/**
 * scrape.js — fetch an article, find its body, turn it into Markdown, and
 * read its publish date out of the page's own metadata.
 *
 * Ported from Site-Main `scrapeArticle`, `tryReaderFallback`,
 * `tryHeadlessFallback`, `extractPublishedDate` and `referenceScrapedImages`
 * (functions/index.js, 088f458). `fetch` instead of axios; everything else
 * is the same selector list, the same noise stripping, the same fallbacks
 * behind the same environment switches, and the same strict TLS — a
 * certificate failure fails the scrape, it is never bypassed.
 */
import { load as loadHtml } from 'cheerio';
import { AuthoredError, authoredMessage, errorCode } from '../http/error-response.js';
import { guardedFetch } from '../http/guarded-fetch.js';
import { fetchWithTimeout } from '../http/fetch-with-timeout.js';
import TurndownService from 'turndown';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

const NOISE_SELECTOR =
  'script, style, nav, header, footer, aside, iframe, .advertisement, .ad, .cookie-banner, .sidebar, .related-posts, .comments, .social-share, .newsletter-signup';

const CONTENT_SELECTORS = [
  '.markdown-body',
  '.post-content',
  '.blog-post-content',
  '.article-body',
  'article',
  'main article',
  '[role="main"]',
  '.article-content',
  '.entry-content',
  '.content-body',
  'main',
  '#content',
  '.content',
];

/** Absolute URL for an image src seen on `pageUrl`. */
export function absoluteImageUrl(src, pageUrl) {
  if (!src) return null;
  if (/^https?:\/\//i.test(src)) return src;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null; // data:, blob:, javascript: — not fetchable images
  const u = new URL(pageUrl);
  if (src.startsWith('//')) return `${u.protocol}${src}`;
  if (src.startsWith('/')) return `${u.origin}${src}`;
  return `${u.origin}/${src}`;
}

/**
 * The article inside a page: the largest matching content block over 200
 * characters, falling back to <body> when nothing reaches 500.
 * @returns {{ articleHtml: string, contentText: string, images: {url: string, alt: string, index: number}[] }}
 */
export function extractArticle(html, pageUrl) {
  const $ = loadHtml(html);
  $(NOISE_SELECTOR).remove();

  let articleHtml = null;
  let contentText = '';
  for (const selector of CONTENT_SELECTORS) {
    const elem = $(selector);
    if (!elem.length) continue;
    const text = elem.text().trim();
    if (text.length > contentText.length && text.length > 200) {
      articleHtml = elem.html();
      contentText = text;
    }
  }
  if (!articleHtml || contentText.length < 500) {
    articleHtml = $('body').html() || '';
    contentText = $('body').text().trim();
  }

  const images = [];
  $('img').each((i, elem) => {
    const src = absoluteImageUrl($(elem).attr('src'), pageUrl);
    if (src && src.startsWith('http'))
      images.push({ url: src, alt: $(elem).attr('alt') || '', index: i });
  });

  return { articleHtml, contentText, images };
}

export function htmlToMarkdown(html) {
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  return turndown.turndown(html || '');
}

/**
 * A page that answered with a status this scraper does not read. Authored,
 * so the reason travels to the draft routes as written here (#945).
 */
export class ScrapeError extends AuthoredError {}

/**
 * The never-throws failure shape.
 *
 * @param {number} startedAt - when the scrape began (ms)
 * @param {string} message - an authored reason
 * @returns {object}
 */
function failure(startedAt, message) {
  return {
    success: false,
    markdown: null,
    html: null,
    plainText: null,
    images: [],
    wordCount: 0,
    error: message,
    scrapeMode: 'failed',
    scrapeLatencyMs: Date.now() - startedAt,
    scrapeFailureReason: message,
  };
}

async function tryReaderFallback(url, startedAt, { env, fetchImpl, log, signal }) {
  if (
    String(env.CONTENTFORGE_SCRAPE_FALLBACK_ENABLED || 'false')
      .toLowerCase()
      .trim() !== 'true'
  )
    return null;
  try {
    const fallbackUrl = `https://r.jina.ai/http://${String(url).replace(/^https?:\/\//i, '')}`;
    log.log?.('[scraper] Trying reader fallback:', fallbackUrl);
    const response = await fetchWithTimeout(fetchImpl, fallbackUrl, {
      timeoutMs: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HCW-Bot/1.0)' },
      signal,
    });
    if (!response.ok) return null;
    const text = (await response.text()).replace(/\s+/g, ' ').trim();
    if (text.length <= 400) return null;
    return {
      success: true,
      markdown: text.slice(0, 24000),
      html: '',
      plainText: text.slice(0, 24000),
      images: [],
      wordCount: text.split(/\s+/).length,
      error: null,
      scrapeMode: 'reader_fallback',
      scrapeLatencyMs: Date.now() - startedAt,
      scrapeFailureReason: null,
    };
  } catch (error) {
    log.warn?.(`[scraper] Reader fallback failed: ${error.message}`);
    return null;
  }
}

async function tryHeadlessFallback(url, startedAt, { env, fetchImpl, log, signal }) {
  const enabled =
    String(env.CONTENTFORGE_HEADLESS_FALLBACK_ENABLED || 'false')
      .toLowerCase()
      .trim() === 'true';
  const endpoint = String(env.CONTENTFORGE_HEADLESS_FALLBACK_URL || '').trim();
  if (!enabled || !endpoint) return null;
  try {
    log.log?.('[scraper] Trying headless fallback:', endpoint);
    const response = await fetchWithTimeout(fetchImpl, endpoint, {
      method: 'POST',
      timeoutMs: 45000,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        timeoutMs: 30000,
        userAgent: 'Mozilla/5.0 (compatible; HCW-Bot/1.0)',
      }),
      signal,
    });
    if (!response.ok) return null;
    const payload = (await response.json().catch(() => ({}))) || {};
    const plainText = String(payload.plainText || payload.text || '')
      .replace(/\s+/g, ' ')
      .trim();
    const markdown = String(payload.markdown || plainText).trim();
    if (markdown.length <= 400 && plainText.length <= 400) return null;
    return {
      success: true,
      markdown: markdown.slice(0, 24000),
      html: String(payload.html || '').slice(0, 24000),
      plainText: plainText.slice(0, 24000),
      images: (Array.isArray(payload.images) ? payload.images : []).slice(0, 20),
      wordCount: plainText.split(/\s+/).length,
      error: null,
      scrapeMode: 'headless_fallback',
      scrapeLatencyMs: Date.now() - startedAt,
      scrapeFailureReason: null,
    };
  } catch (error) {
    log.warn?.(`[scraper] Headless fallback failed: ${error.message}`);
    return null;
  }
}

/**
 * Fetch and extract an article. Never throws; `success:false` carries the reason.
 *
 * @param {string} url
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetch]
 * @param {object} [deps.env]
 * @param {{log?: Function, warn?: Function}} [deps.log]
 * @param {() => number} [deps.now]
 * @param {AbortSignal} [deps.signal]
 */
export async function scrapeArticle(
  url,
  { fetch: fetchImpl = globalThis.fetch, env = process.env, log = {}, now = Date.now, resolve, signal } = {}
) {
  const startedAt = now();
  log.log?.('[scraper] Fetching:', url);
  try {
    // `url` is whatever the editor (or a feed) named, so it is fetched through
    // the SSRF guard: resolved first, private and link-local refused, redirects
    // re-checked hop by hop (2026-10-06 review, AP-B2). A refused address is a
    // failed scrape like any other; the fallbacks below send the URL to a
    // third-party service rather than fetching it from here.
    const { response, text } = await guardedFetch(url, {
      fetch: fetchImpl,
      resolve,
      timeoutMs: 30000,
      headers: BROWSER_HEADERS,
      signal,
    });
    if (!response.ok) throw new ScrapeError(`Status code ${response.status}`);
    const fullHtml = text();
    const { articleHtml, contentText, images } = extractArticle(fullHtml, url);
    const markdown = htmlToMarkdown(articleHtml);
    log.log?.(`[scraper] ${markdown.length} chars markdown, ${images.length} images`);
    return {
      success: true,
      markdown,
      html: fullHtml, // full page, head included: the date extractor reads meta tags
      plainText: contentText,
      images,
      wordCount: contentText.split(/\s+/).filter(Boolean).length,
      error: null,
      scrapeMode: 'direct_html',
      scrapeLatencyMs: now() - startedAt,
      scrapeFailureReason: null,
    };
  } catch (error) {
    log.warn?.(`[scraper] Direct scrape failed: ${error.message}`);
    // A URL the guard refused is not retried through a fallback: the reader
    // and headless services would only fetch the same forbidden target from
    // their side, and the answer here is "no", not "try harder".
    // The reason travels to the draft routes and onto the document, so it
    // is the guard's or this module's own sentence, never a socket's (#945).
    const reason = authoredMessage(
      error,
      `The page could not be fetched (${errorCode(error?.cause ?? error)}).`
    );
    if (error?.refused) return failure(startedAt, reason);
    const deps = { env, fetchImpl, log, signal };
    return (
      (await tryReaderFallback(url, startedAt, deps)) ||
      (await tryHeadlessFallback(url, startedAt, deps)) ||
      failure(startedAt, reason)
    );
  }
}

const DATE_META_SELECTORS = [
  'meta[property="article:published_time"]',
  'meta[property="og:published_time"]',
  'meta[name="published"]',
  'meta[name="DC.date"]',
  'meta[name="publish_date"]',
  'meta[name="published_date"]',
  'meta[itemprop="datePublished"]',
];

/**
 * The page's own publish date — JSON-LD first, then meta tags, then <time> —
 * at midnight UTC. Null when the page does not say.
 */
export function extractPublishedDate(html) {
  if (!html) return null;
  const $ = loadHtml(html);
  let best = null;

  const jsonLd = $('script[type="application/ld+json"]').first().text();
  if (jsonLd) {
    try {
      const data = JSON.parse(jsonLd);
      const candidate = new Date(data?.datePublished);
      if (data?.datePublished && !Number.isNaN(candidate.getTime())) best = candidate;
    } catch {
      // next method
    }
  }
  for (const selector of DATE_META_SELECTORS) {
    const raw = $(selector).attr('content');
    if (raw && raw.trim()) {
      const candidate = new Date(raw.trim());
      if (!Number.isNaN(candidate.getTime())) {
        best = candidate;
        break;
      }
    }
  }
  if (!best) {
    const raw = $('time').first().attr('datetime');
    if (raw && raw.trim()) {
      const candidate = new Date(raw.trim());
      if (!Number.isNaN(candidate.getTime())) best = candidate;
    }
  }
  if (!best) return null;
  return new Date(Date.UTC(best.getUTCFullYear(), best.getUTCMonth(), best.getUTCDate()));
}

/** The lightweight shape stored at inspection: URL references only, archived at publish. */
export function referenceScrapedImages(images) {
  return (images || [])
    .slice(0, 10)
    .map((img, i) => ({ original: img.url, alt: img.alt, index: i }));
}
