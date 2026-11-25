/**
 * sitemap-read.js — fetching the site's sitemap for one Search Console run
 * (sync.js), and a sitemap index's child sitemaps one level down.
 */
import { fetchWithTimeout } from '../http/fetch-with-timeout.js';
import { DEFAULT_SITEMAP_URL, MAX_CHILD_SITEMAPS, SITE_DOMAIN } from './sync-constants.js';
import { onMainSite, parseSitemap, sitemapRoot } from './sitemap-parse.js';

/** One sitemap address fetched: `{ xml }`, or `{ failed }` saying why not. */
async function fetchXml(fetchImpl, address, cancel) {
  try {
    const response = await fetchWithTimeout(fetchImpl, address, { headers: { Accept: 'application/xml, text/xml' }, signal: cancel });
    if (!response.ok) return { failed: `HTTP ${response.status}` };
    return { xml: await response.text() };
  } catch {
    return { failed: 'unreachable' };
  }
}

/** The sitemap address to read: GSC_SITEMAP_URL when set, else the main site's. */
function sitemapAddress(env) {
  return (typeof env.GSC_SITEMAP_URL === 'string' && env.GSC_SITEMAP_URL.trim()) || DEFAULT_SITEMAP_URL;
}

/** A sitemap that could not be read at all. */
const unreadSitemap = (failed) => ({ locs: [], failed, complete: false, note: null });

/** Each child sitemap read in turn: the pages found, and how many could not be read. */
async function readChildren(fetchImpl, children, cancel) {
  const locs = [];
  let unread = 0;
  for (const child of children) {
    const answer = await fetchXml(fetchImpl, child, cancel);
    // A child must be a list of pages: an index one level further down is
    // not followed, and a web page or other answer is not a sitemap.
    if (answer.failed || sitemapRoot(answer.xml) !== 'urlset') unread += 1;
    else locs.push(...parseSitemap(answer.xml).locs);
  }
  return { locs, unread };
}

/** The parts of a sitemap index that were not read, as sentence pieces. */
function indexGaps({ unread, children, offHost, skipped, sameHost }) {
  const gaps = [];
  if (unread) gaps.push(`${unread} of ${children} child sitemaps could not be read`);
  if (offHost) gaps.push(`${offHost} child sitemaps are not on ${SITE_DOMAIN} and were not read`);
  if (skipped) gaps.push(`the sitemap index lists ${sameHost} child sitemaps and only the first ${MAX_CHILD_SITEMAPS} were read`);
  return gaps;
}

/** A sitemap index: read each child sitemap on the site's own host, at most MAX_CHILD_SITEMAPS of them. */
async function readIndex(fetchImpl, parsed, cancel) {
  const sameHost = parsed.locs.filter(onMainSite);
  const children = sameHost.slice(0, MAX_CHILD_SITEMAPS);
  const skipped = sameHost.length - children.length;
  // Child sitemaps on any other host are not read, so the list is not whole.
  const offHost = parsed.locs.length - sameHost.length;
  const { locs, unread } = await readChildren(fetchImpl, children, cancel);
  if (children.length > 0 && unread === children.length) {
    return unreadSitemap(`none of its ${children.length} child sitemaps could be read`);
  }
  const gaps = indexGaps({ unread, children: children.length, offHost, skipped, sameHost: sameHost.length });
  if (gaps.length === 0) return { locs, failed: null, complete: true, note: null };
  const said = gaps.join('; ');
  return {
    locs,
    failed: null,
    complete: false,
    note: `${said[0].toUpperCase()}${said.slice(1)}, so the strays were not worked out this run, and pages the part read does not list keep their last result.`,
  };
}

/**
 * The sitemap's `<loc>` entries. `failed` says why the sitemap could not be
 * read at all; `complete` is false when any part of it was not read (a
 * child sitemap of an index that failed, or children past the first
 * MAX_CHILD_SITEMAPS), so the strays are not worked out from it and pages
 * it may have left out are kept rather than dropped.
 *
 * An answer counts as read only when it really is a sitemap: its first
 * element is `<urlset>` (or, for the address in GSC_SITEMAP_URL only,
 * `<sitemapindex>`). Anything else, such as the site's HTML page, which it
 * sends with HTTP 200 for an address it does not know (#1613), is treated
 * like an answer that never came. Without this, a child sitemap that moved
 * would read as an empty one and its pages would be dropped.
 *
 * @param {{ env: Record<string, string|undefined>, fetchImpl: typeof fetch }} deps
 * @param {AbortSignal} cancel - the run's cancel switch
 */
export async function readSitemapUrls({ env, fetchImpl }, cancel) {
  const first = await fetchXml(fetchImpl, sitemapAddress(env), cancel);
  if (first.failed) return unreadSitemap(first.failed);
  if (!['urlset', 'sitemapindex'].includes(sitemapRoot(first.xml))) {
    return unreadSitemap('the answer is not a sitemap');
  }
  const parsed = parseSitemap(first.xml);
  if (!parsed.isIndex) return { locs: parsed.locs, failed: null, complete: true, note: null };
  return readIndex(fetchImpl, parsed, cancel);
}
