/**
 * fetch-with-timeout.js — the one outbound-HTTP helper (T-712).
 *
 * Node's `fetch` has NO default timeout. A hung socket therefore hangs the
 * caller forever, and several of this platform's callers run inside change-feed
 * handlers, where "forever" means the lease is never checkpointed and every
 * subsequent change on that container queues behind the stuck invocation. One
 * unresponsive third party stalls the pipeline instead of failing one document.
 *
 * The behaviour was never unknown here — `content/scrape.js`, `ai/router.js`,
 * `ai/mcp.js`, `triggers/fetch-image.js` and `timers/link-check.js` each had
 * their own AbortController. What was missing was the same discipline on the
 * calls to Replicate, Publer and Telegram. This module is that helper lifted
 * out so there is one implementation to reason about and one place to change
 * the semantics.
 *
 * Deliberately thin: it does not retry, does not inspect status codes, and does
 * not parse bodies. Callers differ on all three (Replicate polls, Telegram must
 * never retry-storm, Publer reconciles later), so a helper that decided those
 * things would be wrong for most of them.
 */

/** Milliseconds a call may take before it is aborted, when the caller says nothing. */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/**
 * `fetch` with a hard deadline.
 *
 * @param {Function} fetchImpl - injected for testability; normally globalThis.fetch
 * @param {string} url
 * @param {object} [options] - passed through to fetch, minus `timeoutMs`
 * @param {number} [options.timeoutMs]
 * @returns {Promise<Response>}
 * @throws {Error} `timeout after N ms` when the deadline passes, so a timeout
 *   reads as a timeout in logs rather than as an opaque AbortError.
 */
export async function fetchWithTimeout(fetchImpl, url, options = {}) {
  const { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, signal: parentSignal, ...rest } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let onParentAbort;
  if (parentSignal) {
    if (parentSignal.aborted) {
      clearTimeout(timer);
      throw parentSignal.reason || new Error('aborted');
    }
    onParentAbort = () => controller.abort(parentSignal.reason);
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }

  try {
    return await fetchImpl(url, { ...rest, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError' && !parentSignal?.aborted) {
      throw Object.assign(new Error(`timeout after ${timeoutMs} ms`), { code: 'FETCH_TIMEOUT' });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (parentSignal && onParentAbort) {
      parentSignal.removeEventListener('abort', onParentAbort);
    }
  }
}
