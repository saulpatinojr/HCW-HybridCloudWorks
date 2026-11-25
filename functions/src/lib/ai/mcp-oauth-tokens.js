/**
 * mcp-oauth-tokens.js — the token endpoint of the MCP OAuth Connect flow
 * (mcp-oauth.js): the request a grant sends, the reply it expects, the
 * document a connection stores, and what state a stored connection is in.
 */
import { codeShaped } from '../http/error-response.js';
import { McpOAuthError, parseJson, requireHttpsUrl } from './mcp-oauth-base.js';
import { describeOAuthReply } from './mcp-oauth-client.js';

// ─── Token requests ─────────────────────────────────────────────────────────

/**
 * Headers and form body for a token-endpoint request, with the client
 * authentication its registration chose: nothing for a public client, HTTP
 * Basic, or the secret in the body.
 */
export function tokenRequest({ params, clientId, tokenEndpointAuthMethod = 'none', clientSecret = null }) {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...params, client_id: clientId })) {
    if (value !== undefined && value !== null && value !== '') form.set(key, String(value));
  }
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (tokenEndpointAuthMethod === 'client_secret_basic' && clientSecret) {
    const pair = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
    headers.Authorization = `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`;
  } else if (tokenEndpointAuthMethod === 'client_secret_post' && clientSecret) {
    form.set('client_secret', clientSecret);
  }
  return { headers, body: form.toString() };
}

/** A token-endpoint reply as `{ accessToken, refreshToken, expiresAt, scope }`, or a refusal. */
export function parseTokenResponse({ status, text }, { name, grant, now }) {
  const body = parseJson(text);
  if (status !== 200 || !body || body.error) {
    throw new McpOAuthError(
      `${name}'s sign-in server refused the ${grant}: ${describeOAuthReply(body, status)}.`,
      { upstreamStatus: status, oauthError: typeof body?.error === 'string' ? body.error : null }
    );
  }
  if (typeof body.access_token !== 'string' || !body.access_token) {
    throw new McpOAuthError(`${name}'s sign-in server answered the ${grant} with no access token.`, {
      upstreamStatus: status,
    });
  }
  if (body.token_type !== undefined && !/^bearer$/i.test(String(body.token_type))) {
    // Named only when it has the shape of a token type (#945).
    const tokenType = codeShaped(body.token_type);
    throw new McpOAuthError(
      tokenType
        ? `${name}'s sign-in server issued a "${tokenType}" token, not a bearer token.`
        : `${name}'s sign-in server issued a token that is not a bearer token.`,
      { upstreamStatus: status }
    );
  }
  const seconds = Number(body.expires_in);
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : null,
    expiresAt:
      Number.isFinite(seconds) && seconds > 0 ? new Date(now().getTime() + seconds * 1000).toISOString() : null,
    scope: typeof body.scope === 'string' && body.scope.trim() ? body.scope.trim() : null,
  };
}

/**
 * Trade the code for tokens at the token endpoint discovered when the
 * sign-in started (never one supplied by the callback).
 */
export async function exchangeAuthorizationCode({ pending, code, clientSecret = null, http, now = () => new Date(), name }) {
  requireHttpsUrl(pending.tokenEndpoint, `${name}'s token endpoint`);
  const request = tokenRequest({
    params: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.codeVerifier,
      resource: pending.resource,
    },
    clientId: pending.clientId,
    tokenEndpointAuthMethod: pending.tokenEndpointAuthMethod,
    clientSecret,
  });
  const res = await http(pending.tokenEndpoint, { method: 'POST', ...request });
  return parseTokenResponse(res, { name, grant: 'sign-in code', now });
}

/** The document updates a successful exchange stores. */
export function connectedUpdates({ pending, tokens, now }) {
  return {
    oauthToken: tokens.accessToken,
    oauthRefreshToken: tokens.refreshToken,
    oauth: {
      status: 'connected',
      issuer: pending.issuer,
      tokenEndpoint: pending.tokenEndpoint,
      // Absent on documents connected before #1116: Disconnect then has
      // nowhere to revoke and says so (`revoked: null`).
      revocationEndpoint: pending.revocationEndpoint ?? null,
      clientId: pending.clientId,
      tokenEndpointAuthMethod: pending.tokenEndpointAuthMethod,
      resource: pending.resource,
      scope: tokens.scope ?? pending.scope ?? null,
      connectedAt: now().toISOString(),
      expiresAt: tokens.expiresAt,
      refreshedAt: null,
    },
    oauthPending: null,
    status: 'untested',
    lastError: null,
  };
}

// ─── Connection state and refresh ───────────────────────────────────────────

/** 'connected', 'expired' (a refresh failed) or 'not_connected'. */
export function oauthConnectionState(server) {
  if (server?.oauth?.status === 'connected' && server.oauthToken) return 'connected';
  if (server?.oauth?.status === 'disconnected') return 'expired';
  return 'not_connected';
}

/** The sentence a server without a live connection is refused with. */
export function notConnectedMessage(server, serverId) {
  const name = server?.name || serverId;
  return oauthConnectionState(server) === 'expired'
    ? `Sign-in to ${name} has expired. Press Connect on its card under AI Engine → MCP Servers to sign in again.`
    : `${name} is not connected. Press Connect on its card under AI Engine → MCP Servers and sign in.`;
}

/** Whether the stored access token expires within `withinMs` (or already has). */
export function tokenExpiresWithin(server, withinMs, now = () => new Date()) {
  const at = Date.parse(server?.oauth?.expiresAt ?? '');
  return Number.isFinite(at) && at - now().getTime() <= withinMs;
}

/** The stored tokens to revoke, refresh token first (RFC 7009 §2.1), as `[hint, token]` pairs. */
export function revocableTokens(server) {
  return [
    ['refresh_token', server?.oauthRefreshToken],
    ['access_token', server?.oauthToken],
  ].filter(([, token]) => typeof token === 'string' && token);
}

/** A function that replaces every one of `tokens`, raw or percent-encoded, with `***` in a text. */
export function scrubberFor(tokens) {
  return (text) => {
    let out = String(text ?? '');
    for (const [, token] of tokens) {
      for (const form of new Set([token, encodeURIComponent(token)])) out = out.split(form).join('***');
    }
    return out;
  };
}
