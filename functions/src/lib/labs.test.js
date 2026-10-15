/**
 * Labs platform RPCs — pinned to labs-functions.js. Load-bearing: the
 * job-type allowlist + per-type payload byte caps (the enqueue-side
 * containment), the queued-only cancel rule, and the heartbeat staleness
 * math over ISO timestamps.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  AGENT_DOWN_STATUSES,
  AGENT_STALE_AFTER_MS,
  createLabHandlers,
  isAgentOnline,
  LAB_JOB_TYPES,
  JOB_STATUSES,
} from './labs.js';

const context = { log: vi.fn(), error: vi.fn() };

const USER = { oid: 'u1', email: 'editor@hcw.dev' };
const guardAs = (role) => ({ requireRole: vi.fn(async () => ({ user: USER, role, error: null })) });
const denyGuard = {
  requireRole: vi.fn(async () => ({ user: null, role: null, error: { status: 403, body: '{}' } })),
};

const makeRequest = (body) => ({ headers: { get: () => 'vitest' }, json: async () => body ?? {} });

function makeStore(over = {}) {
  return {
    queryDocs: vi.fn(async () => []),
    readDoc: vi.fn(async () => null),
    upsertDoc: vi.fn(async (_c, d) => d),
    patchDoc: vi.fn(async (_c, id, u) => ({ id, ...u })),
    ...over,
  };
}

const NOW = new Date('2026-08-07T05:30:00.000Z');
const fixed = { now: () => NOW, uuid: () => 'fixed-uuid' };

describe('enqueueLabJob', () => {
  it('rejects unknown types and oversized payloads with the source codes', async () => {
    const store = makeStore();
    const h = createLabHandlers({ guard: guardAs('editor'), store, ...fixed });

    const unknown = await h.enqueueLabJob(makeRequest({ type: 'rm-rf' }), context);
    expect(unknown.status).toBe(400);
    expect(JSON.parse(unknown.body).error).toContain('shell-echo');

    const big = await h.enqueueLabJob(
      makeRequest({ type: 'shell-echo', payload: 'x'.repeat(4 * 1024 + 1) }),
      context
    );
    expect(big.status).toBe(413);

    expect(
      (await h.enqueueLabJob(makeRequest({ type: 'shell-echo', payload: 42 }), context)).status
    ).toBe(400);
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('accepts only the payload encodings the type declares, and records the one used (#675)', async () => {
    const store = makeStore();
    const h = createLabHandlers({ guard: guardAs('editor'), store, ...fixed });

    // shell-echo is text-only; helm-template is tar-only; a tar must be base64.
    const tarEcho = await h.enqueueLabJob(
      makeRequest({ type: 'shell-echo', payload: 'AAAA', payloadEncoding: 'tar' }),
      context
    );
    expect(tarEcho.status).toBe(400);
    expect(JSON.parse(tarEcho.body).error).toContain('payloadEncoding must be one of text');

    const textChart = await h.enqueueLabJob(
      makeRequest({ type: 'helm-template', payload: 'apiVersion: v2' }),
      context
    );
    expect(textChart.status).toBe(400);
    expect(JSON.parse(textChart.body).error).toContain('tar');

    const notBase64 = await h.enqueueLabJob(
      makeRequest({ type: 'helm-template', payload: 'not base64!', payloadEncoding: 'tar' }),
      context
    );
    expect(notBase64.status).toBe(400);
    expect(JSON.parse(notBase64.body).error).toContain('base64');
    expect(store.upsertDoc).not.toHaveBeenCalled();

    const chart = await h.enqueueLabJob(
      makeRequest({ type: 'helm-template', payload: 'AAAA\n', payloadEncoding: 'tar' }),
      context
    );
    expect(chart.status).toBe(200);
    expect(store.upsertDoc.mock.calls[0][1]).toMatchObject({
      type: 'helm-template',
      payloadEncoding: 'tar',
    });

    // Omitted means text, which is what every pre-#675 caller sends.
    const plain = await h.enqueueLabJob(
      makeRequest({ type: 'kubeconform', payload: 'kind: Pod' }),
      context
    );
    expect(plain.status).toBe(200);
    expect(store.upsertDoc.mock.calls[1][1]).toMatchObject({
      type: 'kubeconform',
      payloadEncoding: 'text',
    });
  });

  it('every job type names its encodings, and the five #675 types are all present', () => {
    expect(Object.keys(LAB_JOB_TYPES).sort()).toEqual([
      'ansible-check',
      'helm-template',
      'kubeconform',
      'shell-echo',
      'terraform-validate',
    ]);
    for (const [type, spec] of Object.entries(LAB_JOB_TYPES)) {
      expect(spec.payloadEncodings.length, type).toBeGreaterThan(0);
      expect(spec.maxPayloadBytes, type).toBeLessThanOrEqual(64 * 1024);
    }
  });

  it('queues a valid job with the source doc shape', async () => {
    const store = makeStore();
    const h = createLabHandlers({ guard: guardAs('editor'), store, ...fixed });
    const res = await h.enqueueLabJob(
      makeRequest({ type: 'terraform-validate', payload: 'resource {}' }),
      context
    );
    expect(JSON.parse(res.body)).toEqual({
      jobId: 'fixed-uuid',
      type: 'terraform-validate',
      status: 'queued',
    });
    expect(store.upsertDoc.mock.calls[0][1]).toMatchObject({
      id: 'fixed-uuid',
      status: 'queued',
      requestedBy: 'u1',
      requestedByEmail: 'editor@hcw.dev',
      agentId: null,
      exitCode: null,
    });
  });
});

describe('isAgentOnline', () => {
  const nowMs = Date.parse('2026-10-08T04:30:00.000Z');
  const ago = (ms) => new Date(nowMs - ms).toISOString();

  it('is fresh AND not saying goodbye: the offline heartbeat writes lastSeenAt too (#1009)', () => {
    expect(isAgentOnline({ status: 'idle', lastSeenAt: ago(1_000) }, nowMs)).toBe(true);
    expect(isAgentOnline({ status: 'busy', lastSeenAt: ago(1_000) }, nowMs)).toBe(true);
    expect(isAgentOnline({ lastSeenAt: ago(1_000) }, nowMs)).toBe(true);
    for (const status of AGENT_DOWN_STATUSES) {
      expect(isAgentOnline({ status, lastSeenAt: ago(1_000) }, nowMs)).toBe(false);
    }
    expect(AGENT_DOWN_STATUSES).toEqual(['stopping', 'offline']);
  });

  it('is offline once deactivated, however fresh the last heartbeat (review of #1018)', () => {
    expect(isAgentOnline({ active: false, status: 'idle', lastSeenAt: ago(1_000) }, nowMs)).toBe(false);
    expect(isAgentOnline({ active: true, status: 'idle', lastSeenAt: ago(1_000) }, nowMs)).toBe(true);
  });

  it('is offline from three missed heartbeats, and for a record with no heartbeat at all', () => {
    expect(isAgentOnline({ status: 'idle', lastSeenAt: ago(AGENT_STALE_AFTER_MS - 1) }, nowMs)).toBe(true);
    expect(isAgentOnline({ status: 'idle', lastSeenAt: ago(AGENT_STALE_AFTER_MS) }, nowMs)).toBe(false);
    expect(isAgentOnline({ status: 'idle' }, nowMs)).toBe(false);
    expect(isAgentOnline(null, nowMs)).toBe(false);
    // The old signature passed the timestamp alone; that now reads as no
    // agent, which fails closed rather than open.
    expect(isAgentOnline(ago(1_000), nowMs)).toBe(false);
  });
});

describe('getLabsSnapshot', () => {
  it('computes agent online state from ISO heartbeats and sorts jobs desc', async () => {
    const store = makeStore({
      queryDocs: vi.fn(async (container, query) => {
        if (query.includes('VALUE COUNT')) return [3];
        if (container === 'lab_agents') {
          return [
            {
              id: 'fresh',
              lastSeenAt: new Date(NOW.getTime() - 30_000).toISOString(),
              capabilities: ['shell-echo'],
            },
            { id: 'stale', lastSeenAt: new Date(NOW.getTime() - 120_000).toISOString() },
            { id: 'never' },
            // Fresh, but the heartbeat said goodbye (#1009).
            { id: 'stopped', status: 'offline', lastSeenAt: new Date(NOW.getTime() - 5_000).toISOString() },
            { id: 'stopping', status: 'stopping', lastSeenAt: new Date(NOW.getTime() - 5_000).toISOString() },
          ];
        }
        return [
          { id: 'old', createdAt: '2026-08-07T04:00:00Z', type: 'shell-echo', status: 'succeeded' },
          { id: 'new', createdAt: '2026-08-07T05:00:00Z', type: 'ansible-check', status: 'queued' },
        ];
      }),
    });
    const h = createLabHandlers({ guard: guardAs('viewer'), store, ...fixed });
    const body = JSON.parse((await h.getLabsSnapshot(makeRequest({}), context)).body);

    const online = Object.fromEntries(body.agents.map((a) => [a.agentId, a.online]));
    expect(online).toEqual({ fresh: true, stale: false, never: false, stopped: false, stopping: false });
    expect(body.jobs.map((j) => j.id)).toEqual(['new', 'old']);
    expect(body.queueDepth).toBe(3);
    expect(body.jobTypes.map((t) => t.type)).toEqual(Object.keys(LAB_JOB_TYPES));
    expect(body.statuses).toEqual(JOB_STATUSES);
    // Newest first in the query itself, so TOP 100 is the newest 100 of the
    // container and not an arbitrary 100 sorted afterwards (ADR 0033).
    const jobsQuery = store.queryDocs.mock.calls.find(
      ([container, sql]) => container === 'lab_jobs' && !sql.includes('VALUE COUNT')
    )[1];
    expect(jobsQuery).toMatch(/ORDER BY c\.createdAt DESC/);
  });

  // CodeRabbit on #1200: this module's own errorResponse handed the caught
  // error object to context.error, which logged its message.
  it('logs a failed snapshot through the door: one content-free line, never the error text', async () => {
    const store = makeStore({
      queryDocs: vi.fn(async () => {
        throw Object.assign(new Error('cosmos said: account hcw-secret-name refused'), { code: 'ServiceUnavailable' });
      }),
    });
    const ctx = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), invocationId: 'inv-labs-1' };
    const h = createLabHandlers({ guard: guardAs('viewer'), store, ...fixed });
    const res = await h.getLabsSnapshot(makeRequest({}), ctx);
    expect(res.status).toBe(500);
    expect(res.body).not.toContain('hcw-secret-name');
    const logged = [...ctx.error.mock.calls, ...ctx.warn.mock.calls];
    expect(logged.length).toBeGreaterThan(0);
    for (const args of logged) {
      expect(args).toHaveLength(1);
      expect(typeof args[0]).toBe('string');
      expect(args[0]).not.toContain('hcw-secret-name');
    }
    expect(logged.some(([line]) => line.includes('code=ServiceUnavailable'))).toBe(true);
  });

  it('knows no running status: the agent writes claimed, then a terminal one', () => {
    expect(JOB_STATUSES).toEqual([
      'queued',
      'claimed',
      'succeeded',
      'failed',
      'timeout',
      'cancelled',
    ]);
  });

  it('carries the registry half of each agent: active, its object id, when it was registered (#740)', async () => {
    const store = makeStore({
      queryDocs: vi.fn(async (container, query) => {
        if (query.includes('VALUE COUNT')) return [0];
        if (container === 'lab_agents') {
          return [
            {
              id: 'vps-hostinger-01',
              oid: '9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b',
              active: true,
              registeredAt: '2026-09-27T12:00:00.000Z',
            },
            // Anything but a literal true is not active: the guard reads it so.
            { id: 'revoked', oid: '12345678-90ab-4cde-8f01-23456789abcd', active: 'true' },
            { id: 'legacy' },
          ];
        }
        return [];
      }),
    });
    const h = createLabHandlers({ guard: guardAs('viewer'), store, ...fixed });
    const { agents } = JSON.parse((await h.getLabsSnapshot(makeRequest({}), context)).body);

    expect(
      agents.map(({ agentId, active, oid, registeredAt }) => ({
        agentId,
        active,
        oid,
        registeredAt,
      }))
    ).toEqual([
      {
        agentId: 'vps-hostinger-01',
        active: true,
        oid: '9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b',
        registeredAt: '2026-09-27T12:00:00.000Z',
      },
      {
        agentId: 'revoked',
        active: false,
        oid: '12345678-90ab-4cde-8f01-23456789abcd',
        registeredAt: null,
      },
      { agentId: 'legacy', active: false, oid: null, registeredAt: null },
    ]);
  });

  it('carries each host’s applied commit, its drift verdict, and the lab checks by probe id (#1009)', async () => {
    const applied = {
      commit: 'a'.repeat(40),
      committedAt: '2026-08-05T05:00:00.000Z',
      appliedAt: '2026-08-06T05:00:00.000Z',
    };
    const docs = {
      // main read an hour ago: one lab-host change two days after the applied commit.
      lab_drift: {
        id: 'lab_drift',
        since: applied.committedAt,
        lastSuccessAt: '2026-08-07T04:30:00.000Z',
        hostCommits: [{ sha: 'b'.repeat(40), committedAt: '2026-08-06T00:00:00.000Z', title: 'LAB-5' }],
      },
    };
    const store = makeStore({
      readDoc: vi.fn(async (_c, id) => docs[id] ?? null),
      queryDocs: vi.fn(async (container, query) => {
        if (query.includes('VALUE COUNT')) return [0];
        if (container === 'lab_agents') {
          return [
            { id: 'behind', active: true, applied },
            { id: 'silent', active: true },
          ];
        }
        return [];
      }),
    });
    const h = createLabHandlers({ guard: guardAs('viewer'), store, ...fixed });
    const body = JSON.parse((await h.getLabsSnapshot(makeRequest({}), context)).body);

    const [behind, silent] = body.agents;
    expect(behind.applied).toEqual(applied);
    expect(behind.drift.status).toBe('critical');
    expect(behind.drift.summary).toMatch(/^behind is behind main: 1 change/);
    expect(silent.applied).toBeNull();
    expect(silent.drift.summary).toMatch(/has not reported the commit it converged from/);
    expect(Object.keys(body.checks).sort()).toEqual(['coder-template', 'coder-token', 'lab-canary', 'lab-drift']);
    expect(body.checks['lab-drift'].status).toBe('critical');
    expect(body.checks['lab-drift']).not.toHaveProperty('agents');
    expect(body.checks['coder-template'].status).toBe('unknown');
  });

  it('still answers when the lab checks cannot be read, with each check unknown', async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => {
        throw new Error('Cosmos said 503');
      }),
      queryDocs: vi.fn(async (container, query) => {
        if (query.includes('VALUE COUNT')) return [0];
        return container === 'lab_agents' ? [{ id: 'vps-1', active: true }] : [];
      }),
    });
    const h = createLabHandlers({ guard: guardAs('viewer'), store, ...fixed });
    const res = await h.getLabsSnapshot(makeRequest({}), context);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.checks['lab-drift'].status).toBe('unknown');
    expect(body.checks['coder-template'].status).toBe('unknown');
    expect(body.agents[0].drift).toBeNull();
  });

  it('answers without the checks, and a content-free warning, when they cannot be loaded at all', async () => {
    const warn = vi.fn();
    const store = makeStore({
      queryDocs: vi.fn(async (container, query) => {
        if (query.includes('VALUE COUNT')) return [0];
        return container === 'lab_agents' ? [{ id: 'vps-1', active: true }] : [];
      }),
    });
    const readChecks = vi.fn(async () => {
      throw Object.assign(new Error('module vps-1 failed'), { code: 'ERR_MODULE_NOT_FOUND' });
    });
    const h = createLabHandlers({ guard: guardAs('viewer'), store, ...fixed, readChecks });
    const res = await h.getLabsSnapshot(makeRequest({}), { ...context, warn });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).checks).toEqual({});
    expect(warn).toHaveBeenCalledWith('getLabsSnapshot: the lab checks could not be read (ERR_MODULE_NOT_FOUND)');
  });

  it('keeps the checks out of this module’s static imports, which the browser-side tests load', () => {
    // health/pulse-checks.js imports this module for the online rule, and the
    // frontend's statusParity.test.js imports pulse-checks.js under jsdom; the
    // checks bring the Cosmos and Key Vault clients, which cannot load there.
    // The door (http/error-response.js, for the correlation id, #945) imports
    // node:crypto and nothing else, which the second expectation holds.
    const source = readFileSync(new URL('./labs.js', import.meta.url), 'utf8');
    const staticImports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(staticImports).toEqual(['node:crypto', './http/error-response.js']);
    const door = readFileSync(new URL('./http/error-response.js', import.meta.url), 'utf8');
    expect([...door.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1])).toEqual(['node:crypto']);
  });
});

describe('cancelLabJob', () => {
  it('cancels only queued jobs; 404 missing, 409 otherwise', async () => {
    const h404 = createLabHandlers({ guard: guardAs('editor'), store: makeStore(), ...fixed });
    expect((await h404.cancelLabJob(makeRequest({ jobId: 'x' }), context)).status).toBe(404);

    const claimed = makeStore({ readDoc: vi.fn(async () => ({ id: 'j1', status: 'claimed' })) });
    const h409 = createLabHandlers({ guard: guardAs('editor'), store: claimed, ...fixed });
    expect((await h409.cancelLabJob(makeRequest({ jobId: 'j1' }), context)).status).toBe(409);
    expect(claimed.patchDoc).not.toHaveBeenCalled();

    const queued = makeStore({ readDoc: vi.fn(async () => ({ id: 'j1', status: 'queued' })) });
    const h = createLabHandlers({ guard: guardAs('editor'), store: queued, ...fixed });
    const res = await h.cancelLabJob(makeRequest({ jobId: 'j1' }), context);
    expect(JSON.parse(res.body)).toEqual({ jobId: 'j1', status: 'cancelled' });
    expect(queued.patchDoc.mock.calls[0][2]).toMatchObject({
      status: 'cancelled',
      cancelledBy: 'u1',
      finishedAt: NOW.toISOString(),
    });
  });
});

describe('auth', () => {
  it('every handler denies with zero store calls', async () => {
    const store = makeStore();
    const h = createLabHandlers({ guard: denyGuard, store, ...fixed });
    for (const call of [
      h.enqueueLabJob(makeRequest({ type: 'shell-echo', payload: '' }), context),
      h.getLabsSnapshot(makeRequest({}), context),
      h.cancelLabJob(makeRequest({ jobId: 'j' }), context),
    ]) {
      expect((await call).status).toBe(403);
    }
    expect(store.queryDocs).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });
});

describe('getLabJob', () => {
  const makeStore = (over = {}) => ({
    queryDocs: vi.fn(async () => []),
    readDoc: vi.fn(async () => null),
    upsertDoc: vi.fn(),
    patchDoc: vi.fn(),
    ...over,
  });

  it('returns the job with its output for a viewer', async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => ({
        id: 'job-1',
        type: 'shell-echo',
        status: 'succeeded',
        output: 'hello',
        exitCode: 0,
        payload: 'SECRETISH',
        createdAt: '2026-08-01T00:00:00Z',
      })),
    });
    const h = createLabHandlers({ guard: guardAs('viewer'), store, ...fixed });
    const res = await h.getLabJob(
      { method: 'GET', query: { get: (k) => (k === 'jobId' ? 'job-1' : null) } },
      context
    );
    const body = JSON.parse(res.body);
    expect(body.job.output).toBe('hello');
    expect(body.job.status).toBe('succeeded');
    // Projection only — the raw payload is not echoed back.
    expect(body.job).not.toHaveProperty('payload');
  });

  it('denial makes zero store calls; missing job 404s', async () => {
    const store = makeStore();
    const denied = createLabHandlers({ guard: denyGuard, store, ...fixed });
    const res = await denied.getLabJob({ method: 'GET', query: { get: () => 'job-1' } }, context);
    expect(res.status).toBe(403);
    expect(store.readDoc).not.toHaveBeenCalled();

    const h = createLabHandlers({ guard: guardAs('viewer'), store, ...fixed });
    const miss = await h.getLabJob(
      { method: 'GET', query: { get: (k) => (k === 'jobId' ? 'nope' : null) } },
      context
    );
    expect(miss.status).toBe(404);
  });
});
