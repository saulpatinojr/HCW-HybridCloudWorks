import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStore } from '../../../test/memory-store.js';
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
    const handlers = createVisitorSessionHandlers({ store: mockStore() });
    const res = await handlers.getStatus({ headers: new Headers() });
    const body = JSON.parse(res.body);
    expect(body.open).toBe(false);
    expect(body.code).toBe(DOOR_CODES.closed);
    process.env = prev;
  });

  it('reports turnstile_unconfigured when secret missing', async () => {
    const prev = process.env;
    process.env = { ...env, TURNSTILE_SECRET_KEY: '' };
    const handlers = createVisitorSessionHandlers({ store: mockStore() });
    const res = await handlers.getStatus({ headers: new Headers() });
    const body = JSON.parse(res.body);
    expect(body.open).toBe(false);
    expect(body.code).toBe(DOOR_CODES.turnstile_unconfigured);
    process.env = prev;
  });

  it('reports open when available', async () => {
    const prev = process.env;
    process.env = { ...env };
    const handlers = createVisitorSessionHandlers({
      store: mockStore(),
      clock: () => NOW,
    });
    const res = await handlers.getStatus({ headers: new Headers() });
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
      clientHash: 'client-abc',
      labId: 'landing-zone-builder-output',
      accessUrl: 'https://code-server--lab-lzb--v-test.coder.lab.hybridcloudworks.com/?folder=/tmp/home/lab',
      expiresAt: new Date(NOW + 3000000).toISOString(),
    };
    const store = mockStore([activeDoc]);
    const identity = {
      fromRequest: () => ({ anonymousKey: () => 'client-abc' }),
    };
    const handlers = createVisitorSessionHandlers({ store, identity, clock: () => NOW });
    const res = await handlers.getStatus({ headers: new Headers() });
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
    const handlers = createVisitorSessionHandlers({ store, clock: () => NOW });
    const res = await handlers.getStatus({ headers: new Headers() });
    const body = JSON.parse(res.body);
    expect(body.open).toBe(false);
    expect(body.code).toBe(DOOR_CODES.capacity_full);
    process.env = prev;
  });

  it('reports unconfigured when broker config is missing', async () => {
    const prev = process.env;
    process.env = { ...env, CODER_URL: '' };
    const handlers = createVisitorSessionHandlers({ store: mockStore() });
    const res = await handlers.getStatus({ headers: new Headers() });
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
    const handlers = createVisitorSessionHandlers({ store: failingStore });
    const res = await handlers.getStatus({ headers: new Headers() });
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
    const handlers = createVisitorSessionHandlers({
      store,
      fetchImpl,
      clock: () => NOW,
    });
    const res = await handlers.getStatus({ headers: new Headers() });
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
    const handlers = createVisitorSessionHandlers({ store: mockStore() });
    const req = {
      headers: new Headers({ origin: 'https://evil.com' }),
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
    const handlers = createVisitorSessionHandlers({ store: mockStore() });
    const req = {
      headers: new Headers({ origin: SITE }),
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
    const handlers = createVisitorSessionHandlers({ store: mockStore() });
    const req = {
      headers: new Headers({ origin: SITE }),
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
    const handlers = createVisitorSessionHandlers({
      store,
      fetchImpl,
      clock: () => NOW,
    });
    const req = {
      headers: new Headers({ origin: SITE }),
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
    const handlers = createVisitorSessionHandlers({ store: mockStore() });
    const res = await handlers.startSession({ headers: new Headers({ origin: SITE }) });
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).code).toBe(DOOR_CODES.closed);
    process.env = prev;
  });

  it('fails 503 when Turnstile is unconfigured', async () => {
    const prev = process.env;
    process.env = { ...env, TURNSTILE_SECRET_KEY: '' };
    const handlers = createVisitorSessionHandlers({ store: mockStore() });
    const res = await handlers.startSession({ headers: new Headers({ origin: SITE }) });
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).code).toBe(DOOR_CODES.turnstile_unconfigured);
    process.env = prev;
  });

  it('fails 503 when broker config is unconfigured', async () => {
    const prev = process.env;
    process.env = { ...env, CODER_URL: '' };
    const handlers = createVisitorSessionHandlers({ store: mockStore() });
    const res = await handlers.startSession({ headers: new Headers({ origin: SITE }) });
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).code).toBe(DOOR_CODES.unconfigured);
    process.env = prev;
  });

  it('rejects malformed json body with 400', async () => {
    const prev = process.env;
    process.env = { ...env };
    const handlers = createVisitorSessionHandlers({ store: mockStore() });
    const res = await handlers.startSession({
      headers: new Headers({ origin: SITE }),
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
    const handlers = createVisitorSessionHandlers({ store: mockStore(), fetchImpl: failFetch });
    const res = await handlers.startSession({
      headers: new Headers({ origin: SITE }),
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
      id: 'visitor-quota:unidentified:2026-10-17',
      kind: 'visitor_session_daily',
      count: 2,
    });
    const fetchImpl = vi.fn(async (url, init) => {
      if (typeof url === 'string' && url.startsWith('https://challenges.cloudflare.com/')) {
        return passSiteverify(url, init);
      }
      return coderMocks(url, init);
    });
    const handlers = createVisitorSessionHandlers({ store, fetchImpl, clock: () => NOW });
    const res = await handlers.startSession({
      headers: new Headers({ origin: SITE }),
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
      clientHash: 'unidentified',
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
    const handlers = createVisitorSessionHandlers({ store, fetchImpl, clock: () => NOW });
    const res = await handlers.startSession({
      headers: new Headers({ origin: SITE }),
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
    const handlers = createVisitorSessionHandlers({ store, fetchImpl, clock: () => NOW });
    const res = await handlers.startSession({
      headers: new Headers({ origin: SITE }),
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
    const handlers = createVisitorSessionHandlers({ store: mockStore(), fetchImpl, clock: () => NOW });
    const context = { error: vi.fn() };
    const res = await handlers.startSession({
      headers: new Headers({ origin: SITE }),
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
    const handlers = createVisitorSessionHandlers({ store, fetchImpl, clock: () => NOW });
    const res = await handlers.startSession({
      headers: new Headers({ origin: SITE }),
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
    const handlers = createVisitorSessionHandlers({ store, fetchImpl, clock: () => NOW });
    const res = await handlers.startSession(
      {
        headers: new Headers({ origin: SITE }),
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
      coderUserId: 'u-stop',
      workspaceId: 'ws-stop',
      expiresAt: new Date(NOW + 3600000).toISOString(),
    };
    const store = mockStore([doc]);
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    const handlers = createVisitorSessionHandlers({
      store,
      fetchImpl,
      clock: () => NOW,
    });
    const req = {
      url: 'https://api.hybridcloudworks.com/api/public/labs/visitor-session?sessionId=sess-stop',
    };
    const res = await handlers.stopSession(req);
    expect(res.status).toBe(200);
    const updated = await store.readDoc('lab_jobs', 'sess-stop');
    expect(updated.status).toBe('ended');
    process.env = prev;
  });

  it('refuses stopSession when sessionId parameter is missing', async () => {
    const handlers = createVisitorSessionHandlers({ store: mockStore() });
    const res = await handlers.stopSession({ url: 'https://site.com/api/visitor-session' });
    expect(res.status).toBe(400);
  });

  it('returns 404 when stopping non-existent session', async () => {
    const handlers = createVisitorSessionHandlers({ store: mockStore() });
    const res = await handlers.stopSession({ url: 'https://site.com/api/visitor-session?sessionId=nonexistent' });
    expect(res.status).toBe(404);
  });

  it('uses upsertDoc when replaceDocIfMatch is not available on stopSession', async () => {
    const doc = {
      id: 'sess-up',
      type: 'visitor-session',
      status: 'active',
      expiresAt: new Date(NOW + 1000).toISOString(),
    };
    const upsertStore = {
      readDoc: vi.fn(async () => doc),
      upsertDoc: vi.fn(async () => ({})),
    };
    const handlers = createVisitorSessionHandlers({ store: upsertStore, clock: () => NOW });
    const res = await handlers.stopSession({ url: 'https://site.com/api/visitor-session?sessionId=sess-up' });
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
  clientHash: `client-${id}`,
  labId: 'landing-zone-builder-output',
  coderUserId: `u-${id}`,
  workspaceId: `ws-${id}`,
  expiresAt: new Date(NOW + 30 * 60 * 1000).toISOString(),
  ttl: 7200,
  ...overrides,
});

const expiredSession = (id) => activeSession(id, { expiresAt: new Date(NOW - 60 * 1000).toISOString() });

const stopRequest = (id) => ({
  url: `https://api.hybridcloudworks.com/api/public/labs/visitor-session?sessionId=${id}`,
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
      const handlers = createVisitorSessionHandlers({ store, fetchImpl, clock: () => NOW });

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
      const handlers = createVisitorSessionHandlers({ store, fetchImpl: acceptingCoder(), clock: () => NOW });

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
      const handlers = createVisitorSessionHandlers({ store, fetchImpl, clock: () => NOW });
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
      const handlers = createVisitorSessionHandlers({ store, fetchImpl, clock: () => NOW });

      const res = await handlers.stopSession(stopRequest('sess-1'));

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, status: 'ended' });
      expect(store.get('lab_jobs', 'sess-1')).toMatchObject({ status: 'expired', endedAt: reapedAt });
    });

    it('saves again with the new version when something else changed the record but left it active', async () => {
      const store = cosmosLikeStore([activeSession('sess-1')]);
      const fetchImpl = coderThatLetsAnotherWriterIn(store, 'sess-1', { note: 'written by someone else' });
      const handlers = createVisitorSessionHandlers({ store, fetchImpl, clock: () => NOW });

      const res = await handlers.stopSession(stopRequest('sess-1'));

      expect(res.status).toBe(200);
      expect(store.get('lab_jobs', 'sess-1')).toMatchObject({ status: 'ended', note: 'written by someone else' });
      expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(3); // the other writer, the lost write, the retry
    });

    it('answers 409 and leaves the record active when it keeps changing underneath the stop', async () => {
      const store = cosmosLikeStore([activeSession('sess-1')]);
      store.fail('lab_jobs', 'sess-1', 'replaceDocIfMatch', precondition(), 3);
      const handlers = createVisitorSessionHandlers({ store, fetchImpl: acceptingCoder(), clock: () => NOW });

      const res = await handlers.stopSession(stopRequest('sess-1'));

      expect(res.status).toBe(409);
      expect(JSON.parse(res.body)).toMatchObject({ ok: false });
      expect(store.get('lab_jobs', 'sess-1').status).toBe('active');
    });

    it('lets a store failure that is not a lost race reach the caller', async () => {
      const store = cosmosLikeStore([activeSession('sess-1')]);
      store.fail('lab_jobs', 'sess-1', 'replaceDocIfMatch', Object.assign(new Error('cosmos is down'), { code: 503 }));
      const handlers = createVisitorSessionHandlers({ store, fetchImpl: acceptingCoder(), clock: () => NOW });

      await expect(handlers.stopSession(stopRequest('sess-1'))).rejects.toThrow('cosmos is down');
      expect(store.get('lab_jobs', 'sess-1').status).toBe('active');
    });

    it('answers success to two stop requests made at the same moment, and ends the session once', async () => {
      const store = cosmosLikeStore([activeSession('sess-1')]);
      const handlers = createVisitorSessionHandlers({ store, fetchImpl: acceptingCoder(), clock: () => NOW });

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
      const handlers = createVisitorSessionHandlers({ store, fetchImpl, clock: () => NOW });

      const res = await handlers.stopSession(stopRequest('sess-1'));

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, status: 'ended' });
    });

    it('still ends the session, and warns without content, when Coder does not accept the clean-up', async () => {
      const store = cosmosLikeStore([activeSession('sess-1')]);
      const fetchImpl = vi.fn(async () => ({ ok: false, status: 500 }));
      const context = { warn: vi.fn() };
      const handlers = createVisitorSessionHandlers({ store, fetchImpl, clock: () => NOW });

      const res = await handlers.stopSession(stopRequest('sess-1'), context);

      expect(res.status).toBe(200);
      expect(store.get('lab_jobs', 'sess-1').status).toBe('ended');
      expect(context.warn).toHaveBeenCalledTimes(1);
      expect(context.warn.mock.calls[0][0]).not.toMatch(/sess-1|ws-sess-1|u-sess-1/);
    });

    it('does not claim to have ended a session when the store cannot save one', async () => {
      const doc = activeSession('sess-1');
      const store = { readDoc: vi.fn(async () => doc) };
      const handlers = createVisitorSessionHandlers({ store, fetchImpl: acceptingCoder(), clock: () => NOW });

      await expect(handlers.stopSession(stopRequest('sess-1'))).rejects.toThrow(TypeError);
    });

    it('still answers 404 for an id that is not a visitor session', async () => {
      const store = cosmosLikeStore([activeSession('job-1', { type: 'terraform-validate' })]);
      const handlers = createVisitorSessionHandlers({ store, fetchImpl: acceptingCoder(), clock: () => NOW });

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
