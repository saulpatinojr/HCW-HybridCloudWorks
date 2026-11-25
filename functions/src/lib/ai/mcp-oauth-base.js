/**
 * mcp-oauth-base.js — what every part of the MCP OAuth Connect flow
 * (mcp-oauth.js) shares: the redirect address and lifetimes, the errors a
 * sign-in can end in, and the small readers for JSON, URLs and lists.
 * mcp-oauth.js re-exports the public names.
 */
import { PRODUCTION_ORIGINS } from '../auth/cors.js';
import { AuthoredError, codeShaped } from '../http/error-response.js';
import { MCP_OAUTH_CALLBACK_PATH } from './mcp-policy.js';

export const MCP_CONTAINER = 'mcp_servers';

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
export const AUTH_METHODS = Object.freeze(['none', 'client_secret_basic', 'client_secret_post']);

/** Upstream OAuth error codes that mean the grant itself is dead, not the network. */
export const GRANT_REJECTIONS = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client']);

/**
 * A failure in the flow, carrying a sentence an owner can act on. `status` is
 * what this API answers for it; `upstreamStatus` and `oauthError` are what the
 * vendor said, kept so the refresh path can tell a dead grant from an outage.
 */
export class McpOAuthError extends AuthoredError {
  /**
   * @param {string} message - the authored sentence (#945: no provider sentence or socket text)
   * @param {object} [options] - status, upstreamStatus, oauthError, code
   */
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
export class McpOAuthNotConnectedError extends AuthoredError {
  /** @param {string} message - the authored "press Connect" sentence */
  constructor(message) {
    super(message);
    this.name = 'McpOAuthNotConnectedError';
    this.code = 'NOT_CONNECTED';
  }
}

export const base64url = (bytes) => Buffer.from(bytes).toString('base64url');
export const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export const stringList = (value) =>
  Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()) : [];

export function parseJson(text) {
  try {
    const value = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** A path of URL characters only, capped: all of a path an address may show. */
const PATH_SHAPE = /^\/[A-Za-z0-9._~%/-]{0,120}$/;

/**
 * An address for a sentence: `scheme://host/path`, with the scheme and the
 * host held to the door's code shape and the path to URL characters, and no
 * query, fragment or credentials; a fixed phrase for anything else. Most
 * addresses named here come from a provider's metadata, so nothing else of
 * them is repeated, and a value that is not a URL is never echoed (#945).
 *
 * @param {unknown} url - the address
 * @returns {string}
 */
export function bare(url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? ''));
  } catch {
    return 'an address that is not a URL';
  }
  const scheme = codeShaped(parsed.protocol.replace(/:$/, ''));
  const host = codeShaped(parsed.host);
  if (!scheme || !host) return 'an address that cannot be shown';
  return `${scheme}://${host}${PATH_SHAPE.test(parsed.pathname) ? parsed.pathname : '/(path not shown)'}`;
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
    // The value is not repeated: it is often a provider's metadata (#945).
    const blank = value === undefined || value === null || String(value).trim() === '';
    throw new McpOAuthError(`${what} is ${blank ? 'missing' : 'not a valid URL'}.`);
  }
  if (parsed.protocol !== 'https:') {
    throw new McpOAuthError(`${what} must be an https address; it is ${bare(parsed.href)}.`);
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new McpOAuthError(`${what} must not carry credentials or a fragment.`);
  }
  return parsed;
}
