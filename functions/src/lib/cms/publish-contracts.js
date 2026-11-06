/**
 * Per-template publish contracts.
 *
 * Ported unchanged from Site-Main lib/publishContracts.js — pure data plus pure
 * readers, no I/O. CJS→ESM was the only edit.
 *
 * Every content type used to be measured against one blog-shaped rubric — 650
 * words, 3+ headings, 2+ inline modules, body read only from
 * postContent/blogDraft/content/Content. That is correct for a blog post and
 * wrong for everything else:
 *
 *   - Framework and Architecture submissions write no prose body at all. Their
 *     substance lives in structured fields (keyPillars, overviewHtml,
 *     terraformCode, diagramUrl, costAnalysis). The blog rubric read an empty
 *     body and failed them on all three counts.
 *   - Coder Corner is an explanation plus one code block. It has no reason to
 *     carry three headings or two modules.
 *
 * A contract declares, per publish target: where the renderable body lives,
 * which structured fields the detail template needs to render a complete page,
 * and the rubric that page is held to.
 *
 * Keep the target keys in sync with SUPPORTED_PUBLISH_TARGETS in the source
 * cms-functions.js and getPublicSectionForTarget in src/lib/contentModel.js.
 */

/** Prose fields, in priority order, that hold a type's renderable body. */
const BLOG_BODY_FIELDS = ['postContent', 'blogDraft', 'content', 'Content'];

/**
 * Image expectations per type. Only a blog post, whose hero is forge-generated
 * and needs traceability, genuinely requires a hero plus prompt lineage; the
 * other three templates render no image, render only a diagram, or degrade
 * cleanly without one.
 */
const NO_IMAGERY = { requireHero: false, requirePromptLineage: false };

/** Every field name a framework's pillars have ever been stored under. */
const PILLAR_ALIASES = ['frameworkConcepts', 'keyPillars', 'pillars', 'frameworkNodes'];

/**
 * True when every pillar carries body text, not just a label.
 *
 * FrameworkDetailTemplate renders `pillar.summary || pillar.description` — so a
 * list of bare label strings produces pillar cards with nothing inside them.
 */
function everyPillarHasSubstance(value) {
  const list = Array.isArray(value)
    ? value
    : String(value)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
  if (list.length === 0) return false;

  return list.every((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const body = entry.summary || entry.description || entry.details || entry.implementation;
    return Boolean(String(body || '').trim());
  });
}

export const CONTRACTS = {
  blog: {
    target: 'blog',
    label: 'Blog post',
    section: 'blog',
    bodyFields: BLOG_BODY_FIELDS,
    rubric: { minWords: 650, minHeadings: 3, minModules: 2 },
    requiredFields: [],
    imagery: { requireHero: true, requirePromptLineage: true },
  },

  framework: {
    target: 'framework',
    label: 'Framework',
    section: 'frameworks',
    bodyFields: ['overviewHtml', 'overview', 'summary', 'Summary', ...BLOG_BODY_FIELDS],
    rubric: { minWords: 60, minHeadings: 0, minModules: 0 },
    requiredFields: [
      {
        key: 'pillars',
        label: 'at least 3 framework pillars',
        aliases: PILLAR_ALIASES,
        minLength: 3,
      },
      {
        key: 'pillarDetail',
        label: 'a summary on every framework pillar',
        aliases: PILLAR_ALIASES,
        validate: everyPillarHasSubstance,
      },
    ],
    imagery: NO_IMAGERY,
  },

  architecture: {
    target: 'architecture',
    label: 'Architecture design',
    section: 'architecture-designs',
    bodyFields: ['overviewHtml', 'overview', 'description', ...BLOG_BODY_FIELDS],
    rubric: { minWords: 150, minHeadings: 0, minModules: 0 },
    requiredFields: [
      {
        key: 'diagram',
        label: 'a diagram URL',
        aliases: ['diagramUrl', 'diagram', 'contentImageUrl', 'imageUrl'],
      },
      {
        key: 'components',
        label: 'at least 2 technical components',
        aliases: ['technicalSpecs.components', 'keyPillars', 'frameworkConcepts', 'hotspots'],
        minLength: 2,
      },
    ],
    imagery: NO_IMAGERY,
  },

  coder_corner: {
    target: 'coder_corner',
    label: 'Coder Corner snippet',
    section: 'code',
    bodyFields: ['explanation', ...BLOG_BODY_FIELDS],
    rubric: { minWords: 120, minHeadings: 0, minModules: 0 },
    requiredFields: [
      { key: 'code', label: 'a code snippet', aliases: ['codeSnippet', 'code', 'terraformCode'] },
      { key: 'language', label: 'a language label', aliases: ['language', 'lang'] },
    ],
    imagery: NO_IMAGERY,
  },

  // An interview is a list of questions and answers, not a prose body
  // (ADR 0040, D5). The publish pipeline flattens the list into `bodyText`
  // for this rubric (lib/interviews/publish-gate.js), and the consent and
  // schema refusals run before it. The guest photo is optional, so no hero.
  interview: {
    target: 'interview',
    label: 'Interview',
    section: 'interviews',
    bodyFields: ['bodyText', 'bio'],
    rubric: { minWords: 60, minHeadings: 0, minModules: 0 },
    requiredFields: [
      { key: 'qa', label: 'at least one question and answer', aliases: ['qa'], minLength: 1 },
    ],
    imagery: NO_IMAGERY,
  },
};

const DEFAULT_TARGET = 'blog';

/** Read `a.b.c` from an object without throwing on missing intermediates. */
function readPath(data, path) {
  return String(path)
    .split('.')
    .reduce((acc, key) => (acc === null || acc === undefined ? undefined : acc[key]), data);
}

/** First alias on the doc that holds a non-empty value. */
export function firstPresentValue(data = {}, aliases = []) {
  for (const alias of aliases) {
    const value = readPath(data, alias);
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) return value;
      continue;
    }
    if (typeof value === 'string') {
      if (value.trim()) return value;
      continue;
    }
    return value;
  }
  return undefined;
}

/** Contract for a publish target, falling back to the blog contract. */
export function getPublishContract(publishTarget) {
  const key = String(publishTarget || '')
    .trim()
    .toLowerCase();
  return CONTRACTS[key] || CONTRACTS[DEFAULT_TARGET];
}

/** The renderable body for this type, per its contract. */
export function getContractBody(data = {}, contract) {
  for (const field of contract.bodyFields) {
    const value = readPath(data, field);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * Structured fields the detail template needs but the doc is missing.
 * Returns human-readable phrases ready to drop into the gate's issue list.
 */
export function getMissingContractFields(data = {}, contract) {
  return contract.requiredFields
    .filter((field) => {
      const value = firstPresentValue(data, field.aliases);
      if (value === undefined) return true;
      if (field.validate) return !field.validate(value);
      if (field.minLength) {
        const length = Array.isArray(value)
          ? value.length
          : String(value)
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean).length;
        return length < field.minLength;
      }
      return false;
    })
    .map((field) => field.label);
}
