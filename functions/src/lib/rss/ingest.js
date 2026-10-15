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
import { randomUUID } from 'node:crypto';
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
  return new RssParser({
    timeout: 20000,
    headers: { 'User-Agent': 'Mozilla/5.0 HybridCloudWorks-Bot/1.0' },
    customFields: {
      item: [
        ['content:encoded', 'contentFull'],
        ['media:content', 'mediaContent'],
      ],
    },
  });
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
  const warn = (...a) => log.warn?.(...a);

  async function cacheFeed(provider, feed, items) {
    const cacheItems = buildCacheItems(items, feed, MAX_CACHE_ITEMS_PER_FEED);
    const stamp = now().toISOString();
    await store.upsertDoc(RSS_CACHE_CONTAINER, {
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

  async function draftNewContent(provider, feed, items, results, signal) {
    for (const item of (items || []).slice(0, MAX_NEW_CONTENT_PER_FEED)) {
      if (signal?.aborted) throw signal.reason || new Error('aborted');
      const sourceUrl = item.link || '';
      if (!sourceUrl) continue;
      const title = item.title || 'Untitled';
      const publishedMs = item.isoDate ? Date.parse(item.isoDate) : NaN;
      const dup = await dedup.findDuplicateContent(store, {
        url: sourceUrl,
        title,
        publishedMs: Number.isNaN(publishedMs) ? now().getTime() : publishedMs,
      });
      if (dup.duplicate) {
        results.duplicates += 1;
        continue;
      }
      const doc = buildRssContentDoc({
        item,
        sourceUrl,
        title,
        summary: truncateText(item.contentSnippet || item.content || '', 300),
        provider,
        feed,
        dedupFields: dedup.buildDedupFields({ url: sourceUrl, title }),
        now: now(),
        uuid,
      });
      await store.upsertDoc('content', doc);
      results.newContent += 1;
    }
  }

  async function processSingleFeed(provider, feed, results, signal) {
    if (signal?.aborted) throw signal.reason || new Error('aborted');
    info(`[rssFetcher] Fetching ${feed.name} (${provider})`);
    let parsed;
    try {
      parsed = await parser.parseURL(feed.url);
    } catch (err) {
      if (TLS_CODES.has(err?.code)) {
        // Refuse to silently bypass TLS validation: skip and say why.
        results.errors.push(`${provider}/${feed.name}: TLS validation failed (${err.code})`);
        results.skipped += 1;
        return;
      }
      throw err;
    }
    // Not pre-sliced: buildCacheItems applies the cap itself, and it keeps the
    // newest items rather than the first (T-319) — truncating in feed order
    // here would decide that selection before it could. draftNewContent takes
    // its own, smaller slice, so the drafted set is unaffected.
    const items = parsed?.items || [];
    const cached = await cacheFeed(provider, feed, items);
    results.cached += 1;
    await draftNewContent(provider, feed, items, results, signal);
    results.processed += 1;
    info(`[rssFetcher] ${feed.name}: cached ${cached} items`);
  }

  async function rebuildHomepage() {
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
    const items = buildHomepageFeedItems(byProvider);
    await store.upsertDoc(HOMEPAGE_FEEDS_CONTAINER, {
      id: HOMEPAGE_FEEDS_DOC_ID,
      items,
      itemCount: items.length,
      generatedAt: now().toISOString(),
    });
    return items.length;
  }

  return {
    /**
     * @param {object} [options]
     * @param {Record<string, {name: string, url: string}[]>} [options.feeds]
     * @param {AbortSignal} [options.signal]
     * @returns {Promise<{processed: number, cached: number, newContent: number, duplicates: number, skipped: number, homepageItems: number|null, errors: string[]}>}
     */
    async processRssFeeds({ feeds = PROVIDER_FEEDS, signal = defaultSignal } = {}) {
      if (signal?.aborted) throw signal.reason || new Error('aborted');
      const results = {
        processed: 0,
        cached: 0,
        newContent: 0,
        duplicates: 0,
        skipped: 0,
        homepageItems: null,
        errors: [],
      };
      for (const [provider, list] of Object.entries(feeds)) {
        for (const feed of list) {
          if (signal?.aborted) throw signal.reason || new Error('aborted');
          try {
            await processSingleFeed(provider, feed, results, signal);
          } catch (err) {
            if (signal?.aborted || err?.name === 'AbortError' || err?.message === 'aborted') throw err;
            // One feed failing must not abandon the sweep.
            results.errors.push(`${provider}/${feed.name}: ${err?.message || err}`);
            warn(`[rssFetcher] Failed ${feed.name} (${provider}): ${err?.message}`);
          }
        }
      }
      if (signal?.aborted) throw signal.reason || new Error('aborted');
      try {
        results.homepageItems = await rebuildHomepage();
      } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError' || err?.message === 'aborted') throw err;
        results.errors.push(`homepage_feeds: ${err?.message || err}`);
        warn(`[rssFetcher] homepage_feeds aggregation failed: ${err?.message}`);
      }
      info(
        `[rssFetcher] Complete: ${results.processed} feeds, ${results.cached} cached, ${results.newContent} new, ${results.duplicates} duplicates, ${results.errors.length} errors`
      );
      return results;
    },
  };
}
