/**
 * mcp-policy.js — what an MCP server document may name, and how its
 * credential is resolved (ADR 0033, security finding). Split from mcp.js,
 * which re-exports everything here, so the transport and the policy read as
 * two pages. Every check is the same as it was in mcp.js: a disallowed key
 * name resolves to no header, a plain-http URL is refused, and an unresolved
 * Key Vault reference is not a secret.
 *
 * 2026-10-08: the loopback-http exception and the lab-host token's localhost
 * binding are gone, and that token is no longer an MCP key name at all. Both
 * existed for one seeded server, Hostinger at http://localhost:8100,
 * which nothing ever listened on — a Function App has no localhost MCP server
 * — and which now points at Hostinger's hosted server and signs in with OAuth
 * (mcp-oauth.js). Every MCP URL is https, with no exception.
 */

/**
 * Treat an environment value as a usable secret only when it is resolved.
 * Azure Key Vault references that fail to resolve arrive as a literal string;
 * sending that literal as a bearer token creates a misleading upstream 401.
 */
export function readMcpSecret(env, name) {
  if (!name || typeof env?.[name] !== 'string') return '';
  const value = env[name].replace(/^﻿/, '').trim();
  if (!value || value.startsWith('@Microsoft.KeyVault(')) return '';
  return value;
}

/**
 * The app settings an MCP server may name as its bearer key (ADR 0033,
 * security finding). Until this, `apiKeyEnvVar` was any string: an editor
 * could save a custom server at a URL they control with
 * `apiKeyEnvVar: "COSMOS_CONNECTION_STRING"` and receive that setting as a
 * Bearer header on the next Sync. The allowlist is the MCP_* namespace plus
 * the integration keys the seeded servers already use; anything else is
 * refused at save time and again at call time.
 *
 * REPLICATE_API_KEY stays listed although the seeded Replicate MCP server no
 * longer names it (2026-10-08: that server accepts only its own OAuth
 * tokens). The key itself still serves Replicate's REST API for cover images,
 * and its binding below keeps it at Replicate's hosts if a server names it.
 */
export const MCP_KEY_ENV_PATTERN = /^MCP_[A-Z0-9_]+$/;
export const KNOWN_INTEGRATION_KEY_NAMES = Object.freeze([
  'FIRECRAWL_API_KEY',
  // Usable only with a tool allowlist (TOOL_ALLOWLIST_REQUIRED_KEYS below):
  // Publer's MCP can publish and delete, so the key alone is not enough.
  'PUBLER_API_KEY',
  'REPLICATE_API_KEY',
]);

/**
 * Where each shared integration key may be sent (estate review 2026-10-06,
 * finding AP-B1). The allowlist above stopped an editor naming the Cosmos
 * connection string, but it still let the three keys the seeded servers use
 * be routed anywhere: save a server at `https://attacker.example/` with
 * `apiKeyEnvVar: "FIRECRAWL_API_KEY"`, press Sync, and the key arrives as a
 * bearer. So each shared key is bound to the hosts its vendor actually serves
 * from, and a server naming the key at any other host is refused at save
 * time and again at call time. `MCP_*` settings are per-server secrets the
 * owner creates for one server, so they bind to no host.
 */
export const INTEGRATION_KEY_HOSTS = Object.freeze({
  FIRECRAWL_API_KEY: Object.freeze(['mcp.firecrawl.dev', 'api.firecrawl.dev']),
  // Publer's MCP server only (2026-10-07). The same key also opens Publer's
  // REST API at app.publer.com, but that is publerProxy's route, not an MCP
  // server's, so it is deliberately not listed: the MCP binding is one host.
  PUBLER_API_KEY: Object.freeze(['mcp.publer.com']),
  REPLICATE_API_KEY: Object.freeze(['mcp.replicate.com', 'api.replicate.com']),
});

/**
 * The hostname of a URL, lower-cased, or null when it does not parse. Used
 * for the binding check only; `validateMcpUrl` is the URL rule.
 */
function hostOf(url) {
  try {
    return new URL(String(url || '').trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Refuse a shared integration key at a host it is not bound to. Returns the
 * key name (or null for no key); throws with the binding in the message.
 * A server with an `MCP_*` key, or no key, passes for any URL.
 */
export function validateMcpKeyBinding({ url, apiKeyEnvVar }) {
  const keyName = validateMcpApiKeyEnvVar(apiKeyEnvVar);
  const hosts = keyName ? INTEGRATION_KEY_HOSTS[keyName] : null;
  if (!hosts) return keyName;
  const host = hostOf(url);
  if (host && hosts.includes(host)) return keyName;
  throw new Error(
    `${keyName} may only be sent to ${hosts.join(', ')}; "${host || String(url || '')}" is not one of them`
  );
}

/**
 * Validate the name of the app setting a server reads its key from. Empty
 * (no key, or OAuth) is fine and returns null; a name outside the allowlist
 * throws with the rule in the message.
 */
export function validateMcpApiKeyEnvVar(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new Error('apiKeyEnvVar must be a string app-setting name or empty');
  }
  const name = value.trim();
  if (!name) return null;
  if (MCP_KEY_ENV_PATTERN.test(name) || KNOWN_INTEGRATION_KEY_NAMES.includes(name)) {
    return name;
  }
  throw new Error(
    `apiKeyEnvVar must be an MCP_* app setting or one of ${KNOWN_INTEGRATION_KEY_NAMES.join(', ')}; "${name}" is not allowed`
  );
}

/**
 * Shared keys whose servers may only call the tools their document names in
 * `allowedTools` (#995, 2026-10-07). Publer's MCP server can create,
 * schedule, publish and delete posts, and `mcpProxy` needs only the editor
 * role, so without a list any editor could publish through it, past the
 * Social Hub's own publishing rules. A server naming one of these keys must
 * carry a non-empty `allowedTools`; a missing or empty list is refused at
 * save time and every call to such a server is refused at call time.
 */
export const TOOL_ALLOWLIST_REQUIRED_KEYS = Object.freeze(['PUBLER_API_KEY']);

const keyNameOf = (apiKeyEnvVar) => (typeof apiKeyEnvVar === 'string' ? apiKeyEnvVar.trim() : '');

/** Whether a server naming this key must carry `allowedTools`. */
export function requiresToolAllowlist(apiKeyEnvVar) {
  return TOOL_ALLOWLIST_REQUIRED_KEYS.includes(keyNameOf(apiKeyEnvVar));
}

/**
 * The shape of `allowedTools`: absent (undefined or null) returns null, which
 * means no list; otherwise an array of non-empty tool names, returned
 * trimmed. Anything else throws, so a malformed list fails closed.
 */
export function validateMcpAllowedTools(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((name) => typeof name !== 'string' || !name.trim())) {
    throw new Error('allowedTools must be an array of tool names');
  }
  return value.map((name) => name.trim());
}

/**
 * The key and the tool list as a pair: the list's shape, and a non-empty
 * list where the key requires one. Returns the list (or null for none).
 */
export function validateMcpToolPolicy({ apiKeyEnvVar, allowedTools }) {
  const list = validateMcpAllowedTools(allowedTools);
  if (requiresToolAllowlist(apiKeyEnvVar) && (!list || list.length === 0)) {
    throw new Error(
      `a server using ${keyNameOf(apiKeyEnvVar)} must name the tools it may call in allowedTools`
    );
  }
  return list;
}

/**
 * Why a tool call on this server is refused, or null when it may go ahead.
 * Checked before any upstream request, whatever the caller's role.
 *
 * A server with no `allowedTools` may call any tool name, which is exactly
 * what every server could do before #995: `mcpProxy` has never limited a
 * call to the synced tool list, so Firecrawl, the OAuth servers and keyless
 * or `MCP_*` servers keep that behaviour until someone gives them a list.
 * A server that does carry a list is held to it, an empty one
 * included. A server whose key requires a list and has none refuses every
 * call.
 */
export function mcpToolRefusal({ serverId, server, tool }) {
  let list;
  try {
    list = validateMcpToolPolicy({
      apiKeyEnvVar: server?.apiKeyEnvVar,
      allowedTools: server?.allowedTools,
    });
  } catch (error) {
    return `Tool "${tool}" refused on MCP server "${serverId}": ${error.message}`;
  }
  if (list === null || list.includes(tool)) return null;
  return `Tool "${tool}" is not in the allowedTools of MCP server "${serverId}"`;
}

/**
 * Resolve OAuth first, then the configured Azure Function App setting. The
 * server's `url` is part of the decision since AP-B1: a shared integration
 * key resolves to no header unless the URL's host is one the key is bound
 * to, so a document that slipped past save-time (written before the
 * binding, or by hand) still sends nothing.
 */
export function resolveMcpAuthHeaders({ oauthToken, apiKeyEnvVar, url, env = process.env }) {
  const stored = typeof oauthToken === 'string' ? oauthToken.replace(/^﻿/, '').trim() : '';
  // A disallowed name resolves to no header, never to the setting it names:
  // the save-time check is the first line, this is the one that holds for a
  // document written before the allowlist existed.
  let keyName = null;
  try {
    keyName = validateMcpKeyBinding({ url, apiKeyEnvVar });
  } catch {
    keyName = null;
  }
  const bearerToken = stored || readMcpSecret(env, keyName);
  return bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {};
}

/**
 * Hosts whose MCP URL may carry no query string (2026-10-07). Publer's
 * settings page hands out its server URL as `https://mcp.publer.com?api_key=`
 * followed by the key, and its server accepts the key that way. Pasted into
 * the URL field, the key would sit in Cosmos in plain text, be returned on
 * every read of the server list, and be copied into the audit row's
 * before/after. The key belongs in PUBLER_API_KEY, which the server reads
 * from Key Vault and sends as a header, and Publer's MCP takes no other
 * query parameter, so any query on this host is refused.
 */
const NO_QUERY_HOSTS = new Set(['mcp.publer.com']);

/**
 * Reject malformed or credential-bearing URLs before making an outbound call.
 * https is required (ADR 0033): a bearer token over plain http is readable on
 * the wire. There is no loopback exception any more (2026-10-08): it served
 * only the seeded Hostinger entry at localhost, which a Function App could
 * never reach.
 */
export function validateMcpUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new Error('MCP server URL must be a valid URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('MCP server URL must use https');
  }
  if (parsed.username || parsed.password) {
    throw new Error('MCP server URL must not contain embedded credentials');
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    host === '0.0.0.0' ||
    host.startsWith('127.')
  ) {
    throw new Error('MCP server URL must not target loopback addresses');
  }
  if (NO_QUERY_HOSTS.has(parsed.hostname) && parsed.search) {
    throw new Error(
      `MCP server URL for ${parsed.hostname} must not carry a query string; the key goes in its app setting, not the URL`
    );
  }
  return parsed.toString();
}

/**
 * Where a vendor's sign-in sends the browser back to, on the site origin
 * (mcp-oauth.js builds the full redirect URI). The admin SPA serves the page
 * at this path; frontend/src/lib/aiEngine.test.js holds the two together.
 */
export const MCP_OAUTH_CALLBACK_PATH = '/admin/ai-engine/oauth/callback';

/**
 * Servers marked `authType: 'oauth'` whose token is NOT obtained by Connect:
 * Plaud's is pasted on the Recording Hub's Connect tab and refreshed by
 * Plaud's own non-standard endpoint (lib/timers/plaud-token.js).
 */
export const PASTED_TOKEN_SERVER_IDS = Object.freeze(['plaud']);

/**
 * Whether a server signs in through the generic OAuth Connect flow
 * (mcp-oauth.js): marked `authType: 'oauth'` and not one of the pasted-token
 * servers. Such a server is never called without a live connection, and its
 * token is refreshed with the standard refresh grant.
 */
export function usesOAuthConnect(server) {
  return server?.authType === 'oauth' && !PASTED_TOKEN_SERVER_IDS.includes(server?.id);
}
