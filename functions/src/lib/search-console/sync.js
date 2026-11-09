/**
 * sync.js — one Search Console run (#1612): what Google knows about each
 * public page, the site's search traffic, and the sitemaps, saved as one
 * document the admin page reads.
 *
 * Run twice a day by the `syncSearchConsole` timer (schedulers.js) and on
 * demand by the page's Run now button, which queues the `sync-search-console`
 * job (functions/search-console-http.js). One run:
 *
 *   0. Takes the run lease (lease.js). If another run holds it, this run
 *      stops at once and calls nothing, so two runs never overlap, however
 *      they were started.
 *   1. Reads the sitemap (GSC_SITEMAP_URL), keeps only pages on the root
 *      domain `hybridcloudworks.com` (owner decision on #1612), removes
 *      repeats, and stops at 900 pages. A sitemap index is read one level
 *      down, at most 20 child sitemaps. A sitemap that cannot be read, or
 *      that lists no such page, makes the run an error that changes nothing
 *      on the page but the message.
 *   2. Reserves one inspection per page against the daily budget (lease.js:
 *      1,800 a Pacific-time day, under Google's 2,000), and inspects at most
 *      that many pages, four at a time, pacing the starts so a minute never
 *      sees more than about 545 (Google allows 600). Every request sent,
 *      client.js's retries included, uses one reserved inspection; one with
 *      none left asks the budget for one more and is not sent if the day
 *      has none. One page failing is recorded on that page and never fails
 *      the run. If Google still answers 429 (quota used up) after
 *      client.js's retries, the run stops inspecting rather than spend more
 *      of the quota on retries.
 *   3. Reads Search Analytics for the 90 days ending two days ago (Google's
 *      figures lag about two days), for pages under
 *      `https://hybridcloudworks.com/` only: the property is a Domain
 *      property, which also counts every subdomain, and the owner decided
 *      the page covers the root domain only. Totals, a line per day, and the
 *      top 50 queries, pages, countries, devices and search appearances; the
 *      same totals for the last 28 days; and up to 1,000 pages, from which
 *      the "strays" are found: root-domain pages that get impressions but
 *      are not in the sitemap.
 *   4. Lists the sitemaps Google has.
 *   5. Replaces `admin_config/search_console_snapshot` under the ETag it was
 *      read with (a lost race re-reads and tries again), carrying a short
 *      history of the indexing counts, the last 120 runs (about two months).
 *   6. Gives the lease back, handing back any reserved inspections it did
 *      not send.
 *
 * A degraded run never replaces good figures with worse ones: a page whose
 * inspection failed or was not attempted keeps its last answer, marked
 * `stale: true` with `error` saying why; a Search Analytics query or the
 * sitemaps list that failed keeps the last run's figures for that part; the
 * strays are worked out only from a sitemap read in full; a page from the
 * last run that this run's sitemap did not list is dropped only when the
 * sitemap was read in full (otherwise it is kept, stale); and the history
 * gains a point only from pages inspected afresh in this run.
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
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { fetchWithTimeout } from '../http/fetch-with-timeout.js';
import { createGoogleTokenProvider, GoogleAuthError, readGoogleAuthConfig } from './google-auth.js';
import { createSearchConsoleClient, defaultSleep, SearchConsoleError } from './client.js';
import { budgetSpentMessage, createRunLease, dailyBudget, LEASE_TTL_MS, nextPacificMidnight } from './lease.js';

export const CONTAINER = 'admin_config';
export const SNAPSHOT_DOC_ID = 'search_console_snapshot';
export const SNAPSHOT_DOC_TYPE = 'search_console_snapshot';

export const SITE_HOST = 'hybridcloudworks.com';
export const DEFAULT_SITEMAP_URL = `https://${SITE_HOST}/sitemap.xml`;
export const MAX_URLS = 900;
export const CONCURRENCY = 4;
/** Gap between inspection starts: 110 ms is at most about 545 a minute, under Google's 600. */
export const INSPECT_SPACING_MS = 110;
export const HISTORY_MAX = 120;
export const STRAYS_MAX = 100;
export const TOP_ROWS = 50;
export const PAGE_ROWS_FOR_STRAYS = 1000;
export const RANGE_DAYS = 90;
export const SHORT_RANGE_DAYS = 28;
/** Google's Search Analytics data lags about two days. */
export const LAG_DAYS = 2;
/**
 * A sitemap index may point at this many child sitemaps. When it lists more,
 * the rest are not read, and the run treats the sitemap as not read in full.
 */
export const MAX_CHILD_SITEMAPS = 20;
export const WRITE_ATTEMPTS = 3;
/** Long strings from Google are cut to this length before they are stored. */
const MAX_FIELD = 2048;

/** What Google's API does not offer, shown on the page as is. */
export const NOT_AVAILABLE = Object.freeze(['Page indexing totals and reasons', 'Links (internal and external)']);

const DAY_MS = 24 * 60 * 60 * 1000;

/** A string as a regular expression (RE2 or JavaScript) that matches it literally. */
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The filter every Search Analytics query carries: pages whose address starts
 * with `https://hybridcloudworks.com/`. The property is a Domain property
 * (`sc-domain:`), which also counts `api-azure.` and the lab subdomains; the
 * owner decided the page reports the root domain only (#1612). The host is
 * SITE_HOST, the same one the sitemap's pages are chosen by.
 *
 * `includingRegex` takes an RE2 regular expression
 * (https://developers.google.com/webmaster-tools/v1/searchanalytics/query).
 * The same page says that a query grouped or filtered by page cannot be
 * aggregated by property: Google adds it up by page (by canonical address)
 * instead, so these totals can differ from the property-wide totals in
 * Google's own Performance screen. Google's help explains the difference:
 * https://support.google.com/webmasters/answer/6155685#urlorsite
 */
export const ROOT_DOMAIN_FILTER = Object.freeze([
  Object.freeze({
    groupType: 'and',
    filters: Object.freeze([
      Object.freeze({ dimension: 'page', operator: 'includingRegex', expression: `^https://${escapeRegex(SITE_HOST)}/` }),
    ]),
  }),
]);
const VERDICTS = new Set(['PASS', 'NEUTRAL', 'FAIL']);

// ── Small pure helpers ───────────────────────────────────────────────────────

const str = (value) => (typeof value === 'string' && value ? value.slice(0, MAX_FIELD) : null);
const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

const NAMED_ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };

/** One numeric character reference (`&#38;`, `&#x26;`) as its character, or as written when it is not a real one. */
function codePoint(text, code) {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : text;
}

/**
 * Undo the XML escapes a sitemap may use in an address: the five named ones
 * and numeric ones in decimal or hex. One pass, so `&amp;lt;` becomes `&lt;`
 * and is not undone a second time.
 */
function decodeXml(value) {
  return value.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (text, name) => {
    if (name[0] !== '#') return NAMED_ENTITIES[name.toLowerCase()] ?? text;
    const hex = name[1] === 'x' || name[1] === 'X';
    return codePoint(text, Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10));
  });
}

/**
 * The `<loc>` addresses in a sitemap or sitemap index, in order, and whether
 * it is an index (a list of further sitemaps rather than pages).
 *
 * @param {string} xml
 * @returns {{ isIndex: boolean, locs: string[] }}
 */
export function parseSitemap(xml) {
  const source = typeof xml === 'string' ? xml : '';
  const isIndex = /<sitemapindex[\s>]/i.test(source);
  const locs = [...source.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) =>
    decodeXml(m[1].trim())
  );
  return { isIndex, locs };
}

/** The URL when it is an https address on exactly the site's root host, else null. */
function rootDomainUrl(value, host = SITE_HOST) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.toLowerCase() === host ? url : null;
  } catch {
    return null;
  }
}

/**
 * The pages to inspect: root-domain https addresses only, first occurrence
 * kept, at most `max`.
 *
 * @param {string[]} locs
 * @param {{ host?: string, max?: number }} [options]
 * @returns {{ urls: string[], total: number }} total is before the cap
 */
export function selectSiteUrls(locs, { host = SITE_HOST, max = MAX_URLS } = {}) {
  const seen = new Set();
  const kept = [];
  for (const loc of locs) {
    if (!rootDomainUrl(loc, host)) continue;
    if (seen.has(loc)) continue;
    seen.add(loc);
    kept.push(loc);
  }
  return { urls: kept.slice(0, max), total: kept.length };
}

/** An address in one spelling for comparing: lower-case host, no trailing slash past the root, no fragment. */
export function comparableUrl(value) {
  const url = rootDomainUrl(value);
  if (!url) return null;
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  return `https://${url.hostname.toLowerCase()}${path}${url.search}`;
}

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
function metrics(row) {
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
 * Root-domain pages with search traffic that the sitemap does not list,
 * most impressions first, at most STRAYS_MAX.
 *
 * @param {object[]} pageRows - Search Analytics rows grouped by page
 * @param {string[]} sitemapUrls - the pages the sitemap lists (before the cap)
 */
export function findStrays(pageRows, sitemapUrls) {
  const listed = new Set(sitemapUrls.map(comparableUrl).filter(Boolean));
  return presentRows(pageRows)
    .filter((row) => {
      const key = comparableUrl(row.key);
      return key !== null && !listed.has(key);
    })
    .map((row) => ({ url: row.key, clicks: row.clicks, impressions: row.impressions }))
    .sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks)
    .slice(0, STRAYS_MAX);
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

/**
 * A sentence about a failure for the page, built from the failure's kind and
 * HTTP status only. An AuthoredError from client.js or google-auth.js
 * already has a sentence of this file's family; anything else gets a fixed one.
 */
export function failureNote(failure, fallback) {
  if (failure instanceof GoogleAuthError || failure instanceof SearchConsoleError) {
    const status = Number.isInteger(failure.status) ? failure.status : null;
    if (failure instanceof GoogleAuthError) return describeAuth(failure.kind, status);
    return describeCall(failure.kind, status, failure.reason ?? null);
  }
  return fallback;
}

function describeAuth(kind, status) {
  const hop = { entra: 'hop 1 (Entra token)', sts: 'hop 2 (Google token exchange)', impersonation: 'hop 3 (service account token)' }[kind] ?? 'an unknown hop';
  return `Google sign-in failed at ${hop}${status === null ? '' : ` with HTTP ${status}`}. The runbook's setup steps say what each hop needs.`;
}

function describeCall(kind, status, reason) {
  if (reason === 'unreadable') return `Search Console ${kind} sent an answer that is not what Google documents, so it was not used.`;
  if (reason === 'not_sent') return NOT_INSPECTED_BUDGET;
  if (status === 403) return 'Google answered 403: the service account is not a Full user on the Search Console property.';
  if (status === 404)
    return "Google answered 404: it has no Search Console property at the address in the GSC_SITE_URL setting, or the service account cannot see it. Check the setting against the property's name in Search Console.";
  if (status === 429) return `Search Console ${kind} hit Google's quota (HTTP 429).`;
  if (status === null) return `Search Console ${kind} could not be reached.`;
  return `Search Console ${kind} failed with HTTP ${status}.`;
}

/**
 * Is this failure one that every later call would hit too? Then the run
 * stops. 401 and 403: Google will not let the service account read the
 * property. 404: Google has no property at GSC_SITE_URL, or the service
 * account cannot see it, so every call would get the same answer.
 */
function isFatal(failure) {
  if (failure instanceof GoogleAuthError) return true;
  return failure instanceof SearchConsoleError && [401, 403, 404].includes(failure.status);
}

/** A request client.js held back because the day's inspections are used up. */
const isNotSent = (failure) => failure instanceof SearchConsoleError && failure.reason === 'not_sent';

const NOT_INSPECTED_BUDGET = 'Not inspected in the last run: the daily allowance of Google page inspections was used up.';
const NOT_INSPECTED_QUOTA = 'Not inspected in the last run: Google answered that its quota was used up.';
const NOT_IN_SITEMAP_READ = 'Not inspected in the last run: the sitemap could not be read in full, and the part that was read does not list this page.';

/** Google's quota answer (HTTP 429), still there after client.js's retries. */
const isQuota = (failure) => failure instanceof SearchConsoleError && failure.status === 429;

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

// ── Running a set of tasks a few at a time ───────────────────────────────────

/**
 * Run `task(item)` over `items`, at most `limit` at once, with at least
 * `spacingMs` between starts. Stops starting new tasks once `stop()` is true.
 */
async function runPaced(items, { limit, spacingMs, sleep, now, stop, task }) {
  let next = 0;
  let nextStartAt = 0;
  async function lane() {
    while (next < items.length && !stop()) {
      const index = next;
      next += 1;
      const wait = nextStartAt - now();
      nextStartAt = Math.max(now(), nextStartAt) + spacingMs;
      if (wait > 0) await sleep(wait);
      if (stop()) return;
      await task(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

// ── The run ──────────────────────────────────────────────────────────────────

const isWriteConflict = (failure) => {
  const status = failure?.code ?? failure?.statusCode;
  return status === 412 || status === 409;
};

const utcMinute = (date) => `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

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
 * @param {AbortSignal} [deps.signal] - the job's, so a timed-out job stops starting inspections
 * @param {string|null} [deps.jobId] - the job's id when a job runs it, kept on the lease for Run now
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
  jobId = null,
  log,
}) {
  const info = (line) => log?.log?.(`[searchConsoleSync] ${line}`);

  /**
   * The sitemap's `<loc>` entries. `failed` says why the sitemap could not be
   * read at all; `complete` is false when any part of it was not read (a
   * child sitemap of an index that failed, or children past the first
   * MAX_CHILD_SITEMAPS), so the strays are not worked out from it and pages
   * it may have left out are kept rather than dropped.
   */
  async function readSitemapUrls() {
    const root = (typeof env.GSC_SITEMAP_URL === 'string' && env.GSC_SITEMAP_URL.trim()) || DEFAULT_SITEMAP_URL;
    const fetchXml = async (address) => {
      try {
        const response = await fetchWithTimeout(fetchImpl, address, { headers: { Accept: 'application/xml, text/xml' } });
        if (!response.ok) return { failed: `HTTP ${response.status}` };
        return { xml: await response.text() };
      } catch {
        return { failed: 'unreachable' };
      }
    };
    const first = await fetchXml(root);
    if (first.failed) return { locs: [], failed: first.failed, complete: false, note: null };
    const parsed = parseSitemap(first.xml);
    if (!parsed.isIndex) return { locs: parsed.locs, failed: null, complete: true, note: null };
    // A sitemap index: read each child sitemap on the site's own host, at
    // most MAX_CHILD_SITEMAPS of them.
    const sameHost = parsed.locs.filter((loc) => rootDomainUrl(loc));
    const children = sameHost.slice(0, MAX_CHILD_SITEMAPS);
    const skipped = sameHost.length - children.length;
    const locs = [];
    let unread = 0;
    for (const child of children) {
      const answer = await fetchXml(child);
      if (answer.failed) unread += 1;
      else locs.push(...parseSitemap(answer.xml).locs);
    }
    if (children.length > 0 && unread === children.length) {
      return { locs: [], failed: `none of its ${children.length} child sitemaps could be read`, complete: false, note: null };
    }
    const gaps = [];
    if (unread) gaps.push(`${unread} of ${children.length} child sitemaps could not be read`);
    if (skipped) gaps.push(`the sitemap index lists ${sameHost.length} child sitemaps and only the first ${MAX_CHILD_SITEMAPS} were read`);
    if (gaps.length === 0) return { locs, failed: null, complete: true, note: null };
    const said = gaps.join('; ');
    return {
      locs,
      failed: null,
      complete: false,
      note: `${said[0].toUpperCase()}${said.slice(1)}, so the strays were not worked out this run, and pages the part read does not list keep their last result.`,
    };
  }

  async function readStored() {
    return store.readDoc(CONTAINER, SNAPSHOT_DOC_ID, ADMIN_CONFIG_PARTITION);
  }

  /** Write `build(stored)` under the ETag `stored` was read with; retry a lost race. */
  async function save(build) {
    for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
      const stored = await readStored();
      const doc = {
        ...build(stored),
        id: SNAPSHOT_DOC_ID,
        configScope: ADMIN_CONFIG_PARTITION,
        docType: SNAPSHOT_DOC_TYPE,
      };
      try {
        if (stored) {
          await store.replaceDocIfMatch(CONTAINER, { ...doc, _etag: stored._etag }, { partitionKey: ADMIN_CONFIG_PARTITION });
        } else {
          await store.createDoc(CONTAINER, doc);
        }
        return doc;
      } catch (failure) {
        if (!isWriteConflict(failure) || attempt === WRITE_ATTEMPTS) throw failure;
      }
    }
    return null;
  }

  /** A failed run's document: the last good figures kept, only the status and run replaced. */
  const keepPrevious = (stored, siteUrl, run) => ({
    ...emptySnapshot(siteUrl),
    ...pick(stored),
    siteUrl,
    status: 'error',
    run,
  });

  /** The stored history with this run's entry added, newest last, at most HISTORY_MAX. */
  const withHistory = (stored, entry) => {
    const previous = Array.isArray(stored?.indexing?.history) ? stored.indexing.history : [];
    return entry ? [...previous, entry].slice(-HISTORY_MAX) : previous.slice(-HISTORY_MAX);
  };

  /** The run itself, while this run holds the lease. `counts` tells the caller what to hand back. */
  async function runHeld(config, budget, lease, counts) {
    const startedAt = now();
    const started = startedAt.getTime();
    const elapsed = () => Math.round((now().getTime() - started) / 1000);
    const google =
      client ??
      createSearchConsoleClient({
        siteUrl: config.siteUrl,
        auth: createGoogleTokenProvider({
          audience: config.audience,
          appIdUri: config.appIdUri,
          serviceAccountEmail: config.serviceAccountEmail,
          credential,
          env,
          fetchImpl,
        }),
        fetchImpl,
        sleep,
      });

    const notes = [];
    let fatal = null;
    let quotaHit = false;
    const stopped = () => fatal !== null || signal?.aborted === true;

    // 1. The sitemap. Without it there is nothing to inspect and no way to
    // tell a stray, so the run is an error that keeps everything as it was.
    const sitemap = await readSitemapUrls();
    const { urls, total } = selectSiteUrls(sitemap.locs);
    if (sitemap.failed || urls.length === 0) {
      const finishedAt = now();
      const message = sitemap.failed
        ? `The sitemap could not be read (${sitemap.failed}), so nothing was asked of Google.`
        : `The sitemap lists no page on ${SITE_HOST}, so nothing was asked of Google.`;
      const run = { startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), inspected: 0, failed: 0, stale: 0, message };
      await save((stored) => keepPrevious(stored, config.siteUrl, run));
      info(`error: sitemap ${sitemap.failed ? 'unreadable' : 'empty'}, nothing inspected, ${elapsed()}s`);
      return { status: 'error', pages: 0, inspected: 0, failed: 0, strays: 0, seconds: elapsed() };
    }
    if (sitemap.note) notes.push(sitemap.note);
    if (total > urls.length) notes.push(`The sitemap lists ${total} root-domain pages; only the first ${urls.length} are inspected.`);

    // 2. The daily budget: reserve one inspection per page before sending any.
    const allowed = await lease.reserve(urls.length);
    counts.reserved = allowed;
    if (allowed === 0) {
      notes.push(`${budgetSpentMessage(startedAt, budget)} No page was inspected; each keeps its last result.`);
    } else if (allowed < urls.length) {
      notes.push(
        `Only ${allowed} of ${urls.length} pages fit in what is left of today's allowance of ${budget.toLocaleString('en-US')} Google page inspections; the rest keep their last result until it starts again at midnight Pacific time (${utcMinute(nextPacificMidnight(startedAt))}).`
      );
    }
    const toInspect = urls.slice(0, allowed);

    // Every request sent to URL Inspection, client.js's retries included,
    // uses one inspection this run reserved (counts.sent against
    // counts.reserved). Once they are all used, one more is asked of the
    // budget before a request goes out, and the request is not sent when the
    // day has none left. The asks are made one at a time, so this run's own
    // four lanes do not race each other for the lease document.
    let budgetOut = false;
    let unitQueue = Promise.resolve(true);
    const takeInspection = () => {
      unitQueue = unitQueue.then(async () => {
        if (counts.sent < counts.reserved) {
          counts.sent += 1;
          return true;
        }
        if (stopped()) return false;
        const more = await lease.reserve(1).catch(() => 0);
        if (more > 0) {
          counts.reserved += more;
          counts.sent += 1;
          return true;
        }
        budgetOut = true;
        return false;
      });
      return unitQueue;
    };

    // 3. Inspect each page in the allowance.
    const fresh = new Map();
    const failures = new Map();
    const inspectedAt = startedAt.toISOString();
    let sent = 0;
    await runPaced(toInspect, {
      limit: CONCURRENCY,
      spacingMs,
      sleep,
      now: () => now().getTime(),
      stop: () => stopped() || quotaHit || budgetOut,
      task: async (url) => {
        try {
          sent += 1;
          fresh.set(url, presentInspection(url, await google.inspect(url, { beforeSend: takeInspection }), inspectedAt));
        } catch (failure) {
          // Held back before its first request: the page was not inspected
          // at all, and keeps its last result like the pages after it.
          if (isNotSent(failure)) {
            sent -= 1;
            return;
          }
          if (isFatal(failure)) fatal ??= failure;
          if (isQuota(failure)) quotaHit = true;
          failures.set(url, failureNote(failure, 'The inspection failed.'));
        }
      },
    });
    const failed = failures.size;
    if (quotaHit) {
      notes.push(
        `Google still answered 429 (quota used up) after retries, so the run stopped inspecting after ${sent} of ${toInspect.length} pages; the rest keep their last result.`
      );
    } else if (budgetOut) {
      notes.push(
        `Retries used up what was left of today's allowance of ${budget.toLocaleString('en-US')} Google page inspections, so the run stopped inspecting after ${sent} of ${toInspect.length} pages; the rest keep their last result.`
      );
    }

    // 4 and 5. Performance and sitemaps, unless the run already cannot go on.
    // A query that fails gives null, and that part keeps the last run's figures.
    let performanceParts = null;
    let pageRows = null;
    let sitemaps = null;
    if (!stopped()) {
      const longRange = analyticsRange(startedAt, RANGE_DAYS);
      const shortRange = analyticsRange(startedAt, SHORT_RANGE_DAYS);
      // Every query, the undimensioned totals included, carries the
      // root-domain filter (ROOT_DOMAIN_FILTER says why, and what it does to
      // the totals).
      const query = async (label, body) => {
        if (stopped()) return null;
        try {
          return await google.searchAnalytics({ ...body, dimensionFilterGroups: ROOT_DOMAIN_FILTER });
        } catch (failure) {
          if (isFatal(failure)) fatal ??= failure;
          notes.push(`Performance ${label}: ${failureNote(failure, 'the query failed.')} The last figures were kept.`);
          return null;
        }
      };
      const grouped = (dimension, rowLimit = TOP_ROWS) => query(dimension, { ...longRange, dimensions: [dimension], rowLimit });
      const totals = await query('totals', { ...longRange });
      const totals28d = await query('28-day totals', { ...shortRange });
      const daily = await grouped('date', 1000);
      const queries = await grouped('query');
      pageRows = await grouped('page', PAGE_ROWS_FOR_STRAYS);
      const countries = await grouped('country');
      const devices = await grouped('device');
      // searchAppearance cannot be combined with another dimension, so it is its own query.
      const appearance = await grouped('searchAppearance');
      performanceParts = {
        range: longRange,
        totals: totals && presentTotals(totals),
        totals28d: totals28d && presentTotals(totals28d),
        daily: daily && presentDaily(daily),
        queries: queries && presentRows(queries),
        pages: pageRows && presentRows(pageRows).slice(0, TOP_ROWS),
        countries: countries && presentRows(countries),
        devices: devices && presentRows(devices),
        searchAppearance: appearance && presentRows(appearance),
      };
      if (!stopped()) {
        try {
          sitemaps = presentSitemaps(await google.listSitemaps());
        } catch (failure) {
          if (isFatal(failure)) fatal ??= failure;
          notes.push(`Sitemaps: ${failureNote(failure, 'the list could not be read.')} The last list was kept.`);
        }
      }
    }
    // Strays only from a sitemap read in full and a page query that answered;
    // otherwise every page Google shows could look like a stray.
    const strays =
      sitemap.complete && pageRows !== null
        ? findStrays(pageRows, selectSiteUrls(sitemap.locs, { max: Number.POSITIVE_INFINITY }).urls)
        : null;

    const finishedAt = now();
    const seconds = elapsed();
    if (signal?.aborted) {
      // The job's budget ran out. Half a run is not written over the last
      // whole one; the job is recorded as timed out by lib/jobs.js.
      info(`stopped: out of time after ${sent} of ${urls.length} pages, ${seconds}s`);
      return { status: 'error', aborted: true, pages: urls.length, inspected: sent, failed, strays: 0, seconds };
    }
    const status = fatal ? 'error' : 'ok';
    const notInspected = (index) => (index >= allowed || !quotaHit ? NOT_INSPECTED_BUDGET : NOT_INSPECTED_QUOTA);
    // Every root-domain page the part of the sitemap that was read lists,
    // past the 900 cap included: a page from the last run that is missing
    // from this list may sit in a child sitemap that could not be read.
    const listedAnywhere = sitemap.complete ? null : new Set(selectSiteUrls(sitemap.locs, { max: Number.POSITIVE_INFINITY }).urls);
    let staleCount = 0;
    let strayCount = 0;

    await save((stored) => {
      const run = {
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        inspected: sent,
        failed,
        stale: 0,
        message: fatal ? failureNote(fatal, 'The run failed.') : notes.length ? notes.join(' ') : null,
      };
      if (fatal) return keepPrevious(stored, config.siteUrl, run);

      const previous = new Map(
        (Array.isArray(stored?.indexing?.pages) ? stored.indexing.pages : [])
          .filter((page) => page && typeof page.url === 'string')
          .map((page) => [page.url, page])
      );
      const pages = urls.map(
        (url, index) => fresh.get(url) ?? keptInspection(previous.get(url), url, failures.get(url) ?? notInspected(index))
      );
      // A sitemap read in full is the list: a page it no longer lists is
      // dropped. One read only in part may have lost pages with the part it
      // could not read, so those keep their last answer, marked stale, as
      // long as the total stays within MAX_URLS (the snapshot is one
      // document and has to stay small).
      if (listedAnywhere) {
        for (const [url, page] of previous) {
          if (pages.length >= MAX_URLS) break;
          if (listedAnywhere.has(url)) continue;
          pages.push(keptInspection(page, url, NOT_IN_SITEMAP_READ));
        }
      }
      run.stale = pages.filter((page) => page.stale).length;
      staleCount = run.stale;
      const sortedPages = sortPages(pages);
      // History counts only pages Google answered in this run.
      const freshSummary = summarizeIndexing([...fresh.values()]);
      const entry =
        fresh.size > 0
          ? { at: run.finishedAt, pass: freshSummary.pass, neutral: freshSummary.neutral, fail: freshSummary.fail, inspected: fresh.size, failed }
          : null;
      const base = stored ?? emptySnapshot(config.siteUrl);
      const previousPerformance = { ...emptySnapshot(config.siteUrl).performance, ...(base.performance ?? {}) };
      const performance = { ...previousPerformance };
      for (const [key, value] of Object.entries(performanceParts ?? {})) {
        if (value !== null) performance[key] = value;
      }
      const keptStrays = Array.isArray(base.indexing?.strays) ? base.indexing.strays : [];
      strayCount = (strays ?? keptStrays).length;
      return {
        siteUrl: config.siteUrl,
        status: 'ok',
        generatedAt: run.finishedAt,
        run,
        indexing: {
          summary: summarizeIndexing(sortedPages),
          pages: sortedPages,
          strays: strays ?? keptStrays,
          history: withHistory(stored, entry),
        },
        performance,
        sitemaps: sitemaps ?? (Array.isArray(base.sitemaps) ? base.sitemaps : []),
      };
    });

    info(`${status}: ${urls.length} pages, ${sent} inspected, ${failed} failed, ${staleCount} stale, ${strayCount} strays, ${seconds}s`);
    return { status, pages: urls.length, inspected: sent, failed, stale: staleCount, strays: strayCount, seconds };
  }

  return {
    async run() {
      const config = readGoogleAuthConfig(env);
      if (!config.configured) {
        info(`skipped: ${config.missing.length} setting(s) empty`);
        return { skipped: 'not_configured' };
      }
      const budget = dailyBudget(env);
      const lease = createRunLease({ store, now, budget, by: jobId ? 'job' : 'timer', jobId });
      const taken = await lease.acquire();
      if (!taken.ok) {
        info('skipped: another run is in progress');
        return { skipped: 'already_running' };
      }
      // What was reserved against the daily budget and what was sent, so the
      // lease gets back the inspections this run did not use.
      const counts = { reserved: 0, sent: 0 };
      try {
        return await runHeld(config, budget, lease, counts);
      } finally {
        try {
          await lease.release({ unused: Math.max(0, counts.reserved - counts.sent) });
        } catch {
          // A timed-out job may no longer write; the lease lapses on its own.
          info(`lease not given back; it lapses within ${LEASE_TTL_MS / 60000} minutes`);
        }
      }
    },
  };
}

/** The data sections of a stored snapshot, without Cosmos's own fields. */
function pick(stored) {
  const out = {};
  for (const key of ['generatedAt', 'indexing', 'performance', 'sitemaps']) {
    if (stored?.[key] !== undefined && stored[key] !== null) out[key] = stored[key];
  }
  return out;
}
