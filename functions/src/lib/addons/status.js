/**
 * GET /api/public/addons/{id}/status — the server-side AddOn status proxy
 * (ADR 0035 decision 4; the HCW AddOn Integration Standard, section 10).
 *
 * A site page at /tools/<id> shows an AddOn in a sandboxed pane only when
 * this read says the AddOn is configured and reachable (AddOnPanePage.jsx),
 * and the browser never asks the AddOn itself: the SPA's `connect-src`
 * stays closed (frontend/staticwebapp.config.json), so the gate has to be
 * server side. The route is anonymous, so it is bounded the way the Coder
 * status read is (lib/labs/coder-status.js): one document per AddOn in
 * `tool_service_cache`, refreshed at most once a minute however many
 * visitors open the page (lib/labs/minute-cache.js).
 *
 * The ids are closed in registry.js. An id the registry does not name
 * answers 404 with no store read and no network, so a visitor cannot make
 * the Function App call an arbitrary host. The address comes from the app
 * setting the registry names (`ADDON_<ID>_URL`), a plain Terraform setting:
 * it is a public value, already in the site's CSP and the frame's `src`, and
 * no credential travels with it.
 *
 * Three answers, the last two cached for a minute:
 *
 *   { configured: false }
 *       The setting is absent, blank, still an unresolved Key Vault literal,
 *       or not an https URL. The page shows the unavailable sentence. No
 *       store read, no network.
 *   { configured: true, reachable: false, version: null, edition: null, capabilities: [], asOf }
 *       `GET <url>/api/health` refused, timed out, redirected, answered
 *       anything but 200, or answered something that was not the documented
 *       shape (`ok: true` and a semver `version`).
 *   { configured: true, reachable: true, version, edition, capabilities, asOf }
 *       The AddOn's health body, projected.
 *
 * THE PROJECTION IS AN ALLOW-LIST. Exactly `configured`, `reachable`,
 * `version`, `edition`, `capabilities` and `asOf` leave this module; every
 * other field of the health body (`siteOrigins`, `turnstile`, `rulesLoaded`,
 * `workspace`, `limits` and whatever a later release adds) is ignored, and
 * the URL never appears in a body, a warning or an error. `version` must
 * look like a semver; `edition` and each capability are short strings, at
 * most twenty capabilities, so a misbehaving AddOn cannot push an arbitrary
 * document through the cache to every visitor. `edition` is opaque: the
 * migration AddOn reports `demo`, the Python AddOns report `lab`, and the
 * site reads neither.
 *
 * A FAILURE IS CACHED TOO, and it replaces whatever healthy entry was there,
 * so a pane does not open on a stale healthy document through an outage.
 */

import { readSetting } from '../http/read-setting.js';
import { createMinuteCache, jsonResponse, MINUTE_CACHE_SECONDS } from '../labs/minute-cache.js';
import { addonEntry, isKnownAddon } from './registry.js';
import { ADDON_TIMEOUT_MS, HEALTH_BODY_FAULTS, readHealth } from './health.js';

export { ADDON_HEALTH_MAX_BYTES, ADDON_TIMEOUT_MS, projectHealth } from './health.js';

export const ADDON_STATUS_CACHE_SECONDS = MINUTE_CACHE_SECONDS;
/** The cache document id for one AddOn's status. */
export const addonStatusCacheId = (id) => `addons:${id}:status`;
/** The discriminator written on every cached document. */
export const ADDON_STATUS_CACHE_KIND = 'addons-status';

/** The fields a status body may carry, and nothing else. */
export const ADDON_STATUS_FIELDS = Object.freeze([
  'configured',
  'reachable',
  'version',
  'edition',
  'capabilities',
  'asOf',
]);

/**
 * The proxy's configuration for one AddOn, or null when it has none. Only
 * the address decides, and it must be an `https:` URL: a plain-http address
 * is reported as unconfigured (and logged by the caller, by setting name),
 * never used.
 *
 * @returns {{ base: string, healthPath: string } | null}
 */
export function readAddonConfig(env = process.env, id) {
  const entry = addonEntry(id);
  if (!entry) return null;
  const rawUrl = readSetting(env, entry.setting);
  if (!rawUrl) return null;

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;

  return {
    base: `${url.origin}${url.pathname.replace(/\/+$/, '')}`,
    healthPath: entry.healthPath,
  };
}

/** The setting is set but unusable — worth one warning line, by name. */
const hasAddonUrl = (env, id) => Boolean(readSetting(env, addonEntry(id)?.setting));

/** The minute cache for one id from `caches`, created and kept there on first use. */
function minuteCacheFor(caches, { store, now }, id) {
  if (!caches.has(id)) {
    caches.set(
      id,
      createMinuteCache({
        store,
        id: addonStatusCacheId(id),
        kind: ADDON_STATUS_CACHE_KIND,
        now,
        seconds: ADDON_STATUS_CACHE_SECONDS,
      })
    );
  }
  return caches.get(id);
}

/** Why the read failed, in words that carry no URL. */
function failureReason(error) {
  if (error?.code === 'FETCH_TIMEOUT') return `no answer within ${ADDON_TIMEOUT_MS / 1000} s`;
  if (error instanceof SyntaxError) return 'the health body was not JSON';
  if (Number.isInteger(error?.status)) return `the health read answered ${error.status}`;
  if (Object.hasOwn(HEALTH_BODY_FAULTS, error?.code ?? '')) return HEALTH_BODY_FAULTS[error.code];
  return 'the health read failed';
}

/** The unreachable body: the full projection shape, with nothing from the AddOn. */
const unreachable = (asOf) => ({
  configured: true,
  reachable: false,
  version: null,
  edition: null,
  capabilities: [],
  asOf,
});

/**
 * @param {object} deps
 * @param {{ readDoc: Function, upsertDoc: Function }} deps.store
 * @param {Function} [deps.fetchImpl]
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {() => number} [deps.now] - epoch ms
 */
export function createAddonStatusHandlers({
  store,
  fetchImpl = globalThis.fetch,
  env = process.env,
  now = () => Date.now(),
}) {
  const caches = new Map();
  // One live health read per id at a time on this instance: a burst of anonymous requests that all
  // see a missing or stale cache entry shares the same promise instead of each dialling the AddOn.
  // The bound is per Function App instance; a second instance may read once more in the same minute,
  // and the cache document then settles both.
  const inflight = new Map();
  /** The minute cache for one id, created on first use. */
  const cacheFor = (id) => minuteCacheFor(caches, { store, now }, id);

  /**
   * The status body for one known id — the same object the route returns.
   * The caller has checked the id against the registry; an unknown one
   * answers unconfigured here rather than throwing.
   */
  async function readStatus(id, context) {
    const known = isKnownAddon(id);
    const config = known ? readAddonConfig(env, id) : null;
    if (!config) {
      if (known && hasAddonUrl(env, id)) {
        context?.warn?.(
          `addons-status: ${addonEntry(id).setting} is not an https URL; reporting its add-on unconfigured`
        );
      }
      return { configured: false };
    }

    const cache = cacheFor(id);
    const cached = await cache.read(context);
    if (cached) return cached;

    if (!inflight.has(id)) {
      inflight.set(
        id,
        refresh(id, config, cache, context).finally(() => inflight.delete(id))
      );
    }
    return inflight.get(id);
  }

  async function refresh(id, config, cache, context) {
    const asOf = new Date(now()).toISOString();
    let body;
    try {
      const health = await readHealth(fetchImpl, config);
      body = { configured: true, reachable: true, ...health, asOf: health.asOf ?? asOf };
    } catch (error) {
      // The setting name says which AddOn; the id came from the URL and is not logged (content-free telemetry).
      context?.warn?.(`addons-status: ${addonEntry(id).setting} unreachable: ${failureReason(error)}`);
      body = unreachable(asOf);
    }

    await cache.write(body, context);
    return body;
  }

  return {
    readStatus,

    /** GET /api/public/addons/{id}/status */
    async getAddonStatus(request, context) {
      const id = request?.params?.id;
      if (!isKnownAddon(id)) return jsonResponse(404, { error: 'Unknown add-on' });
      try {
        const body = await readStatus(id, context);
        return jsonResponse(200, body, body.configured ? ADDON_STATUS_CACHE_SECONDS : 0);
      } catch (error) {
        // A category and the error's class, never its message: a thrown read can carry a URL.
        context.error(`publicGetAddonStatus failed: ${error?.name ?? 'Error'} (${error?.code ?? 'no code'})`);
        return jsonResponse(500, { error: 'Failed to read the add-on status' });
      }
    },
  };
}
