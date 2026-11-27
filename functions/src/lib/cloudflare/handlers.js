/**
 * cloudflare/handlers.js — the Cloudflare page's routes (#1905).
 *
 * Every route takes an optional `zone` query parameter (#1911): the name of
 * a zone in protected.js MANAGED_ZONES, the site's own when it is left out,
 * so a call written before #1911 keeps acting on the site's zone. Any other
 * value is refused with 400 before Cloudflare is called. The site's zone is
 * reached by its id (CF_ZONE_ID); another managed zone by a lookup of its
 * name with the same token (client.js).
 *
 * Reads need `editor`; every change needs `super_admin`, the same level as
 * making an agent key, because a change here reaches every visitor at once.
 * An agent key reaches these routes only through its own Cloudflare switches
 * (agent-content/admin-access.js, POLICY). There is no delete route at all.
 *
 *   GET   cms/cloudflare/status                  is it set up; the zone and its role; what the token can read; what is protected
 *   GET   cms/cloudflare/settings                every zone setting
 *   PATCH cms/cloudflare/settings/{settingId}    { value }
 *   POST  cms/cloudflare/purge                   { everything: true } or { files: [url, ...] }
 *   GET   cms/cloudflare/dns                     every DNS record (up to the page cap; `truncated` past it)
 *   POST  cms/cloudflare/dns                     add a record
 *   PATCH cms/cloudflare/dns/{recordId}          edit a record
 *   GET   cms/cloudflare/rulesets                the zone's rulesets (no rules)
 *   GET   cms/cloudflare/rulesets/phases/{phase} one phase's rules (in full only for an editable phase, secrets hidden)
 *   PUT   cms/cloudflare/rulesets/phases/{phase} replace one editable phase's rules
 *
 * The routes themselves are in zone-routes.js, dns-routes.js and
 * rules-routes.js; this file wraps each in the role check, the "not set up"
 * answer and the error handling. What may never change is in protected.js:
 * the site's own address, the records Terraform manages, the lab's records,
 * certificate checks, every rule phase not on the allow-list, and (for an
 * agent key) the owner-only settings. Those are refused with a reason before
 * Cloudflare is called. Every change then checks that the zone is the
 * site's own (record.js requireOurZone) before it writes.
 *
 * Every change that Cloudflare accepted writes one admin_audit_logs row
 * (`cloudflare_change`). When the caller is an agent key it is also sent to
 * the owner's phone. When the row could not be written, the owner's phone is
 * told whoever made the change, and the answer says `audited: false`. A
 * refused change writes neither.
 *
 * "Not set up" names what is missing (`missing`: `token`, `zoneId` or both)
 * and where it comes from: the token is pasted on Integrations → Keys; the
 * zone id is set by Terraform and never pasted. The zone id is needed only
 * for the site's zone; another zone's id is looked up.
 *
 * Log lines are content-free: the route's name, a status and a code, never
 * a record name, a value, a URL or the token.
 */
import { readSetting } from '../http/read-setting.js';
import { authoredMessage, codeShaped, errorCode, errorResponse } from '../http/error-response.js';
import { CloudflareError, TOKEN_SETTING, ZONE_ID_PATTERN, ZONE_SETTING, createCloudflareClient } from './client.js';
import { Refusal, fail, zoneOf } from './input.js';
import { SITE_ZONE } from './protected.js';
import { clockOf } from './record.js';
import { getSettings, getStatus, patchSetting, purge } from './zone-routes.js';
import { notConfiguredMessage } from './prerequisites.js';
import { createDns, listDns, patchDns } from './dns-routes.js';
import { getPhase, listRulesets, putPhase } from './rules-routes.js';

export { MAX_PURGE_FILES, SETTING_ID_PATTERN, FAMILIES, PROTECTED_VIEW, protectedView } from './zone-routes.js';
export { PREREQUISITES, notConfiguredMessage } from './prerequisites.js';
export { DNS_TYPES, RECORD_ID_PATTERN } from './dns-routes.js';
export { PHASE_PATTERN, REDACTED_VALUE } from './rules-routes.js';
export { MAX_BODY_BYTES } from './input.js';

export const READ_ROLE = 'editor';
export const WRITE_ROLE = 'super_admin';

/** Every route: its name in the answer object, its name in a log line, its role, its work. */
const ROUTES = Object.freeze([
  ['getStatus', 'status', READ_ROLE, getStatus, { needsClient: false }],
  ['getSettings', 'settings', READ_ROLE, getSettings],
  ['patchSetting', 'setting-change', WRITE_ROLE, patchSetting],
  ['purge', 'purge', WRITE_ROLE, purge],
  ['listDns', 'dns', READ_ROLE, listDns],
  ['createDns', 'dns-create', WRITE_ROLE, createDns],
  ['patchDns', 'dns-edit', WRITE_ROLE, patchDns],
  ['listRulesets', 'rulesets', READ_ROLE, listRulesets],
  ['getPhase', 'phase', READ_ROLE, getPhase],
  ['putPhase', 'phase-replace', WRITE_ROLE, putPhase],
]);

/** How the client names the zone: the site's by its configured id, any other by its name. */
function zoneTarget(deps, zone) {
  if (zone.name !== SITE_ZONE) return { target: { zoneName: zone.name }, missing: [] };
  const zoneId = readSetting(deps.env, ZONE_SETTING).toLowerCase();
  return ZONE_ID_PATTERN.test(zoneId) ? { target: { zoneId }, missing: [] } : { target: null, missing: ['zoneId'] };
}

/**
 * The client for a zone, or null with the list of what is missing: `token`
 * when the admin token is not set, `zoneId` when the site's zone id is not
 * set or is not a zone id.
 */
function clientOf(deps, zone) {
  const token = readSetting(deps.env, TOKEN_SETTING);
  const { target, missing: zoneMissing } = zoneTarget(deps, zone);
  const missing = [...(token ? [] : ['token']), ...zoneMissing];
  if (missing.length) return { client: null, missing };
  return { client: createCloudflareClient({ token, ...target, ...deps.doubles }), missing };
}

/**
 * The answer for an error a route threw: a Refusal (ours, including bad
 * input) with its own status and sentence; a CloudflareError with its
 * sentence, logged by code; anything else a 500 with a safe sentence.
 */
function answerError({ error, label, request, context }) {
  if (error instanceof Refusal) {
    const extra = error.reason ? { reason: error.reason } : {};
    return fail(error.status, error.code, authoredMessage(error, 'The request is not valid.'), extra);
  }
  if (error instanceof CloudflareError) {
    context?.warn?.(`[cloudflare] ${label}: ${errorCode(error)}, Cloudflare HTTP ${codeShaped(error.upstreamStatus) || 'none'}`);
    return fail(error.status, error.code, authoredMessage(error, 'Cloudflare refused the request.'));
  }
  return errorResponse(context, 'The Cloudflare request failed.', error, 500, request);
}

/**
 * The work for one request: the zone it names (400 for any other), then the
 * client (503 when not set up), then the route's own work. Every error is
 * answered by answerError.
 */
async function begin(deps, call, { label, work, needsClient }) {
  try {
    const zone = zoneOf(call.request);
    const { client, missing } = clientOf(deps, zone);
    if (needsClient && !client) return fail(503, 'CLOUDFLARE_NOT_CONFIGURED', notConfiguredMessage(missing), { missing });
    return await work({ deps, ...call, client, missing, zone });
  } catch (error) {
    return answerError({ error, label, request: call.request, context: call.context });
  }
}

/** One route: the role, then the zone and the client, then the work. */
function route(deps, [label, role, work, { needsClient = true } = {}]) {
  return async (request, context) => {
    const auth = await deps.guard.requireRole(request, role);
    if (auth.error) return auth.error;
    return begin(deps, { request, context, user: auth.user }, { label, work, needsClient });
  };
}

/**
 * @param {object} options
 * @param {{ requireRole: Function }} options.guard
 * @param {{ upsertDoc: Function }} options.store for the audit row
 * @param {{ notifyTelegram: Function }} [options.notifier] for an agent key's changes
 * @param {Record<string, string|undefined>} [options.env]
 * @param {typeof fetch} [options.fetch] [options.resolve] [options.dispatcherFor] for tests
 * @param {() => Date} [options.now] [options.uuid] for tests
 */
export function createCloudflareHandlers(options) {
  const { guard, store, notifier = null, env = process.env, fetch, resolve, dispatcherFor } = options;
  const deps = { guard, store, notifier, env, doubles: { fetch, resolve, dispatcherFor }, ...clockOf(options) };
  return Object.fromEntries(ROUTES.map(([name, ...spec]) => [name, route(deps, spec)]));
}
