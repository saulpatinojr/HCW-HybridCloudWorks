/**
 * sitemap-parse.js — reading a sitemap's text and checking page addresses,
 * for one Search Console run (sync.js). Pure functions: no network, no store.
 * sync.js exports them again, so callers keep importing from sync.js.
 */
import { MAX_URLS, SITE_DOMAIN } from './sync-constants.js';

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

/** What may come before a document's first element: a `<?…?>` declaration, a comment, or a DOCTYPE. */
const PROLOG_PART = /^(?:<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>[]*(?:\[[^\]]*\][^>]*)?>)/i;
/** A first element's name, with or without a namespace prefix (`<urlset`, `<sm:urlset`). */
const FIRST_ELEMENT = /^<(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)[\s/>]/;

/**
 * The name of a document's first element, in lower case and without any
 * namespace prefix: `urlset` for a sitemap, `sitemapindex` for a sitemap
 * index, `html` for a web page. A byte-order mark, the `<?xml …?>`
 * declaration, comments and a DOCTYPE before it are skipped. Null when the
 * text has no element at all (empty, or not markup).
 *
 * This is how the run tells a real sitemap from the site's web page: the site
 * answers HTTP 200 with its HTML page for any address it does not know
 * (#1613), so a sitemap that moved still answers 200, and only its first
 * element shows it is not a sitemap.
 *
 * @param {string} xml
 * @returns {string|null}
 */
export function sitemapRoot(xml) {
  let rest = typeof xml === 'string' ? xml.replace(/^﻿/, '') : '';
  for (;;) {
    rest = rest.trimStart();
    const part = PROLOG_PART.exec(rest);
    if (!part) break;
    rest = rest.slice(part[0].length);
  }
  const element = FIRST_ELEMENT.exec(rest);
  return element ? element[1].toLowerCase() : null;
}

/** An opening or closing `<loc>` tag, in any letter case. */
const LOC_TAG = /<(\/?)loc>/gi;

/**
 * The address inside one `<loc>…</loc>`: without the spaces around it or a
 * CDATA wrapper. Null when it is empty or holds markup.
 */
function locText(inner) {
  let text = inner.trim();
  if (text.startsWith('<![CDATA[')) text = text.slice('<![CDATA['.length);
  if (text.endsWith(']]>')) text = text.slice(0, -']]>'.length);
  text = text.trim();
  return text && !text.includes('<') && !text.includes(']') ? text : null;
}

/**
 * The `<loc>` addresses in a sitemap or sitemap index, in order, and whether
 * it is an index (a list of further sitemaps rather than pages), which its
 * first element says (sitemapRoot).
 *
 * The tags are found one by one and the text between an opening tag and the
 * next closing one is taken, rather than with one pattern for the whole
 * entry: a pattern with several optional runs of spaces in a row can take a
 * very long time on a sitemap built to defeat it (a "ReDoS", a regular
 * expression denial of service), and this way the work grows only in step
 * with the sitemap's length.
 *
 * @param {string} xml
 * @returns {{ isIndex: boolean, locs: string[] }}
 */
export function parseSitemap(xml) {
  const source = typeof xml === 'string' ? xml : '';
  const isIndex = sitemapRoot(source) === 'sitemapindex';
  const locs = [];
  let start = -1;
  for (const tag of source.matchAll(LOC_TAG)) {
    if (!tag[1]) {
      start = tag.index + tag[0].length;
      continue;
    }
    if (start < 0) continue;
    const text = locText(source.slice(start, tag.index));
    start = -1;
    if (text) locs.push(decodeXml(text));
  }
  return { isIndex, locs };
}

/**
 * The URL when it is an https address on hybridcloudworks.com or one of its
 * subdomains, else null. The check is on the host name the URL parser reads,
 * which must be exactly the domain or end with `.hybridcloudworks.com`, never
 * on the text of the address, so a look-alike host such as
 * `hybridcloudworks.com.example.net` or `evilhybridcloudworks.com` does not
 * pass.
 */
export function siteAddress(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    // A page address never carries a non-default port or a user name; one
    // that does is not a page of this site, even on the right host. An
    // explicit :443 is HTTPS's own default port, so the parser drops it
    // (url.port is ''): `https://hybridcloudworks.com:443/x` is the same
    // address as `https://hybridcloudworks.com/x` and is accepted as such.
    if (url.port || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    return host === SITE_DOMAIN || host.endsWith(`.${SITE_DOMAIN}`) ? url : null;
  } catch {
    return null;
  }
}

/** The host name of a page on the domain ("docs.hybridcloudworks.com"), or null. */
export function hostOf(value) {
  return siteAddress(value)?.hostname.toLowerCase() ?? null;
}

/** Whether an address is on the main site itself, where the sitemap and its child sitemaps live. */
export const onMainSite = (value) => hostOf(value) === SITE_DOMAIN;

/**
 * The pages to inspect: https addresses on the domain or a subdomain only,
 * first occurrence kept, at most `max`.
 *
 * @param {string[]} locs
 * @param {{ max?: number }} [options]
 * @returns {{ urls: string[], total: number }} total is before the cap
 */
export function selectSiteUrls(locs, { max = MAX_URLS } = {}) {
  const seen = new Set();
  const kept = [];
  for (const loc of locs) {
    if (!siteAddress(loc)) continue;
    if (seen.has(loc)) continue;
    seen.add(loc);
    kept.push(loc);
  }
  return { urls: kept.slice(0, max), total: kept.length };
}

/** A path without the slashes at its end, but never shorter than "/". A loop, not a pattern, for the reason parseSitemap gives. */
function trimTrailingSlashes(path) {
  let end = path.length;
  while (end > 1 && path[end - 1] === '/') end -= 1;
  return path.slice(0, end);
}

/** An address in one spelling for comparing: lower-case host, no trailing slash past the root, no fragment. */
export function comparableUrl(value) {
  const url = siteAddress(value);
  if (!url) return null;
  return `https://${url.hostname.toLowerCase()}${trimTrailingSlashes(url.pathname)}${url.search}`;
}
