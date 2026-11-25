/**
 * labs/visitor-end.js — ending one visitor session (visitor-session.js has
 * the header that explains the sessions): claim its record under the ETag,
 * delete its Coder workspace and user, and save it as over only once Coder
 * confirms both.
 */
import {
  CLEANUP_LEASE_MS,
  CLEANUP_REARM_MS,
  CLEANUP_RETRY_BASE_MS,
  FINISH_ATTEMPTS,
  isCoderId,
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
import { deleteUserCall, deleteWorkspaceCall, lookUpUserCall, lookUpWorkspaceCall } from './visitor-coder.js';
import { releaseSlot } from './visitor-slots.js';
import { DAILY_CAP_REFUND, recordRefund, refundOwed } from './visitor-refunds.js';

/** A count stored in a record: a negative, fractional or text one counts as none. */
export const countOf = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);

/**
 * Can this record be taken up by a stop or the sweep now? An `active` one, or
 * one whose time has come (`retryAt` reached) and that is: cleaning up
 * (`ending`, a claim whose lease has run out), waiting for its next try
 * (`cleanup_pending`), a start whose process never finished
 * (`provisioning`, its lease run out) or a given-up one due another round
 * (`cleanup_failed` with a `retryAt`).
 */
export function claimable(record, nowIso) {
  if (record.status === SESSION_STATUS.active) return true;
  const waiting = [
    SESSION_STATUS.ending,
    SESSION_STATUS.cleanupPending,
    SESSION_STATUS.provisioning,
    SESSION_STATUS.cleanupFailed,
  ].includes(record.status);
  return waiting && typeof record.retryAt === 'string' && record.retryAt <= nowIso;
}

/**
 * Take a session for clean-up, under the ETag it was read with, so that only
 * one request does the Coder calls: the winner gets `ending`, with a lease, a
 * count of tries and a longer `ttl`; the loser is refused with a 412.
 *
 * A claim drops the lab's address (`accessUrl`, #1403 item 6): only a running
 * session needs it, and a record that waits for its clean-up can wait a week.
 * A given-up record claimed for another round starts its count of tries again
 * and counts the round (`cleanupRounds`).
 *
 * Losing is not a failure. A stop and a sweep, or two stops, reach the same
 * session at once. The loser reads the record again: no longer claimable means
 * the winner has it (`taken-elsewhere`), gone means its `ttl` ran out
 * (`gone`); still claimable means something else changed it, and the claim is
 * tried again on the new version, up to FINISH_ATTEMPTS times, then `changed`.
 * Any other error is a real failure and is thrown.
 *
 * `replaceDocIfMatch(containerName, document, options)` takes the whole
 * document, `_etag` inside it, and the partition key in the options (#1383).
 *
 * @returns {Promise<{ outcome: 'claimed', session: object } | { outcome: 'taken-elsewhere', status: string } | { outcome: 'gone' | 'changed' }>}
 *   `status` is what the record that another request holds says now
 */
export async function claimSession(store, session, endStatus, nowMs) {
  const claimOf = ({ accessUrl: _address, ...record }) => {
    const newRound = record.status === SESSION_STATUS.cleanupFailed;
    return {
      ...record,
      status: SESSION_STATUS.ending,
      // Only the two final statuses a session can have; a record that says anything else gets the one asked for.
      endStatus: [SESSION_STATUS.ended, SESSION_STATUS.expired].includes(record.endStatus) ? record.endStatus : endStatus,
      endedAt: record.endedAt ?? new Date(nowMs).toISOString(),
      // A count: a negative or fractional one would never reach the bound.
      cleanupAttempts: newRound ? 1 : countOf(record.cleanupAttempts) + 1,
      ...(newRound ? { cleanupRounds: countOf(record.cleanupRounds) + 1 } : {}),
      retryAt: new Date(nowMs + CLEANUP_LEASE_MS).toISOString(),
      ttl: VISITOR_PENDING_DOC_TTL_SECONDS,
    };
  };

  if (typeof store.replaceDocIfMatch !== 'function') {
    // A store without conditional writes, which the Functions app never has
    // (labs-public-http.js hands it cosmos-client.js's): unconditional, so no
    // protection against a second request. One that cannot save at all must
    // not report that it did.
    if (typeof store.upsertDoc !== 'function') {
      throw new TypeError('The store given to the visitor sessions cannot save a session record.');
    }
    const claimed = claimOf(session);
    await store.upsertDoc(SESSION_CONTAINER, claimed);
    return { outcome: 'claimed', session: claimed };
  }

  const nowIso = new Date(nowMs).toISOString();
  let current = session;
  for (let attempt = 0; attempt < FINISH_ATTEMPTS; attempt += 1) {
    try {
      const claimed = claimOf(current);
      const saved = await store.replaceDocIfMatch(SESSION_CONTAINER, claimed, {
        partitionKey: current.id,
      });
      return { outcome: 'claimed', session: saved ?? claimed };
    } catch (error) {
      if (!lostRace(error)) throw error;
    }
    current = await store.readDoc(SESSION_CONTAINER, session.id, session.id);
    if (!current) return { outcome: 'gone' };
    if (!claimable(current, nowIso)) return { outcome: 'taken-elsewhere', status: current.status };
  }
  return { outcome: 'changed' };
}

/**
 * Ask Coder to delete the session's workspace, then its user, skipping a half
 * an earlier try already got confirmed, and say what it got. The user delete
 * is attempted straight after an accepted workspace delete (it is sometimes
 * quick enough) but not after a refused one, which it cannot succeed after.
 *
 * Nothing to delete counts as done (a record with no workspace or no user). A
 * session that has something to delete cannot be cleaned without the broker
 * configuration, so it is not done, and is tried again when there is one.
 *
 * A record with the visitor's Coder user name and no user id is a start whose
 * user create gave no answer, or whose process died (#1403, item 2). The user
 * is looked up by that name first. Coder having no such user means nothing was
 * made at all (the workspace is asked for only after the user exists, and
 * Coder cannot keep a workspace without its owner), so both halves are done.
 *
 * A record with no workspace id but with the visitor's Coder user and a
 * workspace name is a start that failed after the user was made (its workspace
 * call timed out or was refused). Coder may still have made the workspace, so
 * it is looked up by owner and name before it is taken as gone. A workspace
 * the lookup does not find counts as gone for this try only (`workspaceGone`
 * is not saved): the user delete, which Coder refuses while the user has a
 * workspace, is the confirmation, and a workspace that turns up later is found
 * by the next try's lookup.
 *
 * The user is read back by its id before it is deleted (#1403), unless the
 * name lookup above has just read it: the delete is sent only when Coder's
 * answer is that id and a visitor's name (`v-` and twelve hex characters).
 * Coder having no such user is `gone`, as a delete that found nothing is, and
 * is said in the log the same way. Any other answer leaves the user for the
 * next try (`user lookup mismatch`, `user lookup HTTP 500`, and so on).
 *
 * @returns {Promise<{ workspaceGone: boolean, workspaceGoneSaved: boolean, workspaceId: string | undefined, coderUserId: string | undefined, userGone: boolean, workspace: string, user: string, workspaceBy?: string, userBy?: string }>}
 *   the two halves; `workspaceGoneSaved` is whether `workspaceGone` may be
 *   written to the record; `workspaceId` and `coderUserId` are the ones the
 *   record had or a lookup found; `workspaceBy` and `userBy` say what
 *   confirmed a half on this try (`ok`, `gone`, `not found`); and for each half
 *   a short safe word for the log (`ok`, `gone`, `found`, `not found`,
 *   `HTTP 417`, `lookup mismatch`, `timeout`, `network`, `skipped`,
 *   `unconfigured`, `done`, `none`)
 */
export async function cleanUpCoder(fetchImpl, config, session) {
  const needsLookup =
    !session.workspaceGone &&
    !session.workspaceId &&
    Boolean(session.workspaceName) &&
    Boolean(session.coderUsername);
  const nothingToDelete = !session.workspaceId && !needsLookup;
  const result = {
    workspaceGone: Boolean(session.workspaceGone) || nothingToDelete,
    workspaceGoneSaved: Boolean(session.workspaceGone) || nothingToDelete,
    workspaceId: session.workspaceId,
    coderUserId: session.coderUserId,
    userGone: Boolean(session.userGone) || (!session.coderUserId && !session.coderUsername),
    workspace: session.workspaceGone ? 'done' : 'none',
    user: session.userGone ? 'done' : 'none',
  };

  // Whether this try has already read the user back from Coder, so the read
  // before the delete below is not made twice.
  let userSeen = false;

  // Only the user's name is known: find its id, or learn that it was never made.
  if (!result.userGone && !result.coderUserId) {
    if (!config) {
      return { ...result, user: 'unconfigured', workspace: result.workspaceGone ? result.workspace : 'skipped' };
    }
    const found = await lookUpUserCall(fetchImpl, config, { username: session.coderUsername });
    if (found.missing) {
      return {
        ...result,
        workspaceGone: true,
        workspaceGoneSaved: true,
        userGone: true,
        workspace: 'none',
        user: found.kind,
        workspaceBy: 'no user',
        userBy: 'not found',
      };
    }
    if (!found.id) {
      return { ...result, user: found.kind, workspace: result.workspaceGone ? result.workspace : 'skipped' };
    }
    result.coderUserId = found.id;
    userSeen = true;
  }

  if (needsLookup) {
    if (!config) {
      result.workspace = 'unconfigured';
    } else {
      const found = await lookUpWorkspaceCall(fetchImpl, config, { ...session, coderUserId: result.coderUserId });
      result.workspace = found.kind;
      if (found.id) result.workspaceId = found.id;
      if (found.missing) {
        result.workspaceGone = true;
        result.workspaceBy = 'not found';
      }
    }
  }
  if (!result.workspaceGone && result.workspaceId) {
    if (!config) {
      result.workspace = 'unconfigured';
    } else {
      const call = await deleteWorkspaceCall(fetchImpl, config, result.workspaceId);
      result.workspaceGone = call.confirmed;
      result.workspaceGoneSaved = call.confirmed;
      result.workspace = call.kind;
      if (call.confirmed) result.workspaceBy = call.kind;
    }
  }
  if (!result.userGone) {
    if (!config) {
      result.user = 'unconfigured';
    } else if (!result.workspaceGone) {
      result.user = 'skipped';
    } else {
      // Read the user back by its id before it is deleted (#1403): only an
      // answer that is this id and a visitor's name is deleted. Coder having
      // no such user is the same as a delete that found nothing (`gone`).
      if (!userSeen && isCoderId(result.coderUserId)) {
        const seen = await lookUpUserCall(fetchImpl, config, { id: result.coderUserId });
        if (seen.missing) {
          return { ...result, userGone: true, user: 'gone', userBy: 'gone' };
        }
        if (!seen.id) return { ...result, user: seen.kind };
      }
      const call = await deleteUserCall(fetchImpl, config, result.coderUserId);
      result.userGone = call.confirmed;
      result.user = call.kind;
      if (call.confirmed) result.userBy = call.kind;
    }
  }
  return result;
}

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
  const attempts = claimed.cleanupAttempts;
  const finished = steps.workspaceGone && steps.userGone && (!owed || refunded);
  const givenUp = !finished && attempts >= MAX_CLEANUP_ATTEMPTS;
  const nowIso = new Date(nowMs).toISOString();

  // Coder refusing the user (417) after an earlier try saved the workspace as
  // gone: after a few of those in a row, ask for the workspace delete again,
  // since the delete build Coder accepted may have failed (#1403, item 3).
  const refusedUser = steps.user === 'HTTP 417';
  const refusals = refusedUser ? countOf(claimed.userRefusals) + 1 : 0;
  const askWorkspaceAgain =
    !finished &&
    refusals >= USER_REFUSALS_BEFORE_WORKSPACE_RETRY &&
    Boolean(claimed.workspaceGone) &&
    Boolean(steps.workspaceId);

  const { retryAt: _lease, ...rest } = claimed;
  // Ids a lookup found are kept, so a later try deletes them without looking again.
  const found = {
    ...(steps.workspaceId ? { workspaceId: steps.workspaceId } : {}),
    ...(steps.coderUserId ? { coderUserId: steps.coderUserId } : {}),
  };
  // What confirmed each half, once it is confirmed for good (#1403, item 4).
  const confirmedBy = (savedHalf) => ({
    ...(steps.workspaceBy && (finished || savedHalf) ? { workspaceConfirmedBy: steps.workspaceBy } : {}),
    ...(steps.userBy ? { userConfirmedBy: steps.userBy } : {}),
  });
  const waitingHalves = askWorkspaceAgain
    ? { workspaceGone: false, userGone: steps.userGone, userRefusals: 0 }
    : { workspaceGone: steps.workspaceGoneSaved, userGone: steps.userGone, userRefusals: refusals };
  const rounds = countOf(claimed.cleanupRounds);
  const lastRound = rounds >= MAX_CLEANUP_ROUNDS;

  let next;
  if (finished) {
    next = {
      ...rest,
      ...found,
      ...confirmedBy(true),
      status: claimed.endStatus,
      workspaceGone: true,
      userGone: true,
      ttl: VISITOR_DOC_TTL_SECONDS,
    };
  } else if (givenUp) {
    next = {
      ...rest,
      ...found,
      ...confirmedBy(steps.workspaceGoneSaved && !askWorkspaceAgain),
      status: SESSION_STATUS.cleanupFailed,
      ...waitingHalves,
      cleanupAt: nowIso,
      ...(lastRound ? {} : { retryAt: new Date(nowMs + CLEANUP_REARM_MS).toISOString() }),
      ttl: VISITOR_FAILED_DOC_TTL_SECONDS,
    };
  } else {
    next = {
      ...rest,
      ...found,
      ...confirmedBy(steps.workspaceGoneSaved && !askWorkspaceAgain),
      status: SESSION_STATUS.cleanupPending,
      ...waitingHalves,
      cleanupAt: nowIso,
      retryAt: new Date(nowMs + CLEANUP_RETRY_BASE_MS * attempts).toISOString(),
      ttl: VISITOR_PENDING_DOC_TTL_SECONDS,
    };
  }
  if (askWorkspaceAgain) delete next.workspaceConfirmedBy;
  if (refunded) next.dailyCapRefund = DAILY_CAP_REFUND.given;

  if (typeof store.replaceDocIfMatch === 'function') {
    try {
      await store.replaceDocIfMatch(SESSION_CONTAINER, next, { partitionKey: next.id });
    } catch (error) {
      if (!lostRace(error)) throw error;
      // The record changed while Coder was being called (the lease ran out and
      // another request took it over, or it aged out). That request owns it now.
      const current = await Promise.resolve(store.readDoc?.(SESSION_CONTAINER, next.id, next.id)).catch(() => null);
      return current ? { outcome: 'taken-elsewhere', status: current.status } : { outcome: 'gone' };
    }
  } else {
    await store.upsertDoc(SESSION_CONTAINER, next);
  }

  // A session that no longer holds a lab lets its slot go (#1464 review, finding A).
  if (!mayHoldLab(next)) await releaseSlot(store, next, nowMs);

  const where = `workspace ${steps.workspace}, user ${steps.user}${owed && !refunded ? ', daily start not yet given back' : ''}`;
  if (finished) {
    // A 404 or 410 is also how Coder may answer a token that may not see the
    // thing, so a clean-up confirmed that way is said in the log (#1403, item 4).
    if (steps.workspaceBy === 'gone' || steps.userBy === 'gone') {
      log?.(`visitor-session: a session's Coder clean-up was taken as done on a 404 or 410 (${where})`);
    }
    return { outcome: 'done' };
  }
  const again = askWorkspaceAgain ? '; the workspace delete will be asked for again' : '';
  if (givenUp) {
    log?.(
      lastRound
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
