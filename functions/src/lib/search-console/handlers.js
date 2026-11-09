/**
 * handlers.js — the admin Search Console page's two routes (#1612).
 *
 *   GET  cms/search-console        the last run's snapshot, as the page reads it     editor
 *   POST cms/search-console/run    queue one run now as the sync-search-console job  editor
 *
 * The page never talks to Google. The GET reads the one document sync.js
 * writes (`admin_config/search_console_snapshot`) and answers it in the shape
 * the page was built against, with `status`:
 *
 *   not_configured  one of the three Google sign-in settings is empty (the
 *                   names of the empty ones are in `missing`; never a value)
 *   never_run       configured, but no run has written the document yet
 *   ok              the document from the last good run
 *   error           the last run failed; `run.message` says where, and the
 *                   figures are the last good run's
 *
 * The POST does not run the ~200 inspections inside the request (an HTTP
 * answer on Flex Consumption is cut at 230 seconds). It writes a platform job
 * and sends its queue message (lib/jobs.js, the same path as enqueueJob), and
 * answers 202 at once. Before that it checks, in this order:
 *
 *   - a run already holds the run lease (lease.js), whether the timer's or a
 *     job's: 202 with `alreadyRunning` (and that job's id when a job holds it);
 *   - today's inspection budget is spent: 429 `daily_budget_spent`, with a
 *     sentence saying when it starts again;
 *   - a sync job is already waiting: 202 with `alreadyQueued` and its id while
 *     it is queued, or `alreadyRunning` and its id once it has started.
 *
 * Checking and then writing are two steps, so two presses at the same moment
 * could both pass the checks. To make sure only one of them queues a job,
 * the press first claims the queued-job marker on the lease document
 * (`pendingJob`, lease.js) in one conditional write. The press that loses
 * that write reads the document again and answers with the winner's job
 * (`alreadyQueued`) or the run that has started since (`alreadyRunning`).
 * The run clears the marker when it starts.
 *
 * A job queued some other way, for example straight through enqueueJob,
 * claims no marker, so the third check also looks in the jobs container for a
 * sync job still queued or running. It judges each job by its latest sign of
 * life (the newest of `createdAt`, `startedAt`, `requeuedAt`, `updatedAt` and
 * Cosmos's own last-write time `_ts`), not by when it was created: the jobs
 * sweeper (lib/jobs.js) sends a queued job's message again every ten minutes
 * and records that in `requeuedAt`, so a job can wait far longer than its own
 * budget and still be about to run. A job with no sign of life for
 * IN_FLIGHT_WINDOW_MS is taken as lost.
 *
 * These answers are for the person pressing the button. The rules themselves
 * are kept by the run (sync.js takes the lease and the budget, and a job whose
 * run is no longer needed stops before it calls Google), so a job queued some
 * other way keeps them too.
 */
import { randomUUID } from 'node:crypto';
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { JOBS_CONTAINER, newJobDoc } from '../jobs.js';
import { errorResponse } from '../http/error-response.js';
import { readGoogleAuthConfig } from './google-auth.js';
import {
  budgetLeft,
  budgetSpentMessage,
  claimPendingJob,
  dailyBudget,
  LEASE_DOC_ID,
  leaseIsLive,
  waitingMarkedJob,
} from './lease.js';
import { CONTAINER, emptySnapshot, NOT_AVAILABLE, SNAPSHOT_DOC_ID } from './sync.js';

export const SEARCH_CONSOLE_ROLE = 'editor';
export const SYNC_JOB_TYPE = 'sync-search-console';
/**
 * The job's budget; a queued or running job older than this plus slack is
 * treated as lost. Longer than the run's own 25-minute limit
 * (RUN_DEADLINE_MS), so a slow Run now stops itself and saves what it has,
 * as a timer run does, instead of being cut off by the job first. Still
 * under the 30-minute default function timeout on Flex Consumption.
 */
export const SYNC_JOB_TIMEOUT_MS = 28 * 60 * 1000;
/**
 * A sync job queued or running with no sign of life for this long is taken
 * as lost: its 28-minute budget plus 15 minutes of slack, more than the jobs
 * sweeper (lib/jobs.js) waits before it re-sends a queued job's message (10
 * minutes) or marks a running job past its budget as timed out (5 minutes).
 */
export const IN_FLIGHT_WINDOW_MS = SYNC_JOB_TIMEOUT_MS + 15 * 60 * 1000;
/** Kept here too for callers that read it from the routes' module. */
export { PENDING_WRITE_GRACE_MS } from './lease.js';
/** Times one press re-reads and tries again after losing the marker write to something other than another press. */
const CLAIM_ATTEMPTS = 3;

/**
 * The latest sign of life of a job document, in milliseconds: the newest of
 * the times lib/jobs.js and the sweeper write, and Cosmos's own last-write
 * time (`_ts`, in seconds). NaN when the document carries none of them.
 */
export function lastActivity(job) {
  const times = ['createdAt', 'startedAt', 'requeuedAt', 'updatedAt']
    .map((field) => Date.parse(job?.[field]))
    .filter(Number.isFinite);
  if (Number.isFinite(job?._ts)) times.push(job._ts * 1000);
  return times.length ? Math.max(...times) : Number.NaN;
}

const privateJson = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  body: JSON.stringify(body),
});

/** The stored snapshot's data sections, Cosmos's own fields left behind. */
function present(stored, siteUrl) {
  const base = emptySnapshot(siteUrl);
  if (!stored) return base;
  return {
    siteUrl: typeof stored.siteUrl === 'string' && stored.siteUrl ? stored.siteUrl : siteUrl,
    generatedAt: stored.generatedAt ?? null,
    run: stored.run ?? null,
    indexing: { ...base.indexing, ...(stored.indexing ?? {}) },
    performance: { ...base.performance, ...(stored.performance ?? {}) },
    sitemaps: Array.isArray(stored.sitemaps) ? stored.sitemaps : [],
  };
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ readDoc: Function, upsertDoc: Function, queryDocs: Function, createDoc: Function, replaceDocIfMatch: Function }} deps.store
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 */
export function createSearchConsoleHandlers({ guard, store, env = process.env, now = () => new Date(), uuid = randomUUID }) {
  /** The sync job queued or running with the most recent sign of life inside the window, or null. */
  async function jobInFlight() {
    const rows = await store.queryDocs(
      JOBS_CONTAINER,
      "SELECT c.id, c.status, c.createdAt, c.startedAt, c.requeuedAt, c.updatedAt, c._ts FROM c WHERE c.type = @type AND (c.status = 'queued' OR c.status = 'running')",
      [{ name: '@type', value: SYNC_JOB_TYPE }]
    );
    const cutoff = now().getTime() - IN_FLIGHT_WINDOW_MS;
    const live = (Array.isArray(rows) ? rows : [])
      .map((row) => ({ row, at: lastActivity(row) }))
      .filter(({ at }) => at >= cutoff);
    live.sort((a, b) => b.at - a.at);
    return live[0]?.row ?? null;
  }

  /** A run already going: the lease is held, or a sync job's status is running. */
  const runningAnswer = (jobId) =>
    privateJson(202, {
      ok: true,
      queued: true,
      alreadyRunning: true,
      status: 'running',
      ...(typeof jobId === 'string' && jobId ? { jobId } : {}),
    });

  /** A sync job found waiting: still queued, or already started. */
  const waitingAnswer = (job) =>
    job.status === 'running'
      ? runningAnswer(job.id)
      : privateJson(202, { ok: true, queued: true, alreadyQueued: true, jobId: job.id, status: 'queued' });

  return {
    /** GET cms/search-console */
    async get(request, context) {
      const auth = await guard.requireRole(request, SEARCH_CONSOLE_ROLE);
      if (auth.error) return auth.error;
      try {
        const config = readGoogleAuthConfig(env);
        const stored = await store.readDoc(CONTAINER, SNAPSHOT_DOC_ID, ADMIN_CONFIG_PARTITION);
        const data = present(stored, config.siteUrl);
        let status;
        if (!config.configured) status = 'not_configured';
        else if (!stored) status = 'never_run';
        else status = stored.status === 'error' ? 'error' : 'ok';
        return privateJson(200, {
          ok: true,
          status,
          ...data,
          ...(config.configured ? {} : { missing: config.missing }),
          notAvailable: [...NOT_AVAILABLE],
        });
      } catch (failure) {
        return errorResponse(context, 'Failed to read the Search Console snapshot', failure, 500, request);
      }
    },

    /** POST cms/search-console/run */
    async run(request, context, io = {}) {
      const auth = await guard.requireRole(request, SEARCH_CONSOLE_ROLE);
      if (auth.error) return auth.error;
      if (typeof io.enqueue !== 'function') {
        context?.error?.('searchConsoleRun: no queue output wired');
        return privateJson(500, { ok: false, error: 'Job queue is not configured' });
      }
      try {
        const config = readGoogleAuthConfig(env);
        if (!config.configured) {
          return privateJson(409, {
            ok: false,
            error: 'not_configured',
            message: 'Google sign-in is not set up yet; the runbook docs/runbooks/search-console.md has the steps.',
            missing: config.missing,
          });
        }
        const budget = dailyBudget(env);
        for (let attempt = 1; attempt <= CLAIM_ATTEMPTS; attempt += 1) {
          const at = now();
          const lease = await store.readDoc(CONTAINER, LEASE_DOC_ID, ADMIN_CONFIG_PARTITION);
          if (leaseIsLive(lease, at)) return runningAnswer(lease.jobId);
          if (budgetLeft(lease, at, budget) === 0) {
            return privateJson(429, { ok: false, error: 'daily_budget_spent', message: budgetSpentMessage(at, budget) });
          }
          const marked = await waitingMarkedJob(store, lease, at);
          if (marked) return waitingAnswer(marked);
          // A job queued some other way (straight through enqueueJob) has no marker.
          const running = await jobInFlight();
          if (running) return waitingAnswer(running);
          const jobId = uuid();
          const claim = await claimPendingJob(store, lease, { jobId, now: at });
          // Lost the write: read again, and answer with whoever won.
          if (!claim.ok) continue;
          await store.upsertDoc(
            JOBS_CONTAINER,
            newJobDoc({ id: jobId, type: SYNC_JOB_TYPE, payload: {}, requestedBy: auth.user ?? null, createdAt: now().toISOString() })
          );
          io.enqueue({ jobId, type: SYNC_JOB_TYPE });
          return privateJson(202, { ok: true, queued: true, jobId, status: 'queued', poll: `getJob?jobId=${jobId}` });
        }
        // Lost the write every time to something that left no job behind.
        return privateJson(409, {
          ok: false,
          error: 'busy',
          message: 'Another request changed the run state at the same moment. Press Run now again.',
        });
      } catch (failure) {
        return errorResponse(context, 'Failed to queue a Search Console run', failure, 500, request);
      }
    },
  };
}
