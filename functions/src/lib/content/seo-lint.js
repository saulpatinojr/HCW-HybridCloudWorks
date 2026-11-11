/**
 * seo-lint.js — deterministic SEO advisories for forged drafts (Blog Machine
 * backlog #6). Pure: no model call, no store.
 *
 * Three checks, all ADVISORY — findings ride along on `forgeGrade.seo` for
 * the preview banner and the forge_ready Telegram note, and never move the
 * grade, the staging decision, or any publish gate:
 *   1. Meta-description length — the summary doubles as the meta description;
 *      under ~70 chars search engines pad it, over ~160 they truncate it.
 *   2. Title/keyword alignment — a title sharing no token with any key topic
 *      ranks for none of them. Until #1628 the article address was
 *      slugify(title) too, hence the finding's key; now an article's address
 *      is `<topic>-<id>` (cms/article-topics.js), so only the title carries
 *      the keyword.
 *   3. Heading hierarchy — the page title renders as the H1, so body sections
 *      start at H2 and never skip a level.
 *
 * Fenced code blocks and module tags are stripped before the heading walk —
 * a `# comment` inside a bash block is not a heading.
 */
import { slugify } from '../cms/publish.js';
import { getHeadingMatch } from '../cms/content-quality.js';

export const META_DESCRIPTION_MIN = 70;
export const META_DESCRIPTION_MAX = 160;

function stripNonProse(markdown = '') {
  return String(markdown || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<module\s[^>]*>[\s\S]*?<\/module>/g, ' ');
}

function topicTokens(topic) {
  return slugify(topic).split('-').filter(Boolean);
}

function lintMetaDescription(summary, findings) {
  const meta = String(summary || '').trim();
  if (!meta) {
    findings.push({
      key: 'meta_description_missing',
      message: 'No summary — search engines will improvise the meta description.',
    });
  } else if (meta.length < META_DESCRIPTION_MIN) {
    findings.push({
      key: 'meta_description_short',
      message: `Summary is ${meta.length} chars; aim for ${META_DESCRIPTION_MIN}-${META_DESCRIPTION_MAX} so the search snippet is not padded.`,
    });
  } else if (meta.length > META_DESCRIPTION_MAX) {
    findings.push({
      key: 'meta_description_long',
      message: `Summary is ${meta.length} chars; search results truncate around ${META_DESCRIPTION_MAX}.`,
    });
  }
}

function lintSlugAlignment(title, keyTopics, findings) {
  const slug = slugify(title || '');
  const topics = (Array.isArray(keyTopics) ? keyTopics : [])
    .map((topic) => String(topic || '').trim())
    .filter(Boolean);
  if (!slug || !topics.length) return;
  const slugTokens = new Set(slug.split('-').filter(Boolean));
  const aligned = topics.some((topic) => topicTokens(topic).some((token) => slugTokens.has(token)));
  if (!aligned) {
    findings.push({
      key: 'slug_keyword_mismatch',
      message: `No key topic (${topics.join(', ')}) appears in the title — retitle or retopic so the title carries a keyword.`,
    });
  }
}

function lintHeadingHierarchy(content, findings) {
  const headings = stripNonProse(content)
    .split('\n')
    .map((line) => getHeadingMatch(line))
    .filter(Boolean);
  if (!headings.length) return;

  const h1Count = headings.filter((heading) => heading.level === 1).length;
  if (h1Count > 0) {
    findings.push({
      key: 'heading_h1_in_body',
      message: `${h1Count} H1 heading(s) in the body — the page title is already the H1; start sections at H2.`,
    });
  }
  const firstH2Plus = headings.find((heading) => heading.level >= 2);
  if (firstH2Plus && firstH2Plus.level > 2) {
    findings.push({
      key: 'heading_starts_deep',
      message: `First section heading is H${firstH2Plus.level} ("${firstH2Plus.title}"); start at H2.`,
    });
  }
  for (let index = 1; index < headings.length; index += 1) {
    const prev = headings[index - 1];
    const next = headings[index];
    if (next.level > prev.level + 1) {
      findings.push({
        key: 'heading_skipped_level',
        message: `Heading jumps H${prev.level} to H${next.level} at "${next.title}" — do not skip levels.`,
      });
      break; // one report per article; the first jump is where to start fixing
    }
  }
}

/**
 * @param {{ title?: string, summary?: string, content?: string, keyTopics?: string[] }} article
 * @returns {{ findings: { key: string, message: string }[] }}
 */
export function lintSeo({ title, summary, content, keyTopics } = {}) {
  const findings = [];
  lintMetaDescription(summary, findings);
  lintSlugAlignment(title, keyTopics, findings);
  lintHeadingHierarchy(content, findings);
  return { findings };
}
