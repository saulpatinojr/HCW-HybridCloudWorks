/**
 * reviewer-digest.js — the 07:00 UTC snapshot of the review queue.
 *
 * Ported from Site-Main `generateReviewerDigestSnapshot` (index.js, 088f458):
 * per-status queue counts (capped at 200 each, as the upstream `.limit(200)`
 * read was), the last 30 RSS-sourced items by `fetchedAt` grouped by
 * provider, and the first ten of them as `topItems` — written into
 * `workflow_digests/{YYYY-MM-DD}`.
 */
import { digestDateOf, mergeDigest } from './workflow-records.js';
import { errorResponse } from '../http/error-response.js';

export const REVIEW_STATUSES = ['ingested', 'inspected', 'in_review', 'approved'];
const STATUS_CAP = 200;
const RECENT_LIMIT = 30;
const TOP_ITEMS = 10;

export function createReviewerDigest({ store, now = () => new Date(), log = {} }) {
  async function run({ generatedBy = 'scheduler' } = {}) {
    const digestDate = digestDateOf(now());
    const queueByStatus = {};
    let totalQueued = 0;
    for (const status of REVIEW_STATUSES) {
      const count = Math.min(
        await store.countDocs('content', 'c.contentStatus = @status', [
          { name: '@status', value: status },
        ]),
        STATUS_CAP
      );
      queueByStatus[status] = count;
      totalQueued += count;
    }

    const recent = await store.queryDocs(
      'content',
      `SELECT TOP ${RECENT_LIMIT} c.id, c.Title, c.title, c.cloudProvider, c["Cloud Provider"], c.contentStatus, c.sourceFeed, c.sourceUrl FROM c WHERE c.source = 'rss' ORDER BY c.fetchedAt DESC`,
      []
    );
    const byProvider = {};
    const topItems = [];
    for (const data of recent || []) {
      const provider = data.cloudProvider || data['Cloud Provider'] || 'Unknown';
      byProvider[provider] = (byProvider[provider] || 0) + 1;
      if (topItems.length < TOP_ITEMS) {
        topItems.push({
          id: data.id,
          title: data.Title || data.title || 'Untitled',
          provider,
          status: data.contentStatus || 'ingested',
          sourceFeed: data.sourceFeed || '',
          sourceUrl: data.sourceUrl || '',
        });
      }
    }

    await mergeDigest(store, digestDate, {
      generatedBy,
      queueByStatus,
      totalQueued,
      recentRssCount: (recent || []).length,
      byProvider,
      topItems,
      createdAt: now().toISOString(),
    });
    log.log?.(
      `[reviewerDigest] Generated ${digestDate}: queued=${totalQueued}, recentRss=${(recent || []).length}`
    );
    return {
      success: true,
      digestDate,
      totalQueued,
      recentRssCount: (recent || []).length,
      queueByStatus,
    };
  }
  return { run };
}

/**
 * POST /api/generateReviewerDigestManual — the Ops Health "Run Now" tile
 * (the last dead digest RPC; api-surface notImplemented since the import).
 * The SAME snapshot the 07:00 timer writes, run on demand and merged into
 * the same workflow_digests/{date} doc with generatedBy 'manual' — one
 * digest implementation, whoever asks. Returns the run result directly
 * ({ success, digestDate, totalQueued, recentRssCount, queueByStatus });
 * the tile reads totalQueued and recentRssCount.
 */
export function createReviewerDigestManualHandler({ guard, store, now = () => new Date() }) {
  return async function generateReviewerDigestManual(request, context) {
    const auth = await guard.requireRole(request, 'editor');
    if (auth.error) return auth.error;
    try {
      const result = await createReviewerDigest({ store, now, log: context }).run({
        generatedBy: 'manual',
      });
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result),
      };
    } catch (error) {
      return errorResponse(context, 'Failed to generate reviewer digest', error, 500, request);
    }
  };
}
