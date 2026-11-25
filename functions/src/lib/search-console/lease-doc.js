/**
 * lease-doc.js — the Search Console lease document itself: its fixed names,
 * how a write keeps its fields, the conditional write, and the checks on
 * what it holds (a live lease, a live queued-job marker, today's count).
 * lease.js says what the lease is for, and exports all of this again.
 */
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';

export const CONTAINER = 'admin_config';
export const LEASE_DOC_ID = 'search_console_lease';
export const LEASE_DOC_TYPE = 'search_console_lease';
/** Longer than the job's 28-minute budget and a run's normal few minutes. */
export const LEASE_TTL_MS = 35 * 60 * 1000;
export const WRITE_ATTEMPTS = 3;
/** What the app allows itself a day: Google's 2,000 less 200 for the owner. */
export const DEFAULT_DAILY_BUDGET = 1800;
/** Google's quota day follows Pacific time. */
export const QUOTA_TIME_ZONE = 'America/Los_Angeles';

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

/** Whether an `expiresAt` time is still ahead of `now`. */
const notLapsed = (expiresAtText, now) => {
  const expiresAt = Date.parse(expiresAtText);
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
};

/** Whether a stored lease is held by a run and has not lapsed. */
export function leaseIsLive(lease, now) {
  if (!lease || typeof lease.holder !== 'string' || !lease.holder) return false;
  return notLapsed(lease.expiresAt, now);
}

/** Whether a stored queued-job marker names a job and has not lapsed. */
export function pendingJobIsLive(lease, now) {
  const pending = lease?.pendingJob;
  if (!pending || typeof pending.jobId !== 'string' || !pending.jobId) return false;
  return notLapsed(pending.expiresAt, now);
}

/** Inspections already counted for `now`'s Pacific day (zero on a new day). */
export function usedToday(lease, now) {
  const budget = lease?.budget;
  if (!budget || budget.day !== pacificDay(now)) return 0;
  const used = Number(budget.used);
  return Number.isFinite(used) && used > 0 ? used : 0;
}

export const isWriteConflict = (failure) => {
  const status = failure?.code ?? failure?.statusCode;
  return status === 412 || status === 409;
};

/**
 * Make one conditional write. True when it was made; false when another
 * writer changed the document first (Cosmos answers 409 or 412), so the
 * caller reads it again. Any other failure is thrown on.
 */
export async function wrote(write) {
  try {
    await write();
    return true;
  } catch (failure) {
    if (!isWriteConflict(failure)) throw failure;
    return false;
  }
}

/** The lease document's own fields, without Cosmos's system fields. */
export const shape = (fields) => ({
  id: LEASE_DOC_ID,
  configScope: ADMIN_CONFIG_PARTITION,
  docType: LEASE_DOC_TYPE,
  ...fields,
});

/** Every field of a stored lease document that a write must carry over. */
export const keep = (current) => ({
  holder: current.holder ?? null,
  by: current.by ?? null,
  jobId: current.jobId ?? null,
  takenAt: current.takenAt ?? null,
  expiresAt: current.expiresAt ?? null,
  budget: current.budget ?? null,
  pendingJob: current.pendingJob ?? null,
});

/** The lease document as stored, or null before the first run. */
export const readLease = (store) => store.readDoc(CONTAINER, LEASE_DOC_ID, ADMIN_CONFIG_PARTITION);

export const replaceLease = (store, current, fields) =>
  store.replaceDocIfMatch(CONTAINER, { ...shape(fields), _etag: current._etag }, { partitionKey: ADMIN_CONFIG_PARTITION });
