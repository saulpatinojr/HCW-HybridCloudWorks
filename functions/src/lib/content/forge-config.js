/**
 * forge-config.js — the two admin-editable documents that drive ContentForge.
 *
 * Ported from Site-Main `lib/forge-config.js` (088f458). On Cosmos both live
 * in `admin_config` under the constant partition (ADMIN_CONFIG_PARTITION):
 *   admin_config/forge_profile — who the owner is (certs, talks, weighted
 *                                interest areas, free-form "word soup")
 *   admin_config/forge_prompts — master generation prompt, extra banned
 *                                phrases, style rules, publish threshold
 *
 * Every field falls back to the code defaults so generation and grading keep
 * working if the documents are missing, partial, or malformed. Loaded values
 * are cached in-process for CACHE_TTL_MS.
 */
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { errorFacts } from '../http/error-response.js';

export const CACHE_TTL_MS = 5 * 60 * 1000;

export const DEFAULT_MASTER_PROMPT = `You are writing for Hybrid Cloud Works, a practitioner-run site about hybrid cloud, cloud architecture, and applied AI. Write as one experienced engineer talking to another: direct, specific, grounded in real services, commands, and numbers. No marketing tone, no filler, no throat-clearing introductions. Every article must be publishable as-is without human cleanup.`;

export const DEFAULT_STYLE_RULES = Object.freeze({
  // Em/en dashes are a strong "written by AI" tell; enforced by prompt AND by
  // the post-generation scrub in the forge pipeline.
  noEmDash: true,
  noHyphenTells: true,
  custom: [],
});

export const DEFAULT_PUBLISH_THRESHOLD = 80;

export const DEFAULT_INTEREST_AREAS = Object.freeze([
  {
    key: 'hybrid_arch',
    label: 'Hybrid Architecture',
    weight: 90,
    keywords: [
      'hybrid cloud',
      'on-premises',
      'vmware',
      'colocation',
      'interconnect',
      'landing zone',
    ],
  },
  {
    key: 'cloud_arch',
    label: 'Cloud Architecture',
    weight: 85,
    keywords: [
      'well-architected',
      'architecture',
      'kubernetes',
      'networking',
      'iam',
      'resilience',
      'multi-region',
    ],
  },
  {
    key: 'agentic_ai',
    label: 'Agentic AI',
    weight: 80,
    keywords: ['agent', 'agentic', 'mcp', 'tool use', 'orchestration', 'autonomous'],
  },
  {
    key: 'gen_ai',
    label: 'Generative AI',
    weight: 75,
    keywords: ['llm', 'generative ai', 'rag', 'prompt', 'embedding', 'fine-tuning'],
  },
  {
    key: 'education',
    label: 'Learning & Education',
    weight: 70,
    keywords: ['certification', 'exam', 'learning path', 'tutorial', 'hands-on', 'lab'],
  },
]);

export const DEFAULT_PROFILE = Object.freeze({
  certifications: [],
  speakingTopics: [],
  interestAreas: DEFAULT_INTEREST_AREAS,
  wordSoup: '',
});

export const DEFAULT_PROMPTS = Object.freeze({
  masterPrompt: DEFAULT_MASTER_PROMPT,
  extraBannedPhrases: [],
  styleRules: DEFAULT_STYLE_RULES,
  publishThreshold: DEFAULT_PUBLISH_THRESHOLD,
  autoForge: { enabled: false, dailyLimit: 3 },
  version: 0,
});

/**
 * A number from a stored or submitted value, or the fallback when the value
 * is absent (undefined, null, '') or not a number. `Number(x) || fallback`
 * was used before ADR 0033 and turned an explicit 0 into the fallback: a
 * publish threshold of 0 saved as 80 and an Auto-Forge daily limit of 0 as
 * 3, so the two settings could not be set to the one value that means
 * "everything passes" and "paused".
 */
export function numberOr(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeKeywordList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) =>
      String(item || '')
        .trim()
        .toLowerCase()
    )
    .filter(Boolean);
}

export function normalizeProfile(raw = {}) {
  // An explicit empty list is kept (ADR 0033): the Studio could not clear
  // the interest areas while an empty array fell back to the defaults.
  // Only a missing or non-list value takes the defaults.
  const interestAreas = Array.isArray(raw.interestAreas)
    ? raw.interestAreas.map((area) => ({
        key: String(area.key || '').trim() || 'custom',
        label: String(area.label || area.key || 'Custom'),
        weight: Math.max(0, Math.min(100, numberOr(area.weight, 0))),
        keywords: normalizeKeywordList(area.keywords),
      }))
    : [...DEFAULT_INTEREST_AREAS];

  return {
    certifications: Array.isArray(raw.certifications)
      ? raw.certifications.map((cert) => ({
          name: String(cert.name || ''),
          issuer: String(cert.issuer || ''),
          keywords: normalizeKeywordList(cert.keywords),
        }))
      : [],
    speakingTopics: Array.isArray(raw.speakingTopics)
      ? raw.speakingTopics.map((topic) => ({
          title: String(topic.title || ''),
          keywords: normalizeKeywordList(topic.keywords),
        }))
      : [],
    interestAreas,
    wordSoup: String(raw.wordSoup || ''),
  };
}

export function normalizePrompts(raw = {}) {
  const styleRules = raw.styleRules && typeof raw.styleRules === 'object' ? raw.styleRules : {};
  return {
    masterPrompt: String(raw.masterPrompt || '').trim() || DEFAULT_MASTER_PROMPT,
    extraBannedPhrases: Array.isArray(raw.extraBannedPhrases)
      ? raw.extraBannedPhrases.map((phrase) => String(phrase || '').trim()).filter(Boolean)
      : [],
    styleRules: {
      noEmDash: styleRules.noEmDash !== false,
      noHyphenTells: styleRules.noHyphenTells !== false,
      custom: Array.isArray(styleRules.custom)
        ? styleRules.custom.map((rule) => String(rule || '').trim()).filter(Boolean)
        : [],
    },
    publishThreshold: Math.max(
      0,
      Math.min(100, numberOr(raw.publishThreshold, DEFAULT_PUBLISH_THRESHOLD))
    ),
    autoForge: {
      enabled: raw.autoForge?.enabled === true,
      dailyLimit: Math.max(0, Math.min(10, numberOr(raw.autoForge?.dailyLimit, 3))),
    },
    version: Number(raw.version) || 0,
  };
}

/**
 * @param {object} deps
 * @param {{ readDoc: Function }} deps.store
 * @param {() => number} [deps.now] - epoch ms, for the cache
 * @param {{ warn?: Function }} [deps.log]
 */
export function createForgeConfigLoader({ store, now = Date.now, log = {} }) {
  const deps = { store, now, log };
  const profile = cachedConfig(deps, {
    docId: 'forge_profile',
    label: 'profile',
    normalize: normalizeProfile,
    fallback: DEFAULT_PROFILE,
  });
  const prompts = cachedConfig(deps, {
    docId: 'forge_prompts',
    label: 'prompts',
    normalize: normalizePrompts,
    fallback: DEFAULT_PROMPTS,
  });

  function clearForgeConfigCache() {
    profile.clear();
    prompts.clear();
  }

  return { loadForgeProfile: profile.load, loadForgePrompts: prompts.load, clearForgeConfigCache };
}

/**
 * One `admin_config` document read through a short cache (CACHE_TTL_MS). A
 * read that fails is logged without content and answers `fallback`, as a
 * missing document does.
 */
function cachedConfig({ store, now, log }, { docId, label, normalize, fallback }) {
  let cache = { value: null, loadedAt: 0 };

  async function readValue() {
    try {
      const raw = await store.readDoc('admin_config', docId, ADMIN_CONFIG_PARTITION);
      return raw ? normalize(raw) : fallback;
    } catch (err) {
      log.warn?.(`forge-config: ${label} load failed, using defaults: ${errorFacts(err)}`);
      return fallback;
    }
  }

  return {
    async load({ bypassCache = false } = {}) {
      const at = now();
      if (!bypassCache && cache.value && at - cache.loadedAt < CACHE_TTL_MS) return cache.value;
      const value = await readValue();
      cache = { value, loadedAt: at };
      return value;
    },
    clear() {
      cache = { value: null, loadedAt: 0 };
    },
  };
}
