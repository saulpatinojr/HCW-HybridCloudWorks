/**
 * mcp-oauth-discovery-rules.js — the pure rules of MCP OAuth discovery
 * (mcp-oauth.js): where the metadata documents live, which resource a
 * document covers, and when two issuers are the same. The reads that apply
 * them stay in mcp-oauth.js.
 */
import { requireHttpsUrl } from './mcp-oauth-base.js';

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
