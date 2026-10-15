/**
 * rss-jobs.js — the RSS ingest as a platform job (T-322's first real worker)
 * and the production wiring the `syncRssFeeds` timer shares.
 *
 * Site-Main exposed this as `fetchRssFeedsManual`, a 300 s HTTP handler the
 * admin page called with a 45 s client timeout. Here the page enqueues
 * `fetch-rss-feeds` and polls (frontend/src/lib/jobs.js); the same function
 * runs on the timer every two hours once FEATURE_FLAG_SYNC_RSS_FEEDS is on.
 */
import { queryDocs, upsertDoc } from '../lib/cosmos-client.js';
import { findDuplicateContent, buildDedupFields } from '../lib/cms/content-dedup.js';
import { createRssIngest, createRssParser } from '../lib/rss/ingest.js';
import { registerJobType } from '../lib/jobs.js';

/** One ingest run against production dependencies. Used by the job and the timer. */
export async function runRssIngest(context, { signal } = {}) {
  if (signal?.aborted) throw signal.reason || new Error('aborted');
  const parser = await createRssParser();
  const ingest = createRssIngest({
    store: { queryDocs, upsertDoc },
    parser,
    dedup: { findDuplicateContent, buildDedupFields },
    log: context,
    signal,
  });
  return ingest.processRssFeeds({ signal });
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
