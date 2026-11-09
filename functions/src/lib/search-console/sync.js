/**
 * sync.js — one Search Console run (#1612): what Google knows about each
 * public page, the site's search traffic, and the sitemaps, saved as one
 * document the admin page reads.
 *
 * Run twice a day by the `syncSearchConsole` timer (schedulers.js) and on
 * demand by the page's Run now button, which queues the `sync-search-console`
 * job (functions/search-console-http.js). One run:
 *
 *   1. Reads the sitemap (GSC_SITEMAP_URL), keeps only pages on the root
 *      domain `hybridcloudworks.com` (owner decision on #1612), removes
 *      repeats, and stops at 900 pages, so two runs a day stay under Google's
 *      2,000 inspections a day.
 *   2. Inspects each page, four at a time, pacing the starts so a minute
 *      never sees more than about 545 (Google allows 600). One page failing is
 *      recorded on that page and never fails the run.
 *   3. Reads Search Analytics for the 90 days ending two days ago (Google's
 *      figures lag about two days): totals, a line per day, and the top 50
 *      queries, pages, countries, devices and search appearances; the same
 *      totals for the last 28 days; and up to 1,000 pages, from which the
 *      "strays" are found: root-domain pages that get impressions but are
 *      not in the sitemap.
 *   4. Lists the sitemaps Google has.
 *   5. Replaces `admin_config/search_console_snapshot` under the ETag it was
 *      read with (a lost race re-reads and tries again), carrying a short
 *      history of the indexing counts, the last 120 runs (about two months).
 *
 * When GSC_WIF_AUDIENCE, GSC_ENTRA_APP_ID_URI or GSC_SERVICE_ACCOUNT_EMAIL is
 * empty the run returns `{ skipped: 'not_configured' }` and writes nothing.
 *
 * When Google sign-in fails, or Google says the service account may not read
 * the property, the run stops, keeps the last good figures in the document,
 * and records the failure in `run.message` with status 'error', so the page
 * shows both. The caller (the timer or the job) then treats it as a failed
 * run.
 *
 * Log lines carry counts and durations only: no page address, no token and
 * no Google response (house rule for functions/**).
 */
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { createGoogleTokenProvider, GoogleAuthError, readGoogleAuthConfig } from './google-auth.js';
import { createSearchConsoleClient, defaultSleep, SearchConsoleError } from './client.js';

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
/** A sitemap index may point at this many child sitemaps; the rest are skipped. */
export const MAX_CHILD_SITEMAPS = 20;
export const WRITE_ATTEMPTS = 3;
/** Long strings from Google are cut to this length before they are stored. */
const MAX_FIELD = 2048;

/** What Google's API does not offer, shown on the page as is. */
export const NOT_AVAILABLE = Object.freeze(['Page indexing totals and reasons', 'Links (internal and external)']);

const DAY_MS = 24 * 60 * 60 * 1000;
const VERDICTS = new Set(['PASS', 'NEUTRAL', 'FAIL']);

// ── Small pure helpers ───────────────────────────────────────────────────────

const str = (value) => (typeof value === 'string' && value ? value.slice(0, MAX_FIELD) : null);
const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Undo the five XML entities a sitemap may use in an address. */
function decodeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
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
export function presentInspection(url, result) {
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
  };
}

/** A page whose inspection failed: the same shape, with the failure's sentence. */
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
  };
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

/** The counts the page's summary cards show, from the inspected pages. */
export function summarizeIndexing(pages) {
  const inspected = pages.filter((page) => page.error === null);
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
    (a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0)
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
    contents: (Array.isArray(entry?.contents) ? entry.contents : []).map((part) => ({
      type: str(part?.type) ?? '',
      submitted: num(part?.submitted),
      indexed: num(part?.indexed),
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
    return describeCall(failure.kind, status);
  }
  return fallback;
}

function describeAuth(kind, status) {
  const hop = { entra: 'hop 1 (Entra token)', sts: 'hop 2 (Google token exchange)', impersonation: 'hop 3 (service account token)' }[kind] ?? 'an unknown hop';
  return `Google sign-in failed at ${hop}${status === null ? '' : ` with HTTP ${status}`}. The runbook's setup steps say what each hop needs.`;
}

function describeCall(kind, status) {
  if (status === 403) return 'Google answered 403: the service account is not a Full user on the Search Console property.';
  if (status === 429) return `Search Console ${kind} hit Google's quota (HTTP 429).`;
  if (status === null) return `Search Console ${kind} could not be reached.`;
  return `Search Console ${kind} failed with HTTP ${status}.`;
}

/** Is this failure one that every later call would hit too? Then the run stops. */
function isFatal(failure) {
  if (failure instanceof GoogleAuthError) return true;
  return failure instanceof SearchConsoleError && (failure.status === 401 || failure.status === 403);
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
  log,
}) {
  const info = (line) => log?.log?.(`[searchConsoleSync] ${line}`);

  async function readSitemapUrls() {
    const root = (typeof env.GSC_SITEMAP_URL === 'string' && env.GSC_SITEMAP_URL.trim()) || DEFAULT_SITEMAP_URL;
    const fetchXml = async (address) => {
      let response;
      try {
        response = await fetchImpl(address, { headers: { Accept: 'application/xml, text/xml' } });
      } catch {
        return { failed: 'unreachable' };
      }
      if (!response.ok) return { failed: `HTTP ${response.status}` };
      return { xml: await response.text() };
    };
    const first = await fetchXml(root);
    if (first.failed) return { locs: [], note: `The sitemap could not be read (${first.failed}).` };
    const parsed = parseSitemap(first.xml);
    if (!parsed.isIndex) return { locs: parsed.locs, note: null };
    // A sitemap index: read each child sitemap on the site's own host.
    const children = parsed.locs.filter((loc) => rootDomainUrl(loc)).slice(0, MAX_CHILD_SITEMAPS);
    const locs = [];
    let unread = 0;
    for (const child of children) {
      const answer = await fetchXml(child);
      if (answer.failed) unread += 1;
      else locs.push(...parseSitemap(answer.xml).locs);
    }
    return { locs, note: unread ? `${unread} of ${children.length} child sitemaps could not be read.` : null };
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

  /** The stored history with this run's entry added, newest last, at most HISTORY_MAX. */
  const withHistory = (stored, entry) => {
    const previous = Array.isArray(stored?.indexing?.history) ? stored.indexing.history : [];
    return [...previous, entry].slice(-HISTORY_MAX);
  };

  return {
    async run() {
      const config = readGoogleAuthConfig(env);
      if (!config.configured) {
        info(`skipped: ${config.missing.length} setting(s) empty`);
        return { skipped: 'not_configured' };
      }
      const startedAt = now();
      const started = startedAt.getTime();
      const google =
        client ??
        createSearchConsoleClient({
          siteUrl: config.siteUrl,
          auth: createGoogleTokenProvider({
            audience: config.audience,
            appIdUri: config.appIdUri,
            serviceAccountEmail: config.serviceAccountEmail,
            credential,
            fetchImpl,
          }),
          fetchImpl,
          sleep,
        });

      const notes = [];
      let fatal = null;
      const stopped = () => fatal !== null || signal?.aborted === true;

      // 1. The sitemap.
      const sitemap = await readSitemapUrls();
      if (sitemap.note) notes.push(sitemap.note);
      const { urls, total } = selectSiteUrls(sitemap.locs);
      if (total > urls.length) notes.push(`The sitemap lists ${total} root-domain pages; the first ${urls.length} were inspected.`);

      // 2. Inspect each page.
      const pages = new Array(urls.length);
      let failed = 0;
      await runPaced(urls, {
        limit: CONCURRENCY,
        spacingMs,
        sleep,
        now: () => now().getTime(),
        stop: stopped,
        task: async (url, index) => {
          try {
            pages[index] = presentInspection(url, await google.inspect(url));
          } catch (failure) {
            failed += 1;
            if (isFatal(failure)) fatal ??= failure;
            pages[index] = failedInspection(url, failureNote(failure, 'The inspection failed.'));
          }
        },
      });
      const done = pages.filter(Boolean);
      const inspected = done.length;

      // 3 and 4. Performance and sitemaps, unless the run already cannot go on.
      let performance = null;
      let sitemaps = null;
      let strays = [];
      if (!stopped()) {
        const longRange = analyticsRange(startedAt, RANGE_DAYS);
        const shortRange = analyticsRange(startedAt, SHORT_RANGE_DAYS);
        const query = async (label, body, fallback) => {
          if (stopped()) return fallback;
          try {
            return await google.searchAnalytics(body);
          } catch (failure) {
            if (isFatal(failure)) fatal ??= failure;
            notes.push(`Performance ${label}: ${failureNote(failure, 'the query failed.')}`);
            return fallback;
          }
        };
        const grouped = (dimension, rowLimit = TOP_ROWS) =>
          query(dimension, { ...longRange, dimensions: [dimension], rowLimit }, []);
        const totals = await query('totals', { ...longRange }, []);
        const totals28d = await query('28-day totals', { ...shortRange }, []);
        const daily = await grouped('date', 1000);
        const queries = await grouped('query');
        const pageRows = await grouped('page', PAGE_ROWS_FOR_STRAYS);
        const countries = await grouped('country');
        const devices = await grouped('device');
        // searchAppearance cannot be combined with another dimension, so it is its own query.
        const appearance = await grouped('searchAppearance');
        performance = {
          range: longRange,
          totals: presentTotals(totals),
          totals28d: presentTotals(totals28d),
          daily: presentDaily(daily),
          queries: presentRows(queries),
          pages: presentRows(pageRows).slice(0, TOP_ROWS),
          countries: presentRows(countries),
          devices: presentRows(devices),
          searchAppearance: presentRows(appearance),
        };
        strays = findStrays(pageRows, selectSiteUrls(sitemap.locs, { max: Number.POSITIVE_INFINITY }).urls);
        if (!stopped()) {
          try {
            sitemaps = presentSitemaps(await google.listSitemaps());
          } catch (failure) {
            if (isFatal(failure)) fatal ??= failure;
            notes.push(`Sitemaps: ${failureNote(failure, 'the list could not be read.')}`);
          }
        }
      }
      const finishedAt = now();
      const seconds = Math.round((finishedAt.getTime() - started) / 1000);
      if (signal?.aborted) {
        // The job's budget ran out. Half a run is not written over the last
        // whole one; the job is recorded as timed out by lib/jobs.js.
        info(`stopped: out of time after ${inspected} of ${urls.length} pages, ${seconds}s`);
        return { status: 'error', aborted: true, pages: urls.length, inspected, failed, strays: 0, seconds };
      }
      const status = fatal ? 'error' : 'ok';
      const message = fatal
        ? failureNote(fatal, 'The run failed.')
        : notes.length
          ? notes.join(' ')
          : null;
      const run = {
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        inspected,
        failed,
        message,
      };
      const sortedPages = sortPages(done);
      const summary = summarizeIndexing(sortedPages);

      await save((stored) => {
        const base = stored ?? emptySnapshot(config.siteUrl);
        if (fatal) {
          // Keep the last good figures; record only that this run failed.
          return {
            ...emptySnapshot(config.siteUrl),
            ...pick(base),
            siteUrl: config.siteUrl,
            status: 'error',
            run,
          };
        }
        const entry = {
          at: run.finishedAt,
          pass: summary.pass,
          neutral: summary.neutral,
          fail: summary.fail,
          inspected,
          failed,
        };
        return {
          siteUrl: config.siteUrl,
          status: 'ok',
          generatedAt: run.finishedAt,
          run,
          indexing: { summary, pages: sortedPages, strays, history: withHistory(stored, entry) },
          performance: performance ?? emptySnapshot(config.siteUrl).performance,
          sitemaps: sitemaps ?? (Array.isArray(base.sitemaps) ? base.sitemaps : []),
        };
      });

      info(`${status}: ${urls.length} pages, ${inspected} inspected, ${failed} failed, ${strays.length} strays, ${seconds}s`);
      return { status, pages: urls.length, inspected, failed, strays: strays.length, seconds };
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
