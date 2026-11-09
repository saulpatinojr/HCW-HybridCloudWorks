/**
 * Search Console — the browser's side of the Search Console page
 * (`/admin/search-console`, #1612).
 *
 * The page shows what Google Search knows about the public site,
 * hybridcloudworks.com and every subdomain (docs., api-azure., the lab
 * hosts): which pages Google has indexed, how people find the site in
 * Google, and the sitemaps Google has read. A timer on the server asks
 * Google twice a day and saves one report; this file reads that report and
 * turns Google's codes into words.
 *
 * Everything here is defensive on purpose: any list in the report may be
 * missing or empty and any number may be absent, and the page must still draw.
 */

/**
 * The saved report (`GET`). Under `cms/` like every admin route of the
 * Function App; the browser's page address stays `/admin/search-console`.
 */
export const SEARCH_CONSOLE_ROUTE = 'cms/search-console';

/** Asks the server to run a fresh read now (`POST`, answers 202 when queued). */
export const SEARCH_CONSOLE_RUN_ROUTE = 'cms/search-console/run';

/** Google's own Search Console for the site, as a domain property. */
export const SEARCH_CONSOLE_URL =
  'https://search.google.com/search-console?resource_id=sc-domain%3Ahybridcloudworks.com';

/** The owner's setup steps for the Google sign-in. */
export const SEARCH_CONSOLE_RUNBOOK_URL =
  'https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/docs/runbooks/search-console.md';

/** Google's list of what its Search Console API offers (and so what it does not). */
export const SEARCH_CONSOLE_API_REFERENCE_URL =
  'https://developers.google.com/webmaster-tools/v1/api_reference_index';

/** Where Google documents the codes this file translates. */
export const URL_INSPECTION_RESULT_URL =
  'https://developers.google.com/webmaster-tools/v1/urlInspection.index/UrlInspectionResult';

/** The page's tabs. Deep links are `?tab=`. */
export const TABS = Object.freeze([
  { id: 'indexing', label: 'Indexing' },
  { id: 'performance', label: 'Performance' },
  { id: 'sitemaps', label: 'Sitemaps' },
]);

export const DEFAULT_TAB = 'indexing';

const TAB_IDS = new Set(TABS.map((tab) => tab.id));

/** Words someone might type or bookmark, sent to the tab that holds them. */
export const MOVED_TABS = Object.freeze({
  pages: 'indexing',
  coverage: 'indexing',
  inspection: 'indexing',
  traffic: 'performance',
  queries: 'performance',
  sitemap: 'sitemaps',
});

/** The tab to show for a `?tab=` value: its own, where it moved, or Indexing. */
export function resolveTab(requested) {
  const id = Object.hasOwn(MOVED_TABS, requested ?? '') ? MOVED_TABS[requested] : requested;
  return TAB_IDS.has(id) ? id : DEFAULT_TAB;
}

/**
 * Google's verdict on a page, in the words Search Console itself uses.
 * `PASS` is "Valid" (indexed), `NEUTRAL` is "Excluded" (Google chose not to
 * index it), `FAIL` is "Error". Anything else is unknown.
 */
export const VERDICTS = Object.freeze({
  PASS: { label: 'Indexed', tone: 'ok' },
  NEUTRAL: { label: 'Excluded', tone: 'muted' },
  FAIL: { label: 'Error', tone: 'bad' },
  VERDICT_UNSPECIFIED: { label: 'Unknown', tone: 'warn' },
});

/** The verdict code for a page, with anything unexpected read as unknown. */
export function verdictOf(page) {
  const code = page?.verdict;
  return Object.hasOwn(VERDICTS, code ?? '') ? code : 'VERDICT_UNSPECIFIED';
}

/**
 * Whether Google could fetch the page from the server, in plain words. The
 * codes are Google's `PageFetchState` values (URL_INSPECTION_RESULT_URL).
 */
export const PAGE_FETCH_WORDS = Object.freeze({
  SUCCESSFUL: 'Fetched',
  SOFT_404: 'Soft 404 (looks like a missing page)',
  BLOCKED_ROBOTS_TXT: 'Blocked by robots.txt',
  NOT_FOUND: '404 not found',
  ACCESS_DENIED: '401 unauthorized',
  SERVER_ERROR: '5xx server error',
  REDIRECT_ERROR: 'Redirect error',
  ACCESS_FORBIDDEN: '403 forbidden',
  BLOCKED_4XX: 'Other 4xx error',
  INTERNAL_CRAWL_ERROR: 'Google internal error',
  INVALID_URL: 'Invalid URL',
  PAGE_FETCH_STATE_UNSPECIFIED: 'Unknown',
});

/** A fetch code in words; an unrecognised code is shown as Google sent it. */
export function fetchStateLabel(state) {
  if (!state) return 'Unknown';
  return PAGE_FETCH_WORDS[state] ?? String(state);
}

/** Whether a fetch code is a failure worth flagging (anything but a clean fetch or unknown). */
export function fetchFailed(state) {
  return Boolean(state) && state !== 'SUCCESSFUL' && state !== 'PAGE_FETCH_STATE_UNSPECIFIED';
}

/** Sort order for the pages table: problems first, indexed pages last. */
const VERDICT_RANK = Object.freeze({ FAIL: 0, VERDICT_UNSPECIFIED: 1, NEUTRAL: 2, PASS: 3 });

/**
 * The pages, with every page that is not indexed (an error, unknown, then
 * excluded) before the indexed ones, and by address inside each group.
 */
export function sortPages(pages) {
  return [...(Array.isArray(pages) ? pages : [])].sort((a, b) => {
    const rank = VERDICT_RANK[verdictOf(a)] - VERDICT_RANK[verdictOf(b)];
    if (rank !== 0) return rank;
    return String(a?.url ?? '').localeCompare(String(b?.url ?? ''));
  });
}

/** The path of a full address ("/blog/x"), or the address itself when it will not parse. */
export function pathOf(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}` || '/';
  } catch {
    return String(url ?? '');
  }
}

/**
 * Whether Google picked a different "main" address (its canonical) from the
 * one the page itself declares. Only when both are known: a page Google has
 * not indexed has no Google canonical, and that is not a mismatch.
 */
export function canonicalMismatch(page) {
  const google = page?.googleCanonical;
  const declared = page?.userCanonical;
  if (!google || !declared) return false;
  return google !== declared;
}

/**
 * The addresses the page will turn into links. The report comes from the
 * server, but its links were written by Google and by the sitemap, so the
 * page only links to the two places they should point: Google's own
 * inspection screen and the public site (the domain and its subdomains).
 * Anything else is shown as text.
 */
export const GOOGLE_INSPECTION_PREFIX = 'https://search.google.com/';

/** The site's domain; the Search Console property covers it and every subdomain. */
export const SITE_DOMAIN = 'hybridcloudworks.com';

/** Google's "inspect this page" link, or null when it does not point at Google's Search Console. */
export function inspectionHref(link) {
  return typeof link === 'string' && link.startsWith(GOOGLE_INSPECTION_PREFIX) ? link : null;
}

/**
 * An address as a URL when it is https on hybridcloudworks.com or one of its
 * subdomains, else null. The check is on the host name the browser's own URL
 * parser reads, which must be exactly the domain or end with
 * `.hybridcloudworks.com`, never on the text, so a look-alike such as
 * `hybridcloudworks.com.example.net` or `evilhybridcloudworks.com` fails.
 */
function siteUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    // Same rule as the backend: a page address carries no port or user name.
    if (url.port || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    return host === SITE_DOMAIN || host.endsWith(`.${SITE_DOMAIN}`) ? url : null;
  } catch {
    return null;
  }
}

/** A page's own address as a link, or null when it is not on the public site or a subdomain. */
export function sitePageHref(url) {
  return siteUrl(url)?.href ?? null;
}

/** The host name of a page on the site ("docs.hybridcloudworks.com"), or null. */
export function hostOf(url) {
  return siteUrl(url)?.hostname.toLowerCase() ?? null;
}

/**
 * How a page's address is shown in a table: just its path ("/blog/x") on the
 * main site, which most pages are on, and the whole address on a subdomain,
 * so the host is never hidden.
 */
export function pageLabel(url) {
  const host = hostOf(url);
  if (host === SITE_DOMAIN) return pathOf(url);
  return String(url ?? '');
}

/** Where an inspected page came from: the sitemap, or Google's search figures (a "stray"). */
export const SOURCES = Object.freeze({
  sitemap: { label: 'Sitemap', note: 'Listed in the sitemap' },
  search: {
    label: 'Found in search',
    note: 'Not in the sitemap; found because it got impressions in Google results',
  },
});

/** A page's source, with anything unexpected (or a report from before the field) read as the sitemap. */
export function sourceOf(page) {
  return page?.source === 'search' ? 'search' : 'sitemap';
}

/** A number, or null when the value is missing or not a number. */
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** A count with thousands separators, or a dash. */
export function fmtCount(value) {
  const n = num(value);
  return n === null ? '—' : n.toLocaleString('en-US');
}

/** Google's click-through rate (a fraction, 0.0123) as a percentage with one decimal ("1.2%"). */
export function fmtCtr(value) {
  const n = num(value);
  return n === null ? '—' : `${(n * 100).toFixed(1)}%`;
}

/** Google's average position in results (1 is the top), with one decimal. */
export function fmtPosition(value) {
  const n = num(value);
  return n === null ? '—' : n.toFixed(1);
}

/** An instant as "2026-11-09 12:10 UTC", the clock the server's schedule is written in. */
export function utcText(iso) {
  const date = new Date(iso ?? '');
  if (!iso || Number.isNaN(date.getTime())) return null;
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** Country codes come as lower-case three-letter codes ("usa"); shown upper-case. */
export function countryLabel(key) {
  return String(key ?? '').toUpperCase();
}

/** Device keys come as "DESKTOP", "MOBILE", "TABLET"; shown as "Desktop". */
export function deviceLabel(key) {
  const text = String(key ?? '').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const list = (value) => (Array.isArray(value) ? value : []);
const obj = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

/** A totals block with every figure a number or null. */
function totalsOf(value) {
  const t = obj(value);
  return {
    clicks: num(t.clicks),
    impressions: num(t.impressions),
    ctr: num(t.ctr),
    position: num(t.position),
  };
}

const KNOWN_STATUSES = new Set(['ok', 'not_configured', 'never_run', 'error']);

/**
 * The report with every field the page reads present: lists are lists, blocks
 * are objects, and missing numbers are null. The page never has to check.
 */
export function normalizeReport(raw) {
  const report = obj(raw);
  const indexing = obj(report.indexing);
  const summary = obj(indexing.summary);
  const performance = obj(report.performance);
  const run = report.run ? obj(report.run) : null;
  return {
    status: KNOWN_STATUSES.has(report.status) ? report.status : 'error',
    siteUrl: report.siteUrl ?? null,
    generatedAt: report.generatedAt ?? null,
    run: run && {
      startedAt: run.startedAt ?? null,
      finishedAt: run.finishedAt ?? null,
      inspected: num(run.inspected),
      failed: num(run.failed),
      stale: num(run.stale),
      message: typeof run.message === 'string' && run.message.trim() ? run.message : null,
    },
    indexing: {
      summary: {
        pass: num(summary.pass),
        neutral: num(summary.neutral),
        fail: num(summary.fail),
        unknown: num(summary.unknown),
        byCoverageState: list(summary.byCoverageState),
        byPageFetchState: list(summary.byPageFetchState),
      },
      // `stale` is true only when the server says so: the page's answer is
      // from an earlier run because this run could not refresh it.
      // `source` and `host` are always set, so the table can show and
      // filter them; a report from before they existed reads as sitemap
      // pages, with the host taken from the address.
      pages: list(indexing.pages)
        .filter((page) => page && typeof page === 'object')
        .map((page) => ({
          ...page,
          stale: page.stale === true,
          source: sourceOf(page),
          host: typeof page.host === 'string' && page.host ? page.host : hostOf(page.url),
        })),
      strays: list(indexing.strays).filter((row) => row && typeof row === 'object'),
      history: list(indexing.history).filter((row) => row && typeof row === 'object'),
    },
    performance: {
      range: obj(performance.range),
      totals: totalsOf(performance.totals),
      totals28d: totalsOf(performance.totals28d),
      daily: list(performance.daily),
      queries: list(performance.queries),
      pages: list(performance.pages),
      countries: list(performance.countries),
      devices: list(performance.devices),
      searchAppearance: list(performance.searchAppearance),
    },
    sitemaps: list(report.sitemaps).filter((row) => row && typeof row === 'object'),
    notAvailable: list(report.notAvailable).filter((item) => typeof item === 'string'),
  };
}

/** Rows of a breakdown table, most clicks first, then most impressions. */
export function sortBreakdown(rows) {
  return [...list(rows)].sort(
    (a, b) =>
      (num(b?.clicks) ?? 0) - (num(a?.clicks) ?? 0) ||
      (num(b?.impressions) ?? 0) - (num(a?.impressions) ?? 0)
  );
}

/**
 * The sentence the page shows for each thing Google's API does not offer,
 * with where to find it in Search Console instead. Any item the server names
 * that is not here is shown as the server wrote it.
 */
export const NOT_AVAILABLE_WORDS = Object.freeze({
  'Page indexing totals and reasons':
    'Google publishes no API for its Page indexing screen (the total of indexed and not indexed pages, and the reasons), so the Indexing tab counts only the pages this page inspected: the sitemap’s, and up to 150 found in search. In Search Console, open Indexing, then Pages.',
  'Links (internal and external)':
    'Google publishes no API for its Links screen (which sites and pages link here), so it is not shown. In Search Console, open Links.',
});
