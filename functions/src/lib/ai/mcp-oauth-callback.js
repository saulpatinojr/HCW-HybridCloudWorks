/**
 * mcp-oauth-callback.js — the first half of `completeMcpOAuth`
 * (mcp-oauth-handlers.js): reading the vendor's redirect, finding the
 * pending sign-in its state names, spending that state under its ETag, and
 * checking the sign-in against the clock, the issuer and the server as it is
 * now. Also the small answer helpers the three OAuth routes share. The rules
 * themselves are described at the top of mcp-oauth-handlers.js.
 */
import { json } from '../http/admin-handler.js';
import { errorFacts } from '../http/error-response.js';
import { usesOAuthConnect, validateMcpUrl } from './mcp-policy.js';
import { hashState } from './mcp-oauth.js';

export const MCP_CONTAINER = 'mcp_servers';
const MAX_STATE_LENGTH = 512;
const MAX_CODE_LENGTH = 4096;

export const fail = (status, error, code) => json(status, { ok: false, error, ...(code ? { code } : {}) });

export const userIdOf = (user) => user?.oid || user?.sub || null;

export const isPreconditionFailure = (error) => error?.code === 412 || error?.statusCode === 412;

/** Whether the server still signs in with Connect, at the pending sign-in's resource origin. */
function stillTheResource(server, pending) {
  if (!usesOAuthConnect(server)) return false;
  try {
    return new URL(validateMcpUrl(server.url)).origin === new URL(pending.resource).origin;
  } catch {
    return false;
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
    context.error?.('[completeMcpOAuth] pending lookup failed:', errorFacts(error));
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

/** The `state`, `code` and `iss` of the vendor's redirect, or `{ response }` refusing a body without them. */
function readCallback(body) {
  const state = typeof body?.state === 'string' ? body.state.trim() : '';
  const code = typeof body?.code === 'string' ? body.code.trim() : '';
  // Verbatim, not trimmed: RFC 9207 compares `iss` as a simple string.
  const iss = typeof body?.iss === 'string' ? body.iss.slice(0, 512) : '';
  if (!state || !code || state.length > MAX_STATE_LENGTH || code.length > MAX_CODE_LENGTH) {
    return {
      response: fail(
        400,
        'The sign-in came back without a usable code and state. Press Connect on the server card to start again.',
        'BAD_CALLBACK'
      ),
    };
  }
  return { state, code, iss };
}

/**
 * Spend the state before anything else, guarded by the ETag the lookup
 * read: of two completions racing on one state, one write wins and the
 * other answers "already used" without reaching the token endpoint. A
 * document read without an ETag cannot be spent safely, so it is not.
 *
 * Answers `{ spent }`, the document as the spend left it: its ETag guards
 * the token write at the end, so a server moved or switched to another
 * sign-in method after this point is not given a token for the old resource
 * (review of #1019). Or `{ response }` refusing.
 */
async function spendState(ctx, context, server) {
  if (!server._etag) {
    context.error?.('[completeMcpOAuth] the server document was read without an ETag; refusing');
    return { response: fail(500, 'The sign-in could not be verified. Press Connect on the server card to start again.') };
  }
  try {
    return {
      spent: await ctx.store.patchDoc(MCP_CONTAINER, server.id, { oauthPending: null }, { ifMatch: server._etag }),
    };
  } catch (error) {
    if (isPreconditionFailure(error)) {
      return {
        response: fail(409, 'This sign-in has already been used. Press Connect on the server card to start again.', 'STATE_USED'),
      };
    }
    context.error?.('[completeMcpOAuth] could not spend the state:', errorFacts(error));
    return { response: fail(500, 'Failed to update MCP server configuration') };
  }
}

/** The spent sign-in checked against the clock, the issuer and the server as it is now: the refusal, or null. */
function callbackRefusal(ctx, { server, pending, iss, name }) {
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
  return null;
}

/**
 * Everything before the code exchange: the callback read, the pending
 * sign-in found and spent, and the checks on it. `{ response }` refusing, or
 * what the exchange needs.
 */
export async function prepareCompletion(ctx, request, context, user) {
  const body = await request.json().catch(() => null);
  const callback = readCallback(body);
  if (callback.response) return callback;

  const found = await findPending(ctx, context, { state: callback.state, userId: userIdOf(user) });
  if (found.response) return found;
  const { server } = found;
  const name = server.name || server.id;
  const pending = server.oauthPending;

  const spend = await spendState(ctx, context, server);
  if (spend.response) return spend;

  const refusal = callbackRefusal(ctx, { server, pending, iss: callback.iss, name });
  if (refusal) return { response: refusal };
  return { server, serverId: server.id, name, pending, spent: spend.spent, code: callback.code };
}
