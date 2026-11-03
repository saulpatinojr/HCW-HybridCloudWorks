/**
 * publishing-watchdog.js — `monitorPublishingPipeline`, every 6 hours.
 *
 * Ported from Site-Main index.js (088f458). Two stall signals: scheduled
 * content whose `scheduledPublishDate` passed more than 45 minutes ago and
 * is still not live, and content marked `published` that has sat non-live
 * for more than 6 hours with no schedule. Counts land in the day's digest;
 * any hit raises a `workflow_alerts` document keyed to the hour.
 */
import { digestDateOf, mergeDigest, raiseAlert, toMillis } from './workflow-records.js';

const STALE_SCHEDULED_MS = 45 * 60 * 1000;
const STAGED_TOO_LONG_MS = 6 * 60 * 60 * 1000;
/** The most candidates one run reads; at the bound the count is a floor. */
export const STAGED_CANDIDATES_BOUND = 1000;

export function createPublishingWatchdog({ store, now = () => new Date(), log = {} }) {
  async function run() {
    const at = now();
    const staleThreshold = new Date(at.getTime() - STALE_SCHEDULED_MS).toISOString();
    const stagedThresholdMs = at.getTime() - STAGED_TOO_LONG_MS;

    const overdue = await store.queryDocs(
      'content',
      'SELECT TOP 100 c.id FROM c WHERE (NOT IS_DEFINED(c.Live) OR c.Live = false) AND IS_DEFINED(c.scheduledPublishDate) AND c.scheduledPublishDate != null AND c.scheduledPublishDate <= @threshold',
      [{ name: '@threshold', value: staleThreshold }]
    );
    // Published, not live, no schedule (#1516). The status, Live and
    // schedule filters are in the query, so the rows are only candidates and
    // the count below is exact up to the bound. This used to read TOP 250 of
    // every non-live item in no order and filter in code, so above 250 it
    // was whichever 250 came back. `Live` may be absent, which `c.Live =
    // false` alone left out. The age stays in code: migrated items can carry
    // a Firestore-style `{ seconds }` time, which a query cannot compare.
    const candidates = await store.queryDocs(
      'content',
      `SELECT TOP ${STAGED_CANDIDATES_BOUND} c.id, c.publishedAt, c.reviewedAt, c.updatedAt FROM c WHERE c.contentStatus = 'published' AND (NOT IS_DEFINED(c.Live) OR c.Live = false) AND (NOT IS_DEFINED(c.scheduledPublishDate) OR IS_NULL(c.scheduledPublishDate) OR c.scheduledPublishDate = '')`,
      []
    );
    const stagedTooLong = (candidates || []).filter((data) => {
      const tsMs = toMillis(data.publishedAt || data.reviewedAt || data.updatedAt || null);
      return tsMs > 0 && tsMs <= stagedThresholdMs;
    });
    const stagedBounded = (candidates || []).length >= STAGED_CANDIDATES_BOUND;

    const overdueCount = (overdue || []).length;
    await mergeDigest(store, digestDateOf(at), {
      publishingWatchdog: {
        lastRunAt: at.toISOString(),
        overdueScheduledCount: overdueCount,
        stagedTooLongCount: stagedTooLong.length,
        stagedTooLongBounded: stagedBounded,
      },
    });

    if (overdueCount > 0 || stagedTooLong.length > 0) {
      await raiseAlert(
        store,
        `publishing-watchdog-${at.toISOString().slice(0, 13)}`,
        {
          alertType: 'publishing_pipeline_stalled_items',
          severity: overdueCount > 0 ? 'critical' : 'warning',
          overdueScheduledCount: overdueCount,
          stagedTooLongCount: stagedTooLong.length,
          stagedTooLongBounded: stagedBounded,
          sampleOverdueIds: (overdue || []).slice(0, 10).map((d) => d.id),
          sampleStagedIds: stagedTooLong.slice(0, 10).map((d) => d.id),
          source: 'monitorPublishingPipeline',
        },
        now
      );
      log.warn?.(
        `[monitorPublishingPipeline] Alerts raised: overdueScheduled=${overdueCount}, stagedTooLong=${stagedTooLong.length}`
      );
    } else {
      log.log?.('[monitorPublishingPipeline] Pipeline healthy: no stalled content detected');
    }
    return { overdueScheduledCount: overdueCount, stagedTooLongCount: stagedTooLong.length };
  }
  return { run };
}
