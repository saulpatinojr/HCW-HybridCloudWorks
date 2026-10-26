import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStore } from '../../../test/memory-store.js';
import { createClientIdentity } from '../auth/client-identity.js';
import {
  DOOR_CODES,
  VISITOR_DOC_TTL_SECONDS,
  VISITOR_SESSION_SWITCH,
  createVisitorCoderUser,
  createVisitorSessionHandlers,
  createVisitorWorkspace,
  deleteVisitorUser,
  deleteVisitorWorkspace,
  generateVisitorCredentials,
  getTemplateByName,
  readBrokerConfig,
  readVisitorMaxConcurrent,
  reapExpiredVisitorSessions,
  visitorSessionsEnabled,
} from './visitor-session.js';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const SITE = 'https://hybridcloudworks.com';
const TOKEN = 'turnstile-token-sample';

/**
 * WHO IS CALLING (#1387). These tests give the handlers the real
 * `createClientIdentity()`, built as production builds it (the origin lock on,
 * a salt), and put their callers on requests the way Cloudflare does: with the
 * origin secret and the caller's address. They used to give the handlers a
 * hand-written identity with a `fromRequest` method the real helper has never
 * had, so the code and its stand-in agreed with each other and every visitor
 * was the same person in production.
 */
const ORIGIN_SECRET = 'test-origin-secret';
const IP_SALT = 'test-ip-salt';
const realIdentity = () =>
  createClientIdentity({ originSecret: ORIGIN_SECRET, ipSalt: IP_SALT, allowUnverifiedOrigin: false });

/** Two different visitors, and the headers of a request that reached the Function through our Cloudflare from each. */
const ALICE = '203.0.113.10';
const BOB = '203.0.113.20';
const fromCaller = (ip, extra = {}) =>
  new Headers({ 'x-hcw-origin-secret': ORIGIN_SECRET, 'cf-connecting-ip': ip, ...extra });

/** The key the real helper files a caller's sessions and daily quota under. */
const keyOf = (ip) => realIdentity().anonymousKey({ headers: fromCaller(ip) }).key;
const ALICE_KEY = keyOf(ALICE);
const BOB_KEY = keyOf(BOB);

/** The handlers, built on the real identity helper unless a test says otherwise. */
const makeHandlers = (deps) => createVisitorSessionHandlers({ identity: realIdentity(), ...deps });

/**
 * Answers the three queries the module sends: by type, by status, and by expiry.
 * An in-memory store cannot run Cosmos SQL, so the test says what Cosmos would answer.
 */
function sessionQuery({ docs, parameters }) {
  const value = (name) => parameters?.find((p) => p.name === name)?.value;
  return docs.filter(
    (d) =>
      (value('@type') === undefined || d.type === value('@type')) &&
      (value('@status') === undefined || d.status === value('@status')) &&
      (value('@nowIso') === undefined || d.expiresAt <= value('@nowIso'))
  );
}

/**
 * A store that behaves like Cosmos where it matters here (test/memory-store.js):
 * a replace with a stale ETag is a 412, a create over an existing id a 409, and
 * `replaceDocIfMatch` takes the real function's arguments
 * `(containerName, document, options)` and refuses any other (#1383).
 *
 * This file's own store used to take `(container, id, doc, etag)` and accept
 * any ETag, which is the shape the module was written to and the real function
 * does not have. The module and its fake agreed with each other, so the
 * visitor session's two saves were wrong in production and right in every test.
 */
function cosmosLikeStore(sessions = []) {
  return memoryStore(Object.fromEntries(sessions.map((s) => [`lab_jobs/${s.id}`, s])), {
    query: sessionQuery,
  });
}

/** The store most tests use: Cosmos-like, plus the compare-and-increment the daily cap takes. */
function mockStore(initialDocs = []) {
  const store = cosmosLikeStore(initialDocs);
  store.incrementIf = vi.fn(async (container, id, options) => {
    const existing = store.docs.get(`${container}/${id}`);
    if (!existing) throw Object.assign(new Error('NotFound'), { code: 404 });
    const limit = options?.conditionValues?.limit;
    if (typeof limit === 'number' && (existing.count || 0) >= limit) {
      throw Object.assign(new Error('PreconditionFailed'), { code: 412 });
    }
    existing.count = (existing.count || 0) + 1;
    return existing;
  });
  return store;
}

describe('visitorSessionsEnabled and config helpers', () => {
  it('enables visitor sessions only when switch is exactly "true"', () => {
    expect(visitorSessionsEnabled({ [VISITOR_SESSION_SWITCH]: 'true' })).toBe(true);
    expect(visitorSessionsEnabled({ [VISITOR_SESSION_SWITCH]: 'false' })).toBe(false);
    expect(visitorSessionsEnabled({ [VISITOR_SESSION_SWITCH]: '1' })).toBe(false);
    expect(visitorSessionsEnabled({})).toBe(false);
  });

  it('reads max concurrent sessions with fallback to default 2', () => {
    expect(readVisitorMaxConcurrent({ LABS_VISITOR_MAX_CONCURRENT: '3' })).toBe(3);
    expect(readVisitorMaxConcurrent({ LABS_VISITOR_MAX_CONCURRENT: '0' })).toBe(2);
    expect(readVisitorMaxConcurrent({})).toBe(2);
  });

  it('reads broker config and rejects invalid URLs', () => {
    expect(readBrokerConfig({ CODER_URL: 'http://insecure.local' })).toBeNull();
    expect(readBrokerConfig({ CODER_URL: 'https://coder.lab.example.com', CODER_BROKER_TOKEN: 'valid-token' })).toEqual({
      base: 'https://coder.lab.example.com',
      token: 'valid-token',
      max: 5,
    });
    expect(readBrokerConfig({ CODER_URL: 'https://coder.lab.example.com' })).toBeNull();
  });

  it('generates random visitor credentials with v- prefix', () => {
    const creds = generateVisitorCredentials();
    expect(creds.username).toMatch(/^v-[a-f0-9]{12}$/);
    expect(creds.email).toBe(`${creds.username}@visitor.lab.hybridcloudworks.com`);
    expect(creds.password).toBeDefined();
  });
});

describe('Coder API helpers', () => {
  it('creates visitor user via Coder API', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ id: 'u-1', username: 'v-123456' }),
    }));
    const res = await createVisitorCoderUser(fetchImpl, { base: 'https://coder.example.com', token: 'tok' }, {
      username: 'v-123456',
      email: 'v-123456@visitor.lab.hybridcloudworks.com',
      password: 'pass',
    });
    expect(res.id).toBe('u-1');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://coder.example.com/api/v2/users',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('throws error when user creation fails', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    }));
    await expect(
      createVisitorCoderUser(fetchImpl, { base: 'https://coder.example.com', token: 'tok' }, {
        username: 'v-123456',
        email: 'v-123456@visitor.lab.hybridcloudworks.com',
        password: 'pass',
      })
    ).rejects.toThrow('Failed to create Coder user: HTTP 500 internal error');
  });

  it('throws error when listing templates fails or template is not found', async () => {
    const fetchFail = vi.fn(async () => ({ ok: false, status: 502 }));
    await expect(
      getTemplateByName(fetchFail, { base: 'https://coder.example.com', token: 'tok' })
    ).rejects.toThrow('Failed to list Coder templates: HTTP 502');

    const fetchEmpty = vi.fn(async () => ({ ok: true, json: async () => [] }));
    await expect(
      getTemplateByName(fetchEmpty, { base: 'https://coder.example.com', token: 'tok' })
    ).rejects.toThrow("Coder template 'hcw-lab' not found");
  });

  it('throws error when organization listing fails or returns empty', async () => {
    const fetchFail = vi.fn(async (url) => {
      if (url.endsWith('/templates')) return { ok: true, json: async () => [{ id: 't1', name: 'hcw-lab' }] };
      return { ok: false, status: 503 };
    });
    await expect(
      createVisitorWorkspace(fetchFail, { base: 'https://coder.example.com', token: 'tok' }, {
        userId: 'u1',
        username: 'v-1',
        workspaceName: 'lab-lzb',
        labId: 'landing-zone-builder-output',
      })
    ).rejects.toThrow('Failed to list Coder organizations: HTTP 503');

    const fetchEmpty = vi.fn(async (url) => {
      if (url.endsWith('/templates')) return { ok: true, json: async () => [{ id: 't1', name: 'hcw-lab' }] };
      return { ok: true, json: async () => [] };
    });
    await expect(
      createVisitorWorkspace(fetchEmpty, { base: 'https://coder.example.com', token: 'tok' }, {
        userId: 'u1',
        username: 'v-1',
        workspaceName: 'lab-lzb',
        labId: 'landing-zone-builder-output',
      })
    ).rejects.toThrow('No default Coder organization found');
  });

  it('throws error when workspace creation fails', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/templates')) return { ok: true, json: async () => [{ id: 't1', name: 'hcw-lab' }] };
      if (url.endsWith('/organizations')) return { ok: true, json: async () => [{ id: 'org-1' }] };
      return { ok: false, status: 400, text: async () => 'workspace limit reached' };
    });
    await expect(
      createVisitorWorkspace(fetchImpl, { base: 'https://coder.example.com', token: 'tok' }, {
        userId: 'u1',
        username: 'v-1',
        workspaceName: 'lab-lzb',
        labId: 'landing-zone-builder-output',
      })
    ).rejects.toThrow('Failed to create visitor workspace: HTTP 400 workspace limit reached');
  });

  it('creates visitor workspace and returns accessUrl', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/api/v2/templates')) {
        return { ok: true, json: async () => [{ id: 'tmpl-1', name: 'hcw-lab' }] };
      }
      if (url.endsWith('/api/v2/organizations')) {
        return { ok: true, json: async () => [{ id: 'org-default' }] };
      }
      return {
        ok: true,
        json: async () => ({ id: 'ws-1', name: 'lab-lzb' }),
      };
    });

    const res = await createVisitorWorkspace(
      fetchImpl,
      { base: 'https://coder.example.com', token: 'tok' },
      { userId: 'u-1', username: 'v-123', workspaceName: 'lab-lzb', labId: 'landing-zone-builder-output' }
    );
    expect(res.workspace.id).toBe('ws-1');
    expect(res.accessUrl).toBe(
      'https://code-server--lab-lzb--v-123.coder.lab.hybridcloudworks.com/?folder=/tmp/home/lab'
    );
  });

  it('deletes workspace and user', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    const wsDeleted = await deleteVisitorWorkspace(fetchImpl, { base: 'https://coder.example.com', token: 'tok' }, 'ws-1');
    const userDeleted = await deleteVisitorUser(fetchImpl, { base: 'https://coder.example.com', token: 'tok' }, 'u-1');
    expect(wsDeleted).toBe(true);
    expect(userDeleted).toBe(true);
  });

  it('handles network failure gracefully during delete', async () => {
    const throwFetch = vi.fn(async () => {
      throw new Error('network down');
    });
    const wsDeleted = await deleteVisitorWorkspace(throwFetch, { base: 'https://c.com' }, 'ws-1');
    const userDeleted = await deleteVisitorUser(throwFetch, { base: 'https://c.com' }, 'u-1');
    expect(wsDeleted).toBe(false);
    expect(userDeleted).toBe(false);
  });
});

describe('createVisitorSessionHandlers: getStatus', () => {
  const env = {
    [VISITOR_SESSION_SWITCH]: 'true',
    TURNSTILE_SECRET_KEY: 'turnstile-secret',
    CODER_URL: 'https://coder.lab.hybridcloudworks.com',
    CODER_BROKER_TOKEN: 'broker-token',
  };

  it('reports closed when switch is off', async () => {
    const prev = process.env;
    process.env = { ...env, [VISITOR_SESSION_SWITCH]: 'false' };
    const handlers = makeHandlers({ store: mockStore() });
    const res = await handlers.getStatus({ headers: fromCaller(ALICE) });
    const body = JSON.parse(res.body);
    expect(body.open).toBe(false);
    expect(body.code).toBe(DOOR_CODES.closed);
    process.env = prev;
  });

  it('reports turnstile_unconfigured when secret missing', async () => {
    const prev = process.env;
    process.env = { ...env, TURNSTILE_SECRET_KEY: '' };
    const handlers = makeHandlers({ store: mockStore() });
    const res = await handlers.getStatus({ headers: fromCaller(ALICE) });
    const body = JSON.parse(res.body);
    expect(body.open).toBe(false);
    expect(body.code).toBe(DOOR_CODES.turnstile_unconfigured);
    process.env = prev;
  });

  it('reports open when available', async () => {
    const prev = process.env;
    process.env = { ...env };
    const handlers = makeHandlers({
      store: mockStore(),
      clock: () => NOW,
    });
    const res = await handlers.getStatus({ headers: fromCaller(ALICE) });
    const body = JSON.parse(res.body);
    expect(body.open).toBe(true);
    expect(body.bounds.maxConcurrent).toBe(2);
    expect(body.bounds.activeCount).toBe(0);
    process.env = prev;
  });

  it('reports active session when client already holds one', async () => {
    const prev = process.env;
    process.env = { ...env };
    const activeDoc = {
      id: 'sess-1',
      type: 'visitor-session',
      status: 'active',
      clientHash: ALICE_KEY,
      labId: 'landing-zone-builder-output',
      accessUrl: 'https://code-server--lab-lzb--v-test.coder.lab.hybridcloudworks.com/?folder=/tmp/home/lab',
      expiresAt: new Date(NOW + 3000000).toISOString(),
    };
    const store = mockStore([activeDoc]);
    const handlers = makeHandlers({ store, clock: () => NOW });
    const res = await handlers.getStatus({ headers: fromCaller(ALICE) });
    const body = JSON.parse(res.body);
    expect(body.open).toBe(true);
    expect(body.code).toBe(DOOR_CODES.active_session_exists);
    expect(body.session.id).toBe('sess-1');
    process.env = prev;
  });

  it('reports capacity full when live sessions equal max concurrent', async () => {
    const prev = process.env;
    process.env = { ...env };
    const doc1 = {
      id: 'sess-1',
      type: 'visitor-session',
      status: 'active',
      clientHash: 'client-1',
      expiresAt: new Date(NOW + 3000000).toISOString(),
    };
    const doc2 = {
      id: 'sess-2',
      type: 'visitor-session',
      status: 'active',
      clientHash: 'client-2',
      expiresAt: new Date(NOW + 3000000).toISOString(),
    };
    const store = mockStore([doc1, doc2]);
    const handlers = makeHandlers({ store, clock: () => NOW });
    const res = await handlers.getStatus({ headers: fromCaller(ALICE) });
    const body = JSON.parse(res.body);
    expect(body.open).toBe(false);
    expect(body.code).toBe(DOOR_CODES.capacity_full);
    process.env = prev;
  });

  it('reports unconfigured when broker config is missing', async () => {
    const prev = process.env;
    process.env = { ...env, CODER_URL: '' };
    const handlers = makeHandlers({ store: mockStore() });
    const res = await handlers.getStatus({ headers: fromCaller(ALICE) });
    const body = JSON.parse(res.body);
    expect(body.open).toBe(false);
    expect(body.code).toBe(DOOR_CODES.unconfigured);
    process.env = prev;
  });

  it('reports coder_unavailable 503 when queryDocs fails', async () => {
    const prev = process.env;
    process.env = { ...env };
    const failingStore = {
      queryDocs: vi.fn(async () => {
        throw new Error('cosmos query failure');
      }),
    };
    const handlers = makeHandlers({ store: failingStore });
    const res = await handlers.getStatus({ headers: fromCaller(ALICE) });
    expect(res.status).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.code).toBe(DOOR_CODES.coder_unavailable);
    process.env = prev;
  });

  it('proactively triggers reap when expired sessions are found during getStatus', async () => {
    const prev = process.env;
    process.env = { ...env };
    const expiredDoc = {
      id: 'sess-reap-check',
      type: 'visitor-session',
      status: 'active',
      expiresAt: new Date(NOW - 5000).toISOString(),
    };
    const store = mockStore([expiredDoc]);
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    const handlers = makeHandlers({
      store,
      fetchImpl,
      clock: () => NOW,
    });
    const res = await handlers.getStatus({ headers: fromCaller(ALICE) });
    expect(res.status).toBe(200);
    // The reap runs behind the answer; it must end with the record saved (#1383).
    await vi.waitFor(() => expect(store.get('lab_jobs', 'sess-reap-check').status).toBe('expired'));
    process.env = prev;
  });
});

describe('createVisitorSessionHandlers: startSession', () => {
  const env = {
    [VISITOR_SESSION_SWITCH]: 'true',
    TURNSTILE_SECRET_KEY: 'turnstile-secret',
    CODER_URL: 'https://coder.lab.hybridcloudworks.com',
    CODER_BROKER_TOKEN: 'broker-token',
  };

  const passSiteverify = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      success: true,
      hostname: 'hybridcloudworks.com',
      action: 'visitor-session',
    }),
  }));

  const coderMocks = vi.fn(async (url) => {
    if (url.endsWith('/api/v2/templates')) {
      return { ok: true, json: async () => [{ id: 'tmpl-1', name: 'hcw-lab' }] };
    }
    if (url.endsWith('/api/v2/organizations')) {
      return { ok: true, json: async () => [{ id: 'org-1' }] };
    }
    if (url.endsWith('/api/v2/users')) {
      return { ok: true, json: async () => ({ id: 'u-1', username: 'v-test' }) };
    }
    return { ok: true, json: async () => ({ id: 'ws-1', name: 'lab-lzb' }) };
  });

  it('refuses non-site origins', async () => {
    const prev = process.env;
    process.env = { ...env };
    const handlers = makeHandlers({ store: mockStore() });
    const req = {
      headers: fromCaller(ALICE, { origin: 'https://evil.com' }),
    };
    const res = await handlers.startSession(req);
    expect(res.status).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('ORIGIN_NOT_ALLOWED');
    process.env = prev;
  });

  it('refuses invalid lab ID', async () => {
    const prev = process.env;
    process.env = { ...env };
    const handlers = makeHandlers({ store: mockStore() });
    const req = {
      headers: fromCaller(ALICE, { origin: SITE }),
      json: async () => ({ labId: 'unknown-lab', turnstileToken: TOKEN }),
    };
    const res = await handlers.startSession(req);
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.code).toBe(DOOR_CODES.invalid_lab);
    process.env = prev;
  });

  it('refuses missing Turnstile token', async () => {
    const prev = process.env;
    process.env = { ...env };
    const handlers = makeHandlers({ store: mockStore() });
    const req = {
      headers: fromCaller(ALICE, { origin: SITE }),
      json: async () => ({ labId: 'landing-zone-builder-output' }),
    };
    const res = await handlers.startSession(req);
    expect(res.status).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('TURNSTILE_REQUIRED');
    process.env = prev;
  });

  it('successfully creates visitor session on happy path', async () => {
    const prev = process.env;
    process.env = { ...env };
    const store = mockStore();
    const fetchImpl = vi.fn(async (url, init) => {
      if (typeof url === 'string' && url.startsWith('https://challenges.cloudflare.com/')) {
        return passSiteverify(url, init);
      }
      return coderMocks(url, init);
    });
    const handlers = makeHandlers({
      store,
      fetchImpl,
      clock: () => NOW,
    });
    const req = {
      headers: fromCaller(ALICE, { origin: SITE }),
      json: async () => ({
        labId: 'landing-zone-builder-output',
        turnstileToken: TOKEN,
      }),
    };
    const res = await handlers.startSession(req);
    expect(res.status).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.sessionId).toBeDefined();
    expect(body.accessUrl).toContain('lab-lzb');

    const saved = await store.readDoc('lab_jobs', body.sessionId);
    expect(saved).not.toBeNull();
    expect(saved.type).toBe('visitor-session');
    expect(saved.status).toBe('active');
    expect(saved.ttl).toBe(VISITOR_DOC_TTL_SECONDS);
    process.env = prev;
  });

  it('fails 503 when visitor sessions switch is off', async () => {
    const prev = process.env;
    process.env = { ...env, [VISITOR_SESSION_SWITCH]: 'false' };
    const handlers = makeHandlers({ store: mockStore() });
    const res = await handlers.startSession({ headers: fromCaller(ALICE, { origin: SITE }) });
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).code).toBe(DOOR_CODES.closed);
    process.env = prev;
  });

  it('fails 503 when Turnstile is unconfigured', async () => {
    const prev = process.env;
    process.env = { ...env, TURNSTILE_SECRET_KEY: '' };
    const handlers = makeHandlers({ store: mockStore() });
    const res = await handlers.startSession({ headers: fromCaller(ALICE, { origin: SITE }) });
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).code).toBe(DOOR_CODES.turnstile_unconfigured);
    process.env = prev;
  });

  it('fails 503 when broker config is unconfigured', async () => {
    const prev = process.env;
    process.env = { ...env, CODER_URL: '' };
    const handlers = makeHandlers({ store: mockStore() });
    const res = await handlers.startSession({ headers: fromCaller(ALICE, { origin: SITE }) });
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).code).toBe(DOOR_CODES.unconfigured);
    process.env = prev;
  });

  it('rejects malformed json body with 400', async () => {
    const prev = process.env;
    process.env = { ...env };
    const handlers = makeHandlers({ store: mockStore() });
    const res = await handlers.startSession({
      headers: fromCaller(ALICE, { origin: SITE }),
      json: async () => {
        throw new Error('invalid json');
      },
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe('Malformed JSON body');
    process.env = prev;
  });

  it('rejects failed Turnstile verification with 403 or 503', async () => {
    const prev = process.env;
    process.env = { ...env };
    const failFetch = vi.fn(async (url) => {
      if (typeof url === 'string' && url.startsWith('https://challenges.cloudflare.com/')) {
        return {
          ok: true,
          json: async () => ({
            success: false,
            'error-codes': ['invalid-input-response'],
          }),
        };
      }
      return { ok: true };
    });
    const handlers = makeHandlers({ store: mockStore(), fetchImpl: failFetch });
    const res = await handlers.startSession({
      headers: fromCaller(ALICE, { origin: SITE }),
      json: async () => ({ labId: 'landing-zone-builder-output', turnstileToken: 'bad-token' }),
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).code).toBe('TURNSTILE_FAILED');
    process.env = prev;
  });

  it('enforces client daily rate limit with 429', async () => {
    const prev = process.env;
    process.env = { ...env };
    const store = mockStore();
    await store.createDoc('submission_quota', {
      id: `visitor-quota:${ALICE_KEY}:2026-10-17`,
      kind: 'visitor_session_daily',
      count: 2,
    });
    const fetchImpl = vi.fn(async (url, init) => {
      if (typeof url === 'string' && url.startsWith('https://challenges.cloudflare.com/')) {
        return passSiteverify(url, init);
      }
      return coderMocks(url, init);
    });
    const handlers = makeHandlers({ store, fetchImpl, clock: () => NOW });
    const res = await handlers.startSession({
      headers: fromCaller(ALICE, { origin: SITE }),
      json: async () => ({ labId: 'landing-zone-builder-output', turnstileToken: TOKEN }),
    });
    expect(res.status).toBe(429);
    expect(JSON.parse(res.body).code).toBe(DOOR_CODES.client_rate_limited);
    process.env = prev;
  });

  it('returns existing active session with 200 without creating new one', async () => {
    const prev = process.env;
    process.env = { ...env };
    const existingSession = {
      id: 'sess-already-active',
      type: 'visitor-session',
      status: 'active',
      clientHash: ALICE_KEY,
      labId: 'landing-zone-builder-output',
      accessUrl: 'https://code-server--lab-lzb--v-existing.coder.lab.hybridcloudworks.com',
      expiresAt: new Date(NOW + 100000).toISOString(),
    };
    const store = mockStore([existingSession]);
    const fetchImpl = vi.fn(async (url, init) => {
      if (typeof url === 'string' && url.startsWith('https://challenges.cloudflare.com/')) {
        return passSiteverify(url, init);
      }
      return coderMocks(url, init);
    });
    const handlers = makeHandlers({ store, fetchImpl, clock: () => NOW });
    const res = await handlers.startSession({
      headers: fromCaller(ALICE, { origin: SITE }),
      json: async () => ({ labId: 'landing-zone-builder-output', turnstileToken: TOKEN }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).sessionId).toBe('sess-already-active');
    process.env = prev;
  });

  it('enforces global max concurrency with 503 capacity full', async () => {
    const prev = process.env;
    process.env = { ...env, LABS_VISITOR_MAX_CONCURRENT: '1' };
    const otherSession = {
      id: 'sess-peer',
      type: 'visitor-session',
      status: 'active',
      clientHash: 'peer-hash',
      labId: 'landing-zone-builder-output',
      expiresAt: new Date(NOW + 100000).toISOString(),
    };
    const store = mockStore([otherSession]);
    const fetchImpl = vi.fn(async (url, init) => {
      if (typeof url === 'string' && url.startsWith('https://challenges.cloudflare.com/')) {
        return passSiteverify(url, init);
      }
      return coderMocks(url, init);
    });
    const handlers = makeHandlers({ store, fetchImpl, clock: () => NOW });
    const res = await handlers.startSession({
      headers: fromCaller(ALICE, { origin: SITE }),
      json: async () => ({ labId: 'landing-zone-builder-output', turnstileToken: TOKEN }),
    });
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).code).toBe(DOOR_CODES.capacity_full);
    process.env = prev;
  });

  it('handles Coder provisioning failure with 502', async () => {
    const prev = process.env;
    process.env = { ...env };
    const fetchImpl = vi.fn(async (url, init) => {
      if (typeof url === 'string' && url.startsWith('https://challenges.cloudflare.com/')) {
        return passSiteverify(url, init);
      }
      return { ok: false, status: 502, text: async () => 'bad gateway' };
    });
    const handlers = makeHandlers({ store: mockStore(), fetchImpl, clock: () => NOW });
    const context = { error: vi.fn() };
    const res = await handlers.startSession({
      headers: fromCaller(ALICE, { origin: SITE }),
      json: async () => ({ labId: 'landing-zone-builder-output', turnstileToken: TOKEN }),
    }, context);
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body).code).toBe(DOOR_CODES.coder_unavailable);
    expect(context.error).toHaveBeenCalled();
    process.env = prev;
  });

  it('reaps expired sessions during startSession', async () => {
    const prev = process.env;
    process.env = { ...env };
    const expiredDoc = {
      id: 'sess-exp-start',
      type: 'visitor-session',
      status: 'active',
      clientHash: 'client-expired',
      expiresAt: new Date(NOW - 5000).toISOString(),
    };
    const store = mockStore([expiredDoc]);
    const fetchImpl = vi.fn(async (url, init) => {
      if (typeof url === 'string' && url.startsWith('https://challenges.cloudflare.com/')) {
        return passSiteverify(url, init);
      }
      return coderMocks(url, init);
    });
    const handlers = makeHandlers({ store, fetchImpl, clock: () => NOW });
    const res = await handlers.startSession({
      headers: fromCaller(ALICE, { origin: SITE }),
      json: async () => ({ labId: 'landing-zone-builder-output', turnstileToken: TOKEN }),
    });
    expect(res.status).toBe(201);
    expect(store.get('lab_jobs', 'sess-exp-start')).toMatchObject({
      status: 'expired',
      endedAt: new Date(NOW).toISOString(),
    });
    process.env = prev;
  });

  it('starts the session anyway, and warns without content, when an expired session cannot be saved', async () => {
    const prev = process.env;
    process.env = { ...env };
    const store = mockStore([
      {
        id: 'sess-exp-fail',
        type: 'visitor-session',
        status: 'active',
        clientHash: 'client-expired',
        expiresAt: new Date(NOW - 5000).toISOString(),
      },
    ]);
    store.fail('lab_jobs', 'sess-exp-fail', 'replaceDocIfMatch', Object.assign(new Error('cosmos is down'), { code: 503 }));
    const fetchImpl = vi.fn(async (url, init) => {
      if (typeof url === 'string' && url.startsWith('https://challenges.cloudflare.com/')) {
        return passSiteverify(url, init);
      }
      return coderMocks(url, init);
    });
    const context = { warn: vi.fn(), error: vi.fn() };
    const handlers = makeHandlers({ store, fetchImpl, clock: () => NOW });
    const res = await handlers.startSession(
      {
        headers: fromCaller(ALICE, { origin: SITE }),
        json: async () => ({ labId: 'landing-zone-builder-output', turnstileToken: TOKEN }),
      },
      context
    );
    expect(res.status).toBe(201);
    expect(context.warn).toHaveBeenCalledTimes(1);
    expect(context.warn.mock.calls[0][0]).not.toMatch(/sess-exp-fail|cosmos is down/);
    process.env = prev;
  });
});

describe('createVisitorSessionHandlers: stopSession and reaper', () => {
  const env = {
    [VISITOR_SESSION_SWITCH]: 'true',
    CODER_URL: 'https://coder.lab.hybridcloudworks.com',
    CODER_BROKER_TOKEN: 'broker-token',
  };

  it('stops session and cleans up resources', async () => {
    const prev = process.env;
    process.env = { ...env };
    const doc = {
      id: 'sess-stop',
      type: 'visitor-session',
      status: 'active',
      clientHash: ALICE_KEY,
      coderUserId: 'u-stop',
      workspaceId: 'ws-stop',
      expiresAt: new Date(NOW + 3600000).toISOString(),
    };
    const store = mockStore([doc]);
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    const handlers = makeHandlers({
      store,
      fetchImpl,
      clock: () => NOW,
    });
    const req = {
      url: 'https://api.hybridcloudworks.com/api/public/labs/visitor-session?sessionId=sess-stop',
      headers: fromCaller(ALICE),
    };
    const res = await handlers.stopSession(req);
    expect(res.status).toBe(200);
    const updated = await store.readDoc('lab_jobs', 'sess-stop');
    expect(updated.status).toBe('ended');
    process.env = prev;
  });

  it('refuses stopSession when sessionId parameter is missing', async () => {
    const handlers = makeHandlers({ store: mockStore() });
    const res = await handlers.stopSession({ url: 'https://site.com/api/visitor-session' });
    expect(res.status).toBe(400);
  });

  it('returns 404 when stopping non-existent session', async () => {
    const handlers = makeHandlers({ store: mockStore() });
    const res = await handlers.stopSession({
      url: 'https://site.com/api/visitor-session?sessionId=nonexistent',
      headers: fromCaller(ALICE),
    });
    expect(res.status).toBe(404);
  });

  it('uses upsertDoc when replaceDocIfMatch is not available on stopSession', async () => {
    const doc = {
      id: 'sess-up',
      type: 'visitor-session',
      status: 'active',
      clientHash: ALICE_KEY,
      expiresAt: new Date(NOW + 1000).toISOString(),
    };
    const upsertStore = {
      readDoc: vi.fn(async () => doc),
      upsertDoc: vi.fn(async () => ({})),
    };
    const handlers = makeHandlers({ store: upsertStore, clock: () => NOW });
    const res = await handlers.stopSession({
      url: 'https://site.com/api/visitor-session?sessionId=sess-up',
      headers: fromCaller(ALICE),
    });
    expect(res.status).toBe(200);
    expect(upsertStore.upsertDoc).toHaveBeenCalled();
  });

  it('reaps expired sessions', async () => {
    const expiredDoc = {
      id: 'sess-expired',
      type: 'visitor-session',
      status: 'active',
      coderUserId: 'u-exp',
      workspaceId: 'ws-exp',
      expiresAt: new Date(NOW - 1000).toISOString(),
    };
    const store = mockStore([expiredDoc]);
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    const result = await reapExpiredVisitorSessions(
      store,
      fetchImpl,
      { base: 'https://coder.example.com', token: 'tok' },
      { nowIso: new Date(NOW).toISOString() }
    );
    expect(result.reaped).toBe(1);
    const updated = await store.readDoc('lab_jobs', 'sess-expired');
    expect(updated.status).toBe('expired');
  });

  it('handles reaper errors gracefully when store is missing or query throws', async () => {
    expect(await reapExpiredVisitorSessions(null, vi.fn(), null)).toEqual({ reaped: 0, failed: 0 });
    const brokenStore = {
      queryDocs: vi.fn(async () => {
        throw new Error('db failure');
      }),
    };
    expect(await reapExpiredVisitorSessions(brokenStore, vi.fn(), null)).toEqual({ reaped: 0, failed: 0 });
  });

  it('reaps using upsertDoc when replaceDocIfMatch is omitted', async () => {
    const exp = {
      id: 'sess-upsert-reap',
      type: 'visitor-session',
      status: 'active',
      expiresAt: new Date(NOW - 10000).toISOString(),
    };
    const upsertStore = {
      queryDocs: vi.fn(async () => [exp]),
      upsertDoc: vi.fn(async () => ({})),
    };
    const res = await reapExpiredVisitorSessions(upsertStore, vi.fn(), null, {
      nowIso: new Date(NOW).toISOString(),
    });
    expect(res.reaped).toBe(1);
    expect(upsertStore.upsertDoc).toHaveBeenCalled();
  });
});

/**
 * The saves of a stop and of a reap, checked against the store above (#1383):
 * what is in the record afterwards, which arguments the store was sent, and
 * what happens when another writer gets there first.
 */

const activeSession = (id, overrides = {}) => ({
  id,
  type: 'visitor-session',
  status: 'active',
  clientHash: ALICE_KEY,
  labId: 'landing-zone-builder-output',
  coderUserId: `u-${id}`,
  workspaceId: `ws-${id}`,
  expiresAt: new Date(NOW + 30 * 60 * 1000).toISOString(),
  ttl: 7200,
  ...overrides,
});

const expiredSession = (id) => activeSession(id, { expiresAt: new Date(NOW - 60 * 1000).toISOString() });

const stopRequest = (id, ip = ALICE) => ({
  url: `https://api.hybridcloudworks.com/api/public/labs/visitor-session?sessionId=${id}`,
  headers: fromCaller(ip),
});

const precondition = () => Object.assign(new Error('precondition'), { code: 412 });

/** A Coder that accepts every delete. */
function acceptingCoder() {
  return vi.fn(async () => ({ ok: true }));
}

/** The calls a fetch mock was sent, as "METHOD path" strings. */
const coderCalls = (fetchImpl) =>
  fetchImpl.mock.calls.map(([url, init]) => `${init?.method} ${new URL(url).pathname}`);

/**
 * A Coder whose user delete (the last call of a clean-up) first lets another
 * request change the session record, as a second request or the reaper does
 * in the gap between a stop's read and its write.
 */
function coderThatLetsAnotherWriterIn(store, id, change) {
  return vi.fn(async (url, init) => {
    if (init?.method === 'DELETE') {
      const current = await store.readDoc('lab_jobs', id);
      await store.replaceDocIfMatch('lab_jobs', { ...current, ...change }, { partitionKey: id });
    }
    return { ok: true };
  });
}

describe('visitor sessions against a store that behaves like Cosmos (#1383)', () => {
  const CODER = { base: 'https://coder.lab.hybridcloudworks.com', token: 'broker-token' };

  beforeEach(() => {
    vi.stubEnv(VISITOR_SESSION_SWITCH, 'true');
    vi.stubEnv('CODER_URL', CODER.base);
    vi.stubEnv('CODER_BROKER_TOKEN', CODER.token);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('stopSession', () => {
    it('answers success, deletes the workspace and the user, and saves the record as ended', async () => {
      const store = cosmosLikeStore([activeSession('sess-1')]);
      const fetchImpl = acceptingCoder();
      const handlers = makeHandlers({ store, fetchImpl, clock: () => NOW });

      const res = await handlers.stopSession(stopRequest('sess-1'));

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, status: 'ended' });
      expect(store.get('lab_jobs', 'sess-1')).toMatchObject({
        status: 'ended',
        endedAt: new Date(NOW).toISOString(),
        coderUserId: 'u-sess-1',
        workspaceId: 'ws-sess-1',
        ttl: 7200,
      });
      expect(coderCalls(fetchImpl)).toEqual([
        'POST /api/v2/workspaces/ws-sess-1/builds',
        'DELETE /api/v2/users/u-sess-1',
      ]);
    });

    it('saves the whole document with the version it read, as replaceDocIfMatch(container, document, options)', async () => {
      const store = cosmosLikeStore([activeSession('sess-1')]);
      const readWith = store.get('lab_jobs', 'sess-1')._etag;
      const handlers = makeHandlers({ store, fetchImpl: acceptingCoder(), clock: () => NOW });

      await handlers.stopSession(stopRequest('sess-1'));

      expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(1);
      const [container, document, options] = store.replaceDocIfMatch.mock.calls[0];
      expect(container).toBe('lab_jobs');
      expect(document).toMatchObject({ id: 'sess-1', status: 'ended', _etag: readWith });
      expect(options).toEqual({ partitionKey: 'sess-1' });
    });

    it('answers success again, without calling Coder, when the session is already over', async () => {
      const store = cosmosLikeStore([activeSession('sess-1')]);
      const fetchImpl = acceptingCoder();
      const handlers = makeHandlers({ store, fetchImpl, clock: () => NOW });
      await handlers.stopSession(stopRequest('sess-1'));
      fetchImpl.mockClear();

      const again = await handlers.stopSession(stopRequest('sess-1'));

      expect(again.status).toBe(200);
      expect(JSON.parse(again.body)).toEqual({ ok: true, status: 'ended' });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(store.get('lab_jobs', 'sess-1').status).toBe('ended');
    });

    it('answers success and leaves "expired" alone when the reaper expired it between the read and the write', async () => {
      const store = cosmosLikeStore([activeSession('sess-1')]);
      const reapedAt = new Date(NOW - 1000).toISOString();
      const fetchImpl = coderThatLetsAnotherWriterIn(store, 'sess-1', { status: 'expired', endedAt: reapedAt });
      const handlers = makeHandlers({ store, fetchImpl, clock: () => NOW });

      const res = await handlers.stopSession(stopRequest('sess-1'));

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, status: 'ended' });
      expect(store.get('lab_jobs', 'sess-1')).toMatchObject({ status: 'expired', endedAt: reapedAt });
    });

    it('saves again with the new version when something else changed the record but left it active', async () => {
      const store = cosmosLikeStore([activeSession('sess-1')]);
      const fetchImpl = coderThatLetsAnotherWriterIn(store, 'sess-1', { note: 'written by someone else' });
      const handlers = makeHandlers({ store, fetchImpl, clock: () => NOW });

      const res = await handlers.stopSession(stopRequest('sess-1'));

      expect(res.status).toBe(200);
      expect(store.get('lab_jobs', 'sess-1')).toMatchObject({ status: 'ended', note: 'written by someone else' });
      expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(3); // the other writer, the lost write, the retry
    });

    it('answers 409 and leaves the record active when it keeps changing underneath the stop', async () => {
      const store = cosmosLikeStore([activeSession('sess-1')]);
      store.fail('lab_jobs', 'sess-1', 'replaceDocIfMatch', precondition(), 3);
      const handlers = makeHandlers({ store, fetchImpl: acceptingCoder(), clock: () => NOW });

      const res = await handlers.stopSession(stopRequest('sess-1'));

      expect(res.status).toBe(409);
      expect(JSON.parse(res.body)).toMatchObject({ ok: false });
      expect(store.get('lab_jobs', 'sess-1').status).toBe('active');
    });

    it('lets a store failure that is not a lost race reach the caller', async () => {
      const store = cosmosLikeStore([activeSession('sess-1')]);
      store.fail('lab_jobs', 'sess-1', 'replaceDocIfMatch', Object.assign(new Error('cosmos is down'), { code: 503 }));
      const handlers = makeHandlers({ store, fetchImpl: acceptingCoder(), clock: () => NOW });

      await expect(handlers.stopSession(stopRequest('sess-1'))).rejects.toThrow('cosmos is down');
      expect(store.get('lab_jobs', 'sess-1').status).toBe('active');
    });

    it('answers success to two stop requests made at the same moment, and ends the session once', async () => {
      const store = cosmosLikeStore([activeSession('sess-1')]);
      const handlers = makeHandlers({ store, fetchImpl: acceptingCoder(), clock: () => NOW });

      const [first, second] = await Promise.all([
        handlers.stopSession(stopRequest('sess-1')),
        handlers.stopSession(stopRequest('sess-1')),
      ]);

      expect([first.status, second.status]).toEqual([200, 200]);
      expect(store.get('lab_jobs', 'sess-1')).toMatchObject({ status: 'ended', endedAt: new Date(NOW).toISOString() });
      // Both really tried to save, so one really lost the race and found the record ended.
      expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(2);
    });

    it('answers success when the record has aged out (its ttl) between the read and the write', async () => {
      const store = cosmosLikeStore([activeSession('sess-1')]);
      // Real Cosmos answers a replace of a missing document with 404 (the test store says 412).
      store.fail('lab_jobs', 'sess-1', 'replaceDocIfMatch', Object.assign(new Error('NotFound'), { code: 404 }));
      const fetchImpl = vi.fn(async (url, init) => {
        if (init?.method === 'DELETE') store.docs.delete('lab_jobs/sess-1');
        return { ok: true };
      });
      const handlers = makeHandlers({ store, fetchImpl, clock: () => NOW });

      const res = await handlers.stopSession(stopRequest('sess-1'));

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, status: 'ended' });
    });

    it('still ends the session, and warns without content, when Coder does not accept the clean-up', async () => {
      const store = cosmosLikeStore([activeSession('sess-1')]);
      const fetchImpl = vi.fn(async () => ({ ok: false, status: 500 }));
      const context = { warn: vi.fn() };
      const handlers = makeHandlers({ store, fetchImpl, clock: () => NOW });

      const res = await handlers.stopSession(stopRequest('sess-1'), context);

      expect(res.status).toBe(200);
      expect(store.get('lab_jobs', 'sess-1').status).toBe('ended');
      expect(context.warn).toHaveBeenCalledTimes(1);
      expect(context.warn.mock.calls[0][0]).not.toMatch(/sess-1|ws-sess-1|u-sess-1/);
    });

    it('does not claim to have ended a session when the store cannot save one', async () => {
      const doc = activeSession('sess-1');
      const store = { readDoc: vi.fn(async () => doc) };
      const handlers = makeHandlers({ store, fetchImpl: acceptingCoder(), clock: () => NOW });

      await expect(handlers.stopSession(stopRequest('sess-1'))).rejects.toThrow(TypeError);
    });

    it('still answers 404 for an id that is not a visitor session', async () => {
      const store = cosmosLikeStore([activeSession('job-1', { type: 'terraform-validate' })]);
      const handlers = makeHandlers({ store, fetchImpl: acceptingCoder(), clock: () => NOW });

      expect((await handlers.stopSession(stopRequest('job-1'))).status).toBe(404);
      expect(store.get('lab_jobs', 'job-1').status).toBe('active');
    });
  });

  describe('reapExpiredVisitorSessions', () => {
    const nowIso = new Date(NOW).toISOString();

    it('saves each expired session as expired, deletes its Coder resources, and leaves live ones alone', async () => {
      const store = cosmosLikeStore([expiredSession('old-1'), expiredSession('old-2'), activeSession('live-1')]);
      const fetchImpl = acceptingCoder();

      const result = await reapExpiredVisitorSessions(store, fetchImpl, CODER, { nowIso });

      expect(result).toEqual({ reaped: 2, failed: 0 });
      expect(store.get('lab_jobs', 'old-1')).toMatchObject({ status: 'expired', endedAt: nowIso });
      expect(store.get('lab_jobs', 'old-2')).toMatchObject({ status: 'expired', endedAt: nowIso });
      expect(store.get('lab_jobs', 'live-1').status).toBe('active');
      expect(coderCalls(fetchImpl)).toEqual([
        'POST /api/v2/workspaces/ws-old-1/builds',
        'DELETE /api/v2/users/u-old-1',
        'POST /api/v2/workspaces/ws-old-2/builds',
        'DELETE /api/v2/users/u-old-2',
      ]);
    });

    it('saves the whole document with the version it read, as replaceDocIfMatch(container, document, options)', async () => {
      const store = cosmosLikeStore([expiredSession('old-1')]);
      const readWith = store.get('lab_jobs', 'old-1')._etag;

      await reapExpiredVisitorSessions(store, acceptingCoder(), CODER, { nowIso });

      const [container, document, options] = store.replaceDocIfMatch.mock.calls[0];
      expect(container).toBe('lab_jobs');
      expect(document).toMatchObject({ id: 'old-1', status: 'expired', _etag: readWith });
      expect(options).toEqual({ partitionKey: 'old-1' });
    });

    it('counts a session once when two reapers meet it at the same moment', async () => {
      const store = cosmosLikeStore([expiredSession('old-1')]);

      const [first, second] = await Promise.all([
        reapExpiredVisitorSessions(store, acceptingCoder(), CODER, { nowIso }),
        reapExpiredVisitorSessions(store, acceptingCoder(), CODER, { nowIso }),
      ]);

      expect(first.reaped + second.reaped).toBe(1);
      expect(first.failed + second.failed).toBe(0);
      expect(store.get('lab_jobs', 'old-1')).toMatchObject({ status: 'expired', endedAt: nowIso });
      // Both really tried to save, so one really lost the race and found the record expired.
      expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(2);
    });

    it('does not count a session that a stop ended first, and leaves "ended" alone', async () => {
      const store = cosmosLikeStore([expiredSession('old-1')]);
      const endedAt = new Date(NOW - 5000).toISOString();
      const fetchImpl = coderThatLetsAnotherWriterIn(store, 'old-1', { status: 'ended', endedAt });

      const result = await reapExpiredVisitorSessions(store, fetchImpl, CODER, { nowIso });

      expect(result).toEqual({ reaped: 0, failed: 0 });
      expect(store.get('lab_jobs', 'old-1')).toMatchObject({ status: 'ended', endedAt });
    });

    it('counts and logs a session that keeps changing underneath the reaper, and saves nothing', async () => {
      const store = cosmosLikeStore([expiredSession('old-1')]);
      store.fail('lab_jobs', 'old-1', 'replaceDocIfMatch', precondition(), 3);
      const log = vi.fn();

      const result = await reapExpiredVisitorSessions(store, acceptingCoder(), CODER, { nowIso, log });

      expect(result).toEqual({ reaped: 0, failed: 1 });
      expect(store.get('lab_jobs', 'old-1').status).toBe('active');
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).not.toContain('old-1');
    });

    it('counts and logs a store failure that is not a lost race, then carries on with the next session', async () => {
      const store = cosmosLikeStore([expiredSession('old-1'), expiredSession('old-2')]);
      store.fail('lab_jobs', 'old-1', 'replaceDocIfMatch', Object.assign(new Error('cosmos is down'), { code: 503 }));
      const log = vi.fn();

      const result = await reapExpiredVisitorSessions(store, acceptingCoder(), CODER, { nowIso, log });

      expect(result).toEqual({ reaped: 1, failed: 1 });
      expect(store.get('lab_jobs', 'old-1').status).toBe('active');
      expect(store.get('lab_jobs', 'old-2').status).toBe('expired');
      expect(log).toHaveBeenCalledTimes(1);
      // Content-free: neither the session id nor the error text is in the line.
      expect(log.mock.calls[0][0]).not.toMatch(/old-1|cosmos is down/);
    });

    it('saves the session and logs, without content, when Coder does not accept the clean-up', async () => {
      const store = cosmosLikeStore([expiredSession('old-1')]);
      const log = vi.fn();

      const result = await reapExpiredVisitorSessions(store, vi.fn(async () => ({ ok: false, status: 500 })), CODER, {
        nowIso,
        log,
      });

      expect(result).toEqual({ reaped: 1, failed: 0 });
      expect(store.get('lab_jobs', 'old-1').status).toBe('expired');
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).not.toMatch(/old-1|ws-old-1|u-old-1/);
    });

    it('logs that the sweep could not run, by kind only, when the expired sessions cannot be listed', async () => {
      const store = {
        queryDocs: vi.fn(async () => {
          throw Object.assign(new Error('the account key is abc123'), { code: 503 });
        }),
      };
      const log = vi.fn();

      expect(await reapExpiredVisitorSessions(store, vi.fn(), CODER, { nowIso, log })).toEqual({ reaped: 0, failed: 0 });
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toContain('503');
      expect(log.mock.calls[0][0]).not.toContain('abc123');
    });

    it('logs only a code-like kind: an error whose "code" is free text is reported as a plain error', async () => {
      const store = cosmosLikeStore([expiredSession('old-1')]);
      store.fail('lab_jobs', 'old-1', 'replaceDocIfMatch', Object.assign(new Error('x'), { code: 'the key is abc123 !' }));
      const log = vi.fn();

      await reapExpiredVisitorSessions(store, acceptingCoder(), CODER, { nowIso, log });

      expect(log.mock.calls[0][0]).toMatch(/\(error\)/);
      expect(log.mock.calls[0][0]).not.toContain('abc123');
    });

    it('counts a failure, and saves nothing, when the store has no way to save a session', async () => {
      const store = { queryDocs: vi.fn(async () => [expiredSession('old-1')]) };

      expect(await reapExpiredVisitorSessions(store, acceptingCoder(), CODER, { nowIso })).toEqual({
        reaped: 0,
        failed: 1,
      });
    });
  });
});

/**
 * WHO IS CALLING, against the real client identity helper (#1387).
 *
 * `createClientIdentity()` has `anonymousKey(request)` and
 * `trustedClientIp(request)`; it has never had the `fromRequest` the handlers
 * used to ask for. Every test here builds the real helper (`realIdentity`
 * above) and sends requests the way Cloudflare does, so a call the helper
 * cannot answer fails here instead of in production.
 */
describe('visitor sessions know who is calling (#1387)', () => {
  const CODER = { base: 'https://coder.lab.hybridcloudworks.com', token: 'broker-token' };
  const DAY = '2026-10-17';

  /** Cloudflare's siteverify (recording what it was sent) and a Coder that accepts everything. */
  function visitorFetch() {
    const siteverify = [];
    let users = 0;
    const fetchImpl = vi.fn(async (url, init) => {
      const target = String(url);
      if (target.startsWith('https://challenges.cloudflare.com/')) {
        siteverify.push(new URLSearchParams(init.body));
        return {
          ok: true,
          json: async () => ({ success: true, hostname: 'hybridcloudworks.com', action: 'visitor-session' }),
        };
      }
      if (target.endsWith('/api/v2/templates')) return { ok: true, json: async () => [{ id: 'tmpl-1', name: 'hcw-lab' }] };
      if (target.endsWith('/api/v2/organizations')) return { ok: true, json: async () => [{ id: 'org-1' }] };
      if (target.endsWith('/api/v2/users')) {
        users += 1;
        return { ok: true, json: async () => ({ id: `u-${users}`, username: `v-user${users}` }) };
      }
      if (/\/members\/[^/]+\/workspaces$/.test(target)) {
        return { ok: true, json: async () => ({ id: `ws-${users}`, name: 'lab-lzb' }) };
      }
      return { ok: true };
    });
    return Object.assign(fetchImpl, { siteverify });
  }

  /** The Coder calls that change something (not the reads that start a workspace, and not Turnstile). */
  const coderCallsOf = (fetchImpl) =>
    fetchImpl.mock.calls
      .filter(([url, init]) => String(url).startsWith(CODER.base) && init?.method !== 'GET')
      .map(([url, init]) => `${init.method} ${new URL(url).pathname}`);

  const startAs = (handlers, ip, context) =>
    handlers.startSession(
      {
        headers: fromCaller(ip, { origin: SITE }),
        json: async () => ({ labId: 'landing-zone-builder-output', turnstileToken: TOKEN }),
      },
      context
    );
  const statusAs = (handlers, ip, context) => handlers.getStatus({ headers: fromCaller(ip) }, context);

  /** What the route sent: the status and the parsed body. */
  const parsed = (res) => ({ status: res.status, body: JSON.parse(res.body) });

  beforeEach(() => {
    vi.stubEnv(VISITOR_SESSION_SWITCH, 'true');
    vi.stubEnv('TURNSTILE_SECRET_KEY', 'turnstile-secret');
    vi.stubEnv('CODER_URL', CODER.base);
    vi.stubEnv('CODER_BROKER_TOKEN', CODER.token);
    vi.stubEnv('LABS_VISITOR_MAX_CONCURRENT', '5');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('the identity helper the handlers are given', () => {
    it('is the real one: it answers anonymousKey and trustedClientIp, and has no fromRequest', () => {
      const identity = realIdentity();
      expect(typeof identity.anonymousKey).toBe('function');
      expect(typeof identity.trustedClientIp).toBe('function');
      // The defect, stated directly: the method the handlers used to call.
      expect(identity.fromRequest).toBeUndefined();
    });

    it('refuses, when the handlers are built, a stand-in that has the old fromRequest and nothing else', () => {
      const standIn = { fromRequest: () => ({ anonymousKey: () => 'client-abc' }) };
      expect(() => createVisitorSessionHandlers({ store: mockStore(), identity: standIn })).toThrow(TypeError);
      expect(() => createVisitorSessionHandlers({ store: mockStore(), identity: standIn })).toThrow(
        /anonymousKey or trustedClientIp/
      );
    });

    it('refuses to be built with no identity at all, rather than treating every visitor as one', () => {
      expect(() => createVisitorSessionHandlers({ store: mockStore() })).toThrow(TypeError);
    });

    it('gives two callers on different addresses different keys, and one caller the same key twice', () => {
      expect(ALICE_KEY).toMatch(/^[0-9a-f]{64}$/);
      expect(BOB_KEY).toMatch(/^[0-9a-f]{64}$/);
      expect(ALICE_KEY).not.toBe(BOB_KEY);
      expect(keyOf(ALICE)).toBe(ALICE_KEY);
      expect(ALICE_KEY).not.toBe('unidentified');
    });
  });

  describe('startSession', () => {
    it("files each caller's session and daily quota under that caller's own key, never under 'unidentified'", async () => {
      const store = mockStore();
      const handlers = makeHandlers({ store, fetchImpl: visitorFetch(), clock: () => NOW });

      const alice = parsed(await startAs(handlers, ALICE));
      const bob = parsed(await startAs(handlers, BOB));

      expect([alice.status, bob.status]).toEqual([201, 201]);
      expect(alice.body.sessionId).not.toBe(bob.body.sessionId);
      expect(store.get('lab_jobs', alice.body.sessionId).clientHash).toBe(ALICE_KEY);
      expect(store.get('lab_jobs', bob.body.sessionId).clientHash).toBe(BOB_KEY);
      // One counter each, named for the hash; nothing shared.
      expect(store.get('submission_quota', `visitor-quota:${ALICE_KEY}:${DAY}`)).toMatchObject({ count: 1 });
      expect(store.get('submission_quota', `visitor-quota:${BOB_KEY}:${DAY}`)).toMatchObject({ count: 1 });
      const quotaIds = [...store.docs.keys()].filter((key) => key.startsWith('submission_quota/'));
      expect(quotaIds.some((key) => key.includes('unidentified'))).toBe(false);
      expect(quotaIds).toHaveLength(2);
    });

    it('counts a daily quota per caller: one who has used it is refused and the other is not', async () => {
      const store = mockStore();
      await store.createDoc('submission_quota', {
        id: `visitor-quota:${ALICE_KEY}:${DAY}`,
        kind: 'visitor_session_daily',
        count: 2,
      });
      const fetchImpl = visitorFetch();
      const handlers = makeHandlers({ store, fetchImpl, clock: () => NOW });

      const alice = parsed(await startAs(handlers, ALICE));
      const bob = parsed(await startAs(handlers, BOB));

      expect(alice.status).toBe(429);
      expect(alice.body.code).toBe(DOOR_CODES.client_rate_limited);
      expect(bob.status).toBe(201);
      // Coder was called for Bob only: a user and a workspace, once.
      expect(coderCallsOf(fetchImpl)).toEqual(['POST /api/v2/users', expect.stringMatching(/^POST .*workspaces$/)]);
    });

    it("uses up a caller's two sessions a day through the route, and still serves the other caller", async () => {
      const store = mockStore();
      const handlers = makeHandlers({ store, fetchImpl: visitorFetch(), clock: () => NOW });

      const first = parsed(await startAs(handlers, ALICE));
      const second = parsed(await startAs(handlers, ALICE));
      const third = parsed(await startAs(handlers, ALICE));
      const bob = parsed(await startAs(handlers, BOB));

      expect([first.status, second.status, third.status, bob.status]).toEqual([201, 200, 429, 201]);
      // The second request was Alice's own session handed back, not a new one.
      expect(second.body.sessionId).toBe(first.body.sessionId);
    });

    it("gives Cloudflare's Turnstile the caller's own address, not nothing", async () => {
      const fetchImpl = visitorFetch();
      const handlers = makeHandlers({ store: mockStore(), fetchImpl, clock: () => NOW });

      await startAs(handlers, ALICE);
      await startAs(handlers, BOB);

      expect(fetchImpl.siteverify.map((form) => form.get('remoteip'))).toEqual([ALICE, BOB]);
    });

    it('refuses with 403 before any other work when the request did not come through our Cloudflare', async () => {
      const store = mockStore();
      const fetchImpl = visitorFetch();
      const context = { warn: vi.fn(), error: vi.fn() };
      const handlers = makeHandlers({ store, fetchImpl, clock: () => NOW });
      // Reaches the Function directly with an address of its choosing, and without the origin secret.
      const forged = {
        headers: new Headers({ origin: SITE, 'cf-connecting-ip': '198.51.100.99' }),
        json: async () => ({ labId: 'landing-zone-builder-output', turnstileToken: TOKEN }),
      };

      const refused = parsed(await handlers.startSession(forged, context));

      expect(refused.status).toBe(403);
      expect(refused.body).toEqual({ ok: false, code: 'FORBIDDEN', error: 'Forbidden' });
      expect(fetchImpl).not.toHaveBeenCalled(); // no Turnstile, no Coder
      expect(store.docs.size).toBe(0); // no quota counter, no session
      expect(store.queryDocs).not.toHaveBeenCalled();
      expect(context.warn).toHaveBeenCalledTimes(1);
      expect(context.warn.mock.calls[0][0]).not.toMatch(/198\.51\.100\.99|203\.0\.113/);
    });

    it('refuses a request that presents the wrong origin secret', async () => {
      const store = mockStore();
      const fetchImpl = visitorFetch();
      const handlers = makeHandlers({ store, fetchImpl, clock: () => NOW });
      const wrong = {
        headers: fromCaller(ALICE, { origin: SITE, 'x-hcw-origin-secret': 'not-the-secret' }),
        json: async () => ({ labId: 'landing-zone-builder-output', turnstileToken: TOKEN }),
      };

      expect((await handlers.startSession(wrong)).status).toBe(403);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(store.docs.size).toBe(0);
    });

    it('lets a TypeError from the helper through, rather than answering "Forbidden" for a call that cannot be made', async () => {
      const broken = {
        anonymousKey: () => {
          throw new TypeError('x is not a function');
        },
        trustedClientIp: () => null,
      };
      const handlers = makeHandlers({ identity: broken, store: mockStore(), fetchImpl: visitorFetch(), clock: () => NOW });

      await expect(startAs(handlers, ALICE)).rejects.toThrow(TypeError);
    });
  });

  describe('getStatus', () => {
    it("describes a caller's own session to that caller and to nobody else", async () => {
      const store = mockStore();
      const handlers = makeHandlers({ store, fetchImpl: visitorFetch(), clock: () => NOW });
      const started = parsed(await startAs(handlers, ALICE)).body;

      const alice = parsed(await statusAs(handlers, ALICE));
      const bob = parsed(await statusAs(handlers, BOB));

      expect(alice.body.code).toBe(DOOR_CODES.active_session_exists);
      expect(alice.body.session).toMatchObject({ id: started.sessionId, accessUrl: started.accessUrl });
      expect(bob.body.session).toBeNull();
      expect(bob.body.code).toBe('OPEN');
      // Nothing of Alice's session is anywhere in what Bob was sent.
      const bobsAnswer = JSON.stringify(bob.body);
      expect(bobsAnswer).not.toContain(started.sessionId);
      expect(bobsAnswer).not.toContain(started.accessUrl);
      // Bob can still be told the lab is busy: a count, not a session.
      expect(bob.body.bounds.activeCount).toBe(1);
    });

    it("does not describe a session filed under 'unidentified' (made before this fix) to anyone", async () => {
      const store = mockStore([
        {
          id: 'sess-legacy',
          type: 'visitor-session',
          status: 'active',
          clientHash: 'unidentified',
          labId: 'landing-zone-builder-output',
          accessUrl: 'https://code-server--lab-lzb--v-legacy.coder.lab.hybridcloudworks.com/',
          expiresAt: new Date(NOW + 30 * 60 * 1000).toISOString(),
        },
      ]);
      const handlers = makeHandlers({ store, clock: () => NOW });

      const answer = parsed(await statusAs(handlers, ALICE));

      expect(answer.body.session).toBeNull();
      expect(JSON.stringify(answer.body)).not.toContain('sess-legacy');
    });

    it('refuses with 403, reading nothing, when the request did not come through our Cloudflare', async () => {
      const store = mockStore([activeSession('sess-1')]);
      const context = { warn: vi.fn() };
      const handlers = makeHandlers({ store, clock: () => NOW });

      const answer = parsed(await handlers.getStatus({ headers: new Headers({ 'cf-connecting-ip': ALICE }) }, context));

      expect(answer.status).toBe(403);
      expect(answer.body).toEqual({ ok: false, code: 'FORBIDDEN', error: 'Forbidden' });
      expect(store.queryDocs).not.toHaveBeenCalled();
      expect(JSON.stringify(answer.body)).not.toContain('sess-1');
    });
  });

  describe('stopSession', () => {
    it("does not end another caller's session, even holding its id, and answers as for an id that does not exist", async () => {
      const store = mockStore();
      const fetchImpl = visitorFetch();
      const handlers = makeHandlers({ store, fetchImpl, clock: () => NOW });
      const { sessionId } = parsed(await startAs(handlers, ALICE)).body;
      fetchImpl.mockClear();

      const bobTries = await handlers.stopSession(stopRequest(sessionId, BOB));
      const nobody = await handlers.stopSession(stopRequest('an-id-that-never-existed', BOB));

      expect(bobTries.status).toBe(404);
      // Byte for byte the answer for an id that was never a session: no hint that this one is live.
      expect(bobTries.body).toBe(nobody.body);
      expect(fetchImpl).not.toHaveBeenCalled(); // nothing deleted in Coder
      expect(store.get('lab_jobs', sessionId)).toMatchObject({ status: 'active', clientHash: ALICE_KEY });
      expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
    });

    it('ends the session for the caller it belongs to, after the other caller was turned away', async () => {
      const store = mockStore();
      const fetchImpl = visitorFetch();
      const handlers = makeHandlers({ store, fetchImpl, clock: () => NOW });
      const { sessionId } = parsed(await startAs(handlers, ALICE)).body;
      await handlers.stopSession(stopRequest(sessionId, BOB));
      fetchImpl.mockClear();

      const alice = parsed(await handlers.stopSession(stopRequest(sessionId, ALICE)));

      expect(alice).toEqual({ status: 200, body: { ok: true, status: 'ended' } });
      expect(store.get('lab_jobs', sessionId).status).toBe('ended');
      expect(coderCallsOf(fetchImpl)).toEqual([
        expect.stringMatching(/^POST .*\/builds$/),
        expect.stringMatching(/^DELETE .*\/users\//),
      ]);
    });

    it('keeps two callers apart end to end: each starts, reads and ends only their own session', async () => {
      const store = mockStore();
      const handlers = makeHandlers({ store, fetchImpl: visitorFetch(), clock: () => NOW });
      const alice = parsed(await startAs(handlers, ALICE)).body;
      const bob = parsed(await startAs(handlers, BOB)).body;

      expect(parsed(await statusAs(handlers, ALICE)).body.session.id).toBe(alice.sessionId);
      expect(parsed(await statusAs(handlers, BOB)).body.session.id).toBe(bob.sessionId);
      expect((await handlers.stopSession(stopRequest(alice.sessionId, BOB))).status).toBe(404);
      expect((await handlers.stopSession(stopRequest(bob.sessionId, ALICE))).status).toBe(404);
      expect((await handlers.stopSession(stopRequest(bob.sessionId, BOB))).status).toBe(200);

      expect(store.get('lab_jobs', alice.sessionId).status).toBe('active');
      expect(store.get('lab_jobs', bob.sessionId).status).toBe('ended');
    });

    it("cannot be used to end a session filed under 'unidentified' (made before this fix)", async () => {
      const store = mockStore([activeSession('sess-legacy', { clientHash: 'unidentified' })]);
      const fetchImpl = visitorFetch();
      const handlers = makeHandlers({ store, fetchImpl, clock: () => NOW });

      expect((await handlers.stopSession(stopRequest('sess-legacy', ALICE))).status).toBe(404);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(store.get('lab_jobs', 'sess-legacy').status).toBe('active');
    });

    it('refuses with 403, reading nothing and deleting nothing, when the request did not come through our Cloudflare', async () => {
      const store = mockStore([activeSession('sess-1')]);
      const fetchImpl = visitorFetch();
      const context = { warn: vi.fn() };
      const handlers = makeHandlers({ store, fetchImpl, clock: () => NOW });
      const direct = {
        url: stopRequest('sess-1').url,
        headers: new Headers({ 'cf-connecting-ip': ALICE }),
      };

      const answer = parsed(await handlers.stopSession(direct, context));

      expect(answer.status).toBe(403);
      expect(store.readDoc).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(store.get('lab_jobs', 'sess-1').status).toBe('active');
      expect(context.warn.mock.calls[0][0]).not.toContain('sess-1');
    });
  });

  describe('a caller that cannot be identified', () => {
    // The request proves it came through our Cloudflare (the origin secret is there) but the client
    // address is missing or is not an address. The helper would hash that into one shared "unknown"
    // bucket, which is fine for a rate limit and wrong for who owns a session.
    const noUsableAddress = [
      ['no CF-Connecting-IP header', { 'x-hcw-origin-secret': ORIGIN_SECRET }],
      ['a CF-Connecting-IP that is not an address', { 'x-hcw-origin-secret': ORIGIN_SECRET, 'cf-connecting-ip': 'garbage' }],
      ['a CF-Connecting-IP that is out of range', { 'x-hcw-origin-secret': ORIGIN_SECRET, 'cf-connecting-ip': '999.1.1.1' }],
    ];

    it.each(noUsableAddress)('is refused on all three routes, reading nothing, with %s', async (_name, headers) => {
      const store = mockStore([activeSession('sess-1')]);
      const fetchImpl = visitorFetch();
      const context = { warn: vi.fn() };
      const handlers = makeHandlers({ store, fetchImpl, clock: () => NOW });
      const send = new Headers({ origin: SITE, ...headers });

      const start = await handlers.startSession(
        { headers: send, json: async () => ({ labId: 'landing-zone-builder-output', turnstileToken: TOKEN }) },
        context
      );
      const status = await handlers.getStatus({ headers: send }, context);
      const stop = await handlers.stopSession({ url: stopRequest('sess-1').url, headers: send }, context);

      expect([start.status, status.status, stop.status]).toEqual([403, 403, 403]);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(store.queryDocs).not.toHaveBeenCalled();
      expect(store.readDoc).not.toHaveBeenCalled();
      expect(store.docs.size).toBe(1); // the session it was given, nothing added
      expect(store.get('lab_jobs', 'sess-1').status).toBe('active');
      // Content-free, on every route.
      expect(context.warn).toHaveBeenCalledTimes(3);
      for (const [line] of context.warn.mock.calls) expect(line).not.toMatch(/sess-1|garbage|999|203\.0\.113/);
    });

    it('does not become one visitor: callers without an address cannot read or end a real caller\'s session', async () => {
      const store = mockStore();
      const handlers = makeHandlers({ store, fetchImpl: visitorFetch(), clock: () => NOW });
      const { sessionId, accessUrl } = parsed(await startAs(handlers, ALICE)).body;
      const nobody = new Headers({ 'x-hcw-origin-secret': ORIGIN_SECRET });

      const status = await handlers.getStatus({ headers: nobody });
      const stop = await handlers.stopSession({ url: stopRequest(sessionId).url, headers: nobody });

      expect([status.status, stop.status]).toEqual([403, 403]);
      expect(status.body + stop.body).not.toContain(sessionId);
      expect(status.body + stop.body).not.toContain(accessUrl);
      expect(store.get('lab_jobs', sessionId).status).toBe('active');
    });

    it('is let through in dev, where the helper allows an unverified origin and no address is trusted', async () => {
      const dev = createClientIdentity({ ipSalt: IP_SALT, allowUnverifiedOrigin: true });
      const handlers = makeHandlers({ identity: dev, store: mockStore(), fetchImpl: visitorFetch(), clock: () => NOW });

      expect((await handlers.getStatus({ headers: new Headers() })).status).toBe(200);
    });

    it('lets an error that is not the helper\'s refusal through, instead of answering "Forbidden"', async () => {
      const failing = {
        anonymousKey: () => {
          throw new RangeError('a bug in the helper');
        },
        trustedClientIp: () => null,
      };
      const handlers = makeHandlers({ identity: failing, store: mockStore(), fetchImpl: visitorFetch(), clock: () => NOW });

      await expect(statusAs(handlers, ALICE)).rejects.toThrow(RangeError);
    });
  });

  describe('the stored record and the id are not trusted', () => {
    it('answers 200 with no session, not an error, for a stored hash of multibyte characters as long as a real one', async () => {
      // Sixty-four characters but more than sixty-four bytes: timingSafeEqual throws on unequal byte lengths.
      const odd = activeSession('sess-odd', { clientHash: 'é'.repeat(64) });
      const store = mockStore([odd]);
      const handlers = makeHandlers({ store, clock: () => NOW });

      const status = parsed(await statusAs(handlers, ALICE));
      const stop = await handlers.stopSession(stopRequest('sess-odd', ALICE));

      expect(status.status).toBe(200);
      expect(status.body.session).toBeNull();
      expect(stop.status).toBe(404);
    });

    it('answers 404 to text that cannot be a session id, with the same body and without reading the store', async () => {
      const store = mockStore([activeSession('sess-1')]);
      const handlers = makeHandlers({ store, clock: () => NOW });
      const unknown = await handlers.stopSession(stopRequest('an-id-that-never-existed'));
      store.readDoc.mockClear();

      for (const odd of ['a%2Fb', 'x'.repeat(65), 'a%20b', '..%2F..']) {
        const res = await handlers.stopSession(stopRequest(odd));
        expect(res.status).toBe(404);
        expect(res.body).toBe(unknown.body);
      }
      expect(store.readDoc).not.toHaveBeenCalled();
    });

    it("tells another caller nothing about a session that is already over: 404, as for an id that never existed", async () => {
      const store = mockStore();
      const handlers = makeHandlers({ store, fetchImpl: visitorFetch(), clock: () => NOW });
      const { sessionId } = parsed(await startAs(handlers, ALICE)).body;
      await handlers.stopSession(stopRequest(sessionId, ALICE));
      expect(store.get('lab_jobs', sessionId).status).toBe('ended');

      const bob = await handlers.stopSession(stopRequest(sessionId, BOB));
      const nobody = await handlers.stopSession(stopRequest('an-id-that-never-existed', BOB));
      const alice = await handlers.stopSession(stopRequest(sessionId, ALICE));

      expect(bob.status).toBe(404);
      expect(bob.body).toBe(nobody.body);
      // The owner asking again still gets the quiet success a double click needs.
      expect(alice.status).toBe(200);
    });
  });

  describe('whatever the code calls the identity, it only uses what the real helper has', () => {
    /** The real helper, wrapped so that reading anything it does not have throws. */
    function strictIdentity() {
      const real = realIdentity();
      const reads = [];
      const strict = new Proxy(real, {
        get(target, name) {
          reads.push(String(name));
          if (!(name in target)) throw new TypeError(`the real client identity has no ${String(name)}`);
          return target[name];
        },
      });
      return { strict, reads };
    }

    it('runs a start, a status read and a stop on it, reading only methods the real helper has', async () => {
      const { strict, reads } = strictIdentity();
      const handlers = makeHandlers({ identity: strict, store: mockStore(), fetchImpl: visitorFetch(), clock: () => NOW });

      const started = parsed(await startAs(handlers, ALICE));
      const status = parsed(await statusAs(handlers, ALICE));
      const stopped = parsed(await handlers.stopSession(stopRequest(started.body.sessionId, ALICE)));

      expect([started.status, status.status, stopped.status]).toEqual([201, 200, 200]);
      expect(status.body.session.id).toBe(started.body.sessionId);
      expect(new Set(reads)).toEqual(new Set(['anonymousKey', 'trustedClientIp']));
    });

    it('fails on the same wrapper when the code reaches for a method the helper lacks (the old fromRequest)', () => {
      const { strict } = strictIdentity();
      expect(() => strict.fromRequest).toThrow(/has no fromRequest/);
    });
  });
});
