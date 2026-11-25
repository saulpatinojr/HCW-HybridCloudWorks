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
import { randomBytes } from 'node:crypto';
import { guardedFetch } from '../http/guarded-fetch.js';
import { authoredMessage, errorCode } from '../http/error-response.js';
import { outsideJob } from '../job-context.js';
import { validateMcpUrl } from './mcp-policy.js';
import {
  MCP_OAUTH_REDIRECT_URI,
  McpOAuthError,
  PENDING_TTL_MS,
  bare,
  base64url,
  parseJson,
  requireHttpsUrl,
  stringList,
} from './mcp-oauth-base.js';
import {
  buildAuthorizationUrl,
  codeChallengeS256,
  createCodeVerifier,
  describeOAuthReply,
  hashState,
  registerClient,
  reusableClient,
} from './mcp-oauth-client.js';
import { parseTokenResponse, tokenRequest } from './mcp-oauth-tokens.js';
import {
  afterRefusedRefresh,
  isGrantRejection,
  markDisconnected,
  storeRefreshed,
} from './mcp-oauth-refresh-store.js';

export {
  MCP_OAUTH_CLIENT_NAME,
  MCP_OAUTH_REDIRECT_URI,
  McpOAuthError,
  McpOAuthNotConnectedError,
  PENDING_TTL_MS,
  REFRESH_SKEW_MS,
  requireHttpsUrl,
} from './mcp-oauth-base.js';
export {
  buildAuthorizationUrl,
  chooseTokenEndpointAuthMethod,
  codeChallengeS256,
  createCodeVerifier,
  hashState,
  registrationRequestBody,
  reusableClient,
} from './mcp-oauth-client.js';
export {
  connectedUpdates,
  exchangeAuthorizationCode,
  notConnectedMessage,
  oauthConnectionState,
  parseTokenResponse,
  tokenExpiresWithin,
  tokenRequest,
} from './mcp-oauth-tokens.js';

/**
 * Why an outbound request got no usable answer, in this module's words: the
 * guard's own refusal sentence, or the failure's code — never a socket's
 * text (#945).
 *
 * @param {string} url - the address that was asked
 * @param {unknown} error - what guardedFetch threw
 * @returns {string}
 */
function describeFetchFailure(url, error) {
  const where = bare(url);
  if (error?.code === 'FETCH_TIMEOUT') return `${where} did not answer in time.`;
  if (error?.code === 'REDIRECT_LIMIT' || error?.code === 'REDIRECT_NO_LOCATION') {
    return `${where} answered with a redirect, which this sign-in does not follow.`;
  }
  if (error?.refused) {
    return `${where} is not an address this site fetches (${authoredMessage(error, 'refused')}).`;
  }
  if (error?.code === 'BODY_TOO_LARGE') return `${where} answered with more data than expected.`;
  return `${where} could not be reached (${errorCode(error?.cause ?? error)}).`;
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

/**
 * A metadata document no candidate address answered.
 *
 * @param {string} name - the server's name
 * @param {string} what - the document
 * @param {unknown} failure - the last McpOAuthError (authored)
 * @returns {McpOAuthError}
 */
function unreachable(name, what, failure) {
  return new McpOAuthError(
    `${name}'s ${what} could not be read: ${authoredMessage(failure, 'no address answered.')}`,
    { code: 'UNREACHABLE' }
  );
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
    throw new McpOAuthError(`${name}: ${authoredMessage(error, 'the server URL was refused.')}`, {
      status: 400,
      code: 'BAD_URL',
    });
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
    return { revoked: false, issuer, reason: authoredMessage(error, `${name}'s revocation endpoint was refused.`) };
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
      reason ??= scrub(authoredMessage(error, `${bare(endpoint)} could not be reached for the revocation.`));
    }
  }
  return reason ? { revoked: false, issuer, reason } : { revoked: true, issuer };
}

/**
 * One token refresh against the server's token endpoint: the stored tokens
 * on success, or `{ ok: false, sentence }` with an authored sentence (#945).
 *
 * @param {object} args - store, serverId, server, http, now, log
 * @returns {Promise<object>}
 */
async function performRefresh({ store, serverId, server, http, now, log }) {
  const name = server?.name || serverId;
  const oauth = server?.oauth || {};
  const refreshToken = server?.oauthRefreshToken;
  const expiredMessage = `Sign-in to ${name} has expired. Press Connect on its card under AI Engine → MCP Servers to sign in again.`;
  if (!refreshToken) return markDisconnected({ store, serverId, server, now, sentence: expiredMessage });

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
      log?.warn?.(`[mcp-oauth] a token refresh did not complete (${errorCode(error)})`);
      return {
        ok: false,
        transient: true,
        sentence: authoredMessage(error, `The sign-in to ${name} could not be renewed just now.`),
      };
    }
    return afterRefusedRefresh({ store, serverId, server, now, log, sentence: expiredMessage });
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
 * `{ ok: false, disconnected: true, sentence }` when the grant is dead (the
 * document is then marked as needing a connection, tokens cleared); or
 * `{ ok: false, transient: true, sentence }` when the server could not be
 * reached, which leaves everything as it was.
 *
 * The refresh is shared by every caller in the process, so it runs outside
 * any platform job's context (job-context.js `outsideJob`, #942): a refresh
 * a job happened to start must not carry that job's abort to a route that
 * joins it.
 *
 * @param {object} deps
 * @param {{ readDoc: Function, patchDoc: Function }} deps.store
 * @param {string} deps.serverId
 * @param {object} deps.server the server document as the caller read it
 * @param {Function} deps.http
 * @param {() => Date} [deps.now]
 * @param {{ warn?: Function }} [deps.log]
 * @returns {Promise<object>}
 */
export function refreshOAuthToken({ store, serverId, server, http, now = () => new Date(), log }) {
  if (inflight.has(serverId)) return inflight.get(serverId);
  const pending = outsideJob(() => performRefresh({ store, serverId, server, http, now, log })).finally(
    () => inflight.delete(serverId)
  );
  inflight.set(serverId, pending);
  return pending;
}
