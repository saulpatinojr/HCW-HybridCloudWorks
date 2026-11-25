/**
 * ingest.js — fetch every provider feed, cache it, draft new content, rebuild
 * the homepage aggregate. Shared by the `fetch-rss-feeds` job (the admin
 * "Run Now" button) and the `syncRssFeeds` timer.
 *
 * Ported from Site-Main `processRssFeeds` (functions/index.js, 088f458). What
 * changed and why:
 *   - Firestore batch/doc writes → Cosmos upserts through the store seam, one
 *     rss_cache document per feed (id `${provider}_${feed}`), so a re-run
 *     replaces rather than appends — `items` is capped at write time (T-319).
 *   - The Telegram alert on feed errors is NOT ported yet (there is no
 *     notifier in this codebase). Errors are returned in the result and so
 *     land in the job document, where the admin page shows them.
 *   - No `https.Agent` plumbing: rss-parser is handed a timeout and a
 *     User-Agent; TLS validation stays strict and a certificate failure skips
 *     that feed with the reason recorded (OWASP A02), exactly as upstream.
 *
 * Everything with a side effect arrives through `deps`, so the test suite
 * runs the whole loop against fakes.
 */
import { recordRun } from './source-run.js';
import { guardedFetch } from '../http/guarded-fetch.js';
import { randomUUID } from 'node:crypto';
import { recordedFailure } from '../http/error-response.js';
import { feedErrorCode } from './feed-error-code.js';
import {
  PROVIDER_FEEDS,
  PROVIDERS,
  MAX_CACHE_ITEMS_PER_FEED,
  MAX_NEW_CONTENT_PER_FEED,
  buildCacheItems,
  buildRssContentDoc,
  buildHomepageFeedItems,
  cacheDocId,
  truncateText,
} from './feeds.js';

export const RSS_CACHE_CONTAINER = 'rss_cache';
export const HOMEPAGE_FEEDS_CONTAINER = 'homepage_feeds';
export const HOMEPAGE_FEEDS_DOC_ID = 'latest';

const TLS_CODES = new Set(['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED']);

/** The production parser. Lazy so tests never load rss-parser. */
export async function createRssParser() {
  const { default: RssParser } = await import('rss-parser');
  const parser = new RssParser({
    timeout: 20000,
    headers: { 'User-Agent': 'Mozilla/5.0 HybridCloudWorks-Bot/1.0' },
    customFields: {
      item: [
        ['content:encoded', 'contentFull'],
        ['media:content', 'mediaContent'],
      ],
    },
  });
  return { async parseURL(url, { signal } = {}) {
    const result = await guardedFetch(url, { httpsOnly: true, signal, timeoutMs: 20000, maxBytes: 8 * 1024 * 1024, headers: { 'User-Agent': 'HybridCloudWorks-Bot/1.0' } });
    // The status travels as a field, so a log line can name it (`HTTP_404`)
    // without reading this sentence (#1794).
    if (!result.response.ok) {
      throw Object.assign(new Error(`Feed HTTP ${result.response.status}`), { status: result.response.status });
    }
    try {
      return await parser.parseString(result.text());
    } catch (err) {
      // The XML reader's errors are plain Errors with only a message; the
      // code says it was the body, not the fetch, that failed.
      throw Object.assign(new Error('The feed body could not be read as a feed.'), {
        code: feedErrorCode(err),
        cause: err,
      });
    }
  } };
}

/** Stop between steps once the job's signal fired. */
function stopIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || new Error('aborted');
}

/** Whether a failure is the run being stopped, which ends the sweep rather than one feed. */
const isAbort = (signal, err) => Boolean(signal?.aborted) || err?.name === 'AbortError' || err?.message === 'aborted';

async function cacheFeed(d, provider, feed, items) {
  const cacheItems = buildCacheItems(items, feed, MAX_CACHE_ITEMS_PER_FEED);
  const stamp = d.now().toISOString();
  await d.store.upsertDoc(RSS_CACHE_CONTAINER, {
    id: cacheDocId(provider, feed),
    provider,
    feedUrl: feed.url,
    feedName: feed.name,
    items: cacheItems,
    itemCount: cacheItems.length,
    lastFetched: stamp,
    refreshedAt: stamp,
  });
  return cacheItems.length;
}

/** Draft one feed item as new content unless it is already there. True when it was new. */
async function draftItem(d, provider, feed, item, sourceUrl) {
  const { store, dedup, now } = d;
  const title = item.title || 'Untitled';
  const publishedMs = item.isoDate ? Date.parse(item.isoDate) : NaN;
  const dup = await dedup.findDuplicateContent(store, {
    url: sourceUrl,
    title,
    publishedMs: Number.isNaN(publishedMs) ? now().getTime() : publishedMs,
  });
  if (dup.duplicate) return false;
  const doc = buildRssContentDoc({
    item,
    sourceUrl,
    title,
    summary: truncateText(item.contentSnippet || item.content || '', 300),
    provider,
    feed,
    dedupFields: dedup.buildDedupFields({ url: sourceUrl, title }),
    now: now(),
    uuid: d.uuid,
  });
  await store.upsertDoc('content', doc);
  return true;
}

/** Draft the newest items of one feed as content, counting new ones and duplicates. */
async function draftNewContent(d, { provider, feed, results, signal }, items) {
  for (const item of (items || []).slice(0, feed.maxItems || MAX_NEW_CONTENT_PER_FEED)) {
    stopIfAborted(signal);
    const sourceUrl = item.link || '';
    if (!sourceUrl) continue;
    if (await draftItem(d, provider, feed, item, sourceUrl)) results.newContent += 1;
    else results.duplicates += 1;
  }
}

/**
 * Read one feed: `{ parsed }`, or `{ skipped: true }` when the site's
 * certificate failed validation: that feed is skipped with the reason
 * recorded, never read without the check.
 */
async function readFeed(d, provider, feed, results, signal) {
  try {
    return { parsed: await d.parser.parseURL(feed.url, { signal }) };
  } catch (err) {
    const tlsCode = err?.code || err?.cause?.code;
    if (!TLS_CODES.has(tlsCode)) throw err;
    // Refuse to silently bypass TLS validation: skip and say why.
    results.errors.push(`${provider}/${feed.name}: TLS validation failed (${tlsCode})`);
    await recordRun(d.store, feed, 'failed', { fetchedAt: d.now().toISOString() });
    results.skipped += 1;
    return { skipped: true };
  }
}

async function processSingleFeed(d, provider, feed, results, signal) {
  stopIfAborted(signal);
  // The provider and counts only: a feed's name is typed by an editor (#1635).
  d.info(`[rssFetcher] Fetching a ${provider} feed`);
  const read = await readFeed(d, provider, feed, results, signal);
  if (read.skipped) return;
  const { parsed } = read;
  // Not pre-sliced: buildCacheItems applies the cap itself, and it keeps the
  // newest items rather than the first (T-319) — truncating in feed order
  // here would decide that selection before it could. draftNewContent takes
  // its own, smaller slice, so the drafted set is unaffected.
  const items = parsed?.items || [];
  const cached = await cacheFeed(d, provider, feed, items);
  results.cached += 1;
  await draftNewContent(d, { provider, feed, results, signal }, items);
  results.processed += 1;
  await recordRun(d.store, feed, 'succeeded', { fetchedAt: d.now().toISOString(), itemCount: items.length });
  d.info(`[rssFetcher] ${provider} feed: cached ${cached} items`);
}

async function rebuildHomepage(d, feeds) {
  const { store } = d;
  const byProvider = {};
  await Promise.all(
    PROVIDERS.map(async (provider) => {
      byProvider[provider] = await store.queryDocs(
        RSS_CACHE_CONTAINER,
        'SELECT * FROM c WHERE c.provider = @provider',
        [{ name: '@provider', value: provider }]
      );
    })
  );
  for (const provider of PROVIDERS) {
    const activeIds = new Set((feeds[provider] || []).map(feed => cacheDocId(provider, feed)));
    byProvider[provider] = byProvider[provider].filter(doc => activeIds.has(doc.id));
  }
  const items = buildHomepageFeedItems(byProvider);
  await store.upsertDoc(HOMEPAGE_FEEDS_CONTAINER, {
    id: HOMEPAGE_FEEDS_DOC_ID,
    items,
    itemCount: items.length,
    generatedAt: d.now().toISOString(),
  });
  return items.length;
}

/** Every [provider, feed] pair to run, in order; only the one source when `sourceId` is given. */
function selectedFeeds(feeds, sourceId) {
  return Object.entries(feeds).flatMap(([provider, list]) =>
    list.filter((feed) => !sourceId || feed.id === sourceId).map((feed) => [provider, feed])
  );
}

/**
 * @param {object} d - createRssIngest's dependencies
 * @param {object} [options]
 * @param {Record<string, {name: string, url: string}[]>} [options.feeds]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{processed: number, cached: number, newContent: number, duplicates: number, skipped: number, homepageItems: number|null, errors: string[]}>}
 */
async function processRssFeeds(d, { feeds = PROVIDER_FEEDS, signal = d.defaultSignal, sourceId = null } = {}) {
  const { store, now, log } = d;
  stopIfAborted(signal);
  const results = {
    processed: 0,
    cached: 0,
    newContent: 0,
    duplicates: 0,
    skipped: 0,
    homepageItems: null,
    errors: [],
  };
  for (const [provider, feed] of selectedFeeds(feeds, sourceId)) {
    stopIfAborted(signal);
    try {
      await processSingleFeed(d, provider, feed, results, signal);
    } catch (err) {
      if (isAbort(signal, err)) throw err;
      await recordRun(store, feed, 'failed', { fetchedAt: now().toISOString() });
      // One feed failing must not abandon the sweep. The job result is
      // served by getJob, so it names the feed and a sentence with the
      // code and the log line's reference (#945).
      results.errors.push(
        `${provider}/${feed.name}: ${recordedFailure(log, 'The feed could not be read.', err)}`
      );
    }
  }
  stopIfAborted(signal);
  try {
    results.homepageItems = await rebuildHomepage(d, feeds);
  } catch (err) {
    if (isAbort(signal, err)) throw err;
    results.errors.push(
      `homepage_feeds: ${recordedFailure(log, 'The homepage feed could not be rebuilt.', err)}`
    );
  }
  d.info(
    `[rssFetcher] Complete: ${results.processed} feeds, ${results.cached} cached, ${results.newContent} new, ${results.duplicates} duplicates, ${results.errors.length} errors`
  );
  return results;
}

/**
 * @param {object} deps
 * @param {{ queryDocs: Function, upsertDoc: Function }} deps.store
 * @param {{ parseURL: (url: string) => Promise<{items: object[]}> }} deps.parser
 * @param {{ findDuplicateContent: Function, buildDedupFields: Function }} deps.dedup
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 * @param {{ log?: Function, warn?: Function, error?: Function }} [deps.log]
 */
export function createRssIngest({
  store,
  parser,
  dedup,
  now = () => new Date(),
  uuid = randomUUID,
  log = {},
  signal: defaultSignal = null,
}) {
  const info = (...a) => log.log?.(...a);
  const d = { store, parser, dedup, now, uuid, log, info, defaultSignal };
  return {
    processRssFeeds: (options) => processRssFeeds(d, options),
  };
}
