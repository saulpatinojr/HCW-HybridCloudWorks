/**
 * labs/visitor-start-note.js — what a start that failed after its record was
 * written leaves for the sweep (visitor-session.js has the header that
 * explains the sessions).
 */

import { CLEANUP_RETRY_BASE_MS, isCoderId, mayHoldLab, SESSION_STATUS, VISITOR_DOC_TTL_SECONDS, VISITOR_PENDING_DOC_TTL_SECONDS } from './visitor-model.js';
import { releaseSlot } from './visitor-slots.js';
import { DAILY_CAP_REFUND, recordRefund, refundOwed } from './visitor-refunds.js';
import { errorKind } from './visitor-session.js';

/**
 * Turn a start's `provisioning` record into a note for the sweep, when the
 * start failed after it was written: a `cleanup_pending` record carrying what
 * the sweep reads (the Coder user's name, its id when Coder gave one, the
 * workspace's name, and its id when Coder gave one) and the retry fields
 * (#1403, item 2). The first try waits CLEANUP_RETRY_BASE_MS so that a create
 * Coder is still finishing can finish. It drops `clientHash`: it was never
 * given to a visitor, so no stop request has to reach it, only the sweep. A
 * start that failed at the user (`noWorkspace`) never asked for a workspace,
 * so that half is saved as done: only the user is looked up, and the note
 * does not hold a lab slot while it waits. A user create that Coder refused
 * outright (`noUser`, a 4xx answer other than 408) made nothing at all, so
 * both halves are saved as done and nothing is looked up by name (#1464
 * review, finding F): a name Coder refused may be someone else's.
 *
 * Then the daily start is given back (`recordRefund`), and only once that is
 * written is the marker turned to `given`; a note with nothing left in Coder
 * is saved as over in the same write. When the refund or that write fails,
 * the note stays `cleanup_pending` with `dailyCapRefund: pending`, and the
 * sweep finishes it. It lets the slot go when the note holds no lab.
 *
 * `saveOver` is visitor-session.js's conditional write, passed in.
 *
 * Never throws: the visitor is being answered with a 502 whatever happens
 * here, and a store that is down must not turn that into something else. A
 * note that could not be written leaves the `provisioning` record, which the
 * sweep takes up once its lease has run out. The log says by kind what could
 * not be written, and nothing more.
 */
export async function noteUnfinishedStart(
  store,
  provisioning,
  { user, workspaceId, noWorkspace = false, noUser = false, nowMs, context, saveOver }
) {
  const nowIso = new Date(nowMs).toISOString();
  const { clientHash: _owner, ...record } = provisioning;
  const note = {
    ...record,
    status: SESSION_STATUS.cleanupPending,
    startFailed: true,
    ...(isCoderId(user?.id) ? { coderUserId: user.id } : {}),
    ...(typeof user?.username === 'string' && user.username ? { coderUsername: user.username } : {}),
    ...(isCoderId(workspaceId) ? { workspaceId } : {}),
    ...(noWorkspace || noUser ? { workspaceGone: true, workspaceConfirmedBy: 'never asked for' } : {}),
    ...(noUser ? { userGone: true, userConfirmedBy: 'refused at create' } : {}),
    endedAt: nowIso,
    cleanupAt: nowIso,
    retryAt: new Date(nowMs + CLEANUP_RETRY_BASE_MS).toISOString(),
    ttl: VISITOR_PENDING_DOC_TTL_SECONDS,
  };
  const log = (line) => context?.error?.(line);
  let saved;
  try {
    saved = (await saveOver(store, note)) ?? note;
  } catch (error) {
    log(`visitor-session: a failed start could not be noted for clean-up (${errorKind(error)})`);
    return;
  }
  if (!mayHoldLab(note)) await releaseSlot(store, note, nowMs);
  if (!refundOwed(saved) || !(await recordRefund(store, saved, nowMs, log))) return;
  const { retryAt: _next, ...settled } = saved;
  const over = noUser ? { status: SESSION_STATUS.ended, ttl: VISITOR_DOC_TTL_SECONDS } : {};
  try {
    await saveOver(store, noUser ? { ...settled, ...over, dailyCapRefund: DAILY_CAP_REFUND.given } : { ...saved, dailyCapRefund: DAILY_CAP_REFUND.given });
  } catch {
    // The refund is written; the sweep sees `pending`, finds the refund there (409) and finishes.
  }
}
