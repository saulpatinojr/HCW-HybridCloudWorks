/**
 * labs/visitor-end.js — ending one visitor session (visitor-session.js has
 * the header that explains the sessions): claim its record under the ETag
 * (visitor-claim.js), delete its Coder workspace and user
 * (visitor-cleanup.js), and save it as over only once Coder confirms both.
 */
import {
  CLEANUP_REARM_MS,
  CLEANUP_RETRY_BASE_MS,
  lostRace,
  MAX_CLEANUP_ATTEMPTS,
  MAX_CLEANUP_ROUNDS,
  mayHoldLab,
  SESSION_CONTAINER,
  SESSION_STATUS,
  USER_REFUSALS_BEFORE_WORKSPACE_RETRY,
  VISITOR_DOC_TTL_SECONDS,
  VISITOR_FAILED_DOC_TTL_SECONDS,
  VISITOR_PENDING_DOC_TTL_SECONDS,
} from './visitor-model.js';
import { releaseSlot } from './visitor-slots.js';
import { DAILY_CAP_REFUND, recordRefund, refundOwed } from './visitor-refunds.js';
import { claimSession, countOf } from './visitor-claim.js';
import { cleanUpCoder } from './visitor-cleanup.js';

export { claimable, claimSession, countOf } from './visitor-claim.js';
export { cleanUpCoder } from './visitor-cleanup.js';

/**
 * End one session: claim it, delete its Coder workspace and user, and save it
 * as over only when Coder has confirmed both. Used by the stop route (a
 * visitor pressing End), by the sweep for a session past its hour, and by the
 * sweep again for one still waiting for its clean-up to be finished.
 *
 * @param {object} store
 * @param {Function} fetchImpl
 * @param {{ base: string, token: string } | null} config - null: Coder cannot be called
 * @param {object} session - the stored record, with the `_etag` it was read with
 * @param {object} options
 * @param {'ended' | 'expired'} options.endStatus - what it becomes (a retried record keeps the one it was first given)
 * @param {number} options.nowMs
 * @param {(line: string) => void} [options.log] - content-free lines only
 * @returns {Promise<{ outcome: 'done' | 'pending' | 'given-up' | 'taken-elsewhere' | 'gone' | 'changed', status?: string }>}
 *   `done`: both deletes confirmed and the record is saved as over. `pending`:
 *   not yet, it will be tried again. `given-up`: the last try of a round was
 *   used (`cleanup_failed`; another round follows unless it was the last).
 *   The rest: another request has it, its record has aged out, or it kept
 *   changing.
 */
export async function endSession(store, fetchImpl, config, session, { endStatus, nowMs, log = null }) {
  const claim = await claimSession(store, session, endStatus, nowMs);
  if (claim.outcome !== 'claimed') return claim;

  const claimed = claim.session;
  const steps = await cleanUpCoder(fetchImpl, config, claimed);
  // A start that never ran still owes its daily start back (#1464 review,
  // findings C and round 2): the record is not over until the refund is written.
  const owed = refundOwed(claimed);
  const refunded = owed ? await recordRefund(store, claimed, nowMs, log) : false;
  const end = endFacts(claimed, steps, { owed, refunded });
  const next = nextRecord(claimed, steps, end, nowMs);

  const lost = await saveEnded(store, next);
  if (lost) return lost;

  // A session that no longer holds a lab lets its slot go (#1464 review, finding A).
  if (!mayHoldLab(next)) await releaseSlot(store, next, nowMs);
  return reportEnd(log, steps, end);
}

/** Where this try leaves the session: finished, given up, and whether the workspace delete is asked for again. */
function endFacts(claimed, steps, { owed, refunded }) {
  const attempts = claimed.cleanupAttempts;
  const finished = steps.workspaceGone && steps.userGone && (!owed || refunded);
  // Coder refusing the user (417) after an earlier try saved the workspace as
  // gone: after a few of those in a row, ask for the workspace delete again,
  // since the delete build Coder accepted may have failed (#1403, item 3).
  const refusals = steps.user === 'HTTP 417' ? countOf(claimed.userRefusals) + 1 : 0;
  const askWorkspaceAgain =
    !finished &&
    refusals >= USER_REFUSALS_BEFORE_WORKSPACE_RETRY &&
    Boolean(claimed.workspaceGone) &&
    Boolean(steps.workspaceId);
  const rounds = countOf(claimed.cleanupRounds);
  return {
    owed,
    refunded,
    attempts,
    finished,
    givenUp: !finished && attempts >= MAX_CLEANUP_ATTEMPTS,
    refusals,
    askWorkspaceAgain,
    rounds,
    lastRound: rounds >= MAX_CLEANUP_ROUNDS,
  };
}

/** The status and timing fields for each way a try can end: over, given up for the round, or waiting for the next try. */
function statusFields(claimed, steps, end, nowMs) {
  if (end.finished) {
    return { status: claimed.endStatus, workspaceGone: true, userGone: true, ttl: VISITOR_DOC_TTL_SECONDS };
  }
  const nowIso = new Date(nowMs).toISOString();
  const waitingHalves = end.askWorkspaceAgain
    ? { workspaceGone: false, userGone: steps.userGone, userRefusals: 0 }
    : { workspaceGone: steps.workspaceGoneSaved, userGone: steps.userGone, userRefusals: end.refusals };
  if (end.givenUp) {
    return {
      status: SESSION_STATUS.cleanupFailed,
      ...waitingHalves,
      cleanupAt: nowIso,
      ...(end.lastRound ? {} : { retryAt: new Date(nowMs + CLEANUP_REARM_MS).toISOString() }),
      ttl: VISITOR_FAILED_DOC_TTL_SECONDS,
    };
  }
  return {
    status: SESSION_STATUS.cleanupPending,
    ...waitingHalves,
    cleanupAt: nowIso,
    retryAt: new Date(nowMs + CLEANUP_RETRY_BASE_MS * end.attempts).toISOString(),
    ttl: VISITOR_PENDING_DOC_TTL_SECONDS,
  };
}

/** The record this try saves: the claim without its lease, the ids a lookup found, and what confirmed each half. */
function nextRecord(claimed, steps, end, nowMs) {
  const { retryAt: _lease, ...rest } = claimed;
  // Ids a lookup found are kept, so a later try deletes them without looking again.
  const found = {
    ...(steps.workspaceId ? { workspaceId: steps.workspaceId } : {}),
    ...(steps.coderUserId ? { coderUserId: steps.coderUserId } : {}),
  };
  // What confirmed each half, once it is confirmed for good (#1403, item 4).
  const savedHalf = end.finished || (steps.workspaceGoneSaved && !end.askWorkspaceAgain);
  const confirmedBy = {
    ...(steps.workspaceBy && savedHalf ? { workspaceConfirmedBy: steps.workspaceBy } : {}),
    ...(steps.userBy ? { userConfirmedBy: steps.userBy } : {}),
  };
  const next = { ...rest, ...found, ...confirmedBy, ...statusFields(claimed, steps, end, nowMs) };
  if (end.askWorkspaceAgain) delete next.workspaceConfirmedBy;
  if (end.refunded) next.dailyCapRefund = DAILY_CAP_REFUND.given;
  return next;
}

/** Save the record under the ETag of the claim; the outcome when another request took it meanwhile, else null. */
async function saveEnded(store, next) {
  if (typeof store.replaceDocIfMatch !== 'function') {
    await store.upsertDoc(SESSION_CONTAINER, next);
    return null;
  }
  try {
    await store.replaceDocIfMatch(SESSION_CONTAINER, next, { partitionKey: next.id });
    return null;
  } catch (error) {
    if (!lostRace(error)) throw error;
    // The record changed while Coder was being called (the lease ran out and
    // another request took it over, or it aged out). That request owns it now.
    const current = await Promise.resolve(store.readDoc?.(SESSION_CONTAINER, next.id, next.id)).catch(() => null);
    return current ? { outcome: 'taken-elsewhere', status: current.status } : { outcome: 'gone' };
  }
}

/** The log line for this try, content-free, and its outcome. */
function reportEnd(log, steps, end) {
  const { attempts, rounds } = end;
  const where = `workspace ${steps.workspace}, user ${steps.user}${end.owed && !end.refunded ? ', daily start not yet given back' : ''}`;
  if (end.finished) {
    // A 404 or 410 is also how Coder may answer a token that may not see the
    // thing, so a clean-up confirmed that way is said in the log (#1403, item 4).
    if (steps.workspaceBy === 'gone' || steps.userBy === 'gone') {
      log?.(`visitor-session: a session's Coder clean-up was taken as done on a 404 or 410 (${where})`);
    }
    return { outcome: 'done' };
  }
  const again = end.askWorkspaceAgain ? '; the workspace delete will be asked for again' : '';
  if (end.givenUp) {
    log?.(
      end.lastRound
        ? `visitor-session: a session's Coder clean-up was given up for good after ${attempts} tries in round ${rounds + 1}, the last; it no longer counts against the visitor lab limit, and a person must check the host for its workspace (${where})`
        : `visitor-session: a session's Coder clean-up was given up after ${attempts} tries in round ${rounds + 1} of ${MAX_CLEANUP_ROUNDS + 1}; another round follows in an hour (${where})${again}`
    );
    return { outcome: 'given-up' };
  }
  log?.(
    `visitor-session: a session's Coder clean-up is not finished (${where}); try ${attempts} of ${MAX_CLEANUP_ATTEMPTS}${again}`
  );
  return { outcome: 'pending' };
}
