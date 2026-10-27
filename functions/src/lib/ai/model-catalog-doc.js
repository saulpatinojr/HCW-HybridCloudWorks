/**
 * model-catalog-doc.js — the model catalogue document as the site reads it
 * (ADR 0034 slice 2, #857): its shape, the enrichment of a model id, the
 * router defaults seeded before the first refresh, and the read path.
 *
 * Split from model-catalog.js in slice 3 (#858). The resolver reads the
 * catalogue on every AI call through the config loader (ai-config.js), and
 * the loader cannot import model-catalog.js: that module carries the list
 * adapters, which import the router, which imports the loader. This half
 * imports neither — the tables it needs are model-tables.js — so the read
 * is a static import on the call path. model-catalog.js re-exports every
 * public name here; every caller keeps importing from it.
 *
 * The three rules of the catalogue are in the model-catalog.js header.
 */
import { ADAPTER_MODELS, COST_TABLE, DEFAULT_MODEL_TABLE, MEDIA_DEFAULT_MODELS, PER_IMAGE_USD, PRICING_UNITS, modelRatesFor } from './model-tables.js';
import { KNOWN_PROVIDERS as PROVIDERS } from './provider-order.js';
import { SETTINGS_CONTAINER } from './containers.js';
import { CAPABILITIES, MODALITIES } from './tasks.js';
import { enrichmentFor } from './model-enrichment.js';

/**
 * The enrichment table lives in model-enrichment.js since slice 3 (#858), so
 * the resolver can read it without this module; every caller keeps
 * importing it from model-catalog.js.
 */
export { DEFAULT_ENRICHMENT, ENRICHMENT_TABLE } from './model-enrichment.js';

export const CATALOG_DOC_ID = 'ai-model-catalog';
export const CATALOG_SCHEMA_VERSION = 1;
export const MODEL_STATUSES = Object.freeze(['live', 'retired', 'unknown']);
/** Consecutive successful lists without a model before it is retired. */
export const RETIRE_AFTER_MISSED = 2;
/** The refresh is weekly; a `lastOk` older than this is `stale` at read time. */
export const STALE_AFTER_MS = 8 * 24 * 60 * 60 * 1000;

// ── enrichment ───────────────────────────────────────────────────────────────
// Capabilities, modality and context by id pattern: model-enrichment.js.
// Pricing is never there; COST_TABLE prices, and a model it lacks is unpriced.

/**
 * `{ inputPer1M, outputPer1M }` from the cost table's own row, or null. A
 * provider whose rows are not tokens carries `unit` (model-tables.js
 * PRICING_UNITS): ElevenLabs rows are per 1M characters; Replicate bills per
 * image and has no per-1M row at all, so its price is `{ perUnitUsd, unit:
 * 'image' }` from PER_IMAGE_USD rather than a token rate posing as one
 * (ADR 0034 slice 5, #860).
 */
export function pricingFor(provider, id, at = Date.now()) {
  const perUnit = PER_IMAGE_USD[provider];
  if (perUnit) {
    return typeof perUnit[id] === 'number'
      ? { perUnitUsd: perUnit[id], unit: PRICING_UNITS[provider] || 'image' }
      : null;
  }
  const rates = COST_TABLE[provider];
  if (!rates || !Object.hasOwn(rates, id) || !Array.isArray(rates[id])) return null;
  const [inputPer1M, outputPer1M] = modelRatesFor(provider, id, at);
  const unit = PRICING_UNITS[provider];
  return unit ? { inputPer1M, outputPer1M, unit } : { inputPer1M, outputPer1M };
}

/**
 * What the code knows about a model: capabilities, modality and context from
 * ENRICHMENT_TABLE, pricing from COST_TABLE. `unpriced` is the badge the
 * card shows and the recommendation rule reads.
 */
export function enrichModel(provider, id) {
  const pricing = pricingFor(provider, id);
  return { ...enrichmentFor(id), pricing, unpriced: pricing === null };
}

/**
 * The models the router's own table names for a provider, in table order,
 * unique; for a media provider, its own defaults (MEDIA_DEFAULT_MODELS).
 */
export function seedModelsFor(provider) {
  if (MEDIA_DEFAULT_MODELS[provider]) return [...MEDIA_DEFAULT_MODELS[provider]];
  const purposes = DEFAULT_MODEL_TABLE[provider];
  if (!purposes) return [];
  return [...new Set([...Object.values(purposes).map(([, model]) => model), ...(ADAPTER_MODELS[provider] || [])])];
}

// ── the document ─────────────────────────────────────────────────────────────

export const emptyRefresh = () => ({ lastOk: null, lastAttempt: null, lastError: null });

function emptyDoc() {
  return {
    id: CATALOG_DOC_ID,
    schemaVersion: CATALOG_SCHEMA_VERSION,
    updatedAt: null,
    providers: {},
  };
}

export const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** One stored model entry, every field present and typed, enrichment re-applied. */
export function normalizeModel(provider, id, stored) {
  const base = isPlainObject(stored) ? stored : {};
  return {
    id,
    status: MODEL_STATUSES.includes(base.status) ? base.status : 'unknown',
    firstSeen: typeof base.firstSeen === 'string' ? base.firstSeen : null,
    lastSeen: typeof base.lastSeen === 'string' ? base.lastSeen : null,
    missed: Number.isInteger(base.missed) && base.missed >= 0 ? base.missed : 0,
    hidden: base.hidden === true,
    ...enrichModel(provider, id),
  };
}

/** One provider's entry as stored, or an empty one. */
export function normalizeProvider(provider, stored) {
  const base = isPlainObject(stored) ? stored : {};
  const refresh = isPlainObject(base.refresh) ? base.refresh : {};
  const models = {};
  for (const [id, model] of Object.entries(isPlainObject(base.models) ? base.models : {})) {
    models[id] = normalizeModel(provider, id, model);
  }
  return {
    refresh: {
      lastOk: typeof refresh.lastOk === 'string' ? refresh.lastOk : null,
      lastAttempt: typeof refresh.lastAttempt === 'string' ? refresh.lastAttempt : null,
      lastError: typeof refresh.lastError === 'string' ? refresh.lastError : null,
    },
    models,
  };
}

/**
 * The stored document with every present provider normalised; providers
 * are never dropped. READ PATH ONLY: the writes below start from the raw
 * stored document and normalise one provider at a time, after its own
 * successful listing, so a failed list cannot change a model's enrichment
 * or drop a stored field.
 */
export function normalizeDoc(stored) {
  const doc = emptyDoc();
  if (!isPlainObject(stored)) return doc;
  doc.updatedAt = typeof stored.updatedAt === 'string' ? stored.updatedAt : null;
  for (const [provider, entry] of Object.entries(
    isPlainObject(stored.providers) ? stored.providers : {}
  )) {
    doc.providers[provider] = normalizeProvider(provider, entry);
  }
  return doc;
}

/** A never-listed model in a provider's entry: `unknown` until a list confirms it. */
export function unknownModel(provider, id) {
  return {
    id,
    status: 'unknown',
    firstSeen: null,
    lastSeen: null,
    missed: 0,
    hidden: false,
    ...enrichModel(provider, id),
  };
}

/**
 * The provider's entry before its first refresh: the router's own defaults
 * as `unknown` models, so the card has a list on day one. In memory only;
 * nothing is written until a refresh or a hide.
 */
export function seedProviderEntry(provider) {
  return {
    refresh: emptyRefresh(),
    models: Object.fromEntries(seedModelsFor(provider).map((id) => [id, unknownModel(provider, id)])),
  };
}

/** True when the provider's last successful list is missing or older than STALE_AFTER_MS. */
export function isStale(refresh, now = new Date()) {
  const lastOk = refresh?.lastOk ? new Date(refresh.lastOk).getTime() : NaN;
  if (!Number.isFinite(lastOk)) return true;
  return now.getTime() - lastOk > STALE_AFTER_MS;
}

/**
 * The provider's entry as the page should read it. Until the first
 * SUCCESSFUL list (`refresh.lastOk` set) the router's defaults are seeded in
 * memory under whatever is stored — a first list that failed leaves an entry
 * with no models and an error, and a Hide before the first refresh leaves
 * one with a single model — so the card always has its list on day one, and
 * a stored model (its `hidden` included) wins over the default of the same
 * id. `seeded` says the list is the router's, not the provider's.
 */
function readableProviderEntry(provider, entry) {
  if (entry?.refresh?.lastOk) return { ...entry, seeded: false };
  const seed = seedProviderEntry(provider);
  return {
    refresh: entry?.refresh || seed.refresh,
    models: { ...seed.models, ...(entry?.models || {}) },
    seeded: true,
  };
}

/**
 * The document as the page reads it: every provider the router implements,
 * `stale` derived from `lastOk` at read time, and a provider with no
 * successful refresh yet seeded in memory from the router's defaults so the
 * card has a list before the first list lands (`seeded: true`, nothing
 * written).
 *
 * @param {object} deps
 * @param {{ readDoc: Function }} deps.store
 * @param {() => Date} [deps.now]
 */
export async function readModelCatalog({ store, now = () => new Date() }) {
  const stored = await store.readDoc(SETTINGS_CONTAINER, CATALOG_DOC_ID, CATALOG_DOC_ID);
  const doc = normalizeDoc(stored);
  const at = now();
  const providers = {};
  for (const provider of PROVIDERS) {
    const resolved = readableProviderEntry(provider, doc.providers[provider]);
    providers[provider] = { ...resolved, stale: isStale(resolved.refresh, at) };
  }
  return {
    id: CATALOG_DOC_ID,
    schemaVersion: CATALOG_SCHEMA_VERSION,
    updatedAt: doc.updatedAt,
    providers,
  };
}

/**
 * The ids a select may offer for a provider and a task's `needs`: live or
 * unknown, carrying every capability named, not hidden, in a stable order
 * — live first, then by id. A chat pin asks for `['text']`, which keeps
 * the speech, transcription, embedding and image ids the list endpoints
 * also return out of the pin, the Priority list and the Playground, where
 * a text call to them fails; a speech task's chain editor asks for
 * `['tts']` and gets the TTS ids instead (ADR 0034 slice 5, #860). Reads
 * the document shape `readModelCatalog` returns; the frontend carries the
 * same rule (frontend/src/lib/aiEngine/catalog.js) and aiEngine.test.js
 * holds the two equal.
 */
export function selectableModelsFor(catalog, provider, needs = ['text']) {
  const models = catalog?.providers?.[provider]?.models;
  if (!isPlainObject(models)) return [];
  const rank = (status) => (status === 'live' ? 0 : 1);
  return Object.values(models)
    .filter((model) => isSelectable(model, needs))
    .sort((a, b) => rank(a.status) - rank(b.status) || a.id.localeCompare(b.id))
    .map((m) => m.id);
}

/** The ids a card may offer: `selectableModelsFor` with the text capability. */
export function visibleModelsFor(catalog, provider) {
  return selectableModelsFor(catalog, provider, ['text']);
}

/** Offered in a select: confirmed or awaiting its first list, not hidden, and carrying every need. */
function isSelectable(model, needs) {
  const confirmedOrPending = model.status === 'live' || model.status === 'unknown';
  const shown = model.hidden !== true;
  const carries =
    Array.isArray(model.capabilities) && needs.every((need) => model.capabilities.includes(need));
  return confirmedOrPending && shown && carries;
}

/** The vocabularies the enrichment table must stay inside; pinned by model-catalog.test.js. */
export const ENRICHMENT_VOCABULARY = Object.freeze({ CAPABILITIES, MODALITIES });
