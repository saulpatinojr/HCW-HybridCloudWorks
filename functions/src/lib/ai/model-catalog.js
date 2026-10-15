/**
 * model-catalog.js — the model catalogue document and its refresh (ADR 0034
 * slice 2, #857).
 *
 * Every model the site may select, per provider, populated from each
 * provider's own list endpoint and enriched from a code table keyed by id
 * pattern. Until this the lists were typed into the frontend seed, so a new
 * deployment, a retired id or a price change was a pull request, and the
 * card could offer a model the provider had stopped serving.
 *
 * WHERE IT LIVES. ADR 0034 §1 names `admin_config/ai-model-catalog`; the
 * document is written to `admin_settings` (SETTINGS_CONTAINER) instead,
 * beside `ai-features` and `ai-routing`, the two AI documents it is read
 * with. `admin_config` is partitioned on a constant for the forge's
 * transactional batch (cosmos-client.js) and holds nothing the AI code
 * reads; one container for the AI settings is one partition rule to get
 * right.
 *
 * THREE RULES, EACH A REVIEW FINDING ON THE ADR.
 *
 *   A FAILED LIST CHANGES NO MODEL. A provider that cannot be listed — a
 *   timeout, a 401, a malformed answer — records `refresh.lastError` and
 *   `lastAttempt` and keeps every model exactly as it was. `lastOk` moves
 *   only on success, and the page derives `stale` from its age, so an
 *   outage reads as "the list is old", never as "every model retired".
 *
 *   RETIRED TAKES TWO MISSES. A model absent from one successful list has
 *   `missed` incremented; absent from a second consecutive one it becomes
 *   `retired`. One list that omits a model by accident (a provider's paging
 *   hiccup, a deployment mid-update) is not a retirement. A model seen again
 *   is `live` with `missed` back at zero.
 *
 *   HIDDEN IS THE ADMINISTRATOR'S. A refresh never reads or writes `hidden`;
 *   only the PATCH route does. A model hidden on the card stays hidden
 *   through every refresh, live or retired.
 *
 * Enrichment never trusts a provider's free text: capabilities, context and
 * pricing come from ENRICHMENT_TABLE and COST_TABLE, both code. A model
 * with no table row is `['text']` and unpriced, and an unpriced model is
 * badged on the card and never recommended (ADR 0034 §2).
 *
 * THE MEDIA PROVIDERS ARE CATALOGUE PROVIDERS (ADR 0034 slice 5, #860).
 * ElevenLabs and Replicate have entries like the chat providers, keyed by
 * ELEVENLABS_API_KEY and REPLICATE_API_KEY (router.js MEDIA_KEY_ENV), and
 * NO CARD: a key is what switches them on, there is no order to set and no
 * Test to run, and the catalogue drawer says so. ElevenLabs lists its
 * models; Replicate's list is the static set of image models this
 * repository calls. Gemini's TTS models were in its list already (they
 * answer generateContent) and now carry `tts` through the enrichment table.
 */
import {
  KEY_ENV,
  MEDIA_KEY_ENV,
  NVIDIA_BASE_URL,
  createFoundryTokenProvider,
  defaultGetToken,
  foundryBaseUrl,
  foundryTokenScope,
  readKey,
} from './router.js';
import { KNOWN_PROVIDERS as PROVIDERS } from './provider-order.js';
import { AuthoredError, authoredMessage, errorCode } from '../http/error-response.js';
import { MEDIA_DEFAULT_MODELS } from './model-tables.js';
import { SETTINGS_CONTAINER } from './containers.js';
import {
  CATALOG_DOC_ID,
  CATALOG_SCHEMA_VERSION,
  RETIRE_AFTER_MISSED,
  isPlainObject,
  normalizeModel,
  normalizeProvider,
  seedModelsFor,
  unknownModel,
} from './model-catalog-doc.js';

/**
 * The document half — its shape, enrichment, the seeded defaults and the
 * read path — is model-catalog-doc.js since slice 3 (#858), so the config
 * loader can read the catalogue without the list adapters below; every
 * caller keeps importing from here.
 */
export {
  CATALOG_DOC_ID,
  CATALOG_SCHEMA_VERSION,
  DEFAULT_ENRICHMENT,
  ENRICHMENT_TABLE,
  ENRICHMENT_VOCABULARY,
  MODEL_STATUSES,
  RETIRE_AFTER_MISSED,
  STALE_AFTER_MS,
  enrichModel,
  isStale,
  pricingFor,
  readModelCatalog,
  seedModelsFor,
  seedProviderEntry,
  selectableModelsFor,
  visibleModelsFor,
} from './model-catalog-doc.js';

/** One list call's limit; a provider that takes longer records a timeout. */
export const LIST_TIMEOUT_MS = 20_000;
/** Pages followed per provider; Anthropic pages at 100 and Gemini at 1000. */
const MAX_PAGES = 20;


// ── list adapters ────────────────────────────────────────────────────────────

/**
 * A list that could not be read, in a sentence written here: the status, or
 * what was wrong with the answer. The provider's own error text is not
 * carried (#945); the refresh answer and the card's lastError show this.
 */
export class CatalogListError extends AuthoredError {}

/**
 * GET one list endpoint as JSON, or throw a CatalogListError naming the
 * status or the shape (never the provider's own text, #945).
 *
 * @param {Function} fetchImpl - fetch
 * @param {string} url - the list endpoint
 * @param {object} headers - request headers (the key)
 * @param {number} timeoutMs - the deadline
 * @returns {Promise<object>}
 */
async function getJson(fetchImpl, url, headers, timeoutMs) {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    throw new CatalogListError(`HTTP ${response.status}`, { status: response.status });
  }
  if (data === null || typeof data !== 'object') {
    throw new CatalogListError('List answer was not JSON');
  }
  return data;
}

/**
 * The provider's model collection, or a thrown "malformed list". A 200 whose
 * body lacks the collection (`{}`, an HTML interstitial parsed as an object,
 * a renamed field) is NOT an empty list: read as one, two such answers would
 * retire every stored model. It is a failed refresh, recorded as such.
 */
function collectionOf(data, field) {
  if (!Array.isArray(data?.[field])) {
    throw new CatalogListError(`Malformed list: no "${field}" array in the answer`);
  }
  return data[field];
}

const idsOf = (rows) =>
  rows.map((row) => (typeof row?.id === 'string' ? row.id.trim() : '')).filter(Boolean);

async function listOpenAiCompatible(ctx, url, headers) {
  const data = await getJson(ctx.fetchImpl, url, headers, ctx.timeoutMs);
  return idsOf(collectionOf(data, 'data'));
}

const LISTERS = {
  openai: (ctx) =>
    listOpenAiCompatible(ctx, 'https://api.openai.com/v1/models', {
      Authorization: `Bearer ${readKey(ctx.env, KEY_ENV.openai)}`,
    }),
  nvidia: (ctx) =>
    listOpenAiCompatible(ctx, `${NVIDIA_BASE_URL}/models`, {
      Authorization: `Bearer ${readKey(ctx.env, KEY_ENV.nvidia)}`,
    }),
  foundry: async (ctx) => {
    // The same two ways in as the chat call (router.js openAiCompatibleTable):
    // a local FOUNDRY_API_KEY on a workstation, else the app identity's token.
    const local = readKey(ctx.env, 'FOUNDRY_API_KEY');
    const headers = local
      ? { 'api-key': local }
      : { Authorization: `Bearer ${await ctx.foundryToken()}` };
    return listOpenAiCompatible(ctx, `${foundryBaseUrl(ctx.env)}/openai/v1/models`, headers);
  },
  anthropic: async (ctx) => {
    const headers = {
      'x-api-key': readKey(ctx.env, KEY_ENV.anthropic),
      'anthropic-version': '2023-06-01',
    };
    const ids = [];
    let afterId = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL('https://api.anthropic.com/v1/models');
      url.searchParams.set('limit', '100');
      if (afterId) url.searchParams.set('after_id', afterId);
      const data = await getJson(ctx.fetchImpl, url.toString(), headers, ctx.timeoutMs);
      ids.push(...idsOf(collectionOf(data, 'data')));
      if (!data.has_more || !data.last_id) break;
      afterId = data.last_id;
    }
    return ids;
  },
  gemini: async (ctx) => {
    const headers = { 'x-goog-api-key': readKey(ctx.env, KEY_ENV.gemini) };
    const ids = [];
    let pageToken = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
      url.searchParams.set('pageSize', '1000');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const data = await getJson(ctx.fetchImpl, url.toString(), headers, ctx.timeoutMs);
      ids.push(...geminiChatIdsOf(collectionOf(data, 'models')));
      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
    }
    return ids;
  },
  // The media providers (ADR 0034 slice 5, #860). ElevenLabs lists its
  // models at GET /v1/models as a bare array of { model_id, name, … }
  // (https://elevenlabs.io/docs/api-reference/models/list, read 2026-10-05);
  // the ids come from `model_id`, and an answer that is not an array is a
  // malformed list, for the reason collectionOf gives.
  elevenlabs: async (ctx) => {
    const data = await getJson(
      ctx.fetchImpl,
      'https://api.elevenlabs.io/v1/models',
      { 'xi-api-key': readKey(ctx.env, MEDIA_KEY_ENV.elevenlabs) },
      ctx.timeoutMs
    );
    if (!Array.isArray(data)) throw new CatalogListError('Malformed list: the answer was not an array of models');
    return data
      .map((row) => (typeof row?.model_id === 'string' ? row.model_id.trim() : ''))
      .filter(Boolean);
  },
  // Replicate has no list this site should read: its catalogue is every
  // public model on the platform. The list is STATIC — the image models
  // this repository calls (model-tables.js MEDIA_DEFAULT_MODELS) — so a
  // refresh confirms them `live` and a model the code stops calling
  // retires like any other.
  replicate: async () => [...MEDIA_DEFAULT_MODELS.replicate],
};

/** The env name that makes a provider possible: a chat key, or a media key (router.js MEDIA_KEY_ENV). */
const keyEnvFor = (provider) => KEY_ENV[provider] || MEDIA_KEY_ENV[provider];

/**
 * One Gemini page's chat-capable ids: `models/<id>` entries whose
 * `supportedGenerationMethods` include `generateContent`; embedding and
 * image-only models (which the list also returns) are left out.
 */
function geminiChatIdsOf(models) {
  const chatCapable = (model) =>
    Array.isArray(model?.supportedGenerationMethods) &&
    model.supportedGenerationMethods.includes('generateContent');
  return models
    .filter(chatCapable)
    .map((model) => (typeof model?.name === 'string' ? model.name : ''))
    .map((name) => name.replace(/^models\//, '').trim())
    .filter(Boolean);
}

/**
 * The context `listModels` reads: the environment, a fetch, and the Foundry
 * token source. Production builds it with no arguments; a test hands in
 * `fetchImpl` and never touches the network.
 *
 * @param {object} [options]
 * @param {object} [options.env]
 * @param {Function} [options.fetchImpl]
 * @param {() => Promise<string>} [options.foundryToken]
 * @param {number} [options.timeoutMs]
 */
export function createListContext({
  env = process.env,
  fetchImpl = globalThis.fetch,
  foundryToken,
  timeoutMs = LIST_TIMEOUT_MS,
} = {}) {
  return {
    env,
    fetchImpl,
    timeoutMs,
    foundryToken:
      foundryToken ||
      createFoundryTokenProvider({ getToken: defaultGetToken, scope: foundryTokenScope(env) }),
  };
}

/**
 * The model ids a provider serves today, from its own list endpoint, unique
 * and in the provider's order. `null` when the provider has no key (or, for
 * Foundry, no endpoint): that is "not configured", not a failure, and the
 * refresh skips it. Throws on any other failure, with a message that names
 * the status and never the key.
 *
 * @param {ReturnType<typeof createListContext>} ctx
 * @param {string} provider
 * @returns {Promise<string[] | null>}
 */
export async function listModels(ctx, provider) {
  const lister = LISTERS[provider];
  if (!lister) throw new Error(`Unknown AI provider: ${provider}`);
  if (!readKey(ctx.env, keyEnvFor(provider))) return null;
  const ids = await lister(ctx);
  return [...new Set(ids)];
}


/**
 * The stored document as a document to write: the stored fields (Cosmos
 * system fields included, so `_etag` travels to the conditional replace),
 * the id and schema version pinned, and every provider's entry cloned raw,
 * byte for byte. Nothing is normalised here.
 */
function rawDocForWrite(stored) {
  const base = isPlainObject(stored) ? structuredClone(stored) : {};
  return {
    ...base,
    id: CATALOG_DOC_ID,
    schemaVersion: CATALOG_SCHEMA_VERSION,
    updatedAt: typeof base.updatedAt === 'string' ? base.updatedAt : null,
    providers: isPlainObject(base.providers) ? base.providers : {},
  };
}

/** The raw stored provider entry with its refresh fields typed; models untouched. */
function rawProviderEntry(entry) {
  const base = isPlainObject(entry) ? entry : {};
  const refresh = isPlainObject(base.refresh) ? base.refresh : {};
  return {
    ...base,
    refresh: {
      ...refresh,
      lastOk: typeof refresh.lastOk === 'string' ? refresh.lastOk : null,
      lastAttempt: typeof refresh.lastAttempt === 'string' ? refresh.lastAttempt : null,
      lastError: typeof refresh.lastError === 'string' ? refresh.lastError : null,
    },
    models: isPlainObject(base.models) ? base.models : {},
  };
}

/** Attempts at an ETag-conditioned write before the conflict is reported. */
export const WRITE_ATTEMPTS = 4;

const isConflict = (error) => error?.code === 412 || error?.code === 409;

/**
 * Read the document, build the next version from it, and write it only if
 * nothing else wrote in between (`replaceDocIfMatch` on the ETag it was
 * read with). On a conflict the document is re-read and `build` runs again
 * over the newer version, so a Hide that landed while the lists were being
 * fetched survives the refresh, and a refresh that landed while a Hide was
 * being decided keeps its new models. The first document, when none is
 * stored, is created with an upsert.
 *
 * `build(stored)` returns `{ doc, result }`; a null `doc` means there is
 * nothing to write and `result` is returned as is.
 */
async function writeCatalog(store, build) {
  let lastError = null;
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const stored = await store.readDoc(SETTINGS_CONTAINER, CATALOG_DOC_ID, CATALOG_DOC_ID);
    const { doc, result } = build(stored);
    if (!doc) return result;
    try {
      if (stored) {
        await store.replaceDocIfMatch(SETTINGS_CONTAINER, doc, { partitionKey: CATALOG_DOC_ID });
      } else {
        await store.upsertDoc(SETTINGS_CONTAINER, doc);
      }
      return result;
    } catch (error) {
      if (!isConflict(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}


/** Apply one successful list to a provider's entry (mutates); returns the counts. */
function applyListing(provider, entry, ids, nowIso) {
  const seen = new Set(ids);
  let added = 0;
  let retired = 0;
  for (const id of ids) {
    const existing = entry.models[id];
    if (!existing) {
      entry.models[id] = { ...unknownModel(provider, id), firstSeen: nowIso };
      added += 1;
    }
    const model = entry.models[id];
    model.status = 'live';
    model.lastSeen = nowIso;
    model.missed = 0;
  }
  for (const model of Object.values(entry.models)) {
    if (seen.has(model.id) || model.status === 'retired') continue;
    model.missed += 1;
    if (model.missed >= RETIRE_AFTER_MISSED) {
      model.status = 'retired';
      retired += 1;
    }
  }
  entry.refresh.lastOk = nowIso;
  entry.refresh.lastError = null;
  return { listed: ids.length, added, retired, error: null };
}

/**
 * Every provider's listing, before anything is written: `{ ids }`,
 * `{ error }`, or `{ skipped: true }` for one with no key.
 */
async function listEveryProvider(providers, list) {
  const outcomes = {};
  for (const provider of providers) {
    if (!PROVIDERS.includes(provider)) continue;
    try {
      const ids = await list(provider);
      outcomes[provider] = ids === null ? { skipped: true } : { ids };
    } catch (error) {
      // Shown on the refresh answer and stored as the card's lastError: the
      // failure's code, never the provider's sentence (#945).
      outcomes[provider] = {
        error: authoredMessage(error, `The model list could not be read (${errorCode(error)}).`),
      };
    }
  }
  return outcomes;
}

/**
 * Apply the listings to the stored document: `{ doc, result }`. A provider
 * that listed is normalised (enrichment re-applied) and then updated; one
 * that failed keeps its models exactly as stored and gains only
 * `lastAttempt` and `lastError`; one that was skipped is untouched.
 */
function applyOutcomes(stored, outcomes, nowIso) {
  const doc = rawDocForWrite(stored);
  const summary = {};
  for (const [provider, outcome] of Object.entries(outcomes)) {
    if (outcome.skipped) {
      summary[provider] = { skipped: true };
      continue;
    }
    if (outcome.error) {
      const entry = rawProviderEntry(doc.providers[provider]);
      entry.refresh.lastAttempt = nowIso;
      entry.refresh.lastError = outcome.error;
      doc.providers[provider] = entry;
      summary[provider] = { listed: 0, added: 0, retired: 0, error: outcome.error };
      continue;
    }
    const entry = normalizeProvider(provider, doc.providers[provider]);
    entry.refresh.lastAttempt = nowIso;
    doc.providers[provider] = entry;
    summary[provider] = applyListing(provider, entry, outcome.ids, nowIso);
  }
  doc.updatedAt = nowIso;
  return { doc, result: { updatedAt: nowIso, providers: summary } };
}

/**
 * List every provider and write the document. One provider's failure is a
 * line in its `refresh` and in the summary; the others still refresh. The
 * lists are fetched first and the document written after, conditionally on
 * its ETag (writeCatalog), so a Hide that lands meanwhile is kept. Only a
 * store that cannot be read or written throws.
 *
 * @param {object} deps
 * @param {{ readDoc: Function, upsertDoc: Function, replaceDocIfMatch: Function }} deps.store
 * @param {string[]} deps.providers   the providers with a key (ai.availableProviders())
 * @param {(provider: string) => Promise<string[] | null>} deps.listModels
 * @param {() => Date} [deps.now]
 * @returns {Promise<{ updatedAt: string, providers: Record<string, object> }>}
 */
export async function refreshModelCatalog({ store, providers, listModels: list, now = () => new Date() }) {
  const nowIso = now().toISOString();
  const outcomes = await listEveryProvider(providers, list);
  return writeCatalog(store, (stored) => applyOutcomes(stored, outcomes, nowIso));
}


/**
 * The hide applied to the stored document: `{ doc, result }`, with a null
 * `doc` (nothing to write) when the model is not found. Only the one model's
 * `hidden` changes; every other stored field, model and provider is kept as
 * it was. A model the catalogue has never listed but the router's table
 * names is materialised as `unknown` so it can be hidden before the first
 * refresh.
 */
function applyHidden(stored, { provider, model, hidden }, nowIso) {
  const doc = rawDocForWrite(stored);
  const entry = rawProviderEntry(doc.providers[provider]);
  if (!isPlainObject(entry.models[model])) {
    if (!seedModelsFor(provider).includes(model)) return { doc: null, result: null };
    entry.models[model] = unknownModel(provider, model);
  }
  entry.models[model] = { ...entry.models[model], hidden: hidden === true };
  doc.providers[provider] = entry;
  doc.updatedAt = nowIso;
  return { doc, result: normalizeModel(provider, model, entry.models[model]) };
}

/**
 * Set `hidden` on one model and write the document, conditionally on its
 * ETag (writeCatalog) so a refresh that lands meanwhile keeps its new models
 * and this hide still applies. Returns the model entry, or null when the id
 * is neither in the catalogue nor a router default.
 *
 * @param {object} deps
 * @param {{ readDoc: Function, upsertDoc: Function, replaceDocIfMatch: Function }} deps.store
 * @param {() => Date} [deps.now]
 * @param {{ provider: string, model: string, hidden: boolean }} change
 */
export async function setModelHidden({ store, now = () => new Date() }, change) {
  const nowIso = now().toISOString();
  return writeCatalog(store, (stored) => applyHidden(stored, change, nowIso));
}

