/**
 * The one GET every public read goes through, and its short shared cache.
 * Split out of publicApi.js, which explains the public API in its header and
 * re-exports `clearPublicGetCache`. The sibling files import `publicGet` and
 * `fetchPublicJSON` from here.
 */
import { requireFunctionsBase } from '@/lib/functionsBase';

/**
 * In-flight and recently-resolved GETs, keyed by full path+query (T-716).
 *
 * Three hooks — useBlogData, useProviderLandingContent and useFrameworkData —
 * each request the published corpus under its own `usePublicData` cache key,
 * and `usePublicData` holds state per hook instance, so identical requests were
 * never shared. Walking /aws -> /aws/blog -> /aws/frameworks downloaded the
 * whole corpus three times, bodies included.
 *
 * Deduplicating at the request layer fixes it for every caller at once and
 * changes no filtering semantics, which matters here: the client-side provider
 * matching includes text inference the server does not perform, so pushing the
 * filter server-side would silently drop posts (see T-738).
 *
 * The TTL is deliberately short. This is a read-through convenience for one
 * navigation session, not a cache with an invalidation story: published content
 * changes rarely, and 30 seconds is far below the window in which a visitor
 * would notice.
 */
const PUBLIC_GET_TTL_MS = 30_000;
const publicGetCache = new Map();

/** Exposed for tests; also the honest escape hatch if a caller needs freshness. */
export function clearPublicGetCache() {
  publicGetCache.clear();
}

/** One uncached GET: the JSON body, null for a 404, a thrown Error otherwise. */
export async function fetchPublicJSON(pathAndQuery) {
  const base = requireFunctionsBase(pathAndQuery);
  const res = await fetch(`${base}/${pathAndQuery}`, {
    headers: { Accept: 'application/json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error || `Public API request failed with HTTP ${res.status}`);
  }
  return res.json();
}

export async function publicGet(pathAndQuery) {
  const cached = publicGetCache.get(pathAndQuery);
  // A pending entry is reused regardless of age: two components mounting in the
  // same tick must share one request, which is the concurrent half of the bug.
  if (cached && (cached.pending || Date.now() - cached.at < PUBLIC_GET_TTL_MS)) {
    return cached.promise;
  }

  const promise = fetchPublicJSON(pathAndQuery);

  const entry = { promise, pending: true, at: Date.now() };
  publicGetCache.set(pathAndQuery, entry);
  try {
    const body = await promise;
    entry.pending = false;
    entry.at = Date.now();
    return body;
  } catch (err) {
    // A failure must not be cached: the next caller has to be able to retry.
    publicGetCache.delete(pathAndQuery);
    throw err;
  }
}
