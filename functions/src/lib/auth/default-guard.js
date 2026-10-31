/**
 * The production composition of the role guard: real token verifier, real
 * Cosmos lookups, real audit sink. Handlers import this; tests build their own
 * guard with createRoleGuard and fakes.
 *
 * Initialisation is lazy — on the first guarded request, not at module load.
 * createTokenVerifier throws without ENTRA_TENANT_ID / ENTRA_API_AUDIENCE
 * (deliberately: an unset audience would otherwise silently disable audience
 * validation, see verify-token.js FIX A1). Composing it at import time would
 * take the whole Function App down at cold start, including /api/health, and
 * break importing any handler module in tests. Lazy init keeps the health
 * probe alive and surfaces the misconfiguration as a clear 500 on the first
 * guarded call instead.
 */
import { randomUUID } from 'node:crypto';
import { createTokenVerifier } from './verify-token.js';
import { createRoleGuard } from './require-role.js';
import { readDoc, upsertDoc } from '../cosmos-client.js';

let guard = null;

export function getDefaultGuard() {
  if (guard) return guard;
  guard = createRoleGuard({
    verifier: createTokenVerifier({
      tenantId: process.env.ENTRA_TENANT_ID,
      audience: process.env.ENTRA_API_AUDIENCE,
    }),
    // Gate 2's authoritative record: a point read of admins/{oid}.
    lookupAdmin: (oid) => readDoc('admins', oid, oid),
    // Site-Main writes every denial to admin_audit_logs
    // (admin-auth.js:405-411); the container exists here and now has its
    // writer. Failures inside the sink are swallowed by the guard itself.
    auditDenial: (entry) =>
      upsertDoc('admin_audit_logs', {
        id: randomUUID(),
        kind: 'auth-denial',
        at: new Date().toISOString(),
        ...entry,
      }),
  });
  return guard;
}

/** Test seam: drop the memoised guard so env changes take effect. */
export function resetDefaultGuard() {
  guard = null;
}
