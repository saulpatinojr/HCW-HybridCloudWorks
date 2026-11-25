/**
 * sync.js — one Search Console run (#1612): what Google knows about each
 * public page, the site's search traffic, and the sitemaps, saved as one
 * document the admin page reads.
 *
 * Run twice a day by the `syncSearchConsole` timer (schedulers.js) and on
 * demand by the page's Run now button, which queues the `sync-search-console`
 * job (functions/search-console-http.js). One run:
 *
 *   0. A run started by a job first checks it is still wanted: when the
 *      queued-job marker (lease.js) names another job still waiting, or a run
 *      finished after this job was queued, the job stops at once with
 *      `{ skipped: 'superseded' }` and calls nothing. So a job's queue
 *      message that arrives late, or twice, never adds a second run.
 *   1. Takes the run lease (lease.js). If another run holds it, this run
 *      stops at once and calls nothing, so two runs never overlap, however
 *      they were started.
 *   2. Reads the sitemap (GSC_SITEMAP_URL; only the main site,
 *      `hybridcloudworks.com`, publishes one), keeps the https pages on
 *      hybridcloudworks.com and every subdomain (owner decision of
 *      2026-11-09 on #1612: the report covers the whole Search Console
 *      property), removes repeats, and stops at 900 pages. A sitemap index
 *      is read one level down, at most 20 child sitemaps, on the main site's
 *      host only. A sitemap that cannot be read, or that lists no such page,
 *      makes the run an error that changes nothing on the page but the
 *      message.
 *   3. Reads the pages Google showed in search over the 90 days (up to 1,000
 *      rows), and from them the "strays": pages on the domain or any
 *      subdomain that got impressions but are not in the sitemap. The 150
 *      strays with the most impressions are inspected too, after the
 *      sitemap's pages, as long as the run stays within its 900 pages.
 *   4. Reserves one inspection per page against the daily budget (lease.js:
 *      1,800 a Pacific-time day, under Google's 2,000), sitemap pages first,
 *      and inspects at most that many pages, four at a time, pacing the
 *      starts so a minute never sees more than about 545 (Google allows
 *      600). Every request sent, client.js's retries included, uses one
 *      reserved inspection; one with none left asks the budget for one more
 *      and is not sent if the day has none. One page failing is recorded on
 *      that page and never fails the run. If Google still answers 429 (quota
 *      used up) after client.js's retries, the run stops inspecting rather
 *      than spend more of the quota on retries.
 *   5. Reads the rest of Search Analytics for the 90 days ending two days ago
 *      (Google's figures lag about two days), for the whole property, with
 *      no filter: totals, a line per day, and the top 50 queries, pages,
 *      countries, devices and search appearances, and the same totals for
 *      the last 28 days.
 *   6. Lists the sitemaps Google has.
 *   7. Checks that it still holds the lease and extends it (lease.js
 *      `renew`), then replaces `admin_config/search_console_snapshot` under
 *      the ETag it was read with (a lost race re-reads and tries again),
 *      carrying a short history of the indexing counts, the last 120 runs
 *      (about two months). A run that no longer holds the lease writes
 *      nothing and returns `{ skipped: 'lease_lost' }`: another run took the
 *      lease after it lapsed, and that run's results are the newer ones.
 *   8. Gives the lease back, handing back any reserved inspections it did
 *      not send.
 *
 * A run has a time limit, RUN_DEADLINE_MS (25 minutes), well inside the
 * lease's 35. When it is reached, the run's cancel switch (an AbortController)
 * fires: no new inspection or query starts, and every call to Google or for a
 * sitemap still waiting for an answer is cut off at once, retries and their
 * pauses included. The run then saves what it has, as in step 5, and the
 * pages it did not reach keep their last answer, marked stale. A job's own
 * cancel signal (lib/jobs.js, at the job's 28-minute budget, which the run's
 * own 25-minute limit always reaches first) fires the same switch, but then
 * nothing is saved: half a run is not written over the last whole one, and
 * the job is recorded as timed out.
 *
 * A degraded run never replaces good figures with worse ones: a page whose
 * inspection failed or was not attempted keeps its last answer, marked
 * `stale: true` with `error` saying why; a Search Analytics query or the
 * sitemaps list that failed keeps the last run's figures for that part; the
 * strays are worked out only from a sitemap read in full and a page query
 * that answered; a sitemap page from the last run that this run's sitemap
 * did not list is dropped only when the sitemap was read in full, and a
 * stray from the last run only when the strays were worked out again
 * (otherwise each is kept, stale); and the history gains a point only from
 * pages inspected afresh in this run.
 *
 * Each stored page says where it came from (`source`: 'sitemap', or
 * 'search' for a stray) and its host name (`host`), so the page can show
 * which site of the domain it is on.
 *
 * When GSC_WIF_AUDIENCE, GSC_ENTRA_APP_ID_URI or GSC_SERVICE_ACCOUNT_EMAIL is
 * empty the run returns `{ skipped: 'not_configured' }` and writes nothing.
 *
 * When Google sign-in fails, Google says the service account may not read
 * the property (401, 403), or Google has no such property (404: the
 * GSC_SITE_URL setting is wrong or the service account cannot see it), the
 * run stops, keeps the last good figures in the document,
 * and records the failure in `run.message` with status 'error', so the page
 * shows both. The caller (the timer or the job) then treats it as a failed
 * run.
 *
 * Log lines carry counts and durations only: no page address, no token and
 * no Google response (house rule for functions/**).
 */
import { defaultSleep } from './client.js';
import { readGoogleAuthConfig } from './google-auth.js';
import { clearPendingJob, createRunLease, dailyBudget, LEASE_TTL_MS, readLease, RUN_DEADLINE_MS, waitingMarkedJob } from './lease.js';
import { INSPECT_SPACING_MS, SUPERSEDE_SLACK_MS } from './sync-constants.js';
import { readStored } from './sync-store.js';
import { runHeld } from './sync-run.js';

// The run's fixed numbers and its pure helpers live in the files beside this
// one; they are exported again here so callers keep importing from sync.js.
export {
  CONCURRENCY,
  CONTAINER,
  DEFAULT_SITEMAP_URL,
  HISTORY_MAX,
  INSPECT_SPACING_MS,
  LAG_DAYS,
  MAX_CHILD_SITEMAPS,
  MAX_URLS,
  NOT_AVAILABLE,
  PAGE_ROWS_FOR_STRAYS,
  RANGE_DAYS,
  SHORT_RANGE_DAYS,
  SITE_DOMAIN,
  SNAPSHOT_DOC_ID,
  SNAPSHOT_DOC_TYPE,
  STRAYS_INSPECTED_MAX,
  STRAYS_MAX,
  SUPERSEDE_SLACK_MS,
  TOP_ROWS,
  WRITE_ATTEMPTS,
} from './sync-constants.js';
export { comparableUrl, hostOf, parseSitemap, selectSiteUrls, siteAddress, sitemapRoot } from './sitemap-parse.js';
export {
  analyticsRange,
  emptySnapshot,
  failedInspection,
  findStrays,
  keptInspection,
  presentDaily,
  presentInspection,
  presentRows,
  presentSitemaps,
  presentTotals,
  sortPages,
  summarizeIndexing,
} from './sync-present.js';
export { failureNote } from './sync-notes.js';

/**
 * For a run a job started: whether that job is no longer needed, so it
 * stops before it takes the lease or calls Google. Two cases:
 *
 *   - The queued-job marker (lease.js) names a different job that is still
 *     waiting or running. That job is the one Run now queued, and it will
 *     do the run. This is how a job queued straight through enqueueJob,
 *     which claims no marker, gives way.
 *   - A run finished after this job was queued (the snapshot's
 *     `run.finishedAt` is later than the job's `createdAt`). A queue
 *     message that arrives late, for example one the jobs sweeper sent
 *     again, would otherwise run a second time for nothing and spend the
 *     day's inspections twice.
 *
 * The timer's runs are never superseded: they have no job.
 */
async function superseded({ store, jobId, jobCreatedAt }, at, leaseDoc) {
  // leaseDoc: the lease document acquire() is about to replace, so the
  // decision and the claim rest on the same read (see run() below).
  const marked = await waitingMarkedJob(store, leaseDoc === undefined ? await readLease(store) : leaseDoc, at);
  if (marked && marked.id !== jobId) return true;
  const created = Date.parse(jobCreatedAt);
  if (!Number.isFinite(created)) return false;
  const finished = Date.parse((await readStored(store))?.run?.finishedAt);
  // Five seconds of slack: finishedAt and createdAt come from different
  // hosts' clocks, and a press just after a run ends must still run.
  return Number.isFinite(finished) && finished > created + SUPERSEDE_SLACK_MS;
}

/**
 * The run's cancel switch: it fires at the time limit, or when the
 * job's own signal fires, and cuts off every call still waiting.
 * `stop()` clears the timer and the listener once the run is over.
 */
function startCancelSwitch(signal, deadlineMs) {
  const cancel = new AbortController();
  const deadline = setTimeout(() => cancel.abort(new Error('run time limit reached')), deadlineMs);
  deadline.unref?.();
  const onJobAbort = () => cancel.abort(signal.reason);
  if (signal?.aborted) cancel.abort(signal.reason);
  else signal?.addEventListener('abort', onJobAbort, { once: true });
  return {
    signal: cancel.signal,
    stop() {
      clearTimeout(deadline);
      signal?.removeEventListener('abort', onJobAbort);
    },
  };
}

/**
 * Run while holding the lease, then give the lease back, handing back any
 * reserved inspections the run did not send.
 */
async function runWithLease(deps, config, budget, lease) {
  const cancel = startCancelSwitch(deps.signal, deps.deadlineMs);
  // What was reserved against the daily budget and what was sent, so the
  // lease gets back the inspections this run did not use.
  const counts = { reserved: 0, sent: 0 };
  try {
    return await runHeld(deps, { config, budget, lease, counts, cancel: cancel.signal });
  } finally {
    cancel.stop();
    try {
      await lease.release({ unused: Math.max(0, counts.reserved - counts.sent) });
    } catch {
      // A timed-out job may no longer write; the lease lapses on its own.
      deps.info(`lease not given back; it lapses within ${LEASE_TTL_MS / 60000} minutes`);
    }
  }
}

/** Why a run stops before it takes the lease, or null when it goes ahead. */
async function skipBeforeLease(deps, config) {
  if (!config.configured) {
    deps.info(`skipped: ${config.missing.length} setting(s) empty`);
    return { skipped: 'not_configured' };
  }
  if (deps.jobId && (await superseded(deps, deps.now()))) {
    // A marker naming this job is cleared, or Run now would wait for it
    // until it lapses.
    await clearPendingJob(deps.store, deps.jobId);
    deps.info('skipped: a newer run or another queued job makes this one unneeded');
    return { skipped: 'superseded' };
  }
  return null;
}

/**
 * @param {object} deps
 * @param {{ readDoc: Function, createDoc: Function, replaceDocIfMatch: Function }} deps.store
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {typeof fetch} [deps.fetchImpl] - for the sitemap and, unless `client` is given, Google
 * @param {object} [deps.client] - test seam: a ready client.js client
 * @param {object} [deps.credential] - test seam: the Azure credential google-auth.js uses
 * @param {() => Date} [deps.now]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {number} [deps.spacingMs]
 * @param {AbortSignal} [deps.signal] - the job's, so a timed-out job stops at once and saves nothing
 * @param {number} [deps.deadlineMs] - the run's time limit (a test seam; RUN_DEADLINE_MS otherwise)
 * @param {string|null} [deps.jobId] - the job's id when a job runs it, kept on the lease for Run now
 * @param {string|null} [deps.jobCreatedAt] - when that job was queued (its document's createdAt)
 * @param {object} [deps.log] - invocation context or logger
 */
export function createSearchConsoleSync({
  store,
  env = process.env,
  fetchImpl = globalThis.fetch,
  client,
  credential,
  now = () => new Date(),
  sleep = defaultSleep,
  spacingMs = INSPECT_SPACING_MS,
  signal,
  deadlineMs = RUN_DEADLINE_MS,
  jobId = null,
  jobCreatedAt = null,
  log,
}) {
  const info = (line) => log?.log?.(`[searchConsoleSync] ${line}`);
  const deps = { store, env, fetchImpl, client, credential, now, sleep, spacingMs, signal, deadlineMs, jobId, jobCreatedAt, info };

  return {
    async run() {
      const config = readGoogleAuthConfig(env);
      const skip = await skipBeforeLease(deps, config);
      if (skip) return skip;
      const budget = dailyBudget(env);
      const lease = createRunLease({ store, now, budget, by: jobId ? 'job' : 'timer', jobId });
      // The superseded check runs again inside acquire(), on the very lease
      // document it replaces with ifMatch. A press that claims the marker,
      // or a run that finishes and releases the lease, changes that
      // document between the check and the write, so the write fails, and
      // acquire() reads again and checks again: the decision and the claim
      // cannot be split (Copilot review of #1615). The check above stays as
      // a cheap early exit that writes nothing.
      const taken = await lease.acquire(jobId ? { admit: async (current, at) => !(await superseded(deps, at, current)) } : undefined);
      if (taken.superseded) {
        info('skipped: a newer run or another queued job makes this one unneeded');
        return { skipped: 'superseded' };
      }
      if (!taken.ok) {
        info('skipped: another run is in progress');
        return { skipped: 'already_running' };
      }
      return runWithLease(deps, config, budget, lease);
    },
  };
}
