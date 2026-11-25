/**
 * blog-listings.js — `fetchBlogListings`, every 6 hours: non-RSS blog listing
 * pages scraped through Firecrawl's structured extraction into `content`
 * drafts, the same shape the RSS ingest writes.
 *
 * Ported from Site-Main index.js (088f458). Upstream used the Firecrawl SDK;
 * this calls the REST endpoint with fetch (one fewer dependency).
 * `FIRECRAWL_API_KEY` is a Key Vault reference on the app; a missing key
 * skips the run.
 *
 * The call uses version 2 of Firecrawl's API (#1848). Version 1 stops
 * answering on 2026-12-10 (https://docs.firecrawl.dev/migrate-to-v2, read
 * 2026-11-25). What changed for this file, from that page and the scrape
 * reference (https://docs.firecrawl.dev/api-reference/endpoint/scrape):
 *   - the address ends `/v2/scrape`, not `/v1/scrape`;
 *   - the schema travels inside `formats`, as `{ type: 'json', schema }`,
 *     where v1 took `formats: ['extract']` and a separate `extract` field;
 *   - the answer is read from `data.json`, not `data.extract`.
 * No `prompt` is sent: v1 sent none, and in v2 it is optional (only `type`
 * is required on the json format), so the request asks for the same thing.
 */
import { recordRun } from '../rss/source-run.js';
import { randomUUID } from 'node:crypto';
import { readKey } from '../ai/router.js';
import { buildRssContentDoc, truncateText } from '../rss/feeds.js';
import { AuthoredError, errorCode, storedFailure } from '../http/error-response.js';

export const FIRECRAWL_SCRAPE_URL = 'https://api.firecrawl.dev/v2/scrape';
export const MAX_ARTICLES_PER_SOURCE = 20;

export const BLOG_SCRAPE_SOURCES = Object.freeze([
  {
    provider: 'azure',
    name: 'Microsoft Tech Community Blogs',
    url: 'https://techcommunity.microsoft.com/Blogs/',
  },
  {
    provider: 'azure',
    name: 'Microsoft Partner Center Announcements',
    url: 'https://learn.microsoft.com/en-us/partner-center/announcements/',
  },
  {
    provider: 'azure',
    name: 'Microsoft Partner Blog',
    url: 'https://partner.microsoft.com/en-us/blog',
  },
  { provider: 'aws', name: 'AWS Blogs Index', url: 'https://aws.amazon.com/blogs/' },
  { provider: 'gcp', name: 'Google Cloud Blog', url: 'https://cloud.google.com/blog/' },
  { provider: 'gcp', name: 'Google Developers Blog', url: 'https://developers.googleblog.com/' },
  { provider: 'gcp', name: 'Firebase Blog', url: 'https://firebase.blog/' },
  {
    provider: 'finops',
    name: 'Microsoft FinOps Blog',
    url: 'https://techcommunity.microsoft.com/category/azure/blog/finopsblog',
  },
  {
    provider: 'finops',
    name: 'FinOps Foundation Updates',
    url: 'https://www.finops.org/updates/all-updates/',
  },
  { provider: 'terraform', name: 'HashiCorp Blog', url: 'https://www.hashicorp.com/en/blog' },
  { provider: 'terraform', name: 'TF Weekly Newsletter', url: 'https://www.weekly.tf/' },
]);

const ARTICLE_SCHEMA = {
  type: 'object',
  properties: {
    articles: {
      type: 'array',
      description: 'List of blog articles found on the page',
      items: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL of the article' },
          title: { type: 'string', description: 'Article title' },
          description: { type: 'string', description: 'Article excerpt or description' },
          publishedAt: {
            type: 'string',
            description: 'Publication date (ISO 8601 or human-readable)',
          },
          imageUrl: { type: 'string', description: 'Article thumbnail or cover image URL' },
          author: { type: 'string', description: 'Author name if present' },
        },
        required: ['url', 'title'],
      },
    },
  },
  required: ['articles'],
};

/** Resolve a possibly relative article URL against the listing page. */
export function resolveArticleUrl(url, listingUrl) {
  const value = String(url || '');
  if (!value) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:\/\//i.test(value)) return ''; // javascript:, mailto:, data: — not an article
  try {
    return new URL(value, listingUrl).href;
  } catch {
    return '';
  }
}

/**
 * The error for a scrape the provider refused. The status, or a fixed code
 * for a 200 that says it failed, travels as a field: the sentence names the
 * address and may quote the provider, so no log line or stored result reads
 * it (#1794).
 *
 * @param {{ ok: boolean, status: number }} response - the provider's answer
 * @param {{ error?: string }} result - its parsed body
 * @param {string} listingUrl - the page that was asked for
 * @returns {Error}
 */
function scrapeRefusal(response, result, listingUrl) {
  return Object.assign(
    new Error(`Firecrawl scrape failed for ${listingUrl}: ${result.error || `HTTP ${response.status}`}`),
    response.ok ? { code: 'SCRAPE_REFUSED' } : { status: response.status }
  );
}

/** Articles on a listing page via Firecrawl structured extraction. */
export async function scrapeListingPage(
  { apiKey, fetch: fetchImpl = globalThis.fetch },
  listingUrl,
  signal
) {
  const response = await fetchImpl(FIRECRAWL_SCRAPE_URL, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: listingUrl,
      formats: [{ type: 'json', schema: ARTICLE_SCHEMA }],
    }),
  });
  let result;
  try {
    result = await response.json();
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    // A sentence written here, so the job's result may keep it as it is.
    throw new AuthoredError('The blog listing response could not be read.', { code: 'UNREADABLE_BODY' });
  }
  if (!response.ok || result.success === false) throw scrapeRefusal(response, result, listingUrl);
  const articles = result.data?.json?.articles || [];
  return articles.map((a) => ({ ...a, url: resolveArticleUrl(a.url, listingUrl) }));
}

/** The `content` draft for a discovered article — the RSS shape, source 'firecrawl'. */
export function buildListingContentDoc({ article, source, dedupFields, now, uuid }) {
  const published = article.publishedAt ? new Date(article.publishedAt) : null;
  const item = {
    title: article.title || 'Untitled',
    link: article.url,
    creator: article.author || source.name,
    contentSnippet: article.description || '',
    content: article.description || '',
    isoDate: published && !Number.isNaN(published.getTime()) ? published.toISOString() : undefined,
    categories: [],
    enclosure: article.imageUrl ? { url: article.imageUrl } : undefined,
  };
  const doc = buildRssContentDoc({
    item,
    sourceUrl: article.url,
    title: item.title,
    summary: truncateText(article.description || '', 300),
    provider: source.provider,
    feed: source,
    dedupFields,
    now,
    uuid,
  });
  return { ...doc, source: 'firecrawl', readTime: '3 min' };
}

/** Stop between steps once the job's signal fired. */
function stopIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || new Error('aborted');
}

/** The article's canonical address, when the listing gave one. */
const canonicalOf = (article) => article.canonicalUrl || article.canonical || '';

/** Save one article as a draft unless it is already there. True when it was new. */
async function ingestArticle(d, source, article) {
  const { store, dedup, now } = d;
  const sourceUrl = article.url;
  if (!sourceUrl || !sourceUrl.startsWith('http')) return false;
  const title = article.title || 'Untitled';
  const publishedMs = article.publishedAt ? Date.parse(article.publishedAt) : NaN;
  const dup = await dedup.findDuplicateContent(store, {
    url: sourceUrl,
    canonicalUrl: canonicalOf(article),
    title,
    publishedMs: Number.isNaN(publishedMs) ? now().getTime() : publishedMs,
  });
  if (dup.duplicate) return false;
  const doc = buildListingContentDoc({
    article,
    source,
    dedupFields: dedup.buildDedupFields({
      url: sourceUrl,
      canonicalUrl: canonicalOf(article),
      title,
    }),
    now: now(),
    uuid: d.uuid,
  });
  await store.upsertDoc('content', doc);
  return true;
}

/** Scrape one listing and save its new articles, adding to the run's counts. */
async function scrapeSource(d, apiKey, source, results) {
  const { log, signal } = d;
  // The provider and counts only: a source's name is typed by an editor (#1635).
  log.log?.(`[blogScraper] Scraping a ${source.provider} listing`);
  const articles = await scrapeListingPage({ apiKey, fetch: d.fetchImpl }, source.url, signal);
  results.scraped += 1;
  let newCount = 0;
  for (const article of articles.slice(0, source.maxItems || MAX_ARTICLES_PER_SOURCE)) {
    stopIfAborted(signal);
    if (await ingestArticle(d, source, article)) newCount += 1;
  }
  results.newArticles += newCount;
  await recordRun(d.store, source, 'succeeded', { fetchedAt: d.now().toISOString(), itemCount: articles.length });
  log.log?.(`[blogScraper] ${source.provider} listing: ${articles.length} found, ${newCount} new`);
}

async function run(d) {
  const { store, log, signal, now } = d;
  const apiKey = readKey(d.env, 'FIRECRAWL_API_KEY');
  if (!apiKey) {
    log.warn?.('[blogScraper] FIRECRAWL_API_KEY not configured; skipping');
    return { skipped: true, reason: 'not_configured', scraped: 0, newArticles: 0, errors: 0 };
  }
  const results = { skipped: false, scraped: 0, newArticles: 0, errors: 0, failures: [] };
  for (const source of d.sources) {
    stopIfAborted(signal);
    try {
      await scrapeSource(d, apiKey, source, results);
    } catch (err) {
      if (signal?.aborted) throw signal.reason || err;
      await recordRun(store, source, 'failed', { fetchedAt: now().toISOString() });
      results.errors += 1;
      // Stored as the `sync-blog-source` job's result, which an admin can
      // read: a sentence written here with the error's code, never the
      // error's own text (#945, #1794).
      results.failures.push({
        source: source.name,
        error: storedFailure(err, 'The listing could not be read.'),
      });
      // The provider and the error's code: no editor-typed name or raw error text (#1642).
      log.error?.(`[blogScraper] ${source.provider} listing failed: ${errorCode(err)}`);
    }
  }
  return results;
}

/**
 * @param {object} deps
 * @param {{ queryDocs: Function, upsertDoc: Function }} deps.store
 * @param {{ findDuplicateContent: Function, buildDedupFields: Function }} deps.dedup
 */
export function createBlogListingsScrape({
  store,
  dedup,
  fetch: fetchImpl = globalThis.fetch,
  env = process.env,
  sources = BLOG_SCRAPE_SOURCES,
  now = () => new Date(),
  uuid = randomUUID,
  log = {},
  signal,
}) {
  const d = { store, dedup, fetchImpl, env, sources, now, uuid, log, signal };
  return {
    run: () => run(d),
    ingestArticle: (source, article) => ingestArticle(d, source, article),
  };
}

/**
 * A run's result as the timer prints it: the counts, without `failures`.
 * Each failure names its source, and a source's name is typed by an editor,
 * so the list is kept for the stored job result and left out of the log
 * line (#1635, #1794).
 *
 * @param {object} results - what `run()` returned
 * @returns {object}
 */
export function listingsLogSummary(results) {
  return { ...results, failures: undefined };
}
