/** Reaching the origin for the smoke test, waiting out its own firewall when it refuses a burst of requests (smoke-deployed.mjs). */

// ── the origin's own firewall ────────────────────────────────────────────────

/** How long to wait between tries when the origin's firewall refuses a request. */
export const FIREWALL_RETRY_INTERVAL_MS = 5_000;

/**
 * The most waiting the whole run will do for the firewall, across every
 * request: a rule that never arrives costs this once, not once per check.
 */
export const FIREWALL_RETRY_BUDGET_MS = 90_000;

/**
 * Is this the App Service access restriction's own refusal? It answers 403
 * "Ip Forbidden" and names the refused address in `x-ms-forbidden-ip`; the
 * app never sets that header, so an app-level 403 (a guard, the CORS
 * refusal) is not mistaken for it.
 */
export function isOriginFirewallRefusal(res) {
  return res?.status === 403 && Boolean(res.headers?.has?.('x-ms-forbidden-ip'));
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `fetch` that waits out the origin firewall's refusal. Only that refusal is
 * retried; any other status, and any thrown error, is returned or thrown as
 * it came. When the shared budget is spent the last refusal is returned, so
 * the check fails with its 403 rather than waiting forever.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {number} [options.budgetMs]
 * @param {number} [options.intervalMs]
 */
export function createOriginFetch({
  fetchImpl = globalThis.fetch,
  sleep = sleepMs,
  budgetMs = FIREWALL_RETRY_BUDGET_MS,
  intervalMs = FIREWALL_RETRY_INTERVAL_MS,
} = {}) {
  let remainingMs = budgetMs;
  const stats = { retries: 0, waitedMs: 0 };
  async function originFetch(url, init) {
    for (;;) {
      const res = await fetchImpl(url, init);
      if (!isOriginFirewallRefusal(res) || remainingMs < intervalMs) return res;
      // Drain the refusal's body so its connection is released before the retry.
      await res.arrayBuffer?.().catch(() => {});
      remainingMs -= intervalMs;
      stats.retries += 1;
      stats.waitedMs += intervalMs;
      await sleep(intervalMs);
    }
  }
  return Object.assign(originFetch, { stats });
}

export const originFetch = createOriginFetch();

/** One line saying the firewall made the run wait, so a slow green run explains itself. */
export function noteFirewallWaits() {
  const { retries, waitedMs } = originFetch.stats;
  if (retries > 0) {
    console.log(
      `  (the origin firewall refused ${retries} request(s) before this runner's rule reached the front end; waited ${waitedMs / 1000} s in all)`
    );
  }
}
