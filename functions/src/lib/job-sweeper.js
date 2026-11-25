/**
 * job-sweeper.js — the timer's half of the platform jobs (jobs.js): queued
 * jobs whose message was lost are re-enqueued, a job requeued too often is
 * failed as a poison message, and a job abandoned in `running` is reaped.
 * jobs.js builds createJobSweeper from this module with its own registry and
 * re-exports the constants.
 */
import { errorFacts } from './http/error-response.js';

// ── Stale-queued sweeper ─────────────────────────────────────────────────────
//
// The enqueue handler writes the job document and THEN the output binding
// sends the queue message; a binding failure leaves the job `queued` with no
// message behind it. The sweeper (functions/jobs-sweeper.js, a timer)
// re-enqueues those. Duplicates are harmless: runJob's etag-conditioned claim
// skips a job that already started.

export const STALE_QUEUED_MS = 10 * 60 * 1000;
export const SWEEP_BATCH = 20;
export const MAX_REQUEUE_COUNT = 3;
/**
 * Margin added to a job type's own timeoutMs before the sweeper will call a
 * `running` job abandoned (T-710). It absorbs clock skew between the worker
 * and the sweeper plus the delay between a host dying and the next sweep, so
 * the reaper never steals a job from a worker that is merely slow.
 */
export const RUNNING_GRACE_MS = 5 * 60 * 1000;

/**
 * Patch a job under the ETag it was read with, when it has one, so a job
 * that moved since the sweep read it is not overwritten.
 */
function patchJob(store, container, doc, update) {
  return doc._etag
    ? store.patchDoc(container, doc.id, update, { ifMatch: doc._etag })
    : store.patchDoc(container, doc.id, update);
}

/**
 * Run a job type's onComplete hook. Same best-effort contract as runJob's: a
 * throwing hook is logged and never changes the outcome already written.
 */
async function runCompletionHook(spec, info, { log, now, label }) {
  if (typeof spec?.onComplete !== 'function') return;
  try {
    await spec.onComplete(info, { context: log, now });
  } catch (hookError) {
    log.warn?.(`sweep: onComplete for ${label} failed: ${errorFacts(hookError)}`);
  }
}

/**
 * Jobs abandoned in `running` (T-710).
 *
 * A worker that dies mid-run — host restart, scale-in, deploy, or the
 * platform timeout beating the job's own budget — leaves the document
 * `running` forever: redelivery sees `status !== 'queued'` and returns
 * `skipped`, the queued sweep below ignores it, `getJob` reports `running`
 * to a client that polls indefinitely, and the type's `onComplete` never
 * fires, so the failure notification that exists to bring a failed approval
 * back to the phone is lost too.
 *
 * The cutoff is per type, not one blanket value: budgets range from 5 to 28
 * minutes, and a single conservative cutoff would leave short jobs hanging
 * for half an hour. A job is reaped only once its OWN budget plus a grace
 * margin has elapsed, so a slow-but-live worker is never stolen from.
 *
 * This query and the queued one read whole documents (#1198), so the hooks
 * get `job.payload`. That stays cheap because newJobDoc bounds every job
 * document's payload by its type's `maxPayloadBytes`.
 */
async function reapAbandoned(deps, types) {
  const { store, now, container } = deps;
  const cutoff = new Date(now().getTime() - RUNNING_GRACE_MS).toISOString();
  const running = await store.queryDocs(
    container,
    `SELECT TOP ${SWEEP_BATCH} * FROM c WHERE c.status = 'running' AND IS_DEFINED(c.startedAt) AND c.startedAt < @cutoff`,
    [{ name: '@cutoff', value: cutoff }]
  );
  const reaped = [];
  for (const doc of running || []) {
    const spec = types?.get?.(doc.type);
    const budget = abandonedBudget(deps, spec, doc);
    if (budget === null) continue;
    if (await reapOne(deps, spec, doc, budget)) reaped.push({ jobId: doc.id, type: doc.type });
  }
  return reaped;
}

/**
 * The job's own time budget when it has run past that budget plus the grace
 * margin, or null when it may still be running.
 */
function abandonedBudget({ now, log, defaultTimeoutMs }, spec, doc) {
  // An unreadable startedAt is not evidence of abandonment. Comparing an
  // Invalid Date returns false for every operator, so without this an
  // undated row would fall straight through into being reaped.
  const startedMs = Date.parse(doc.startedAt);
  if (!Number.isFinite(startedMs)) {
    log.warn?.('sweep: a job is running with no readable startedAt; leaving it');
    return null;
  }
  // An unregistered type cannot state a budget; fall back to the default
  // rather than leaving it running forever.
  const budget = Number(spec?.timeoutMs) || defaultTimeoutMs;
  return startedMs > now().getTime() - budget - RUNNING_GRACE_MS ? null : budget;
}

/** Mark one abandoned job `timeout` and run its hook; false when the write failed. */
async function reapOne({ store, now, log, container }, spec, doc, budget) {
  const finishedAt = now().toISOString();
  const error = `abandoned while running: no terminal write within ${Math.round(
    (budget + RUNNING_GRACE_MS) / 60000
  )} minutes (worker process lost)`;
  try {
    await patchJob(store, container, doc, { status: 'timeout', finishedAt, error });
  } catch (err) {
    log.warn?.(`sweep: could not reap a job: ${errorFacts(err)}`);
    return false;
  }
  await runCompletionHook(
    spec,
    { job: doc, status: 'timeout', result: null, error },
    { log, now, label: doc.type }
  );
  return true;
}

/** A job requeued MAX_REQUEUE_COUNT times: failed as a poison message, and its hook told. */
async function failPoisonJob({ store, now, log, container }, spec, doc) {
  const finishedAt = now().toISOString();
  const error = `exceeded maximum requeue attempts (${MAX_REQUEUE_COUNT}); marked as poison message`;
  try {
    await patchJob(store, container, doc, { status: 'failed', finishedAt, error });
  } catch (err) {
    log.warn?.(`sweep: could not fail a poison job: ${errorFacts(err)}`);
    return;
  }
  log.warn?.(
    `sweep: a job reached maximum requeue attempts (${MAX_REQUEUE_COUNT}); marked failed as poison message`
  );
  await runCompletionHook(
    spec,
    { job: doc, status: 'failed', result: null, error },
    { log, now, label: `poison ${doc.type}` }
  );
}

/** Stamp a stale queued job for re-enqueueing; true when the stamp was written. */
async function stampRequeue({ store, now, log, container }, doc, currentCount) {
  try {
    await patchJob(store, container, doc, {
      requeuedAt: now().toISOString(),
      requeueCount: currentCount + 1,
    });
    return true;
  } catch (err) {
    log.warn?.(`sweep: could not stamp a job: ${errorFacts(err)}`);
    return false;
  }
}

/** @returns {Promise<{ requeued: {jobId: string, type: string}[], reaped: {jobId: string, type: string}[] }>} */
async function sweep(deps, types) {
  const { store, now, container } = deps;
  const cutoff = new Date(now().getTime() - STALE_QUEUED_MS).toISOString();
  const stale = await store.queryDocs(
    container,
    `SELECT TOP ${SWEEP_BATCH} * FROM c WHERE c.status = 'queued' AND c.createdAt < @cutoff AND (NOT IS_DEFINED(c.requeuedAt) OR c.requeuedAt < @cutoff)`,
    [{ name: '@cutoff', value: cutoff }]
  );
  const requeued = [];
  for (const doc of stale || []) {
    const currentCount = Number(doc.requeueCount) || 0;
    if (currentCount >= MAX_REQUEUE_COUNT) {
      await failPoisonJob(deps, types?.get?.(doc.type), doc);
    } else if (await stampRequeue(deps, doc, currentCount)) {
      requeued.push({ jobId: doc.id, type: doc.type });
    }
  }
  // The queued gap and the running gap are the same failure one state
  // apart, so they are swept together (T-710). Reaping cannot re-enqueue:
  // a job whose worker may have completed real side effects before dying
  // must not be run again silently — it lands `timeout` and visible.
  const reaped = await reapAbandoned(deps, types);
  return { requeued, reaped };
}

/**
 * The sweeper over one store. `jobs` is jobs.js's part: the container, the
 * registry used when the caller passes none, and the default time budget.
 *
 * @param {object} deps
 * @param {{ queryDocs: Function, patchDoc: Function }} deps.store
 * @param {() => Date} [deps.now]
 * @param {{ log?: Function, warn?: Function }} [deps.log]
 * @param {Map<string, object>} [deps.registry]
 * @param {{ container: string, registry: Map<string, object>, defaultTimeoutMs: number }} jobs
 */
export function buildJobSweeper({ store, now = () => new Date(), log = {}, registry: customRegistry } = {}, jobs) {
  const typesToUse = customRegistry || jobs.registry;
  const deps = { store, now, log, container: jobs.container, defaultTimeoutMs: jobs.defaultTimeoutMs };
  return {
    reapAbandoned: (types = typesToUse) => reapAbandoned(deps, types),
    sweep: () => sweep(deps, typesToUse),
  };
}
