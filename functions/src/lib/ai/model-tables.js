/**
 * model-tables.js — the two tables of model ids the router carries: the
 * purpose → default model table (env-overridable per provider) and the
 * cost table that prices every usage row.
 *
 * Moved out of router.js in ADR 0034 slice 3 (#858) so the model catalogue
 * (model-catalog-doc.js) and the config loader (ai-config.js) can read them
 * without importing the router, which imports the loader: the catalogue is
 * read on every AI call now, and a lazy import on that path cost a
 * synchronous call its time budget. Every caller keeps importing
 * `DEFAULT_MODEL_TABLE` and `COST_TABLE` from router.js, which re-exports
 * them; the tables themselves are unchanged.
 */

// Provider × purpose → [env var, default model].
export const DEFAULT_MODEL_TABLE = Object.freeze({
  anthropic: {
    draft: ['CONTENTFORGE_ANTHROPIC_DRAFT_MODEL', 'claude-sonnet-4-6'],
    analysis: ['CONTENTFORGE_ANTHROPIC_ANALYSIS_MODEL', 'claude-sonnet-4-6'],
    multimodal: ['CONTENTFORGE_ANTHROPIC_MULTIMODAL_MODEL', 'claude-sonnet-4-6'],
    general: ['CONTENTFORGE_ANTHROPIC_MODEL', 'claude-haiku-4-5'],
  },
  openai: {
    draft: ['CONTENTFORGE_OPENAI_DRAFT_MODEL', 'gpt-5-mini'],
    analysis: ['CONTENTFORGE_OPENAI_ANALYSIS_MODEL', 'gpt-5-mini'],
    multimodal: ['CONTENTFORGE_OPENAI_MULTIMODAL_MODEL', 'gpt-5-mini'],
    general: ['CONTENTFORGE_OPENAI_MODEL', 'gpt-5-nano'],
  },
  // Same model ids as upstream's Vertex table; the public Gemini API serves
  // them too. Env var names keep the GEMINI_ prefix so a Vertex-era override
  // cannot silently apply here.
  gemini: {
    draft: ['CONTENTFORGE_GEMINI_DRAFT_MODEL', 'gemini-3.5-flash-lite'],
    analysis: ['CONTENTFORGE_GEMINI_ANALYSIS_MODEL', 'gemini-3.6-flash'],
    multimodal: ['CONTENTFORGE_GEMINI_MULTIMODAL_MODEL', 'gemini-3.6-flash'],
    general: ['CONTENTFORGE_GEMINI_MODEL', 'gemini-3.5-flash-lite'],
  },
  // NVIDIA API Catalog (#701). Ids read from each model's page on
  // https://build.nvidia.com on 2026-09-25 — the `model` value in the page's
  // own curl sample, which is NOT always the URL slug (the page
  // build.nvidia.com/z-ai/glm-5-3 serves `z-ai/glm-5.3`):
  //   deepseek-ai/deepseek-v4.1-flash  build.nvidia.com/deepseek-ai/deepseek-v4.1-flash
  //   z-ai/glm-5.3                     build.nvidia.com/z-ai/glm-5-3
  //   z-ai/glm-5.3-flash               build.nvidia.com/z-ai/glm-5-3-flash
  // GLM-5.3, the large text MoE, serves every purpose. On the trial tier the
  // "flash" models were the slow ones, measured direct from a workstation on
  // 2026-10-04 with a one-line prompt: z-ai/glm-5.3 2.6 s,
  // z-ai/glm-5.3-flash 70 s, deepseek-ai/deepseek-v4.1-flash over 120 s. The
  // portal's Test gives up at 45 s, so the GLM-5.3-Flash default failed every
  // Test while the key was good (#701). Both keep their cost-table rows, so
  // history still prices, and a CONTENTFORGE_NVIDIA_*_MODEL override can bring
  // either back once NVIDIA serves it faster; the portal offers only the
  // defaults below (frontend aiEngine.test.js holds the two lists equal).
  // Kimi K3 is on the catalogue too, but its page's sample left `model` blank
  // on the day, so it is not a default. The catalogue changes often: a
  // retired id is a 404, which fails over to the next provider.
  nvidia: {
    draft: ['CONTENTFORGE_NVIDIA_DRAFT_MODEL', 'z-ai/glm-5.3'],
    analysis: ['CONTENTFORGE_NVIDIA_ANALYSIS_MODEL', 'z-ai/glm-5.3'],
    multimodal: ['CONTENTFORGE_NVIDIA_MULTIMODAL_MODEL', 'z-ai/glm-5.3'],
    general: ['CONTENTFORGE_NVIDIA_MODEL', 'z-ai/glm-5.3'],
  },
  // Microsoft Foundry (#849): deployment names, which infra/foundry.tf keeps
  // equal to the model names. Mini for the work that reads a whole draft,
  // nano for the short calls; the owner picks otherwise on the card.
  foundry: {
    draft: ['CONTENTFORGE_FOUNDRY_DRAFT_MODEL', 'gpt-5-mini'],
    analysis: ['CONTENTFORGE_FOUNDRY_ANALYSIS_MODEL', 'gpt-5-mini'],
    multimodal: ['CONTENTFORGE_FOUNDRY_MULTIMODAL_MODEL', 'gpt-5-mini'],
    general: ['CONTENTFORGE_FOUNDRY_MODEL', 'gpt-5-nano'],
  },
});

/**
 * Cost table: provider → model → [input USD per 1M, output USD per 1M].
 * Ported verbatim, including rows for providers this router no longer calls
 * (vertex, azure, perplexity, bedrock, replicate): `ai_usage` holds history
 * recorded against them and the admin usage page prices it through here.
 * Re-pricing history would rewrite past spend attribution.
 */
export const COST_TABLE = Object.freeze({
  anthropic: {
    // Standard API rates, verified 2026-10-27: platform.claude.com/docs/en/about-claude/pricing
    'claude-opus-5-5': [4.0, 20.0],
    'claude-sonnet-5-5': [2.0, 10.0],
    'claude-opus-4-6': [5.0, 25.0],
    'claude-sonnet-4-6': [3.0, 15.0],
    'claude-haiku-4-5': [1.0, 5.0],
    'claude-haiku-4-5-20251001': [1.0, 5.0],
    default: [3.0, 15.0],
  },
  openai: {
    // Standard processing, short-context prices verified 2026-10-27:
    // https://developers.openai.com/api/docs/pricing
    'gpt-6-astra': [10.0, 50.0],
    'gpt-6.1-sol': [2.0, 10.0],
    'gpt-6.1-terra': [1.0, 5.0],
    'gpt-6-luna': [0.1, 0.5],
    'gpt-4o': [5.0, 15.0],
    'gpt-4o-mini': [0.15, 0.6],
    o1: [15.0, 60.0],
    'o3-mini': [1.1, 4.4],
    // gpt-5-mini / gpt-5-nano were UNPRICED (null) from ADR 0033 until
    // 2026-10-05, when the owner confirmed OpenAI's published rates — the
    // same figures the Azure OpenAI pricing page lists for the same models
    // (read 2026-10-04). Rows written while they were null stay at 0 with
    // `unpriced: true`; the Usage tab counts and says so. A null row is still
    // how a model with no confirmed rate is kept honest (isPriced).
    'gpt-5-mini': [0.25, 2.0],
    'gpt-5-nano': [0.05, 0.4],
    default: [5.0, 15.0],
  },
  gemini: {
    // Standard rates after the promotional period; modelRatesFor applies the dated discount.
    'gemini-4-argon': [4.0, 20.0],
    'gemini-3.8-flash': [1.5, 7.5],
    'gemini-3.6-flash': [1.5, 7.5],
    'gemini-3.5-flash': [1.5, 9.0],
    'gemini-3.5-flash-lite': [0.3, 2.5],
    'gemini-2.5-pro': [3.5, 10.5],
    'gemini-2.5-flash': [0.3, 2.5],
    'gemini-2.5-flash-lite': [0.1, 0.4],
    // Text-to-speech (Listen & Learn). The output rate prices AUDIO tokens and
    // is an order of magnitude above the text rates, which is why an episode's
    // cost is dominated by its length rather than its prompt. Read from the
    // published paid-tier pricing on 2026-08-24; the flash TTS model is half
    // the price of the other two, which is why it is the default in
    // listen-and-learn/speech/gemini.js.
    'gemini-2.5-flash-preview-tts': [0.5, 10.0],
    'gemini-2.5-pro-preview-tts': [1.0, 20.0],
    'gemini-3.1-flash-tts-preview': [1.0, 20.0],
    // Standard rates from https://ai.google.dev/gemini-api/docs/pricing, verified 2026-10-27.
    'gemini-3.8-flash-tts': [1.0, 18.0],
    'gemini-3.8-flash-lite-tts': [1.0, 12.0],
    default: [0.3, 2.5],
  },
  vertex: {
    'gemini-3.6-flash': [1.5, 7.5],
    'gemini-3.5-flash': [1.5, 9.0],
    'gemini-3.5-flash-lite': [0.3, 2.5],
    'gemini-2.5-pro': [3.5, 10.5],
    'gemini-2.5-flash': [0.3, 2.5],
    'gemini-2.5-flash-lite': [0.1, 0.4],
    default: [0.3, 2.5],
  },
  perplexity: {
    'sonar-pro': [3.0, 15.0],
    sonar: [1.0, 1.0],
    default: [3.0, 15.0],
  },
  azure: {
    'gpt-4o': [5.0, 15.0],
    'gpt-4o-mini': [0.15, 0.6],
    default: [5.0, 15.0],
  },
  bedrock: {
    'amazon.nova-micro-v1:0': [0.035, 0.14],
    'amazon.nova-lite-v1:0': [0.06, 0.24],
    'amazon.nova-pro-v1:0': [0.8, 3.2],
    default: [0.06, 0.24],
  },
  // ElevenLabs speech (Listen & Learn), priced PER CHARACTER: the "output"
  // unit of a row is the billed character count, promptTokens is always 0,
  // and USD 0.10 per 1,000 characters is USD 100 per 1M. Read from the API
  // pricing page for the Starter and Creator plans on 2026-09-08. Expressed
  // in the table's per-1M shape so getCostEstimate and the admin usage page
  // price these rows without learning a new unit — see the header of
  // listen-and-learn/speech/elevenlabs.js.
  elevenlabs: {
    eleven_v3: [0, 100.0],
    default: [0, 100.0],
  },
  // NVIDIA API Catalog trial tier (#701): free, so every row is zero — the
  // Usage tab then shows these calls, and what they did not cost, instead of
  // pricing them at a guessed rate. `default` covers a model the portal or an
  // env override pins. If the owner ever moves to a paid NVIDIA plan, these
  // rows are what change.
  nvidia: {
    'z-ai/glm-5.3': [0, 0],
    'z-ai/glm-5.3-flash': [0, 0],
    'deepseek-ai/deepseek-v4.1-flash': [0, 0],
    default: [0, 0],
  },
  // Microsoft Foundry (#849): Global Standard, USD per 1M tokens, read from
  // the Azure OpenAI pricing page on 2026-10-04. `default` is the mini rate
  // so a deployment added on the card prices high rather than free.
  foundry: {
    'gpt-5-nano': [0.05, 0.4],
    'gpt-5-mini': [0.25, 2.0],
    'gpt-4.1-nano': [0.1, 0.4],
    default: [0.25, 2.0],
  },
  replicate: {
    'meta/llama-3.1-405b-instruct': [0.65, 2.75],
    'meta/llama-3.1-70b-instruct': [0.35, 1.4],
    'meta/llama-3.1-8b-instruct': [0.05, 0.25],
    'mistralai/mistral-7b-instruct-v0.2': [0.05, 0.25],
    default: [0.35, 1.4],
  },
});

/**
 * The media providers' own default models (ADR 0034 slice 5, #860): what
 * the catalogue seeds for them before their first list, as
 * DEFAULT_MODEL_TABLE seeds the chat providers. ElevenLabs lists its models
 * (model-catalog.js); Replicate has no list endpoint the site reads, so its
 * entry IS its list — the image models this repository calls, one today.
 */
export const ADAPTER_MODELS = Object.freeze({
  gemini: Object.freeze([
    'gemini-2.5-flash-preview-tts',
    'gemini-2.5-pro-preview-tts',
    'gemini-3.1-flash-tts-preview',
    'gemini-3.8-flash-tts',
    'gemini-3.8-flash-lite-tts',
  ]),
});

export const MEDIA_DEFAULT_MODELS = Object.freeze({
  elevenlabs: Object.freeze(['eleven_v3']),
  replicate: Object.freeze(['google/imagen-4-fast']),
});

/**
 * The unit a provider's cost rows are expressed in, where it is not tokens.
 * ElevenLabs bills characters and its rows are USD per 1M characters
 * (speech/elevenlabs.js header); Replicate bills per output image and has
 * no per-1M shape at all, so its price is PER_IMAGE_USD below and the
 * catalogue carries `unit: 'image'` rather than a token rate that would
 * price nothing. Everything else is `1M tokens`, the table's own unit.
 */
export const PRICING_UNITS = Object.freeze({
  elevenlabs: '1M characters',
  replicate: 'image',
});

/**
 * USD per output image, by model, for the catalogue's price column and the
 * recommendation rule (a recommended model must be priced). Read from
 * replicate.com/google/imagen-4-fast on 2026-10-05 ("$0.02 per output
 * image, or 50 images for $1"), the same figure Terraform sets
 * CONTENTFORGE_IMAGE_COST_USD to; the usage rows are priced from that
 * setting (triggers/ai-cover.js), and this table is what the page shows.
 */
export const PER_IMAGE_USD = Object.freeze({
  replicate: Object.freeze({
    'google/imagen-4-fast': 0.02,
  }),
});

/** True only for a confirmed model rate, including image prices and the NVIDIA trial. */
export function isPriced(provider, model) {
  if (Number.isFinite(PER_IMAGE_USD[provider]?.[model])) return true;
  const rates = COST_TABLE[provider] || {};
  // Unknown ids must agree with catalogue pricing, never inherit a guessed rate.
  // NVIDIA's documented trial tier is free independently of the selected model.
  const rate = provider === 'nvidia' ? rates.default : Object.hasOwn(rates, model) ? rates[model] : null;
  return Array.isArray(rate) && rate.length === 2 &&
    rate.every((value) => Number.isFinite(value) && value >= 0);
}

/** Published introductory rates. Date bounds prevent a promotion becoming a permanent price. */
export const MODEL_PRICE_PROMOTIONS = Object.freeze({
  gemini: Object.freeze({
    'gemini-4-argon': { until: '2026-12-01T00:00:00Z', rates: [2, 10] },
    'gemini-3.8-flash': { until: '2027-01-01T00:00:00Z', rates: [0.75, 3.75] },
    'gemini-3.8-flash-tts': { until: '2027-01-01T00:00:00Z', rates: [0.5, 9] },
    'gemini-3.8-flash-lite-tts': { until: '2027-01-01T00:00:00Z', rates: [0.5, 6] },
  }),
});

/** Current token rates, shared by catalogue display and usage recording. Never re-prices stored rows. */
export function modelRatesFor(provider, model, at = Date.now()) {
  const promotion = MODEL_PRICE_PROMOTIONS[provider]?.[model];
  if (promotion && Number(new Date(at)) < Date.parse(promotion.until)) return promotion.rates;
  const rates = COST_TABLE[provider];
  return rates && Object.hasOwn(rates, model) ? rates[model] : null;
}
