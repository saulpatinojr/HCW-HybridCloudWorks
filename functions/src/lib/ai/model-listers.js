/**
 * model-listers.js — how each provider's model list is read for the model
 * catalogue (model-catalog.js): one lister per provider, paged and bounded,
 * and the context they share. model-catalog.js re-exports the public names.
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
import { AuthoredError } from '../http/error-response.js';
import { MEDIA_DEFAULT_MODELS } from './model-tables.js';

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
 * @param {AbortSignal} signal - the deadline shared by all pages
 * @returns {Promise<object>}
 */
async function getJson(fetchImpl, url, headers, signal) {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers,
    signal,
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
  const data = await getJson(ctx.fetchImpl, url, headers, ctx.signal);
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
      const data = await getJson(ctx.fetchImpl, url.toString(), headers, ctx.signal);
      ids.push(...idsOf(collectionOf(data, 'data')));
      if (!data.has_more) return ids;
      if (!data.last_id || data.last_id === afterId) throw new CatalogListError(
        'Incomplete list: invalid Anthropic pagination cursor'
      );
      afterId = data.last_id;
    }
    throw new CatalogListError('Incomplete list: Anthropic pagination limit reached');
  },
  gemini: async (ctx) => {
    const headers = { 'x-goog-api-key': readKey(ctx.env, KEY_ENV.gemini) };
    const ids = [];
    let pageToken = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
      url.searchParams.set('pageSize', '1000');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const data = await getJson(ctx.fetchImpl, url.toString(), headers, ctx.signal);
      ids.push(...geminiChatIdsOf(collectionOf(data, 'models')));
      if (!data.nextPageToken) return ids;
      if (data.nextPageToken === pageToken) throw new CatalogListError(
        'Incomplete list: repeated Gemini pagination cursor'
      );
      pageToken = data.nextPageToken;
    }
    throw new CatalogListError('Incomplete list: Gemini pagination limit reached');
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
      ctx.signal
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
 * One Gemini page's callable ids: `models/<id>` entries whose
 * `supportedGenerationMethods` include `generateContent` or `interactions`; embedding and
 * image-only models (which the list also returns) are left out.
 */
function geminiChatIdsOf(models) {
  const chatCapable = (model) =>
    Array.isArray(model?.supportedGenerationMethods) &&
    model.supportedGenerationMethods.some((method) =>
      ['generateContent', 'interactions'].includes(method)
    );
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
  const signal = AbortSignal.timeout(ctx.timeoutMs);
  let onAbort;
  const deadline = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    // Include token acquisition as well as every response body in the deadline.
    const ids = await Promise.race([lister({ ...ctx, signal }), deadline]);
    return [...new Set(ids)];
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
