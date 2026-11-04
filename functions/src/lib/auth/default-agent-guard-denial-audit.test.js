/**
 * The lab agent guard's denial sink must never reject (#1476).
 *
 * The guard (require-agent.js) calls its sink without awaiting it, so its
 * try/catch only sees a synchronous throw. Before the fix the production
 * wiring handed it a bare `upsertDoc(...)` call: a Cosmos write refused under
 * throttling became an unhandled rejection in the Functions host instead of a
 * clean 401 or 403. The admin and workspace guards' shared sink
 * (denial-audit.js) was fixed on #1465; this file holds the agent guard to the
 * same rule, through the real wiring in default-agent-guard.js and the real
 * guard, with only Cosmos and the token verifier replaced.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A plain function, not vi.fn(): a spy attaches its own handler to every
// promise it returns to record the result, which would mark a rejected write
// as handled and hide exactly the unhandled rejection this file is about.
const cosmos = vi.hoisted(() => ({ calls: [], impl: async () => ({}) }));
vi.mock('../cosmos-client.js', () => ({
  readDoc: async () => null,
  upsertDoc: (...args) => {
    cosmos.calls.push(args);
    return cosmos.impl(...args);
  },
}));

// The verifier is replaced (there is no tenant here); bearerTokenFrom stays
// real so the guard reads the request the way it does in production.
const verify = vi.hoisted(() => ({ impl: async () => ({}) }));
vi.mock('./verify-token.js', async (importOriginal) => ({
  ...(await importOriginal()),
  createTokenVerifier: () => ({ verify: (token) => verify.impl(token) }),
}));

const { getDefaultAgentGuard, resetDefaultAgentGuard } = await import('./default-agent-guard.js');

const request = { headers: { get: (name) => (name.toLowerCase() === 'authorization' ? 'Bearer fake' : null) } };

beforeEach(() => {
  process.env.ENTRA_TENANT_ID = '00000000-0000-0000-0000-000000000001';
  process.env.ENTRA_API_AUDIENCE = 'api://00000000-0000-0000-0000-000000000001';
  resetDefaultAgentGuard();
});

afterEach(() => {
  cosmos.calls.length = 0;
  cosmos.impl = async () => ({});
  verify.impl = async () => ({});
  vi.restoreAllMocks();
});

const rejectWith = (error) => {
  cosmos.impl = () => Promise.reject(error);
};

/** Collect the unhandled rejections raised while `work` runs and settles. */
async function unhandledDuring(work) {
  const seen = [];
  const listener = (reason) => seen.push(reason);
  process.on('unhandledRejection', listener);
  try {
    const result = await work();
    // Let the un-awaited sink settle and Node report what it would.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { result, seen };
  } finally {
    process.off('unhandledRejection', listener);
  }
}

describe('the agent guard denial sink (#1476)', () => {
  it('writes one agent-auth-denial row with the indexed twins the Health page reads', async () => {
    const { requireAgent } = getDefaultAgentGuard();
    verify.impl = async () => {
      throw Object.assign(new Error('bad token'), { code: 'invalid-signature' });
    };
    const result = await requireAgent(request, 'vps-1');

    expect(result.error.status).toBe(401);
    expect(cosmos.calls).toHaveLength(1);
    const [container, doc] = cosmos.calls[0];
    expect(container).toBe('admin_audit_logs');
    expect(doc).toMatchObject({ kind: 'agent-auth-denial', outcome: 'denied', reason: 'invalid-token' });
    // The same two facts under the names the container indexes (`action`,
    // `timestamp`), as every other guard's row has them since #1465.
    expect(doc.action).toBe('agent-auth-denial');
    expect(doc.timestamp).toBe(doc.at);
    expect(doc.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('resolves, and logs only the error code, when the write fails', async () => {
    rejectWith(Object.assign(new Error('secret account detail'), { code: 429 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { requireAgent } = getDefaultAgentGuard();
    verify.impl = async () => ({ oid: 'agent-oid', scp: 'access_as_user', roles: [] });

    const { result, seen } = await unhandledDuring(() => requireAgent(request, 'vps-1'));

    expect(result.error.status).toBe(403);
    expect(seen).toEqual([]);
    expect(cosmos.calls).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('429');
    expect(line).not.toContain('secret account detail');
  });

  it('leaves a 401 unchanged and raises no unhandled rejection when the write fails', async () => {
    rejectWith(Object.assign(new Error('cosmos down'), { code: 503 }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { requireAgent } = getDefaultAgentGuard();
    verify.impl = async () => {
      throw Object.assign(new Error('expired'), { code: 'token-expired' });
    };

    const { result, seen } = await unhandledDuring(() => requireAgent(request, 'vps-1'));

    expect(result).toEqual({ agent: null, identity: null, error: expect.objectContaining({ status: 401 }) });
    expect(JSON.parse(result.error.body)).toEqual({ ok: false, error: 'Authentication required' });
    expect(seen).toEqual([]);
  });
});
