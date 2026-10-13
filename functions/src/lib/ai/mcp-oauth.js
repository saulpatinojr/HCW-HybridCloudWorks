/**
 * mcp-oauth.js — the OAuth 2.1 "Connect" flow for remote MCP servers that
 * accept only tokens issued by their own authorization server (2026-10-08).
 *
 * Why it exists: Replicate's hosted server (mcp.replicate.com/sse) answers the
 * REPLICATE_API_KEY bearer with `401 invalid_token`, and Hostinger's hosted
 * server (mcp.hostinger.com) takes nothing but its own tokens. Both publish
 * the MCP authorization profile, which is four RFCs composed, and this module
 * is those four and nothing else:
 *
 *   - RFC 9728 protected-resource metadata: which authorization server issues
 *     tokens for the MCP server, and the `resource` to ask for (RFC 8707);
 *   - RFC 8414 authorization-server metadata (OpenID configuration as the
 *     fallback): the authorize, token and registration endpoints;
 *   - RFC 7591 dynamic client registration: this site registers itself once
 *     per issuer and redirect URI, as a public client where the server allows;
 *   - RFC 6749 / RFC 7636: the authorization-code grant with PKCE S256 only,
 *     and the refresh grant;
 *   - RFC 7009 token revocation, on Disconnect, where the metadata names a
 *     `revocation_endpoint` (Podbean does; Replicate and Hostinger did not
 *     when read). Best effort: the local delete never waits on it (#1116).
 *
 * Every request goes through `guardedFetch` (lib/http/guarded-fetch.js): https
 * only on every hop, private addresses refused, one deadline and a byte cap.
 * Requests that carry a secret (registration, code exchange, refresh) follow
 * no redirect at all, so a 307 can never replay a verifier or a refresh token
 * at another host.
 *
 * What lives where on the `mcp_servers` document:
 *
 *   readable    oauth        { status, issuer, tokenEndpoint, revocationEndpoint,
 *                              clientId, tokenEndpointAuthMethod, resource,
 *                              scope, connectedAt, expiresAt, refreshedAt }
 *               oauthClient  { issuer, redirectUri, clientId,
 *                              tokenEndpointAuthMethod, registeredAt }
 *   write-only  oauthToken, oauthRefreshToken, oauthClientSecret,
 *               oauthPending { stateHash, codeVerifier, createdBy, ... }
 *
 * The config routes (admin-integrations/config-collections.js) strip the
 * write-only fields from every read and drop all four OAuth objects from any
 * browser write: only this flow sets them, because `oauth.tokenEndpoint` and
 * `oauth.revocationEndpoint` are where a refresh token is sent and must never
 * be a value an editor typed.
 *
 * Plaud is NOT routed through here. Its token is pasted on the Recording
 * Hub's Connect tab and refreshed by Plaud's own non-standard endpoint
 * (lib/timers/plaud-token.js); `usesOAuthConnect` in mcp-policy.js is the line
 * between the two.
 */
import { createHash, randomBytes } from 'node:crypto';
import { PRODUCTION_ORIGINS } from '../auth/cors.js';
import { guardedFetch } from '../http/guarded-fetch.js';
import { MCP_OAUTH_CALLBACK_PATH, validateMcpUrl } from './mcp-policy.js';

const MCP_CONTAINER = 'mcp_servers';

/**
 * Where every vendor sends the browser back to. Dynamic client registration
 * records this string verbatim, so it is built from the one site origin the
 * API already treats as the site (cors.js PRODUCTION_ORIGINS[0], the apex),
 * not from a request header a caller could choose.
 */
export const MCP_OAUTH_REDIRECT_URI = `${PRODUCTION_ORIGINS[0]}${MCP_OAUTH_CALLBACK_PATH}`;

/** The name this site registers under; vendors show it on their consent page. */
export const MCP_OAUTH_CLIENT_NAME = 'HybridCloudWorks';

/** A started sign-in is good for ten minutes, once. */
export const PENDING_TTL_MS = 10 * 60_000;

/** Refresh before an RPC when the access token has less than this left. */
export const REFRESH_SKEW_MS = 2 * 60_000;

/** The client authentication methods this site can use, in preference order. */
const AUTH_METHODS = Object.freeze(['none', 'client_secret_basic', 'client_secret_post']);

/** Upstream OAuth error codes that mean the grant itself is dead, not the network. */
const GRANT_REJECTIONS = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client']);

/**
 * A failure in the flow, carrying a sentence an owner can act on. `status` is
 * what this API answers for it; `upstreamStatus` and `oauthError` are what the
 * vendor said, kept so the refresh path can tell a dead grant from an outage.
 */
export class McpOAuthError extends Error {
  constructor(message, { status = 502, upstreamStatus = null, oauthError = null, code = 'OAUTH_FAILED' } = {}) {
    super(message);
    this.name = 'McpOAuthError';
    this.status = status;
    this.upstreamStatus = upstreamStatus;
    this.oauthError = oauthError;
    this.code = code;
  }
}

/**
 * Thrown before any RPC to an OAuth server that has no live connection, so
 * nothing is sent without a token and the card can say "press Connect"
 * instead of a red HTTP 401.
 */
export class McpOAuthNotConnectedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'McpOAuthNotConnectedError';
    this.code = 'NOT_CONNECTED';
  }
}

const base64url = (bytes) => Buffer.from(bytes).toString('base64url');
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const stringList = (value) =>
  Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()) : [];

function parseJson(text) {
  try {
    const value = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** The URL with its query and fragment removed, for messages. */
function bare(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(url);
  }
}

/**
 * `value` as a parsed https URL with no credentials or fragment, or a refusal
 * naming `what`. Every endpoint the flow sends anything to passes this.
 */
export function requireHttpsUrl(value, what) {
  let parsed;
  try {
    parsed = new URL(String(value ?? ''));
  } catch {
    throw new McpOAuthError(`${what} is not a valid URL (${String(value ?? '') || 'missing'}).`);
  }
  if (parsed.protocol !== 'https:') {
    throw new McpOAuthError(`${what} must be an https address; it is ${bare(parsed.href)}.`);
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new McpOAuthError(`${what} must not carry credentials or a fragment.`);
  }
  return parsed;
}

function describeFetchFailure(url, error) {
  const where = bare(url);
  if (error?.code === 'FETCH_TIMEOUT') return `${where} did not answer in time.`;
  if (error?.code === 'REDIRECT_LIMIT' || error?.code === 'REDIRECT_NO_LOCATION') {
    return `${where} answered with a redirect, which this sign-in does not follow.`;
  }
  if (error?.refused) return `${where} is not an address this site fetches (${error.message}).`;
  if (error?.code === 'BODY_TOO_LARGE') return `${where} answered with more data than expected.`;
  return `${where} could not be reached (${error?.message || error}).`;
}

/**
 * The one outbound request of this module: guardedFetch, https on every hop,
 * redirects followed only where `followRedirects` says (metadata GETs) and
 * never for a request carrying a secret. Resolves to `{ status, headers, text }`
 * whatever the status; throws McpOAuthError when nothing came back.
 *
 * `fetch`, `resolve` and `dispatcherFor` are guardedFetch's own seams and
 * exist for tests; production passes none of them.
 */
export function createOAuthHttp({ fetch, resolve, dispatcherFor, timeoutMs = 8_000, maxBytes = 256 * 1024 } = {}) {
  return async function oauthRequest(url, { method = 'GET', headers, body, followRedirects = false, timeoutMs: perCall } = {}) {
    requireHttpsUrl(url, 'The address');
    try {
      const result = await guardedFetch(url, {
        fetch,
        resolve,
        dispatcherFor,
        method,
        headers,
        body,
        maxRedirects: followRedirects ? 3 : 0,
        httpsOnly: true,
        timeoutMs: perCall ?? timeoutMs,
        maxBytes,
      });
      return { status: result.response.status, headers: result.response.headers, text: result.text() };
    } catch (error) {
      throw new McpOAuthError(describeFetchFailure(url, error), { code: 'UNREACHABLE' });
    }
  };
}

// ─── Discovery ───────────────────────────────────────────────────────────────

/**
 * The `resource_metadata` URL a 401's WWW-Authenticate challenge names
 * (RFC 9728 §5.1), or null. Hostinger sends one; Replicate does not.
 */
export function resourceMetadataFromChallenge(header) {
  if (typeof header !== 'string') return null;
  const quoted = /resource_metadata\s*=\s*"([^"]+)"/i.exec(header);
  if (quoted) return quoted[1].trim();
  const token = /resource_metadata\s*=\s*([^\s,]+)/i.exec(header);
  return token ? token[1].trim() : null;
}

/**
 * Where to look for protected-resource metadata, in order: the challenge's
 * `resource_metadata` (when https), the well-known URI with the server URL's
 * path appended (RFC 9728 §3.1), then the well-known URI at the origin.
 */
export function protectedResourceMetadataUrls(serverUrl, challengeUrl = null) {
  const url = new URL(serverUrl);
  const urls = [];
  if (challengeUrl) {
    try {
      if (new URL(challengeUrl).protocol === 'https:') urls.push(new URL(challengeUrl).href);
    } catch {
      // An unparseable hint is ignored; the well-known URIs below still apply.
    }
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (path) urls.push(`${url.origin}/.well-known/oauth-protected-resource${path}`);
  urls.push(`${url.origin}/.well-known/oauth-protected-resource`);
  return [...new Set(urls)];
}

/**
 * Where to look for authorization-server metadata (RFC 8414 §3.1), the
 * OpenID configuration as the fallback: path-inserted for an issuer with a
 * path, and the OIDC path-appended form last.
 */
export function authorizationServerMetadataUrls(issuer) {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, '');
  if (!path) {
    return [
      `${url.origin}/.well-known/oauth-authorization-server`,
      `${url.origin}/.well-known/openid-configuration`,
    ];
  }
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ];
}

/**
 * One unauthenticated MCP request, for the challenge it answers with. A
 * failure here is not a failure of the flow: the well-known URIs still work.
 */
async function probeChallenge(serverUrl, http) {
  try {
    const res = await http(serverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'hcw-mcp-proxy', version: '1.0.0' },
        },
        id: 0,
      }),
      timeoutMs: 5_000,
    });
    return res.status === 401 ? res.headers?.get?.('www-authenticate') || null : null;
  } catch {
    return null;
  }
}

/**
 * The first candidate that answers 200 with a JSON object `accept`s:
 * `{ url, doc }`. Otherwise `{ failure }`, where `failure` is the last
 * request error when no candidate answered at all — so an outage is not
 * reported as "publishes no metadata" — and null when they answered without
 * a usable document.
 */
async function firstDocument(urls, http, accept) {
  let answered = false;
  let failure = null;
  for (const url of urls) {
    let res;
    try {
      res = await http(url, { headers: { Accept: 'application/json' }, followRedirects: true });
    } catch (error) {
      failure = error;
      continue;
    }
    answered = true;
    if (res.status !== 200) continue;
    const doc = parseJson(res.text);
    if (doc && accept(doc)) return { url, doc };
  }
  return { failure: answered ? null : failure };
}

function unreachable(name, what, failure) {
  return new McpOAuthError(`${name}'s ${what} could not be read: ${failure.message}`, {
    code: 'UNREACHABLE',
  });
}

/**
 * Whether a protected resource's identifier names this MCP server: the same
 * origin, no query, and a path that is the server URL's path or a parent of
 * it (`https://mcp.replicate.com/` covers `/sse`). Replicate and Hostinger
 * both name their origin. RFC 9728 §3.3 asks for an exact match with the
 * identifier the well-known URI was built from; a parent path is accepted
 * because the origin-level document is the fallback this flow reads.
 */
function coversServer(resource, server) {
  if (resource.origin !== server.origin || resource.search) return false;
  const base = resource.pathname.replace(/\/+$/, '');
  const path = server.pathname.replace(/\/+$/, '');
  return !base || path === base || path.startsWith(`${base}/`);
}

/**
 * The protected resource's metadata, checked: an https authorization server,
 * and a `resource` that names this MCP server (coversServer). A resource
 * naming anything else would have this site ask for a token meant for
 * someone else.
 */
async function discoverProtectedResource({ serverUrl, challenge, http, name }) {
  const found = await firstDocument(
    protectedResourceMetadataUrls(serverUrl, resourceMetadataFromChallenge(challenge)),
    http,
    (doc) => stringList(doc.authorization_servers).length > 0
  );
  if (!found.doc) {
    if (found.failure) throw unreachable(name, 'OAuth protected-resource metadata', found.failure);
    throw new McpOAuthError(
      `${name} publishes no OAuth protected-resource metadata (RFC 9728) at ${new URL(serverUrl).origin}/.well-known/oauth-protected-resource, so it cannot be connected with Connect.`
    );
  }
  const { doc } = found;
  // The issuer identifier is kept as the metadata spells it: the registration
  // is reused per issuer, and RFC 8414 compares issuers as strings.
  const issuerUrl = stringList(doc.authorization_servers)[0].trim();
  requireHttpsUrl(issuerUrl, `${name}'s authorization server`);
  const own = new URL(serverUrl);
  let resource = `${own.origin}${own.pathname}`;
  if (doc.resource !== undefined) {
    const named = requireHttpsUrl(doc.resource, `The resource ${name}'s metadata names`);
    if (!coversServer(named, own)) {
      throw new McpOAuthError(
        `${name}'s metadata names the resource ${bare(named.href)}, which is not its own address ${bare(own.href)}; no token is requested for it.`
      );
    }
    resource = String(doc.resource);
  }
  return {
    issuerUrl,
    resource,
    scopes: stringList(doc.scopes_supported),
    metadataUrl: found.url,
  };
}

/**
 * The authorization server's metadata, held to what this flow needs: https
 * endpoints, PKCE with S256, and a registration endpoint. Each refusal says
 * which of those the server lacks.
 */
async function discoverAuthorizationServer({ issuerUrl, http, name }) {
  const found = await firstDocument(
    authorizationServerMetadataUrls(issuerUrl),
    http,
    (doc) => typeof doc.authorization_endpoint === 'string' && typeof doc.token_endpoint === 'string'
  );
  if (!found.doc) {
    if (found.failure) throw unreachable(name, 'authorization-server metadata', found.failure);
    throw new McpOAuthError(
      `${name}'s authorization server ${bare(issuerUrl)} publishes no OAuth or OpenID metadata, so it cannot be connected with Connect.`
    );
  }
  const { doc } = found;
  // RFC 8414 §3.3: the metadata's issuer must be the identifier it was
  // fetched for, so a missing one, or one at another path on the same origin
  // (another tenant), is refused before any endpoint in it is used.
  const issuer = typeof doc.issuer === 'string' ? doc.issuer : '';
  if (!sameIssuer(issuer, issuerUrl)) {
    throw new McpOAuthError(
      `${name}'s authorization-server metadata names the issuer ${issuer ? bare(issuer) : '(none)'}, not ${bare(issuerUrl)}; the sign-in was not started.`
    );
  }
  requireHttpsUrl(issuer, `${name}'s issuer`);
  const authorizationEndpoint = requireHttpsUrl(doc.authorization_endpoint, `${name}'s authorization endpoint`).href;
  const tokenEndpoint = requireHttpsUrl(doc.token_endpoint, `${name}'s token endpoint`).href;
  if (!stringList(doc.code_challenge_methods_supported).includes('S256')) {
    throw new McpOAuthError(
      `${name}'s sign-in server does not offer PKCE with S256 (code_challenge_methods_supported lacks "S256"), which this site requires.`
    );
  }
  if (typeof doc.registration_endpoint !== 'string' || !doc.registration_endpoint.trim()) {
    throw new McpOAuthError(
      `${name}'s sign-in server offers no dynamic client registration (no registration_endpoint), so this site cannot register itself with it.`
    );
  }
  const registrationEndpoint = requireHttpsUrl(doc.registration_endpoint, `${name}'s registration endpoint`).href;
  const responseTypes = stringList(doc.response_types_supported);
  if (responseTypes.length && !responseTypes.includes('code')) {
    throw new McpOAuthError(`${name}'s sign-in server does not offer the authorization-code flow.`);
  }
  const grantTypes = stringList(doc.grant_types_supported);
  if (grantTypes.length && !grantTypes.includes('authorization_code')) {
    throw new McpOAuthError(`${name}'s sign-in server does not offer the authorization_code grant.`);
  }
  return {
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint,
    revocationEndpoint: optionalHttpsEndpoint(doc.revocation_endpoint),
    // RFC 8414 §2: absent means client_secret_basic.
    tokenEndpointAuthMethods: Array.isArray(doc.token_endpoint_auth_methods_supported)
      ? stringList(doc.token_endpoint_auth_methods_supported)
      : ['client_secret_basic'],
    // RFC 9207: a server that says it sends `iss` on the redirect must have
    // sent it, and it must name this issuer (mix-up defence).
    issParameterSupported: doc.authorization_response_iss_parameter_supported === true,
    metadataUrl: found.url,
  };
}

/**
 * An endpoint the flow can do without (RFC 8414 `revocation_endpoint`): its
 * https URL, or null when absent or not one this site would send a token to.
 * Not a refusal: a server that advertises a bad revocation address can still
 * be connected; its Disconnect then just has nowhere to revoke.
 */
function optionalHttpsEndpoint(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return requireHttpsUrl(value, 'The endpoint').href;
  } catch {
    return null;
  }
}

/** `https://host` for an identifier that is an origin alone, with or without the root "/"; otherwise null. */
function bareOrigin(value) {
  try {
    const url = new URL(value);
    return value === url.origin || value === `${url.origin}/` ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Whether the metadata's `issuer` is the identifier the metadata was fetched
 * for (RFC 8414 §3.3: identical). One spelling is allowed besides the
 * identical one, and nothing else: an identifier that is an origin alone,
 * written with and without the root "/", which the URL standard serialises
 * as one URL. Replicate's resource metadata names `https://mcp.replicate.com/`
 * and its server metadata `https://mcp.replicate.com` (measured 2026-10-08),
 * so the identical rule alone would refuse it. Any path, a different tenant
 * on the same origin, and a missing issuer are not the same (review of
 * #1019). The redirect's `iss` is held to the stricter rule, verbatim
 * (RFC 9207), in mcp-oauth-handlers.js.
 */
export function sameIssuer(metadataIssuer, issuerUrl) {
  const a = typeof metadataIssuer === 'string' ? metadataIssuer : '';
  const b = typeof issuerUrl === 'string' ? issuerUrl : '';
  if (!a || !b) return false;
  if (a === b) return true;
  const origin = bareOrigin(a);
  return origin !== null && origin === bareOrigin(b);
}

/**
 * Everything the flow needs to know about one MCP server's sign-in, from its
 * URL and (optionally) the WWW-Authenticate header of a 401 it answered.
 * `scope` is the protected resource's own `scopes_supported`, joined, and
 * empty when it lists none. The authorization server's list is deliberately
 * not used: it names everything that server can grant (often `openid`,
 * `offline_access` and more), not what this resource needs, and the
 * smallest grant that works is the one to ask for.
 */
export async function discoverOAuth({ serverUrl, challenge = null, http, name = 'The MCP server' }) {
  const resource = await discoverProtectedResource({ serverUrl, challenge, http, name });
  const server = await discoverAuthorizationServer({ issuerUrl: resource.issuerUrl, http, name });
  return {
    issuer: server.issuer,
    authorizationEndpoint: server.authorizationEndpoint,
    tokenEndpoint: server.tokenEndpoint,
    registrationEndpoint: server.registrationEndpoint,
    revocationEndpoint: server.revocationEndpoint,
    tokenEndpointAuthMethods: server.tokenEndpointAuthMethods,
    issParameterSupported: server.issParameterSupported,
    resource: resource.resource,
    scope: resource.scopes.join(' '),
    resourceMetadataUrl: resource.metadataUrl,
    authorizationServerMetadataUrl: server.metadataUrl,
  };
}

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

function describeOAuthReply(body, status) {
  const text = [body?.error, body?.error_description].filter((part) => typeof part === 'string' && part.trim());
  return text.length ? text.join(': ').slice(0, 300) : `HTTP ${status}`;
}

async function registerClient({ discovery, redirectUri, http, now, name }) {
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

/**
 * Discover, register (or reuse the registration), and mint the sign-in for
 * one server. Returns the URL to send the browser to and the document
 * `updates` that make it completable: the pending state (write-only), and a
 * new registration when one was made. Writes nothing itself.
 */
export async function startOAuthConnect({
  server,
  serverId,
  userId,
  http,
  now = () => new Date(),
  random = randomBytes,
  redirectUri = MCP_OAUTH_REDIRECT_URI,
}) {
  const name = server?.name || serverId;
  let serverUrl;
  try {
    serverUrl = validateMcpUrl(server?.url);
  } catch (error) {
    throw new McpOAuthError(`${name}: ${error.message}`, { status: 400, code: 'BAD_URL' });
  }
  const challenge = await probeChallenge(serverUrl, http);
  const discovery = await discoverOAuth({ serverUrl, challenge, http, name });

  const updates = {};
  let client = reusableClient(server, { issuer: discovery.issuer, redirectUri });
  if (!client) {
    const registered = await registerClient({ discovery, redirectUri, http, now, name });
    client = registered.client;
    updates.oauthClient = registered.client;
    updates.oauthClientSecret = registered.clientSecret;
  }

  const state = base64url(random(32));
  const codeVerifier = createCodeVerifier(random);
  const createdAt = now();
  updates.oauthPending = {
    stateHash: hashState(state),
    codeVerifier,
    createdBy: userId,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + PENDING_TTL_MS).toISOString(),
    issuer: discovery.issuer,
    tokenEndpoint: discovery.tokenEndpoint,
    revocationEndpoint: discovery.revocationEndpoint ?? null,
    clientId: client.clientId,
    tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
    redirectUri,
    resource: discovery.resource,
    scope: discovery.scope || null,
    issParameterSupported: discovery.issParameterSupported,
  };

  return {
    authorizationUrl: buildAuthorizationUrl({
      authorizationEndpoint: discovery.authorizationEndpoint,
      clientId: client.clientId,
      redirectUri,
      codeChallenge: codeChallengeS256(codeVerifier),
      state,
      resource: discovery.resource,
      scope: discovery.scope,
    }),
    updates,
  };
}

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
    throw new McpOAuthError(
      `${name}'s sign-in server issued a "${String(body.token_type).slice(0, 40)}" token, not a bearer token.`,
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

// ─── Revocation (RFC 7009) ──────────────────────────────────────────────────

/**
 * Revoke a server's grant at its authorization server before the tokens are
 * deleted locally (#1116). The refresh token goes first — RFC 7009 §2.1 says
 * revoking it should take its access tokens with it — then the access token,
 * each as `token=…&token_type_hint=…` with the client authentication the
 * registration chose, exactly as the token endpoint is called.
 *
 * Resolves, never throws:
 *   `{ revoked: true,  issuer }`          every stored token was accepted (2xx);
 *   `{ revoked: false, issuer, reason }`  one was not — a non-2xx, no answer,
 *                                         a timeout, or an endpoint this site
 *                                         will not send a token to;
 *   `{ revoked: null,  issuer }`          nowhere to revoke: the metadata named
 *                                         no revocation_endpoint (or the
 *                                         document predates its storage), or
 *                                         no token is stored.
 *
 * `reason` is built from the endpoint's address and what the server said,
 * never from a token, so it can be logged and shown on the card.
 */
export async function revokeOAuthGrant({ server, serverId, http }) {
  const name = server?.name || serverId;
  const oauth = server?.oauth || {};
  const issuer = typeof oauth.issuer === 'string' && oauth.issuer ? oauth.issuer : null;
  const endpoint = oauth.revocationEndpoint;
  const tokens = [
    ['refresh_token', server?.oauthRefreshToken],
    ['access_token', server?.oauthToken],
  ].filter(([, token]) => typeof token === 'string' && token);
  if (!endpoint || !tokens.length) return { revoked: null, issuer };

  try {
    requireHttpsUrl(endpoint, `${name}'s revocation endpoint`);
  } catch (error) {
    return { revoked: false, issuer, reason: error.message };
  }

  // Every token this call sends, so a provider body or a transport error that
  // echoes one is scrubbed before it becomes the `reason` the handler returns
  // (CodeRabbit on #1124). Raw and percent-encoded forms both.
  const scrub = (text) => {
    let out = String(text ?? '');
    for (const [, token] of tokens) {
      for (const form of new Set([token, encodeURIComponent(token)])) out = out.split(form).join('***');
    }
    return out;
  };

  let reason = null;
  for (const [hint, token] of tokens) {
    const request = tokenRequest({
      params: { token, token_type_hint: hint },
      clientId: oauth.clientId,
      tokenEndpointAuthMethod: oauth.tokenEndpointAuthMethod,
      clientSecret: server.oauthClientSecret ?? null,
    });
    try {
      const res = await http(endpoint, { method: 'POST', ...request });
      // RFC 7009 §2.2: 200 whether or not the token was still valid. Anything
      // else is the server declining, and the next token is still tried.
      if (res.status < 200 || res.status >= 300) {
        reason ??= scrub(
          `${bare(endpoint)} answered the ${hint.replace('_', ' ')} revocation with ${describeOAuthReply(
            parseJson(res.text),
            res.status
          )}.`
        );
      }
    } catch (error) {
      reason ??= scrub(error?.message || String(error));
    }
  }
  return reason ? { revoked: false, issuer, reason } : { revoked: true, issuer };
}

function isGrantRejection(error) {
  return (
    error instanceof McpOAuthError &&
    (GRANT_REJECTIONS.has(error.oauthError) || [400, 401].includes(error.upstreamStatus))
  );
}

const isPreconditionFailure = (error) => error?.code === 412 || error?.statusCode === 412;

/**
 * Whether `latest` is still the connection `server` was refreshing: the same
 * place, the same sign-in method, still connected, with the same refresh
 * token. A write between the two that left all of that alone (a rename, a
 * status line) does not make the refresh stale; anything else does.
 */
function sameConnection(latest, server) {
  return (
    Boolean(latest) &&
    latest.url === server?.url &&
    latest.authType === server?.authType &&
    latest.oauth?.status === 'connected' &&
    latest.oauth?.resource === server?.oauth?.resource &&
    latest.oauthRefreshToken === server?.oauthRefreshToken
  );
}

/**
 * Whether `latest` holds a newer connection to the same resource than the
 * one `server` was refreshing: another instance refreshed (the refresh token
 * rotated) or the owner pressed Connect again. Its tokens are as good as a
 * refresh's, so they are used instead of clearing or overwriting them.
 */
function newerConnection(latest, server) {
  return (
    Boolean(latest) &&
    latest.url === server?.url &&
    latest.authType === server?.authType &&
    latest.oauth?.status === 'connected' &&
    latest.oauth?.resource === server?.oauth?.resource &&
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
async function markDisconnected({ store, serverId, server, now, message }) {
  const at = now().toISOString();
  const updates = {
    oauthToken: null,
    oauthRefreshToken: null,
    oauth: { ...(server.oauth || {}), status: 'disconnected', disconnectedAt: at, disconnectReason: 'refresh_failed' },
    status: 'needs_connection',
    lastError: message,
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
  return { ok: false, disconnected: true, message };
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
async function storeRefreshed({ store, serverId, server, updates, name }) {
  let current = server._etag ? server : await readServer(store, serverId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!sameConnection(current, server)) break;
    // A document without an ETag cannot be written safely, so it is not;
    // the stored token is used until the next try. Cosmos always sends one.
    if (!current._etag) {
      return { ok: false, transient: true, message: `${name}'s renewed sign-in could not be stored safely; the next call tries again.` };
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
    message: `${name} changed while its sign-in was being renewed, so the renewal was not kept. ${notConnectedMessage(current, serverId)}`,
  };
}

async function performRefresh({ store, serverId, server, http, now, log }) {
  const name = server?.name || serverId;
  const oauth = server?.oauth || {};
  const refreshToken = server?.oauthRefreshToken;
  const expiredMessage = `Sign-in to ${name} has expired. Press Connect on its card under AI Engine → MCP Servers to sign in again.`;
  if (!refreshToken) return markDisconnected({ store, serverId, server, now, message: expiredMessage });

  let tokens;
  try {
    requireHttpsUrl(oauth.tokenEndpoint, `${name}'s token endpoint`);
    const request = tokenRequest({
      params: { grant_type: 'refresh_token', refresh_token: refreshToken, resource: oauth.resource },
      clientId: oauth.clientId,
      tokenEndpointAuthMethod: oauth.tokenEndpointAuthMethod,
      clientSecret: server.oauthClientSecret ?? null,
    });
    const res = await http(oauth.tokenEndpoint, { method: 'POST', ...request });
    tokens = parseTokenResponse(res, { name, grant: 'token refresh', now });
  } catch (error) {
    if (!isGrantRejection(error)) {
      log?.warn?.(`[mcp-oauth] a token refresh did not complete: ${error?.message || error}`);
      return { ok: false, transient: true, message: error?.message || String(error) };
    }
    // Refresh tokens rotate: another instance may have spent this one a
    // moment ago and stored the next. Its result is as good as ours. The
    // disconnect below is guarded by the ETag of this read, so a rotation
    // stored after it is not cleared either (review of #1019).
    const latest = await readServer(store, serverId).catch(() => null);
    if (newerConnection(latest, server)) return { ok: true, server: latest };
    // Moved, switched or disconnected meanwhile: nothing of this connection
    // is left to clear, and writing would put a stale status on the new one.
    if (latest && !sameConnection(latest, server)) {
      return { ok: false, disconnected: true, message: notConnectedMessage(latest, serverId) };
    }
    log?.warn?.('[mcp-oauth] a token refresh was refused; marking the server disconnected');
    return markDisconnected({ store, serverId, server: latest || server, now, message: expiredMessage });
  }

  const updates = {
    oauthToken: tokens.accessToken,
    // Not every server rotates: no new refresh token means keep the old one.
    oauthRefreshToken: tokens.refreshToken || refreshToken,
    oauth: {
      ...oauth,
      status: 'connected',
      expiresAt: tokens.expiresAt,
      scope: tokens.scope ?? oauth.scope ?? null,
      refreshedAt: now().toISOString(),
    },
  };
  return storeRefreshed({ store, serverId, server, updates, name });
}

/** In-flight refreshes per server, so concurrent calls in one process spend a rotating refresh token once. */
const inflight = new Map();

/**
 * Refresh one server's access token with the standard refresh grant.
 * Resolves `{ ok: true, server }` with the updated document;
 * `{ ok: false, disconnected: true, message }` when the grant is dead (the
 * document is then marked as needing a connection, tokens cleared); or
 * `{ ok: false, transient: true, message }` when the server could not be
 * reached, which leaves everything as it was.
 */
export function refreshOAuthToken({ store, serverId, server, http, now = () => new Date(), log }) {
  if (inflight.has(serverId)) return inflight.get(serverId);
  const pending = performRefresh({ store, serverId, server, http, now, log }).finally(() =>
    inflight.delete(serverId)
  );
  inflight.set(serverId, pending);
  return pending;
}
