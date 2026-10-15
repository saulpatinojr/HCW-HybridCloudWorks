/**
 * The agent's only link to the platform (#817).
 *
 * Everything this process may do is these four POSTs, so what they carry is
 * the contract: a bearer token from the certificate credential on every call,
 * the agentId in every body (the server checks it against the token), and a
 * refusal that surfaces as an error with the server's status and message
 * rather than as a job the agent thinks it holds.
 *
 * Node's built-in test runner, like the rest of this package: its lockfile
 * carries one dependency, and a test framework is not worth a second. The
 * credential is injected, so no certificate and no Entra call is involved.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createApiClient } from './api.js';

const API = 'https://api.example.test/api';

function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = queue.shift() ?? { status: 200, body: {} };
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => {
        if (next.body === undefined) throw new SyntaxError('no body');
        return next.body;
      },
    };
  };
  return { impl, calls };
}

function client({ responses = [], token = 'agent-token' } = {}) {
  const fetch = fakeFetch(responses);
  const scopes = [];
  const api = createApiClient({
    apiBase: API,
    scope: 'api://hcw/.default',
    agentId: 'vps-hostinger-01',
    fetchImpl: fetch.impl,
    credential: {
      getToken: async (scope) => {
        scopes.push(scope);
        return token ? { token } : null;
      },
    },
  });
  return { api, calls: fetch.calls, scopes };
}

describe('every call', () => {
  it('POSTs JSON with a bearer token for the API scope and the agentId in the body', async () => {
    const { api, calls, scopes } = client({ responses: [{ status: 200, body: { ok: true } }] });
    await api.heartbeat({ status: 'idle', activeJobs: 0, hostname: 'h', version: '2.0.0' });

    const [call] = calls;
    assert.equal(call.url, `${API}/agent/heartbeat`);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers['Content-Type'], 'application/json');
    assert.equal(call.init.headers.Authorization, 'Bearer agent-token');
    assert.deepEqual(scopes, ['api://hcw/.default']);
    assert.deepEqual(call.body, {
      agentId: 'vps-hostinger-01',
      status: 'idle',
      activeJobs: 0,
      hostname: 'h',
      version: '2.0.0',
    });
  });

  it('carries the applied-commit record on a heartbeat when there is one, and leaves it out when there is not', async () => {
    const applied = {
      commit: '0123456789abcdef0123456789abcdef01234567',
      committedAt: '2026-10-09T23:02:14-05:00',
      appliedAt: '2026-10-10T04:31:07Z',
    };
    const { api, calls } = client();
    await api.heartbeat({ status: 'idle', activeJobs: 0, hostname: 'h', version: '2.0.0', applied });
    await api.heartbeat({ status: 'idle', activeJobs: 0, hostname: 'h', version: '2.0.0', applied: null });

    assert.deepEqual(calls[0].body.applied, applied);
    assert.equal(Object.hasOwn(calls[1].body, 'applied'), false);
  });

  it('a heartbeat sent with its own timeout gives up at that timeout, not at the 20 s default', async () => {
    // The two shutdown heartbeats carry one (lib/shutdown.js): a fetch that
    // never answers is abandoned when the signal fires, and the agent moves
    // on to the next step of the stop.
    const abandoned = [];
    const api = createApiClient({
      apiBase: API,
      scope: 'api://hcw/.default',
      agentId: 'vps-hostinger-01',
      fetchImpl: (url, init) =>
        new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => {
            abandoned.push(url);
            reject(init.signal.reason);
          });
        }),
      credential: { getToken: async () => ({ token: 'agent-token' }) },
    });

    const started = Date.now();
    await assert.rejects(
      api.heartbeat({ status: 'offline', activeJobs: 0, hostname: 'h', version: '2.0.0' }, { timeoutMs: 20 }),
      (error) => error.name === 'AbortError'
    );
    assert.ok(Date.now() - started < 5000, 'the heartbeat waited past its own timeout');
    assert.deepEqual(abandoned, [`${API}/agent/heartbeat`]);
  });

  it('the timeout covers the token as well: a token request that never answers is abandoned and nothing is sent', async () => {
    // The certificate credential refreshes its token at Entra about once an
    // hour. A refresh that hangs must not hold a shutdown heartbeat past its
    // own timeout, so the request's signal is handed to getToken, which the
    // SDK honours as `abortSignal`.
    const sent = [];
    const api = createApiClient({
      apiBase: API,
      scope: 'api://hcw/.default',
      agentId: 'vps-hostinger-01',
      fetchImpl: async (url) => {
        sent.push(url);
        return { ok: true, status: 200, json: async () => ({}) };
      },
      credential: {
        getToken: (scope, { abortSignal } = {}) =>
          new Promise((_, reject) => {
            assert.ok(abortSignal, 'getToken was not given the request signal');
            abortSignal.addEventListener('abort', () => reject(abortSignal.reason));
          }),
      },
    });

    const started = Date.now();
    await assert.rejects(
      api.heartbeat({ status: 'stopping', activeJobs: 1, hostname: 'h', version: '2.0.0' }, { timeoutMs: 20 }),
      (error) => error.name === 'AbortError'
    );
    assert.ok(Date.now() - started < 5000, 'the heartbeat waited on the token past its own timeout');
    assert.deepEqual(sent, []);
  });

  it('cannot be made to send a different agentId through a body field', async () => {
    // The spread puts agentId first, so a caller-supplied key could replace
    // it. The three methods pass only named fields, which is what keeps it.
    const { api, calls } = client();
    await api.completeJob({ jobId: 'j1', status: 'succeeded', exitCode: 0, output: 'ok', agentId: 'someone-else' });
    assert.equal(calls[0].body.agentId, 'vps-hostinger-01');
    assert.deepEqual(Object.keys(calls[0].body).sort(), ['agentId', 'exitCode', 'jobId', 'output', 'status']);
  });

  it('sends claimId when provided in completeJob', async () => {
    const { api, calls } = client();
    await api.completeJob({ jobId: 'j1', claimId: 'claim-123', status: 'succeeded', exitCode: 0, output: 'ok' });
    assert.equal(calls[0].body.claimId, 'claim-123');
    assert.deepEqual(Object.keys(calls[0].body).sort(), ['agentId', 'claimId', 'exitCode', 'jobId', 'output', 'status']);
  });

  it('refuses to send anything without a token', async () => {
    const { api, calls } = client({ token: null });
    await assert.rejects(api.claimJob(), /failed to acquire an API token/);
    assert.equal(calls.length, 0);
  });

  it('turns a refusal into an error carrying the status and the server message', async () => {
    const { api } = client({ responses: [{ status: 403, body: { error: 'Agent access required' } }] });
    await assert.rejects(api.claimJob(), (error) => {
      assert.equal(error.status, 403);
      assert.equal(error.message, 'Agent access required');
      return true;
    });
  });

  it('names the path and status when a refusal has no readable body', async () => {
    const { api } = client({ responses: [{ status: 502, body: undefined }] });
    await assert.rejects(api.completeJob({ jobId: 'j1', status: 'failed' }), (error) => {
      assert.equal(error.status, 502);
      assert.equal(error.message, 'agent/completeLabJob failed with HTTP 502');
      return true;
    });
  });
});

describe('claimJob', () => {
  it('returns the job the server hands out', async () => {
    const job = { id: 'j1', type: 'terraform-validate', payload: '{}' };
    const { api, calls } = client({ responses: [{ status: 200, body: { job } }] });
    assert.deepEqual(await api.claimJob(), job);
    assert.equal(calls[0].url, `${API}/agent/claimLabJob`);
    assert.deepEqual(calls[0].body, { agentId: 'vps-hostinger-01' });
  });

  it('returns null when there is no job, whether the field is null or absent', async () => {
    const { api } = client({ responses: [{ status: 200, body: { job: null } }, { status: 200, body: {} }] });
    assert.equal(await api.claimJob(), null);
    assert.equal(await api.claimJob(), null);
  });
});

describe('reportCoderAutomation', () => {
  const report = { checkedAt: '2026-10-08T04:30:00Z' };

  it('posts the token and the report to agent/reportCoderAutomation and returns the answer', async () => {
    const { api, calls } = client({ responses: [{ status: 200, body: { ok: true, stored: true } }] });
    // Built at run time: a literal in Coder's API key shape reads as a leaked
    // token to secret scanners (GitGuardian flagged these on #1030).
    const statusToken = ['FAKEKEYID0', 'FAKESECRETFAKESECRET00'].join('-');
    assert.deepEqual(await api.reportCoderAutomation({ statusToken, report }), { ok: true, stored: true });
    assert.equal(calls[0].url, `${API}/agent/reportCoderAutomation`);
    assert.deepEqual(calls[0].body, { agentId: 'vps-hostinger-01', statusToken, report });
  });

  it('sends no statusToken key at all when there is no token, and no agentId but its own', async () => {
    const { api, calls } = client();
    await api.reportCoderAutomation({ report, agentId: 'someone-else' });
    assert.deepEqual(calls[0].body, { agentId: 'vps-hostinger-01', report });
  });

  it('surfaces a refused token as an error carrying the status', async () => {
    const { api } = client({ responses: [{ status: 422, body: { ok: false, stored: false, error: 'Coder refused the token (HTTP 401); the token was not stored' } }] });
    await assert.rejects(api.reportCoderAutomation({ report }), (error) => {
      assert.equal(error.status, 422);
      return true;
    });
  });
});
