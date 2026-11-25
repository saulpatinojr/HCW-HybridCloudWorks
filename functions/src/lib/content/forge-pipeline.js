/**
 * forge-pipeline.js — deterministic post-generation helpers: dash scrub,
 * module repair, the forge module instruction, and title-similarity dedupe.
 *
 * Ported from Site-Main `lib/forge-pipeline.js` (088f458). `validateModules`,
 * `findBannedPhrases` and the module grammar constants were lifted earlier
 * into ../cms/content-modules.js and are imported from there; nothing here
 * does I/O.
 */
import { MODULE_TAG_REGEX } from '../cms/content-modules.js';

/**
 * Replace em/en dashes with comma or hyphen phrasing everywhere EXCEPT inside
 * code and design (Mermaid) modules, where dashes are syntax.
 */
export function scrubDashes(markdown = '') {
  const source = String(markdown || '');
  const segments = [];
  let lastIndex = 0;

  MODULE_TAG_REGEX.lastIndex = 0;
  let match;
  while ((match = MODULE_TAG_REGEX.exec(source)) !== null) {
    segments.push({ text: source.slice(lastIndex, match.index), protect: false });
    const [, type] = match;
    segments.push({ text: match[0], protect: type === 'code' || type === 'design' });
    lastIndex = match.index + match[0].length;
  }
  segments.push({ text: source.slice(lastIndex), protect: false });

  return segments
    .map((segment) => {
      if (segment.protect) return segment.text;
      return segment.text
        .replace(/\s*—\s*/g, ', ')
        .replace(/(\d)\s*–\s*(\d)/g, '$1-$2')
        .replace(/\s*–\s*/g, ', ');
    })
    .join('');
}

/**
 * Forge-specific module instruction appended after buildVoiceAndFormatBlock.
 * Overrides the base MODULE_TAG_SYNTAX prohibition on picture/spacer modules
 * because the forge pipeline resolves picture placeholders into a generated
 * image pack afterwards.
 */
export function buildForgeModuleInstruction(format) {
  const formatModules = format?.modules?.use?.join(', ') || 'fact, recommendation';
  return `ContentForge module requirements (these OVERRIDE the earlier "never emit picture/video/spacer" rule):
- Include 4 to 8 module tags total, spread through the article where they belong contextually.
- Vary align between "left" and "right" so consecutive modules alternate sides; use align="all" for the full-width types: design, stat_board, comparison, timeline.
- Include at least one spacer module as a visual break between major sections: <module type="spacer">{"style":"gradient"}</module>. Valid styles: gradient, solid, dots, double, glow, accent.
- Include at least one fact or recommendation module.
- Prioritize the format's module types (${formatModules}) plus variety from: code, links, text, design, pull_quote, stat_board, comparison, timeline, callout.
- You MAY include one or two picture modules as placeholders for generated images. Use empty imageUrl and a detailed imagePrompt describing the image to generate: <module type="picture" align="right">{"imageUrl":"","caption":"...","imagePrompt":"detailed image generation prompt"}</module>
- Still never emit video modules.
- Two text modules back to back (one align="left", one align="right") render side by side; use that for comparisons.`;
}

// ── Deterministic module repair ─────────────────────────────────────────────
// In forge-module-repair.js.
export { repairModules } from './forge-module-repair.js';

// ── Dedupe vs published corpus ───────────────────────────────────────────────

const TITLE_STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'for',
  'to',
  'of',
  'in',
  'on',
  'with',
  'your',
  'how',
  'what',
  'why',
  'is',
  'are',
  'vs',
  'via',
  'from',
  'into',
  'using',
]);

export function titleTokens(title = '') {
  return new Set(
    String(title || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 2 && !TITLE_STOPWORDS.has(token))
  );
}

/**
 * Jaccard similarity of meaningful title tokens against the corpus.
 * 0.55 default threshold: "AKS networking deep dive" vs "Deep dive into AKS
 * networking" collide; different topics on the same service do not.
 * @returns {{ similar: boolean, bestScore: number, bestTitle: string|null }}
 */
export function findSimilarTitle(candidateTitle, publishedTitles = [], threshold = 0.55) {
  const candidate = titleTokens(candidateTitle);
  if (!candidate.size) return { similar: false, bestScore: 0, bestTitle: null };

  let bestScore = 0;
  let bestTitle = null;
  for (const publishedTitle of publishedTitles) {
    const published = titleTokens(publishedTitle);
    if (!published.size) continue;
    let intersection = 0;
    for (const token of candidate) if (published.has(token)) intersection += 1;
    const union = candidate.size + published.size - intersection;
    const score = union > 0 ? intersection / union : 0;
    if (score > bestScore) {
      bestScore = score;
      bestTitle = publishedTitle;
    }
  }
  return { similar: bestScore >= threshold, bestScore, bestTitle };
}
