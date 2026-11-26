/**
 * The Cloudflare page's calls (#1905): the admin routes under
 * `cms/cloudflare/`, which call Cloudflare's API on the server with the
 * admin token. The token never reaches the browser, and nothing here can
 * delete: the API has no delete route.
 *
 *   readCloudflareStatus()               GET   whether it is set up, the zone,
 *                                              what the token can read, and
 *                                              what is locked              editor
 *   readCloudflareSettings()             GET   every zone setting          editor
 *   saveCloudflareSetting(id, value)     PATCH one zone setting           super_admin
 *   purgeCloudflareCache(request)        POST  everything, or 1–30 URLs   super_admin
 *   readCloudflareDns()                  GET   every DNS record            editor
 *   createCloudflareDnsRecord(record)    POST  a new record               super_admin
 *   updateCloudflareDnsRecord(id, patch) PATCH change a record            super_admin
 *   readCloudflareRulesets()             GET   the zone's rulesets         editor
 *   readCloudflarePhase(phase)           GET   one phase's rules           editor
 *   replaceCloudflarePhase(phase, body)  PUT   replace a phase's rules    super_admin
 *
 * Every id that goes into a path is checked here first, with the same rule
 * the server uses, so a bad value is a sentence on screen rather than a
 * request; the server checks again, and decides what is locked.
 */
import { getJSON, postJSON, sendJSON } from '@/lib/api';

const BASE = 'cms/cloudflare';

/** The server's rule for a setting id (cloudflare-http.js). */
export const SETTING_ID = /^[a-z0-9_]{1,64}$/;
/** The server's rule for a rule phase. */
export const PHASE_ID = /^[a-z_]{1,64}$/;
/** The most addresses one purge may name. */
export const MAX_PURGE_FILES = 30;

/** The code the API answers with while the token or zone id is not set. */
export const NOT_CONFIGURED = 'CLOUDFLARE_NOT_CONFIGURED';

function checked(pattern, value, what) {
  const text = String(value ?? '');
  if (!pattern.test(text)) throw new Error(`That is not a valid ${what}.`);
  return encodeURIComponent(text);
}

export function readCloudflareStatus() {
  return getJSON(`${BASE}/status`);
}

export function readCloudflareSettings() {
  return getJSON(`${BASE}/settings`);
}

export function saveCloudflareSetting(settingId, value) {
  return sendJSON(`${BASE}/settings/${checked(SETTING_ID, settingId, 'setting id')}`, 'PATCH', {
    value,
  });
}

/** `{ everything: true }` or `{ files: [url, …] }`, nothing else. */
export function purgeCloudflareCache(request) {
  const body =
    request?.everything === true ? { everything: true } : { files: [...(request?.files ?? [])] };
  return postJSON(`${BASE}/purge`, body);
}

export function readCloudflareDns() {
  return getJSON(`${BASE}/dns`);
}

export function createCloudflareDnsRecord(record) {
  return postJSON(`${BASE}/dns`, record);
}

export function updateCloudflareDnsRecord(recordId, patch) {
  // Cloudflare's record ids are 32 hex characters; the server checks them too.
  return sendJSON(
    `${BASE}/dns/${checked(/^[A-Za-z0-9]{1,64}$/, recordId, 'record id')}`,
    'PATCH',
    patch
  );
}

export function readCloudflareRulesets() {
  return getJSON(`${BASE}/rulesets`);
}

export function readCloudflarePhase(phase) {
  return getJSON(`${BASE}/rulesets/phases/${checked(PHASE_ID, phase, 'rule phase')}`);
}

export function replaceCloudflarePhase(phase, body) {
  return sendJSON(`${BASE}/rulesets/phases/${checked(PHASE_ID, phase, 'rule phase')}`, 'PUT', body);
}
