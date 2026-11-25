/**
 * mcp-oauth-handlers.js — the three admin routes of the MCP OAuth Connect
 * flow (2026-10-08); the protocol itself is mcp-oauth.js.
 *
 *   POST cms/mcp/{serverId}/oauth/start       → { ok, authorizationUrl }
 *   POST cms/mcp/oauth/complete  { state, code } → { ok, connected, serverId,
 *                                                  serverName, toolCount }
 *   POST cms/mcp/{serverId}/oauth/disconnect  → { ok, disconnected, revoked,
 *                                                  issuer, reason? }
 *
 * All three need `super_admin`. A Connect obtains a credential that every
 * editor's mcpProxy call to that server will then carry, which is the same
 * decision as seeding an integration key (admin-secrets.js) or moving where a
 * key is sent (config-collections.js, AP-B1) — both super_admin. Disconnect
 * sits with them so one role owns a server's connection end to end.
 *
 * The callback carries no server id: the state names the server, by the
 * SHA-256 of the state stored on exactly one document's `oauthPending`. The
 * state is refused when it is unknown, when another administrator started
 * it, when it is over ten minutes old, and on its second use — it is cleared
 * (ETag-guarded) before the code is exchanged, so a replay finds nothing.
 * The redirect's `iss` (RFC 9207), when sent, must name the issuer the
 * sign-in started with, and the server must still be at the resource the
 * token is for.
 *
 * Disconnect revokes the grant at the provider first (RFC 7009, #1116) when
 * the sign-in's metadata named a revocation endpoint, then deletes the tokens
 * here whatever the provider answered: `revoked` is true, false (with a
 * `reason` the card can show — the grant may still be live there) or null
 * (nowhere to revoke). A provider outage never keeps a token on this side.
 *
 * Errors use the MCP routes' shape, `{ ok: false, error, code? }`, with a
 * sentence an owner can act on.
 */
import { randomUUID } from 'node:crypto';
import { json } from '../http/admin-handler.js';
import { authoredMessage, errorCode, errorFacts } from '../http/error-response.js';
import { syncMcpServerTools } from './mcp.js';
import { usesOAuthConnect } from './mcp-policy.js';
import {
  McpOAuthError,
  connectedUpdates,
  createOAuthHttp,
  exchangeAuthorizationCode,
  revokeOAuthGrant,
  startOAuthConnect,
} from './mcp-oauth.js';
import {
  MCP_CONTAINER,
  fail,
  isPreconditionFailure,
  prepareCompletion,
  userIdOf,
} from './mcp-oauth-callback.js';

/** Why a server cannot use Connect, or null when it can. */
function connectRefusal(server, serverId) {
  if (usesOAuthConnect(server)) return null;
  const name = server?.name || serverId;
  if (serverId === 'plaud') {
    return 'Plaud connects from Recording Hub → Connect, not from this button; its sign-in is not the standard one.';
  }
  return `${name} does not sign in with OAuth. It reads its key from an app setting, or needs none.`;
}

/** The audit row for a connection change; best effort, like every audit writer here. */
async function auditConnection(ctx, context, { action, serverId, user, details }) {
  try {
    await ctx.store.upsertDoc('admin_audit_logs', {
      id: ctx.uuid(),
      action,
      userId: userIdOf(user),
      userName: user?.name || null,
      userEmail: user?.email || user?.preferred_username || null,
      timestamp: ctx.now().toISOString(),
      details: { collection: MCP_CONTAINER, documentId: serverId, ...details },
    });
  } catch (error) {
    context.warn?.(`${action} saved but the audit row failed: ${errorFacts(error)}`);
  }
}

/** The server named by the route, or the response refusing the request. */
async function loadRouteServer(ctx, request, context, label) {
  const serverId = String(request.params?.serverId || '').trim();
  if (!serverId) return { response: fail(400, 'serverId is required') };
  let server;
  try {
    server = await ctx.store.readDoc(MCP_CONTAINER, serverId, serverId);
  } catch (error) {
    context.error?.(`[${label}] configuration read failed:`, errorFacts(error));
    return { response: fail(500, 'Failed to read MCP server configuration') };
  }
  if (!server) return { response: fail(404, 'MCP server not found') };
  const refusal = connectRefusal(server, serverId);
  if (refusal) return { response: fail(400, refusal, 'NOT_OAUTH') };
  return { serverId, server };
}

/**
 * Everything a start needs before it talks to the provider: the role, the
 * server named by the route, and a user id to tie the sign-in to.
 * `{ serverId, server, userId }`, or `{ response }` refusing.
 */
async function openStart(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'super_admin');
  if (auth.error) return { response: auth.error };
  const loaded = await loadRouteServer(ctx, request, context, 'startMcpOAuth');
  if (loaded.response) return loaded;
  const userId = userIdOf(auth.user);
  if (!userId) return { response: fail(403, 'Your sign-in carries no user id, so a Connect cannot be tied to you.') };
  return { serverId: loaded.serverId, server: loaded.server, userId };
}

/** POST cms/mcp/{serverId}/oauth/start */
async function startMcpOAuth(ctx, request, context) {
  const opened = await openStart(ctx, request, context);
  if (opened.response) return opened.response;
  const { serverId, server, userId } = opened;

  try {
    const { authorizationUrl, updates } = await startOAuthConnect({
      server,
      serverId,
      userId,
      http: ctx.oauthHttp,
      now: ctx.now,
    });
    await ctx.store.patchDoc(MCP_CONTAINER, serverId, updates);
    return json(200, { ok: true, authorizationUrl });
  } catch (error) {
    if (error instanceof McpOAuthError) {
      context.warn?.(`[startMcpOAuth] the sign-in was not started (${errorCode(error)})`);
      return fail(error.status, authoredMessage(error, 'The sign-in was not started.'), error.code);
    }
    context.error?.(`[startMcpOAuth] failed (${errorCode(error)})`);
    return fail(500, `The sign-in for ${server.name || serverId} could not be started. Try Connect again.`);
  }
}

/** Write the connection under the spend's ETag: the refusal, or null once stored. */
async function storeConnection(ctx, context, { serverId, spent, updates, name }) {
  if (!spent?._etag) {
    context.error?.('[completeMcpOAuth] the spent document came back without an ETag; refusing to store the token');
    return fail(500, `${name} signed in, but the connection could not be saved. Press Connect again.`);
  }
  try {
    await ctx.store.patchDoc(MCP_CONTAINER, serverId, updates, { ifMatch: spent._etag });
    return null;
  } catch (error) {
    if (isPreconditionFailure(error)) {
      return fail(
        409,
        `${name} changed while the sign-in was in progress, so it was not accepted. Press Connect on its card to start again.`,
        'SERVER_CHANGED'
      );
    }
    context.error?.('[completeMcpOAuth] could not store the connection:', errorFacts(error));
    return fail(500, `${name} signed in, but the connection could not be saved. Press Connect again.`);
  }
}

/** After the connection is stored: the audit row, the first tool sync, and the answer. */
async function finishConnection(ctx, context, { server, serverId, name, pending, updates, user }) {
  await auditConnection(ctx, context, {
    action: 'mcp_oauth_connected',
    serverId,
    user,
    details: { issuer: pending.issuer, scope: updates.oauth.scope },
  });

  const sync = await syncMcpServerTools({
    store: ctx.store,
    serverId,
    server: { ...server, ...updates },
    env: ctx.env,
    fetch: ctx.fetch,
    now: ctx.now,
    log: ctx.log,
    timeoutMs: ctx.timeoutMs,
    oauthHttp: ctx.oauthHttp,
    context,
  });
  return json(200, {
    ok: true,
    connected: true,
    serverId,
    serverName: name,
    toolCount: sync.ok ? sync.tools.length : 0,
    ...(sync.ok ? {} : { syncError: sync.error }),
  });
}

/** POST cms/mcp/oauth/complete — { state, code } from the vendor's redirect. */
async function completeMcpOAuth(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'super_admin');
  if (auth.error) return auth.error;

  const prepared = await prepareCompletion(ctx, request, context, auth.user);
  if (prepared.response) return prepared.response;
  const { server, serverId, name, pending, spent, code } = prepared;

  let tokens;
  try {
    tokens = await exchangeAuthorizationCode({
      pending,
      code,
      clientSecret: server.oauthClientSecret ?? null,
      http: ctx.oauthHttp,
      now: ctx.now,
      name,
    });
  } catch (error) {
    // McpOAuthError is authored; anything else gets this module's sentence (#945).
    const message = `${authoredMessage(error, `The sign-in for ${name} could not be completed.`)} Press Connect on the ${name} card to try again.`;
    context.warn?.(`[completeMcpOAuth] the code exchange failed (${errorCode(error)})`);
    return fail(502, message, 'EXCHANGE_FAILED');
  }

  const updates = connectedUpdates({ pending, tokens, now: ctx.now });
  const notStored = await storeConnection(ctx, context, { serverId, spent, updates, name });
  if (notStored) return notStored;
  return finishConnection(ctx, context, { server, serverId, name, pending, updates, user: auth.user });
}

/** POST cms/mcp/{serverId}/oauth/disconnect */
async function disconnectMcpOAuth(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'super_admin');
  if (auth.error) return auth.error;
  const loaded = await loadRouteServer(ctx, request, context, 'disconnectMcpOAuth');
  if (loaded.response) return loaded.response;
  const { serverId, server } = loaded;

  // Revoke at the provider first, while the tokens are still here to send.
  // Its outcome is reported, never acted on: the delete below happens
  // either way, so a provider that is down cannot keep a token on this side.
  const revocation = await revokeOAuthGrant({ server, serverId, http: ctx.oauthHttp });
  if (revocation.revoked === false) {
    // Fixed text only: `reason` carries provider-controlled text and the
    // server id is a document id, and neither belongs in telemetry
    // (CodeRabbit on #1124). The response carries both for the card.
    context.warn?.(
      '[disconnectMcpOAuth] the grant was not revoked at its provider; the token is deleted here regardless.'
    );
  }

  try {
    // The registration (oauthClient and its secret) stays: it belongs to the
    // issuer and redirect URI, and the next Connect reuses it.
    await ctx.store.patchDoc(MCP_CONTAINER, serverId, {
      oauthToken: null,
      oauthRefreshToken: null,
      oauth: null,
      oauthPending: null,
      status: 'untested',
      lastError: null,
    });
  } catch (error) {
    context.error?.('[disconnectMcpOAuth] failed:', errorFacts(error));
    return fail(500, 'Failed to update MCP server configuration');
  }
  await auditConnection(ctx, context, {
    action: 'mcp_oauth_disconnected',
    serverId,
    user: auth.user,
    details: { issuer: revocation.issuer, revoked: revocation.revoked },
  });
  return json(200, {
    ok: true,
    disconnected: true,
    revoked: revocation.revoked,
    issuer: revocation.issuer,
    ...(revocation.reason ? { reason: revocation.reason } : {}),
  });
}

/**
 * @param {{ guard: object, store: { readDoc, patchDoc, queryDocs, upsertDoc },
 *   env?: object, fetch?: Function, now?: () => Date, log?: object,
 *   timeoutMs?: number, oauthHttp?: Function, uuid?: () => string }} deps
 */
export function createMcpOAuthHandlers({
  guard,
  store,
  env = process.env,
  fetch = globalThis.fetch,
  now = () => new Date(),
  log = console,
  timeoutMs,
  oauthHttp = createOAuthHttp(),
  uuid = randomUUID,
}) {
  const ctx = { guard, store, env, fetch, now, log, timeoutMs, oauthHttp, uuid };
  return {
    startMcpOAuth: (request, context) => startMcpOAuth(ctx, request, context),
    completeMcpOAuth: (request, context) => completeMcpOAuth(ctx, request, context),
    disconnectMcpOAuth: (request, context) => disconnectMcpOAuth(ctx, request, context),
  };
}
