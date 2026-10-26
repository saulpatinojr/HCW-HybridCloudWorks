import { createRoleGuard } from '../auth/require-role.js';
import { createTokenVerifier } from '../auth/verify-token.js';
import { readDoc } from '../cosmos-client.js';
import { SYNC_SCOPE, fail, ownerEnabled } from './model.js';

let syncGuard;
export function getBrainSyncGuard() {
  syncGuard ||= createRoleGuard({
    delegatedScope: SYNC_SCOPE,
    verifier: createTokenVerifier({
      tenantId: process.env.ENTRA_TENANT_ID,
      audience: process.env.ENTRA_API_AUDIENCE,
    }),
    lookupAdmin: (oid) => readDoc('admins', oid, oid),
  });
  return syncGuard;
}

export async function requireBrainOwner(
  guard,
  request,
  env = process.env,
  sync = false,
) {
  const auth = await guard.requireRole(request, 'editor');
  if (auth.error) return auth;
  if (!ownerEnabled(auth.user, env))
    fail(404, 'UNAVAILABLE', 'Second Brain is unavailable for this account.');
  if (
    sync &&
    (!env.BRAIN_SYNC_CLIENT_ID ||
      auth.user.azp?.toLowerCase() !== env.BRAIN_SYNC_CLIENT_ID.toLowerCase())
  )
    fail(403, 'FORBIDDEN', 'This client cannot synchronize the workspace.');
  return auth;
}
