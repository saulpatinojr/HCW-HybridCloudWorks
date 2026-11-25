/**
 * mcp-oauth-discovery-rules.js — the pure rules of MCP OAuth discovery
 * (mcp-oauth.js): where the metadata documents live, which resource a
 * document covers, and when two issuers are the same. The reads that apply
 * them stay in mcp-oauth.js.
 */
import {
  McpOAuthError,
  bare,
  requireHttpsUrl,
  stringList,
} from './mcp-oauth-base.js';

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
 * Whether a protected resource's identifier names this MCP server: the same
 * origin, no query, and a path that is the server URL's path or a parent of
 * it (`https://mcp.replicate.com/` covers `/sse`). Replicate and Hostinger
 * both name their origin. RFC 9728 §3.3 asks for an exact match with the
 * identifier the well-known URI was built from; a parent path is accepted
 * because the origin-level document is the fallback this flow reads.
 */
export function coversServer(resource, server) {
  if (resource.origin !== server.origin || resource.search) return false;
  const base = resource.pathname.replace(/\/+$/, '');
  const path = server.pathname.replace(/\/+$/, '');
  return !base || path === base || path.startsWith(`${base}/`);
}

/**
 * An endpoint the flow can do without (RFC 8414 `revocation_endpoint`): its
 * https URL, or null when absent or not one this site would send a token to.
 * Not a refusal: a server that advertises a bad revocation address can still
 * be connected; its Disconnect then just has nowhere to revoke.
 */
export function optionalHttpsEndpoint(value) {
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
 * An authorization server's metadata document, checked: the issuer it names,
 * https endpoints, PKCE with S256, dynamic registration and the
 * authorization-code flow. The endpoints and options a sign-in uses, or a
 * McpOAuthError naming what is missing.
 */
export function authorizationServerOf(doc, { issuerUrl, name, metadataUrl }) {
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
    metadataUrl,
  };
}

/**
 * One unauthenticated MCP request, for the challenge it answers with. A
 * failure here is not a failure of the flow: the well-known URIs still work.
 */
export async function probeChallenge(serverUrl, http) {
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
