/**
 * mcp-oauth-client.js — this site as an OAuth client of an MCP server
 * (mcp-oauth.js): dynamic client registration, PKCE and the state, and the
 * authorization address a sign-in opens.
 */
import { createHash, randomBytes } from 'node:crypto';
import { codeShaped } from '../http/error-response.js';
import {
  AUTH_METHODS,
  MCP_OAUTH_CLIENT_NAME,
  McpOAuthError,
  base64url,
  isObject,
  parseJson,
  stringList,
} from './mcp-oauth-base.js';

// ─── Dynamic client registration ────────────────────────────────────────────

/** `none` when offered, else the first secret method offered, else null. */
export function chooseTokenEndpointAuthMethod(supported) {
  const offered = stringList(supported);
  return AUTH_METHODS.find((method) => offered.includes(method)) || null;
}

/** The RFC 7591 registration request this site sends. */
export function registrationRequestBody({ redirectUri, tokenEndpointAuthMethod }) {
  return {
    client_name: MCP_OAUTH_CLIENT_NAME,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: tokenEndpointAuthMethod,
  };
}

/** The stored registration when it is for this issuer and redirect URI, else null. */
export function reusableClient(server, { issuer, redirectUri }) {
  const client = server?.oauthClient;
  if (!isObject(client) || client.issuer !== issuer || client.redirectUri !== redirectUri) return null;
  if (typeof client.clientId !== 'string' || !client.clientId) return null;
  if (!AUTH_METHODS.includes(client.tokenEndpointAuthMethod)) return null;
  if (client.tokenEndpointAuthMethod !== 'none' && !server.oauthClientSecret) return null;
  return client;
}

/**
 * An OAuth endpoint's refusal as its status and RFC 6749 error code. The
 * `error_description` is the provider's own sentence and is not carried
 * (#945); the code (`invalid_grant`) is what an owner acts on.
 *
 * @param {object|null} body - the parsed answer
 * @param {number} status - its HTTP status
 * @returns {string}
 */
export function describeOAuthReply(body, status) {
  const code = typeof body?.error === 'string' ? codeShaped(body.error) : '';
  return code ? `${code} (HTTP ${status})` : `HTTP ${status}`;
}

export async function registerClient({ discovery, redirectUri, http, now, name }) {
  const tokenEndpointAuthMethod = chooseTokenEndpointAuthMethod(discovery.tokenEndpointAuthMethods);
  if (!tokenEndpointAuthMethod) {
    throw new McpOAuthError(
      `${name}'s sign-in server offers no client authentication this site supports (none, client_secret_basic or client_secret_post).`
    );
  }
  const res = await http(discovery.registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(registrationRequestBody({ redirectUri, tokenEndpointAuthMethod })),
  });
  const body = parseJson(res.text);
  if (![200, 201].includes(res.status) || typeof body?.client_id !== 'string' || !body.client_id.trim()) {
    throw new McpOAuthError(
      `${name}'s sign-in server refused to register this site: ${describeOAuthReply(body, res.status)}.`,
      { upstreamStatus: res.status, oauthError: body?.error ?? null }
    );
  }
  const method = AUTH_METHODS.includes(body.token_endpoint_auth_method)
    ? body.token_endpoint_auth_method
    : tokenEndpointAuthMethod;
  const secret = typeof body.client_secret === 'string' && body.client_secret ? body.client_secret : null;
  if (method !== 'none' && !secret) {
    throw new McpOAuthError(
      `${name}'s sign-in server registered this site for ${method} but issued no client secret.`
    );
  }
  return {
    client: {
      issuer: discovery.issuer,
      redirectUri,
      clientId: body.client_id.trim(),
      tokenEndpointAuthMethod: method,
      registeredAt: now().toISOString(),
    },
    clientSecret: method === 'none' ? null : secret,
  };
}

// ─── PKCE, state and the authorization request ──────────────────────────────

/** A PKCE code verifier: 32 random bytes, base64url — 43 characters (RFC 7636 §4.1). */
export function createCodeVerifier(random = randomBytes) {
  return base64url(random(32));
}

/**
 * The S256 code challenge of a verifier (RFC 7636 §4.2).
 *
 * SHA-256 is the method the RFC fixes, BASE64URL(SHA256(ASCII(verifier))),
 * and the authorization server computes the same to compare, so no other
 * hash is possible. The verifier is not a password: it is 32 bytes from
 * randomBytes, used once. CodeQL's js/insufficient-password-hash reads it as
 * one from the names it flows through, and is dismissed as a false positive
 * on this ground (#1019).
 */
export function codeChallengeS256(verifier) {
  return base64url(createHash('sha256').update(String(verifier), 'ascii').digest());
}

/**
 * What is stored in place of `state`: its SHA-256, hex. A fast digest on
 * purpose: `state` is 32 random bytes, single-use and ten minutes long, so
 * there is nothing to brute-force, as with a session id.
 */
export function hashState(state) {
  return createHash('sha256').update(String(state), 'utf8').digest('hex');
}

/** The URL the browser is sent to. */
export function buildAuthorizationUrl({ authorizationEndpoint, clientId, redirectUri, codeChallenge, state, resource, scope }) {
  const url = new URL(authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  if (resource) url.searchParams.set('resource', resource);
  if (scope) url.searchParams.set('scope', scope);
  return url.toString();
}
