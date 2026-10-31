/**
 * The denial sink must never reject (#1465 review): the guard does not await
 * it, so a rejected Cosmos write would surface as an unhandled rejection on a
 * denial path instead of being contained.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

// A plain function, not vi.fn(): a spy attaches its own handler to every
// promise it returns to record the result, which would mark a rejected write
// as handled and hide exactly the unhandled rejection this file is about.
const cosmos = vi.hoisted(() => ({ calls: [], impl: async () => ({}) }));
vi.mock('../cosmos-client.js', () => ({
  upsertDoc: (...args) => {
    cosmos.calls.push(args);
    return cosmos.impl(...args);
  },
}));

const { writeDenialAudit } = await import('./denial-audit.js');
const { createRoleGuard } = await import('./require-role.js');

afterEach(() => {
  cosmos.calls.length = 0;
  cosmos.impl = async () => ({});
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

describe('writeDenialAudit', () => {
  it('writes one auth-denial row', async () => {
    await writeDenialAudit({ outcome: 'denied', reason: 'missing-scope' });
    const [container, doc] = cosmos.calls[0];
    expect(container).toBe('admin_audit_logs');
    expect(doc).toMatchObject({ kind: 'auth-denial', outcome: 'denied', reason: 'missing-scope' });
  });

  it('resolves, and logs only the error code, when the write fails', async () => {
    rejectWith(Object.assign(new Error('secret account detail'), { code: 403 }));
    const log = { warn: vi.fn() };
    await expect(writeDenialAudit({ outcome: 'denied' }, log)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toContain('403');
    expect(log.warn.mock.calls[0][0]).not.toContain('secret account detail');
  });

  it('leaves the guard answer unchanged and raises no unhandled rejection when the write fails', async () => {
    rejectWith(Object.assign(new Error('cosmos down'), { code: 503 }));
    const guard = createRoleGuard({
      verifier: { verify: async () => ({ oid: 'someone', scp: 'access_as_admin', roles: [] }) },
      lookupAdmin: async () => null,
      auditDenial: writeDenialAudit,
      delegatedScope: 'code_brain_sync',
    });
    const request = { headers: { get: (name) => (name === 'authorization' ? 'Bearer fake' : null) } };
    const { result, seen } = await unhandledDuring(() => guard.requireRole(request, 'editor'));
    expect(cosmos.calls).toHaveLength(1);
    expect(result.error.status).toBe(401);
    expect(result.error.headers['WWW-Authenticate']).toContain('insufficient_scope');
    expect(seen).toEqual([]);
  });
});
