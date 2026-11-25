/**
 * Pure content-linting primitives: banned-phrase detection and inline-module
 * validation.
 *
 * The innermost layer of the content-quality graph the api-surface contract
 * bounds. In Site-Main this logic is scattered across three files that also
 * hold AI and pipeline code — `content-voice.js` (BANNED_PHRASES,
 * mergeBannedPhrases), `forge-pipeline.js` (validateModules, findBannedPhrases,
 * the MODULE_* constants) and `content-critique.js` (scanBannedPhrases). Only
 * these pure pieces are consumed by the quality scorers, so they are lifted
 * here as one self-contained module rather than dragging the AI-bearing files
 * across.
 *
 * Nothing here does I/O: no Firestore, no network, no process.env. Ported to
 * ESM directly; the source functions were already side-effect free.
 *
 * MODULE_TAG_REGEX must stay in lockstep with the frontend parser
 * (frontend/src/lib/moduleParser.js) — the LLM's output is parsed by the same
 * grammar as hand-authored modules, so a drift here silently breaks rendering.
 */

/**
 * Overused AI-tell phrases. Ported verbatim from Site-Main content-voice.js:136
 * — the editorial critique and quality gate both key off this exact list, so it
 * is copied rather than paraphrased.
 */
export const BANNED_PHRASES = [
  "in today's fast-paced digital landscape",
  'in the ever-evolving world of',
  "it's important to note that",
  'unlock the power of',
  'unlock the full potential',
  'seamless integration',
  'seamlessly integrate',
  'robust solution',
  'game-changer',
  'game changing',
  "let's dive in",
  "let's explore",
  'delve into',
  'in conclusion',
  'in summary',
  'at the end of the day',
  'the world of',
  'navigate the complexities',
  'take your ... to the next level',
  'whether you are a beginner or an expert',
  'as we all know',
  'cutting-edge',
  'stay ahead of the curve',
];

/** Inline module grammar. Global flag: callers must reset lastIndex before use. */
export const MODULE_TAG_REGEX =
  /<module\s+type="(\w+)"(?:\s+align="([^"]*)")?\s*>([\s\S]*?)<\/module>/g;

// The type list and each JSON payload schema are specified in
// docs/content/blog-machine.md (the cross-package contract of record); the frontend
// twin lists live in frontend/src/lib/moduleParser.js, and each side carries
// a test asserting its list matches the documented set.
export const KNOWN_MODULE_TYPES = new Set([
  'fact', 'recommendation', 'text', 'code', 'design', 'links', 'picture', 'video', 'spacer',
  'pull_quote', 'stat_board', 'comparison', 'timeline', 'callout',
]);

/** Types whose body must be a JSON object rather than free text. */
export const JSON_MODULE_TYPES = new Set([
  'links', 'picture', 'video', 'spacer',
  'pull_quote', 'stat_board', 'comparison', 'timeline', 'callout',
]);

export const MAX_MODULES = 14;

export const MAX_STAT_BOARD_STATS = 4;

/**
 * Merge extra banned phrases into the base set, de-duplicated and trimmed.
 * Source: content-voice.js:175.
 */
export function mergeBannedPhrases(extraBanned = []) {
  const extras = (extraBanned || []).map((p) => String(p || '').trim()).filter(Boolean);
  return [...new Set([...BANNED_PHRASES, ...extras])];
}

/**
 * Banned phrases present in `markdown`. Phrases containing '...' are skipped —
 * they are display-only patterns ("take your ... to the next level") that would
 * never match literally. Source: forge-pipeline.js:61.
 */
export function findBannedPhrases(markdown = '', extraBanned = []) {
  const text = String(markdown || '').toLowerCase();
  return mergeBannedPhrases(extraBanned).filter(
    (phrase) => !phrase.includes('...') && text.includes(phrase.toLowerCase())
  );
}

/**
 * Literal-substring banned-phrase scan (no '...' skipping, no extras). The
 * critique path uses this stricter variant. Source: content-critique.js:9.
 */
export function scanBannedPhrases(text = '') {
  const lower = String(text || '').toLowerCase();
  return BANNED_PHRASES.filter((phrase) => lower.includes(phrase.toLowerCase()));
}

/**
 * Validate the inline module tags in a forged draft against the grammar.
 * Source: forge-pipeline.js:72. Return shape is load-bearing —
 * buildContentQualityReport keys off { valid, moduleCount, issues, picturePrompts }.
 *
 * @returns {{ valid: boolean, moduleCount: number, issues: string[], picturePrompts: string[] }}
 */
export function validateModules(markdown = '') {
  const issues = [];
  const picturePrompts = [];
  let moduleCount = 0;
  const source = String(markdown || '');

  MODULE_TAG_REGEX.lastIndex = 0;
  let match;
  while ((match = MODULE_TAG_REGEX.exec(source)) !== null) {
    moduleCount += 1;
    const [, type, align, content] = match;
    issues.push(...moduleIssues({ type, align, content, n: moduleCount, picturePrompts }));
  }

  if (moduleCount > MAX_MODULES) {
    issues.push(`Too many modules: ${moduleCount} (max ${MAX_MODULES})`);
  }

  return { valid: issues.length === 0, moduleCount, issues, picturePrompts };
}

/** The issues of module number `n`, in the order they are reported. */
function moduleIssues({ type, align, content, n, picturePrompts }) {
  if (!KNOWN_MODULE_TYPES.has(type)) return [`Unknown module type "${type}"`];
  const issues = [];
  if (align && !['left', 'right', 'all'].includes(align)) {
    issues.push(`Module ${n} (${type}) has invalid align "${align}"`);
  }
  if (JSON_MODULE_TYPES.has(type)) {
    const problem = jsonModuleIssue(type, content, n, picturePrompts);
    if (problem) issues.push(problem);
  } else if (!String(content || '').trim()) {
    issues.push(`Module ${n} (${type}) is empty`);
  }
  return issues;
}

/**
 * The one issue of a module with a JSON body, or null. Any failure while the
 * body is read or checked counts as JSON that is not valid.
 */
function jsonModuleIssue(type, content, n, picturePrompts) {
  try {
    const parsed = JSON.parse(content.trim());
    // A JSON body must be an object, not a bare value: `5` parses but no
    // renderer can do anything with it, and the semantic checks below
    // would silently pass for types without one.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return `Module ${n} (${type}) JSON body is not an object`;
    }
    const check = Object.hasOwn(MODULE_CHECKS, type) ? MODULE_CHECKS[type] : null;
    return check ? check(parsed, n, picturePrompts) : null;
  } catch {
    return `Module ${n} (${type}) content is not valid JSON`;
  }
}

const blank = (value) => !String(value || '').trim();
const listOf = (value) => (Array.isArray(value) ? value : []);

/**
 * The semantic check of each JSON module type: the issue, or null. A
 * picture's prompt is collected into `picturePrompts` on the way.
 */
const MODULE_CHECKS = {
  picture(parsed, n, picturePrompts) {
    const prompt = String(parsed.imagePrompt || '').trim();
    if (prompt) {
      picturePrompts.push(prompt);
      return null;
    }
    return blank(parsed.imageUrl) ? `Picture module ${n} has neither imageUrl nor imagePrompt` : null;
  },
  links(parsed, n) {
    return listOf(parsed.links).length ? null : `Links module ${n} has no links`;
  },
  pull_quote(parsed, n) {
    return blank(parsed.text) ? `Pull-quote module ${n} has no text` : null;
  },
  stat_board(parsed, n) {
    const stats = listOf(parsed.stats);
    if (stats.length < 2 || stats.length > MAX_STAT_BOARD_STATS) {
      return `Stat-board module ${n} needs 2-${MAX_STAT_BOARD_STATS} stats, has ${stats.length}`;
    }
    const incomplete = stats.some((stat) => !String(stat?.value ?? '').trim() || blank(stat?.label));
    return incomplete ? `Stat-board module ${n} has a stat missing value or label` : null;
  },
  comparison(parsed, n) {
    const columns = listOf(parsed.columns);
    const rows = listOf(parsed.rows);
    if (columns.length < 2 || !rows.length) {
      return `Comparison module ${n} needs at least 2 columns and 1 row`;
    }
    return rows.some((row) => !Array.isArray(row) || row.length !== columns.length)
      ? `Comparison module ${n} has a row that does not match its ${columns.length} columns`
      : null;
  },
  timeline(parsed, n) {
    const steps = listOf(parsed.steps);
    if (steps.length < 2) return `Timeline module ${n} needs at least 2 steps`;
    return steps.some((step) => blank(step?.title)) ? `Timeline module ${n} has a step with no title` : null;
  },
  callout(parsed, n) {
    return blank(parsed.title) || blank(parsed.body) ? `Callout module ${n} needs both title and body` : null;
  },
};
