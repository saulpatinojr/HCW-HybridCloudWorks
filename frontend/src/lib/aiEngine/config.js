/**
 * AI Engine — config routes, subscriptions and the writes on providers and
 * MCP servers. Imported through `@/lib/aiEngine`, which re-exports it.
 *
 * Config reads note: mcp_servers documents carry hasOauthToken (boolean)
 * instead of the token itself — the value is write-only on the API.
 */
import { getJSON, sendJSON } from '@/lib/api';

/**
 * Route keys for the config API. Callers historically pass the container
 * names ('ai_providers'/'mcp_servers'), so both spellings resolve.
 */
const CONFIG_ROUTES = {
  ai_providers: 'ai-providers',
  'ai-providers': 'ai-providers',
  mcp_servers: 'mcp-servers',
  'mcp-servers': 'mcp-servers',
};

export function configRoute(colName) {
  const route = CONFIG_ROUTES[colName];
  if (!route) throw new Error(`Unknown config collection: ${colName}`);
  return route;
}

export async function fetchConfig(route) {
  const res = await getJSON(`cms/config/${route}`);
  return res.items || [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Config subscriptions
//
// Realtime config listeners use fetch-plus-notify:
// every subscriber gets the current list on subscribe, and every write helper
// in this module re-fetches and re-notifies after it lands. Same reactive UX
// on the admin pages, no polling.
// ─────────────────────────────────────────────────────────────────────────────

const configSubscribers = {
  'ai-providers': new Set(),
  'mcp-servers': new Set(),
};

export async function notifyConfigSubscribers(route) {
  if (configSubscribers[route].size === 0) return;
  try {
    const items = await fetchConfig(route);
    configSubscribers[route].forEach((callback) => callback(items));
  } catch (err) {
    console.error(`[aiEngine] refresh of ${route} failed:`, err);
  }
}

function subscribeConfig(route, callback) {
  configSubscribers[route].add(callback);
  fetchConfig(route)
    .then((items) => {
      if (configSubscribers[route].has(callback)) callback(items);
    })
    .catch((err) => console.error(`[aiEngine] load of ${route} failed:`, err));
  return () => configSubscribers[route].delete(callback);
}

/** Listener on ai_providers, sorted by order (server-sorted). */
export function subscribeProviders(callback) {
  return subscribeConfig('ai-providers', callback);
}

/** Listener on mcp_servers, sorted by order (server-sorted). */
export function subscribeMcpServers(callback) {
  return subscribeConfig('mcp-servers', callback);
}

/** Toggle enable flag on a provider or MCP server. */
export async function setEnabled(colName, docId, enabled) {
  const route = configRoute(colName);
  await sendJSON(`cms/config/${route}/${docId}`, 'PATCH', { enabled });
  await notifyConfigSubscribers(route);
}

/** Add a custom MCP server. */
export async function addMcpServer(data) {
  const id = crypto.randomUUID();
  await sendJSON(`cms/config/mcp-servers/${id}`, 'PUT', {
    ...data,
    tools: [],
    status: 'untested',
  });
  await notifyConfigSubscribers('mcp-servers');
  return id;
}

/**
 * Store an OAuth access token for an MCP server (e.g. Plaud).
 * The API accepts the write but never returns the value on any read —
 * reads carry hasOauthToken (boolean) instead. Only mcpProxy uses the token
 * server-side.
 */
export async function setMcpOAuthToken(serverId, oauthToken, oauthRefreshToken = '') {
  // The refresh token is what the 12-hour refreshPlaudToken timer rotates
  // with. It is optional here so an access token alone still connects; when
  // omitted the stored refresh token (if any) is left untouched, because the
  // API merges a PATCH and never clears a field it was not sent.
  const body = {
    oauthToken,
    status: 'untested', // force re-test after token update
  };
  if (typeof oauthRefreshToken === 'string' && oauthRefreshToken.trim()) {
    body.oauthRefreshToken = oauthRefreshToken.trim();
  }
  await sendJSON(`cms/config/mcp-servers/${serverId}`, 'PATCH', body);
  await notifyConfigSubscribers('mcp-servers');
}

/** Delete a custom MCP server (only non-seed servers). */
export async function removeMcpServer(serverId) {
  await sendJSON(`cms/config/mcp-servers/${serverId}`, 'DELETE');
  await notifyConfigSubscribers('mcp-servers');
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuth Connect for remote MCP servers (2026-10-08)
//
// Replicate's and Hostinger's hosted servers accept only tokens their own
// sign-in issues. Connect asks the API to start that sign-in, and the browser
// goes to the vendor; the vendor sends it back to the callback page, which
// hands the code to `completeMcpOAuth`. Tokens never reach the browser.
// ─────────────────────────────────────────────────────────────────────────────

/** Start a sign-in. Returns the vendor URL to send the browser to. */
export async function startMcpOAuth(serverId) {
  const res = await sendJSON(`cms/mcp/${encodeURIComponent(serverId)}/oauth/start`, 'POST', {});
  return res.authorizationUrl;
}

/**
 * Finish a sign-in with what the vendor's redirect carried: `code`, `state`
 * and, from servers that send it, `iss` (RFC 9207), which the API checks
 * against the issuer the sign-in started with. Resolves
 * `{ connected, serverId, serverName, toolCount, syncError? }`.
 */
export async function completeMcpOAuth({ state, code, iss }) {
  const res = await sendJSON('cms/mcp/oauth/complete', 'POST', {
    state,
    code,
    ...(iss ? { iss } : {}),
  });
  await notifyConfigSubscribers('mcp-servers');
  return res;
}

/**
 * Forget a server's sign-in: its tokens and connection, server-side. Where
 * the provider advertises a revocation endpoint the API revokes the grant
 * there first (#1116). Resolves `{ disconnected, revoked, issuer, reason? }`:
 * `revoked` is true, false (the grant may still be live at `issuer`; `reason`
 * says why) or null (the provider offers no revocation).
 */
export async function disconnectMcpOAuth(serverId) {
  const res = await sendJSON(
    `cms/mcp/${encodeURIComponent(serverId)}/oauth/disconnect`,
    'POST',
    {}
  );
  await notifyConfigSubscribers('mcp-servers');
  return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// The model catalogue (ADR 0034 slice 2, #857) — admin_settings/ai-model-catalog
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every provider's model list as the API holds it, with `stale` per provider
 * and the router's defaults seeded for a provider never refreshed. The page
 * merges it onto the provider cards (aiEngine/catalog.js withCatalogModels).
 */
export async function fetchModelCatalog() {
  const res = await getJSON('cms/ai-model-catalog');
  return res.catalog || { providers: {} };
}

/**
 * Hide or show one model on its card. The model id travels URL-encoded —
 * NVIDIA's carry a slash — and the API decodes it. Returns the stored entry.
 */
export async function setModelHidden(providerId, model, hidden) {
  const route = `cms/ai-model-catalog/${encodeURIComponent(providerId)}/${encodeURIComponent(model)}`;
  const res = await sendJSON(route, 'PATCH', { hidden: Boolean(hidden) });
  return res.model || null;
}

/**
 * List every provider with a key now, rather than waiting for the weekly
 * probe. Returns the summary: per provider `{ listed, added, retired, error }`,
 * or `{ skipped: true }` for one with no key.
 */
export async function refreshModelCatalog() {
  const res = await sendJSON('cms/ai-model-catalog/refresh', 'POST', {});
  return res.summary || { providers: {} };
}
