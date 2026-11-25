/**
 * sync-snapshot.js — step 7 of a Search Console run (sync.js): the document
 * a finished run saves, built from what it read and the last run's document.
 * A degraded run never replaces good figures with worse ones (sync.js's
 * header says how).
 */
import {
  MAX_URLS,
  NOT_IN_SEARCH_READ,
  NOT_IN_SITEMAP_READ,
  NOT_INSPECTED_BUDGET,
  NOT_INSPECTED_DEADLINE,
  NOT_INSPECTED_QUOTA,
  STRAYS_MAX,
} from './sync-constants.js';
import { comparableUrl, hostOf } from './sitemap-parse.js';
import { emptySnapshot, keptInspection, sortPages, summarizeIndexing } from './sync-present.js';
import { failureNote } from './sync-notes.js';
import { keepPrevious, withHistory } from './sync-store.js';

/** A stored page with where it came from and its host name. */
const withOrigin = (page, source) => ({ ...page, source, host: hostOf(page.url) });

/** Where a stored page came from; a page from before the field existed came from the sitemap. */
const sourceOf = (page) => (page?.source === 'search' ? 'search' : 'sitemap');

/** The time limit was reached (the switch fired, and not because of the job). */
export const timeUp = (ctx) => ctx.cancel.aborted && ctx.deps.signal?.aborted !== true;

/** Why a planned page has no fresh answer, by its place in the plan. */
function notInspected(ctx, plan, index) {
  if (index >= plan.allowed) return NOT_INSPECTED_BUDGET;
  if (timeUp(ctx)) return NOT_INSPECTED_DEADLINE;
  return ctx.quotaHit ? NOT_INSPECTED_QUOTA : NOT_INSPECTED_BUDGET;
}

/** The run's message: the stopping failure's sentence, or the notes, or nothing. */
function runMessage(ctx) {
  if (ctx.fatal) return failureNote(ctx.fatal, 'The run failed.');
  return ctx.notes.length ? ctx.notes.join(' ') : null;
}

/** The last run's pages by address. */
function previousPages(stored) {
  return new Map(
    (Array.isArray(stored?.indexing?.pages) ? stored.indexing.pages : [])
      .filter((page) => page && typeof page.url === 'string')
      .map((page) => [page.url, page])
  );
}

/**
 * A page from the last run that this run did not set out to inspect, kept
 * stale, or null when it is dropped. A sitemap page is dropped when the
 * sitemap was read in full and no longer lists it, and a stray when the
 * strays were worked out again and it is no longer one of those inspected.
 * Otherwise, when this run could not tell (part of the sitemap, or Google's
 * page list, could not be read), the page keeps its last answer, marked stale.
 */
function leftoverPage(url, page, plan) {
  if (sourceOf(page) === 'sitemap') {
    const missing = plan.listedAnywhere && !plan.listedAnywhere.has(url);
    return missing ? withOrigin(keptInspection(page, url, NOT_IN_SITEMAP_READ), 'sitemap') : null;
  }
  const unknown = plan.strays === null && !plan.listedComparable.has(comparableUrl(url));
  return unknown ? withOrigin(keptInspection(page, url, NOT_IN_SEARCH_READ), 'search') : null;
}

/**
 * Every planned page, fresh or kept, then the last run's other pages that
 * are kept, as long as the total stays within MAX_URLS (the snapshot is one
 * document and has to stay small).
 */
function pagesFor(ctx, plan, previous) {
  const { fresh, failures } = plan.inspection;
  const pages = plan.targets.map(({ url, source }, index) =>
    withOrigin(fresh.get(url) ?? keptInspection(previous.get(url), url, failures.get(url) ?? notInspected(ctx, plan, index)), source)
  );
  const planned = new Set(plan.targets.map((target) => target.url));
  for (const [url, page] of previous) {
    if (pages.length >= MAX_URLS) break;
    if (planned.has(url)) continue;
    const kept = leftoverPage(url, page, plan);
    if (kept) pages.push(kept);
  }
  return pages;
}

/** History counts only pages Google answered in this run. */
function historyEntry(fresh, run) {
  if (fresh.size === 0) return null;
  const summary = summarizeIndexing([...fresh.values()]);
  return { at: run.finishedAt, pass: summary.pass, neutral: summary.neutral, fail: summary.fail, inspected: fresh.size, failed: run.failed };
}

/** This run's Performance figures over the last run's, part by part: a part that failed keeps its last figures. */
function mergePerformance(base, siteUrl, parts) {
  const performance = { ...emptySnapshot(siteUrl).performance, ...(base.performance ?? {}) };
  for (const [key, value] of Object.entries(parts)) {
    if (value !== null && value !== undefined) performance[key] = value;
  }
  return performance;
}

/**
 * The document to save. `tallies` is filled with the stale and stray counts
 * for the run's log line and result.
 *
 * @param {object|null} stored - the document as read for this write
 * @param {object} ctx - the run's shared state
 * @param {object} plan - what the run set out to do and what it got
 * @param {{ stale: number, strays: number }} tallies
 */
export function buildSnapshot(stored, ctx, plan, tallies) {
  const siteUrl = ctx.config.siteUrl;
  const run = {
    startedAt: ctx.startedAt.toISOString(),
    finishedAt: plan.finishedAt.toISOString(),
    inspected: plan.inspection.sent,
    failed: plan.failed,
    stale: 0,
    message: runMessage(ctx),
  };
  if (ctx.fatal) return keepPrevious(stored, siteUrl, run);

  const pages = pagesFor(ctx, plan, previousPages(stored));
  run.stale = pages.filter((page) => page.stale).length;
  tallies.stale = run.stale;
  const sortedPages = sortPages(pages);
  const base = stored ?? emptySnapshot(siteUrl);
  const keptStrays = Array.isArray(base.indexing?.strays) ? base.indexing.strays : [];
  const strayTable = plan.strays ? plan.strays.slice(0, STRAYS_MAX) : keptStrays;
  tallies.strays = strayTable.length;
  return {
    siteUrl,
    status: 'ok',
    generatedAt: run.finishedAt,
    run,
    indexing: {
      summary: summarizeIndexing(sortedPages),
      pages: sortedPages,
      strays: strayTable,
      history: withHistory(stored, historyEntry(plan.inspection.fresh, run)),
    },
    performance: mergePerformance(base, siteUrl, plan.performanceParts),
    sitemaps: plan.sitemaps ?? (Array.isArray(base.sitemaps) ? base.sitemaps : []),
  };
}
