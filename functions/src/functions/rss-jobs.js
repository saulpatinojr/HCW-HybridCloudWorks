/**
 * rss-jobs.js — the RSS ingest as a platform job (T-322's first real worker)
 * and the production wiring the `syncRssFeeds` timer shares.
 *
 * Site-Main exposed this as `fetchRssFeedsManual`, a 300 s HTTP handler the
 * admin page called with a 45 s client timeout. Here the page enqueues
 * `fetch-rss-feeds` and polls (frontend/src/lib/jobs.js); the same function
 * runs on the timer every two hours once FEATURE_FLAG_SYNC_RSS_FEEDS is on.
 */
import { queryDocs, upsertDoc, readDoc } from '../lib/cosmos-client.js';
import { findDuplicateContent, buildDedupFields } from '../lib/cms/content-dedup.js';
import { createRssIngest, createRssParser } from '../lib/rss/ingest.js';
import { loadBlogSources, groupRssSources } from '../lib/rss/source-config.js';
import { registerJobType } from '../lib/jobs.js';

/** One ingest run against production dependencies. Used by the job and the timer. */
export async function runRssIngest(context, { signal } = {}) {
  if (signal?.aborted) throw signal.reason || new Error('aborted');
  const sources = await loadBlogSources({ queryDocs, readDoc });
  const parser = await createRssParser();
  const ingest = createRssIngest({
    store: { queryDocs, upsertDoc, readDoc },
    parser,
    dedup: { findDuplicateContent, buildDedupFields },
    log: context,
    signal,
  });
  return ingest.processRssFeeds({ signal, feeds: groupRssSources(sources) });
}

registerJobType('fetch-rss-feeds', {
  // Ingests feed items as draft content; editor, matching the RSS admin route.
  role: 'editor',
  description:
    'Fetch every provider RSS feed, cache it, draft new content for review, rebuild the homepage feed.',
  maxPayloadBytes: 256,
  // ~20 feeds at up to 20 s each plus dedup reads: well inside this, and far
  // outside the 230 s an HTTP response gets.
  timeoutMs: 12 * 60 * 1000,
  worker: (_payload, { context, signal } = {}) => runRssIngest(context, { signal }),
});

registerJobType('sync-blog-source', {
  role: 'editor',
  description: 'Fetch one enabled blog source into the review workflow.',
  maxPayloadBytes: 256,
  timeoutMs: 3 * 60 * 1000,
  worker: async (payload, { context, signal } = {}) => {
    const sources = await loadBlogSources({ queryDocs, readDoc });
    const source = sources.find((item) => item.id === payload?.sourceId && item.enabled);
    if (!source) throw new Error('Choose an enabled blog source.');
    if (source.kind === 'listing') {
      const { createBlogListingsScrape } = await import('../lib/timers/blog-listings.js');
      return createBlogListingsScrape({
        store: { queryDocs, upsertDoc },
        dedup: { findDuplicateContent, buildDedupFields },
        sources: [source],
        log: context,
        signal,
      }).run();
    }
    const ingest = createRssIngest({
      store: { queryDocs, upsertDoc },
      parser: await createRssParser(),
      dedup: { findDuplicateContent, buildDedupFields },
      log: context,
      signal,
    });
    return ingest.processRssFeeds({ feeds: groupRssSources(sources), sourceId: source.id, signal });
  },
});
