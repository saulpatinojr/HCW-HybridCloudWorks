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
 *     holding the lease and stops. A marker nobody cleared lapses after 35
 *     minutes, like the lease.
 *
 * Every write is conditional: a new lease document is created only if none
 * exists (Cosmos answers 409 otherwise), and a change to an existing one is
 * made only if it has not changed since it was read (its ETag; Cosmos answers
 * 412 otherwise). Losing that race means another run got there first.
 */
import { randomUUID } from 'node:crypto';
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';

const CONTAINER = 'admin_config';
export const LEASE_DOC_ID = 'search_console_lease';
export const LEASE_DOC_TYPE = 'search_console_lease';
/** Longer than the job's 20-minute budget and a run's normal few minutes. */
export const LEASE_TTL_MS = 35 * 60 * 1000;
/**
 * How long one run may go on before it stops starting work and cancels the
 * calls still waiting for an answer: well inside the lease's 35 minutes, so
 * the run still holds the lease when it writes its results.
 */
export const RUN_DEADLINE_MS = 25 * 60 * 1000;
/** Google's own daily limit of URL inspections for one property. */
export const GOOGLE_DAILY_LIMIT = 2000;
/** What the app allows itself a day: Google's 2,000 less 200 for the owner. */
export const DEFAULT_DAILY_BUDGET = 1800;
/** The app setting that may lower (or, up to Google's limit, raise) the budget. */
export const BUDGET_SETTING = 'GSC_DAILY_INSPECTION_BUDGET';
/** Google's quota day follows Pacific time. */
export const QUOTA_TIME_ZONE = 'America/Los_Angeles';
const WRITE_ATTEMPTS = 3;
const HOUR_MS = 60 * 60 * 1000;

const pacificFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: QUOTA_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The Pacific-time calendar day of an instant, as `YYYY-MM-DD`. */
export function pacificDay(date) {
  const parts = Object.fromEntries(pacificFormat.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

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

/** Whether a stored lease is held by a run and has not lapsed. */
export function leaseIsLive(lease, now) {
  if (!lease || typeof lease.holder !== 'string' || !lease.holder) return false;
  const expiresAt = Date.parse(lease.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

/** Whether a stored queued-job marker names a job and has not lapsed. */
export function pendingJobIsLive(lease, now) {
  const pending = lease?.pendingJob;
  if (!pending || typeof pending.jobId !== 'string' || !pending.jobId) return false;
  const expiresAt = Date.parse(pending.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

/** Inspections already counted for `now`'s Pacific day (zero on a new day). */
export function usedToday(lease, now) {
  const budget = lease?.budget;
  if (!budget || budget.day !== pacificDay(now)) return 0;
  const used = Number(budget.used);
  return Number.isFinite(used) && used > 0 ? used : 0;
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

const isWriteConflict = (failure) => {
  const status = failure?.code ?? failure?.statusCode;
  return status === 412 || status === 409;
};

/** The lease document's own fields, without Cosmos's system fields. */
const shape = (fields) => ({
  id: LEASE_DOC_ID,
  configScope: ADMIN_CONFIG_PARTITION,
  docType: LEASE_DOC_TYPE,
  ...fields,
});

/** Every field of a stored lease document that a write must carry over. */
const keep = (current) => ({
  holder: current.holder ?? null,
  by: current.by ?? null,
  jobId: current.jobId ?? null,
  takenAt: current.takenAt ?? null,
  expiresAt: current.expiresAt ?? null,
  budget: current.budget ?? null,
  pendingJob: current.pendingJob ?? null,
});

const readLease = (store) => store.readDoc(CONTAINER, LEASE_DOC_ID, ADMIN_CONFIG_PARTITION);

const replaceLease = (store, current, fields) =>
  store.replaceDocIfMatch(CONTAINER, { ...shape(fields), _etag: current._etag }, { partitionKey: ADMIN_CONFIG_PARTITION });

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
  try {
    if (lease) {
      await replaceLease(store, lease, { ...keep(lease), pendingJob });
    } else {
      await store.createDoc(
        CONTAINER,
        shape({ holder: null, by: null, jobId: null, takenAt: null, expiresAt: null, budget: null, pendingJob })
      );
    }
    return { ok: true };
  } catch (failure) {
    if (!isWriteConflict(failure)) throw failure;
    return { ok: false };
  }
}

/**
 * One run's hold on the lease.
 *
 * @param {object} deps
 * @param {{ readDoc: Function, createDoc: Function, replaceDocIfMatch: Function }} deps.store
 * @param {() => Date} [deps.now]
 * @param {number} [deps.budget] - inspections allowed a Pacific day
 * @param {'timer'|'job'} [deps.by] - who started the run, shown to Run now
 * @param {string|null} [deps.jobId] - the job's id when a job started it
 * @param {string} [deps.holder] - this run's random id (a test seam)
 */
export function createRunLease({
  store,
  now = () => new Date(),
  budget = DEFAULT_DAILY_BUDGET,
  by = 'timer',
  jobId = null,
  holder = randomUUID(),
}) {
  /** The day the reservation was counted against, so a refund lands on the same day. */
  let reservedDay = null;
  /**
   * Set when this run reserved on two different days (a run that crossed
   * midnight Pacific): what is unused cannot be told apart by day, so
   * nothing is handed back, which errs on the safe side.
   */
  let reservedOnTwoDays = false;

  const read = () => readLease(store);
  const replace = (current, fields) => replaceLease(store, current, fields);

  /**
   * The queued-job marker after this run starts: cleared when it names this
   * run's job (the job is no longer waiting) or has lapsed, kept otherwise
   * (another job is still queued).
   */
  const pendingAfterStart = (current, at) =>
    pendingJobIsLive(current, at) && current.pendingJob.jobId !== jobId ? current.pendingJob : null;

  return {
    holder,

    /**
     * Take the lease. `{ ok: true }` when this run holds it now;
     * `{ ok: false }` when another run holds it.
     */
    async acquire() {
      for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
        const current = await read();
        const at = now();
        if (leaseIsLive(current, at)) {
          // Another run holds it, so this job will not run. Its marker is
          // cleared all the same, or Run now would wait for it until it lapses.
          if (jobId && current.pendingJob?.jobId === jobId) {
            try {
              await replace(current, { ...keep(current), pendingJob: null });
            } catch (failure) {
              if (!isWriteConflict(failure)) throw failure;
              continue;
            }
          }
          return { ok: false };
        }
        const fields = {
          budget: current?.budget ?? { day: pacificDay(at), used: 0 },
          holder,
          by,
          jobId,
          takenAt: at.toISOString(),
          expiresAt: new Date(at.getTime() + LEASE_TTL_MS).toISOString(),
          pendingJob: pendingAfterStart(current, at),
        };
        try {
          if (current) await replace(current, fields);
          else await store.createDoc(CONTAINER, shape(fields));
          return { ok: true };
        } catch (failure) {
          if (!isWriteConflict(failure)) throw failure;
          // Another run wrote first: read again and see whether it now holds it.
        }
      }
      return { ok: false };
    },

    /**
     * Count up to `wanted` inspections against today's budget and return how
     * many may be sent (0 when the budget is spent or this run no longer
     * holds the lease).
     */
    async reserve(wanted) {
      for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
        const current = await read();
        if (!current || current.holder !== holder) return 0;
        const at = now();
        const day = pacificDay(at);
        const used = usedToday(current, at);
        const allowed = Math.max(0, Math.min(wanted, budget - used));
        if (allowed === 0) return 0;
        try {
          await replace(current, { ...keep(current), budget: { day, used: used + allowed } });
          if (reservedDay !== null && reservedDay !== day) reservedOnTwoDays = true;
          reservedDay = day;
          return allowed;
        } catch (failure) {
          if (!isWriteConflict(failure)) throw failure;
        }
      }
      return 0;
    },

    /**
     * Check, just before the run writes its results, that this run still
     * holds the lease and that it has not lapsed, and extend it by another
     * LEASE_TTL_MS so no other run can take it while the write is made. The
     * extension is a conditional write (ifMatch): if the document changed
     * since it was read (412), it is read again and checked again, because
     * the change may only be a Run now press marking a queued job. `{ ok: true }`
     * when this run still holds the lease; `{ ok: false }` when another run
     * holds it, it lapsed, or it kept changing under every attempt.
     */
    async renew() {
      for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
        const current = await read();
        const at = now();
        if (!current || current.holder !== holder || !leaseIsLive(current, at)) return { ok: false };
        try {
          await replace(current, { ...keep(current), expiresAt: new Date(at.getTime() + LEASE_TTL_MS).toISOString() });
          return { ok: true };
        } catch (failure) {
          if (!isWriteConflict(failure)) throw failure;
        }
      }
      return { ok: false };
    },

    /**
     * Give the lease back, handing back `unused` reserved inspections that
     * were never sent. Does nothing when another run has taken over a lapsed
     * lease in the meantime.
     */
    async release({ unused = 0 } = {}) {
      for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
        const current = await read();
        if (!current || current.holder !== holder) return;
        let counted = current.budget ?? null;
        if (unused > 0 && !reservedOnTwoDays && counted && counted.day === reservedDay) {
          counted = { day: counted.day, used: Math.max(0, (Number(counted.used) || 0) - unused) };
        }
        try {
          await replace(current, {
            holder: null,
            by: null,
            jobId: null,
            takenAt: current.takenAt ?? null,
            expiresAt: null,
            releasedAt: now().toISOString(),
            budget: counted,
            pendingJob: current.pendingJob ?? null,
          });
          return;
        } catch (failure) {
          if (!isWriteConflict(failure)) throw failure;
        }
      }
    },
  };
}
