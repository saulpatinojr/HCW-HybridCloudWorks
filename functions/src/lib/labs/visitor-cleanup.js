/**
 * labs/visitor-cleanup.js — the Coder half of ending a visitor session
 * (visitor-end.js has the rest; visitor-session.js has the header that
 * explains the sessions): delete the workspace, then the user, each looked
 * up or read back first where the record does not settle it.
 */
import { isCoderId } from './visitor-model.js';
import { deleteUserCall, deleteWorkspaceCall, lookUpUserCall, lookUpWorkspaceCall } from './visitor-coder.js';

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
  const result = startingHalves(session, needsLookup);

  // Whether this try has already read the user back from Coder, so the read
  // before the delete below is not made twice.
  let userSeen = false;

  // Only the user's name is known: find its id, or learn that it was never made.
  if (!result.userGone && !result.coderUserId) {
    const named = await userByName(fetchImpl, config, session, result);
    if (named.answer) return named.answer;
    result.coderUserId = named.id;
    userSeen = true;
  }

  if (needsLookup) await lookUpWorkspaceHalf(fetchImpl, config, session, result);
  if (!result.workspaceGone && result.workspaceId) await deleteWorkspaceHalf(fetchImpl, config, result);
  return result.userGone ? result : deleteUserHalf(fetchImpl, config, result, userSeen);
}

/** What the record already says about each half, before Coder is asked anything. */
function startingHalves(session, needsLookup) {
  const nothingToDelete = !session.workspaceId && !needsLookup;
  return {
    workspaceGone: Boolean(session.workspaceGone) || nothingToDelete,
    workspaceGoneSaved: Boolean(session.workspaceGone) || nothingToDelete,
    workspaceId: session.workspaceId,
    coderUserId: session.coderUserId,
    userGone: Boolean(session.userGone) || (!session.coderUserId && !session.coderUsername),
    workspace: session.workspaceGone ? 'done' : 'none',
    user: session.userGone ? 'done' : 'none',
  };
}

/**
 * The user's id, found by the name the broker chose: `{ id }`, or
 * `{ answer }`, this try's result, when there is no id to go on (no
 * configuration, a lookup that failed, or no such user, which means
 * nothing was made at all).
 */
async function userByName(fetchImpl, config, session, result) {
  const notThisTry = (user) => ({ ...result, user, workspace: result.workspaceGone ? result.workspace : 'skipped' });
  if (!config) return { answer: notThisTry('unconfigured') };
  const found = await lookUpUserCall(fetchImpl, config, { username: session.coderUsername });
  if (found.missing) {
    return {
      answer: {
        ...result,
        workspaceGone: true,
        workspaceGoneSaved: true,
        userGone: true,
        workspace: 'none',
        user: found.kind,
        workspaceBy: 'no user',
        userBy: 'not found',
      },
    };
  }
  return found.id ? { id: found.id } : { answer: notThisTry(found.kind) };
}

/** Look the workspace up by owner and name; one Coder does not have counts as gone for this try. */
async function lookUpWorkspaceHalf(fetchImpl, config, session, result) {
  if (!config) {
    result.workspace = 'unconfigured';
    return;
  }
  const found = await lookUpWorkspaceCall(fetchImpl, config, { ...session, coderUserId: result.coderUserId });
  result.workspace = found.kind;
  if (found.id) result.workspaceId = found.id;
  if (found.missing) {
    result.workspaceGone = true;
    result.workspaceBy = 'not found';
  }
}

/** Ask Coder to delete the workspace, and note what it said. */
async function deleteWorkspaceHalf(fetchImpl, config, result) {
  if (!config) {
    result.workspace = 'unconfigured';
    return;
  }
  const call = await deleteWorkspaceCall(fetchImpl, config, result.workspaceId);
  result.workspaceGone = call.confirmed;
  result.workspaceGoneSaved = call.confirmed;
  result.workspace = call.kind;
  if (call.confirmed) result.workspaceBy = call.kind;
}

/**
 * Delete the user once the workspace is gone. Read the user back by its id
 * before it is deleted (#1403): only an answer that is this id and a
 * visitor's name is deleted. Coder having no such user is the same as a
 * delete that found nothing (`gone`).
 */
async function deleteUserHalf(fetchImpl, config, result, userSeen) {
  if (!config) return { ...result, user: 'unconfigured' };
  if (!result.workspaceGone) return { ...result, user: 'skipped' };
  if (!userSeen && isCoderId(result.coderUserId)) {
    const seen = await lookUpUserCall(fetchImpl, config, { id: result.coderUserId });
    if (seen.missing) return { ...result, userGone: true, user: 'gone', userBy: 'gone' };
    if (!seen.id) return { ...result, user: seen.kind };
  }
  const call = await deleteUserCall(fetchImpl, config, result.coderUserId);
  return { ...result, userGone: call.confirmed, user: call.kind, ...(call.confirmed ? { userBy: call.kind } : {}) };
}
