/**
 * cloudflare/zone-routes.js — the Cloudflare page's status, zone settings
 * and cache purge routes (#1905). handlers.js wraps each in the role check
 * and the error handling; each is handed one `call` object: { deps,
 * request, context, client, user, zone } (zone: the managed zone the
 * request names, protected.js MANAGED_ZONES).
 *
 * A change is checked in this order, so a bad request never reaches
 * Cloudflare: the path value, the body's shape, what the caller may change
 * (an agent key and the owner-only settings), then the zone check, then the
 * read of the current value, then the change.
 */
import { authoredMessage } from '../http/error-response.js';
import { isAgentUser } from '../agent-content/agent-keys.js';
import { CloudflareError } from './client.js';
import { Refusal, bad, bodyOf, json, paramOf, refuseUnknownFields } from './input.js';
import { recordChange, requireOurZone } from './record.js';
import { notConfiguredMessage } from './prerequisites.js';
import { EDITABLE_PHASES, MANAGED_ZONES, OWNER_ONLY_SETTINGS, SITE_ZONE, managedZone, ownerOnlySettingReason } from './protected.js';
import { RATE_LIMIT_PHASE, rateLimitFromRuleset, rateLimitUnread } from './rate-limit.js';

export { PREREQUISITES, notConfiguredMessage } from './prerequisites.js';

export const SETTING_ID_PATTERN = /^[a-z0-9_]{1,64}$/;
export const MAX_PURGE_FILES = 30;
const MAX_URL_LENGTH = 2048;

/** The four kinds of thing the page shows, in its tab order. */
export const FAMILIES = Object.freeze([
  Object.freeze({ id: 'settings', label: 'Zone settings' }),
  Object.freeze({ id: 'dns', label: 'DNS records' }),
  Object.freeze({ id: 'rules', label: 'Rules' }),
  Object.freeze({ id: 'cache', label: 'Cache settings (purging needs its own permission, which cannot be tested without a purge)' }),
]);

/** What `protected.js` holds for one managed zone, as the status route shows it. */
export function protectedView(zone) {
  return {
    dnsNames: zone.dnsNames.map(({ name, reason }) => ({ name, reason })),
    dnsPrefixes: zone.dnsPrefixes.map(({ prefix, reason }) => ({ prefix, reason })),
    phases: zone.phases.map(({ phase, reason }) => ({ phase, reason })),
    wildcardReason: zone.wildcardReason,
    editablePhases: EDITABLE_PHASES.map(({ phase, description }) => ({ phase, description })),
    ownerOnlySettings: OWNER_ONLY_SETTINGS.map(({ setting, reason }) => ({ setting, reason })),
  };
}

/** The site zone's view, as before #1911. */
export const PROTECTED_VIEW = Object.freeze(protectedView(managedZone(SITE_ZONE)));

/** The zone a status answer is about, and every zone the page may pick, each by name and role. */
const zoneViews = (zone) => ({
  managed: { name: zone.name, role: zone.role },
  managedZones: MANAGED_ZONES.map(({ name, role }) => ({ name, role })),
});

/** The zone's id, name, status and plan, or the sentence saying why it could not be read. */
async function zoneSummary(client) {
  try {
    const found = await client.getZone();
    const zone = { id: found?.id ?? client.zoneId, name: found?.name ?? null, status: found?.status ?? null, plan: found?.plan?.name ?? null };
    return { zone, zoneError: null };
  } catch (error) {
    if (!(error instanceof CloudflareError)) throw error;
    return { zone: null, zoneError: authoredMessage(error, 'Cloudflare did not answer for the zone.') };
  }
}

/**
 * Whether the API rate limit rule is in place (#1909), for the site's zone
 * only (the lab zone has no API to protect, so it answers null). A refusal
 * or a Cloudflare outage is its own state, with this module's sentence.
 * When the zone itself could not be read, the phase is not read either and
 * the answer is unreachable: a 404 for the phase would otherwise read as
 * "no rule", when it can mean the zone or the token is gone.
 */
async function rateLimitSummary(client, managed, zoneError) {
  if (managed.name !== SITE_ZONE) return null;
  if (zoneError) return rateLimitUnread(null);
  try {
    return rateLimitFromRuleset(await client.getPhase(RATE_LIMIT_PHASE));
  } catch (error) {
    if (!(error instanceof CloudflareError)) throw error;
    return rateLimitUnread(error.upstreamStatus);
  }
}

/**
 * GET cms/cloudflare/status[?zone=]. One zone's status: 200 even when not
 * set up, with `missing` naming `token` and/or `zoneId` and a sentence
 * saying where each comes from. `managed` names the zone the answer is
 * about and its role; `managedZones` every zone the page may pick.
 * `rateLimit` says whether the site zone's API rate limit rule is on
 * (rate-limit.js: a state, two counts and a sentence). Never holds a rule,
 * a record or a value.
 */
export async function getStatus({ client, missing = [], zone: managed }) {
  const views = { ...zoneViews(managed), protected: protectedView(managed) };
  if (!client) {
    const message = notConfiguredMessage(missing);
    return json(200, { ok: true, configured: false, missing, message, zone: null, families: [], rateLimit: null, ...views });
  }
  const { zone, zoneError } = await zoneSummary(client);
  const [rateLimit, ...readable] = await Promise.all([
    rateLimitSummary(client, managed, zoneError),
    ...FAMILIES.map((family) => client.canRead(family.id)),
  ]);
  return json(200, {
    ok: true,
    configured: true,
    missing: [],
    zone,
    zoneError,
    families: FAMILIES.map((family, index) => ({ ...family, readable: readable[index] })),
    rateLimit,
    ...views,
  });
}

const settingView = (setting) => ({
  id: setting?.id ?? null,
  value: setting?.value ?? null,
  editable: setting?.editable !== false,
  modifiedOn: setting?.modified_on ?? null,
});

/** GET cms/cloudflare/settings. */
export async function getSettings({ client }) {
  const settings = await client.listSettings();
  return json(200, { ok: true, settings: (Array.isArray(settings) ? settings : []).map(settingView) });
}

/** The setting id in the path, checked. */
function settingIdOf(request) {
  const settingId = paramOf(request, 'settingId');
  if (!SETTING_ID_PATTERN.test(settingId)) throw bad('The setting id must be 1 to 64 lower-case letters, digits or underscores.');
  return settingId;
}

/** Refuses an agent key a setting only the owner changes. */
function refuseOwnerOnly(user, settingId) {
  const reason = ownerOnlySettingReason(settingId);
  if (reason && isAgentUser(user)) {
    throw new Refusal(`An agent key may not change ${settingId}. ${reason}`, { status: 403, code: 'CLOUDFLARE_OWNER_ONLY', reason });
  }
}

/**
 * PATCH cms/cloudflare/settings/{settingId} { value }. The current value is
 * read first, so the audit row says what it was and what it became (zone
 * settings hold no secrets).
 */
export async function patchSetting(call) {
  const { request, client, user, zone } = call;
  const settingId = settingIdOf(request);
  const body = await bodyOf(request);
  refuseUnknownFields(body, ['value']);
  if (!Object.hasOwn(body, 'value')) throw bad('Send { "value": ... }.');
  refuseOwnerOnly(user, settingId);
  await requireOurZone(client, zone.name);
  const before = (await client.getSetting(settingId))?.value ?? null;
  const result = await client.patchSetting(settingId, body.value);
  const saved = settingView({ ...result, id: result?.id ?? settingId, value: result?.value ?? body.value });
  const audited = await recordChange(call, { family: 'settings', settingId, before, after: saved.value }, `changed the Cloudflare zone setting ${settingId}.`);
  return json(200, { ok: true, setting: saved, audited });
}

/** Whether a host is the zone or one of its names. */
const onZone = (host, zoneName) => host === zoneName || host.endsWith(`.${zoneName}`);

/** A URL from a purge list, or null when it is not text of a sane length or not a URL. */
function urlOrNull(value) {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Whether a purge address is https, carries no sign-in, and is on the zone's own names. */
function purgeable(url, zoneName) {
  if (!url || url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  return onZone(url.hostname.toLowerCase(), zoneName);
}

/** A purge request, checked: everything, or 1 to 30 https URLs on the zone's own names. */
function purgeBody(body, zoneName) {
  refuseUnknownFields(body, ['everything', 'files']);
  if (body.everything !== undefined) {
    if (body.everything !== true || body.files !== undefined) throw bad('Send { "everything": true } or { "files": [...] }, not both.');
    return { purge_everything: true };
  }
  const files = body.files;
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_PURGE_FILES) {
    throw bad(`files must be a list of 1 to ${MAX_PURGE_FILES} addresses.`);
  }
  const checked = files.map((value, index) => {
    const url = urlOrNull(value);
    if (!purgeable(url, zoneName)) throw bad(`Address ${index + 1} must be an https address on ${zoneName} or one of its subdomains.`);
    return url.toString();
  });
  return { files: checked };
}

/** POST cms/cloudflare/purge { everything: true } or { files } (on the zone's own names). */
export async function purge(call) {
  const { request, client, zone } = call;
  const sent = purgeBody(await bodyOf(request), zone.name);
  await requireOurZone(client, zone.name);
  await client.purge(sent);
  const everything = sent.purge_everything === true;
  const details = everything ? { family: 'cache', purge: 'everything' } : { family: 'cache', purge: 'files', count: sent.files.length };
  const sentence = everything ? 'purged the whole Cloudflare cache.' : `purged ${sent.files.length} address(es) from the Cloudflare cache.`;
  const audited = await recordChange(call, details, sentence);
  return json(200, { ok: true, purged: everything ? 'everything' : sent.files.length, audited });
}
