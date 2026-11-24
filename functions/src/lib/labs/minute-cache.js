/**
 * A one-document, one-minute cache in `tool_service_cache`, for the two
 * anonymous labs reads (#664, #680).
 *
 * Both routes stand in front of something that must not be driven by anonymous
 * traffic — Azure Resource Graph under the Function App's identity, and Coder's
 * API with a read-only token. The bound is the same one the pricing read uses:
 * one document per route, rewritten at most once a minute, however many
 * visitors open the page. `tool_service_cache` already carries a container
 * `default_ttl` (infra/cosmos-containers.json), so a per-document `ttl` of
 * sixty seconds is honoured and a stale entry is deleted for free.
 *
 * Two properties this insists on:
 *
 *   1. **Freshness is checked here, not left to Cosmos.** TTL deletion is
 *      asynchronous, so a document can outlive its `ttl` by a little; the
 *      `cachedAt` stamp is what decides whether an entry is served.
 *   2. **The store is best-effort in both directions.** A failed read means a
 *      live read; a failed write means the next request pays again. Neither
 *      turns into a 500, because the visitor asked about the lab, not about
 *      the cache. The reason is logged at warn.
 */

import { CACHE_CONTAINER } from '../cloud-tools/history.js';
import { errorFacts } from '../http/error-response.js';

export const MINUTE_CACHE_SECONDS = 60;

/**
 * A JSON response, with `Cache-Control` only when the body may be shared.
 * The one shape both labs routes answer with, kept here so the two modules
 * agree on it.
 *
 * @param {number} status
 * @param {object} body
 * @param {number} [cacheSeconds] - 0 means no Cache-Control header
 */
export function jsonResponse(status, body, cacheSeconds = 0) {
  return {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(cacheSeconds > 0 ? { 'Cache-Control': `public, max-age=${cacheSeconds}` } : {}),
    },
    body: JSON.stringify(body),
  };
}

/**
 * @param {object} deps
 * @param {{ readDoc: Function, upsertDoc: Function }} deps.store
 * @param {string} deps.id - the document id, doubling as partition key (`/id`)
 * @param {string} deps.kind - a discriminator written on the document, for anyone reading the container
 * @param {() => number} [deps.now] - epoch ms
 * @param {number} [deps.seconds] - how long an entry is fresh
 */
/** A one-minute cache for one document id in the cache container: `read` returns the fresh value or null, `write` replaces it; neither throws. */
export function createMinuteCache({ store, id, kind, now = () => Date.now(), seconds = MINUTE_CACHE_SECONDS }) {
  const freshMs = seconds * 1000;

  return {
    /** The cached value, or null when there is none, it is stale, or the store failed. */
    async read(context) {
      try {
        const doc = await store.readDoc(CACHE_CONTAINER, id, id);
        if (!doc || doc.value === undefined) return null;
        const cachedAt = Date.parse(doc.cachedAt);
        if (!Number.isFinite(cachedAt) || now() - cachedAt >= freshMs) return null;
        return doc.value;
      } catch (error) {
        // The error's class and code, never its message: a store error can carry an address or a query.
        context?.warn?.(`${id}: cache read failed, reading live: ${errorFacts(error)}`);
        return null;
      }
    },

    /** Replace the entry. Never throws. */
    async write(value, context) {
      try {
        await store.upsertDoc(CACHE_CONTAINER, {
          id,
          kind,
          value,
          cachedAt: new Date(now()).toISOString(),
          ttl: seconds,
        });
      } catch (error) {
        context?.warn?.(`${id}: cache write failed, next request reads live: ${errorFacts(error)}`);
      }
    },
  };
}
