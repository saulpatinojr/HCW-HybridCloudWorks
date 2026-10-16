/**
 * agent-protocol-contract.test.js — Cross-boundary contract tests for VPS Agent client (QA-3 #978).
 *
 * Verifies that vps-agent/lib/api.js strictly satisfies the shared JSON contract fixture
 * in .azure/agent-protocol.json. Renaming or omitting any contract field on either
 * the client or functions side fails this suite.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createApiClient } from './api.js';

const CONTRACT_PATH = new URL('../../.azure/agent-protocol.json', import.meta.url);
const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));

const API_BASE = 'https://api.example.test/api';

function fakeFetch(responses = []) {
  const calls = [];
  const queue = [...responses];
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = queue.shift() ?? { status: 200, body: { ok: true } };
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
    };
  };
  return { impl, calls };
}

function createTestClient(responses = []) {
  const fetch = fakeFetch(responses);
  const api = createApiClient({
    apiBase: API_BASE,
    scope: 'api://hcw/.default',
    agentId: 'vps-hostinger-01',
    fetchImpl: fetch.impl,
    credential: {
      getToken: async () => ({ token: 'mock-agent-token' }),
    },
  });
  return { api, calls: fetch.calls };
}

describe('agent protocol contract (QA-3 #978): vps-agent client', () => {
  it('contract fixture defines all four required agent RPCs', () => {
    const expectedRpcs = ['claimLabJob', 'heartbeat', 'completeLabJob', 'reportCoderAutomation'];
    assert.deepEqual(Object.keys(contract.rpcs).sort(), expectedRpcs.sort());
  });

  describe('claimLabJob contract', () => {
    const rpc = contract.rpcs.claimLabJob;

    it('sends POST to declared path with required fields', async () => {
      const { api, calls } = createTestClient([
        { status: 200, body: rpc.response.success.sampleWithJob },
      ]);
      const res = await api.claimJob();

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, `${API_BASE}/${rpc.path}`);
      assert.equal(calls[0].init.method, rpc.method);

      // Verify request payload fields
      for (const field of rpc.request.requiredFields) {
        assert.ok(Object.hasOwn(calls[0].body, field), `Request must have required field: ${field}`);
      }
      assert.equal(calls[0].body.agentId, 'vps-hostinger-01');

      // Verify response payload fields
      assert.ok(res, 'claimJob should return job object');
      for (const field of rpc.response.success.jobFields.requiredFields) {
        assert.ok(Object.hasOwn(res, field), `Job response must have required field: ${field}`);
      }
      assert.equal(res.id, rpc.response.success.sampleWithJob.job.id);
      assert.equal(res.type, rpc.response.success.sampleWithJob.job.type);
      assert.equal(res.claimId, rpc.response.success.sampleWithJob.job.claimId);
    });

    it('returns null on sampleNoJob response', async () => {
      const { api } = createTestClient([
        { status: 200, body: rpc.response.success.sampleNoJob },
      ]);
      const res = await api.claimJob();
      assert.equal(res, null);
    });
  });

  describe('heartbeat contract', () => {
    const rpc = contract.rpcs.heartbeat;

    it('sends minimal heartbeat matching contract required fields', async () => {
      const sample = rpc.request.sampleMinimal;
      const { api, calls } = createTestClient([{ status: 200, body: rpc.response.success.sample }]);
      const res = await api.heartbeat({
        status: sample.status,
        activeJobs: sample.activeJobs,
        hostname: sample.hostname,
        version: sample.version,
      });

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, `${API_BASE}/${rpc.path}`);
      assert.equal(calls[0].init.method, rpc.method);
      assert.deepEqual(res, rpc.response.success.sample);

      for (const field of rpc.request.requiredFields) {
        assert.ok(Object.hasOwn(calls[0].body, field), `Heartbeat body must have required field: ${field}`);
      }
    });

    it('sends full heartbeat matching contract optional fields including applied commit record', async () => {
      const sample = rpc.request.sampleFull;
      const { api, calls } = createTestClient([{ status: 200, body: rpc.response.success.sample }]);
      await api.heartbeat({
        status: sample.status,
        activeJobs: sample.activeJobs,
        hostname: sample.hostname,
        version: sample.version,
        applied: sample.applied,
        certificateExpiresAt: sample.certificateExpiresAt,
      });

      assert.equal(calls.length, 1);
      for (const field of rpc.request.appliedFields.requiredFields) {
        assert.ok(
          Object.hasOwn(calls[0].body.applied, field),
          `Applied record must have required field: ${field}`
        );
      }
      assert.equal(calls[0].body.certificateExpiresAt, sample.certificateExpiresAt);
    });

    it('all contract valid statuses are supported by client', async () => {
      for (const status of rpc.request.validStatuses) {
        const { api, calls } = createTestClient([{ status: 200, body: { ok: true } }]);
        await api.heartbeat({ status, activeJobs: 0, hostname: 'h', version: '2.0.0' });
        assert.equal(calls[0].body.status, status);
      }
    });
  });

  describe('completeLabJob contract', () => {
    const rpc = contract.rpcs.completeLabJob;

    it('sends completeJob matching contract required and optional fields', async () => {
      const sample = rpc.request.sample;
      const { api, calls } = createTestClient([{ status: 200, body: rpc.response.success.sample }]);
      const res = await api.completeJob({
        jobId: sample.jobId,
        claimId: sample.claimId,
        status: sample.status,
        exitCode: sample.exitCode,
        output: sample.output,
      });

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, `${API_BASE}/${rpc.path}`);
      assert.equal(calls[0].init.method, rpc.method);
      assert.deepEqual(res, rpc.response.success.sample);

      for (const field of rpc.request.requiredFields) {
        assert.ok(Object.hasOwn(calls[0].body, field), `completeLabJob body must have required field: ${field}`);
      }
      assert.equal(calls[0].body.claimId, sample.claimId);
    });

    it('all contract valid terminal statuses are accepted', async () => {
      for (const status of rpc.request.validStatuses) {
        const { api, calls } = createTestClient([{ status: 200, body: { ok: true } }]);
        await api.completeJob({ jobId: 'j', status, exitCode: 0, output: 'ok' });
        assert.equal(calls[0].body.status, status);
      }
    });
  });

  describe('reportCoderAutomation contract', () => {
    const rpc = contract.rpcs.reportCoderAutomation;

    it('sends reportCoderAutomation matching contract required fields and response', async () => {
      const sample = rpc.request.sample;
      const { api, calls } = createTestClient([{ status: 200, body: rpc.response.success.sample }]);
      const res = await api.reportCoderAutomation({
        statusToken: sample.statusToken,
        report: sample.report,
      });

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, `${API_BASE}/${rpc.path}`);
      assert.equal(calls[0].init.method, rpc.method);

      for (const field of rpc.request.requiredFields) {
        assert.ok(
          Object.hasOwn(calls[0].body, field),
          `reportCoderAutomation body must have required field: ${field}`
        );
      }
      assert.equal(calls[0].body.statusToken, sample.statusToken);
      assert.equal(calls[0].body.report.checkedAt, sample.report.checkedAt);

      for (const field of rpc.response.success.requiredFields) {
        assert.ok(Object.hasOwn(res, field), `Response must have required field: ${field}`);
      }
      assert.equal(res.ok, true);
      assert.equal(res.stored, true);
    });
  });
});
