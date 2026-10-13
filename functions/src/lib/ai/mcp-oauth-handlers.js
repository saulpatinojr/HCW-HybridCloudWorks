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
import { syncMcpServerTools } from './mcp.js';
import { usesOAuthConnect, validateMcpUrl } from './mcp-policy.js';
import {
  McpOAuthError,
  connectedUpdates,
  createOAuthHttp,
  exchangeAuthorizationCode,
  hashState,
  revokeOAuthGrant,
  startOAuthConnect,
} from './mcp-oauth.js';

const MCP_CONTAINER = 'mcp_servers';
const MAX_STATE_LENGTH = 512;
const MAX_CODE_LENGTH = 4096;

const fail = (status, error, code) => json(status, { ok: false, error, ...(code ? { code } : {}) });

const userIdOf = (user) => user?.oid || user?.sub || null;

const isPreconditionFailure = (error) => error?.code === 412 || error?.statusCode === 412;

/** Whether the server still signs in with Connect, at the pending sign-in's resource origin. */
function stillTheResource(server, pending) {
  if (!usesOAuthConnect(server)) return false;
  try {
    return new URL(validateMcpUrl(server.url)).origin === new URL(pending.resource).origin;
  } catch {
    return false;
  }
}

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
    context.warn?.(`${action} saved but the audit row failed: ${error?.message || error}`);
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
    context.error?.(`[${label}] configuration read failed:`, error?.message || error);
    return { response: fail(500, 'Failed to read MCP server configuration') };
  }
  if (!server) return { response: fail(404, 'MCP server not found') };
  const refusal = connectRefusal(server, serverId);
  if (refusal) return { response: fail(400, refusal, 'NOT_OAUTH') };
  return { serverId, server };
}

/** POST cms/mcp/{serverId}/oauth/start */
async function startMcpOAuth(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'super_admin');
  if (auth.error) return auth.error;
  const loaded = await loadRouteServer(ctx, request, context, 'startMcpOAuth');
  if (loaded.response) return loaded.response;
  const { serverId, server } = loaded;

  const userId = userIdOf(auth.user);
  if (!userId) return fail(403, 'Your sign-in carries no user id, so a Connect cannot be tied to you.');

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
      context.warn?.(`[startMcpOAuth] the sign-in was not started: ${error.message}`);
      return fail(error.status, error.message, error.code);
    }
    context.error?.('[startMcpOAuth] failed:', error?.message || error);
    return fail(500, `The sign-in for ${server.name || serverId} could not be started. Try Connect again.`);
  }
}

/** The pending sign-in this state names, or the response refusing it. */
async function findPending(ctx, context, { state, userId }) {
  const stateHash = hashState(state);
  let rows;
  try {
    rows = await ctx.store.queryDocs(
      MCP_CONTAINER,
      'SELECT * FROM c WHERE c.oauthPending.stateHash = @stateHash',
      [{ name: '@stateHash', value: stateHash }]
    );
  } catch (error) {
    context.error?.('[completeMcpOAuth] pending lookup failed:', error?.message || error);
    return { response: fail(500, 'Failed to read MCP server configuration') };
  }
  const server = (rows || []).find((doc) => doc?.oauthPending?.stateHash === stateHash);
  if (!server) {
    return {
      response: fail(
        400,
        'This sign-in is not one this site started, or it has already been used. Press Connect on the server card to start again.',
        'STATE_UNKNOWN'
      ),
    };
  }
  if (!userId || server.oauthPending.createdBy !== userId) {
    return {
      response: fail(
        403,
        `This sign-in for ${server.name || server.id} was started by a different administrator. Press Connect yourself to connect it.`,
        'STATE_OTHER_ADMIN'
      ),
    };
  }
  return { server };
}

/** POST cms/mcp/oauth/complete — { state, code } from the vendor's redirect. */
async function completeMcpOAuth(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'super_admin');
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => null);
  const state = typeof body?.state === 'string' ? body.state.trim() : '';
  const code = typeof body?.code === 'string' ? body.code.trim() : '';
  // Verbatim, not trimmed: RFC 9207 compares `iss` as a simple string.
  const iss = typeof body?.iss === 'string' ? body.iss.slice(0, 512) : '';
  if (!state || !code || state.length > MAX_STATE_LENGTH || code.length > MAX_CODE_LENGTH) {
    return fail(
      400,
      'The sign-in came back without a usable code and state. Press Connect on the server card to start again.',
      'BAD_CALLBACK'
    );
  }

  const found = await findPending(ctx, context, { state, userId: userIdOf(auth.user) });
  if (found.response) return found.response;
  const { server } = found;
  const serverId = server.id;
  const name = server.name || serverId;
  const pending = server.oauthPending;

  // Spend the state before anything else, guarded by the ETag the lookup
  // read: of two completions racing on one state, one write wins and the
  // other answers "already used" without reaching the token endpoint. A
  // document read without an ETag cannot be spent safely, so it is not.
  if (!server._etag) {
    context.error?.('[completeMcpOAuth] the server document was read without an ETag; refusing');
    return fail(500, 'The sign-in could not be verified. Press Connect on the server card to start again.');
  }
  // The document as the spend left it: its ETag guards the token write at
  // the end, so a server moved or switched to another sign-in method after
  // this point is not given a token for the old resource (review of #1019).
  let spent;
  try {
    spent = await ctx.store.patchDoc(MCP_CONTAINER, serverId, { oauthPending: null }, { ifMatch: server._etag });
  } catch (error) {
    if (isPreconditionFailure(error)) {
      return fail(409, 'This sign-in has already been used. Press Connect on the server card to start again.', 'STATE_USED');
    }
    context.error?.('[completeMcpOAuth] could not spend the state:', error?.message || error);
    return fail(500, 'Failed to update MCP server configuration');
  }

  if (!(Date.parse(pending.expiresAt) > ctx.now().getTime())) {
    return fail(
      400,
      `The sign-in for ${name} took longer than 10 minutes, so it was not accepted. Press Connect on its card to start again.`,
      'STATE_EXPIRED'
    );
  }

  // RFC 9207: the redirect names the issuer that produced the code. Present,
  // it must be the one this sign-in started with; absent, it is refused only
  // where the server said it always sends it. This is the mix-up defence: a
  // code another authorization server issued is not exchanged here.
  if (iss ? iss !== pending.issuer : pending.issParameterSupported === true) {
    return fail(
      400,
      `The sign-in came back from ${iss || 'an unnamed issuer'}, not from ${name}'s sign-in server ${pending.issuer}, so it was not accepted. Press Connect on its card to start again.`,
      'ISSUER_MISMATCH'
    );
  }

  // The server must still be the one the sign-in was for: still signing in
  // with Connect, and still at the resource the token will be issued for.
  if (!stillTheResource(server, pending)) {
    return fail(
      409,
      `${name} changed while the sign-in was in progress, so it was not accepted. Press Connect on its card to start again.`,
      'SERVER_CHANGED'
    );
  }

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
    const message =
      error instanceof McpOAuthError
        ? `${error.message} Press Connect on the ${name} card to try again.`
        : `The sign-in for ${name} could not be completed. Press Connect on its card to try again.`;
    context.warn?.(`[completeMcpOAuth] the code exchange failed: ${error?.message || error}`);
    return fail(502, message, 'EXCHANGE_FAILED');
  }

  const updates = connectedUpdates({ pending, tokens, now: ctx.now });
  if (!spent?._etag) {
    context.error?.('[completeMcpOAuth] the spent document came back without an ETag; refusing to store the token');
    return fail(500, `${name} signed in, but the connection could not be saved. Press Connect again.`);
  }
  try {
    await ctx.store.patchDoc(MCP_CONTAINER, serverId, updates, { ifMatch: spent._etag });
  } catch (error) {
    if (isPreconditionFailure(error)) {
      return fail(
        409,
        `${name} changed while the sign-in was in progress, so it was not accepted. Press Connect on its card to start again.`,
        'SERVER_CHANGED'
      );
    }
    context.error?.('[completeMcpOAuth] could not store the connection:', error?.message || error);
    return fail(500, `${name} signed in, but the connection could not be saved. Press Connect again.`);
  }
  await auditConnection(ctx, context, {
    action: 'mcp_oauth_connected',
    serverId,
    user: auth.user,
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

/** POST cms/mcp/{serverId}/oauth/disconnect */
async function disconnectMcpOAuth(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'super_admin');
  if (auth.error) return auth.error;
  const loaded = await loadRouteServer(ctx, request, context, 'disconnectMcpOAuth');
  if (loaded.response) return loaded.response;
  const { serverId, server } = loaded;
  const name = server.name || serverId;

  // Revoke at the provider first, while the tokens are still here to send.
  // Its outcome is reported, never acted on: the delete below happens
  // either way, so a provider that is down cannot keep a token on this side.
  const revocation = await revokeOAuthGrant({ server, serverId, http: ctx.oauthHttp });
  if (revocation.revoked === false) {
    // Fixed text only: `reason` carries provider-controlled text and belongs
    // in the response for the card, not in the log (CodeRabbit on #1124).
    context.warn?.(
      `[disconnectMcpOAuth] ${serverId}: the grant was not revoked at its provider; the token is deleted here regardless.`
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
    context.error?.('[disconnectMcpOAuth] failed:', error?.message || error);
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
