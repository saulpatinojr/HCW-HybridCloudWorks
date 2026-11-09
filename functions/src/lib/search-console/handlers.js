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
 *   - a sync job is already queued: 202 with `alreadyQueued` and its id.
 *
 * These answers are for the person pressing the button. The rules themselves
 * are kept by the run (sync.js takes the lease and the budget), so a job
 * queued some other way, for example straight through enqueueJob, keeps them
 * too.
 */
import { randomUUID } from 'node:crypto';
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { JOBS_CONTAINER, newJobDoc } from '../jobs.js';
import { errorResponse } from '../http/error-response.js';
import { readGoogleAuthConfig } from './google-auth.js';
import { budgetLeft, budgetSpentMessage, dailyBudget, LEASE_DOC_ID, leaseIsLive } from './lease.js';
import { CONTAINER, emptySnapshot, NOT_AVAILABLE, SNAPSHOT_DOC_ID } from './sync.js';

export const SEARCH_CONSOLE_ROLE = 'editor';
export const SYNC_JOB_TYPE = 'sync-search-console';
/** The job's budget; a queued or running job older than this plus slack is treated as lost. */
export const SYNC_JOB_TIMEOUT_MS = 20 * 60 * 1000;
const IN_FLIGHT_WINDOW_MS = SYNC_JOB_TIMEOUT_MS + 15 * 60 * 1000;

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
 * @param {{ readDoc: Function, upsertDoc: Function, queryDocs: Function }} deps.store
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 */
export function createSearchConsoleHandlers({ guard, store, env = process.env, now = () => new Date(), uuid = randomUUID }) {
  /** The newest sync job still queued or running inside its window, or null. */
  async function jobInFlight() {
    const rows = await store.queryDocs(
      JOBS_CONTAINER,
      "SELECT c.id, c.status, c.createdAt FROM c WHERE c.type = @type AND (c.status = 'queued' OR c.status = 'running')",
      [{ name: '@type', value: SYNC_JOB_TYPE }]
    );
    const cutoff = now().getTime() - IN_FLIGHT_WINDOW_MS;
    const live = (Array.isArray(rows) ? rows : []).filter((row) => Date.parse(row?.createdAt) >= cutoff);
    live.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return live[0] ?? null;
  }

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
        const at = now();
        const lease = await store.readDoc(CONTAINER, LEASE_DOC_ID, ADMIN_CONFIG_PARTITION);
        if (leaseIsLive(lease, at)) {
          return privateJson(202, {
            ok: true,
            queued: true,
            alreadyRunning: true,
            status: 'running',
            ...(typeof lease.jobId === 'string' && lease.jobId ? { jobId: lease.jobId } : {}),
          });
        }
        const budget = dailyBudget(env);
        if (budgetLeft(lease, at, budget) === 0) {
          return privateJson(429, { ok: false, error: 'daily_budget_spent', message: budgetSpentMessage(at, budget) });
        }
        const running = await jobInFlight();
        if (running) {
          return privateJson(202, { ok: true, queued: true, alreadyQueued: true, jobId: running.id, status: running.status });
        }
        const jobId = uuid();
        await store.upsertDoc(
          JOBS_CONTAINER,
          newJobDoc({ id: jobId, type: SYNC_JOB_TYPE, payload: {}, requestedBy: auth.user ?? null, createdAt: now().toISOString() })
        );
        io.enqueue({ jobId, type: SYNC_JOB_TYPE });
        return privateJson(202, { ok: true, queued: true, jobId, status: 'queued', poll: `getJob?jobId=${jobId}` });
      } catch (failure) {
        return errorResponse(context, 'Failed to queue a Search Console run', failure, 500, request);
      }
    },
  };
}
