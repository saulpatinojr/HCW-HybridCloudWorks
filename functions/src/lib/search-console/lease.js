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
 *
 *   - A daily budget: the same document counts the inspections sent on the
 *     current Google quota day, which runs midnight to midnight Pacific time.
 *     A run reserves the inspections it is about to send before it sends
 *     them, and hands back the ones it did not use when it ends. If a run dies
 *     before handing them back they stay counted, which errs on the safe side.
 *     The app stops at 1,800 a day, leaving 200 for the owner's own
 *     inspections in Google's Search Console screens.
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

  const read = () => store.readDoc(CONTAINER, LEASE_DOC_ID, ADMIN_CONFIG_PARTITION);

  /** The lease document's own fields, without Cosmos's system fields. */
  const shape = (fields) => ({
    id: LEASE_DOC_ID,
    configScope: ADMIN_CONFIG_PARTITION,
    docType: LEASE_DOC_TYPE,
    ...fields,
  });

  const keep = (current) => ({
    holder: current.holder ?? null,
    by: current.by ?? null,
    jobId: current.jobId ?? null,
    takenAt: current.takenAt ?? null,
    expiresAt: current.expiresAt ?? null,
    budget: current.budget ?? null,
  });

  const replace = (current, fields) =>
    store.replaceDocIfMatch(CONTAINER, { ...shape(fields), _etag: current._etag }, { partitionKey: ADMIN_CONFIG_PARTITION });

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
        if (leaseIsLive(current, at)) return { ok: false };
        const fields = {
          budget: current?.budget ?? { day: pacificDay(at), used: 0 },
          holder,
          by,
          jobId,
          takenAt: at.toISOString(),
          expiresAt: new Date(at.getTime() + LEASE_TTL_MS).toISOString(),
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
          reservedDay = day;
          return allowed;
        } catch (failure) {
          if (!isWriteConflict(failure)) throw failure;
        }
      }
      return 0;
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
        if (unused > 0 && counted && counted.day === reservedDay) {
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
          });
          return;
        } catch (failure) {
          if (!isWriteConflict(failure)) throw failure;
        }
      }
    },
  };
}
