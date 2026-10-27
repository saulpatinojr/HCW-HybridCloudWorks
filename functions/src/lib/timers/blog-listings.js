/**
 * blog-listings.js — `fetchBlogListings`, every 6 hours: non-RSS blog listing
 * pages scraped through Firecrawl's structured extraction into `content`
 * drafts, the same shape the RSS ingest writes.
 *
 * Ported from Site-Main index.js (088f458). Upstream used the Firecrawl SDK;
 * this calls the v1 REST endpoint with fetch (one fewer dependency, same
 * request: `formats: ['extract']` with a JSON schema). `FIRECRAWL_API_KEY`
 * is a Key Vault reference on the app; a missing key skips the run.
 */
import { recordRun } from '../rss/source-run.js';
import { randomUUID } from 'node:crypto';
import { readKey } from '../ai/router.js';
import { buildRssContentDoc, truncateText } from '../rss/feeds.js';

export const FIRECRAWL_SCRAPE_URL = 'https://api.firecrawl.dev/v1/scrape';
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
      formats: ['extract'],
      extract: { schema: ARTICLE_SCHEMA },
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.success === false) {
    throw new Error(
      `Firecrawl scrape failed for ${listingUrl}: ${result.error || `HTTP ${response.status}`}`
    );
  }
  const articles = result.data?.extract?.articles || result.extract?.articles || [];
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
  async function ingestArticle(source, article) {
    const sourceUrl = article.url;
    if (!sourceUrl || !sourceUrl.startsWith('http')) return false;
    const title = article.title || 'Untitled';
    const publishedMs = article.publishedAt ? Date.parse(article.publishedAt) : NaN;
    const dup = await dedup.findDuplicateContent(store, {
      url: sourceUrl,
      canonicalUrl: article.canonicalUrl || article.canonical || '',
      title,
      publishedMs: Number.isNaN(publishedMs) ? now().getTime() : publishedMs,
    });
    if (dup.duplicate) return false;
    const doc = buildListingContentDoc({
      article,
      source,
      dedupFields: dedup.buildDedupFields({
        url: sourceUrl,
        canonicalUrl: article.canonicalUrl || article.canonical || '',
        title,
      }),
      now: now(),
      uuid,
    });
    await store.upsertDoc('content', doc);
    return true;
  }

  async function run() {
    const apiKey = readKey(env, 'FIRECRAWL_API_KEY');
    if (!apiKey) {
      log.warn?.('[blogScraper] FIRECRAWL_API_KEY not configured; skipping');
      return { skipped: true, reason: 'not_configured', scraped: 0, newArticles: 0, errors: 0 };
    }
    const results = { skipped: false, scraped: 0, newArticles: 0, errors: 0, failures: [] };
    for (const source of sources) {
      if (signal?.aborted) throw signal.reason || new Error('aborted');
      try {
        log.log?.(`[blogScraper] Scraping ${source.name} (${source.provider})`);
        const articles = await scrapeListingPage({ apiKey, fetch: fetchImpl }, source.url, signal);
        results.scraped += 1;
        let newCount = 0;
        for (const article of articles.slice(0, source.maxItems || MAX_ARTICLES_PER_SOURCE)) {
          if (signal?.aborted) throw signal.reason || new Error('aborted');
          if (await ingestArticle(source, article)) newCount += 1;
        }
        results.newArticles += newCount;
        await recordRun(store, source, 'succeeded', { fetchedAt: now().toISOString(), itemCount: articles.length });
        log.log?.(`[blogScraper] ${source.name}: ${articles.length} found, ${newCount} new`);
      } catch (err) {
        if (signal?.aborted) throw signal.reason || err;
        await recordRun(store, source, 'failed', { fetchedAt: now().toISOString() });
        results.errors += 1;
        results.failures.push({ source: source.name, error: err?.message || String(err) });
        log.error?.(`[blogScraper] Failed ${source.name}: ${err?.message || err}`);
      }
    }
    return results;
  }
  return { run, ingestArticle };
}
