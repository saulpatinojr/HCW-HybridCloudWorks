/**
 * The three OAuth Connect routes (mcp-oauth-handlers.js): who may call them,
 * and every way a callback's state is refused — unknown, another
 * administrator's, expired, replayed, raced — before any code is exchanged.
 * The happy path runs end to end against a Hostinger-shaped fake: start,
 * the vendor's redirect, complete, the token stored, the tool sync run with
 * the new bearer.
 */
import { describe, it, expect, vi } from 'vitest';
import { createMcpOAuthHandlers } from './mcp-oauth-handlers.js';
import { createOAuthHttp } from './mcp-oauth.js';

const PUBLIC = '93.184.216.34';
const HOSTINGER_OAUTH = 'https://auth.hostinger.com/api/external/v1/oauth-server';
const NOW = new Date('2026-10-08T12:00:00.000Z');

const reply = (status, body = '', headers = {}) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  };
};

/** Hostinger as published on 2026-10-08, plus a token endpoint and an MCP server that lists one tool. */
function hostinger({ token = reply(200, { access_token: 'at-1', refresh_token: 'rt-1', token_type: 'Bearer', expires_in: 3600 }) } = {}) {
  const calls = [];
  const routes = {
    'POST https://mcp.hostinger.com/': (init) => {
      if (init.headers?.Authorization === 'Bearer at-1') {
        return reply(200, {
          jsonrpc: '2.0',
          id: 1,
          result: { tools: [{ name: 'VPS_getVirtualMachinesV1', description: 'List VPS', inputSchema: {} }] },
        });
      }
      return reply(401, '', {
        'www-authenticate':
          'Bearer realm="mcp", resource_metadata="https://mcp.hostinger.com/.well-known/oauth-protected-resource"',
      });
    },
    'GET https://mcp.hostinger.com/.well-known/oauth-protected-resource': reply(200, {
      resource: 'https://mcp.hostinger.com',
      authorization_servers: ['https://auth.hostinger.com'],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp:use'],
    }),
    'GET https://auth.hostinger.com/.well-known/oauth-authorization-server': reply(200, {
      issuer: 'https://auth.hostinger.com',
      authorization_endpoint: `${HOSTINGER_OAUTH}/authorize`,
      token_endpoint: `${HOSTINGER_OAUTH}/token`,
      registration_endpoint: `${HOSTINGER_OAUTH}/register`,
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [],
    }),
    [`POST ${HOSTINGER_OAUTH}/register`]: reply(201, { client_id: 'hst-client-1' }),
    [`POST ${HOSTINGER_OAUTH}/token`]: token,
  };
  const fetch = vi.fn(async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, headers: init.headers || {}, body: init.body });
    const handler = routes[`${method} ${url}`];
    if (!handler) return reply(404, {});
    return typeof handler === 'function' ? handler(init) : handler;
  });
  const http = createOAuthHttp({ fetch, resolve: async () => ({ address: PUBLIC }), dispatcherFor: () => ({ close: async () => {} }) });
  return { fetch, http, calls };
}

const PODBEAN = 'https://mcp.podbean.com';

/**
 * Podbean, the one Connect server whose metadata names a revocation_endpoint
 * (`https://mcp.podbean.com/revoke`, read 2026-10-13, #1116). The other
 * endpoints follow the same shape; `revoke` is the reply (or function) its
 * revocation endpoint answers with.
 */
function podbean({ revoke = reply(200, {}) } = {}) {
  const calls = [];
  const routes = {
    [`POST ${PODBEAN}/mcp`]: (init) =>
      init.headers?.Authorization === 'Bearer at-1'
        ? reply(200, { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'list_episodes', description: 'List', inputSchema: {} }] } })
        : reply(401, '', { 'www-authenticate': `Bearer resource_metadata="${PODBEAN}/.well-known/oauth-protected-resource"` }),
    [`GET ${PODBEAN}/.well-known/oauth-protected-resource`]: reply(200, {
      resource: `${PODBEAN}/mcp`,
      authorization_servers: [PODBEAN],
    }),
    [`GET ${PODBEAN}/.well-known/oauth-authorization-server`]: reply(200, {
      issuer: PODBEAN,
      authorization_endpoint: `${PODBEAN}/authorize`,
      token_endpoint: `${PODBEAN}/token`,
      registration_endpoint: `${PODBEAN}/register`,
      revocation_endpoint: `${PODBEAN}/revoke`,
      revocation_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
    }),
    [`POST ${PODBEAN}/register`]: reply(201, { client_id: 'pb-client-1', token_endpoint_auth_method: 'none' }),
    [`POST ${PODBEAN}/token`]: reply(200, { access_token: 'at-1', refresh_token: 'rt-1', token_type: 'Bearer', expires_in: 3600 }),
    [`POST ${PODBEAN}/revoke`]: revoke,
  };
  const fetch = vi.fn(async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, headers: init.headers || {}, body: init.body });
    const handler = routes[`${method} ${url}`];
    if (!handler) return reply(404, {});
    return typeof handler === 'function' ? handler(init) : handler;
  });
  const http = createOAuthHttp({ fetch, resolve: async () => ({ address: PUBLIC }), dispatcherFor: () => ({ close: async () => {} }) });
  return { fetch, http, calls };
}

/** An mcp_servers container with ETags, a state-hash query, and an audit log. */
function memStore(docs) {
  const data = new Map(docs.map((doc) => [doc.id, { ...doc, _etag: 'e0' }]));
  let version = 0;
  const audit = [];
  return {
    data,
    audit,
    readDoc: vi.fn(async (_c, id) => data.get(id) ?? null),
    patchDoc: vi.fn(async (_c, id, updates, options) => {
      const current = data.get(id);
      if (options?.ifMatch && options.ifMatch !== current._etag) {
        throw Object.assign(new Error('changed since read'), { code: 412 });
      }
      const next = { ...current, ...updates, _etag: `e${(version += 1)}` };
      data.set(id, next);
      return next;
    }),
    queryDocs: vi.fn(async (_c, _q, params) =>
      [...data.values()].filter((doc) => doc.oauthPending?.stateHash === params[0].value)
    ),
    upsertDoc: vi.fn(async (container, doc) => {
      if (container === 'admin_audit_logs') audit.push(doc);
      return doc;
    }),
  };
}

const hostingerDoc = () => ({
  id: 'hostinger-mcp',
  name: 'Hostinger MCP',
  url: 'https://mcp.hostinger.com',
  transport: 'http',
  authType: 'oauth',
  apiKeyEnvVar: null,
  enabled: false,
  status: 'error',
  lastError: 'fetch failed',
});

const podbeanDoc = () => ({
  id: 'podbean-mcp',
  name: 'Podbean MCP',
  url: `${PODBEAN}/mcp`,
  transport: 'http',
  authType: 'oauth',
  apiKeyEnvVar: null,
  enabled: false,
  status: 'untested',
});

/** Podbean as a completed Connect leaves it, with the revocation endpoint the sign-in discovered. */
const connectedPodbeanDoc = (over = {}) => ({
  ...podbeanDoc(),
  oauthToken: 'at-1',
  oauthRefreshToken: 'rt-1',
  oauthClient: { issuer: PODBEAN, clientId: 'pb-client-1', tokenEndpointAuthMethod: 'none' },
  oauth: {
    status: 'connected',
    issuer: PODBEAN,
    tokenEndpoint: `${PODBEAN}/token`,
    revocationEndpoint: `${PODBEAN}/revoke`,
    clientId: 'pb-client-1',
    tokenEndpointAuthMethod: 'none',
    resource: `${PODBEAN}/mcp`,
    ...over,
  },
});

const guardFor = (oid, role = 'super_admin') => ({
  requireRole: vi.fn(async (_request, minimum) =>
    minimum === 'super_admin' && role !== 'super_admin'
      ? { user: null, role: null, error: { status: 403, body: '{"error":"Requires super_admin or higher"}' } }
      : { user: { oid, name: 'Owner', email: 'owner@example.test' }, role, error: null }
  ),
});

const context = { error: vi.fn(), warn: vi.fn() };
const routeRequest = (serverId, body = {}) => ({ params: { serverId }, json: async () => body });
const bodyRequest = (body) => ({ params: {}, json: async () => body });
const parse = (res) => JSON.parse(res.body);

function handlersFor({ store, net, oid = 'owner-oid', role = 'super_admin', now = () => NOW }) {
  return createMcpOAuthHandlers({
    guard: guardFor(oid, role),
    store,
    env: {},
    fetch: net.fetch,
    now,
    log: { warn: vi.fn(), error: vi.fn() },
    oauthHttp: net.http,
    uuid: () => 'audit-1',
  });
}

async function started({ store, net, now }) {
  const res = await handlersFor({ store, net, now }).startMcpOAuth(routeRequest('hostinger-mcp'), context);
  expect(res.status).toBe(200);
  const url = new URL(parse(res).authorizationUrl);
  return { url, state: url.searchParams.get('state') };
}

describe('POST cms/mcp/{serverId}/oauth/start', () => {
  it('needs super_admin, and asks nothing of the network when refused', async () => {
    const store = memStore([hostingerDoc()]);
    const net = hostinger();
    const res = await handlersFor({ store, net, role: 'editor' }).startMcpOAuth(
      routeRequest('hostinger-mcp'),
      context
    );
    expect(res.status).toBe(403);
    expect(net.fetch).not.toHaveBeenCalled();
    expect(store.patchDoc).not.toHaveBeenCalled();
  });

  it('returns the authorization URL and stores the pending sign-in against the admin', async () => {
    const store = memStore([hostingerDoc()]);
    const net = hostinger();
    const { url, state } = await started({ store, net });
    expect(`${url.origin}${url.pathname}`).toBe(`${HOSTINGER_OAUTH}/authorize`);
    expect(url.searchParams.get('scope')).toBe('mcp:use');
    const doc = store.data.get('hostinger-mcp');
    expect(doc.oauthPending).toMatchObject({ createdBy: 'owner-oid', expiresAt: '2026-10-08T12:10:00.000Z' });
    expect(JSON.stringify(doc)).not.toContain(state);
    expect(doc.oauthClient.clientId).toBe('hst-client-1');
  });

  it('refuses servers that do not sign in with OAuth, and sends Plaud to its own Connect tab', async () => {
    const store = memStore([
      { id: 'firecrawl', name: 'Firecrawl', url: 'https://mcp.firecrawl.dev/sse', apiKeyEnvVar: 'FIRECRAWL_API_KEY' },
      { id: 'plaud', name: 'Plaud', url: 'https://mcp.plaud.ai/mcp', authType: 'oauth' },
    ]);
    const net = hostinger();
    const h = handlersFor({ store, net });
    const firecrawl = await h.startMcpOAuth(routeRequest('firecrawl'), context);
    expect(firecrawl.status).toBe(400);
    expect(parse(firecrawl)).toMatchObject({ ok: false, code: 'NOT_OAUTH' });
    const plaud = await h.startMcpOAuth(routeRequest('plaud'), context);
    expect(parse(plaud).error).toMatch(/Recording Hub → Connect/);
    expect((await h.startMcpOAuth(routeRequest('nope'), context)).status).toBe(404);
    expect(net.fetch).not.toHaveBeenCalled();
  });

  it('answers a discovery failure with the sentence that names it', async () => {
    const store = memStore([hostingerDoc()]);
    const net = hostinger();
    net.fetch.mockImplementation(async () => reply(404, {}));
    const res = await handlersFor({ store, net }).startMcpOAuth(routeRequest('hostinger-mcp'), context);
    expect(res.status).toBe(502);
    expect(parse(res).error).toMatch(/publishes no OAuth protected-resource metadata/);
  });
});

describe('POST cms/mcp/oauth/complete', () => {
  it('connects: exchanges the code, stores the token write-only, clears the error, syncs tools', async () => {
    const store = memStore([hostingerDoc()]);
    const net = hostinger();
    const { state } = await started({ store, net });

    const res = await handlersFor({ store, net }).completeMcpOAuth(bodyRequest({ state, code: 'code-1' }), context);
    expect(res.status).toBe(200);
    expect(parse(res)).toEqual({
      ok: true,
      connected: true,
      serverId: 'hostinger-mcp',
      serverName: 'Hostinger MCP',
      toolCount: 1,
    });
    expect(res.body).not.toContain('at-1');
    expect(res.body).not.toContain('rt-1');

    const exchange = net.calls.find((c) => c.url === `${HOSTINGER_OAUTH}/token`);
    expect(Object.fromEntries(new URLSearchParams(exchange.body))).toMatchObject({
      grant_type: 'authorization_code',
      code: 'code-1',
      redirect_uri: 'https://hybridcloudworks.com/admin/ai-engine/oauth/callback',
      client_id: 'hst-client-1',
      resource: 'https://mcp.hostinger.com',
    });

    const doc = store.data.get('hostinger-mcp');
    expect(doc).toMatchObject({
      oauthToken: 'at-1',
      oauthRefreshToken: 'rt-1',
      oauthPending: null,
      status: 'connected',
      lastError: null,
      oauth: { status: 'connected', scope: 'mcp:use', expiresAt: '2026-10-08T13:00:00.000Z' },
    });
    expect(doc.tools.map((t) => t.name)).toEqual(['VPS_getVirtualMachinesV1']);
    const sync = net.calls.filter((c) => c.url === 'https://mcp.hostinger.com/' && c.headers.Authorization);
    expect(sync[0].headers.Authorization).toBe('Bearer at-1');
    expect(store.audit).toEqual([
      expect.objectContaining({
        action: 'mcp_oauth_connected',
        userId: 'owner-oid',
        details: { collection: 'mcp_servers', documentId: 'hostinger-mcp', issuer: 'https://auth.hostinger.com', scope: 'mcp:use' },
      }),
    ]);
  });

  it('refuses an unknown state', async () => {
    const store = memStore([hostingerDoc()]);
    const net = hostinger();
    const res = await handlersFor({ store, net }).completeMcpOAuth(
      bodyRequest({ state: 'never-issued', code: 'c' }),
      context
    );
    expect(res.status).toBe(400);
    expect(parse(res)).toMatchObject({ code: 'STATE_UNKNOWN' });
    expect(net.fetch).not.toHaveBeenCalled();
  });

  it('refuses a callback missing its code or state', async () => {
    const store = memStore([hostingerDoc()]);
    const net = hostinger();
    for (const body of [{ state: 's' }, { code: 'c' }, null, { state: 's'.repeat(600), code: 'c' }]) {
      const res = await handlersFor({ store, net }).completeMcpOAuth(bodyRequest(body), context);
      expect(res.status).toBe(400);
      expect(parse(res).code).toBe('BAD_CALLBACK');
    }
  });

  it('refuses another administrator, without spending the state', async () => {
    const store = memStore([hostingerDoc()]);
    const net = hostinger();
    const { state } = await started({ store, net });
    const other = await handlersFor({ store, net, oid: 'other-oid' }).completeMcpOAuth(
      bodyRequest({ state, code: 'c' }),
      context
    );
    expect(other.status).toBe(403);
    expect(parse(other)).toMatchObject({ code: 'STATE_OTHER_ADMIN' });
    expect(net.calls.some((c) => c.url.endsWith('/token'))).toBe(false);
    expect(store.data.get('hostinger-mcp').oauthPending).not.toBeNull();

    const owner = await handlersFor({ store, net }).completeMcpOAuth(bodyRequest({ state, code: 'c' }), context);
    expect(owner.status).toBe(200);
  });

  it('refuses a state older than ten minutes, and spends it', async () => {
    const store = memStore([hostingerDoc()]);
    const net = hostinger();
    const { state } = await started({ store, net });
    const later = () => new Date(NOW.getTime() + 11 * 60_000);
    const res = await handlersFor({ store, net, now: later }).completeMcpOAuth(
      bodyRequest({ state, code: 'c' }),
      context
    );
    expect(res.status).toBe(400);
    expect(parse(res)).toMatchObject({ code: 'STATE_EXPIRED' });
    expect(parse(res).error).toMatch(/longer than 10 minutes/);
    expect(store.data.get('hostinger-mcp').oauthPending).toBeNull();
    expect(net.calls.some((c) => c.url.endsWith('/token'))).toBe(false);
  });

  it('refuses a replayed state', async () => {
    const store = memStore([hostingerDoc()]);
    const net = hostinger();
    const { state } = await started({ store, net });
    const h = handlersFor({ store, net });
    expect((await h.completeMcpOAuth(bodyRequest({ state, code: 'c' }), context)).status).toBe(200);
    const replay = await h.completeMcpOAuth(bodyRequest({ state, code: 'c' }), context);
    expect(replay.status).toBe(400);
    expect(parse(replay).code).toBe('STATE_UNKNOWN');
    expect(net.calls.filter((c) => c.url.endsWith('/token'))).toHaveLength(1);
  });

  it('lets one of two racing completions through and refuses the other before the token endpoint', async () => {
    const store = memStore([hostingerDoc()]);
    const net = hostinger();
    const { state } = await started({ store, net });
    // The other completion spends the state between this one's read and write.
    const realPatch = store.patchDoc.getMockImplementation();
    store.patchDoc.mockImplementationOnce(async (c, id, updates, options) => {
      await realPatch(c, id, { touchedBy: 'the-other-completion' });
      return realPatch(c, id, updates, options);
    });
    const res = await handlersFor({ store, net }).completeMcpOAuth(bodyRequest({ state, code: 'c' }), context);
    expect(res.status).toBe(409);
    expect(parse(res).code).toBe('STATE_USED');
    expect(net.calls.some((c) => c.url.endsWith('/token'))).toBe(false);
  });

  it('says what the vendor said when the exchange is refused, and stores nothing', async () => {
    const store = memStore([hostingerDoc()]);
    const net = hostinger({ token: reply(400, { error: 'invalid_grant', error_description: 'code expired' }) });
    const { state } = await started({ store, net });
    const res = await handlersFor({ store, net }).completeMcpOAuth(bodyRequest({ state, code: 'c' }), context);
    expect(res.status).toBe(502);
    expect(parse(res).error).toMatch(/refused the sign-in code: invalid_grant: code expired.*Press Connect/);
    expect(store.data.get('hostinger-mcp').oauthToken).toBeUndefined();
  });

  it('needs super_admin', async () => {
    const store = memStore([hostingerDoc()]);
    const net = hostinger();
    const res = await handlersFor({ store, net, role: 'editor' }).completeMcpOAuth(
      bodyRequest({ state: 's', code: 'c' }),
      context
    );
    expect(res.status).toBe(403);
    expect(store.queryDocs).not.toHaveBeenCalled();
  });
});

describe('POST cms/mcp/{serverId}/oauth/disconnect', () => {
  it('clears the tokens, the connection and any pending sign-in, keeps the registration, and audits', async () => {
    const store = memStore([
      {
        ...hostingerDoc(),
        oauthToken: 'at-1',
        oauthRefreshToken: 'rt-1',
        oauth: { status: 'connected', issuer: 'https://auth.hostinger.com' },
        oauthPending: { stateHash: 'h' },
        oauthClient: { clientId: 'hst-client-1' },
      },
    ]);
    const net = hostinger();
    const res = await handlersFor({ store, net }).disconnectMcpOAuth(routeRequest('hostinger-mcp'), context);
    // No revocation_endpoint on the connection (Hostinger advertises none): nowhere to revoke.
    expect(parse(res)).toEqual({ ok: true, disconnected: true, revoked: null, issuer: 'https://auth.hostinger.com' });
    expect(store.data.get('hostinger-mcp')).toMatchObject({
      oauthToken: null,
      oauthRefreshToken: null,
      oauth: null,
      oauthPending: null,
      status: 'untested',
      lastError: null,
      oauthClient: { clientId: 'hst-client-1' },
    });
    expect(store.audit[0]).toMatchObject({
      action: 'mcp_oauth_disconnected',
      details: { issuer: 'https://auth.hostinger.com', revoked: null },
    });
    expect(net.fetch).not.toHaveBeenCalled();
  });

  it('needs super_admin', async () => {
    const store = memStore([hostingerDoc()]);
    const res = await handlersFor({ store, net: hostinger(), role: 'editor' }).disconnectMcpOAuth(
      routeRequest('hostinger-mcp'),
      context
    );
    expect(res.status).toBe(403);
    expect(store.patchDoc).not.toHaveBeenCalled();
  });
});

describe('disconnect revokes the grant at the provider (RFC 7009, #1116)', () => {
  /** Every string every log channel was given, so a token can be looked for in all of them. */
  const logged = (ctx, h) =>
    JSON.stringify([...ctx.warn.mock.calls, ...ctx.error.mock.calls, ...h.log.warn.mock.calls, ...h.log.error.mock.calls]);
  const freshContext = () => ({ error: vi.fn(), warn: vi.fn() });
  const handlersWithLog = ({ store, net }) => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const h = createMcpOAuthHandlers({
      guard: guardFor('owner-oid'),
      store,
      env: {},
      fetch: net.fetch,
      now: () => NOW,
      log,
      oauthHttp: net.http,
      uuid: () => 'audit-1',
    });
    return { ...h, log };
  };
  const revokeCalls = (net) => net.calls.filter((c) => c.url === `${PODBEAN}/revoke`);

  it('stores the revocation endpoint the sign-in discovered, then on Disconnect revokes refresh then access before deleting', async () => {
    const store = memStore([podbeanDoc()]);
    const net = podbean();
    const start = await handlersFor({ store, net }).startMcpOAuth(routeRequest('podbean-mcp'), context);
    const state = new URL(parse(start).authorizationUrl).searchParams.get('state');
    expect(store.data.get('podbean-mcp').oauthPending.revocationEndpoint).toBe(`${PODBEAN}/revoke`);
    const done = await handlersFor({ store, net }).completeMcpOAuth(bodyRequest({ state, code: 'c' }), context);
    expect(done.status).toBe(200);
    expect(store.data.get('podbean-mcp').oauth).toMatchObject({
      status: 'connected',
      issuer: PODBEAN,
      revocationEndpoint: `${PODBEAN}/revoke`,
    });

    // The order of events: both revocations reach the provider before the local delete.
    const revokedBeforeDelete = [];
    const realPatch = store.patchDoc.getMockImplementation();
    store.patchDoc.mockImplementation(async (...args) => {
      revokedBeforeDelete.push(revokeCalls(net).length);
      return realPatch(...args);
    });
    const ctx = freshContext();
    const h = handlersWithLog({ store, net });
    const res = await h.disconnectMcpOAuth(routeRequest('podbean-mcp'), ctx);
    expect(parse(res)).toEqual({ ok: true, disconnected: true, revoked: true, issuer: PODBEAN });
    expect(revokedBeforeDelete).toEqual([2]);

    const [refresh, access] = revokeCalls(net);
    expect(refresh.method).toBe('POST');
    expect(refresh.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(refresh.headers).not.toHaveProperty('Authorization');
    expect(Object.fromEntries(new URLSearchParams(refresh.body))).toEqual({
      token: 'rt-1',
      token_type_hint: 'refresh_token',
      client_id: 'pb-client-1',
    });
    expect(Object.fromEntries(new URLSearchParams(access.body))).toEqual({
      token: 'at-1',
      token_type_hint: 'access_token',
      client_id: 'pb-client-1',
    });
    expect(store.data.get('podbean-mcp')).toMatchObject({ oauthToken: null, oauthRefreshToken: null, oauth: null });
    expect(store.audit.at(-1)).toMatchObject({
      action: 'mcp_oauth_disconnected',
      details: { issuer: PODBEAN, revoked: true },
    });
    expect(logged(ctx, h)).not.toMatch(/at-1|rt-1/);
    expect(res.body).not.toMatch(/at-1|rt-1/);
  });

  it('authenticates a confidential client at the revocation endpoint the way the token endpoint is called', async () => {
    const store = memStore([
      {
        ...connectedPodbeanDoc({ tokenEndpointAuthMethod: 'client_secret_basic' }),
        oauthClientSecret: 'pb-secret',
      },
    ]);
    const net = podbean();
    const res = await handlersFor({ store, net }).disconnectMcpOAuth(routeRequest('podbean-mcp'), context);
    expect(parse(res).revoked).toBe(true);
    for (const call of revokeCalls(net)) {
      expect(call.headers.Authorization).toBe(`Basic ${Buffer.from('pb-client-1:pb-secret').toString('base64')}`);
      expect(new URLSearchParams(call.body).has('client_secret')).toBe(false);
    }
  });

  it('still deletes the tokens when the provider refuses the revocation, and says the grant may be live', async () => {
    const store = memStore([connectedPodbeanDoc()]);
    const net = podbean({ revoke: reply(503, { error: 'temporarily_unavailable' }) });
    const ctx = freshContext();
    const h = handlersWithLog({ store, net });
    const res = await h.disconnectMcpOAuth(routeRequest('podbean-mcp'), ctx);
    expect(res.status).toBe(200);
    expect(parse(res)).toMatchObject({ ok: true, disconnected: true, revoked: false, issuer: PODBEAN });
    expect(parse(res).reason).toMatch(/mcp\.podbean\.com\/revoke answered the refresh token revocation with temporarily_unavailable/);
    expect(store.data.get('podbean-mcp')).toMatchObject({ oauthToken: null, oauthRefreshToken: null, oauth: null, status: 'untested' });
    // The access token was still tried after the refresh token was refused.
    expect(revokeCalls(net)).toHaveLength(2);
    expect(ctx.warn).toHaveBeenCalledWith(expect.stringMatching(/was not revoked at https:\/\/mcp\.podbean\.com/));
    expect(logged(ctx, h)).not.toMatch(/at-1|rt-1/);
    expect(res.body).not.toMatch(/at-1|rt-1/);
    expect(store.audit.at(-1).details).toEqual({ collection: 'mcp_servers', documentId: 'podbean-mcp', issuer: PODBEAN, revoked: false });
  });

  it('treats no answer from the provider the same way: deleted here, revoked false, the reason names the address only', async () => {
    const store = memStore([connectedPodbeanDoc()]);
    const net = podbean();
    net.fetch.mockImplementation(async () => {
      throw new Error('ECONNRESET');
    });
    const ctx = freshContext();
    const res = await handlersFor({ store, net }).disconnectMcpOAuth(routeRequest('podbean-mcp'), ctx);
    expect(parse(res)).toMatchObject({ revoked: false, issuer: PODBEAN });
    expect(parse(res).reason).toMatch(/^https:\/\/mcp\.podbean\.com\/revoke could not be reached/);
    expect(parse(res).reason).not.toMatch(/at-1|rt-1/);
    expect(store.data.get('podbean-mcp').oauthToken).toBeNull();
  });

  it('sends no token to a revocation endpoint that is not https, and reports it', async () => {
    const store = memStore([connectedPodbeanDoc({ revocationEndpoint: 'http://mcp.podbean.com/revoke' })]);
    const net = podbean();
    const res = await handlersFor({ store, net }).disconnectMcpOAuth(routeRequest('podbean-mcp'), context);
    expect(parse(res)).toMatchObject({ revoked: false, issuer: PODBEAN });
    expect(parse(res).reason).toMatch(/must be an https address/);
    expect(net.fetch).not.toHaveBeenCalled();
    expect(store.data.get('podbean-mcp').oauthToken).toBeNull();
  });

  it('has nowhere to revoke on a connection stored before the endpoint was kept', async () => {
    const { revocationEndpoint: _none, ...older } = connectedPodbeanDoc().oauth;
    const store = memStore([{ ...connectedPodbeanDoc(), oauth: older }]);
    const net = podbean();
    const res = await handlersFor({ store, net }).disconnectMcpOAuth(routeRequest('podbean-mcp'), context);
    expect(parse(res)).toEqual({ ok: true, disconnected: true, revoked: null, issuer: PODBEAN });
    expect(net.fetch).not.toHaveBeenCalled();
    expect(store.data.get('podbean-mcp').oauthToken).toBeNull();
  });
});

describe('complete: the checks added after the security review (2026-10-08)', () => {
  it('refuses a redirect whose iss names another issuer (RFC 9207 mix-up defence)', async () => {
    const store = memStore([hostingerDoc()]);
    const net = hostinger();
    const { state } = await started({ store, net });
    const res = await handlersFor({ store, net }).completeMcpOAuth(
      bodyRequest({ state, code: 'c', iss: 'https://evil.example' }),
      context
    );
    expect(res.status).toBe(400);
    expect(parse(res)).toMatchObject({ code: 'ISSUER_MISMATCH' });
    expect(parse(res).error).toMatch(/came back from https:\/\/evil\.example, not from Hostinger MCP's sign-in server/);
    expect(net.calls.some((c) => c.url.endsWith('/token'))).toBe(false);
  });

  it('accepts the issuer verbatim and no other spelling of it (RFC 9207, review of #1019)', async () => {
    for (const [iss, status] of [
      ['https://auth.hostinger.com', 200],
      ['https://auth.hostinger.com/', 400],
      [' https://auth.hostinger.com', 400],
    ]) {
      const store = memStore([hostingerDoc()]);
      const net = hostinger();
      const { state } = await started({ store, net });
      const res = await handlersFor({ store, net }).completeMcpOAuth(bodyRequest({ state, code: 'c', iss }), context);
      expect(res.status, iss).toBe(status);
      if (status === 400) expect(parse(res).code).toBe('ISSUER_MISMATCH');
    }
  });

  it('refuses a missing iss only where the server promised to send it', async () => {
    const store = memStore([hostingerDoc()]);
    const net = hostinger();
    const { state } = await started({ store, net });
    const doc = store.data.get('hostinger-mcp');
    store.data.set('hostinger-mcp', { ...doc, oauthPending: { ...doc.oauthPending, issParameterSupported: true } });
    const res = await handlersFor({ store, net }).completeMcpOAuth(bodyRequest({ state, code: 'c' }), context);
    expect(res.status).toBe(400);
    expect(parse(res).code).toBe('ISSUER_MISMATCH');
  });

  it('refuses when the server moved or stopped using Connect while the sign-in was out', async () => {
    for (const change of [{ url: 'https://mcp.elsewhere.example' }, { authType: undefined }]) {
      const store = memStore([hostingerDoc()]);
      const net = hostinger();
      const { state } = await started({ store, net });
      store.data.set('hostinger-mcp', { ...store.data.get('hostinger-mcp'), ...change });
      const res = await handlersFor({ store, net }).completeMcpOAuth(bodyRequest({ state, code: 'c' }), context);
      expect(res.status).toBe(409);
      expect(parse(res).code).toBe('SERVER_CHANGED');
      expect(net.calls.some((c) => c.url.endsWith('/token'))).toBe(false);
    }
  });

  it('does not give the token to a server moved after the state was spent (review of #1019)', async () => {
    for (const change of [{ url: 'https://mcp.elsewhere.example' }, { authType: undefined }]) {
      const store = memStore([hostingerDoc()]);
      // The change lands while the code is being exchanged: after the spend, before the store.
      const token = async () => {
        const doc = store.data.get('hostinger-mcp');
        store.data.set('hostinger-mcp', { ...doc, ...change, _etag: 'changed-meanwhile' });
        return reply(200, { access_token: 'at-1', refresh_token: 'rt-1', token_type: 'Bearer', expires_in: 3600 });
      };
      const net = hostinger({ token });
      const { state } = await started({ store, net });
      const res = await handlersFor({ store, net }).completeMcpOAuth(bodyRequest({ state, code: 'c' }), context);
      expect(res.status).toBe(409);
      expect(parse(res).code).toBe('SERVER_CHANGED');
      expect(store.data.get('hostinger-mcp').oauthToken).toBeUndefined();
      expect(store.audit.some((row) => row.action === 'mcp_oauth_connected')).toBe(false);
    }
  });

  it('fails closed when the document came back without an ETag', async () => {
    const store = memStore([hostingerDoc()]);
    const net = hostinger();
    const { state } = await started({ store, net });
    const { _etag: _dropped, ...noEtag } = store.data.get('hostinger-mcp');
    store.data.set('hostinger-mcp', noEtag);
    const res = await handlersFor({ store, net }).completeMcpOAuth(bodyRequest({ state, code: 'c' }), context);
    expect(res.status).toBe(500);
    expect(store.data.get('hostinger-mcp').oauthPending).not.toBeNull();
    expect(net.calls.some((c) => c.url.endsWith('/token'))).toBe(false);
  });
});
