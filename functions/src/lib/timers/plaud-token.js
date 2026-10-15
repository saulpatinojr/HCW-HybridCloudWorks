/**
 * plaud-token.js — `refreshPlaudToken`, every 12 hours: rotates the Plaud MCP
 * OAuth access token stored on `mcp_servers/plaud` using its refresh token
 * (Plaud returns a new pair each time; access ~24 h, refresh ~7 days). A
 * failed refresh flips the document to `disconnected` so the admin UI shows
 * the reconnect prompt.
 *
 * A document with an access token but NO refresh token is not a failure:
 * until 2026-09-05 the Connect tab stored only the access token, and this
 * timer used to mark such a document disconnected every 12 hours — which
 * would have broken a working Library the moment the timer was armed. It now
 * warns and leaves the document alone; the access token expires on its own
 * schedule and the Connect tab says whether auto-refresh is armed.
 *
 * These are the Plaud MCP tokens (the `third-party` OAuth flow behind
 * `npx @plaud-ai/mcp install`), not Plaud Embedded's client id and secret —
 * that is a different product (device SDK and transcription API) and nothing
 * here uses it.
 *
 * Ported from Site-Main index.js (088f458). The tokens live in the document,
 * as they did upstream — no app secret is involved.
 *
 * Since 2026-10-08 the timer runs this as one half of the MCP OAuth token
 * refresh (mcp-token-refresh.js); the other half is the standard refresh
 * grant for servers connected through OAuth Connect. Plaud stays here
 * because its endpoint is not the standard one.
 *
 * `lastTokenRefreshError` is shown on the Connect tab, so it holds a sentence
 * with the HTTP status and Plaud's OAuth `error` code, or the error's code
 * and a log line's reference, never Plaud's body or a socket's text (#945).
 */
import { AuthoredError, codeShaped, recordedFailure } from '../http/error-response.js';

/**
 * ` invalid_grant` when the refused answer carried an OAuth `error` code,
 * else nothing.
 *
 * @param {string} body - the response text
 * @returns {string}
 */
function oauthCodeNote(body) {
  try {
    const code = codeShaped(JSON.parse(body)?.error);
    return code ? ` ${code}` : '';
  } catch {
    return '';
  }
}

export const PLAUD_REFRESH_URL =
  'https://platform.plaud.ai/developer/api/oauth/third-party/access-token/refresh';

/**
 * Build the Plaud MCP token refresh.
 *
 * @param {object} deps
 * @param {{ readDoc: Function, patchDoc: Function }} deps.store
 * @param {typeof fetch} [deps.fetch]
 * @param {() => Date} [deps.now]
 * @param {{ log?: Function, warn?: Function, error?: Function }} [deps.log]
 * @returns {{ run: () => Promise<{ ok: boolean, reason?: string, expiresInSec?: number }> }}
 */
export function createPlaudTokenRefresh({
  store,
  fetch: fetchImpl = globalThis.fetch,
  now = () => new Date(),
  log = {},
}) {
  const patch = (updates) => store.patchDoc('mcp_servers', 'plaud', updates);

  /**
   * Rotate the pair, or mark the connection disconnected with a stored
   * sentence: Plaud's status and OAuth code, or the error's code and a
   * reference, never Plaud's body (#945).
   *
   * @returns {Promise<{ ok: boolean, reason?: string, expiresInSec?: number }>}
   */
  async function run() {
    const doc = await store.readDoc('mcp_servers', 'plaud', 'plaud');
    if (!doc) {
      log.warn?.('[refreshPlaudToken] mcp_servers/plaud not found');
      return { ok: false, reason: 'missing_doc' };
    }
    const refreshToken = doc.oauthRefreshToken;
    if (!refreshToken) {
      log.warn?.(
        '[refreshPlaudToken] no oauthRefreshToken stored; leaving the access token as it is'
      );
      return { ok: false, reason: 'missing_refresh_token' };
    }
    try {
      const res = await fetchImpl(PLAUD_REFRESH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({ refresh_token: refreshToken }).toString(),
      });
      const body = await res.text();
      if (!res.ok) {
        log.error?.(`[refreshPlaudToken] failed: HTTP ${res.status}`);
        await patch({
          status: 'disconnected',
          lastTokenRefreshError: `Plaud refused the token refresh (HTTP ${res.status}${oauthCodeNote(body)}).`,
        });
        return { ok: false, reason: `http_${res.status}` };
      }
      const parsed = JSON.parse(body);
      if (!parsed.access_token) throw new AuthoredError('Plaud answered without an access token.');
      const expiresInSec = Number(parsed.expires_in) || 86400;
      await patch({
        oauthToken: parsed.access_token,
        oauthRefreshToken: parsed.refresh_token || refreshToken,
        oauthExpiresAt: now().getTime() + expiresInSec * 1000,
        status: 'connected',
        lastTokenRefresh: now().toISOString(),
        lastTokenRefreshError: null,
      });
      log.log?.(`[refreshPlaudToken] success (expires in ${expiresInSec}s)`);
      return { ok: true, expiresInSec };
    } catch (err) {
      await patch({
        status: 'disconnected',
        lastTokenRefreshError: recordedFailure(log, 'The token refresh failed.', err),
      });
      return { ok: false, reason: 'exception' };
    }
  }
  return { run };
}
