/**
 * labs/visitor-coder.js — the calls the visitor sessions make to Coder
 * (visitor-session.js has the header that explains them): make a visitor's
 * user and workspace, look them up, and delete them, each under a timeout
 * and with nothing Coder wrote carried into an error.
 */
import {
  CODER_CALL_TIMEOUT_MS,
  CODER_FETCH_OPTIONS,
  CODER_PROVISION_TIMEOUT_MS,
  isCoderId,
  isLabWorkspaceName,
  isVisitorUsername,
} from './visitor-model.js';

/**
 * A signal that aborts a Coder call after `config.timeoutMs` (default
 * CODER_CALL_TIMEOUT_MS for a delete, CODER_PROVISION_TIMEOUT_MS for the calls
 * that provision a session), so a Coder that hangs cannot hold a request open.
 * None of the Coder calls had one before (#1388).
 */
export const coderTimeout = (config, fallbackMs = CODER_CALL_TIMEOUT_MS) =>
  AbortSignal.timeout(config?.timeoutMs ?? fallbackMs);

/** The options of one call to Coder: the caller's, no redirect, and the timeout. */
export const coderInit = (config, init, fallbackMs = CODER_CALL_TIMEOUT_MS) => ({
  ...init,
  ...CODER_FETCH_OPTIONS,
  signal: coderTimeout(config, fallbackMs),
});

/**
 * The error a provisioning call throws when Coder refuses it: the step and the
 * HTTP status, and nothing Coder wrote in its answer (#1403, item 9). Coder's
 * text can name users, templates or its own settings, and this message reaches
 * a log line. `statusCode` lets `errorKind` report the status on its own.
 */
export function coderRefusal(what, status) {
  const shown = Number.isInteger(status) ? `HTTP ${status}` : 'a refusal';
  return Object.assign(new Error(`${what}: ${shown}`), Number.isInteger(status) ? { statusCode: status } : {});
}

export async function createVisitorCoderUser(fetchImpl, config, { username, email, password }) {
  const res = await fetchImpl(
    `${config.base}/api/v2/users`,
    coderInit(
      config,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Coder-Session-Token': config.token,
        },
        body: JSON.stringify({
          username,
          email,
          name: username,
          password,
          user_login_type: 'password',
        }),
      },
      CODER_PROVISION_TIMEOUT_MS
    )
  );
  if (!res.ok) {
    await releaseBody(res);
    throw coderRefusal('Failed to create Coder user', res.status);
  }
  return res.json();
}

export async function getTemplateByName(fetchImpl, config, templateName = 'hcw-lab') {
  const res = await fetchImpl(
    `${config.base}/api/v2/templates`,
    coderInit(
      config,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'Coder-Session-Token': config.token,
        },
      },
      CODER_PROVISION_TIMEOUT_MS
    )
  );
  if (!res.ok) {
    await releaseBody(res);
    throw coderRefusal('Failed to list Coder templates', res.status);
  }
  const templates = await res.json();
  const matched = Array.isArray(templates) ? templates.find((t) => t.name === templateName) : null;
  if (!matched) {
    throw new Error(`Coder template '${templateName}' not found`);
  }
  return matched;
}

export async function createVisitorWorkspace(
  fetchImpl,
  config,
  { userId, username, workspaceName, labId, templateName = 'hcw-lab' }
) {
  const template = await getTemplateByName(fetchImpl, config, templateName);
  const orgRes = await fetchImpl(
    `${config.base}/api/v2/organizations`,
    coderInit(
      config,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'Coder-Session-Token': config.token,
        },
      },
      CODER_PROVISION_TIMEOUT_MS
    )
  );
  if (!orgRes.ok) {
    await releaseBody(orgRes);
    throw coderRefusal('Failed to list Coder organizations', orgRes.status);
  }
  const orgs = await orgRes.json();
  const defaultOrg = Array.isArray(orgs) && orgs.length > 0 ? orgs[0] : null;
  if (!defaultOrg) {
    throw new Error('No default Coder organization found');
  }

  const res = await fetchImpl(
    `${config.base}/api/v2/organizations/${encodeURIComponent(defaultOrg.id)}/members/${encodeURIComponent(userId)}/workspaces`,
    coderInit(
      config,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Coder-Session-Token': config.token,
        },
        body: JSON.stringify({
          template_id: template.id,
          name: workspaceName,
          autostart: true,
        }),
      },
      CODER_PROVISION_TIMEOUT_MS
    )
  );
  if (!res.ok) {
    await releaseBody(res);
    throw coderRefusal('Failed to create visitor workspace', res.status);
  }
  const workspace = await res.json();
  const accessUrl = `https://code-server--${workspaceName}--${username}.coder.lab.hybridcloudworks.com/?folder=/tmp/home/lab`;
  return { workspace, accessUrl };
}

/**
 * Ask Coder to delete a workspace. True when Coder accepted it or the
 * workspace is already gone (404 or 410); false for anything else, a timeout
 * included. The sessions use the same call through `cleanUpCoder`, which also
 * keeps the reason for its log line.
 */
export async function deleteVisitorWorkspace(fetchImpl, config, workspaceId) {
  return (await deleteWorkspaceCall(fetchImpl, config, workspaceId)).confirmed;
}

/** Ask Coder to delete a user: true when accepted or already gone, false otherwise. */
export async function deleteVisitorUser(fetchImpl, config, userId) {
  return (await deleteUserCall(fetchImpl, config, userId)).confirmed;
}



/*
 * What a stored id or name must look like before it is written into a Coder
 * URL path (`isCoderId`, `isVisitorUsername`, `isLabWorkspaceName` above).
 * These values come from Coder's own answers, or from the broker's own
 * choices, and are saved in the session record, which no visitor writes; the
 * unattended sweep still carries an administrator-grade token, so it sends
 * nothing that is not plainly what the record says it is. Until #1403's
 * follow-up the rule was looser (any one path segment that was not `.`,
 * `..` or `me`), so a stored value that was another valid name, another
 * person's for example, would still have been sent.
 */

/** Let go of an answer's body without reading it; a failure to is no failure of the call. */
export async function releaseBody(res) {
  try {
    await res.body?.cancel();
  } catch {
    // The status is already read.
  }
}

/**
 * One delete call to Coder, with a timeout. `confirmed` is true when Coder
 * accepted it, or answered 404 or 410 (the thing is already gone: a delete
 * that finds nothing to delete has done its job). `kind` says what happened
 * in a few safe words for a log line: `ok`, `gone`, `HTTP 417`, `timeout`,
 * `network`. Never the response text and never an id.
 */
export async function coderDelete(fetchImpl, config, url, init) {
  try {
    const res = await fetchImpl(url, coderInit(config, init));
    // Only the status matters; let go of the body so the connection is not held for it.
    await releaseBody(res);
    if (res.ok) return { confirmed: true, kind: 'ok' };
    if (res.status === 404 || res.status === 410) return { confirmed: true, kind: 'gone' };
    return { confirmed: false, kind: Number.isInteger(res.status) ? `HTTP ${res.status}` : 'refused' };
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return { confirmed: false, kind: timedOut ? 'timeout' : 'network' };
  }
}

export const INVALID_ID = Object.freeze({ confirmed: false, kind: 'invalid id' });

export const deleteWorkspaceCall = (fetchImpl, config, workspaceId) =>
  !isCoderId(workspaceId)
    ? Promise.resolve(INVALID_ID)
    : coderDelete(fetchImpl, config, `${config.base}/api/v2/workspaces/${encodeURIComponent(workspaceId)}/builds`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Coder-Session-Token': config.token,
        },
        body: JSON.stringify({ transition: 'delete' }),
      });

export const deleteUserCall = (fetchImpl, config, userId) =>
  !isCoderId(userId)
    ? Promise.resolve(INVALID_ID)
    : coderDelete(fetchImpl, config, `${config.base}/api/v2/users/${encodeURIComponent(userId)}`, {
        method: 'DELETE',
        headers: {
          Accept: 'application/json',
          'Coder-Session-Token': config.token,
        },
      });

/** Both names the lookup writes into its path are the broker's own: a visitor's user name and a lab's workspace name. */
export const hasSafeLookupNames = (session) =>
  isVisitorUsername(session.coderUsername) && isLabWorkspaceName(session.workspaceName);

/**
 * Look a visitor's workspace up by its owner's name and its own name, for a
 * record that has no workspace id: a start whose workspace call gave no answer
 * (it timed out, say) after Coder may have gone on and made the workspace, so
 * nothing tells us its id. Coder's API: `GET /api/v2/users/{user}/workspace/{workspacename}`
 * answers the workspace, or 404 when there is none (a deleted one too, unless
 * `include_deleted` is asked for, which it is not).
 * https://coder.com/docs/reference/api/workspaces (read 2026-10-26)
 *
 * It answers one of:
 *  - `{ id, kind: 'found' }`: the workspace, and only when it is the visitor's
 *    own: its name is the one this record was made for and its owner is the
 *    Coder user this record made. Anything else is `lookup mismatch` and is
 *    never deleted.
 *  - `{ missing: true, kind: 'not found' }`: Coder has no such workspace.
 *  - `{ kind }`: Coder did not say (`lookup HTTP 500`, `lookup timeout`,
 *    `lookup network`, `lookup mismatch`). Never an id or any of Coder's text.
 */
export async function lookUpWorkspaceCall(fetchImpl, config, session) {
  if (!hasSafeLookupNames(session)) return { kind: 'lookup invalid name' };
  const url =
    `${config.base}/api/v2/users/${encodeURIComponent(session.coderUsername)}` +
    `/workspace/${encodeURIComponent(session.workspaceName)}`;
  try {
    const res = await fetchImpl(
      url,
      coderInit(config, {
        method: 'GET',
        headers: { Accept: 'application/json', 'Coder-Session-Token': config.token },
      })
    );
    if (res.status === 404 || res.status === 410) {
      await releaseBody(res);
      return { missing: true, kind: 'not found' };
    }
    if (!res.ok) {
      await releaseBody(res);
      return { kind: Number.isInteger(res.status) ? `lookup HTTP ${res.status}` : 'lookup refused' };
    }
    const workspace = await res.json();
    const ours =
      isCoderId(workspace?.id) &&
      workspace.name === session.workspaceName &&
      workspace.owner_id === session.coderUserId;
    return ours ? { id: workspace.id, kind: 'found' } : { kind: 'lookup mismatch' };
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return { kind: timedOut ? 'lookup timeout' : 'lookup network' };
  }
}

/**
 * Read a visitor's Coder user back, by its id or by the name the broker chose
 * for it. Coder's API takes either where it takes a user: `GET
 * /api/v2/users/{user}`, "User ID, username, or me".
 * https://coder.com/docs/reference/api/users (read 2026-10-31 and 2026-11-03)
 *
 * Two callers:
 *  - A record that has the name and no id: a start whose user create gave no
 *    answer (it timed out, say), or whose process died before it saved the
 *    id (#1403, item 2). The name finds the id.
 *  - A record about to have its user deleted (#1403, the GET before the
 *    delete): the id is read back first, and the delete is sent only when
 *    Coder's answer is that id and a visitor's name. A stored id that is
 *    another person's, or a token that may not see the user, is caught here,
 *    before anything is deleted.
 *
 * Only an id that is plainly an id, or a name of the broker's own shape
 * (`v-` and twelve hex characters), is sent, so a stored value that is
 * another person's name, or `me`, never is. It answers one of:
 *  - `{ id, kind: 'user found' }`: the user, and only when Coder's answer
 *    carries an id that is plainly an id, a name of the broker's shape, and
 *    the same id or name as was asked for.
 *  - `{ missing: true, kind: 'user not found' }`: Coder has no such user.
 *  - `{ kind }`: Coder did not say (`user lookup HTTP 500`, `user lookup
 *    timeout`, `user lookup network`, `user lookup mismatch`, `user lookup
 *    invalid name`). Never an id or any of Coder's text.
 */
export async function lookUpUserCall(fetchImpl, config, { id = undefined, username = undefined }) {
  const byId = isCoderId(id);
  if (!byId && !isVisitorUsername(username)) return { kind: 'user lookup invalid name' };
  try {
    const res = await fetchImpl(
      `${config.base}/api/v2/users/${encodeURIComponent(byId ? id : username)}`,
      coderInit(config, {
        method: 'GET',
        headers: { Accept: 'application/json', 'Coder-Session-Token': config.token },
      })
    );
    if (res.status === 404 || res.status === 410) {
      await releaseBody(res);
      return { missing: true, kind: 'user not found' };
    }
    if (!res.ok) {
      await releaseBody(res);
      return { kind: Number.isInteger(res.status) ? `user lookup HTTP ${res.status}` : 'user lookup refused' };
    }
    const user = await res.json();
    const ours =
      isCoderId(user?.id) && isVisitorUsername(user.username) && (byId ? user.id === id : user.username === username);
    return ours ? { id: user.id, kind: 'user found' } : { kind: 'user lookup mismatch' };
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return { kind: timedOut ? 'user lookup timeout' : 'user lookup network' };
  }
}
