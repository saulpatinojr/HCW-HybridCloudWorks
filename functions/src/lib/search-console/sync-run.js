/**
 * sync-run.js — the steps of one Search Console run while it holds the run
 * lease (steps 2 to 7 in sync.js's header). The steps share one plain object,
 * `ctx`, made by createRunContext: what the run was given, what it has read,
 * the notes for the page, and whether it must stop.
 */
import { createGoogleTokenProvider } from './google-auth.js';
import { createSearchConsoleClient } from './client.js';
import { RUN_DEADLINE_MS } from './lease.js';
import { MAX_URLS, PAGE_ROWS_FOR_STRAYS, RANGE_DAYS, SHORT_RANGE_DAYS, SITE_DOMAIN, STRAYS_INSPECTED_MAX, TOP_ROWS } from './sync-constants.js';
import { comparableUrl, selectSiteUrls } from './sitemap-parse.js';
import { readSitemapUrls } from './sitemap-read.js';
import { analyticsRange, findStrays, presentDaily, presentRows, presentSitemaps, presentTotals } from './sync-present.js';
import { failureNote, isFatal } from './sync-notes.js';
import { keepPrevious, saveWhileHeld } from './sync-store.js';
import { inspectPages, noteInspectionStop, reserveBudget, stopped } from './sync-inspect.js';
import { buildSnapshot, timeUp } from './sync-snapshot.js';

/** The Google client: the test seam's, or one signed in with the run's settings. */
function googleClient(deps, config, cancel) {
  if (deps.client) return deps.client;
  return createSearchConsoleClient({
    siteUrl: config.siteUrl,
    auth: createGoogleTokenProvider({
      audience: config.audience,
      appIdUri: config.appIdUri,
      serviceAccountEmail: config.serviceAccountEmail,
      credential: deps.credential,
      env: deps.env,
      fetchImpl: deps.fetchImpl,
      signal: cancel,
    }),
    fetchImpl: deps.fetchImpl,
    sleep: deps.sleep,
  });
}

/** The run's shared state. `cancel` is the run's cancel switch. */
function createRunContext(deps, config, cancel) {
  const startedAt = deps.now();
  const started = startedAt.getTime();
  return {
    deps,
    config,
    cancel,
    startedAt,
    elapsed: () => Math.round((deps.now().getTime() - started) / 1000),
    google: googleClient(deps, config, cancel),
    notes: [],
    fatal: null,
    quotaHit: false,
    budgetOut: false,
    longRange: null,
    shortRange: null,
  };
}

const leaseLost = (ctx) => {
  ctx.deps.info(`stopped: the run lease was lost before saving, nothing written, ${ctx.elapsed()}s`);
  return { skipped: 'lease_lost' };
};

/** A sitemap that could not be read, or lists no page: an error run that keeps everything as it was. */
async function saveSitemapFailure(ctx, lease, sitemap) {
  const finishedAt = ctx.deps.now();
  const message = sitemap.failed
    ? `The sitemap could not be read (${sitemap.failed}), so nothing was asked of Google.`
    : `The sitemap lists no page on ${SITE_DOMAIN} or its subdomains, so nothing was asked of Google.`;
  const run = { startedAt: ctx.startedAt.toISOString(), finishedAt: finishedAt.toISOString(), inspected: 0, failed: 0, stale: 0, message };
  if (!(await saveWhileHeld(ctx.deps.store, lease, (stored) => keepPrevious(stored, ctx.config.siteUrl, run)))) return leaseLost(ctx);
  ctx.deps.info(`error: sitemap ${sitemap.failed ? 'unreadable' : 'empty'}, nothing inspected, ${ctx.elapsed()}s`);
  return { status: 'error', pages: 0, inspected: 0, failed: 0, strays: 0, seconds: ctx.elapsed() };
}

/**
 * 2. The sitemap. Without it there is nothing to inspect and no way to
 * tell a stray, so the run is an error that keeps everything as it was.
 * Returns `{ result }` when the run ends here, else the pages to inspect.
 */
async function sitemapStep(ctx, lease, sitemap) {
  if (ctx.cancel.aborted) {
    // Stopped while the sitemap was read: what was read cannot be trusted
    // to be whole, and nothing has been asked of Google yet.
    ctx.deps.info(`stopped: out of time while reading the sitemap, ${ctx.elapsed()}s`);
    return { result: { status: 'error', aborted: true, pages: 0, inspected: 0, failed: 0, strays: 0, seconds: ctx.elapsed() } };
  }
  const { urls, total } = selectSiteUrls(sitemap.locs);
  if (sitemap.failed || urls.length === 0) return { result: await saveSitemapFailure(ctx, lease, sitemap) };
  if (sitemap.note) ctx.notes.push(sitemap.note);
  if (total > urls.length) ctx.notes.push(`The sitemap lists ${total} pages; only the first ${urls.length} are inspected.`);
  // Every page the sitemap (or the part of it that was read) lists, past
  // the 900 cap included.
  const listed = selectSiteUrls(sitemap.locs, { max: Number.POSITIVE_INFINITY }).urls;
  return { urls, listed };
}

/** A failed call: kept on the run when it stops the run, and its sentence added to the notes. */
function recordFailure(ctx, failure, note) {
  if (isFatal(failure)) ctx.fatal ??= failure;
  ctx.notes.push(note);
}

/**
 * One Search Analytics query, for the whole property with no filter
 * (SITE_DOMAIN's note says why). A query that fails gives null, and that
 * part keeps the last run's figures.
 */
async function runQuery(ctx, label, body) {
  if (stopped(ctx)) return null;
  try {
    return await ctx.google.searchAnalytics(body, { signal: ctx.cancel });
  } catch (failure) {
    // Cut off by the time limit: that part keeps its last figures, and
    // the note about the time limit says why.
    if (ctx.cancel.aborted) return null;
    recordFailure(ctx, failure, `Performance ${label}: ${failureNote(failure, 'the query failed.')} The last figures were kept.`);
    return null;
  }
}

const grouped = (ctx, dimension, rowLimit = TOP_ROWS) => runQuery(ctx, dimension, { ...ctx.longRange, dimensions: [dimension], rowLimit });

/**
 * 3. The strays: pages Google showed in search that the sitemap does not
 * list. Only from a sitemap read in full and a page query that
 * answered; otherwise every page Google shows could look like a stray.
 */
function planTargets(ctx, { sitemap, urls, listed, pageRows }) {
  const strays = sitemap.complete && pageRows !== null ? findStrays(pageRows, listed, { max: Number.POSITIVE_INFINITY }) : null;
  const strayRoom = Math.max(0, Math.min(STRAYS_INSPECTED_MAX, MAX_URLS - urls.length));
  const strayUrls = (strays ?? []).slice(0, strayRoom).map((row) => row.url);
  if (strays && strays.length > strayUrls.length) {
    ctx.notes.push(
      strayUrls.length === 0
        ? `Google shows ${strays.length} pages in search that the sitemap does not list; none were inspected, because the sitemap's pages fill the run's ${MAX_URLS}.`
        : `Google shows ${strays.length} pages in search that the sitemap does not list; only the ${strayUrls.length} with the most impressions are inspected.`
    );
  }
  // Sitemap pages first, so they come first out of the daily budget too.
  const targets = [...urls.map((url) => ({ url, source: 'sitemap' })), ...strayUrls.map((url) => ({ url, source: 'search' }))];
  return { strays, strayUrls, targets };
}

/** The sitemaps Google has, or null when the list could not be read. */
async function readSitemapList(ctx) {
  try {
    return presentSitemaps(await ctx.google.listSitemaps({ signal: ctx.cancel }));
  } catch (failure) {
    if (!ctx.cancel.aborted) recordFailure(ctx, failure, `Sitemaps: ${failureNote(failure, 'the list could not be read.')} The last list was kept.`);
    return null;
  }
}

/**
 * 5 and 6. The rest of Performance, and the sitemaps, unless the run
 * already cannot go on. Fills `parts`; returns the sitemaps, or null.
 */
async function readRest(ctx, parts) {
  if (stopped(ctx)) return null;
  const totals = await runQuery(ctx, 'totals', { ...ctx.longRange });
  const totals28d = await runQuery(ctx, '28-day totals', { ...ctx.shortRange });
  const daily = await grouped(ctx, 'date', 1000);
  const queries = await grouped(ctx, 'query');
  const countries = await grouped(ctx, 'country');
  const devices = await grouped(ctx, 'device');
  // searchAppearance cannot be combined with another dimension, so it is its own query.
  const appearance = await grouped(ctx, 'searchAppearance');
  Object.assign(parts, {
    totals: totals && presentTotals(totals),
    totals28d: totals28d && presentTotals(totals28d),
    daily: daily && presentDaily(daily),
    queries: queries && presentRows(queries),
    countries: countries && presentRows(countries),
    devices: devices && presentRows(devices),
    searchAppearance: appearance && presentRows(appearance),
  });
  if (stopped(ctx)) return null;
  return readSitemapList(ctx);
}

/** 7. Save what the run has, unless the job's own budget ran out. */
async function finishRun(ctx, lease, plan) {
  const { deps } = ctx;
  const { sent } = plan.inspection;
  plan.finishedAt = deps.now();
  const seconds = ctx.elapsed();
  if (deps.signal?.aborted) {
    // The job's budget ran out. Half a run is not written over the last
    // whole one; the job is recorded as timed out by lib/jobs.js.
    deps.info(`stopped: out of time after ${sent} of ${plan.targets.length} pages, ${seconds}s`);
    return { status: 'error', aborted: true, pages: plan.targets.length, inspected: sent, failed: plan.failed, strays: 0, seconds };
  }
  if (timeUp(ctx)) {
    // The run's own time limit: what it has is saved, the rest kept.
    ctx.notes.push(
      `The run reached its ${RUN_DEADLINE_MS / 60000}-minute time limit after ${sent} of ${plan.toInspect.length} pages were sent to Google, so it stopped; the pages it did not finish keep their last result, and any part not read keeps its last figures.`
    );
  }
  const status = ctx.fatal ? 'error' : 'ok';
  // A sitemap read only in part: a page from the last run that is missing
  // from what was read may sit in a child sitemap that could not be read.
  plan.listedAnywhere = plan.sitemap.complete ? null : new Set(plan.listed);
  plan.listedComparable = new Set(plan.listed.map(comparableUrl).filter(Boolean));
  const tallies = { stale: 0, strays: 0 };
  const saved = await saveWhileHeld(deps.store, lease, (stored) => buildSnapshot(stored, ctx, plan, tallies));
  if (!saved) return leaseLost(ctx);

  deps.info(
    `${status}: ${plan.targets.length} pages (${plan.strayUrls.length} from search), ${sent} inspected, ${plan.failed} failed, ${tallies.stale} stale, ${tallies.strays} strays, ${seconds}s`
  );
  return { status, pages: plan.targets.length, inspected: sent, failed: plan.failed, stale: tallies.stale, strays: tallies.strays, seconds };
}

/**
 * The run itself, while this run holds the lease. `counts` tells the caller
 * what to hand back. `cancel` is the run's cancel switch: it fires at the
 * time limit or when the job's own signal fires.
 *
 * @param {object} deps - createSearchConsoleSync's dependencies, with `info` (the log line writer)
 * @param {{ config: object, budget: number, lease: object, counts: { reserved: number, sent: number }, cancel: AbortSignal }} held
 */
export async function runHeld(deps, { config, budget, lease, counts, cancel }) {
  const ctx = createRunContext(deps, config, cancel);
  const sitemap = await readSitemapUrls(deps, cancel);
  const step = await sitemapStep(ctx, lease, sitemap);
  if (step.result) return step.result;

  ctx.longRange = analyticsRange(ctx.startedAt, RANGE_DAYS);
  ctx.shortRange = analyticsRange(ctx.startedAt, SHORT_RANGE_DAYS);
  const pageRows = await grouped(ctx, 'page', PAGE_ROWS_FOR_STRAYS);
  const plan = { sitemap, listed: step.listed, ...planTargets(ctx, { sitemap, urls: step.urls, listed: step.listed, pageRows }) };

  plan.allowed = await reserveBudget(ctx, lease, counts, budget, plan.targets.length);
  plan.toInspect = plan.targets.slice(0, plan.allowed);
  plan.inspection = await inspectPages(ctx, lease, counts, plan.toInspect);
  plan.failed = plan.inspection.failures.size;
  noteInspectionStop(ctx, budget, plan.inspection.sent, plan.toInspect.length);

  plan.performanceParts = { range: ctx.longRange, pages: pageRows && presentRows(pageRows).slice(0, TOP_ROWS) };
  plan.sitemaps = await readRest(ctx, plan.performanceParts);
  return finishRun(ctx, lease, plan);
}
