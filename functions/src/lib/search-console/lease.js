/**
 * lease.js — keeps Search Console runs inside Google's inspection quota
 * (#1612 review).
 *
 * Google allows 2,000 URL inspections a day and 600 a minute for one property
 * (https://developers.google.com/webmaster-tools/limits). Two things here make
 * sure the app stays under that, whichever way a run was started (the
 * twice-a-day timer, the page's Run now button, or a job queued straight
 * through enqueueJob):
 *
 *   - A run lease: one document, `admin_config/search_console_lease`, that a
 *     run must take before it does anything and gives back when it ends. While
 *     one run holds it, any other run stops at once without calling Google, so
 *     two runs never overlap. A run that dies without giving it back cannot
 *     block the next ones for long: the lease lapses after 35 minutes, longer
 *     than any run is allowed to take, and an expired lease can be taken over.
 *     A run stops itself 25 minutes after it starts (RUN_DEADLINE_MS), and
 *     before it writes its results it checks that it still holds the lease
 *     and extends it (`renew`). A run that lost the lease, because it ran so
 *     long that the lease lapsed and another run took it, writes nothing, so
 *     it can never overwrite the newer run's results.
 *
 *   - A daily budget: the same document counts the inspections sent on the
 *     current Google quota day, which runs midnight to midnight Pacific time.
 *     A run reserves the inspections it is about to send before it sends
 *     them, and hands back the ones it did not use when it ends. If a run dies
 *     before handing them back they stay counted, which errs on the safe side.
 *     The app stops at 1,800 a day, leaving 200 for the owner's own
 *     inspections in Google's Search Console screens.
 *
 *   - A queued-job marker, `pendingJob` on the same document: the Run now
 *     button claims it (`claimPendingJob`) before it writes a job, so two
 *     presses at the same moment queue one job, not two. The run that job
 *     starts clears it when it takes the lease, or when it finds another run
 *     holding the lease and stops, or when it finds it is no longer needed
 *     (`clearPendingJob`, sync.js). A marker nobody cleared lapses after 35
 *     minutes, like the lease. A sync job checks the marker before it starts
 *     (`waitingMarkedJob`): when the marker names another job still waiting,
 *     that job is the one that runs, and this one stops without calling Google.
 *
 * Every write is conditional: a new lease document is created only if none
 * exists (Cosmos answers 409 otherwise), and a change to an existing one is
 * made only if it has not changed since it was read (its ETag; Cosmos answers
 * 412 otherwise). Losing that race means another run got there first.
 */
import { JOBS_CONTAINER } from '../jobs.js';
import {
  CONTAINER,
  DEFAULT_DAILY_BUDGET,
  keep,
  LEASE_TTL_MS,
  pacificDay,
  pendingJobIsLive,
  readLease,
  replaceLease,
  shape,
  usedToday,
  WRITE_ATTEMPTS,
  wrote,
} from './lease-doc.js';

// The document's own helpers live in lease-doc.js and one run's hold in
// lease-run.js; they are exported again here so callers keep importing
// from lease.js.
export {
  DEFAULT_DAILY_BUDGET,
  LEASE_DOC_ID,
  LEASE_DOC_TYPE,
  LEASE_TTL_MS,
  leaseIsLive,
  pacificDay,
  pendingJobIsLive,
  QUOTA_TIME_ZONE,
  readLease,
  usedToday,
} from './lease-doc.js';
export { createRunLease } from './lease-run.js';

/**
 * How long one run may go on before it stops starting work and cancels the
 * calls still waiting for an answer: well inside the lease's 35 minutes, so
 * the run still holds the lease when it writes its results.
 */
export const RUN_DEADLINE_MS = 25 * 60 * 1000;
/** Google's own daily limit of URL inspections for one property. */
export const GOOGLE_DAILY_LIMIT = 2000;
/** The app setting that may lower (or, up to Google's limit, raise) the budget. */
export const BUDGET_SETTING = 'GSC_DAILY_INSPECTION_BUDGET';
const HOUR_MS = 60 * 60 * 1000;

/**
 * The next midnight Pacific time after `date`. Pacific time is always a
 * whole number of hours behind UTC, so midnight falls on a UTC hour: the
 * first whole hour whose Pacific day differs from today's is the answer,
 * summer time or not.
 */
export function nextPacificMidnight(date) {
  const today = pacificDay(date);
  let at = Math.floor(date.getTime() / HOUR_MS) * HOUR_MS + HOUR_MS;
  while (pacificDay(new Date(at)) === today) at += HOUR_MS;
  return new Date(at);
}

/** The daily budget: the app setting when it is a whole number from 0 to 2,000, else 1,800. */
export function dailyBudget(env = process.env) {
  const raw = typeof env?.[BUDGET_SETTING] === 'string' ? env[BUDGET_SETTING].trim() : '';
  if (!/^\d+$/.test(raw)) return DEFAULT_DAILY_BUDGET;
  const value = Number(raw);
  return value <= GOOGLE_DAILY_LIMIT ? value : DEFAULT_DAILY_BUDGET;
}

/**
 * A marker whose job document is not there yet counts as waiting for this
 * long: the press that claimed it may still be writing the job. After that
 * the write is taken to have failed, and the marker no longer counts.
 */
export const PENDING_WRITE_GRACE_MS = 2 * 60 * 1000;
const WAITING = new Set(['queued', 'running']);

/**
 * The job the stored queued-job marker names, while that job is still
 * waiting to run or running: `{ id, status }`. Null when there is no live
 * marker, or its job has already finished. Reads the job's own document.
 *
 * @param {{ readDoc: Function }} store
 * @param {object|null} lease - the lease document as just read
 * @param {Date} now
 */
export async function waitingMarkedJob(store, lease, now) {
  if (!pendingJobIsLive(lease, now)) return null;
  const { jobId, claimedAt } = lease.pendingJob;
  const job = await store.readDoc(JOBS_CONTAINER, jobId, jobId);
  if (!job) {
    const claimed = Date.parse(claimedAt);
    return Number.isFinite(claimed) && now.getTime() - claimed < PENDING_WRITE_GRACE_MS ? { id: jobId, status: 'queued' } : null;
  }
  return WAITING.has(job.status) ? { id: jobId, status: job.status } : null;
}

/** Inspections still allowed today. */
export function budgetLeft(lease, now, budget = DEFAULT_DAILY_BUDGET) {
  return Math.max(0, budget - usedToday(lease, now));
}

const utcMinute = (date) => `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** The sentence the page shows when today's budget is spent, with when it resets. */
export function budgetSpentMessage(now, budget = DEFAULT_DAILY_BUDGET) {
  const reset = nextPacificMidnight(now);
  return `Today's allowance of ${budget.toLocaleString('en-US')} Google page inspections is used up. It starts again at midnight Pacific time (${utcMinute(reset)}).`;
}

/**
 * Claim the queued-job marker for `jobId`, in one conditional write against
 * the lease document `lease` was read as (null when there is none yet): a
 * create when there is no document, a replace under its ETag otherwise.
 * `{ ok: true }` when this request now holds the marker; `{ ok: false }` when
 * another request or a run changed the document first (409 or 412), and the
 * caller reads it again to see who won.
 *
 * @param {{ createDoc: Function, replaceDocIfMatch: Function }} store
 * @param {object|null} lease - the lease document as just read
 * @param {{ jobId: string, now: Date }} claim
 */
export async function claimPendingJob(store, lease, { jobId, now }) {
  const pendingJob = {
    jobId,
    claimedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + LEASE_TTL_MS).toISOString(),
  };
  const ok = await wrote(() =>
    lease
      ? replaceLease(store, lease, { ...keep(lease), pendingJob })
      : store.createDoc(CONTAINER, shape({ holder: null, by: null, jobId: null, takenAt: null, expiresAt: null, budget: null, pendingJob }))
  );
  return { ok };
}

/**
 * Clear the queued-job marker when it names `jobId`, for a job that will not
 * run after all. Leaves a marker naming another job alone. A conditional
 * write under the document's ETag; when something else changed the document
 * first (412), it is read again and checked again.
 *
 * @param {{ readDoc: Function, replaceDocIfMatch: Function }} store
 * @param {string} jobId
 */
export async function clearPendingJob(store, jobId) {
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
    const current = await readLease(store);
    if (!current || current.pendingJob?.jobId !== jobId) return;
    if (await wrote(() => replaceLease(store, current, { ...keep(current), pendingJob: null }))) return;
  }
}
