/**
 * sync-present.js — how one Search Console run (sync.js) turns Google's
 * answers into the shapes the admin page reads. Pure functions: no network,
 * no store. sync.js exports them again, so callers keep importing from
 * sync.js.
 */
import { MAX_FIELD, LAG_DAYS, RANGE_DAYS, STRAYS_MAX } from './sync-constants.js';
import { comparableUrl } from './sitemap-parse.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const VERDICTS = new Set(['PASS', 'NEUTRAL', 'FAIL']);

// ── Small pure helpers ───────────────────────────────────────────────────────

const str = (value) => (typeof value === 'string' && value ? value.slice(0, MAX_FIELD) : null);
const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * The Search Analytics date range: `days` days ending LAG_DAYS before today
 * (UTC), both ends included.
 *
 * @param {Date} now
 * @param {number} [days]
 */
export function analyticsRange(now, days = RANGE_DAYS) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const end = today - LAG_DAYS * DAY_MS;
  return { startDate: isoDate(end - (days - 1) * DAY_MS), endDate: isoDate(end) };
}

/** One Search Analytics row as the page shows it. */
export function metrics(row) {
  return {
    clicks: num(row?.clicks),
    impressions: num(row?.impressions),
    ctr: num(row?.ctr),
    position: num(row?.position),
  };
}

/** Rows grouped by one dimension: `{ key, clicks, impressions, ctr, position }`. */
export function presentRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    key: str(Array.isArray(row?.keys) ? row.keys[0] : '') ?? '',
    ...metrics(row),
  }));
}

/** The totals row of an undimensioned query, zeros when Google sent none. */
export function presentTotals(rows) {
  return metrics(Array.isArray(rows) && rows.length ? rows[0] : null);
}

/** The daily rows: `{ date, clicks, impressions, ctr, position }`, oldest first. */
export function presentDaily(rows) {
  return presentRows(rows)
    .map(({ key, ...rest }) => ({ date: key, ...rest }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Pages on the domain or a subdomain with search traffic that the sitemap
 * does not list, most impressions first, at most `max` (STRAYS_MAX, the
 * table's length, unless asked for more).
 *
 * @param {object[]} pageRows - Search Analytics rows grouped by page
 * @param {string[]} sitemapUrls - the pages the sitemap lists (before the cap)
 * @param {{ max?: number }} [options]
 */
export function findStrays(pageRows, sitemapUrls, { max = STRAYS_MAX } = {}) {
  const listed = new Set(sitemapUrls.map(comparableUrl).filter(Boolean));
  return presentRows(pageRows)
    .filter((row) => {
      const key = comparableUrl(row.key);
      return key !== null && !listed.has(key);
    })
    .map((row) => ({ url: row.key, clicks: row.clicks, impressions: row.impressions }))
    .sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks)
    .slice(0, max);
}

/** One inspected page as stored, from Google's UrlInspectionResult. */
export function presentInspection(url, result, inspectedAt = null) {
  const index = result?.indexStatusResult ?? {};
  const verdict = VERDICTS.has(index.verdict) ? index.verdict : 'VERDICT_UNSPECIFIED';
  return {
    url,
    verdict,
    coverageState: str(index.coverageState) ?? '',
    pageFetchState: str(index.pageFetchState) ?? '',
    robotsTxtState: str(index.robotsTxtState) ?? '',
    indexingState: str(index.indexingState) ?? '',
    lastCrawlTime: str(index.lastCrawlTime),
    googleCanonical: str(index.googleCanonical),
    userCanonical: str(index.userCanonical),
    inspectionResultLink: str(result?.inspectionResultLink),
    error: null,
    stale: false,
    inspectedAt,
  };
}

/** A page with no answer from Google: the same shape, with the failure's sentence. */
export function failedInspection(url, note) {
  return {
    url,
    verdict: 'VERDICT_UNSPECIFIED',
    coverageState: '',
    pageFetchState: '',
    robotsTxtState: '',
    indexingState: '',
    lastCrawlTime: null,
    googleCanonical: null,
    userCanonical: null,
    inspectionResultLink: null,
    error: note,
    stale: false,
    inspectedAt: null,
  };
}

/** Whether a stored page entry holds a real answer from Google: a fresh one, or an older one kept. */
const hasResult = (page) => page?.error === null || page?.stale === true;

/**
 * A page this run has no fresh answer for: its inspection failed, or it was
 * not inspected because of the daily budget or Google's quota. Its last
 * answer is kept and marked stale, with `error` saying why it was not
 * refreshed. A page with no earlier answer is a failed entry.
 */
export function keptInspection(previous, url, note) {
  if (previous && hasResult(previous)) return { ...previous, url, stale: true, error: note };
  return failedInspection(url, note);
}

/** `[{ key, count }]`, most first, then by name. */
function tally(values) {
  const counts = new Map();
  for (const value of values) {
    const key = value || 'Not reported';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/**
 * The counts the page's summary cards show: each page by its latest answer
 * from Google, kept (stale) answers included. A page with no answer at all
 * is unknown.
 */
export function summarizeIndexing(pages) {
  const inspected = pages.filter(hasResult);
  const count = (verdict) => inspected.filter((page) => page.verdict === verdict).length;
  const pass = count('PASS');
  const neutral = count('NEUTRAL');
  const fail = count('FAIL');
  return {
    pass,
    neutral,
    fail,
    unknown: pages.length - pass - neutral - fail,
    byCoverageState: tally(inspected.map((page) => page.coverageState)),
    byPageFetchState: tally(inspected.map((page) => page.pageFetchState)),
  };
}

/** Problems first: FAIL, then NEUTRAL, then unknown, then PASS; then by address. */
const VERDICT_ORDER = { FAIL: 0, NEUTRAL: 1, VERDICT_UNSPECIFIED: 2, PASS: 3 };
export function sortPages(pages) {
  return [...pages].sort(
    (a, b) =>
      (VERDICT_ORDER[a.verdict] ?? 2) - (VERDICT_ORDER[b.verdict] ?? 2) ||
      (a.url < b.url ? -1 : a.url > b.url ? 1 : 0)
  );
}

/** The sitemaps as the page shows them; Google sends its counts as strings. */
export function presentSitemaps(list) {
  return (Array.isArray(list) ? list : []).map((entry) => ({
    path: str(entry?.path) ?? '',
    lastSubmitted: str(entry?.lastSubmitted),
    lastDownloaded: str(entry?.lastDownloaded),
    isPending: entry?.isPending === true,
    warnings: num(entry?.warnings),
    errors: num(entry?.errors),
    // Only `submitted` is kept: Google marks `contents[].indexed`
    // "Deprecated; do not use" (https://developers.google.com/webmaster-tools/v1/sitemaps).
    contents: (Array.isArray(entry?.contents) ? entry.contents : []).map((part) => ({
      type: str(part?.type) ?? '',
      submitted: num(part?.submitted),
    })),
  }));
}

/** The snapshot the page reads before any run has written one. */
export function emptySnapshot(siteUrl) {
  return {
    siteUrl,
    generatedAt: null,
    run: null,
    indexing: {
      summary: { pass: 0, neutral: 0, fail: 0, unknown: 0, byCoverageState: [], byPageFetchState: [] },
      pages: [],
      strays: [],
      history: [],
    },
    performance: {
      range: null,
      totals: metrics(null),
      totals28d: metrics(null),
      daily: [],
      queries: [],
      pages: [],
      countries: [],
      devices: [],
      searchAppearance: [],
    },
    sitemaps: [],
  };
}
