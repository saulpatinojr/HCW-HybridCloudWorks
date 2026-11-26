/**
 * The Cloudflare page's routes (#1905), against a fake Cloudflare API: no
 * network. Roles, "not set up", the protected names and phases, input
 * checks, the audit row and the phone message, and that the token never
 * leaves the Authorization header.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCloudflareHandlers, MAX_PURGE_FILES, READ_ROLE, WRITE_ROLE } from './handlers.js';
import { CLOUDFLARE_API_BASE } from './client.js';
import { agentUserOf } from '../agent-content/keys.js';
import { agentKeyById } from '../agent-content/agent-keys.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = 'not-a-real-cloudflare-token-EXAMPLE-0123456789';
const ZONE = '00000000000000000000000000000001';
const RECORD_ID = '00000000000000000000000000000002';
const ENV = { CLOUDFLARE_ADMIN_TOKEN: TOKEN, CF_ZONE_ID: ZONE };
const ZONE_PATH = `/client/v4/zones/${ZONE}`;
const PERSON = { oid: 'person-oid', email: 'owner@example.com' };
const NETWORK_GUY = agentUserOf(agentKeyById('claude-network'));

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

const ZONE_READS = {
  [`GET ${ZONE_PATH}`]: ok({ id: ZONE, name: 'example.com', status: 'active', plan: { name: 'Free Website' }, owner: { email: 'someone@example.com' } }),
};

function setup({ routes = {}, env = ENV, user = PERSON, refuse = null } = {}) {
  const api = cloudflare({ ...ZONE_READS, ...routes });
  const guard = { requireRole: vi.fn(async (request, role) => (refuse ? { error: refuse } : { user, role, error: null })) };
  const store = { upsertDoc: vi.fn(async () => ({})) };
  const notifier = { notifyTelegram: vi.fn(async () => ({ sent: true })) };
  const handlers = createCloudflareHandlers({
    guard,
    store,
    notifier,
    env,
    fetch: api.fetch,
    resolve: async () => ({ address: '93.184.216.34' }),
    dispatcherFor: () => ({ close: async () => {} }),
    now: () => new Date('2026-11-26T12:00:00.000Z'),
    uuid: () => 'audit-1',
  });
  const context = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { api, guard, store, notifier, handlers, context };
}

const request = ({ params = {}, body, text } = {}) => ({
  params,
  headers: { get: (name) => (name.toLowerCase() === 'user-agent' ? 'test-agent' : null) },
  text: async () => (text !== undefined ? text : body === undefined ? '' : JSON.stringify(body)),
});
const parse = (res) => ({ status: res.status, body: JSON.parse(res.body) });
const logs = (context) => JSON.stringify([context.log.mock.calls, context.warn.mock.calls, context.error.mock.calls]);

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
  ['getPhase', READ_ROLE, request({ params: { phase: 'http_request_dynamic_redirect' } })],
  ['putPhase', WRITE_ROLE, request({ params: { phase: 'http_request_dynamic_redirect' }, body: { rules: [] } })],
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
  const unset = [
    {},
    { CF_ZONE_ID: ZONE },
    { CLOUDFLARE_ADMIN_TOKEN: TOKEN },
    { CLOUDFLARE_ADMIN_TOKEN: '@Microsoft.KeyVault(SecretUri=https://kv.example/secrets/CLOUDFLARE-ADMIN-TOKEN)', CF_ZONE_ID: ZONE },
    { CLOUDFLARE_ADMIN_TOKEN: TOKEN, CF_ZONE_ID: 'not-a-zone-id' },
  ];

  it('says so on the status route with 200, and lists what is protected', async () => {
    for (const env of unset) {
      const { handlers, api } = setup({ env });
      const res = parse(await handlers.getStatus(request(), {}));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ configured: false, zone: null, families: [] });
      expect(res.body.message).toMatch(/Integrations → Keys/);
      expect(res.body.protected.phases.map((p) => p.phase)).toContain('http_request_late_transform');
      expect(api.fetch).not.toHaveBeenCalled();
    }
  });

  it('answers 503 CLOUDFLARE_NOT_CONFIGURED on every other route', async () => {
    for (const env of unset) {
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
    expect(res.body.zone).toEqual({ id: ZONE, name: 'example.com', status: 'active', plan: 'Free Website' });
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

describe('zone settings', () => {
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

  it('changes one setting, writes one audit row, and sends nothing to the phone for a person', async () => {
    const { handlers, api, store, notifier } = setup({
      routes: { [`PATCH ${ZONE_PATH}/settings/always_use_https`]: ok({ id: 'always_use_https', value: 'on', editable: true }) },
    });
    const res = parse(await handlers.patchSetting(request({ params: { settingId: 'always_use_https' }, body: { value: 'on' } }), {}));
    expect(res.status).toBe(200);
    expect(res.body.setting).toMatchObject({ id: 'always_use_https', value: 'on' });
    expect(api.calls[0]).toMatchObject({ method: 'PATCH', body: { value: 'on' } });
    expect(store.upsertDoc).toHaveBeenCalledTimes(1);
    const [container, row] = store.upsertDoc.mock.calls[0];
    expect(container).toBe('admin_audit_logs');
    expect(row).toMatchObject({
      id: 'audit-1',
      action: 'cloudflare_change',
      resourceType: 'cloudflare',
      userId: 'person-oid',
      userEmail: 'owner@example.com',
      details: { family: 'settings', settingId: 'always_use_https' },
    });
    expect(row.agent).toBeUndefined();
    expect(notifier.notifyTelegram).not.toHaveBeenCalled();
  });

  it('names the agent key in the audit row and tells the owner’s phone when the caller is one', async () => {
    const { handlers, store, notifier } = setup({
      user: NETWORK_GUY,
      routes: { [`PATCH ${ZONE_PATH}/settings/always_use_https`]: ok({ id: 'always_use_https', value: 'on' }) },
    });
    await handlers.patchSetting(request({ params: { settingId: 'always_use_https' }, body: { value: 'on' } }), {});
    expect(store.upsertDoc.mock.calls[0][1]).toMatchObject({ agent: 'claude-network', userId: 'agent:claude-network' });
    expect(notifier.notifyTelegram).toHaveBeenCalledTimes(1);
    expect(notifier.notifyTelegram.mock.calls[0][0]).toMatchObject({
      source: 'cloudflare-change:claude-network',
      message: 'Claude Network Guy changed the Cloudflare zone setting always_use_https.',
    });
  });
});

describe('cache purge', () => {
  const purgeRoute = (calls) => ({ [`POST ${ZONE_PATH}/purge_cache`]: (url, init) => (calls.push(JSON.parse(init.body)), ok({ id: ZONE })) });

  it('purges everything', async () => {
    const sent = [];
    const { handlers, store } = setup({ routes: purgeRoute(sent) });
    const res = parse(await handlers.purge(request({ body: { everything: true } }), {}));
    expect(res.body.purged).toBe('everything');
    expect(sent).toEqual([{ purge_everything: true }]);
    expect(store.upsertDoc.mock.calls[0][1].details).toEqual({ family: 'cache', purge: 'everything' });
  });

  it('purges up to thirty https addresses on the zone’s own names', async () => {
    const sent = [];
    const { handlers, store } = setup({ routes: purgeRoute(sent) });
    const files = ['https://example.com/a.css', 'https://www.example.com/b.js?v=1'];
    const res = parse(await handlers.purge(request({ body: { files } }), {}));
    expect(res.body.purged).toBe(2);
    expect(sent).toEqual([{ files }]);
    expect(store.upsertDoc.mock.calls[0][1].details).toEqual({ family: 'cache', purge: 'files', count: 2 });
  });

  it.each([
    [{ files: [] }],
    [{ files: Array.from({ length: MAX_PURGE_FILES + 1 }, (_, i) => `https://example.com/${i}`) }],
    [{ files: ['http://example.com/a'] }],
    [{ files: ['https://example.org/a'] }],
    [{ files: ['https://notexample.com/a'] }],
    [{ files: ['https://user:pass@example.com/a'] }],
    [{ files: ['not a url'] }],
    [{ files: [42] }],
    [{ everything: false }],
    [{ everything: true, files: ['https://example.com/a'] }],
    [{ everything: 'yes' }],
    [{ purge_everything: true }],
  ])('refuses %j and purges nothing', async (body) => {
    const sent = [];
    const { handlers, store } = setup({ routes: purgeRoute(sent) });
    expect(parse(await handlers.purge(request({ body }), {})).status).toBe(400);
    expect(sent).toEqual([]);
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });
});

describe('DNS records', () => {
  const record = (over = {}) => ({ id: RECORD_ID, type: 'A', name: 'blog.example.com', content: '192.0.2.1', proxied: true, ttl: 1, comment: null, ...over });

  it('lists every page, and marks the protected ones with their reason', async () => {
    const { handlers, api } = setup({
      routes: {
        [`GET ${ZONE_PATH}/dns_records`]: (url) =>
          url.searchParams.get('page') === '1'
            ? ok([record(), record({ id: 'b', name: 'www.hybridcloudworks.com' })], { result_info: { page: 1, total_pages: 2 } })
            : ok([record({ id: 'c', name: '_acme-challenge.hybridcloudworks.com', type: 'TXT' })], { result_info: { page: 2, total_pages: 2 } }),
      },
    });
    const res = parse(await handlers.listDns(request(), {}));
    expect(api.calls.map((call) => call.query.get('page'))).toEqual(['1', '2']);
    expect(res.body.records.map((r) => [r.id, r.locked])).toEqual([[RECORD_ID, false], ['b', true], ['c', true]]);
    expect(res.body.records[1].lockedReason).toMatch(/Static Web App/);
  });

  it.each(['@', 'hybridcloudworks.com', 'www', 'www.hybridcloudworks.com', 'api-azure', 'docs.hybridcloudworks.com', '_acme-challenge.blog', 'x.lab.hybridcloudworks.com', 'lab'])(
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

  it.each([
    [{ type: 'NS', name: 'blog', content: 'ns.example.net' }],
    [{ type: 'A', name: 'blog' }],
    [{ type: 'A', name: '', content: '192.0.2.1' }],
    [{ type: 'A', name: 'bad name', content: '192.0.2.1' }],
    [{ type: 'A', name: 'blog', content: '192.0.2.1', ttl: 30 }],
    [{ type: 'A', name: 'blog', content: '192.0.2.1', proxied: 'yes' }],
    [{ type: 'A', name: 'blog', content: '192.0.2.1', comment: 'x'.repeat(101) }],
    [{ type: 'A', name: 'blog', content: '192.0.2.1', id: 'x' }],
  ])('refuses the record %j', async (body) => {
    const { handlers, api } = setup();
    expect(parse(await handlers.createDns(request({ body }), {})).status).toBe(400);
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it('adds a record that is not protected, and records it', async () => {
    const { handlers, api, store, notifier } = setup({
      user: NETWORK_GUY,
      routes: { [`POST ${ZONE_PATH}/dns_records`]: (url, init) => ok(record({ ...JSON.parse(init.body), name: 'blog.example.com' })) },
    });
    const res = parse(await handlers.createDns(request({ body: { type: 'a', name: 'blog', content: '192.0.2.1', ttl: 300, proxied: false } }), {}));
    expect(res.status).toBe(201);
    expect(api.calls[0].body).toEqual({ type: 'A', name: 'blog', content: '192.0.2.1', ttl: 300, proxied: false });
    expect(store.upsertDoc.mock.calls[0][1].details).toEqual({ family: 'dns', change: 'create', recordType: 'A', name: 'blog.example.com' });
    expect(notifier.notifyTelegram.mock.calls[0][0].message).toBe('Claude Network Guy added the A record blog.example.com in Cloudflare.');
  });

  it('refuses an edit when the record’s current name is protected, after reading it', async () => {
    const { handlers, api, store } = setup({ routes: { [`GET ${ZONE_PATH}/dns_records/${RECORD_ID}`]: ok(record({ name: 'api-azure.hybridcloudworks.com' })) } });
    const res = parse(await handlers.patchDns(request({ params: { recordId: RECORD_ID }, body: { proxied: false } }), {}));
    expect(res.status).toBe(409);
    expect(api.calls.map((call) => call.method)).toEqual(['GET']);
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('refuses an edit that would rename a record onto a protected name', async () => {
    const { handlers, api } = setup({ routes: { [`GET ${ZONE_PATH}/dns_records/${RECORD_ID}`]: ok(record()) } });
    const res = parse(await handlers.patchDns(request({ params: { recordId: RECORD_ID }, body: { name: 'www' } }), {}));
    expect(res.status).toBe(409);
    expect(api.calls.map((call) => call.method)).toEqual(['GET']);
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

  it('edits a record that is not protected, and records it', async () => {
    const { handlers, api, store } = setup({
      routes: {
        [`GET ${ZONE_PATH}/dns_records/${RECORD_ID}`]: ok(record()),
        [`PATCH ${ZONE_PATH}/dns_records/${RECORD_ID}`]: ok(record({ proxied: false })),
      },
    });
    const res = parse(await handlers.patchDns(request({ params: { recordId: RECORD_ID }, body: { proxied: false } }), {}));
    expect(res.status).toBe(200);
    expect(api.calls[1]).toMatchObject({ method: 'PATCH', body: { proxied: false } });
    expect(store.upsertDoc.mock.calls[0][1].details).toEqual({ family: 'dns', change: 'edit', recordType: 'A', name: 'blog.example.com' });
  });
});

describe('rules', () => {
  it('lists the zone’s rulesets, with the protected phases locked', async () => {
    const { handlers } = setup({
      routes: {
        [`GET ${ZONE_PATH}/rulesets`]: ok([
          { id: 'r1', name: 'origin', phase: 'http_request_late_transform', kind: 'zone' },
          { id: 'r2', name: 'redirects', phase: 'http_request_dynamic_redirect', kind: 'zone' },
        ]),
      },
    });
    const res = parse(await handlers.listRulesets(request(), {}));
    expect(res.body.rulesets.map((r) => [r.phase, r.locked])).toEqual([
      ['http_request_late_transform', true],
      ['http_request_dynamic_redirect', false],
    ]);
  });

  it('reads one phase, and answers null for a phase with no rules yet', async () => {
    const { handlers } = setup({
      routes: {
        [`GET ${ZONE_PATH}/rulesets/phases/http_request_dynamic_redirect/entrypoint`]: ok({ id: 'r2', phase: 'http_request_dynamic_redirect', rules: [{ id: 'x' }] }),
      },
    });
    const found = parse(await handlers.getPhase(request({ params: { phase: 'http_request_dynamic_redirect' } }), {}));
    expect(found.body.ruleset).toMatchObject({ id: 'r2', rules: [{ id: 'x' }], locked: false });
    const none = parse(await handlers.getPhase(request({ params: { phase: 'http_request_cache_settings' } }), {}));
    expect(none.status).toBe(200);
    expect(none.body.ruleset).toBeNull();
  });

  it.each(['', 'HTTP', 'http-request', '../x', 'a'.repeat(65)])('refuses the phase %j before calling Cloudflare', async (phase) => {
    const { handlers, api } = setup();
    expect(parse(await handlers.getPhase(request({ params: { phase } }), {})).status).toBe(400);
    expect(parse(await handlers.putPhase(request({ params: { phase }, body: { rules: [] } }), {})).status).toBe(400);
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it.each(['http_request_late_transform', 'http_ratelimit'])('refuses to replace the protected phase %s, and calls nothing', async (phase) => {
    const { handlers, api, store } = setup({ user: NETWORK_GUY });
    const res = parse(await handlers.putPhase(request({ params: { phase }, body: { rules: [] } }), {}));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CLOUDFLARE_PROTECTED');
    expect(api.fetch).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ rules: 'x' }], [{ rules: [1] }], [{ rules: [], kind: 'zone' }], [{ rules: Array.from({ length: 101 }, () => ({})) }]])(
    'refuses the rules %j',
    async (body) => {
      const { handlers, api } = setup();
      expect(parse(await handlers.putPhase(request({ params: { phase: 'http_request_dynamic_redirect' }, body }), {})).status).toBe(400);
      expect(api.fetch).not.toHaveBeenCalled();
    }
  );

  it('replaces a phase’s rules and records it', async () => {
    const rules = [{ expression: 'true', action: 'redirect', action_parameters: {} }];
    const { handlers, api, store } = setup({
      routes: { [`PUT ${ZONE_PATH}/rulesets/phases/http_request_dynamic_redirect/entrypoint`]: (url, init) => ok({ id: 'r2', phase: 'http_request_dynamic_redirect', ...JSON.parse(init.body) }) },
    });
    const res = parse(await handlers.putPhase(request({ params: { phase: 'http_request_dynamic_redirect' }, body: { rules, description: 'Redirects' } }), {}));
    expect(res.status).toBe(200);
    expect(api.calls[0].body).toEqual({ rules, description: 'Redirects' });
    expect(store.upsertDoc.mock.calls[0][1].details).toEqual({ family: 'rules', phase: 'http_request_dynamic_redirect', count: 1 });
  });

  it('drops Cloudflare’s own version and last_updated stamps from a rule sent back, and keeps the rest', async () => {
    const stamped = [{ id: 'x1', ref: 'r1', version: '3', last_updated: '2026-11-01T00:00:00Z', expression: 'true', action: 'redirect' }];
    const { handlers, api } = setup({
      routes: { [`PUT ${ZONE_PATH}/rulesets/phases/http_request_dynamic_redirect/entrypoint`]: (url, init) => ok({ id: 'r2', phase: 'http_request_dynamic_redirect', ...JSON.parse(init.body) }) },
    });
    const res = parse(await handlers.putPhase(request({ params: { phase: 'http_request_dynamic_redirect' }, body: { rules: stamped } }), {}));
    expect(res.status).toBe(200);
    expect(api.calls[0].body).toEqual({ rules: [{ id: 'x1', ref: 'r1', expression: 'true', action: 'redirect' }] });
  });
});

describe('a refusal from Cloudflare', () => {
  it.each([
    [400, 400, /not valid/],
    [401, 502, /refused the token/],
    [403, 502, /refused the token/],
    [404, 404, /no such item/],
    [429, 429, /limiting requests/],
    [500, 502, /HTTP 500/],
  ])('answers Cloudflare’s %i as %i with a sentence of its own, no audit row and no phone message', async (upstream, answer, sentence) => {
    const { handlers, store, notifier, context } = setup({
      user: NETWORK_GUY,
      routes: { [`PATCH ${ZONE_PATH}/settings/ssl`]: reply(upstream, { success: false, errors: [{ code: 1007, message: `far-end words ${TOKEN}` }] }) },
    });
    const res = await handlers.patchSetting(request({ params: { settingId: 'ssl' }, body: { value: 'flexible' } }), context);
    const body = JSON.parse(res.body);
    expect(res.status).toBe(answer);
    expect(body.error).toMatch(sentence);
    expect(res.body).not.toMatch(/far-end words/);
    expect(res.body).not.toContain(TOKEN);
    expect(logs(context)).not.toContain(TOKEN);
    expect(logs(context)).not.toMatch(/far-end words|ssl/);
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(notifier.notifyTelegram).not.toHaveBeenCalled();
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
      routes: { [`PATCH ${ZONE_PATH}/settings/ssl`]: ok({ id: 'ssl', value: 'strict' }) },
    });
    const res = await handlers.patchSetting(request({ params: { settingId: 'ssl' }, body: { value: 'strict' } }), context);
    expect(api.calls[0].url.startsWith(`${CLOUDFLARE_API_BASE}/zones/${ZONE}/`)).toBe(true);
    expect(api.calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(api.calls[0].url).not.toContain(TOKEN);
    expect(res.body).not.toContain(TOKEN);
    expect(JSON.stringify(store.upsertDoc.mock.calls)).not.toContain(TOKEN);
    expect(logs(context)).not.toContain(TOKEN);
  });
});

describe('no delete', () => {
  it('registers no DELETE route and makes no DELETE call', () => {
    for (const file of ['client.js', 'handlers.js', '../../functions/cloudflare-http.js']) {
      const source = readFileSync(join(HERE, file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(source, file).not.toMatch(/DELETE/);
    }
  });
});
