/**
 * mcp-oauth-refresh-store.js — how a refreshed MCP OAuth token is kept
 * (mcp-oauth.js performRefresh): the conditional writes that store it or mark
 * a dead connection, and the checks that tell a stale refresh from a newer
 * connection another instance stored.
 */
import { GRANT_REJECTIONS, MCP_CONTAINER, McpOAuthError } from './mcp-oauth-base.js';
import { notConnectedMessage } from './mcp-oauth-tokens.js';

export function isGrantRejection(error) {
  return (
    error instanceof McpOAuthError &&
    (GRANT_REJECTIONS.has(error.oauthError) || [400, 401].includes(error.upstreamStatus))
  );
}

const isPreconditionFailure = (error) => error?.code === 412 || error?.statusCode === 412;

/**
 * Whether `latest` is at the same place as `server`, with the same sign-in
 * method, and still connected to the same resource: what both checks below
 * start from.
 */
function connectedToSameResource(latest, server) {
  return (
    Boolean(latest) &&
    sameAddressAndMethod(latest, server) &&
    latest.oauth?.status === 'connected' &&
    latest.oauth?.resource === server?.oauth?.resource
  );
}

/** The same URL and the same sign-in method. */
const sameAddressAndMethod = (latest, server) =>
  latest.url === server?.url && latest.authType === server?.authType;

/**
 * Whether `latest` is still the connection `server` was refreshing: the same
 * place, the same sign-in method, still connected, with the same refresh
 * token. A write between the two that left all of that alone (a rename, a
 * status line) does not make the refresh stale; anything else does.
 */
function sameConnection(latest, server) {
  return connectedToSameResource(latest, server) && latest.oauthRefreshToken === server?.oauthRefreshToken;
}

/**
 * Whether `latest` holds a newer connection to the same resource than the
 * one `server` was refreshing: another instance refreshed (the refresh token
 * rotated) or the owner pressed Connect again. Its tokens are as good as a
 * refresh's, so they are used instead of clearing or overwriting them.
 */
function newerConnection(latest, server) {
  return (
    connectedToSameResource(latest, server) &&
    Boolean(latest.oauthToken) &&
    Boolean(latest.oauthRefreshToken) &&
    latest.oauthRefreshToken !== server?.oauthRefreshToken
  );
}

const readServer = (store, serverId) => store.readDoc(MCP_CONTAINER, serverId, serverId);

/**
 * Clear a dead connection, guarded by the ETag of the document the decision
 * was made from (review of #1019). Unguarded, an instance whose refresh was
 * refused could clear the rotated token another instance had just stored.
 * On a conflict the document is read again, and a newer connection there is
 * the answer; otherwise the refusal stands and the next call decides again.
 */
export async function markDisconnected({ store, serverId, server, now, sentence }) {
  const at = now().toISOString();
  const updates = {
    oauthToken: null,
    oauthRefreshToken: null,
    oauth: { ...(server.oauth || {}), status: 'disconnected', disconnectedAt: at, disconnectReason: 'refresh_failed' },
    status: 'needs_connection',
    lastError: sentence,
    lastTested: at,
  };
  try {
    await store.patchDoc(MCP_CONTAINER, serverId, updates, server._etag ? { ifMatch: server._etag } : {});
  } catch (error) {
    if (isPreconditionFailure(error)) {
      const latest = await readServer(store, serverId).catch(() => null);
      if (newerConnection(latest, server)) return { ok: true, server: latest };
    }
    // Otherwise the refusal is the useful result; a failed status write must not mask it.
  }
  return { ok: false, disconnected: true, sentence };
}

/**
 * Store a refreshed token, guarded by the ETag of the document the refresh
 * started from (review of #1019). A Disconnect, a URL move or a change of
 * sign-in method that landed while the refresh was in flight is not undone:
 * the conflict is read, and the refresh's tokens are kept only while the
 * document is still the same connection (a rename, say, retries the write);
 * a newer connection is used as it stands; anything else discards them, so
 * a token issued for the old resource is never sent to a new URL.
 */
export async function storeRefreshed({ store, serverId, server, updates, name }) {
  let current = server._etag ? server : await readServer(store, serverId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!sameConnection(current, server)) break;
    // A document without an ETag cannot be written safely, so it is not;
    // the stored token is used until the next try. Cosmos always sends one.
    if (!current._etag) {
      return { ok: false, transient: true, sentence: `${name}'s renewed sign-in could not be stored safely; the next call tries again.` };
    }
    try {
      const written = await store.patchDoc(MCP_CONTAINER, serverId, updates, { ifMatch: current._etag });
      return { ok: true, server: { ...current, ...updates, ...(written?._etag ? { _etag: written._etag } : {}) } };
    } catch (error) {
      if (!isPreconditionFailure(error)) throw error;
      current = await readServer(store, serverId);
    }
  }
  if (newerConnection(current, server)) return { ok: true, server: current };
  // `disconnected` as well: to a caller, the connection it was using is gone
  // and the call must not go ahead on the old token.
  return {
    ok: false,
    disconnected: true,
    changed: true,
    sentence: `${name} changed while its sign-in was being renewed, so the renewal was not kept. ${notConnectedMessage(current, serverId)}`,
  };
}

/**
 * What a refresh the sign-in server refused leaves: a newer connection
 * another instance stored, the answer that the server changed meanwhile, or
 * the server marked disconnected.
 */
export async function afterRefusedRefresh({ store, serverId, server, now, log, sentence }) {
  // Refresh tokens rotate: another instance may have spent this one a
  // moment ago and stored the next. Its result is as good as ours. The
  // disconnect below is guarded by the ETag of this read, so a rotation
  // stored after it is not cleared either (review of #1019).
  const latest = await readServer(store, serverId).catch(() => null);
  if (newerConnection(latest, server)) return { ok: true, server: latest };
  // Moved, switched or disconnected meanwhile: nothing of this connection
  // is left to clear, and writing would put a stale status on the new one.
  if (latest && !sameConnection(latest, server)) {
    return { ok: false, disconnected: true, sentence: notConnectedMessage(latest, serverId) };
  }
  log?.warn?.('[mcp-oauth] a token refresh was refused; marking the server disconnected');
  return markDisconnected({ store, serverId, server: latest || server, now, sentence });
}
