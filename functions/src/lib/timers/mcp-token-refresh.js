/**
 * mcp-token-refresh.js — what the `refreshPlaudToken` timer runs since
 * 2026-10-08: the MCP OAuth token refresh, of which Plaud is one half.
 *
 *   1. Plaud's own refresh, unchanged (plaud-token.js). Plaud's endpoint is
 *      not the standard refresh grant, so it keeps its own path and is never
 *      routed through the one below.
 *   2. The standard refresh grant (ai/mcp-oauth.js) for every server
 *      connected through OAuth Connect whose access token expires within 30
 *      minutes — or already has, which over a 12-hour schedule is the usual
 *      case for an hour-long token. An idle server's refresh token is
 *      thereby spent and renewed at least once a day, so a vendor whose
 *      refresh tokens lapse after days unused does not quietly disconnect.
 *
 * WHY THE PLAUD TIMER AND NOT A NEW ONE. A timer is armed by naming its flag
 * suffix in the `enabled_timers` workspace variable, and a new suffix must
 * also be added to `local.timer_catalogue` (infra/functionapp.tf) and the
 * validation list in infra/variables.tf — a Terraform change and a TFC
 * apply by the owner. Extending this one keeps its name, its flag
 * (FEATURE_FLAG_REFRESH_PLAUD_TOKEN) and its schedule, so nothing needs
 * re-arming. Requests about to use a token never wait for this timer
 * anyway: mcp.js refreshes on demand two minutes before expiry and on a 401.
 *
 * One server failing never stops the others; each half reports its own
 * summary.
 */
import { createOAuthHttp, refreshOAuthToken, tokenExpiresWithin } from '../ai/mcp-oauth.js';
import { usesOAuthConnect } from '../ai/mcp-policy.js';
import { createPlaudTokenRefresh } from './plaud-token.js';
import { errorFacts, errorCode } from '../http/error-response.js';

/** The timer refreshes a connected server whose token has less than this left. */
export const TIMER_REFRESH_WINDOW_MS = 30 * 60_000;

/** The summary field one refresh's result counts towards. */
const outcomeField = (result) => {
  if (result.ok) return 'refreshed';
  return result.disconnected ? 'disconnected' : 'failed';
};

/** Refresh one connected server whose token is due, counting the outcome. */
async function refreshOne(d, server, summary) {
  try {
    const result = await refreshOAuthToken({
      store: d.store,
      serverId: server.id,
      server,
      http: d.oauthHttp,
      now: d.now,
      log: d.log,
    });
    summary[outcomeField(result)] += 1;
  } catch (error) {
    summary.failed += 1;
    d.log.error?.(`[refreshPlaudToken] an OAuth Connect refresh threw: ${errorFacts(error)}`);
  }
}

async function refreshConnectedServers(d) {
  const rows = await d.store.queryDocs(
    'mcp_servers',
    "SELECT * FROM c WHERE c.oauth.status = 'connected'",
    []
  );
  const summary = { checked: 0, refreshed: 0, notDue: 0, disconnected: 0, failed: 0 };
  for (const server of rows || []) {
    if (!usesOAuthConnect(server) || server?.oauth?.status !== 'connected') continue;
    summary.checked += 1;
    if (!tokenExpiresWithin(server, TIMER_REFRESH_WINDOW_MS, d.now)) {
      summary.notDue += 1;
      continue;
    }
    await refreshOne(d, server, summary);
  }
  return summary;
}

async function run(d, plaud) {
  const { log } = d;
  let plaudResult;
  try {
    plaudResult = await plaud.run();
  } catch (error) {
    log.error?.(`[refreshPlaudToken] Plaud refresh threw: ${errorFacts(error)}`);
    plaudResult = { ok: false, reason: 'exception' };
  }
  let oauth;
  try {
    oauth = await refreshConnectedServers(d);
  } catch (error) {
    log.error?.(`[refreshPlaudToken] OAuth refresh sweep failed: ${errorFacts(error)}`);
    oauth = { error: errorCode(error) };
  }
  return { plaud: plaudResult, oauth };
}

export function createMcpTokenRefresh({
  store,
  fetch,
  oauthHttp = createOAuthHttp(),
  now = () => new Date(),
  log = {},
}) {
  const plaud = createPlaudTokenRefresh({ store, fetch, now, log });
  const d = { store, oauthHttp, now, log };
  return { run: () => run(d, plaud) };
}
