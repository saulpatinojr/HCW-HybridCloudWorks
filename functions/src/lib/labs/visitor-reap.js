/**
 * labs/visitor-reap.js — the sweep that ends visitor sessions past their
 * hour and tries again the clean-ups Coder has not confirmed (visitor-
 * session.js has the header that explains it).
 */
import {
  MAX_SWEEP_SESSIONS,
  SESSION_CONTAINER,
  SESSION_STATUS,
  SWEEP_DEADLINE_MS,
  VISITOR_JOB_TYPE,
} from './visitor-model.js';
import { errorKind } from './visitor-session.js';
import { endSession } from './visitor-end.js';

/** The statuses whose records the sweep takes up again once their `retryAt` has come. */
export const DUE_STATUSES = Object.freeze([
  SESSION_STATUS.cleanupPending,
  SESSION_STATUS.ending,
  SESSION_STATUS.provisioning,
  SESSION_STATUS.cleanupFailed,
]);

/**
 * The sweep. Ends every session past `expiresAt` (saved as `expired` once
 * Coder confirms its workspace and user are gone), and tries again every
 * record whose time has come: a clean-up Coder has not yet confirmed, a claim
 * whose holder never finished, a start whose process never finished, and a
 * given-up record due another round (#1388, #1403).
 *
 * Never throws for one bad session: a store failure that is not a lost race
 * is counted in `failed` and, when `log` is given, reported by kind only
 * (the code or error name, with no session id and no error text). It was once
 * swallowed here without a trace, which is how a reaper that saved nothing ran
 * unnoticed (#1383).
 *
 * @param {object} store
 * @param {Function} fetchImpl
 * @param {{ base: string, token: string } | null} config - null: Coder cannot be called, so sessions that need it stay pending
 * It takes up no new session once SWEEP_DEADLINE_MS has passed since it
 * started (#1403): the claims it makes last CLEANUP_LEASE_MS from `nowIso`,
 * and a session taken up later than that could still be in its Coder calls
 * when another sweep takes it over. The rest wait for the next run, and the
 * log says how many.
 *
 * @param {object} [options]
 * @param {string} [options.nowIso] - the moment the sweep is reckoned from (its claims' leases run from it)
 * @param {(line: string) => void} [options.log]
 * @param {number} [options.limit] - the most sessions to take up; the rest wait for the next sweep (default MAX_SWEEP_SESSIONS)
 * @param {() => number} [options.clock] - epoch ms, read as the sweep goes, for the deadline
 * @returns {Promise<{ reaped: number, finished: number, pending: number, failed: number }>}
 *   `reaped`: sessions past their hour that this call saved as expired.
 *   `finished`: sessions waiting on a clean-up that this call saved as over.
 *   `pending`: sessions Coder has not yet confirmed, to be tried again.
 *   `failed`: given up, kept changing, or could not be saved. One that a stop
 *   ended first is counted nowhere.
 */
export async function reapExpiredVisitorSessions(
  store,
  fetchImpl,
  config,
  { nowIso = new Date().toISOString(), log = null, limit = MAX_SWEEP_SESSIONS, clock = () => Date.now() } = {}
) {
  const tally = { reaped: 0, finished: 0, pending: 0, failed: 0 };
  if (!store?.queryDocs) return tally;
  const nowMs = Date.parse(nowIso);
  const startedMs = clock();

  let expiredSessions = [];
  try {
    expiredSessions = await store.queryDocs(SESSION_CONTAINER, EXPIRED_QUERY, [
      { name: '@top', value: limit },
      { name: '@type', value: VISITOR_JOB_TYPE },
      { name: '@status', value: SESSION_STATUS.active },
      { name: '@nowIso', value: nowIso },
    ]);
  } catch (error) {
    // A sweep that never ran must not look like one that found nothing.
    log?.(`visitor-session: the expired sessions could not be listed (${errorKind(error)})`);
    return tally;
  }

  const due = await dueSessions(store, { limit, nowIso, log });
  const taken = sweepWork(expiredSessions, due).slice(0, limit);
  for (const [index, item] of taken.entries()) {
    if (clock() - startedMs >= SWEEP_DEADLINE_MS) {
      // Late enough that this session's Coder calls could outlast the lease
      // its claim would hold; it and the rest wait for the next run.
      log?.(`visitor-session: the sweep stopped before its lease ran out, leaving ${taken.length - index} sessions for the next run`);
      break;
    }
    await sweepOne(store, fetchImpl, config, item, { nowMs, log, tally });
  }
  return tally;
}

/** Waiting for a retry, a claim or a start whose holder never finished, and a given-up record due another round. */
async function dueSessions(store, { limit, nowIso, log }) {
  try {
    const due = await store.queryDocs(SESSION_CONTAINER, DUE_QUERY, [
      { name: '@top', value: limit },
      { name: '@type', value: VISITOR_JOB_TYPE },
      { name: '@statuses', value: [...DUE_STATUSES] },
      { name: '@dueIso', value: nowIso },
    ]);
    return Array.isArray(due) ? due : [];
  } catch (error) {
    log?.(`visitor-session: the sessions waiting for a clean-up could not be listed (${errorKind(error)})`);
    return [];
  }
}

/** The sessions to end, expired first, each with what it becomes and whether it is a retry. */
function sweepWork(expiredSessions, due) {
  return [
    ...expiredSessions.map((session) => ({ session, endStatus: SESSION_STATUS.expired, retry: false })),
    ...due.map((session) => ({
      session,
      // What it was going to become, if that is one of the two final statuses; anything else is an expiry.
      endStatus: [SESSION_STATUS.ended, SESSION_STATUS.expired].includes(session.endStatus) ? session.endStatus : SESSION_STATUS.expired,
      retry: true,
    })),
  ];
}

/** End one session and count what happened. */
async function sweepOne(store, fetchImpl, config, { session, endStatus, retry }, { nowMs, log, tally }) {
  try {
    const { outcome } = await endSession(store, fetchImpl, config, session, { endStatus, nowMs, log });
    if (outcome === 'done') tally[retry ? 'finished' : 'reaped'] += 1;
    if (outcome === 'pending') tally.pending += 1;
    if (outcome === 'given-up') tally.failed += 1;
    if (outcome === 'changed') {
      tally.failed += 1;
      log?.('visitor-session: a session kept changing and was not cleaned up');
    }
  } catch (error) {
    tally.failed += 1;
    log?.(`visitor-session: a session could not be saved (${errorKind(error)})`);
  }
}

/**
 * The three queries on `lab_jobs`, as Cosmos runs them. The tests run these
 * very strings against their documents (`runCosmosQuery` in
 * test/cosmos-predicate.js), so a mistake in
 * one fails a test (#1403, item 8).
 *
 * Each is bounded with `TOP @top` (#1403): the sweep reads no more than it
 * will take up (its `limit`), and the routes no more than MAX_HOLDING_RECORDS.
 * The number of records is small in any case; the bound is what makes that
 * true by construction, now that the sweep runs 720 times a day. `TOP` takes a
 * parameter, as a constant would: Microsoft Learn, "Parameterized queries"
 * (https://learn.microsoft.com/cosmos-db/query/parameterized-queries, read
 * 2026-11-03).
 */
export const EXPIRED_QUERY =
  'SELECT TOP @top * FROM c WHERE c.type = @type AND c.status = @status AND c.expiresAt <= @nowIso';
export const DUE_QUERY =
  'SELECT TOP @top * FROM c WHERE c.type = @type AND ARRAY_CONTAINS(@statuses, c.status) AND c.retryAt <= @dueIso';
export const HOLDING_QUERY = 'SELECT TOP @top * FROM c WHERE c.type = @type AND ARRAY_CONTAINS(@statuses, c.status)';
