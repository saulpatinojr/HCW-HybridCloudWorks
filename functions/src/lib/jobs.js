/**
 * jobs.js — in-platform asynchronous jobs (T-322).
 *
 * Flex Consumption caps an HTTP response at 230 seconds at the load balancer,
 * and nothing in host.json can raise it. Six Site-Main handlers declare
 * longer timeouts and make the browser wait (generateListenAndLearn 540 s,
 * refreshToolServiceCache 300 s, forgeArticle 300 s, fetchRssFeedsManual
 * 300 s, generateWeeklyDigest 300 s, batchInspect 300 s). On Azure each of
 * them becomes a JOB: the HTTP call returns 202 with a job id in well under a
 * second, a queue-triggered worker does the work with the non-HTTP timeout
 * (30 minutes on Flex), and the client polls `getJob` until a terminal state.
 *
 * Why not `lab_jobs`: that flow hands jobs to the external VPS agent, which
 * polls, claims and reports back over its own App Role. These jobs run
 * INSIDE the Function App, on the Storage Queue the host already owns
 * (AzureWebJobsStorage, identity-based; the app's managed identity holds
 * Queue Data Contributor on it), so no new credential and no new service.
 *
 * Flow
 *   POST /api/enqueueJob {type, payload}
 *     → 202 {jobId}                      (document 'queued' + queue message)
 *   queue 'platform-jobs' → runJob(message)
 *     → claim with an etag-conditioned replace ('queued' → 'running'), so a
 *       duplicate delivery — queues are at-least-once — is a no-op;
 *     → run the registered worker under the type's own timeout;
 *     → 'succeeded' | 'failed' | 'timeout', with result or error.
 *   GET|POST /api/getJob?jobId=…
 *     → the document, minus Cosmos system fields.
 *
 * Worker contract: `worker(payload, { context, job, now })` returns a small,
 * JSON-serialisable result (the document is the record; large outputs belong
 * in their own container or in blob storage, with the id in the result). A
 * thrown error becomes `failed` with its message; it is NOT retried — the
 * document is the source of truth and an operator re-enqueues deliberately.
 *
 * The document is written before the queue message is sent by the output
 * binding, so a binding that fails after the write leaves the job 'queued'
 * with no message behind it. That gap was left open on purpose at first and
 * is now closed: `createJobSweeper` below re-enqueues stale 'queued' jobs, run
 * every 15 minutes by `platformJobSweeper` (functions/jobs-sweeper.js) when
 * the `PLATFORM_JOB_SWEEPER` timer is armed. `noop` is here so the whole path
 * can be exercised end to end.
 */
import { randomUUID } from 'node:crypto';
import { runAsJob } from './job-context.js';
import { buildJobSweeper } from './job-sweeper.js';
import { enqueueJob, getJob } from './job-routes.js';
import { DEFAULT_TIMEOUT_MS, JOBS_CONTAINER, registry } from './job-model.js';
import { logFailure, storedFailure, errorFacts } from './http/error-response.js';

export {
  JOBS_CONTAINER,
  JOBS_QUEUE,
  JOB_READ_FLOOR,
  JOB_STATUSES,
  JobFailedError,
  JobPayloadTooLargeError,
  TERMINAL_JOB_STATUSES,
  getJobType,
  jobPayloadBytes,
  listJobTypes,
  newJobDoc,
  publicJob,
  registerJobType,
  resetJobTypes,
} from './job-model.js';

const MAX_ERROR_CHARS = 2000;

function truncate(text, max = MAX_ERROR_CHARS) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function isPreconditionFailure(err) {
  const code = err?.code ?? err?.statusCode;
  return code === 412 || code === 'PreconditionFailed';
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ readDoc: Function, upsertDoc: Function, patchDoc: Function, replaceDocIfMatch: Function }} deps.store
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 * @param {Map<string, object>} [deps.types] - test seam; defaults to the module registry
 */
export function createJobHandlers({
  guard,
  store,
  now = () => new Date(),
  uuid = randomUUID,
  types = registry,
}) {
  const deps = { guard, store, now, uuid, types };
  return {
    /**
     * POST /api/enqueueJob — editor (or the type's own role).
     * @param {object} request
     * @param {object} context
     * @param {{ enqueue: (message: {jobId: string, type: string}) => void }} io - the queue output
     */
    enqueueJob: (request, context, io) => enqueueJob(deps, request, context, io),
    getJob: (request, context) => getJob(deps, request, context),
    runJob: (message, context) => runJob(deps, message, context),
  };
}

/**
 * Queue worker. Never throws for a job-level failure: the document is the
 * record, and a rethrow would only make the queue redeliver the same
 * message up to the poison threshold.
 *
 * @param {{jobId?: string}} message - the parsed queue message
 * @param {object} context
 * @returns {Promise<{jobId: string|null, outcome: string}>}
 */
async function runJob({ store, now, types }, message, context) {
  const jobId = typeof message?.jobId === 'string' ? message.jobId : '';
  if (!jobId) {
    context.warn?.('runJob: message without jobId', message);
    return { jobId: null, outcome: 'ignored' };
  }

  const doc = await store.readDoc(JOBS_CONTAINER, jobId, jobId);
  if (!doc) {
    context.warn?.('runJob: a queued job has no document');
    return { jobId, outcome: 'missing' };
  }
  if (doc.status !== 'queued') {
    // Duplicate delivery, or an operator cancelled it while it waited.
    // No job id in these lines: they reach Log Analytics (#1635), and an id is a document id.
    context.log?.(`runJob: a ${doc.type} job is ${doc.status}; skipping`);
    return { jobId, outcome: 'skipped' };
  }

  const spec = types.get(doc.type);
  const startedAt = now().toISOString();
  if (!spec) {
    await store.patchDoc(JOBS_CONTAINER, jobId, {
      status: 'failed',
      startedAt,
      finishedAt: startedAt,
      error: `Unknown job type ${doc.type} (not registered in this deployment)`,
    });
    return { jobId, outcome: 'failed' };
  }

  // Claim. The etag makes two deliveries race safely: the loser gets 412.
  let claimed;
  try {
    claimed = await store.replaceDocIfMatch(JOBS_CONTAINER, {
      ...doc,
      status: 'running',
      startedAt,
      attempts: (doc.attempts || 0) + 1,
    });
  } catch (error) {
    if (isPreconditionFailure(error)) {
      context.log?.(`runJob: a ${doc.type} job was claimed elsewhere`);
      return { jobId, outcome: 'skipped' };
    }
    throw error;
  }

  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => {
        controller.abort(
          Object.assign(new Error('job timed out'), {
            code: 'JOB_TIMEOUT',
          })
        );
        reject(
          Object.assign(new Error('job timed out'), {
            code: 'JOB_TIMEOUT',
          })
        );
      },
      spec.timeoutMs
    );
  });
  // Best effort, after the terminal write: a hook failure is logged, never
  // re-thrown — it must not turn a finished job into a poisoned message.
  const invokeOnComplete = async (info) => {
    if (typeof spec.onComplete !== 'function') return;
    try {
      await spec.onComplete(info, { context, now });
    } catch (hookError) {
      context.warn?.(
        `runJob: onComplete for ${doc.type} failed: ${errorFacts(hookError)}`
      );
    }
  };

  try {
    const result = await Promise.race([
      // Inside the job's context, the shared Cosmos and Blob clients
      // refuse a write that starts after the timeout (job-context.js).
      // This code, and the hooks below, run outside it.
      runAsJob(controller.signal, () =>
        spec.worker(doc.payload, {
          context,
          job: claimed,
          now,
          signal: controller.signal,
          abortSignal: controller.signal,
        })
      ),
      timeout,
      // The deadline is the worker's, so it is disarmed the moment the
      // race settles: a worker that finished just inside it must not have
      // its signal fire during the terminal write or the hook below.
    ]).finally(() => clearTimeout(timer));
    await store.patchDoc(JOBS_CONTAINER, jobId, {
      status: 'succeeded',
      finishedAt: now().toISOString(),
      result: result === undefined ? null : result,
      error: null,
    });
    context.log?.(`runJob: a ${doc.type} job succeeded`);
    await invokeOnComplete({
      job: claimed,
      status: 'succeeded',
      result: result === undefined ? null : result,
      error: null,
    });
    return { jobId, outcome: 'succeeded' };
  } catch (error) {
    const timedOut = error?.code === 'JOB_TIMEOUT';
    // getJob serves this document to the type's role, so it stores the
    // worker's authored sentence, or a fixed one with the error's code
    // and the log line's correlation id: never a provider's, the
    // store's or a socket's own words (#945). The log line is
    // content-free and carries the same id.
    const correlationId = logFailure(
      context,
      `runJob: ${doc.type} ${timedOut ? 'timed out' : 'failed'}`,
      error
    );
    const errorText = truncate(
      storedFailure(error, timedOut ? 'The job ran out of time.' : 'The job failed.', {
        correlationId,
      })
    );
    await store.patchDoc(JOBS_CONTAINER, jobId, {
      status: timedOut ? 'timeout' : 'failed',
      finishedAt: now().toISOString(),
      error: errorText,
    });
    await invokeOnComplete({
      job: claimed,
      status: timedOut ? 'timeout' : 'failed',
      result: null,
      error: errorText,
    });
    return { jobId, outcome: timedOut ? 'timeout' : 'failed' };
  } finally {
    // Already cleared when the race settled; this covers a worker that
    // threw before the race was entered.
    clearTimeout(timer);
  }
}

// ── Stale-queued sweeper (job-sweeper.js) ───────────────────────────────────

export {
  MAX_REQUEUE_COUNT,
  RUNNING_GRACE_MS,
  STALE_QUEUED_MS,
  SWEEP_BATCH,
} from './job-sweeper.js';

/**
 * The stale-queued and abandoned-job sweeper (job-sweeper.js), over this
 * module's container and registry.
 *
 * @param {object} [deps] store, now, log, and a registry for tests
 */
export function createJobSweeper(deps = {}) {
  return buildJobSweeper(deps, {
    container: JOBS_CONTAINER,
    registry,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  });
}
