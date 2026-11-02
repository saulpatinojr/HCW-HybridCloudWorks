/**
 * The production composition of the role guard.
 *
 * `require-role.test.js` covers the guard's behaviour against injected fakes,
 * which is the right shape for the rules — but it cannot see whether the real
 * composition supplies the dependencies at all. That gap is what T-406
 * described: `admin_audit_logs` with no writer. The writer exists now, and this
 * file is what keeps it existing, because nothing else fails if the
 * `auditDenial` line is deleted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const cosmos = vi.hoisted(() => ({ readDoc: vi.fn(), upsertDoc: vi.fn() }));
const roleGuard = vi.hoisted(() => ({ createRoleGuard: vi.fn(() => ({ requireRole: vi.fn() })) }));

vi.mock('../cosmos-client.js', () => cosmos);
vi.mock('./require-role.js', () => roleGuard);
vi.mock('./verify-token.js', () => ({ createTokenVerifier: vi.fn(() => ({ verify: vi.fn() })) }));
const agentGuard = vi.hoisted(() => ({
  authenticate: vi.fn(async () => ({ record: { capabilities: {} }, user: { oid: 'agent:koda' }, error: null })),
}));
vi.mock('../agent-content/guard.js', () => ({ getAgentContentGuard: () => agentGuard, resetAgentContentGuard: () => {} }));

const { getDefaultGuard, resetDefaultGuard } = await import('./default-guard.js');

const original = { ...process.env };

describe('getDefaultGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    roleGuard.createRoleGuard.mockReturnValue({ requireRole: vi.fn() });
    resetDefaultGuard();
    process.env.ENTRA_TENANT_ID = 'tenant';
    process.env.ENTRA_API_AUDIENCE = 'api://audience';
  });

  afterEach(() => {
    process.env = { ...original };
    resetDefaultGuard();
  });

  it('supplies an auditDenial sink — the container had none (T-406)', async () => {
    getDefaultGuard();
    const { auditDenial } = roleGuard.createRoleGuard.mock.calls[0][0];
    expect(typeof auditDenial).toBe('function');

    await auditDenial({ outcome: 'denied', reason: 'missing-app-role', oid: 'oid-1' });

    const [container, doc] = cosmos.upsertDoc.mock.calls[0];
    expect(container).toBe('admin_audit_logs');
    expect(doc).toMatchObject({
      kind: 'auth-denial',
      outcome: 'denied',
      reason: 'missing-app-role',
      oid: 'oid-1',
    });
    expect(doc.id).toBeTruthy();
    expect(doc.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('looks the admin record up by object id in the admins container', async () => {
    getDefaultGuard();
    const { lookupAdmin } = roleGuard.createRoleGuard.mock.calls[0][0];
    await lookupAdmin('oid-1');
    // Third argument is the partition key: `admins` is partitioned on /id.
    expect(cosmos.readDoc).toHaveBeenCalledWith('admins', 'oid-1', 'oid-1');
  });

  it('is memoised, so the JWKS client is built once per instance', () => {
    expect(getDefaultGuard()).toBe(getDefaultGuard());
    expect(roleGuard.createRoleGuard).toHaveBeenCalledTimes(1);
  });

  it('builds nothing at import time', () => {
    // Composing at module load would take the whole app down at cold start on
    // a missing ENTRA_* setting, including /api/health.
    expect(roleGuard.createRoleGuard).not.toHaveBeenCalled();
  });

  it('sends a request that presents a site key down the agent path, and a token down the role guard (ADR 0038)', async () => {
    const guard = getDefaultGuard();
    const headers = (authorization) => ({ get: (name) => (name.toLowerCase() === 'authorization' ? authorization : null) });
    const key = `hcwk_${'a'.repeat(43)}`;
    const agent = await guard.requireRole(
      { method: 'GET', url: 'https://h/api/cms/content', headers: headers(`Bearer ${key}`) },
      'editor'
    );
    expect(agentGuard.authenticate).toHaveBeenCalledTimes(1);
    expect(agent.error).toBeNull();
    expect(agent.user.oid).toBe('agent:koda');
    expect(roleGuard.createRoleGuard.mock.results[0].value.requireRole).not.toHaveBeenCalled();

    await guard.requireRole({ method: 'GET', url: 'https://h/api/cms/content', headers: headers('Bearer not.a.key') }, 'editor');
    expect(roleGuard.createRoleGuard.mock.results[0].value.requireRole).toHaveBeenCalledTimes(1);
  });
});
