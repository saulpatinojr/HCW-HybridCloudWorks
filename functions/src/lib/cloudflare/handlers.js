/**
 * cloudflare/handlers.js — the Cloudflare page's routes (#1905).
 *
 * Reads need `editor`; every change needs `super_admin`, the same level as
 * making an agent key, because a change here reaches every visitor at once.
 * An agent key reaches these routes only through its own Cloudflare switches
 * (agent-content/admin-access.js, POLICY). There is no delete route at all.
 *
 *   GET   cms/cloudflare/status                  is it set up; the zone; what the token can read; what is protected
 *   GET   cms/cloudflare/settings                every zone setting
 *   PATCH cms/cloudflare/settings/{settingId}    { value }
 *   POST  cms/cloudflare/purge                   { everything: true } or { files: [url, ...] }
 *   GET   cms/cloudflare/dns                     every DNS record
 *   POST  cms/cloudflare/dns                     add a record
 *   PATCH cms/cloudflare/dns/{recordId}          edit a record
 *   GET   cms/cloudflare/rulesets                the zone's rulesets
 *   GET   cms/cloudflare/rulesets/phases/{phase} one phase's rules
 *   PUT   cms/cloudflare/rulesets/phases/{phase} replace one phase's rules
 *
 * What may never change is in protected.js: the site's own address, the
 * records Terraform manages, the lab's records, certificate checks, and the
 * rule phases Terraform writes. Those are refused with 409 and a reason,
 * before Cloudflare is called.
 *
 * Every change that Cloudflare accepted writes one admin_audit_logs row
 * (`cloudflare_change`). When the caller is an agent key it is also sent to
 * the owner's phone. A refused change writes neither.
 *
 * Log lines are content-free: the route's name, a status and a code, never
 * a record name, a value, a URL or the token.
 */
import { randomUUID } from 'node:crypto';
import { readSetting } from '../http/read-setting.js';
import { AuthoredError, authoredMessage, codeShaped, errorCode, errorResponse, errorFacts } from '../http/error-response.js';
import { agentKeyById, isAgentUser } from '../agent-content/agent-keys.js';
import { CloudflareError, TOKEN_SETTING, ZONE_ID_PATTERN, ZONE_SETTING, createCloudflareClient } from './client.js';
import {
  PROTECTED_DNS_NAMES,
  PROTECTED_DNS_PREFIXES,
  PROTECTED_PHASES,
  ZONE_APEX,
  dnsNameProtection,
  normalizeDnsName,
  phaseProtection,
} from './protected.js';

export const READ_ROLE = 'editor';
export const WRITE_ROLE = 'super_admin';

export const SETTING_ID_PATTERN = /^[a-z0-9_]{1,64}$/;
export const PHASE_PATTERN = /^[a-z_]{1,64}$/;
export const RECORD_ID_PATTERN = /^[a-f0-9]{32}$/;
/** The record types the page may add or edit. Others are read-only here. */
export const DNS_TYPES = Object.freeze(['A', 'AAAA', 'CNAME', 'MX', 'TXT']);
export const MAX_PURGE_FILES = 30;
/** The largest request body read, in characters (a phase's rules are the big one). */
export const MAX_BODY_CHARS = 64 * 1024;
const MAX_RULES = 100;

/** The four kinds of thing the page shows, in its tab order. */
export const FAMILIES = Object.freeze([
  Object.freeze({ id: 'settings', label: 'Zone settings' }),
  Object.freeze({ id: 'dns', label: 'DNS records' }),
  Object.freeze({ id: 'rules', label: 'Rules' }),
  Object.freeze({ id: 'cache', label: 'Cache settings (purging needs its own permission, which cannot be tested without a purge)' }),
]);

export const NOT_CONFIGURED_MESSAGE =
  'Cloudflare is not set up yet: paste the Cloudflare admin token on Integrations → Keys (CLOUDFLARE-ADMIN-TOKEN). The zone id comes from Terraform.';

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  body: JSON.stringify(body),
});
const fail = (status, code, error, extra = {}) => json(status, { ok: false, code, error, ...extra });

/** Thrown for input the caller can correct; answered as 400 with the sentence. */
class InputError extends AuthoredError {}
const bad = (message) => new InputError(message);

/** What `protected.js` holds, as the status route shows it. */
export const PROTECTED_VIEW = Object.freeze({
  dnsNames: PROTECTED_DNS_NAMES.map(({ name, reason }) => ({ name, reason })),
  dnsPrefixes: PROTECTED_DNS_PREFIXES.map(({ prefix, reason }) => ({ prefix, reason })),
  phases: PROTECTED_PHASES.map(({ phase, reason }) => ({ phase, reason })),
});

/** The JSON object a request carries, or an InputError. */
async function bodyOf(request) {
  let text;
  try {
    text = typeof request.text === 'function' ? await request.text() : JSON.stringify(await request.json());
  } catch {
    throw bad('The request body could not be read.');
  }
  if (typeof text !== 'string' || text.length > MAX_BODY_CHARS) throw bad(`The request body must be JSON of at most ${MAX_BODY_CHARS} characters.`);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw bad('The request body must be JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('The request body must be a JSON object.');
  return body;
}

function refuseUnknownFields(body, allowed) {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) throw bad(`Not a field this route takes: ${unknown.slice(0, 5).join(', ')}.`);
}

const paramOf = (request, name) => String(request?.params?.[name] ?? '');

/** The DNS fields a create or an edit may carry, checked one by one. */
function dnsFields(body, { partial }) {
  refuseUnknownFields(body, ['type', 'name', 'content', 'ttl', 'proxied', 'comment', 'priority']);
  const out = {};
  if (body.type !== undefined || !partial) {
    const type = String(body.type ?? '').toUpperCase();
    if (!DNS_TYPES.includes(type)) throw bad(`type must be one of ${DNS_TYPES.join(', ')}.`);
    out.type = type;
  }
  if (body.name !== undefined || !partial) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 253) throw bad('name must be a DNS name of 1 to 253 characters.');
    if (!/^[A-Za-z0-9*_.@-]+$/.test(body.name.trim())) throw bad('name may hold only letters, digits, dots, hyphens, underscores, @ and *.');
    out.name = body.name.trim();
  }
  if (body.content !== undefined || !partial) {
    if (typeof body.content !== 'string' || !body.content.trim() || body.content.length > 4096) throw bad('content must be text of 1 to 4096 characters.');
    out.content = body.content.trim();
  }
  if (body.ttl !== undefined) {
    if (!Number.isInteger(body.ttl) || !(body.ttl === 1 || (body.ttl >= 60 && body.ttl <= 86400))) {
      throw bad('ttl must be 1 (automatic) or a whole number of seconds from 60 to 86400.');
    }
    out.ttl = body.ttl;
  }
  if (body.proxied !== undefined) {
    if (typeof body.proxied !== 'boolean') throw bad('proxied must be true or false.');
    out.proxied = body.proxied;
  }
  if (body.comment !== undefined) {
    if (typeof body.comment !== 'string' || body.comment.length > 100) throw bad('comment must be text of at most 100 characters.');
    out.comment = body.comment;
  }
  if (body.priority !== undefined) {
    if (!Number.isInteger(body.priority) || body.priority < 0 || body.priority > 65535) throw bad('priority must be a whole number from 0 to 65535.');
    out.priority = body.priority;
  }
  if (partial && Object.keys(out).length === 0) throw bad('Send at least one field to change.');
  return out;
}

/** A purge request, checked: everything, or 1 to 30 https URLs on the zone's own hostnames. */
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
  const apex = String(zoneName || ZONE_APEX).toLowerCase();
  const checked = files.map((value, index) => {
    let url;
    try {
      url = typeof value === 'string' && value.length <= 2048 ? new URL(value) : null;
    } catch {
      url = null;
    }
    const host = url?.hostname?.toLowerCase();
    if (!url || url.protocol !== 'https:' || url.username || url.password || !(host === apex || host?.endsWith(`.${apex}`))) {
      throw bad(`Address ${index + 1} must be an https address on ${apex} or one of its subdomains.`);
    }
    return url.toString();
  });
  return { files: checked };
}

/** A phase's new rules, checked for shape. Cloudflare checks what each rule says. */
function rulesBody(body) {
  refuseUnknownFields(body, ['rules', 'description']);
  if (!Array.isArray(body.rules) || body.rules.length > MAX_RULES) throw bad(`rules must be a list of at most ${MAX_RULES} rules.`);
  if (body.rules.some((rule) => !rule || typeof rule !== 'object' || Array.isArray(rule))) throw bad('Each rule must be an object.');
  const out = { rules: body.rules };
  if (body.description !== undefined) {
    if (typeof body.description !== 'string' || body.description.length > 500) throw bad('description must be text of at most 500 characters.');
    out.description = body.description;
  }
  return out;
}

const pickDns = (record) => ({
  id: record?.id ?? null,
  type: record?.type ?? null,
  name: record?.name ?? null,
  content: record?.content ?? null,
  proxied: record?.proxied ?? null,
  ttl: record?.ttl ?? null,
  comment: record?.comment ?? null,
  priority: record?.priority ?? null,
  locked: dnsNameProtection(record?.name) !== null,
  lockedReason: dnsNameProtection(record?.name),
});

const pickRuleset = (ruleset) => ({
  id: ruleset?.id ?? null,
  name: ruleset?.name ?? null,
  phase: ruleset?.phase ?? null,
  kind: ruleset?.kind ?? null,
  description: ruleset?.description ?? null,
  locked: phaseProtection(ruleset?.phase) !== null,
  lockedReason: phaseProtection(ruleset?.phase),
});

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ upsertDoc: Function }} deps.store for the audit row
 * @param {{ notifyTelegram: Function }} [deps.notifier] for an agent key's changes
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {typeof fetch} [deps.fetch] [deps.resolve] [deps.dispatcherFor] for tests
 */
export function createCloudflareHandlers({
  guard,
  store,
  notifier = null,
  env = process.env,
  fetch: fetchImpl,
  resolve,
  dispatcherFor,
  now = () => new Date(),
  uuid = randomUUID,
}) {
  /** The client, or null when the token or the zone id is not set. */
  function clientOrNull() {
    const token = readSetting(env, TOKEN_SETTING);
    const zoneId = readSetting(env, ZONE_SETTING).toLowerCase();
    if (!token || !ZONE_ID_PATTERN.test(zoneId)) return null;
    return createCloudflareClient({ token, zoneId, fetch: fetchImpl, resolve, dispatcherFor });
  }

  async function audit({ context, user, request }, details) {
    try {
      await store.upsertDoc('admin_audit_logs', {
        id: uuid(),
        timestamp: now().toISOString(),
        action: 'cloudflare_change',
        userId: user?.oid || user?.sub || null,
        userEmail: user?.email || null,
        ...(isAgentUser(user) ? { agent: user.agent } : {}),
        resourceType: 'cloudflare',
        resourceId: details.family,
        details,
        userAgent: request.headers?.get?.('user-agent') || null,
        compliance: { schemaVersion: 1, detailsSanitized: true, identityVerified: true },
      });
    } catch (error) {
      // Best effort: the change has happened, so the answer says so.
      context?.error?.('[cloudflare] audit row failed', errorFacts(error));
    }
  }

  async function tellOwner(user, sentence) {
    if (!isAgentUser(user) || !notifier) return;
    const name = agentKeyById(user.agent)?.displayName || user.agent;
    try {
      await notifier.notifyTelegram({
        title: `Cloudflare changed by ${name}`,
        message: `${name} ${sentence}`,
        severity: 'info',
        source: `cloudflare-change:${user.agent}`,
      });
    } catch {
      // The notifier never throws; this is belt and braces.
    }
  }

  /**
   * One route: the role, then the client (503 when not set up), then the
   * work. Input errors answer 400; Cloudflare's refusals answer with their
   * own status and sentence; anything else is a 500 with a safe sentence.
   */
  function route(name, role, work, { needsClient = true } = {}) {
    return async (request, context) => {
      const auth = await guard.requireRole(request, role);
      if (auth.error) return auth.error;
      const client = clientOrNull();
      if (needsClient && !client) return fail(503, 'CLOUDFLARE_NOT_CONFIGURED', NOT_CONFIGURED_MESSAGE);
      try {
        return await work({ request, context, client, user: auth.user });
      } catch (error) {
        if (error instanceof InputError) return fail(400, 'BAD_REQUEST', authoredMessage(error, 'The request is not valid.'));
        if (error instanceof CloudflareError) {
          context?.warn?.(`[cloudflare] ${name}: ${errorCode(error)}, Cloudflare HTTP ${codeShaped(error.upstreamStatus) || 'none'}`);
          return fail(error.status, error.code, authoredMessage(error, 'Cloudflare refused the request.'));
        }
        return errorResponse(context, 'The Cloudflare request failed.', error, 500, request);
      }
    };
  }

  const getStatus = route(
    'status',
    READ_ROLE,
    async ({ client }) => {
      if (!client) {
        return json(200, { ok: true, configured: false, message: NOT_CONFIGURED_MESSAGE, zone: null, families: [], protected: PROTECTED_VIEW });
      }
      let zone = null;
      let zoneFailure = null;
      try {
        const found = await client.getZone();
        zone = { id: found?.id ?? client.zoneId, name: found?.name ?? null, status: found?.status ?? null, plan: found?.plan?.name ?? null };
      } catch (error) {
        if (!(error instanceof CloudflareError)) throw error;
        zoneFailure = error;
      }
      const readable = await Promise.all(FAMILIES.map((family) => client.canRead(family.id)));
      return json(200, {
        ok: true,
        configured: true,
        zone,
        zoneError: zoneFailure ? authoredMessage(zoneFailure, 'Cloudflare did not answer for the zone.') : null,
        families: FAMILIES.map((family, index) => ({ ...family, readable: readable[index] })),
        protected: PROTECTED_VIEW,
      });
    },
    { needsClient: false }
  );

  const getSettings = route('settings', READ_ROLE, async ({ client }) => {
    const settings = await client.listSettings();
    return json(200, {
      ok: true,
      settings: (Array.isArray(settings) ? settings : []).map((setting) => ({
        id: setting?.id ?? null,
        value: setting?.value ?? null,
        editable: setting?.editable !== false,
        modifiedOn: setting?.modified_on ?? null,
      })),
    });
  });

  const patchSetting = route('setting-change', WRITE_ROLE, async ({ request, context, client, user }) => {
    const settingId = paramOf(request, 'settingId');
    if (!SETTING_ID_PATTERN.test(settingId)) throw bad('The setting id must be 1 to 64 lower-case letters, digits or underscores.');
    const body = await bodyOf(request);
    refuseUnknownFields(body, ['value']);
    if (!Object.hasOwn(body, 'value')) throw bad('Send { "value": ... }.');
    const result = await client.patchSetting(settingId, body.value);
    await audit({ context, user, request }, { family: 'settings', settingId });
    await tellOwner(user, `changed the Cloudflare zone setting ${settingId}.`);
    return json(200, {
      ok: true,
      setting: { id: result?.id ?? settingId, value: result?.value ?? body.value, editable: result?.editable !== false, modifiedOn: result?.modified_on ?? null },
    });
  });

  const purge = route('purge', WRITE_ROLE, async ({ request, context, client, user }) => {
    const body = await bodyOf(request);
    let zoneName = null;
    if (body.everything === undefined) zoneName = (await client.getZone())?.name || null;
    const sent = purgeBody(body, zoneName);
    await client.purge(sent);
    const details = sent.purge_everything ? { family: 'cache', purge: 'everything' } : { family: 'cache', purge: 'files', count: sent.files.length };
    await audit({ context, user, request }, details);
    await tellOwner(
      user,
      sent.purge_everything ? 'purged the whole Cloudflare cache.' : `purged ${sent.files.length} address(es) from the Cloudflare cache.`
    );
    return json(200, { ok: true, purged: sent.purge_everything ? 'everything' : sent.files.length });
  });

  const listDns = route('dns', READ_ROLE, async ({ client }) => {
    const records = await client.listDns();
    return json(200, { ok: true, records: records.map(pickDns) });
  });

  const createDns = route('dns-create', WRITE_ROLE, async ({ request, context, client, user }) => {
    const fields = dnsFields(await bodyOf(request), { partial: false });
    const reason = dnsNameProtection(fields.name);
    if (reason) return fail(409, 'CLOUDFLARE_PROTECTED', `That name is protected: ${reason}`, { reason });
    const created = await client.createDns(fields);
    const name = created?.name || normalizeDnsName(fields.name);
    await audit({ context, user, request }, { family: 'dns', change: 'create', recordType: fields.type, name });
    await tellOwner(user, `added the ${fields.type} record ${name} in Cloudflare.`);
    return json(201, { ok: true, record: pickDns(created) });
  });

  const patchDns = route('dns-edit', WRITE_ROLE, async ({ request, context, client, user }) => {
    const recordId = paramOf(request, 'recordId').toLowerCase();
    if (!RECORD_ID_PATTERN.test(recordId)) throw bad('The record id must be 32 hexadecimal characters.');
    const changes = dnsFields(await bodyOf(request), { partial: true });
    const current = await client.getDns(recordId);
    const reason = dnsNameProtection(current?.name) || (changes.name !== undefined ? dnsNameProtection(changes.name) : null);
    if (reason) return fail(409, 'CLOUDFLARE_PROTECTED', `That record is protected: ${reason}`, { reason });
    const updated = await client.patchDns(recordId, changes);
    const name = updated?.name || current?.name || null;
    const recordType = updated?.type || changes.type || current?.type || null;
    await audit({ context, user, request }, { family: 'dns', change: 'edit', recordType, name });
    await tellOwner(user, `edited the ${recordType} record ${name} in Cloudflare.`);
    return json(200, { ok: true, record: pickDns(updated) });
  });

  const listRulesets = route('rulesets', READ_ROLE, async ({ client }) => {
    const rulesets = await client.listRulesets();
    return json(200, { ok: true, rulesets: (Array.isArray(rulesets) ? rulesets : []).map(pickRuleset) });
  });

  /** The phase in the path, checked; an InputError for a malformed one. */
  const phaseOf = (request) => {
    const phase = paramOf(request, 'phase');
    if (!PHASE_PATTERN.test(phase)) throw bad('The phase must be 1 to 64 lower-case letters or underscores.');
    return phase;
  };

  const getPhase = route('phase', READ_ROLE, async ({ request, client }) => {
    const phase = phaseOf(request);
    const ruleset = await client.getPhase(phase);
    return json(200, {
      ok: true,
      ruleset: ruleset ? { ...pickRuleset(ruleset), rules: Array.isArray(ruleset.rules) ? ruleset.rules : [] } : null,
      locked: phaseProtection(phase) !== null,
      lockedReason: phaseProtection(phase),
    });
  });

  const putPhase = route('phase-replace', WRITE_ROLE, async ({ request, context, client, user }) => {
    const phase = phaseOf(request);
    const reason = phaseProtection(phase);
    if (reason) return fail(409, 'CLOUDFLARE_PROTECTED', `That rule phase is protected: ${reason}`, { reason });
    const sent = rulesBody(await bodyOf(request));
    const saved = await client.putPhase(phase, sent);
    await audit({ context, user, request }, { family: 'rules', phase, count: sent.rules.length });
    await tellOwner(user, `replaced the Cloudflare rules in the ${phase} phase (${sent.rules.length} rule(s)).`);
    return json(200, { ok: true, ruleset: { ...pickRuleset(saved), rules: Array.isArray(saved?.rules) ? saved.rules : [] } });
  });

  return { getStatus, getSettings, patchSetting, purge, listDns, createDns, patchDns, listRulesets, getPhase, putPhase };
}
