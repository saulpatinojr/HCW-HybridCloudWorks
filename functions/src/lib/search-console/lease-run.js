/**
 * lease-run.js — one run's hold on the Search Console lease: taking it,
 * reserving inspections against the daily budget, extending it before the
 * run writes, and giving it back. lease.js says what the lease is for and
 * exports createRunLease again.
 *
 * Every method reads the document, decides, and makes one conditional
 * write; when another writer got there first, it reads again, at most
 * WRITE_ATTEMPTS times.
 */
import { randomUUID } from 'node:crypto';
import {
  CONTAINER,
  DEFAULT_DAILY_BUDGET,
  keep,
  LEASE_TTL_MS,
  leaseIsLive,
  pacificDay,
  pendingJobIsLive,
  readLease,
  replaceLease,
  shape,
  usedToday,
  WRITE_ATTEMPTS,
  wrote,
} from './lease-doc.js';

/**
 * The queued-job marker after this run starts: cleared when it names this
 * run's job (the job is no longer waiting) or has lapsed, kept otherwise
 * (another job is still queued).
 */
const pendingAfterStart = (s, current, at) =>
  pendingJobIsLive(current, at) && current.pendingJob.jobId !== s.jobId ? current.pendingJob : null;

/**
 * Clear the queued-job marker when it names this run's job. True when there
 * was nothing to clear or it was cleared; false when another writer changed
 * the document first.
 */
async function clearOwnMarker(s, current) {
  if (!s.jobId || current?.pendingJob?.jobId !== s.jobId) return true;
  return wrote(() => replaceLease(s.store, current, { ...keep(current), pendingJob: null }));
}

/** One try at taking the lease: the answer, or null to read again and retry. */
async function acquireOnce(s, current, at, admit) {
  if (!leaseIsLive(current, at) && admit && !(await admit(current, at))) {
    return (await clearOwnMarker(s, current)) ? { ok: false, superseded: true } : null;
  }
  if (leaseIsLive(current, at)) {
    // Another run holds it, so this job will not run. Its marker is
    // cleared all the same, or Run now would wait for it until it lapses.
    return (await clearOwnMarker(s, current)) ? { ok: false } : null;
  }
  const fields = {
    budget: current?.budget ?? { day: pacificDay(at), used: 0 },
    holder: s.holder,
    by: s.by,
    jobId: s.jobId,
    takenAt: at.toISOString(),
    expiresAt: new Date(at.getTime() + LEASE_TTL_MS).toISOString(),
    pendingJob: pendingAfterStart(s, current, at),
  };
  // A conflict means another run wrote first: read again and see whether it now holds it.
  const made = await wrote(() => (current ? replaceLease(s.store, current, fields) : s.store.createDoc(CONTAINER, shape(fields))));
  return made ? { ok: true } : null;
}

/**
 * Take the lease. `{ ok: true }` when this run holds it now;
 * `{ ok: false }` when another run holds it.
 *
 * `admit(current, at)`, when given, is asked about the document this call
 * is about to replace; when it answers false the lease is not taken
 * (`{ ok: false, superseded: true }`) and a marker naming this job is
 * cleared. Because the write is conditional on that same document, a
 * change made after `admit` read it fails the write, and the loop asks
 * `admit` again about the new one.
 */
async function acquire(s, { admit } = {}) {
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
    const current = await readLease(s.store);
    const outcome = await acquireOnce(s, current, s.now(), admit);
    if (outcome) return outcome;
  }
  return { ok: false };
}

/** Remember the day a reservation was counted against, noting a run that crossed midnight Pacific. */
function noteReservedDay(s, day) {
  if (s.reservedDay !== null && s.reservedDay !== day) s.reservedOnTwoDays = true;
  s.reservedDay = day;
}

/**
 * Count up to `wanted` inspections against today's budget and return how
 * many may be sent (0 when the budget is spent or this run no longer
 * holds the lease).
 */
async function reserve(s, wanted) {
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
    const current = await readLease(s.store);
    if (!current || current.holder !== s.holder) return 0;
    const at = s.now();
    const day = pacificDay(at);
    const used = usedToday(current, at);
    const allowed = Math.max(0, Math.min(wanted, s.budget - used));
    if (allowed === 0) return 0;
    if (await wrote(() => replaceLease(s.store, current, { ...keep(current), budget: { day, used: used + allowed } }))) {
      noteReservedDay(s, day);
      return allowed;
    }
  }
  return 0;
}

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
async function renew(s) {
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
    const current = await readLease(s.store);
    const at = s.now();
    if (!current || current.holder !== s.holder || !leaseIsLive(current, at)) return { ok: false };
    if (await wrote(() => replaceLease(s.store, current, { ...keep(current), expiresAt: new Date(at.getTime() + LEASE_TTL_MS).toISOString() }))) {
      return { ok: true };
    }
  }
  return { ok: false };
}

/** Today's count after handing back `unused` inspections, when they can be told apart by day. */
function countAfterRefund(s, counted, unused) {
  if (unused > 0 && !s.reservedOnTwoDays && counted && counted.day === s.reservedDay) {
    return { day: counted.day, used: Math.max(0, (Number(counted.used) || 0) - unused) };
  }
  return counted;
}

/**
 * Give the lease back, handing back `unused` reserved inspections that
 * were never sent. Does nothing when another run has taken over a lapsed
 * lease in the meantime.
 */
async function release(s, { unused = 0 } = {}) {
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
    const current = await readLease(s.store);
    if (!current || current.holder !== s.holder) return;
    const counted = countAfterRefund(s, current.budget ?? null, unused);
    const fields = {
      holder: null,
      by: null,
      jobId: null,
      takenAt: current.takenAt ?? null,
      expiresAt: null,
      releasedAt: s.now().toISOString(),
      budget: counted,
      pendingJob: current.pendingJob ?? null,
    };
    if (await wrote(() => replaceLease(s.store, current, fields))) return;
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
  const s = {
    store,
    now,
    budget,
    by,
    jobId,
    holder,
    /** The day the reservation was counted against, so a refund lands on the same day. */
    reservedDay: null,
    /**
     * Set when this run reserved on two different days (a run that crossed
     * midnight Pacific): what is unused cannot be told apart by day, so
     * nothing is handed back, which errs on the safe side.
     */
    reservedOnTwoDays: false,
  };
  return {
    holder,
    acquire: (options) => acquire(s, options),
    reserve: (wanted) => reserve(s, wanted),
    renew: () => renew(s),
    release: (options) => release(s, options),
  };
}
