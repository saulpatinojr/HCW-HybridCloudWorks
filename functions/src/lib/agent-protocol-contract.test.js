/**
 * agent-protocol-contract.test.js — Cross-boundary contract tests for Functions Agent API (QA-3 #978).
 *
 * Verifies that functions/src/lib/lab-agent.js strictly satisfies the shared JSON contract fixture
 * in .azure/agent-protocol.json. Renaming or omitting any contract field on either
 * the functions or client side fails this suite.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';

import { createLabAgentHandlers } from './lab-agent.js';

const CONTRACT_PATH = new URL('../../../.azure/agent-protocol.json', import.meta.url);
const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));

// Set NOW after the contract fixture sample timestamps so parseAppliedRecord and checkedAt don't look like future skew
const NOW = new Date('2026-10-10T05:00:00.000Z');
const context = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

const allowGuard = (agent = {}) => ({
  requireAgent: vi.fn(async (_request, agentId) => ({
    agent: {
      agentId: agentId || 'vps-hostinger-01',
      active: true,
      capabilities: ['shell-echo'],
      ...agent,
    },
    identity: { oid: 'oid-vps-01' },
    error: null,
  })),
});

const req = (body) => ({ json: async () => body });
const parse = (res) => JSON.parse(res.body);

function makeConfigStore(initial = {}) {
  const docs = new Map(Object.entries(initial));
  let etag = 0;
  const stamp = (doc) => ({ ...doc, _etag: `"e${++etag}"` });
  for (const [id, doc] of docs) docs.set(id, stamp(doc));
  return {
    readDoc: vi.fn(async (_container, id) => (docs.has(id) ? structuredClone(docs.get(id)) : null)),
    createDoc: vi.fn(async (_container, doc) => {
      docs.set(doc.id, stamp(doc));
      return docs.get(doc.id);
    }),
    replaceDocIfMatch: vi.fn(async (_container, doc) => {
      docs.set(doc.id, stamp(doc));
      return docs.get(doc.id);
    }),
    upsertDoc: vi.fn(async (_container, doc) => {
      docs.set(doc.id, stamp(doc));
      return doc;
    }),
    queryDocs: vi.fn(async () => []),
    patchDoc: vi.fn(async () => ({})),
  };
}

describe('agent protocol contract (QA-3 #978): functions API', () => {
  it('contract fixture defines all five required agent RPCs', () => {
    // reportHostCheck joined on 2026-10-19 (#1282).
    const expectedRpcs = ['claimLabJob', 'heartbeat', 'completeLabJob', 'reportCoderAutomation', 'reportHostCheck'];
    expect(Object.keys(contract.rpcs).sort()).toEqual(expectedRpcs.sort());
  });

  describe('claimLabJob contract', () => {
    const rpc = contract.rpcs.claimLabJob;

    it('returns sampleWithJob shape when candidate is claimed', async () => {
      const sampleJob = {
        id: 'job-101',
        type: 'shell-echo',
        payload: 'echo test',
        status: 'queued',
        createdAt: '2026-10-09T03:00:00.000Z',
        _etag: '"etag1"',
      };
      const store = {
        queryDocs: vi.fn(async () => [sampleJob]),
        replaceDocIfMatch: vi.fn(async (c, doc) => doc),
      };
      const handlers = createLabAgentHandlers({
        guard: allowGuard(),
        store,
        now: () => NOW,
        uuid: () => 'claim-202',
      });

      const res = await handlers.claimLabJob(req(rpc.request.sample), context);
      expect(res.status).toBe(200);

      const body = parse(res);
      // Verify response top-level required fields
      for (const field of rpc.response.success.requiredFields) {
        expect(body).toHaveProperty(field);
      }
      expect(body.ok).toBe(true);
      expect(body.job).not.toBeNull();

      // Verify job required fields
      for (const field of rpc.response.success.jobFields.requiredFields) {
        expect(body.job).toHaveProperty(field);
      }
      expect(body.job.id).toBe('job-101');
      expect(body.job.claimId).toBe('claim-202');
      expect(body.job.type).toBe('shell-echo');
      expect(body.job.payload).toBe('echo test');
      expect(body.job.payloadEncoding).toBe('text');
    });

    it('returns sampleNoJob shape when no candidates exist', async () => {
      const store = { queryDocs: vi.fn(async () => []) };
      const handlers = createLabAgentHandlers({
        guard: allowGuard(),
        store,
        now: () => NOW,
      });

      const res = await handlers.claimLabJob(req(rpc.request.sample), context);
      expect(res.status).toBe(200);

      const body = parse(res);
      expect(body).toEqual(rpc.response.success.sampleNoJob);
    });
  });

  describe('heartbeat contract', () => {
    const rpc = contract.rpcs.heartbeat;

    it('accepts sampleMinimal and returns contract response', async () => {
      const store = { patchDoc: vi.fn(async () => ({})) };
      const handlers = createLabAgentHandlers({
        guard: allowGuard(),
        store,
        now: () => NOW,
      });

      const sample = rpc.request.sampleMinimal;
      const res = await handlers.heartbeatAgent(req(sample), context);
      expect(res.status).toBe(200);

      const body = parse(res);
      for (const field of rpc.response.success.requiredFields) {
        expect(body).toHaveProperty(field);
      }
      expect(body).toEqual(rpc.response.success.sample);

      expect(store.patchDoc).toHaveBeenCalledWith(
        'lab_agents',
        sample.agentId,
        expect.objectContaining({
          status: sample.status,
          activeJobs: sample.activeJobs,
          hostname: sample.hostname,
          version: sample.version,
        }),
        { partitionKey: sample.agentId }
      );
    });

    it('accepts sampleFull with applied commit record and certificate expiry', async () => {
      const store = { patchDoc: vi.fn(async () => ({})) };
      const handlers = createLabAgentHandlers({
        guard: allowGuard(),
        store,
        now: () => NOW,
      });

      const sample = rpc.request.sampleFull;
      const res = await handlers.heartbeatAgent(req(sample), context);
      expect(res.status).toBe(200);

      const body = parse(res);
      expect(body).toEqual(rpc.response.success.sample);

      expect(store.patchDoc).toHaveBeenCalledWith(
        'lab_agents',
        sample.agentId,
        expect.objectContaining({
          applied: expect.objectContaining({
            commit: sample.applied.commit,
            committedAt: expect.any(String),
            appliedAt: expect.any(String),
          }),
          certificateExpiresAt: sample.certificateExpiresAt,
        }),
        { partitionKey: sample.agentId }
      );
    });

    it('accepts all contract valid statuses', async () => {
      for (const status of rpc.request.validStatuses) {
        const store = { patchDoc: vi.fn(async () => ({})) };
        const handlers = createLabAgentHandlers({
          guard: allowGuard(),
          store,
          now: () => NOW,
        });

        const res = await handlers.heartbeatAgent(
          req({ agentId: 'vps-hostinger-01', status, activeJobs: 0, hostname: 'h', version: '2.0.0' }),
          context
        );
        expect(res.status).toBe(200);
      }
    });
  });

  describe('completeLabJob contract', () => {
    const rpc = contract.rpcs.completeLabJob;

    it('accepts sample request and returns contract success response', async () => {
      const sample = rpc.request.sample;
      const heldJob = {
        id: sample.jobId,
        agentId: sample.agentId,
        claimId: sample.claimId,
        status: 'claimed',
        _etag: '"etag-held"',
      };
      const store = {
        readDoc: vi.fn(async () => heldJob),
        replaceDocIfMatch: vi.fn(async (c, doc) => doc),
      };
      const handlers = createLabAgentHandlers({
        guard: allowGuard(),
        store,
        now: () => NOW,
      });

      const res = await handlers.completeLabJob(req(sample), context);
      expect(res.status).toBe(200);

      const body = parse(res);
      for (const field of rpc.response.success.requiredFields) {
        expect(body).toHaveProperty(field);
      }
      expect(body).toEqual(rpc.response.success.sample);

      expect(store.replaceDocIfMatch).toHaveBeenCalledWith(
        'lab_jobs',
        expect.objectContaining({
          status: sample.status,
          exitCode: sample.exitCode,
          output: sample.output,
        }),
        { partitionKey: sample.jobId }
      );
    });

    it('accepts all contract valid statuses', async () => {
      for (const status of rpc.request.validStatuses) {
        const heldJob = {
          id: 'job-101',
          agentId: 'vps-hostinger-01',
          status: 'claimed',
        };
        const store = {
          readDoc: vi.fn(async () => heldJob),
          replaceDocIfMatch: vi.fn(async (c, doc) => doc),
        };
        const handlers = createLabAgentHandlers({
          guard: allowGuard(),
          store,
          now: () => NOW,
        });

        const res = await handlers.completeLabJob(
          req({ agentId: 'vps-hostinger-01', jobId: 'job-101', status, exitCode: 0, output: 'ok' }),
          context
        );
        expect(res.status).toBe(200);
      }
    });

    it('refuses request missing required contract field jobId', async () => {
      const handlers = createLabAgentHandlers({
        guard: allowGuard(),
        store: {},
        now: () => NOW,
      });

      const res = await handlers.completeLabJob(
        req({ agentId: 'vps-hostinger-01', status: 'succeeded', exitCode: 0, output: 'ok' }),
        context
      );
      expect(res.status).toBe(400);
      expect(parse(res).error).toMatch(/jobId is required/);
    });
  });

  describe('reportCoderAutomation contract', () => {
    const rpc = contract.rpcs.reportCoderAutomation;

    it('accepts report and token, returning contract success response with stored: true', async () => {
      const store = makeConfigStore();
      const coderEnv = { CODER_URL: 'https://coder.lab.example', KEY_VAULT_URI: 'https://kv.example/' };
      const runningUrl = 'https://coder.lab.example/api/v2/workspaces?q=status%3Arunning';
      const meUrl = 'https://coder.lab.example/api/v2/users/me';
      const keyUrl = `https://coder.lab.example/api/v2/users/me/keys/${rpc.request.sample.statusToken.split('-')[0]}`;
      const readScopes = ['template:read', 'workspace:read', 'api_key:read', 'user:read'];

      const fetchImpl = vi.fn(async (url) => {
        if (url === runningUrl) return { ok: true, status: 200, json: async () => ({ count: 1 }) };
        if (url === meUrl) return { ok: true, status: 200, json: async () => ({ username: 'hcw-status' }) };
        if (url === keyUrl) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: rpc.request.sample.statusToken.split('-')[0],
              scopes: readScopes,
              expires_at: '2027-11-30T00:00:00.123456789Z',
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      });

      const vault = {
        setVaultSecret: vi.fn(async () => ({ version: 'v1' })),
        refreshKeyVaultReferences: vi.fn(async () => ({ refreshed: true, reason: null })),
      };

      const handlers = createLabAgentHandlers({
        guard: allowGuard(),
        store,
        now: () => NOW,
        coderAutomation: { env: coderEnv, fetchImpl, vault, uuid: () => 'audit-1' },
      });

      const res = await handlers.reportCoderAutomation(req(rpc.request.sample), context);
      expect(res.status).toBe(200);

      const body = parse(res);
      for (const field of rpc.response.success.requiredFields) {
        expect(body).toHaveProperty(field);
      }
      expect(body).toEqual(rpc.response.success.sample);
    });

    it('accepts report without statusToken, returning stored: false', async () => {
      const store = makeConfigStore();
      const handlers = createLabAgentHandlers({
        guard: allowGuard(),
        store,
        now: () => NOW,
        coderAutomation: {},
      });

      const res = await handlers.reportCoderAutomation(
        req({ agentId: 'vps-hostinger-01', report: rpc.request.sample.report }),
        context
      );
      expect(res.status).toBe(200);

      const body = parse(res);
      expect(body.ok).toBe(true);
      expect(body.stored).toBe(false);
    });
  });

  describe('reportHostCheck contract (#1282)', () => {
    const rpc = contract.rpcs.reportHostCheck;

    it('accepts the sample report and returns the contract success response', async () => {
      const store = makeConfigStore();
      const handlers = createLabAgentHandlers({ guard: allowGuard(), store, now: () => NOW });

      const res = await handlers.reportHostCheck(req(rpc.request.sample), context);
      expect(res.status).toBe(200);

      const body = parse(res);
      for (const field of rpc.response.success.requiredFields) {
        expect(body).toHaveProperty(field);
      }
      expect(body).toEqual(rpc.response.success.sample);

      // The entry is the sample's report, every required field present, plus
      // the site's time of receipt; nothing the contract does not name.
      const entry = store.createDoc.mock.calls[0][1].checks[rpc.request.sample.check];
      for (const field of rpc.request.reportFields.requiredFields) {
        expect(entry).toHaveProperty(field);
      }
      for (const field of rpc.request.reportFields.containerFields.requiredFields) {
        expect(entry.containers).toHaveProperty(field);
      }
      expect(Object.keys(entry).sort()).toEqual(
        [...rpc.request.reportFields.requiredFields, ...rpc.request.reportFields.optionalFields, 'agentId', 'receivedAt'].sort()
      );
    });

    it('accepts every check the contract lists, and refuses one it does not', async () => {
      for (const check of rpc.request.validChecks) {
        const handlers = createLabAgentHandlers({ guard: allowGuard(), store: makeConfigStore(), now: () => NOW });
        const res = await handlers.reportHostCheck(req({ ...rpc.request.sample, check }), context);
        expect(res.status, check).toBe(200);
      }
      const handlers = createLabAgentHandlers({ guard: allowGuard(), store: makeConfigStore(), now: () => NOW });
      const res = await handlers.reportHostCheck(req({ ...rpc.request.sample, check: 'coder' }), context);
      expect(res.status).toBe(400);
      expect(parse(res).error).toMatch(/check must name a host check/);
    });

    it('refuses a report missing a required contract field', async () => {
      const { up: _omitted, ...report } = rpc.request.sample.report;
      const handlers = createLabAgentHandlers({ guard: allowGuard(), store: makeConfigStore(), now: () => NOW });
      const res = await handlers.reportHostCheck(req({ ...rpc.request.sample, report }), context);
      expect(res.status).toBe(400);
      expect(parse(res).error).toMatch(/report\.up is required/);
    });
  });
});
