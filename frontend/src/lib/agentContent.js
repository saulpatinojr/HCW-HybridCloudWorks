/**
 * The Koda tab's calls (ADR 0037): one admin route, cms/agent-content/key.
 *
 *   readKodaKey()                 GET     the key's state, never the key   editor
 *   generateKodaKey()             POST    make or rotate; the answer carries
 *                                         `secret` ONCE                     super_admin
 *   setKodaCapabilities(switches) PATCH   what the key may do               super_admin
 *   revokeKodaKey()               DELETE  the next request with the old key
 *                                         is refused                        super_admin
 *
 * The secret in a Generate answer goes to the screen once, for the owner to
 * paste into the connector's secure page, and nowhere else: not to storage,
 * not to the console, not to a toast. The tab holds it in component state
 * until the owner dismisses it or leaves the tab.
 */
import { getJSON, postJSON, sendJSON } from '@/lib/api';
import { getFunctionsBase } from '@/lib/functionsBase';

export const KODA_KEY_ROUTE = 'cms/agent-content/key';

export function readKodaKey() {
  return getJSON(KODA_KEY_ROUTE);
}

export function generateKodaKey() {
  return postJSON(KODA_KEY_ROUTE, {});
}

export function setKodaCapabilities(capabilities) {
  return sendJSON(KODA_KEY_ROUTE, 'PATCH', { capabilities });
}

export function revokeKodaKey() {
  return sendJSON(KODA_KEY_ROUTE, 'DELETE');
}

/**
 * The address Muse registers and calls: the API host this build talks to,
 * plus the agent base path the API reports. Absolute when the build is
 * cross-origin (the production case, `https://api-azure.hybridcloudworks.com/api`);
 * when the build is same-origin (`/api`) the page's own origin is prefixed so
 * the owner can paste it as it stands.
 *
 * @param {string} basePath the API's `basePath`, e.g. `/api/agent-content/v1`
 * @returns {{ host: string, url: string }}
 */
export function kodaApiAddress(
  basePath,
  { functionsBase = getFunctionsBase(), origin = globalThis.location?.origin || '' } = {}
) {
  const base = String(functionsBase || '').replace(/\/api\/?$/, '');
  const root = /^https?:\/\//.test(base) ? base : `${origin}${base}`;
  const url = `${root}${basePath || ''}`;
  let host = '';
  try {
    ({ host } = new URL(url));
  } catch {
    host = '';
  }
  return { host, url };
}
