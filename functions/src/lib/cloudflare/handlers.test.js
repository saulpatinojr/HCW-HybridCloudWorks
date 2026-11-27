/**
 * The Cloudflare page's routes (#1905), against a fake Cloudflare API: no
 * network. Roles, "not set up", the zone check, the protected names, the
 * allow-list of rule phases, the owner-only settings, input checks (the body
 * size included), the audit row with its before and after, the phone
 * message, the hidden origin secret, the freshness check on a phase, and
 * that the token never leaves the Authorization header.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCloudflareHandlers,
  MAX_BODY_BYTES,
  MAX_PURGE_FILES,
  PREREQUISITES,
  READ_ROLE,
  REDACTED_VALUE,
  WRITE_ROLE,
  notConfiguredMessage,
} from './handlers.js';
import { CLOUDFLARE_API_BASE, DNS_MAX_PAGES, forgetZoneIds, zoneUnreachableMessage } from './client.js';
import { EDITABLE_PHASES, LAB_ZONE, OWNER_ONLY_SETTINGS, READ_ONLY_PHASE_REASON, ZONE_APEX } from './protected.js';
import { UNAUDITED_NOTE, WRONG_ZONE_MESSAGE, wrongZoneMessage } from './record.js';
import { AGENT_DISABLE_MESSAGE, AGENT_REMOVAL_MESSAGE, AGENT_RESPONSE_MESSAGE, GUARDED_PHASES, STALE_MESSAGE, concurrentWriteNote } from './rules-routes.js';
import { agentUserOf } from '../agent-content/keys.js';
import { formatTelegramText } from '../notify.js';
import { agentKeyById } from '../agent-content/agent-keys.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = 'not-a-real-cloudflare-token-EXAMPLE-0123456789';
const ORIGIN_SECRET = 'not-a-real-origin-secret-EXAMPLE-9876543210';
const ZONE = '00000000000000000000000000000001';
const RECORD_ID = '00000000000000000000000000000002';
const ENV = { CLOUDFLARE_ADMIN_TOKEN: TOKEN, CF_ZONE_ID: ZONE };
const ZONE_PATH = `/client/v4/zones/${ZONE}`;
const PHASES = `${ZONE_PATH}/rulesets/phases`;
const PERSON = { oid: 'person-oid', email: 'owner@example.com' };
const NETWORK_GUY = agentUserOf(agentKeyById('claude-network'));
const REDIRECT = 'http_request_dynamic_redirect';

const reply = (status, body = {}) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), text: async () => text };
};
const ok = (result, extra = {}) => reply(200, { success: true, errors: [], result, ...extra });

/** A fake Cloudflare: `routes` maps "METHOD /path" to a function of (url, init) or a reply. */
function cloudflare(routes = {}) {
  const calls = [];
  const fetch = vi.fn(async (url, init = {}) => {
    const parsed = new URL(url);
    const method = init.method || 'GET';
    calls.push({ method, path: parsed.pathname, query: parsed.searchParams, url, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const route = routes[`${method} ${parsed.pathname}`];
    if (!route) return reply(404, { success: false, errors: [{ code: 7003, message: 'no route' }] });
    return typeof route === 'function' ? route(parsed, init) : route;
  });
  return { fetch, calls };
}

const zoneReply = (name = ZONE_APEX) => ok({ id: ZONE, name, status: 'active', plan: { name: 'Free Website' }, owner: { email: 'someone@example.com' } });
const ZONE_READS = { [`GET ${ZONE_PATH}`]: zoneReply() };

function setup({ routes = {}, env = ENV, user = PERSON, refuse = null } = {}) {
  const api = cloudflare({ ...ZONE_READS, ...routes });
  const guard = { requireRole: vi.fn(async (request, role) => (refuse ? { error: refuse } : { user, role, error: null })) };
  const store = { upsertDoc: vi.fn(async () => ({})) };
  const notifier = { notifyTelegram: vi.fn(async () => ({ sent: true })) };
  let ids = 0;
  const handlers = createCloudflareHandlers({
    guard,
    store,
    notifier,
    env,
    fetch: api.fetch,
    resolve: async () => ({ address: '93.184.216.34' }),
    dispatcherFor: () => ({ close: async () => {} }),
    now: () => new Date('2026-11-26T12:00:00.000Z'),
    uuid: () => `audit-${(ids += 1)}`,
  });
  const context = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { api, guard, store, notifier, handlers, context };
}

const request = ({ params = {}, body, text, headers = {}, query = '' } = {}) => ({
  params,
  query: new URLSearchParams(query),
  headers: { get: (name) => (name.toLowerCase() === 'user-agent' ? 'test-agent' : (headers[name.toLowerCase()] ?? null)) },
  text: async () => (text !== undefined ? text : body === undefined ? '' : JSON.stringify(body)),
});
const parse = (res) => ({ status: res.status, body: JSON.parse(res.body) });
const logs = (context) => JSON.stringify([context.log.mock.calls, context.warn.mock.calls, context.error.mock.calls]);
const methods = (api) => api.calls.map((call) => `${call.method} ${call.path.replace(ZONE_PATH, '')}`);
const WRITES = (api) => api.calls.filter((call) => call.method !== 'GET');

const RULE = { expression: 'true', action: 'redirect', action_parameters: {} };

/** Every route, with a request that would pass its checks. */
const ROUTES = [
  ['getStatus', READ_ROLE, request()],
  ['getSettings', READ_ROLE, request()],
  ['patchSetting', WRITE_ROLE, request({ params: { settingId: 'always_use_https' }, body: { value: 'on' } })],
  ['purge', WRITE_ROLE, request({ body: { everything: true } })],
  ['listDns', READ_ROLE, request()],
  ['createDns', WRITE_ROLE, request({ body: { type: 'A', name: 'blog', content: '192.0.2.1' } })],
  ['patchDns', WRITE_ROLE, request({ params: { recordId: RECORD_ID }, body: { proxied: true } })],
  ['listRulesets', READ_ROLE, request()],
  ['getPhase', READ_ROLE, request({ params: { phase: REDIRECT } })],
  ['putPhase', WRITE_ROLE, request({ params: { phase: REDIRECT }, body: { rules: [RULE], expectedVersion: null } })],
];

describe('roles', () => {
  it('asks editor for every read and super_admin for every change', async () => {
    expect(READ_ROLE).toBe('editor');
    expect(WRITE_ROLE).toBe('super_admin');
    for (const [name, role, req] of ROUTES) {
      const { handlers, guard } = setup();
      await handlers[name](req, { warn: vi.fn() });
      expect(guard.requireRole.mock.calls[0][1], name).toBe(role);
    }
  });

  it('answers the guard’s refusal and calls nothing', async () => {
    for (const [name, , req] of ROUTES) {
      const refusal = { status: 403, body: '{"ok":false}' };
      const { handlers, api, store } = setup({ refuse: refusal });
      expect(await handlers[name](req, {}), name).toBe(refusal);
      expect(api.fetch).not.toHaveBeenCalled();
      expect(store.upsertDoc).not.toHaveBeenCalled();
    }
  });
});

describe('not set up', () => {
  // Each setup that is not complete, with what the answers must name as missing.
  const unset = [
    [{}, ['token', 'zoneId']],
    [{ CF_ZONE_ID: ZONE }, ['token']],
    [{ CLOUDFLARE_ADMIN_TOKEN: TOKEN }, ['zoneId']],
    [{ CLOUDFLARE_ADMIN_TOKEN: '@Microsoft.KeyVault(SecretUri=https://kv.example/secrets/CLOUDFLARE-ADMIN-TOKEN)', CF_ZONE_ID: ZONE }, ['token']],
    [{ CLOUDFLARE_ADMIN_TOKEN: TOKEN, CF_ZONE_ID: 'not-a-zone-id' }, ['zoneId']],
  ];
  const envs = unset.map(([env]) => env);

  it.each(unset)('names exactly what is missing for %j: %j', async (env, missing) => {
    const { handlers } = setup({ env });
    const status = parse(await handlers.getStatus(request(), {}));
    expect(status.body.missing).toEqual(missing);
    expect(status.body.message).toBe(notConfiguredMessage(missing));
    const refused = parse(await handlers.getSettings(request(), {}));
    expect(refused.body).toMatchObject({ code: 'CLOUDFLARE_NOT_CONFIGURED', missing, error: notConfiguredMessage(missing) });
    expect(JSON.stringify([status.body, refused.body])).not.toContain(TOKEN);
  });

  it('says where each missing thing comes from: the token from the Keys tab, the zone id from Terraform', () => {
    const token = notConfiguredMessage(['token']);
    expect(token).toMatch(/admin token \(CLOUDFLARE_ADMIN_TOKEN\).*Integrations → Keys/);
    expect(token).not.toMatch(/CF_ZONE_ID|Terraform/);
    const zone = notConfiguredMessage(['zoneId']);
    expect(zone).toMatch(/zone id \(CF_ZONE_ID\).*Terraform sets it on the next apply of the hcw-azure workspace, so it is not pasted on the Keys tab/);
    expect(zone).not.toMatch(/CLOUDFLARE_ADMIN_TOKEN|Integrations → Keys/);
    expect(notConfiguredMessage(['token', 'zoneId'])).toMatch(/Two things are missing: .*Integrations → Keys.*; and the zone id .*Terraform/);
    expect(Object.keys(PREREQUISITES)).toEqual(['token', 'zoneId']);
  });

  it('says so on the status route with 200, and lists what is protected and what may be edited', async () => {
    for (const env of envs) {
      const { handlers, api } = setup({ env });
      const res = parse(await handlers.getStatus(request(), {}));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ configured: false, zone: null, families: [] });
      expect(res.body.protected.phases.map((p) => p.phase)).toContain('http_request_late_transform');
      expect(res.body.protected.editablePhases.map((p) => p.phase)).toEqual(EDITABLE_PHASES.map((p) => p.phase));
      expect(res.body.protected.ownerOnlySettings.map((s) => s.setting)).toEqual(OWNER_ONLY_SETTINGS.map((s) => s.setting));
      expect(api.fetch).not.toHaveBeenCalled();
    }
  });

  it('answers 503 CLOUDFLARE_NOT_CONFIGURED on every other route', async () => {
    for (const env of envs) {
      for (const [name, , req] of ROUTES.filter(([route]) => route !== 'getStatus')) {
        const { handlers, api } = setup({ env });
        const res = parse(await handlers[name](req, {}));
        expect(res.status, name).toBe(503);
        expect(res.body.code).toBe('CLOUDFLARE_NOT_CONFIGURED');
        expect(api.fetch).not.toHaveBeenCalled();
      }
    }
  });
});

describe('the status route', () => {
  it('shows the zone, and which families the token can read', async () => {
    const { handlers } = setup({
      routes: {
        [`GET ${ZONE_PATH}/settings/ssl`]: ok({ id: 'ssl', value: 'strict' }),
        [`GET ${ZONE_PATH}/dns_records`]: reply(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] }),
        [`GET ${ZONE_PATH}/rulesets`]: ok([]),
        [`GET ${ZONE_PATH}/settings/cache_level`]: reply(500, {}),
      },
    });
    const res = parse(await handlers.getStatus(request(), { warn: vi.fn() }));
    expect(res.body.configured).toBe(true);
    expect(res.body.missing).toEqual([]);
    expect(res.body.zone).toEqual({ id: ZONE, name: ZONE_APEX, status: 'active', plan: 'Free Website' });
    expect(res.body.zoneError).toBeNull();
    expect(Object.fromEntries(res.body.families.map((f) => [f.id, f.readable]))).toEqual({ settings: true, dns: false, rules: true, cache: null });
    expect(JSON.stringify(res.body)).not.toContain('someone@example.com');
  });

  it('still answers when the zone cannot be read, with a sentence of its own', async () => {
    const { handlers } = setup({ routes: { [`GET ${ZONE_PATH}`]: reply(403, { success: false, errors: [{ code: 9109, message: `far-end words ${TOKEN}` }] }) } });
    const res = parse(await handlers.getStatus(request(), { warn: vi.fn() }));
    expect(res.status).toBe(200);
    expect(res.body.zone).toBeNull();
    expect(res.body.zoneError).toMatch(/refused the token .*HTTP 403.*9109/);
    expect(JSON.stringify(res.body)).not.toMatch(/far-end words/);
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
  });
});

describe('the zone check before any change', () => {
  // Each change, with the Cloudflare routes it would need if the zone were right.
  const changes = [
    ['patchSetting', request({ params: { settingId: 'brotli' }, body: { value: 'on' } })],
    ['purge', request({ body: { everything: true } })],
    ['createDns', request({ body: { type: 'A', name: 'blog', content: '192.0.2.1' } })],
    ['patchDns', request({ params: { recordId: RECORD_ID }, body: { proxied: true } })],
    ['putPhase', request({ params: { phase: REDIRECT }, body: { rules: [RULE], expectedVersion: null } })],
  ];

  it.each(changes)('%s refuses with 409 when the zone id points at another zone, reading only the zone', async (name, req) => {
    const { handlers, api, store, notifier } = setup({ user: NETWORK_GUY, routes: { [`GET ${ZONE_PATH}`]: zoneReply('example.com') } });
    const res = parse(await handlers[name](req, { warn: vi.fn() }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CLOUDFLARE_WRONG_ZONE');
    expect(res.body.error).toBe(WRONG_ZONE_MESSAGE);
    expect(methods(api)).toEqual(['GET ']);
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(notifier.notifyTelegram).not.toHaveBeenCalled();
  });

  it.each(changes)('%s checks the body before it calls Cloudflare at all', async (name, req) => {
    const { handlers, api } = setup();
    const broken = { ...req, text: async () => '[1]' };
    expect(parse(await handlers[name](broken, {})).status).toBe(400);
    expect(api.fetch).not.toHaveBeenCalled();
  });
});

describe('the request body', () => {
  const route = (handlers, req) => handlers.patchSetting({ ...req, params: { settingId: 'brotli' } }, {});

  it('refuses a declared length over the limit without reading the body', async () => {
    const { handlers, api } = setup();
    const text = vi.fn(async () => '{"value":"on"}');
    const res = parse(await route(handlers, { ...request({ headers: { 'content-length': String(MAX_BODY_BYTES + 1) } }), text }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at most 65536 bytes/);
    expect(text).not.toHaveBeenCalled();
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it('stops reading a stream the moment it passes the limit, and parses nothing', async () => {
    const { handlers, api } = setup();
    const chunk = new Uint8Array(16 * 1024).fill(32);
    let reads = 0;
    const reader = { read: vi.fn(async () => ((reads += 1), { done: false, value: chunk })), cancel: vi.fn(async () => {}) };
    const res = parse(await route(handlers, { ...request(), body: { getReader: () => reader } }));
    expect(res.status).toBe(400);
    expect(reads).toBe(5);
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it('reads a small stream whole', async () => {
    const { handlers } = setup({
      routes: { [`GET ${ZONE_PATH}/settings/brotli`]: ok({ id: 'brotli', value: 'off' }), [`PATCH ${ZONE_PATH}/settings/brotli`]: ok({ id: 'brotli', value: 'on' }) },
    });
    const bytes = new TextEncoder().encode('{"value":"on"}');
    const chunks = [{ done: false, value: bytes }, { done: true }];
    const reader = { read: vi.fn(async () => chunks.shift()), cancel: vi.fn() };
    expect(parse(await route(handlers, { ...request(), body: { getReader: () => reader } })).status).toBe(200);
  });

  it('refuses a text body over the limit counted in bytes, not characters', async () => {
    const { handlers, api } = setup();
    const text = JSON.stringify({ value: 'é'.repeat(MAX_BODY_BYTES / 2) });
    expect(text.length).toBeLessThan(MAX_BODY_BYTES + 20);
    expect(parse(await route(handlers, request({ text }))).status).toBe(400);
    expect(api.fetch).not.toHaveBeenCalled();
  });
});

describe('zone settings', () => {
  const brotli = (patch = ok({ id: 'brotli', value: 'on', editable: true })) => ({
    [`GET ${ZONE_PATH}/settings/brotli`]: ok({ id: 'brotli', value: 'off' }),
    [`PATCH ${ZONE_PATH}/settings/brotli`]: patch,
  });

  it('lists every setting', async () => {
    const { handlers } = setup({
      routes: { [`GET ${ZONE_PATH}/settings`]: ok([{ id: 'ssl', value: 'strict', editable: true, modified_on: '2026-01-01T00:00:00Z' }]) },
    });
    const res = parse(await handlers.getSettings(request(), {}));
    expect(res.body.settings).toEqual([{ id: 'ssl', value: 'strict', editable: true, modifiedOn: '2026-01-01T00:00:00Z' }]);
  });

  it.each(['', 'SSL', 'a-b', '../dns_records', 'a'.repeat(65), 'ssl%2F..'])('refuses the setting id %j before calling Cloudflare', async (settingId) => {
    const { handlers, api, store } = setup();
    const res = parse(await handlers.patchSetting(request({ params: { settingId }, body: { value: 'on' } }), {}));
    expect(res.status).toBe(400);
    expect(api.fetch).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ value: 'on', extra: 1 }], ['[1]'], ['not json']])('refuses the body %j', async (body) => {
    const { handlers, api } = setup();
    const req = typeof body === 'string' ? request({ params: { settingId: 'ssl' }, text: body }) : request({ params: { settingId: 'ssl' }, body });
    expect(parse(await handlers.patchSetting(req, {})).status).toBe(400);
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it('reads the value first, changes it, and writes one audit row with before and after; nothing to the phone for a person', async () => {
    const { handlers, api, store, notifier } = setup({ routes: brotli() });
    const res = parse(await handlers.patchSetting(request({ params: { settingId: 'brotli' }, body: { value: 'on' } }), {}));
    expect(res.status).toBe(200);
    expect(res.body.setting).toMatchObject({ id: 'brotli', value: 'on' });
    expect(methods(api)).toEqual(['GET ', 'GET /settings/brotli', 'PATCH /settings/brotli']);
    expect(api.calls[2]).toMatchObject({ method: 'PATCH', body: { value: 'on' } });
    expect(store.upsertDoc).toHaveBeenCalledTimes(1);
    const [container, row] = store.upsertDoc.mock.calls[0];
    expect(container).toBe('admin_audit_logs');
    expect(row).toMatchObject({
      id: 'audit-1',
      action: 'cloudflare_change',
      resourceType: 'cloudflare',
      userId: 'person-oid',
      userEmail: 'owner@example.com',
      details: { family: 'settings', settingId: 'brotli', before: 'off', after: 'on' },
    });
    expect(row.agent).toBeUndefined();
    expect(notifier.notifyTelegram).not.toHaveBeenCalled();
  });

  it('changes nothing when the read of the current value fails', async () => {
    const { handlers, api, store } = setup({ routes: { [`GET ${ZONE_PATH}/settings/brotli`]: reply(500, {}) } });
    const res = await handlers.patchSetting(request({ params: { settingId: 'brotli' }, body: { value: 'on' } }), { warn: vi.fn() });
    expect(res.status).toBe(502);
    expect(WRITES(api)).toEqual([]);
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('names the agent key in the audit row and tells the owner’s phone when the caller is one', async () => {
    const { handlers, store, notifier } = setup({ user: NETWORK_GUY, routes: brotli() });
    await handlers.patchSetting(request({ params: { settingId: 'brotli' }, body: { value: 'on' } }), {});
    expect(store.upsertDoc.mock.calls[0][1]).toMatchObject({ agent: 'claude-network', userId: 'agent:claude-network' });
    expect(notifier.notifyTelegram).toHaveBeenCalledTimes(1);
    expect(notifier.notifyTelegram.mock.calls[0][0]).toMatchObject({
      source: 'cloudflare-change:claude-network:audit-1',
      message: `Claude Network Guy changed the Cloudflare zone setting brotli. Zone: ${ZONE_APEX}.`,
    });
  });

  it('sends every one of an agent’s changes to the phone under its own source, so no cooldown swallows one', async () => {
    const { handlers, notifier } = setup({ user: NETWORK_GUY, routes: brotli() });
    for (let i = 0; i < 3; i += 1) await handlers.patchSetting(request({ params: { settingId: 'brotli' }, body: { value: 'on' } }), {});
    const sources = notifier.notifyTelegram.mock.calls.map(([sent]) => sent.source);
    expect(sources).toEqual(['cloudflare-change:claude-network:audit-1', 'cloudflare-change:claude-network:audit-2', 'cloudflare-change:claude-network:audit-3']);
  });

  it('shows every per-change source as the Cloudflare page on the phone', () => {
    const text = formatTelegramText({ title: 't', message: 'm', severity: 'info', source: 'cloudflare-change:claude-network:audit-7' });
    expect(text).toContain('Reported by the Cloudflare page.');
    expect(text).not.toContain('audit-7');
  });

  it.each(OWNER_ONLY_SETTINGS.map((entry) => entry.setting))('refuses an agent key the owner-only setting %s with 403 and the reason, calling nothing', async (settingId) => {
    const { handlers, api, store, notifier } = setup({ user: NETWORK_GUY });
    const res = parse(await handlers.patchSetting(request({ params: { settingId }, body: { value: 'off' } }), {}));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CLOUDFLARE_OWNER_ONLY');
    expect(res.body.error).toMatch(/Change it on the Cloudflare page yourself/);
    expect(res.body.reason).toBe(OWNER_ONLY_SETTINGS.find((entry) => entry.setting === settingId).reason);
    expect(api.fetch).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(notifier.notifyTelegram).not.toHaveBeenCalled();
  });

  it('lets a super_admin person change an owner-only setting', async () => {
    const { handlers, store } = setup({
      routes: { [`GET ${ZONE_PATH}/settings/ssl`]: ok({ id: 'ssl', value: 'full' }), [`PATCH ${ZONE_PATH}/settings/ssl`]: ok({ id: 'ssl', value: 'strict' }) },
    });
    const res = parse(await handlers.patchSetting(request({ params: { settingId: 'ssl' }, body: { value: 'strict' } }), {}));
    expect(res.status).toBe(200);
    expect(store.upsertDoc.mock.calls[0][1].details).toEqual({ zone: ZONE_APEX, family: 'settings', settingId: 'ssl', before: 'full', after: 'strict' });
  });
});

describe('cache purge', () => {
  const purgeRoute = (calls) => ({ [`POST ${ZONE_PATH}/purge_cache`]: (url, init) => (calls.push(JSON.parse(init.body)), ok({ id: ZONE })) });

  it('purges everything, after the zone check', async () => {
    const sent = [];
    const { handlers, api, store } = setup({ routes: purgeRoute(sent) });
    const res = parse(await handlers.purge(request({ body: { everything: true } }), {}));
    expect(res.body.purged).toBe('everything');
    expect(methods(api)).toEqual(['GET ', 'POST /purge_cache']);
    expect(sent).toEqual([{ purge_everything: true }]);
    expect(store.upsertDoc.mock.calls[0][1].details).toEqual({ zone: ZONE_APEX, family: 'cache', purge: 'everything' });
  });

  it('purges up to thirty https addresses on the zone’s own names', async () => {
    const sent = [];
    const { handlers, store } = setup({ routes: purgeRoute(sent) });
    const files = [`https://${ZONE_APEX}/a.css`, `https://www.${ZONE_APEX}/b.js?v=1`];
    const res = parse(await handlers.purge(request({ body: { files } }), {}));
    expect(res.body.purged).toBe(2);
    expect(sent).toEqual([{ files }]);
    expect(store.upsertDoc.mock.calls[0][1].details).toEqual({ zone: ZONE_APEX, family: 'cache', purge: 'files', count: 2 });
  });

  it.each([
    [{ files: [] }],
    [{ files: Array.from({ length: MAX_PURGE_FILES + 1 }, (_, i) => `https://${ZONE_APEX}/${i}`) }],
    [{ files: [`http://${ZONE_APEX}/a`] }],
    [{ files: ['https://example.org/a'] }],
    [{ files: [`https://not${ZONE_APEX}/a`] }],
    [{ files: [`https://user:pass@${ZONE_APEX}/a`] }],
    [{ files: [`https://${ZONE_APEX}/${'a'.repeat(2048)}`] }],
    [{ files: ['not a url'] }],
    [{ files: [42] }],
    [{ everything: false }],
    [{ everything: true, files: [`https://${ZONE_APEX}/a`] }],
    [{ everything: 'yes' }],
    [{ purge_everything: true }],
  ])('refuses %j and calls nothing', async (body) => {
    const sent = [];
    const { handlers, api, store } = setup({ routes: purgeRoute(sent) });
    expect(parse(await handlers.purge(request({ body }), {})).status).toBe(400);
    expect(api.fetch).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });
});

describe('DNS records', () => {
  const record = (over = {}) => ({ id: RECORD_ID, type: 'A', name: `blog.${ZONE_APEX}`, content: '192.0.2.1', proxied: true, ttl: 1, comment: null, ...over });
  const created = { [`POST ${ZONE_PATH}/dns_records`]: (url, init) => ok(record(JSON.parse(init.body))) };

  it('lists every page, and marks the protected ones with their reason', async () => {
    const { handlers, api } = setup({
      routes: {
        [`GET ${ZONE_PATH}/dns_records`]: (url) =>
          url.searchParams.get('page') === '1'
            ? ok([record(), record({ id: 'b', name: `www.${ZONE_APEX}` })], { result_info: { page: 1, total_pages: 2 } })
            : ok([record({ id: 'c', name: `_acme-challenge.${ZONE_APEX}`, type: 'TXT' })], { result_info: { page: 2, total_pages: 2 } }),
      },
    });
    const res = parse(await handlers.listDns(request(), {}));
    expect(api.calls.map((call) => call.query.get('page'))).toEqual(['1', '2']);
    expect(res.body.records.map((r) => [r.id, r.locked])).toEqual([[RECORD_ID, false], ['b', true], ['c', true]]);
    expect(res.body.records[1].lockedReason).toMatch(/Static Web App/);
    expect(res.body.truncated).toBe(false);
  });

  it('stops at the page cap and says the list is cut', async () => {
    const { handlers, api } = setup({
      routes: { [`GET ${ZONE_PATH}/dns_records`]: (url) => ok([record({ id: url.searchParams.get('page') })], { result_info: { total_pages: DNS_MAX_PAGES + 10 } }) },
    });
    const res = parse(await handlers.listDns(request(), {}));
    expect(api.calls).toHaveLength(DNS_MAX_PAGES);
    expect(res.body.records).toHaveLength(DNS_MAX_PAGES);
    expect(res.body.truncated).toBe(true);
  });

  it.each(['@', ZONE_APEX, 'www', `www.${ZONE_APEX}`, 'api-azure', `docs.${ZONE_APEX}`, '_acme-challenge.blog', `x.lab.${ZONE_APEX}`, 'lab', '*', `*.${ZONE_APEX}`, '*.api-azure', '*.www', '*._acme-challenge', '*.lab', '*.x.lab', 'WWW'])(
    'refuses to add a record named %j, with the reason, and calls nothing',
    async (name) => {
      const { handlers, api, store, notifier } = setup({ user: NETWORK_GUY });
      const res = parse(await handlers.createDns(request({ body: { type: 'CNAME', name, content: 'example.net' } }), {}));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CLOUDFLARE_PROTECTED');
      expect(res.body.reason).toBeTruthy();
      expect(api.fetch).not.toHaveBeenCalled();
      expect(store.upsertDoc).not.toHaveBeenCalled();
      expect(notifier.notifyTelegram).not.toHaveBeenCalled();
    }
  );

  it.each(['.blog', 'blog.', 'a..b', '..', '.', 'blog@', '@.blog', 'a.@', 'blog.*', 'a*', '*a.blog', '**', `${'a'.repeat(64)}.blog`, `api-azure.${ZONE_APEX}.`])(
    'refuses the badly formed name %j with 400, and calls nothing',
    async (name) => {
      const { handlers, api } = setup();
      const res = parse(await handlers.createDns(request({ body: { type: 'A', name, content: '192.0.2.1' } }), {}));
      expect(res.status).toBe(400);
      expect(api.fetch).not.toHaveBeenCalled();
    }
  );

  it.each([
    [{ type: 'NS', name: 'blog', content: 'ns.example.net' }],
    [{ type: 'A', name: 'blog' }],
    [{ type: 'A', name: '', content: '192.0.2.1' }],
    [{ type: 'A', name: 'bad name', content: '192.0.2.1' }],
    [{ type: 'A', name: 'blog', content: '192.0.2.1', ttl: 30 }],
    [{ type: 'A', name: 'blog', content: '192.0.2.1', proxied: 'yes' }],
    [{ type: 'A', name: 'blog', content: '192.0.2.1', comment: 'x'.repeat(101) }],
    [{ type: 'A', name: 'blog', content: '192.0.2.1', priority: -1 }],
    [{ type: 'A', name: 'blog', content: '192.0.2.1', id: 'x' }],
  ])('refuses the record %j', async (body) => {
    const { handlers, api } = setup();
    expect(parse(await handlers.createDns(request({ body }), {})).status).toBe(400);
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it('adds a record that is not protected, sending the full name that was checked, and records it without its content', async () => {
    const { handlers, api, store, notifier } = setup({ user: NETWORK_GUY, routes: created });
    const res = parse(await handlers.createDns(request({ body: { type: 'a', name: 'Blog', content: '192.0.2.1', ttl: 300, proxied: false } }), {}));
    expect(res.status).toBe(201);
    expect(methods(api)).toEqual(['GET ', 'POST /dns_records']);
    expect(api.calls[1].body).toEqual({ type: 'A', name: `blog.${ZONE_APEX}`, content: '192.0.2.1', ttl: 300, proxied: false });
    expect(store.upsertDoc.mock.calls[0][1].details).toEqual({
      zone: ZONE_APEX,
      family: 'dns',
      change: 'create',
      recordType: 'A',
      name: `blog.${ZONE_APEX}`,
      before: null,
      after: { proxied: false, ttl: 300 },
    });
    expect(JSON.stringify(store.upsertDoc.mock.calls)).not.toContain('192.0.2.1');
    expect(notifier.notifyTelegram.mock.calls[0][0].message).toBe(`Claude Network Guy added the A record blog.${ZONE_APEX} in Cloudflare. Zone: ${ZONE_APEX}.`);
  });

  it.each([['@', ZONE_APEX], ['*.blog', `*.blog.${ZONE_APEX}`], [`shop.${ZONE_APEX}`, `shop.${ZONE_APEX}`], ['_dmarc.shop', `_dmarc.shop.${ZONE_APEX}`]])(
    'reads %j as %j',
    async (name, full) => {
      if (name === '@') return; // the apex is protected; checked above
      const { handlers, api } = setup({ routes: created });
      expect(parse(await handlers.createDns(request({ body: { type: 'TXT', name, content: 'v=example' } }), {})).status).toBe(201);
      expect(api.calls[1].body.name).toBe(full);
    }
  );

  it('refuses an edit when the record’s current name is protected, after reading it', async () => {
    const { handlers, api, store } = setup({ routes: { [`GET ${ZONE_PATH}/dns_records/${RECORD_ID}`]: ok(record({ name: `api-azure.${ZONE_APEX}` })) } });
    const res = parse(await handlers.patchDns(request({ params: { recordId: RECORD_ID }, body: { proxied: false } }), {}));
    expect(res.status).toBe(409);
    expect(methods(api)).toEqual(['GET ', `GET /dns_records/${RECORD_ID}`]);
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it.each(['NS', 'CAA', 'SRV', 'HTTPS', ''])('refuses an edit to a record whose current type is %j, after reading it', async (type) => {
    const { handlers, api, store } = setup({ routes: { [`GET ${ZONE_PATH}/dns_records/${RECORD_ID}`]: ok(record({ type })) } });
    const res = parse(await handlers.patchDns(request({ params: { recordId: RECORD_ID }, body: { type: 'A', content: '192.0.2.9' } }), {}));
    expect(res.status).toBe(409);
    expect(res.body.reason).toMatch(/Cloudflare dashboard/);
    expect(WRITES(api)).toEqual([]);
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('refuses an edit that asks for a different record type, after reading it, and writes nothing', async () => {
    const { handlers, api, store } = setup({ routes: { [`GET ${ZONE_PATH}/dns_records/${RECORD_ID}`]: ok(record()) } });
    const res = parse(await handlers.patchDns(request({ params: { recordId: RECORD_ID }, body: { type: 'MX', content: 'mail.example.com', priority: 10 } }), {}));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/type cannot be changed/);
    expect(WRITES(api)).toEqual([]);
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('accepts an edit that names the record’s own type', async () => {
    const { handlers, api } = setup({
      routes: {
        [`GET ${ZONE_PATH}/dns_records/${RECORD_ID}`]: ok(record()),
        [`PATCH ${ZONE_PATH}/dns_records/${RECORD_ID}`]: ok(record({ content: '192.0.2.8' })),
      },
    });
    const res = parse(await handlers.patchDns(request({ params: { recordId: RECORD_ID }, body: { type: 'A', content: '192.0.2.8' } }), {}));
    expect(res.status).toBe(200);
    expect(WRITES(api)).toHaveLength(1);
  });

  it.each(['www', '*.api-azure', '*'])('refuses an edit that would rename a record onto %j, before calling Cloudflare', async (name) => {
    const { handlers, api } = setup({ routes: { [`GET ${ZONE_PATH}/dns_records/${RECORD_ID}`]: ok(record()) } });
    const res = parse(await handlers.patchDns(request({ params: { recordId: RECORD_ID }, body: { name } }), {}));
    expect(res.status).toBe(409);
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it.each(['', 'abc', '../settings', 'g'.repeat(32)])('refuses the record id %j before calling Cloudflare', async (recordId) => {
    const { handlers, api } = setup();
    expect(parse(await handlers.patchDns(request({ params: { recordId }, body: { proxied: true } }), {})).status).toBe(400);
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it('refuses an edit that changes nothing', async () => {
    const { handlers, api } = setup();
    expect(parse(await handlers.patchDns(request({ params: { recordId: RECORD_ID }, body: {} }), {})).status).toBe(400);
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it('edits a record that is not protected, and records the type, name, proxied and ttl before and after, never the content', async () => {
    const { handlers, api, store } = setup({
      routes: {
        [`GET ${ZONE_PATH}/dns_records/${RECORD_ID}`]: ok(record()),
        [`PATCH ${ZONE_PATH}/dns_records/${RECORD_ID}`]: ok(record({ proxied: false, ttl: 300, content: '192.0.2.7' })),
      },
    });
    const res = parse(await handlers.patchDns(request({ params: { recordId: RECORD_ID }, body: { proxied: false, ttl: 300, content: '192.0.2.7' } }), {}));
    expect(res.status).toBe(200);
    expect(api.calls[2]).toMatchObject({ method: 'PATCH', body: { proxied: false, ttl: 300, content: '192.0.2.7' } });
    expect(store.upsertDoc.mock.calls[0][1].details).toEqual({
      zone: ZONE_APEX,
      family: 'dns',
      change: 'edit',
      recordType: 'A',
      name: `blog.${ZONE_APEX}`,
      before: { proxied: true, ttl: 1 },
      after: { proxied: false, ttl: 300 },
    });
    expect(JSON.stringify(store.upsertDoc.mock.calls)).not.toMatch(/192\.0\.2\.[17]/);
  });

  it('sends a new name in full, and records the old one', async () => {
    const { handlers, api, store } = setup({
      routes: {
        [`GET ${ZONE_PATH}/dns_records/${RECORD_ID}`]: ok(record()),
        [`PATCH ${ZONE_PATH}/dns_records/${RECORD_ID}`]: (url, init) => ok(record(JSON.parse(init.body))),
      },
    });
    await handlers.patchDns(request({ params: { recordId: RECORD_ID }, body: { name: 'Shop' } }), {});
    expect(api.calls[2].body).toEqual({ name: `shop.${ZONE_APEX}` });
    expect(store.upsertDoc.mock.calls[0][1].details).toMatchObject({ name: `shop.${ZONE_APEX}`, previousName: `blog.${ZONE_APEX}` });
  });

  it('answers protectedAfterWrite: false for an ordinary edit', async () => {
    const { handlers } = setup({
      routes: { [`GET ${ZONE_PATH}/dns_records/${RECORD_ID}`]: ok(record()), [`PATCH ${ZONE_PATH}/dns_records/${RECORD_ID}`]: ok(record({ proxied: false })) },
    });
    const res = parse(await handlers.patchDns(request({ params: { recordId: RECORD_ID }, body: { proxied: false } }), {}));
    expect(res.body).toMatchObject({ ok: true, audited: true, protectedAfterWrite: false });
  });

  it.each([
    ['a person', PERSON, 'Someone signed in to the admin portal'],
    ['an agent key', NETWORK_GUY, 'Claude Network Guy'],
  ])('still records an edit whose saved record came back with a protected name, and warns the owner, for %s', async (label, user, actor) => {
    // Our read sees an open name; the record was renamed onto a protected one before our write landed.
    const { handlers, store, notifier, context } = setup({
      user,
      routes: {
        [`GET ${ZONE_PATH}/dns_records/${RECORD_ID}`]: ok(record()),
        [`PATCH ${ZONE_PATH}/dns_records/${RECORD_ID}`]: ok(record({ name: `www.${ZONE_APEX}`, proxied: false })),
      },
    });
    const res = parse(await handlers.patchDns(request({ params: { recordId: RECORD_ID }, body: { proxied: false } }), context));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, audited: true, protectedAfterWrite: true });
    expect(res.body.record).toMatchObject({ name: `www.${ZONE_APEX}`, locked: true });
    expect(store.upsertDoc).toHaveBeenCalledTimes(1);
    expect(store.upsertDoc.mock.calls[0][1].details).toMatchObject({ name: `www.${ZONE_APEX}`, protectedAfterWrite: true });
    expect(notifier.notifyTelegram).toHaveBeenCalledTimes(1);
    const sent = notifier.notifyTelegram.mock.calls[0][0];
    expect(sent).toMatchObject({ severity: 'warning', source: 'cloudflare-check:audit-1' });
    expect(sent.message).toBe(
      `${actor} edited the A record www.${ZONE_APEX} in Cloudflare. Zone: ${ZONE_APEX}. The record now carries the protected name www.${ZONE_APEX}, which this page never edits. Check it in the Cloudflare dashboard.`
    );
    expect(logs(context)).not.toContain(ZONE_APEX);
    expect(context.warn).toHaveBeenCalledWith('[cloudflare] dns-edit: the saved record carries a protected name');
  });

  it('puts both warnings in one message when the saved name is protected and the audit row failed', async () => {
    const { handlers, store, notifier } = setup({
      routes: {
        [`GET ${ZONE_PATH}/dns_records/${RECORD_ID}`]: ok(record()),
        [`PATCH ${ZONE_PATH}/dns_records/${RECORD_ID}`]: ok(record({ name: `api-azure.${ZONE_APEX}` })),
      },
    });
    store.upsertDoc.mockRejectedValue(new Error('down'));
    const res = parse(await handlers.patchDns(request({ params: { recordId: RECORD_ID }, body: { proxied: false } }), { error: vi.fn(), warn: vi.fn() }));
    expect(res.body).toMatchObject({ audited: false, protectedAfterWrite: true });
    expect(notifier.notifyTelegram).toHaveBeenCalledTimes(1);
    expect(notifier.notifyTelegram.mock.calls[0][0].message).toMatch(/protected name api-azure\..*audit row could not be written/);
  });
});

describe('rules', () => {
  const LATE = 'http_request_late_transform';
  const ORIGIN_RULE = {
    id: 'origin-1',
    description: 'Origin secret',
    expression: `(http.host eq "api-azure.${ZONE_APEX}")`,
    action: 'rewrite',
    enabled: true,
    version: '4',
    action_parameters: { headers: { 'x-hcw-origin-secret': { operation: 'set', value: ORIGIN_SECRET } } },
    logging: { enabled: true },
  };
  const LATE_RULESET = { id: 'r1', name: 'origin', phase: LATE, kind: 'zone', version: '7', rules: [ORIGIN_RULE] };
  const SECRETISH = {
    id: 'h1',
    expression: 'true',
    action: 'rewrite',
    action_parameters: {
      headers: {
        'x-api-key': { operation: 'set', value: ORIGIN_SECRET },
        'X-Auth-Token': { operation: 'set', value: ORIGIN_SECRET },
        'x-cache-hint': { operation: 'set', value: 'warm' },
      },
    },
  };
  const entrypoint = (phase, ruleset) => ({ [`GET ${PHASES}/${phase}/entrypoint`]: ok(ruleset) });
  // The saved rule set comes back with the next version unless a test names
  // another (a version further on means a write landed in between).
  const put = (phase, version) => ({
    [`PUT ${PHASES}/${phase}/entrypoint`]: (url, init) => ok({ id: 'r2', phase, ...(version ? { version } : {}), ...JSON.parse(init.body) }),
  });
  const replace = (phase, body) => request({ params: { phase }, body: { expectedVersion: '3', ...body } });
  const current = (phase, version = '3') => entrypoint(phase, { id: 'r2', phase, version, rules: [] });

  it('lists the zone’s rulesets, locked unless on the allow-list, with no rules in the answer', async () => {
    const { handlers } = setup({
      routes: {
        [`GET ${ZONE_PATH}/rulesets`]: ok([
          LATE_RULESET,
          { id: 'r2', name: 'redirects', phase: REDIRECT, kind: 'zone', version: '2', rules: [SECRETISH] },
          { id: 'r3', name: 'origin rules', phase: 'http_request_origin', kind: 'zone' },
          { id: 'r4', name: 'custom', phase: 'http_request_firewall_custom', kind: 'zone' },
        ]),
      },
    });
    const res = parse(await handlers.listRulesets(request(), {}));
    expect(res.body.rulesets.map((r) => [r.phase, r.locked])).toEqual([
      [LATE, true],
      [REDIRECT, false],
      ['http_request_origin', true],
      ['http_request_firewall_custom', false],
    ]);
    expect(res.body.rulesets[2].lockedReason).toBe(READ_ONLY_PHASE_REASON);
    expect(res.body.rulesets[1].version).toBe('2');
    for (const ruleset of res.body.rulesets) expect(ruleset.rules).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(ORIGIN_SECRET);
  });

  it('reads a phase that may not be replaced as a summary of each rule only, never its parameters', async () => {
    const { handlers } = setup({ routes: entrypoint(LATE, LATE_RULESET) });
    const res = parse(await handlers.getPhase(request({ params: { phase: LATE } }), {}));
    expect(res.body.ruleset.rules).toEqual([
      { id: 'origin-1', description: 'Origin secret', expression: ORIGIN_RULE.expression, action: 'rewrite', enabled: true },
    ]);
    expect(res.body).toMatchObject({ editable: false, locked: true, version: '7' });
    expect(JSON.stringify(res.body)).not.toContain(ORIGIN_SECRET);
    expect(JSON.stringify(res.body)).not.toContain('action_parameters');
  });

  it('reads an editable phase in full, with every secret-sounding header value hidden', async () => {
    const { handlers } = setup({ routes: entrypoint(REDIRECT, { id: 'r2', phase: REDIRECT, version: '3', rules: [SECRETISH] }) });
    const found = parse(await handlers.getPhase(request({ params: { phase: REDIRECT } }), {}));
    expect(found.body).toMatchObject({ editable: true, locked: false, version: '3' });
    const headers = found.body.ruleset.rules[0].action_parameters.headers;
    expect(headers['x-api-key'].value).toBe(REDACTED_VALUE);
    expect(headers['X-Auth-Token'].value).toBe(REDACTED_VALUE);
    expect(headers['x-cache-hint'].value).toBe('warm');
    expect(JSON.stringify(found.body)).not.toContain(ORIGIN_SECRET);
  });

  it('answers null for a phase with no rules yet', async () => {
    const { handlers } = setup();
    const none = parse(await handlers.getPhase(request({ params: { phase: 'http_request_cache_settings' } }), {}));
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({ ruleset: null, version: null, editable: false });
  });

  it('never lets the origin secret out of any route, whatever it reads', async () => {
    const routes = {
      [`GET ${ZONE_PATH}/rulesets`]: ok([LATE_RULESET]),
      [`GET ${ZONE_PATH}/rulesets/phases/${LATE}/entrypoint`]: ok(LATE_RULESET),
      [`GET ${ZONE_PATH}/rulesets/phases/${REDIRECT}/entrypoint`]: ok({ id: 'r2', phase: REDIRECT, version: '3', rules: [SECRETISH] }),
      [`PUT ${ZONE_PATH}/rulesets/phases/${REDIRECT}/entrypoint`]: ok({ id: 'r2', phase: REDIRECT, version: '4', rules: [SECRETISH] }),
      [`GET ${ZONE_PATH}/settings/ssl`]: ok({ id: 'ssl', value: 'strict' }),
      [`GET ${ZONE_PATH}/dns_records`]: ok([]),
      [`GET ${ZONE_PATH}/settings`]: ok([]),
    };
    const reqs = [
      ['getStatus', request()],
      ['getSettings', request()],
      ['listDns', request()],
      ['listRulesets', request()],
      ['getPhase', request({ params: { phase: LATE } })],
      ['getPhase', request({ params: { phase: REDIRECT } })],
      ['putPhase', replace(REDIRECT, { rules: [RULE] })],
      ['putPhase', request({ params: { phase: LATE }, body: { rules: [ORIGIN_RULE], expectedVersion: '7' } })],
    ];
    for (const user of [PERSON, NETWORK_GUY]) {
      for (const [name, req] of reqs) {
        const { handlers, store, notifier, context } = setup({ user, routes });
        const res = await handlers[name](req, context);
        expect(res.body, name).not.toContain(ORIGIN_SECRET);
        expect(JSON.stringify([store.upsertDoc.mock.calls, notifier.notifyTelegram.mock.calls]), name).not.toContain(ORIGIN_SECRET);
        expect(logs(context), name).not.toContain(ORIGIN_SECRET);
      }
    }
  });

  it.each(['', 'HTTP', 'http-request', '../x', 'a'.repeat(65)])('refuses the phase %j before calling Cloudflare', async (phase) => {
    const { handlers, api } = setup();
    expect(parse(await handlers.getPhase(request({ params: { phase } }), {})).status).toBe(400);
    expect(parse(await handlers.putPhase(request({ params: { phase }, body: { rules: [RULE], expectedVersion: null } }), {})).status).toBe(400);
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it('refuses to replace the Terraform phase http_request_late_transform, with its own reason, and calls nothing', async () => {
    const { handlers, api, store } = setup({ user: NETWORK_GUY });
    const res = parse(await handlers.putPhase(replace(LATE, { rules: [RULE] }), {}));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CLOUDFLARE_PROTECTED');
    expect(res.body.reason).not.toBe(READ_ONLY_PHASE_REASON);
    expect(api.fetch).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it.each([
    'http_request_origin',
    'http_request_cache_settings',
    'http_request_cloud_connector',
    'http_request_snippets',
    'http_request_firewall_managed',
    'ddos_l7',
    'http_request_a_phase_cloudflare_adds_later',
  ])('refuses to replace %s, which is not on the allow-list, for a person too', async (phase) => {
    for (const user of [PERSON, NETWORK_GUY]) {
      const { handlers, api, store } = setup({ user });
      const res = parse(await handlers.putPhase(replace(phase, { rules: [RULE] }), {}));
      expect(res.status).toBe(409);
      expect(res.body.reason).toBe(READ_ONLY_PHASE_REASON);
      expect(res.body.error).toMatch(/can send or store the site's traffic elsewhere, so it is changed in the Cloudflare dashboard/);
      expect(api.fetch).not.toHaveBeenCalled();
      expect(store.upsertDoc).not.toHaveBeenCalled();
    }
  });

  it.each([
    [{}],
    [{ rules: 'x' }],
    [{ rules: [1] }],
    [{ rules: [RULE], kind: 'zone' }],
    [{ rules: Array.from({ length: 101 }, () => ({})) }],
    [{ rules: [] }],
    [{ rules: [RULE], expectedVersion: 3 }],
    [{ rules: [RULE], expectedVersion: '' }],
  ])('refuses the rules %j before calling Cloudflare', async (body) => {
    const { handlers, api } = setup();
    const res = parse(await handlers.putPhase(request({ params: { phase: REDIRECT }, body: { expectedVersion: '3', ...body } }), {}));
    expect(res.status).toBe(400);
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it('refuses an empty list for everyone, saying it would delete every rule', async () => {
    for (const user of [PERSON, NETWORK_GUY]) {
      const { handlers } = setup({ user });
      const res = parse(await handlers.putPhase(replace(REDIRECT, { rules: [] }), {}));
      expect(res.body.error).toMatch(/deletes every rule in the phase/);
    }
  });

  it('refuses a body with no expectedVersion', async () => {
    const { handlers, api } = setup();
    const res = parse(await handlers.putPhase(request({ params: { phase: REDIRECT }, body: { rules: [RULE] } }), {}));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expectedVersion/);
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it.each(['skip', 'SKIP'])('refuses a custom security rule whose action is %s', async (action) => {
    const { handlers, api } = setup({ user: NETWORK_GUY });
    const rules = [{ expression: 'true', action: 'block' }, { expression: 'true', action, action_parameters: { ruleset: 'current' } }];
    const res = parse(await handlers.putPhase(replace('http_request_firewall_custom', { rules }), {}));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/may not skip/);
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it('refuses a replacement that sends a hidden value back', async () => {
    const { handlers, api } = setup();
    const rules = [{ ...SECRETISH, action_parameters: { headers: { 'x-api-key': { operation: 'set', value: REDACTED_VALUE } } } }];
    const res = parse(await handlers.putPhase(replace('http_request_transform', { rules }), {}));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/hidden value/);
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it('replaces an editable phase’s rules when the version still matches, and records it', async () => {
    const rules = [{ expression: 'true', action: 'block' }];
    const { handlers, api, store } = setup({ routes: { ...current('http_request_firewall_custom'), ...put('http_request_firewall_custom', '4') } });
    const res = parse(await handlers.putPhase(replace('http_request_firewall_custom', { rules, description: 'Custom' }), {}));
    expect(res.status).toBe(200);
    expect(methods(api)).toEqual(['GET ', 'GET /rulesets/phases/http_request_firewall_custom/entrypoint', 'PUT /rulesets/phases/http_request_firewall_custom/entrypoint']);
    expect(api.calls[2].body).toEqual({ rules, description: 'Custom' });
    expect(res.body.ruleset.version).toBe('4');
    expect(res.body.concurrentWrite).toBe(false);
    expect(store.upsertDoc.mock.calls[0][1].details).toEqual({ zone: ZONE_APEX, family: 'rules', phase: 'http_request_firewall_custom', count: 1 });
  });

  it.each([
    ['a person', undefined],
    ['an agent key', 'agent'],
  ])('warns when another write landed between the check and the write, for %s', async (_who, kind) => {
    const rules = [{ id: 'c1', expression: 'true', action: 'block', enabled: true }];
    const routes = { ...entrypoint('http_request_firewall_custom', { id: 'r2', phase: 'http_request_firewall_custom', version: '3', rules: [{ id: 'c1', expression: 'false', action: 'block', enabled: true }] }), ...put('http_request_firewall_custom', '5') };
    const { handlers, store, notifier } = setup({ ...(kind ? { user: NETWORK_GUY } : {}), routes });
    const res = parse(await handlers.putPhase(replace('http_request_firewall_custom', { rules }), {}));
    expect(res.status).toBe(200);
    expect(res.body.concurrentWrite).toBe(true);
    expect(store.upsertDoc.mock.calls[0][1].details).toMatchObject({ phase: 'http_request_firewall_custom', concurrentWrite: true });
    expect(notifier.notifyTelegram).toHaveBeenCalledTimes(1);
    expect(notifier.notifyTelegram.mock.calls[0][0].message).toMatch(/may have replaced it/);
  });

  it('does not warn when the version moved on by one, or when Cloudflare gave no version', async () => {
    expect(concurrentWriteNote({ version: '3' }, { version: '4' })).toBeNull();
    expect(concurrentWriteNote({ version: '3' }, {})).toBeNull();
    expect(concurrentWriteNote(null, { version: '1' })).toBeNull();
    expect(concurrentWriteNote(null, {})).toBeNull();
    expect(concurrentWriteNote({ last_updated: '2026-11-26T00:00:00Z' }, { last_updated: '2026-11-27T00:00:00Z' })).toBeNull();
    expect(concurrentWriteNote({ version: '3' }, { version: '5' })).toMatch(/may have replaced it/);
    // A phase with no rule set yet: the first write makes version 1, so 2 means two first writes raced.
    expect(concurrentWriteNote(null, { version: '2' })).toMatch(/may have replaced it/);
  });

  it('refuses with 409, writing nothing, when the phase changed since it was read', async () => {
    const { handlers, api, store, notifier } = setup({ user: NETWORK_GUY, routes: { ...current(REDIRECT, '4'), ...put(REDIRECT) } });
    const res = parse(await handlers.putPhase(replace(REDIRECT, { rules: [RULE] }), {}));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'CLOUDFLARE_STALE', error: STALE_MESSAGE });
    expect(WRITES(api)).toEqual([]);
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(notifier.notifyTelegram).not.toHaveBeenCalled();
  });

  it('uses last_updated as the version when Cloudflare gives no version', async () => {
    const stamp = '2026-11-01T00:00:00Z';
    const { handlers } = setup({ routes: { ...entrypoint(REDIRECT, { id: 'r2', phase: REDIRECT, last_updated: stamp, rules: [] }), ...put(REDIRECT) } });
    const read = parse(await handlers.getPhase(request({ params: { phase: REDIRECT } }), {}));
    expect(read.body.version).toBe(stamp);
    expect(parse(await handlers.putPhase(request({ params: { phase: REDIRECT }, body: { rules: [RULE], expectedVersion: stamp } }), {})).status).toBe(200);
  });

  it('accepts expectedVersion null for a phase with no rules yet, and refuses it once the phase has some', async () => {
    const fresh = setup({ routes: put(REDIRECT) });
    expect(parse(await fresh.handlers.putPhase(request({ params: { phase: REDIRECT }, body: { rules: [RULE], expectedVersion: null } }), {})).status).toBe(200);
    const taken = setup({ routes: { ...current(REDIRECT, '1'), ...put(REDIRECT) } });
    const res = parse(await taken.handlers.putPhase(request({ params: { phase: REDIRECT }, body: { rules: [RULE], expectedVersion: null } }), {}));
    expect(res.status).toBe(409);
    expect(WRITES(taken.api)).toEqual([]);
  });

  it('drops Cloudflare’s own version and last_updated stamps from a rule sent back, and keeps the rest', async () => {
    const stamped = [{ id: 'x1', ref: 'r1', version: '3', last_updated: '2026-11-01T00:00:00Z', expression: 'true', action: 'redirect' }];
    const { handlers, api } = setup({ routes: { ...current(REDIRECT), ...put(REDIRECT) } });
    const res = parse(await handlers.putPhase(replace(REDIRECT, { rules: stamped }), {}));
    expect(res.status).toBe(200);
    expect(api.calls[2].body).toEqual({ rules: [{ id: 'x1', ref: 'r1', expression: 'true', action: 'redirect' }] });
  });

  it.each(EDITABLE_PHASES.map((entry) => entry.phase))('lets the editable phase %s be replaced', async (phase) => {
    const { handlers } = setup({ routes: { ...current(phase), ...put(phase) } });
    expect(parse(await handlers.putPhase(replace(phase, { rules: [{ expression: 'true', action: 'block' }] }), {})).status).toBe(200);
  });

  describe('the API rate limit rule (http_ratelimit), the Cloudflare page’s since #1903', () => {
    const RATE = 'http_ratelimit';
    // The rule #1904 chose: 200 requests in 10 seconds from one address to /api/, blocked for 10 seconds.
    const LIMIT = {
      description: 'Block an address sending more than 200 requests in 10 seconds to the API (counted per Cloudflare data centre)',
      expression: '(lower(http.request.uri.path) contains "/api/")',
      action: 'block',
      enabled: true,
      ratelimit: { characteristics: ['cf.colo.id', 'ip.src'], period: 10, requests_per_period: 200, mitigation_timeout: 10 },
    };
    const SAVED = { id: 'limit-1', ...LIMIT };
    const withLimit = entrypoint(RATE, { id: 'r5', phase: RATE, kind: 'zone', version: '2', rules: [SAVED] });

    it('lets Claude Network Guy make the rule in an empty phase, recorded and sent to the phone', async () => {
      const { handlers, api, store, notifier } = setup({ user: NETWORK_GUY, routes: put(RATE) });
      const res = parse(await handlers.putPhase(replace(RATE, { rules: [LIMIT], expectedVersion: null }), {}));
      expect(res.status).toBe(200);
      expect(methods(api)).toEqual(['GET ', `GET /rulesets/phases/${RATE}/entrypoint`, `PUT /rulesets/phases/${RATE}/entrypoint`]);
      expect(api.calls[2].body).toEqual({ rules: [LIMIT] });
      expect(store.upsertDoc.mock.calls[0][1]).toMatchObject({ agent: 'claude-network', details: { family: 'rules', phase: RATE, count: 1 } });
      expect(notifier.notifyTelegram).toHaveBeenCalledTimes(1);
      expect(notifier.notifyTelegram.mock.calls[0][0]).toMatchObject({
        source: 'cloudflare-change:claude-network:audit-1',
        message: `Claude Network Guy replaced the Cloudflare rules in the ${RATE} phase (1 rule(s)). Zone: ${ZONE_APEX}.`,
      });
    });

    it('reads the phase in full, limits included, as editable', async () => {
      const { handlers } = setup({ routes: withLimit });
      const res = parse(await handlers.getPhase(request({ params: { phase: RATE } }), {}));
      expect(res.body).toMatchObject({ editable: true, locked: false, lockedReason: null, version: '2' });
      expect(res.body.ruleset.rules).toEqual([SAVED]);
    });

    it('lets an agent key change the limit but not remove the rule', async () => {
      const changed = setup({ user: NETWORK_GUY, routes: { ...withLimit, ...put(RATE) } });
      const raised = { ...SAVED, ratelimit: { ...SAVED.ratelimit, requests_per_period: 300 } };
      expect(parse(await changed.handlers.putPhase(replace(RATE, { rules: [raised], expectedVersion: '2' }), {})).status).toBe(200);

      const removed = setup({ user: NETWORK_GUY, routes: { ...withLimit, ...put(RATE) } });
      const res = parse(await removed.handlers.putPhase(replace(RATE, { rules: [{ ...LIMIT, description: 'a new one' }], expectedVersion: '2' }), {}));
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'CLOUDFLARE_OWNER_ONLY', error: AGENT_REMOVAL_MESSAGE });
      expect(WRITES(removed.api)).toEqual([]);
      expect(removed.store.upsertDoc).not.toHaveBeenCalled();
      expect(removed.notifier.notifyTelegram).not.toHaveBeenCalled();
    });

    it('refuses an empty list and a stale version for everyone, writing nothing', async () => {
      for (const user of [PERSON, NETWORK_GUY]) {
        const empty = setup({ user, routes: { ...withLimit, ...put(RATE) } });
        const none = parse(await empty.handlers.putPhase(replace(RATE, { rules: [], expectedVersion: '2' }), {}));
        expect(none.status).toBe(400);
        expect(none.body.error).toMatch(/deletes every rule in the phase/);
        expect(empty.api.fetch).not.toHaveBeenCalled();

        const stale = setup({ user, routes: { ...withLimit, ...put(RATE) } });
        const old = parse(await stale.handlers.putPhase(replace(RATE, { rules: [SAVED], expectedVersion: '1' }), {}));
        expect(old.status).toBe(409);
        expect(old.body).toMatchObject({ code: 'CLOUDFLARE_STALE', error: STALE_MESSAGE });
        expect(WRITES(stale.api)).toEqual([]);
        expect(stale.store.upsertDoc).not.toHaveBeenCalled();
      }
    });

    it('refuses to change the rule when the zone is not this site’s', async () => {
      const { handlers, api, store } = setup({ user: NETWORK_GUY, routes: { [`GET ${ZONE_PATH}`]: zoneReply('other.example'), ...put(RATE) } });
      const res = parse(await handlers.putPhase(replace(RATE, { rules: [LIMIT], expectedVersion: null }), {}));
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'CLOUDFLARE_WRONG_ZONE', error: WRONG_ZONE_MESSAGE });
      expect(WRITES(api)).toEqual([]);
      expect(store.upsertDoc).not.toHaveBeenCalled();
    });
  });

  describe('in a guarded phase an agent key may not switch a rule off or set a custom response', () => {
    const ON = { id: 'rule-on', expression: 'true', action: 'block', enabled: true };
    const OFF = { id: 'rule-off', expression: 'false', action: 'block', enabled: false };
    const withRules = (phase, rules) => entrypoint(phase, { id: 'r6', phase, version: '3', rules });
    const RESPONSE = { response: { status_code: 429, content: 'Slow down', content_type: 'text/plain' } };

    it('guards the custom security rules and the rate limiting rules', () => {
      expect(GUARDED_PHASES).toEqual(['http_request_firewall_custom', 'http_ratelimit']);
    });

    it.each(GUARDED_PHASES.flatMap((phase) => [
      [phase, 'switches a rule that is on to enabled: false', [{ ...ON, enabled: false }, OFF]],
      [phase, 'switches a rule that is on to a value that is not true', [{ ...ON, enabled: 'false' }, OFF]],
      [phase, 'adds a new rule that starts switched off', [ON, OFF, { expression: 'true', action: 'block', enabled: false }]],
      [phase, 'adds a rule under an id the phase does not hold, switched off', [ON, OFF, { id: 'rule-new', expression: 'true', action: 'block', enabled: false }]],
    ]))('refuses in %s an agent key’s list that %s, with 403 and nothing written', async (phase, label, rules) => {
      const { handlers, api, store, notifier } = setup({ user: NETWORK_GUY, routes: { ...withRules(phase, [ON, OFF]), ...put(phase) } });
      const res = parse(await handlers.putPhase(replace(phase, { rules }), {}));
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'CLOUDFLARE_OWNER_ONLY', error: AGENT_DISABLE_MESSAGE });
      expect(WRITES(api)).toEqual([]);
      expect(store.upsertDoc).not.toHaveBeenCalled();
      expect(notifier.notifyTelegram).not.toHaveBeenCalled();
    });

    it.each(GUARDED_PHASES)('lets an agent key keep a rule that is already off as it is, and add rules that are on, in %s', async (phase) => {
      const { handlers, api } = setup({ user: NETWORK_GUY, routes: { ...withRules(phase, [ON, OFF]), ...put(phase) } });
      const rules = [ON, OFF, { expression: 'true', action: 'block' }, { expression: 'true', action: 'block', enabled: true }];
      expect(parse(await handlers.putPhase(replace(phase, { rules }), {})).status).toBe(200);
      expect(WRITES(api)).toHaveLength(1);
    });

    it.each(GUARDED_PHASES)('refuses an agent key’s custom response in %s before calling Cloudflare', async (phase) => {
      const { handlers, api, store } = setup({ user: NETWORK_GUY, routes: { ...withRules(phase, [ON]), ...put(phase) } });
      const rules = [{ ...ON, action_parameters: RESPONSE }];
      const res = parse(await handlers.putPhase(replace(phase, { rules }), {}));
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'CLOUDFLARE_OWNER_ONLY', error: AGENT_RESPONSE_MESSAGE });
      expect(api.fetch).not.toHaveBeenCalled();
      expect(store.upsertDoc).not.toHaveBeenCalled();
    });

    it.each(GUARDED_PHASES)('lets a super_admin person switch a rule off and set a custom response in %s', async (phase) => {
      const { handlers, api } = setup({ routes: { ...withRules(phase, [ON]), ...put(phase) } });
      const rules = [{ ...ON, enabled: false, action_parameters: RESPONSE }];
      expect(parse(await handlers.putPhase(replace(phase, { rules }), {})).status).toBe(200);
      expect(api.calls[2].body).toEqual({ rules });
    });

    it('leaves the other editable phases as they were: an agent key may switch a redirect off', async () => {
      const redirect = { id: 'rule-on', expression: 'true', action: 'redirect', enabled: true };
      const { handlers } = setup({ user: NETWORK_GUY, routes: { ...withRules(REDIRECT, [redirect]), ...put(REDIRECT) } });
      expect(parse(await handlers.putPhase(replace(REDIRECT, { rules: [{ ...redirect, enabled: false }] }), {})).status).toBe(200);
    });
  });

  describe('an agent key may add or change rules, never remove one', () => {
    const KEPT = { id: 'rule-a', expression: 'true', action: 'block' };
    const OTHER = { id: 'rule-b', expression: 'false', action: 'block' };
    const withRules = (rules) => entrypoint(REDIRECT, { id: 'r2', phase: REDIRECT, version: '3', rules });

    it.each([
      ['leaves one out', [KEPT]],
      ['leaves every one out for new ones', [{ expression: 'true', action: 'redirect' }]],
      ['keeps the rule but drops its id', [KEPT, { ...OTHER, id: undefined }]],
    ])('refuses an agent key’s list that %s with 403, writing nothing', async (label, rules) => {
      const { handlers, api, store, notifier } = setup({ user: NETWORK_GUY, routes: { ...withRules([KEPT, OTHER]), ...put(REDIRECT) } });
      const res = parse(await handlers.putPhase(replace(REDIRECT, { rules }), {}));
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'CLOUDFLARE_OWNER_ONLY', error: AGENT_REMOVAL_MESSAGE });
      expect(res.body.error).toBe('An agent key may add or change rules but not remove one. Removing a rule is done by the owner on the Cloudflare page.');
      expect(WRITES(api)).toEqual([]);
      expect(store.upsertDoc).not.toHaveBeenCalled();
      expect(notifier.notifyTelegram).not.toHaveBeenCalled();
    });

    it.each([
      ['adds a rule and keeps every current one', [KEPT, OTHER, { expression: 'true', action: 'redirect' }]],
      ['changes a current rule and keeps the rest', [{ ...KEPT, expression: 'http.host eq "blog.example"' }, OTHER]],
      ['puts the current rules in another order', [OTHER, KEPT]],
    ])('lets an agent key replace a phase when its list %s', async (label, rules) => {
      const { handlers, api } = setup({ user: NETWORK_GUY, routes: { ...withRules([KEPT, OTHER]), ...put(REDIRECT) } });
      const res = parse(await handlers.putPhase(replace(REDIRECT, { rules }), {}));
      expect(res.status).toBe(200);
      expect(WRITES(api)).toHaveLength(1);
    });

    it('lets an agent key add the first rules to a phase with none', async () => {
      const { handlers } = setup({ user: NETWORK_GUY, routes: put(REDIRECT) });
      expect(parse(await handlers.putPhase(replace(REDIRECT, { rules: [RULE], expectedVersion: null }), {})).status).toBe(200);
    });

    it('lets a super_admin person remove a rule', async () => {
      const { handlers, api, store } = setup({ routes: { ...withRules([KEPT, OTHER]), ...put(REDIRECT) } });
      const res = parse(await handlers.putPhase(replace(REDIRECT, { rules: [KEPT] }), {}));
      expect(res.status).toBe(200);
      expect(api.calls[2].body).toEqual({ rules: [KEPT] });
      expect(store.upsertDoc.mock.calls[0][1].details).toEqual({ zone: ZONE_APEX, family: 'rules', phase: REDIRECT, count: 1 });
    });
  });
});

describe('an accepted change whose audit row failed is never silent', () => {
  const brotli = {
    [`GET ${ZONE_PATH}/settings/brotli`]: ok({ id: 'brotli', value: 'off' }),
    [`PATCH ${ZONE_PATH}/settings/brotli`]: ok({ id: 'brotli', value: 'on' }),
  };
  const STORE_WORDS = 'store said: container admin_audit_logs row audit-1 for owner@example.com';
  const failingStore = (store) => store.upsertDoc.mockRejectedValue(Object.assign(new Error(STORE_WORDS), { code: 'StoreDown' }));
  const change = (handlers, context) => handlers.patchSetting(request({ params: { settingId: 'brotli' }, body: { value: 'on' } }), context);

  it('answers audited: true when the row was written', async () => {
    const { handlers } = setup({ routes: brotli });
    expect(parse(await change(handlers, {})).body.audited).toBe(true);
  });

  it.each([
    ['a person', PERSON, 'Someone signed in to the admin portal'],
    ['an agent key', NETWORK_GUY, 'Claude Network Guy'],
  ])('tells the owner’s phone, for %s, and answers audited: false', async (label, user, actor) => {
    const { handlers, store, notifier, context } = setup({ user, routes: brotli });
    failingStore(store);
    const res = parse(await change(handlers, context));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, audited: false });
    expect(notifier.notifyTelegram).toHaveBeenCalledTimes(1);
    const sent = notifier.notifyTelegram.mock.calls[0][0];
    expect(sent).toMatchObject({ severity: 'warning', source: 'cloudflare-check:audit-1', title: `Check this Cloudflare change in ${ZONE_APEX}` });
    expect(sent.message).toBe(`${actor} changed the Cloudflare zone setting brotli. Zone: ${ZONE_APEX}. ${UNAUDITED_NOTE}`);
    expect(sent.message).toMatch(/made in Cloudflare, but its audit row could not be written/);
    expect(logs(context)).not.toContain(STORE_WORDS);
    expect(logs(context)).not.toContain('owner@example.com');
    expect(formatTelegramText(sent)).toContain('Reported by the Cloudflare page.');
  });

  it('gives every such change its own source, so no cooldown swallows one', async () => {
    const { handlers, store, notifier } = setup({ routes: brotli });
    failingStore(store);
    for (let i = 0; i < 2; i += 1) await change(handlers, {});
    expect(notifier.notifyTelegram.mock.calls.map(([sent]) => sent.source)).toEqual(['cloudflare-check:audit-1', 'cloudflare-check:audit-2']);
  });

  it.each([
    ['purge', () => request({ body: { everything: true } }), { [`POST ${ZONE_PATH}/purge_cache`]: ok({ id: ZONE }) }],
    [
      'createDns',
      () => request({ body: { type: 'A', name: 'blog', content: '192.0.2.1' } }),
      { [`POST ${ZONE_PATH}/dns_records`]: ok({ id: RECORD_ID, type: 'A', name: `blog.${ZONE_APEX}` }) },
    ],
    [
      'putPhase',
      () => request({ params: { phase: REDIRECT }, body: { rules: [RULE], expectedVersion: null } }),
      { [`PUT ${PHASES}/${REDIRECT}/entrypoint`]: ok({ id: 'r2', phase: REDIRECT, version: '1', rules: [RULE] }) },
    ],
  ])('answers audited on %s too, false when the row failed', async (name, req, routes) => {
    const good = setup({ routes });
    expect(parse(await good.handlers[name](req(), {})).body.audited, name).toBe(true);
    const failed = setup({ routes });
    failingStore(failed.store);
    expect(parse(await failed.handlers[name](req(), {})).body.audited, name).toBe(false);
    expect(failed.notifier.notifyTelegram, name).toHaveBeenCalledTimes(1);
  });

  it('sends no warning for a refused change', async () => {
    const { handlers, store, notifier } = setup({ user: NETWORK_GUY });
    failingStore(store);
    const res = parse(await handlers.patchSetting(request({ params: { settingId: 'ssl' }, body: { value: 'off' } }), {}));
    expect(res.status).toBe(403);
    expect(notifier.notifyTelegram).not.toHaveBeenCalled();
  });
});

describe('a refusal from Cloudflare', () => {
  it.each([
    [400, 400, /not valid/],
    [401, 502, /refused the token/],
    [403, 502, /refused the token/],
    [404, 404, /no such item/],
    [409, 409, /conflicts/],
    [429, 429, /limiting requests/],
    [500, 502, /HTTP 500/],
  ])('answers Cloudflare’s %i as %i with a sentence of its own, no audit row and no phone message', async (upstream, answer, sentence) => {
    const { handlers, store, notifier, context } = setup({
      user: NETWORK_GUY,
      routes: {
        [`GET ${ZONE_PATH}/settings/brotli`]: ok({ id: 'brotli', value: 'off' }),
        [`PATCH ${ZONE_PATH}/settings/brotli`]: reply(upstream, { success: false, errors: [{ code: 1007, message: `far-end words ${TOKEN}` }] }),
      },
    });
    const res = await handlers.patchSetting(request({ params: { settingId: 'brotli' }, body: { value: 'on' } }), context);
    const body = JSON.parse(res.body);
    expect(res.status).toBe(answer);
    expect(body.error).toMatch(sentence);
    expect(res.body).not.toMatch(/far-end words/);
    expect(res.body).not.toContain(TOKEN);
    expect(logs(context)).not.toContain(TOKEN);
    expect(logs(context)).not.toMatch(/far-end words|brotli/);
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(notifier.notifyTelegram).not.toHaveBeenCalled();
  });

  it('answers 502 when a 2xx answer says it failed', async () => {
    const { handlers } = setup({ routes: { [`GET ${ZONE_PATH}/settings`]: reply(200, { success: false, errors: [] }) } });
    const res = await handlers.getSettings(request(), { warn: vi.fn() });
    expect(res.status).toBe(502);
  });

  it('answers 502 when Cloudflare cannot be reached, without the transport’s words', async () => {
    const { handlers, api, context } = setup();
    api.fetch.mockImplementation(async () => {
      throw new Error(`socket hang up for Bearer ${TOKEN}`);
    });
    const res = await handlers.getSettings(request(), context);
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body).code).toBe('CLOUDFLARE_UNREACHABLE');
    expect(res.body).not.toContain(TOKEN);
    expect(logs(context)).not.toContain(TOKEN);
  });
});

describe('the token', () => {
  it('goes in the Authorization header of an https call to Cloudflare, and nowhere else', async () => {
    const { handlers, api, store, context } = setup({
      user: NETWORK_GUY,
      routes: { [`GET ${ZONE_PATH}/settings/brotli`]: ok({ id: 'brotli', value: 'off' }), [`PATCH ${ZONE_PATH}/settings/brotli`]: ok({ id: 'brotli', value: 'on' }) },
    });
    const res = await handlers.patchSetting(request({ params: { settingId: 'brotli' }, body: { value: 'on' } }), context);
    for (const call of api.calls) {
      expect(call.url.startsWith(`${CLOUDFLARE_API_BASE}/zones/${ZONE}`)).toBe(true);
      expect(call.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(call.url).not.toContain(TOKEN);
    }
    expect(res.body).not.toContain(TOKEN);
    expect(JSON.stringify(store.upsertDoc.mock.calls)).not.toContain(TOKEN);
    expect(logs(context)).not.toContain(TOKEN);
  });
});

describe('no delete', () => {
  it('registers no DELETE route and makes no DELETE call', () => {
    const files = ['client.js', 'handlers.js', 'input.js', 'record.js', 'zone-routes.js', 'dns-routes.js', 'rules-routes.js', '../../functions/cloudflare-http.js'];
    for (const file of files) {
      const source = readFileSync(join(HERE, file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(source, file).not.toMatch(/DELETE/);
    }
  });
});

describe('the lab zone (#1911)', () => {
  const LAB_ID = '00000000000000000000000000000003';
  const LAB_PATH = `/client/v4/zones/${LAB_ID}`;
  const LAB = `zone=${LAB_ZONE}`;
  const lookup = (zones = [{ id: LAB_ID, name: LAB_ZONE, status: 'active' }]) => ({ 'GET /client/v4/zones': ok(zones) });
  const labZone = (name = LAB_ZONE) => ({ [`GET ${LAB_PATH}`]: ok({ id: LAB_ID, name, status: 'active', plan: { name: 'Free Website' } }) });
  const labRoutes = (extra = {}) => ({ ...lookup(), ...labZone(), ...extra });
  const paths = (api) => api.calls.map((call) => `${call.method} ${call.path.replace(LAB_PATH, '<lab>')}`);
  const created = { [`POST ${LAB_PATH}/dns_records`]: (url, init) => ok({ id: RECORD_ID, ...JSON.parse(init.body), proxied: false, ttl: 1 }) };

  beforeEach(() => forgetZoneIds());

  describe('the zone parameter', () => {
    const UNKNOWN = ['zone=example.com', 'zone=', `zone=${LAB_ZONE}&zone=${ZONE_APEX}`, `zone=${LAB_ZONE}.`, 'zone=hybridcloudworks.com.evil.example'];

    it.each(ROUTES)('%s refuses an unknown, empty or repeated zone with 400, calling nothing', async (name, role, req) => {
      for (const query of UNKNOWN) {
        const { handlers, api, store } = setup({ routes: labRoutes() });
        const res = parse(await handlers[name]({ ...req, query: new URLSearchParams(query) }, {}));
        expect(res.status, `${name} ${query}`).toBe(400);
        expect(res.body.code).toBe('CLOUDFLARE_UNMANAGED_ZONE');
        expect(res.body.error).toBe(`zone must be ${ZONE_APEX} or ${LAB_ZONE}: the site acts on no other zone.`);
        expect(api.fetch).not.toHaveBeenCalled();
        expect(store.upsertDoc).not.toHaveBeenCalled();
      }
    });

    it('acts on the site’s zone, by its configured id, when the request names none', async () => {
      const { handlers, api } = setup();
      const res = parse(await handlers.getStatus(request(), {}));
      expect(res.body.managed).toEqual({ name: ZONE_APEX, role: expect.stringMatching(/site's own zone/) });
      expect(res.body.managedZones.map((zone) => zone.name)).toEqual([ZONE_APEX, LAB_ZONE]);
      expect(api.calls.every((call) => call.path.startsWith(ZONE_PATH))).toBe(true);
    });

    it('reads the zone name in any letter case', async () => {
      const { handlers } = setup({ routes: labRoutes() });
      const res = parse(await handlers.getStatus(request({ query: 'zone=HybridCloudInsights.COM' }), {}));
      expect(res.body.managed.name).toBe(LAB_ZONE);
      expect(res.body.zone).toMatchObject({ id: LAB_ID, name: LAB_ZONE });
    });

    it('needs no CF_ZONE_ID for the lab zone, and still needs the token', async () => {
      const withoutId = setup({ env: { CLOUDFLARE_ADMIN_TOKEN: TOKEN }, routes: labRoutes({ [`GET ${LAB_PATH}/settings`]: ok([]) }) });
      expect(parse(await withoutId.handlers.getSettings(request({ query: LAB }), {})).status).toBe(200);
      const withoutToken = setup({ env: { CF_ZONE_ID: ZONE }, routes: labRoutes() });
      const res = parse(await withoutToken.handlers.getSettings(request({ query: LAB }), {}));
      expect(res.status).toBe(503);
      expect(res.body.missing).toEqual(['token']);
    });
  });

  describe('the zone id is looked up by name', () => {
    it('looks the id up once with the token, then reuses it for the instance’s life', async () => {
      const first = setup({ routes: labRoutes({ [`GET ${LAB_PATH}/settings`]: ok([]) }) });
      await first.handlers.getSettings(request({ query: LAB }), {});
      expect(paths(first.api)).toEqual(['GET /client/v4/zones', 'GET <lab>/settings']);
      expect(first.api.calls[0].query.get('name')).toBe(LAB_ZONE);
      expect(first.api.calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
      const second = setup({ routes: labRoutes({ [`GET ${LAB_PATH}/settings`]: ok([]) }) });
      await second.handlers.getSettings(request({ query: LAB }), {});
      expect(paths(second.api)).toEqual(['GET <lab>/settings']);
    });

    it.each([
      ['no zone', []],
      ['only a zone whose name merely contains it', [{ id: LAB_ID, name: `evil-${LAB_ZONE}` }]],
      ['a zone of that name without a proper id', [{ id: '../zones', name: LAB_ZONE, status: 'active' }]],
      ['a zone of that name that is not active', [{ id: LAB_ID, name: LAB_ZONE, status: 'pending' }]],
      ['two active zones of that name', [{ id: LAB_ID, name: LAB_ZONE, status: 'active' }, { id: ZONE, name: LAB_ZONE.toUpperCase(), status: 'active' }]],
    ])('refuses when the token finds %s, says to add it to the token, and keeps nothing', async (label, zones) => {
      const { handlers, api } = setup({ routes: { ...lookup(zones), ...labZone() } });
      const res = parse(await handlers.getSettings(request({ query: LAB }), { warn: vi.fn() }));
      expect(res.status).toBe(502);
      expect(res.body).toMatchObject({ code: 'CLOUDFLARE_ZONE_UNREACHABLE', error: zoneUnreachableMessage(LAB_ZONE) });
      expect(res.body.error).toMatch(/Zone Resources/);
      expect(paths(api)).toEqual(['GET /client/v4/zones']);
      const again = setup({ routes: { ...lookup(zones), ...labZone() } });
      await again.handlers.getSettings(request({ query: LAB }), { warn: vi.fn() });
      expect(paths(again.api)).toEqual(['GET /client/v4/zones']);
    });

    const gone = (code) => reply(code, { success: false, errors: [{ code: 7003, message: 'gone' }] });
    const settingsAgain = async () => {
      const again = setup({ routes: labRoutes({ [`GET ${LAB_PATH}/settings`]: ok([]) }) });
      await again.handlers.getSettings(request({ query: LAB }), {});
      return paths(again.api);
    };

    it.each([403, 404])('forgets a looked-up id when Cloudflare answers %i for the zone itself, and looks it up again next time (F5, R2)', async (code) => {
      const first = setup({ routes: { ...lookup(), [`GET ${LAB_PATH}`]: gone(code) } });
      const res = parse(await first.handlers.purge(request({ query: LAB, body: { everything: true } }), { warn: vi.fn() }));
      expect(res.status).not.toBe(200);
      expect(WRITES(first.api)).toEqual([]);
      expect(await settingsAgain()).toEqual(['GET /client/v4/zones', 'GET <lab>/settings']);
    });

    it.each([
      ['a 404 for a record', 'patchDns', request({ query: LAB, params: { recordId: RECORD_ID }, body: { proxied: true } }), { [`GET ${LAB_PATH}/dns_records/${RECORD_ID}`]: gone(404) }],
      ['a 403 for a setting', 'getSettings', request({ query: LAB }), { [`GET ${LAB_PATH}/settings`]: gone(403) }],
      ['a 403 for a status probe', 'getStatus', request({ query: LAB }), { [`GET ${LAB_PATH}/dns_records`]: gone(403) }],
      ['a 404 for a rule phase’s rule set list', 'listRulesets', request({ query: LAB }), { [`GET ${LAB_PATH}/rulesets`]: gone(404) }],
      ['a 500 for anything', 'getSettings', request({ query: LAB }), { [`GET ${LAB_PATH}/settings`]: reply(500, {}) }],
    ])('keeps a looked-up id through %s inside the zone (R2)', async (label, route, req, routes) => {
      const first = setup({ routes: labRoutes(routes) });
      await first.handlers[route](req, { warn: vi.fn() });
      expect(paths(first.api)[0]).toBe('GET /client/v4/zones');
      expect(await settingsAgain()).toEqual(['GET <lab>/settings']);
    });

    it('answers the status with the sentence when the lookup fails, looking up once', async () => {
      const { handlers, api } = setup({ routes: lookup([]) });
      const res = parse(await handlers.getStatus(request({ query: LAB }), { warn: vi.fn() }));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ configured: true, zone: null, zoneError: zoneUnreachableMessage(LAB_ZONE) });
      expect(res.body.families.map((family) => family.readable)).toEqual([null, null, null, null]);
      expect(paths(api)).toEqual(['GET /client/v4/zones']);
    });
  });

  describe('what is protected there', () => {
    it('lists the apex, the certificate subtree, Caddy’s checks and the wildcard rule, and no Terraform phase', async () => {
      const { handlers } = setup({ routes: labRoutes() });
      const res = parse(await handlers.getStatus(request({ query: LAB }), {}));
      expect(res.body.managed).toEqual({ name: LAB_ZONE, role: expect.stringMatching(/Caddy/) });
      expect(res.body.protected.dnsNames.map((item) => item.name)).toEqual([LAB_ZONE, `lab.${LAB_ZONE}`, `*.lab.${LAB_ZONE}`]);
      expect(res.body.protected.dnsPrefixes).toEqual([{ prefix: '_', reason: expect.stringMatching(/Caddy.*lab-host\/README\.md.*_dmarc/) }]);
      expect(res.body.protected.wildcardReason).toMatch(/wildcard in the lab zone could answer the lab's certificate check/);
      expect(res.body.protected.phases).toEqual([]);
      expect(res.body.protected.editablePhases.map((item) => item.phase)).toEqual(EDITABLE_PHASES.map((item) => item.phase));
    });

    it('lists no wildcard rule for the site’s zone', async () => {
      const { handlers } = setup();
      const res = parse(await handlers.getStatus(request(), {}));
      expect(res.body.protected.wildcardReason).toBeNull();
    });

    it.each([
      ['TXT', '*.lab'],
      ['CNAME', '*.lab'],
      ['TXT', '*'],
      ['CNAME', '*.foo'],
      ['TXT', '*.x.lab'],
      ['TXT', 'lab'],
      ['CNAME', 'x.lab'],
      ['TXT', '_acme-challenge.lab'],
      ['TXT', `_acme-challenge.lab.${LAB_ZONE}`],
      ['TXT', '_acme-challenge'],
      ['MX', '@'],
      ['TXT', LAB_ZONE],
      ['TXT', '_atproto'],
      ['TXT', '_dmarc'],
      ['TXT', '_domainkey'],
      ['CNAME', '_gh-example-o'],
    ])('refuses to add a %s record at %s, before any call', async (type, name) => {
      const { handlers, api } = setup({ routes: labRoutes(created) });
      const res = parse(await handlers.createDns(request({ query: LAB, body: { type, name, content: 'x.example.net', priority: 10 } }), {}));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CLOUDFLARE_PROTECTED');
      expect(api.fetch).not.toHaveBeenCalled();
    });

    it('adds a record at www, which nothing there uses, named in full in that zone', async () => {
      const { handlers, api } = setup({ routes: labRoutes(created) });
      const res = parse(await handlers.createDns(request({ query: LAB, body: { type: 'A', name: 'www', content: '192.0.2.1' } }), {}));
      expect(res.status).toBe(201);
      expect(api.calls.at(-1).body.name).toBe(`www.${LAB_ZONE}`);
      expect(res.body.record).toMatchObject({ name: `www.${LAB_ZONE}`, locked: false });
    });

    it('still lets the site zone take a _dmarc record: only the lab zone refuses every _ name (R1)', async () => {
      const made = { [`POST ${ZONE_PATH}/dns_records`]: (url, init) => ok({ id: RECORD_ID, ...JSON.parse(init.body) }) };
      const { handlers } = setup({ routes: made });
      const res = parse(await handlers.createDns(request({ body: { type: 'TXT', name: '_dmarc', content: 'v=DMARC1; p=reject' } }), {}));
      expect(res.status).toBe(201);
    });

    it('still refuses the site’s own address in the site’s zone when it is named', async () => {
      const { handlers, api } = setup();
      const res = parse(await handlers.createDns(request({ query: `zone=${ZONE_APEX}`, body: { type: 'A', name: '@', content: '192.0.2.1' } }), {}));
      expect(res.status).toBe(409);
      expect(res.body.reason).toMatch(/The site itself/);
      expect(api.fetch).not.toHaveBeenCalled();
    });

    const current = (name) => ok({ id: RECORD_ID, type: 'TXT', name, content: 'x', proxied: false, ttl: 1 });
    const patch = { [`PATCH ${LAB_PATH}/dns_records/${RECORD_ID}`]: ok({}) };

    it.each(['*.lab', 'x.lab', '_acme-challenge.lab', '*.foo', '@', '_foo', '_dmarc'])('refuses renaming an editable lab record to %s, before any call', async (name) => {
      const { handlers, api } = setup({ routes: labRoutes({ [`GET ${LAB_PATH}/dns_records/${RECORD_ID}`]: current(`note.${LAB_ZONE}`), ...patch }) });
      const res = parse(await handlers.patchDns(request({ query: LAB, params: { recordId: RECORD_ID }, body: { name } }), {}));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CLOUDFLARE_PROTECTED');
      expect(api.fetch).not.toHaveBeenCalled();
    });

    it('refuses an edit to a certificate check by its current name, after reading it', async () => {
      const { handlers, api } = setup({ routes: labRoutes({ [`GET ${LAB_PATH}/dns_records/${RECORD_ID}`]: current(`_acme-challenge.lab.${LAB_ZONE}`), ...patch }) });
      const res = parse(await handlers.patchDns(request({ query: LAB, params: { recordId: RECORD_ID }, body: { content: 'y' } }), {}));
      expect(res.status).toBe(409);
      expect(res.body.reason).toMatch(/certificate.*lab-host\/README\.md/);
      expect(WRITES(api)).toEqual([]);
    });

    it('locks the certificate checks and the apex in the list, and leaves www open', async () => {
      const records = [
        { id: 'a', type: 'TXT', name: `_acme-challenge.lab.${LAB_ZONE}`, content: 'x' },
        { id: 'b', type: 'MX', name: LAB_ZONE, content: 'mail.example.net' },
        { id: 'c', type: 'A', name: `www.${LAB_ZONE}`, content: '192.0.2.1' },
      ];
      const { handlers } = setup({ routes: labRoutes({ [`GET ${LAB_PATH}/dns_records`]: ok(records, { result_info: { total_pages: 1 } }) }) });
      const res = parse(await handlers.listDns(request({ query: LAB }), {}));
      expect(res.body.records.map((record) => [record.name, record.locked])).toEqual([
        [`_acme-challenge.lab.${LAB_ZONE}`, true],
        [LAB_ZONE, true],
        [`www.${LAB_ZONE}`, false],
      ]);
    });

    it.each([
      [LAB, `x.${ZONE_APEX}`, ZONE_APEX],
      [LAB, ZONE_APEX, ZONE_APEX],
      [`zone=${ZONE_APEX}`, `x.${LAB_ZONE}`, LAB_ZONE],
    ])('with %s, refuses (400) the name %s, which belongs to %s, before any call (F6)', async (query, name, other) => {
      const { handlers, api } = setup({ routes: labRoutes(created) });
      const res = parse(await handlers.createDns(request({ query, body: { type: 'A', name, content: '192.0.2.1' } }), {}));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(`name ends with ${other}, which is its own zone: send it with zone=${other} (or pick that zone on the page) to change it there.`);
      expect(api.fetch).not.toHaveBeenCalled();
      const renamed = parse(await handlers.patchDns(request({ query, params: { recordId: RECORD_ID }, body: { name } }), {}));
      expect(renamed.status).toBe(400);
    });

    it('reads the origin rule’s phase as read-only for the plain reason: Terraform writes no rule there', async () => {
      const { handlers } = setup({ routes: labRoutes({ [`GET ${LAB_PATH}/rulesets`]: ok([{ id: 'r', phase: 'http_request_late_transform', kind: 'zone' }]) }) });
      const res = parse(await handlers.listRulesets(request({ query: LAB }), {}));
      expect(res.body.rulesets[0]).toMatchObject({ locked: true, lockedReason: READ_ONLY_PHASE_REASON });
    });

    it('refuses a purge of an address on the site’s zone', async () => {
      const { handlers, api } = setup({ routes: labRoutes() });
      const res = parse(await handlers.purge(request({ query: LAB, body: { files: [`https://www.${ZONE_APEX}/`] } }), {}));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(`Address 1 must be an https address on ${LAB_ZONE} or one of its subdomains.`);
      expect(api.fetch).not.toHaveBeenCalled();
    });
  });

  describe('the zone check before a write', () => {
    it('refuses (409) when the looked-up id answers with another zone’s name, and looks it up again next time', async () => {
      const { handlers, api, store } = setup({ routes: { ...lookup(), ...labZone(ZONE_APEX), ...created } });
      const res = parse(await handlers.createDns(request({ query: LAB, body: { type: 'A', name: 'x', content: '192.0.2.1' } }), {}));
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'CLOUDFLARE_WRONG_ZONE', error: wrongZoneMessage(LAB_ZONE) });
      expect(WRITES(api)).toEqual([]);
      expect(store.upsertDoc).not.toHaveBeenCalled();
      const again = setup({ routes: labRoutes(created) });
      await again.handlers.createDns(request({ query: LAB, body: { type: 'A', name: 'x', content: '192.0.2.1' } }), {});
      expect(paths(again.api)).toEqual(['GET /client/v4/zones', 'GET <lab>', 'POST <lab>/dns_records']);
    });

    it('refuses (409) a write to the site’s zone when CF_ZONE_ID points at the lab zone', async () => {
      const { handlers, api } = setup({ routes: { [`GET ${ZONE_PATH}`]: zoneReply(LAB_ZONE) } });
      const res = parse(await handlers.purge(request({ body: { everything: true } }), {}));
      expect(res.status).toBe(409);
      expect(res.body.error).toBe(WRONG_ZONE_MESSAGE);
      expect(WRITES(api)).toEqual([]);
    });
  });

  describe('Claude Network Guy in the lab zone', () => {
    it('changes a record there under its switch, and the audit row and the phone name the zone', async () => {
      const { handlers, store, notifier } = setup({ user: NETWORK_GUY, routes: labRoutes(created) });
      const res = parse(await handlers.createDns(request({ query: LAB, body: { type: 'TXT', name: 'note', content: 'hello' } }), {}));
      expect(res.status).toBe(201);
      expect(store.upsertDoc.mock.calls[0][1]).toMatchObject({ agent: 'claude-network', details: { zone: LAB_ZONE, family: 'dns', name: `note.${LAB_ZONE}` } });
      expect(notifier.notifyTelegram.mock.calls[0][0]).toMatchObject({
        title: `Cloudflare changed by Claude Network Guy in ${LAB_ZONE}`,
        message: `Claude Network Guy added the TXT record note.${LAB_ZONE} in Cloudflare. Zone: ${LAB_ZONE}.`,
        source: 'cloudflare-change:claude-network:audit-1',
      });
      expect(JSON.stringify(store.upsertDoc.mock.calls)).not.toContain('hello');
    });

    it('is refused the owner-only settings there too, calling nothing', async () => {
      const { handlers, api } = setup({ user: NETWORK_GUY, routes: labRoutes() });
      const res = parse(await handlers.patchSetting(request({ query: LAB, params: { settingId: 'ssl' }, body: { value: 'off' } }), {}));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('CLOUDFLARE_OWNER_ONLY');
      expect(api.fetch).not.toHaveBeenCalled();
    });

    it('may not remove a rule or switch a rate limit off there', async () => {
      const PHASE = `${LAB_PATH}/rulesets/phases/http_ratelimit/entrypoint`;
      const kept = { id: 'limit-1', expression: 'true', action: 'block', enabled: true };
      const routes = labRoutes({ [`GET ${PHASE}`]: ok({ id: 'rs', version: '2', rules: [kept, { ...kept, id: 'limit-2' }] }), [`PUT ${PHASE}`]: ok({}) });
      const removal = setup({ user: NETWORK_GUY, routes });
      const removed = parse(await removal.handlers.putPhase(request({ query: LAB, params: { phase: 'http_ratelimit' }, body: { rules: [kept], expectedVersion: '2' } }), {}));
      expect(removed).toMatchObject({ status: 403, body: { error: AGENT_REMOVAL_MESSAGE } });
      const off = setup({ user: NETWORK_GUY, routes });
      const rules = [{ ...kept, enabled: false }, { ...kept, id: 'limit-2' }];
      const switched = parse(await off.handlers.putPhase(request({ query: LAB, params: { phase: 'http_ratelimit' }, body: { rules, expectedVersion: '2' } }), {}));
      expect(switched).toMatchObject({ status: 403, body: { error: AGENT_DISABLE_MESSAGE } });
      expect([...WRITES(removal.api), ...WRITES(off.api)]).toEqual([]);
    });
  });
});
