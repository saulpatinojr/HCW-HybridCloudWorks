/**
 * forge-studio/queue-outcomes.js — what a finished forge job writes back on
 * its queue entry, the reconcile that catches a write that was lost, and the
 * one-off move of the first cut's single queue document. Split out of
 * queue.js, which re-exports this.
 */
import { ADMIN_CONFIG_PARTITION } from '../../cosmos-client.js';
import { JOBS_CONTAINER, TERMINAL_JOB_STATUSES } from '../../jobs.js';
import { text } from './brief.js';
import {
  CONTAINER,
  LEGACY_QUEUE_DOC_ID,
  PK,
  QUEUE_STATUSES,
  RECONCILE_PER_READ,
  SAFE_ID,
  defaultSleep,
  entryBrief,
  newEntry,
  normalizeQueueUrl,
  updateEntry,
} from './queue-entries.js';

/**
 * What a job's onComplete records on the entry it was started for: the
 * document when it succeeded, the error when it did not. A `skipped`
 * duplicate (the forge's 409) is recorded as forged on the duplicate.
 */
export function outcomeFor({ status, result, error: failure }) {
  if (status === 'succeeded' && result && result.success !== false) {
    return { status: 'forged', contentId: result.contentId || null, error: null };
  }
  if (status === 'succeeded' && result?.skipped) {
    return {
      status: 'forged',
      contentId: result.duplicateOf || result.contentId || null,
      error: result.error ? String(result.error).slice(0, 500) : null,
    };
  }
  const message = failure || result?.error || `the forge job ${status || 'did not finish'}`;
  return {
    status: 'failed',
    contentId: result?.contentId || null,
    error: String(message).slice(0, 500),
  };
}

/**
 * The job's onComplete half: the entry `queueItemId` names takes the
 * outcome, under its own ETag with retries. Nothing when the entry is gone
 * (the owner removed it while the job ran). Should every attempt lose, the
 * list's reconcile reads the job document on the next open.
 */
export async function recordQueueOutcome(
  store,
  { queueItemId, status, result, error },
  { now, sleep = defaultSleep }
) {
  const id = String(queueItemId || '');
  if (!SAFE_ID.test(id)) return null;
  const outcome = outcomeFor({ status, result, error });
  return updateEntry(store, id, () => ({ ...outcome, updatedAt: now().toISOString() }), {
    attempts: 10,
    sleep,
  });
}

/**
 * Forging entries whose job has already finished take its outcome from the
 * job document: the hook above may have lost every ETag race, or the host
 * may have recycled before it ran. At most RECONCILE_PER_READ per read.
 * Resolves to the entries with the outcomes applied.
 */
export async function reconcileForging(ctx, entries) {
  const forging = entries
    .filter((item) => item.status === 'forging' && item.jobId)
    .slice(0, RECONCILE_PER_READ);
  if (!forging.length) return entries;
  const updated = new Map();
  for (const item of forging) {
    const job = await ctx.store.readDoc(JOBS_CONTAINER, item.jobId, item.jobId).catch(() => null);
    if (job && !TERMINAL_JOB_STATUSES.includes(job.status)) continue;
    // No job document at all: the claim was written and the job never was
    // (the write failed and the revert failed too). Failed, not forging.
    const outcome = job
      ? outcomeFor({ status: job.status, result: job.result, error: job.error })
      : { status: 'failed', contentId: null, error: 'the forge job was never written; Save again' };
    const after = await updateEntry(ctx.store, item.id, (entry) =>
      entry.status === 'forging' ? { ...outcome, updatedAt: ctx.now().toISOString() } : null
    ).catch(() => null);
    if (after) updated.set(item.id, after);
  }
  return updated.size ? entries.map((item) => updated.get(item.id) || item) : entries;
}

/** A legacy item as an entry document, its fields and status kept. */
function entryFromLegacy(ctx, item, url) {
  const stamp = ctx.now().toISOString();
  return {
    ...newEntry({
      url,
      stamp: item.addedAt || stamp,
      actor: item.addedBy || 'migration',
      title: item.title,
    }),
    brief: entryBrief({ url, brief: item.brief || {} }),
    kind: text(item.kind, 60),
    status: QUEUE_STATUSES.includes(item.status) ? item.status : 'queued',
    jobId: item.jobId || null,
    contentId: item.contentId || null,
    error: item.error || null,
    updatedAt: item.updatedAt || stamp,
  };
}

/** `createDoc`, with a 409 (the URL's entry exists) answered as null rather than thrown. */
export async function createUnlessPresent(store, entry) {
  try {
    return await store.createDoc(CONTAINER, entry);
  } catch (error) {
    if (error?.code === 409) return null;
    throw error;
  }
}

/**
 * The first cut's single document: its entries become documents of their
 * own and it is emptied so this runs once. Idempotent under concurrent
 * first reads: an entry's id is its URL's hash, so a second reader's
 * createDoc meets a 409 and moves on, and the final emptying is under the
 * legacy document's ETag (the loser's 412 is nothing to do). Nothing when
 * there is no such document or it is already empty.
 */
export async function migrateLegacyQueue(ctx) {
  const legacy = await ctx.store.readDoc(CONTAINER, LEGACY_QUEUE_DOC_ID, ADMIN_CONFIG_PARTITION);
  const items = Array.isArray(legacy?.items) ? legacy.items : [];
  if (!items.length) return 0;
  let moved = 0;
  for (const item of items) {
    const url = normalizeQueueUrl(item.url);
    if (!url) continue;
    if (await createUnlessPresent(ctx.store, entryFromLegacy(ctx, item, url))) moved += 1;
  }
  try {
    await ctx.store.replaceDocIfMatch(
      CONTAINER,
      { ...legacy, items: [], migratedAt: ctx.now().toISOString(), migratedCount: moved },
      PK
    );
  } catch (error) {
    if (error?.code !== 412) throw error;
  }
  return moved;
}
