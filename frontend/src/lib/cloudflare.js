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
 *   replaceCloudflarePhase(phase, body)  PUT   replace an editable phase's
 *                                              rules { rules,
 *                                              expectedVersion }           super_admin
 *
 * Every call takes the zone last (#1911): a managed zone's name, sent as
 * `?zone=`, and the site's zone on the server when it is left out. The
 * server refuses any zone it does not manage.
 *
 * Every id that goes into a path is checked here first, with the same rule
 * the server uses (functions/src/lib/cloudflare/zone-routes.js,
 * dns-routes.js and rules-routes.js, wrapped by handlers.js), so a bad value
 * is a sentence on screen rather than a request; the server checks again,
 * and decides what is locked. A phase replacement carries `expectedVersion`,
 * the version its read answered, and is refused when the phase changed since.
 */
import { getJSON, postJSON, sendJSON } from '@/lib/api';

const BASE = 'cms/cloudflare';

/** The server's rule for a setting id (zone-routes.js SETTING_ID_PATTERN). */
export const SETTING_ID = /^[a-z0-9_]{1,64}$/;
/** The server's rule for a rule phase (rules-routes.js PHASE_PATTERN). */
export const PHASE_ID = /^[a-z0-9_]{1,64}$/;
/** The server's rule for a DNS record id (dns-routes.js RECORD_ID_PATTERN). */
export const RECORD_ID = /^[a-f0-9]{32}$/;
/** The most addresses one purge may name. */
export const MAX_PURGE_FILES = 30;

/** The code the API answers with while the token or zone id is not set. */
export const NOT_CONFIGURED = 'CLOUDFLARE_NOT_CONFIGURED';

/** The shape of a zone name: lower-case letters, digits, dots and hyphens. */
export const ZONE_NAME = /^[a-z0-9.-]{1,253}$/;

function checked(pattern, value, what) {
  const text = String(value ?? '');
  if (!pattern.test(text)) throw new Error(`That is not a valid ${what}.`);
  return encodeURIComponent(text);
}

/** A route, with `?zone=` when a zone is named. */
function at(route, zone) {
  if (zone === undefined || zone === null) return route;
  return `${route}?zone=${checked(ZONE_NAME, zone, 'zone name')}`;
}

export function readCloudflareStatus(zone) {
  return getJSON(at(`${BASE}/status`, zone));
}

export function readCloudflareSettings(zone) {
  return getJSON(at(`${BASE}/settings`, zone));
}

export function saveCloudflareSetting(settingId, value, zone) {
  const route = at(`${BASE}/settings/${checked(SETTING_ID, settingId, 'setting id')}`, zone);
  return sendJSON(route, 'PATCH', { value });
}

/** `{ everything: true }` or `{ files: [url, …] }`, nothing else. */
export function purgeCloudflareCache(request, zone) {
  const body =
    request?.everything === true ? { everything: true } : { files: [...(request?.files ?? [])] };
  return postJSON(at(`${BASE}/purge`, zone), body);
}

export function readCloudflareDns(zone) {
  return getJSON(at(`${BASE}/dns`, zone));
}

export function createCloudflareDnsRecord(record, zone) {
  return postJSON(at(`${BASE}/dns`, zone), record);
}

export function updateCloudflareDnsRecord(recordId, patch, zone) {
  // Cloudflare's record ids are 32 lower-case hex characters; the server checks them too.
  const route = at(`${BASE}/dns/${checked(RECORD_ID, recordId, 'record id')}`, zone);
  return sendJSON(route, 'PATCH', patch);
}

export function readCloudflareRulesets(zone) {
  return getJSON(at(`${BASE}/rulesets`, zone));
}

/** One phase's route, checked. */
const phaseRoute = (phase, zone) =>
  at(`${BASE}/rulesets/phases/${checked(PHASE_ID, phase, 'rule phase')}`, zone);

export function readCloudflarePhase(phase, zone) {
  return getJSON(phaseRoute(phase, zone));
}

export function replaceCloudflarePhase(phase, body, zone) {
  return sendJSON(phaseRoute(phase, zone), 'PUT', body);
}
