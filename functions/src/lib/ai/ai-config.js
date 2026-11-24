/**
 * ai-config.js — the admin portal's AI settings, made to actually mean something.
 *
 * WHY THIS EXISTS. The admin portal has had provider cards with enable toggles
 * and an order field since it was ported. They wrote documents into the
 * `ai_providers` container and **the router never opened that container**.
 * `getActiveAiProvider()` looked at environment variables and nothing else, so
 * every toggle in the UI was decorative: turning Claude off in the portal left
 * Claude serving every request. The portal was not merely out of date, it was
 * actively misleading — it also listed Vertex as enabled (a provider the
 * Function App cannot authenticate) and OpenAI as deprecated (a provider the
 * router calls today).
 *
 * This module is the missing half. It reads that configuration and turns it
 * into three answers the router asks for:
 *
 *   1. Which providers hold a key and     resolveProviderOrder()
 *      are switched on?
 *   2. May this feature call a model?     isFeatureEnabled()
 *   3. Which candidates, in which order?  selection + catalog → select.js
 *      (ADR 0034 slice 3, #858; until then applyFeaturePlacement (#701)
 *      and applyFeatureRoute (ADR 0033), which the loader now migrates
 *      into the selection document in memory — migrate-selection.js)
 *
 * THREE RULES DECIDE EVERY EDGE CASE HERE. They are worth stating plainly
 * because each one is the answer to "what happens when configuration and
 * reality disagree", and getting any of them backwards breaks the site in a way
 * that is hard to see.
 *
 *   A KEY IS AUTHORITATIVE; CONFIGURATION IS ADVISORY. Configuration can
 *   disable a provider that has a key and can reorder the ones that do. It can
 *   never enable a provider whose key is absent. If it could, an administrator
 *   could tick a box and every AI call would start failing at the API with a
 *   401 — configuration must not be able to describe a state the platform
 *   cannot enter.
 *
 *   UNREADABLE CONFIGURATION IS NOT EMPTY CONFIGURATION. If Cosmos is
 *   unreachable, `load()` reports null and the router behaves exactly as it did
 *   before this module existed: environment order, every feature on. A
 *   configuration read failure must never be able to turn the site's AI off.
 *   That is why `load()` distinguishes "I could not read" from "I read, and
 *   everything is disabled" — the second is a legitimate instruction and is
 *   obeyed, the first is an outage and is ignored.
 *
 *   ABSENT MEANS ON. A feature with no stored setting is enabled, because that
 *   is the state the site is in today. A new feature must not arrive switched
 *   off, and an empty container must not read as "all off".
 *
 * The cache exists because this is consulted on every AI call and the answer
 * changes when an administrator clicks something — minutes apart at most, never
 * per request. A stale answer is served in preference to no answer when a
 * refresh fails, for the same reason as the second rule.
 */

import { DEFAULT_PROVIDER_ORDER } from './provider-order.js';
import {
  ADMIN_CONFIG_CONTAINER,
  ADMIN_CONFIG_PARTITION,
  FEATURES_DOC_ID,
  LISTEN_AND_LEARN_SPEECH_DOC_ID,
  PODCAST_VOICE_MODEL_SETTING,
  PROVIDERS_CONTAINER,
  SETTINGS_CONTAINER,
} from './containers.js';
import { ROUTING_DOC_ID, normalizeRouting } from './routing-table.js';
import { isSelectionV2, normalizeSelection } from './selection.js';
import { applyMediaMigration, migrateSelection } from './migrate-selection.js';
import { readModelCatalog } from './model-catalog-doc.js';
import { errorFacts } from '../http/error-response.js';

/**
 * The catalogue, the placement rules and the routing table live in sibling
 * modules; every caller keeps importing them from here.
 */
export {
  AI_FEATURES,
  FEATURE_NAMES,
  PER_FEATURE_PROVIDERS,
  PLACEMENTS,
  PROVIDER_PLACEMENT_DEFAULTS,
  placementFor,
  isPlacementConfigurable,
  applyFeaturePlacement,
  isFeatureEnabled,
} from './features-catalogue.js';
export {
  ROUTING_DOC_ID,
  MAX_ROUTE_FALLBACKS,
  normalizeRoute,
  normalizeRouting,
  routeFor,
  applyFeatureRoute,
} from './routing-table.js';
export { DEFAULT_PROVIDER_ORDER };

/** The containers and document ids: containers.js, so the catalogue's read path can name them too. */
export { FEATURES_DOC_ID, PROVIDERS_CONTAINER, SETTINGS_CONTAINER } from './containers.js';

/** Ranked lowest-first, so an unordered provider sorts after every ordered one. */
function rankOf(doc, id) {
  const order = Number(doc?.order);
  if (Number.isFinite(order)) return order;
  const fallback = DEFAULT_PROVIDER_ORDER.indexOf(id);
  return fallback === -1 ? Number.MAX_SAFE_INTEGER : 1000 + fallback;
}

/**
 * Configured providers ∩ providers that hold a key, in configured order.
 *
 * @param {Array<object>|null} docs   `ai_providers` documents, or null when the
 *                                    configuration could not be read.
 * @param {string[]} available        Providers whose API key is present. This is
 *                                    the authority: nothing outside it is ever
 *                                    returned, whatever the documents say.
 * @returns {{order: string[], disabled: string[]}} `disabled` names providers
 *          that hold a key but were switched off, which is the difference
 *          between "not configured" and "turned off" in the router's error.
 */
export function resolveProviderOrder(docs, available) {
  // `available` is the router's PROVIDERS ∩ keys-present, so it is already the
  // authoritative set. Nothing here needs the full provider list: documents for
  // providers this platform does not implement (vertex, perplexity, bedrock,
  // replicate) are simply never looked up. They stay in the container untouched
  // — they are historical rows, and dropping stored configuration as a side
  // effect of a read would be worse than ignoring it.
  const withKeys = [...new Set(available)];

  // No readable configuration — behave exactly as the env-only router did.
  if (!Array.isArray(docs)) {
    return {
      order: [...withKeys].sort(
        (a, b) => DEFAULT_PROVIDER_ORDER.indexOf(a) - DEFAULT_PROVIDER_ORDER.indexOf(b)
      ),
      disabled: [],
    };
  }

  const byId = new Map();
  for (const doc of docs) {
    const id = String(doc?.id || '')
      .toLowerCase()
      .trim();
    if (id) byId.set(id, doc);
  }

  const enabled = withKeys.filter((id) => byId.get(id)?.enabled !== false);
  const disabled = withKeys.filter((id) => byId.get(id)?.enabled === false);

  enabled.sort((a, b) => {
    const delta = rankOf(byId.get(a), a) - rankOf(byId.get(b), b);
    // A stable tiebreak, so two providers sharing an order value do not swap
    // between instances and make the active provider look non-deterministic.
    return delta !== 0
      ? delta
      : DEFAULT_PROVIDER_ORDER.indexOf(a) - DEFAULT_PROVIDER_ORDER.indexOf(b);
  });

  return { order: enabled, disabled };
}

/** The model an administrator pinned for a provider, if any. */
export function configuredModelFor(docs, provider) {
  if (!Array.isArray(docs)) return null;
  const doc = docs.find((d) => String(d?.id || '').toLowerCase() === provider);
  const model = typeof doc?.defaultModel === 'string' ? doc.defaultModel.trim() : '';
  return model || null;
}

/** What an unreadable or absent configuration reads as: nothing known. */
const EMPTY = Object.freeze({
  providers: null,
  features: null,
  routing: null,
  selection: null,
  catalog: null,
});

/**
 * The model catalogue (ADR 0034 slice 2), read beside the three documents
 * through its document half (model-catalog-doc.js, which imports neither
 * the router nor this module). A catalogue that cannot be read is null —
 * the resolver then judges every model by the code enrichment table and
 * nothing goes dark — and never fails the other three.
 */
async function readCatalog(store, { now, log }) {
  try {
    return await readModelCatalog({ store, now: () => new Date(now()) });
  } catch (error) {
    log.warn?.(`[ai-config] could not read the model catalogue: ${errorFacts(error)}`);
    return null;
  }
}

/**
 * The selection document (ADR 0034 §2) as the resolver reads it: a stored
 * version 2 normalised, anything else — the v1 `{ routes }` document, or
 * none — migrated in memory from the three documents. Nothing is written
 * on read; the first PUT after the migration stores version 2.
 */
export function selectionFrom({ providers, features, routing, media = null }) {
  return isSelectionV2(routing)
    ? applyMediaMigration(normalizeSelection(routing), media)
    : migrateSelection({ providers, features, routing, media });
}

/**
 * The model choices the settings pages carried before the Tasks tab owned
 * them (ADR 0034 slice 5, #860; migrate-selection.js header): the Listen &
 * Learn speech model stored on Platform settings and the podcast voice
 * model setting. Read so a choice made before this slice survives it; a
 * document that cannot be read is "none stored" (the task stays on its
 * recommendation) and never fails the other reads.
 */
async function readMediaModels(store, { env, log }) {
  let speech = null;
  try {
    speech = await store.readDoc(
      ADMIN_CONFIG_CONTAINER,
      LISTEN_AND_LEARN_SPEECH_DOC_ID,
      ADMIN_CONFIG_PARTITION
    );
  } catch (error) {
    log.warn?.(`[ai-config] could not read the Listen & Learn speech setting: ${errorFacts(error)}`);
  }
  const podcast = String(env?.[PODCAST_VOICE_MODEL_SETTING] || '').trim();
  return {
    listenAndLearnSpeech: typeof speech?.geminiModel === 'string' ? speech.geminiModel : null,
    podcastVoice: podcast && !podcast.startsWith('@Microsoft.KeyVault(') ? podcast : null,
  };
}

/** The three documents and the catalogue, read together and normalised. */
async function readAiConfig(store, deps) {
  const [providers, features, routing, catalog, media] = await Promise.all([
    store.queryDocs(PROVIDERS_CONTAINER, 'SELECT * FROM c'),
    store.readDoc(SETTINGS_CONTAINER, FEATURES_DOC_ID, FEATURES_DOC_ID),
    // The selection document (ADR 0034 §2), or the per-task routing it
    // migrates from (ADR 0033). A missing document is the code defaults.
    store.readDoc(SETTINGS_CONTAINER, ROUTING_DOC_ID, ROUTING_DOC_ID),
    readCatalog(store, deps),
    readMediaModels(store, deps),
  ]);
  const cards = Array.isArray(providers) ? providers : [];
  return {
    providers: cards,
    features: features || null,
    // The v1 view, kept for the Routing tab until slice 4 removes it.
    routing: routing ? normalizeRouting(routing) : null,
    selection: selectionFrom({
      providers: cards,
      features: features || null,
      routing: routing || null,
      media,
    }),
    catalog,
  };
}

/** A successful read: cached from now, and the in-flight slot freed. */
function settleRead(state, now, value) {
  state.cache = { at: now(), value };
  state.inflight = null;
  return value;
}

/**
 * A failed read. Stale beats nothing: an administrator's disable stays in
 * force through a Cosmos blip rather than silently reverting to "everything
 * on", so the cached value is re-stamped and served; with no cache, EMPTY.
 */
function recoverFromFailedRead(state, { now, log }, error) {
  state.inflight = null;
  log.warn?.(`[ai-config] could not read AI configuration: ${errorFacts(error)}`);
  if (state.cache) {
    state.cache = { at: now(), value: state.cache.value };
    return state.cache.value;
  }
  return EMPTY;
}

/**
 * The configuration, from the cache while it is fresh, else from one shared
 * read: concurrent callers during a refresh await the same promise.
 */
function loadAiConfig(state, deps) {
  const { store, ttlMs, now } = deps;
  if (!store) return EMPTY;
  if (state.cache && now() - state.cache.at < ttlMs) return state.cache.value;
  if (!state.inflight) {
    state.inflight = readAiConfig(store, deps).then(
      (value) => settleRead(state, now, value),
      (error) => recoverFromFailedRead(state, deps, error)
    );
  }
  return state.inflight;
}

/**
 * Reads the documents and the catalogue, cached, with a stale-over-nothing
 * failure policy. `load()` answers `{ providers, features, routing,
 * selection, catalog }`.
 *
 * @param {object} deps
 * @param {{queryDocs: Function, readDoc: Function}} [deps.store] Omit and the
 *        loader reports null for everything, which is the pre-configuration
 *        behaviour. Unit tests of the router rely on that.
 * @param {number} [deps.ttlMs]
 */
export function createAiConfigLoader({
  store = null,
  ttlMs = 60_000,
  now = () => Date.now(),
  log = console,
  // The environment the media migration reads the podcast voice model
  // setting from (readMediaModels); the router hands over its own.
  env = process.env,
} = {}) {
  const state = { cache: null, inflight: null }; // cache: { at, value }
  const deps = { store, ttlMs, now, log, env };
  return {
    load: async () => loadAiConfig(state, deps),
    invalidate: () => (state.cache = null),
  };
}
