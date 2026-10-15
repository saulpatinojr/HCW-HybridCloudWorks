/**
 * forge-grader.js — scores an article against the owner's forge profile and
 * produces an explainable "publish %".
 *
 * Ported from Site-Main `lib/forge-grader.js` (088f458):
 *   1. keywordPrescreen — cheap keyword overlap per section. Zero overlap with
 *      every section skips the model call and returns a low score.
 *   2. gradeArticle — one JSON-mode model call returns a 0-100 subscore plus a
 *      one-line rationale per section. The overall is recomputed here as a
 *      best-fit weighted score; the model's own arithmetic is never trusted.
 */

const CERTIFICATIONS_WEIGHT = 80;
const SPEAKING_WEIGHT = 75;
const PRESCREEN_MIN_HITS = 1;

function extractArticleText(article = {}) {
  return [article.title, article.summary, article.content]
    .map((part) => String(part || ''))
    .join('\n')
    .toLowerCase();
}

function countKeywordHits(text, keywords = []) {
  let hits = 0;
  for (const keyword of keywords) if (keyword && text.includes(keyword)) hits += 1;
  return hits;
}

export function buildSections(profile = {}) {
  const sections = [];
  if ((profile.certifications || []).length) {
    sections.push({
      key: 'certifications',
      label: 'Certifications',
      weight: CERTIFICATIONS_WEIGHT,
      description: (profile.certifications || [])
        .map((cert) => `${cert.name}${cert.issuer ? ` (${cert.issuer})` : ''}`)
        .join('; '),
      keywords: (profile.certifications || []).flatMap((cert) => cert.keywords || []),
    });
  }
  if ((profile.speakingTopics || []).length) {
    sections.push({
      key: 'speaking',
      label: 'Speaking Topics',
      weight: SPEAKING_WEIGHT,
      description: (profile.speakingTopics || []).map((topic) => topic.title).join('; '),
      keywords: (profile.speakingTopics || []).flatMap((topic) => topic.keywords || []),
    });
  }
  for (const area of profile.interestAreas || []) {
    sections.push({
      key: area.key,
      label: area.label,
      weight: area.weight,
      description: area.label,
      keywords: area.keywords || [],
    });
  }
  return sections.filter((section) => section.weight > 0);
}

export function keywordPrescreen(article, profile) {
  const text = extractArticleText(article);
  const sections = buildSections(profile);
  const hitsBySection = {};
  let totalHits = 0;
  for (const section of sections) {
    const hits = countKeywordHits(text, section.keywords);
    hitsBySection[section.key] = hits;
    totalHits += hits;
  }
  return { hitsBySection, totalHits, sections };
}

function clampScore(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(100, Math.round(num)));
}

// Overall = best-fit weighted score, NOT the average across every section —
// averaging punished on-target articles for the sections they were never
// about. Each section's score is scaled by its weight (the area's publish
// ceiling), the strongest fit wins, and multi-area articles get a small
// breadth bonus (+3 per additional section scoring >= 70, capped at +9).
export function computeOverall(subs, sections) {
  const weightByKey = Object.fromEntries(sections.map((section) => [section.key, section.weight]));
  const weighted = subs
    .map((sub) => ({
      score: sub.score,
      weightedScore: (sub.score * (weightByKey[sub.key] || 0)) / 100,
    }))
    .sort((a, b) => b.weightedScore - a.weightedScore);
  if (!weighted.length) return 0;
  const breadthBonus = Math.min(
    9,
    weighted.slice(1).filter((entry) => entry.score >= 70).length * 3
  );
  return Math.min(100, Math.round(weighted[0].weightedScore + breadthBonus));
}

export function buildRubricPrompt(article, profile, sections) {
  const sectionLines = sections
    .map(
      (section) =>
        `- key: "${section.key}" | ${section.label}. Relevant when the article touches: ${section.description}. Signal keywords: ${section.keywords.join(', ') || '(none listed)'}`
    )
    .join('\n');

  return `You are grading how well a draft article matches a site owner's publishing profile.

Owner profile sections:
${sectionLines}

${profile.wordSoup ? `Owner free-form context (word soup):\n${profile.wordSoup.slice(0, 4000)}\n` : ''}
Article title: ${String(article.title || '').slice(0, 300)}
Article summary: ${String(article.summary || '').slice(0, 1000)}
Article content (may be truncated):
${String(article.content || '').slice(0, 12000)}

For EACH profile section, give a relevance score from 0 to 100 and a single-sentence rationale grounded in the article's actual content. Score 0 when the article has nothing to do with the section, 100 when it is squarely about it. Also grade practical learning value for readers under key "education_value" if that key is not already a section.

Return ONLY a JSON object shaped exactly like:
{"subs":[{"key":"<section key>","score":<0-100>,"rationale":"<one sentence>"}]}
Include one entry per section key listed above, no extras, no markdown.`;
}

/**
 * @param {{ ai: { generateJsonResponse: Function } }} deps
 */
export function createGrader({ ai, signal: defaultSignal }) {
  /**
   * @returns {Promise<{ overall: number, subs: object[], prescreen: object, skippedLlm: boolean, note?: string }>}
   */
  async function gradeArticle(article, profile, { usageOut = null, signal: callSignal } = {}) {
    const activeSignal = callSignal || defaultSignal;
    if (activeSignal?.aborted) throw activeSignal.reason || new Error('aborted');
    const { hitsBySection, totalHits, sections } = keywordPrescreen(article, profile);

    if (!sections.length) {
      return {
        overall: 0,
        subs: [],
        prescreen: hitsBySection,
        skippedLlm: true,
        note: 'No profile sections with weight > 0; edit Forge Memory first.',
      };
    }
    if (totalHits < PRESCREEN_MIN_HITS) {
      return {
        overall: 5,
        subs: sections.map((section) => ({
          key: section.key,
          label: section.label,
          score: 5,
          rationale: 'No topical overlap with this section (keyword prescreen).',
        })),
        prescreen: hitsBySection,
        skippedLlm: true,
      };
    }

    const response = await ai.generateJsonResponse({
      prompt: buildRubricPrompt(article, profile, sections),
      purpose: 'analysis',
      feature: 'forgeGrading',
      systemPrompt:
        'You are a strict, consistent content relevance grader. Respond with valid JSON only.',
      usageOut,
      signal: activeSignal,
    });

    const rawSubs = Array.isArray(response?.subs) ? response.subs : [];
    const subs = sections.map((section) => {
      const match = rawSubs.find((sub) => sub?.key === section.key);
      return {
        key: section.key,
        label: section.label,
        score: clampScore(match?.score),
        rationale: String(match?.rationale || 'No rationale returned.').slice(0, 500),
      };
    });

    return {
      overall: computeOverall(subs, sections),
      subs,
      prescreen: hitsBySection,
      skippedLlm: false,
    };
  }

  return { gradeArticle };
}
