/**
 * The read side of `scheduledPublishDate` (T-301).
 *
 * The write side has been complete since the migration: `saveContentSchedule`
 * validates and persists the date, `BlogReviewBoard` renders the picker, and
 * Calendar and Queue display the result. Nothing consumed it. An operator
 * scheduled a post, the server accepted it, the UI confirmed it, and the post
 * never went live — with no error and no alert anywhere. A feature that is
 * complete except for the part that does the work is worse than an absent one,
 * because it is indistinguishable from a working one until someone checks.
 *
 * Design notes, each load-bearing:
 *
 *   - **It calls `processPublishContent`, it does not reimplement publishing.**
 *     The status gate, quality gate, image gate, slug resolution, cover
 *     trigger and version snapshot *are* the publish semantics. A timer with
 *     its own copy would drift from the operator path, and the drift would
 *     show up as posts that publish differently depending on who published
 *     them.
 *   - **The date is compared as a string, and that is safe only because both
 *     sides are `Date#toISOString()` output** — fixed width, UTC, `Z`-suffixed,
 *     so lexicographic order is chronological order. `saveContentSchedule`
 *     produces its value that way and so does this module. A local-time or
 *     offset-bearing string would break the comparison silently, which is why
 *     the query also requires `IS_STRING`.
 *   - **`ORDER BY c.scheduledPublishDate` is allowed here**, despite the rule
 *     against ordering on possibly-missing fields that applies elsewhere in
 *     this codebase. That rule exists because Cosmos drops documents lacking
 *     the sort key; here the `WHERE` clause already requires the field to be
 *     present and a string, so the set being ordered is exactly the set that
 *     has it. Do not copy the exemption without copying the `WHERE` clause.
 *   - **The schedule is cleared after publishing.** Without that, every tick
 *     re-matches the same document forever. It would not look like a failure —
 *     `processPublishContent` treats a republish as legitimate — it would look
 *     like version-history spam accumulating every fifteen minutes.
 */

import { digestDateOf, mergeDigest } from './timers/workflow-records.js';
import { recordedFailure } from './http/error-response.js';

const DEFAULT_BATCH = 25;

/**
 * The run's one word, as `workflow_digests/{date}.publishingOps.status`
 * records it: `success` when nothing failed (a skip is a lost race the next
 * tick retries, not a failure), `degraded` when some failed and some
 * published, `failed` when everything due failed.
 *
 * That block had three readers and no writer (#1010): the ops snapshot's
 * `lastSchedulerSuccessAt`, the Telegram bot's /digest, and the Health Hub's
 * Scheduled publishing probe all read `digest.publishingOps`, which nothing in
 * this port wrote, so the hub could only ever say "idle". The publisher now
 * records every run there, nothing due included, which also makes
 * `lastRunAt` the scheduler's heartbeat: the hub calls the scheduler offline
 * after three missed fifteen-minute runs.
 */
export function publishingStatus(summary) {
  if (!summary.failed) return 'success';
  return summary.published > 0 ? 'degraded' : 'failed';
}

/** One rolling alert document, so repeated failures do not flood the list. */
export const PUBLISH_ALERT_ID = 'scheduled_publish_failures';

/**
 * The alert type `ops-health.js` already counts. The consumer was written
 * during the migration and had no producer until now.
 */
export const PUBLISH_ALERT_TYPE = 'scheduled_publish_failures';

/**
 * Documents whose schedule has come due.
 *
 * `contentStatus = 'approved'` mirrors what `saveContentSchedule` writes, and
 * the `Live` clause is written as `NOT IS_DEFINED(c.Live) OR c.Live = false`
 * because legacy documents predate the field — `c.Live != true` would also
 * match documents where it is absent, but says less about why.
 *
 * @param {number} limit
 * @returns {string}
 */
export function buildDueQuery(limit) {
  return (
    `SELECT TOP ${limit} c.id FROM c WHERE ` +
    `c.contentStatus = 'approved' ` +
    // Excludes both the absent field and the explicit null that
    // `saveContentSchedule` writes for an instant publish. Without it every
    // instant-publish document would match on every tick.
    `AND IS_STRING(c.scheduledPublishDate) ` +
    `AND c.scheduledPublishDate <= @now ` +
    `AND (NOT IS_DEFINED(c.Live) OR c.Live = false) ` +
    `ORDER BY c.scheduledPublishDate ASC`
  );
}

/**
 * Build the rolling failure alert.
 *
 * A previously *resolved* alert starts a new incident rather than reviving the
 * old one, so `firstSeenAt` measures the current outage rather than the first
 * one ever. Resolution stays an operator action through `ops-health.js`, which
 * requires a note; nothing here closes an alert on its own.
 *
 * @param {object} args
 * @param {object|null} args.existing
 * @param {{contentId: string, error: string}[]} args.failures
 * @param {string} args.nowIso
 * @returns {object}
 */
export function buildPublishFailureAlert({ existing, failures, nowIso }) {
  const wasOpen = existing && existing.status !== 'resolved' && existing.active !== false;
  return {
    id: PUBLISH_ALERT_ID,
    alertType: PUBLISH_ALERT_TYPE,
    status: 'open',
    active: true,
    severity: 'high',
    title: 'Scheduled publish failures',
    firstSeenAt: wasOpen ? existing.firstSeenAt || nowIso : nowIso,
    updatedAt: nowIso,
    updatedBy: 'publishScheduledContent',
    failureCount: failures.length,
    failures: failures.slice(0, 25),
  };
}

/**
 * @param {object} deps
 * @param {{queryDocs: Function, patchDoc: Function, readDoc: Function, upsertDoc: Function,
 *   createDoc: Function, replaceDocIfMatch: Function}} deps.store the last two for the
 *   digest's run record (timers/workflow-records.js mergeDigest)
 * @param {{processPublishContent: Function}} deps.publish
 * @param {() => Date} [deps.now]
 * @param {number} [deps.batchSize]
 */
export function createScheduledPublisher({ store, publish, now = () => new Date(), batchSize = DEFAULT_BATCH }) {
  return {
    /**
     * One tick. Returns a summary rather than throwing, so a timer invocation
     * fails only on something genuinely unexpected.
     *
     * @param {{log: Function, error: Function}} context
     */
    async runScheduledPublish(context) {
      const at = now();
      let summary;
      try {
        summary = await this.publishDue(at.toISOString(), context);
      } catch (error) {
        // The run itself broke (the due query, most likely). Say so where the
        // hub looks, then let the host record the failure as before.
        await this.recordRun(at, { due: 0, published: 0, skipped: 0, failed: 0 }, context, error);
        throw error;
      }
      await this.recordRun(at, summary, context);
      return summary;
    },

    /**
     * The run's outcome on the day's digest, as `publishingOps`. Best-effort:
     * losing the record must not fail a run whose publishes happened.
     */
    async recordRun(at, summary, context, error = null) {
      try {
        await mergeDigest(store, digestDateOf(at), {
          publishingOps: {
            lastRunAt: at.toISOString(),
            due: summary.due,
            published: summary.published,
            skipped: summary.skipped,
            failed: summary.failed,
            hasMore: Boolean(summary.hasMore),
            status: error ? 'failed' : publishingStatus(summary),
            // The digest is an admin read: a sentence with the code and the
            // log line's reference, never the store's own words (#945).
            ...(error
              ? { error: recordedFailure(context, 'The scheduled publish run failed.', error) }
              : {}),
          },
        });
      } catch (recordError) {
        context.error('[publishScheduledContent] could not record the run on the digest:', recordError);
      }
    },

    /** Publish what is due now; the summary of what happened. */
    async publishDue(nowIso, context) {
      const due = await store.queryDocs('content', buildDueQuery(batchSize), [
        { name: '@now', value: nowIso },
      ]);

      const summary = { due: due.length, published: 0, skipped: 0, failed: 0, hasMore: false };
      if (due.length === 0) return summary;

      // A full batch means there are probably more. They are not chased within
      // this tick: the next one is fifteen minutes away, and a tick that keeps
      // going until the queue drains is a tick that can overrun its own
      // schedule during a backlog.
      summary.hasMore = due.length === batchSize;

      const failures = [];
      for (const row of due) {
        const contentId = String(row.id);
        try {
          const result = await publish.processPublishContent(contentId, {
            user: { oid: 'publishScheduledContent', email: 'scheduler@system' },
            markLive: true,
            createSlugPageTrigger: true,
            addToCurated: true,
          });

          if (result?.error) {
            summary.failed += 1;
            failures.push({ contentId, error: String(result.error) });
            continue;
          }
          if (result?.skipped) {
            // Someone else touched the document between the read and the
            // write. Leaving the schedule set means the next tick retries it,
            // which is the right outcome for a lost race.
            summary.skipped += 1;
            continue;
          }

          summary.published += 1;

          // Only after a publish that actually happened. Clearing it on a
          // failure would silently cancel the operator's schedule.
          //
          // `null`, not `undefined`: `patchDoc` reads `undefined` as a field
          // deletion and reroutes to read-modify-write, and `null` is already
          // what `saveContentSchedule` writes for an instant publish, so the
          // two paths leave the document in the same shape.
          await store.patchDoc('content', contentId, {
            scheduledPublishDate: null,
            scheduledPublishCompletedAt: nowIso,
          });
        } catch (error) {
          summary.failed += 1;
          failures.push({
            contentId,
            error: recordedFailure(context, 'The publish failed.', error),
          });
        }
      }

      if (failures.length > 0) {
        await this.recordFailures(failures, nowIso, context);
      }

      context.log(
        `[publishScheduledContent] due=${summary.due} published=${summary.published} ` +
          `skipped=${summary.skipped} failed=${summary.failed} hasMore=${summary.hasMore}`
      );
      return summary;
    },

    /**
     * Persist failures where the ops dashboard already looks for them.
     * Best-effort: losing the alert must not turn a partial run into a failed
     * timer invocation, because the publishes that did succeed still happened.
     */
    async recordFailures(failures, nowIso, context) {
      try {
        const existing = await store.readDoc('workflow_alerts', PUBLISH_ALERT_ID, PUBLISH_ALERT_ID);
        await store.upsertDoc(
          'workflow_alerts',
          buildPublishFailureAlert({ existing, failures, nowIso })
        );
      } catch (error) {
        context.error('[publishScheduledContent] could not record failure alert:', error);
      }
    },
  };
}
