import { createRoleGuard } from '../auth/require-role.js';
import { createTokenVerifier } from '../auth/verify-token.js';
import { readDoc } from '../cosmos-client.js';
import { writeDenialAudit } from '../auth/denial-audit.js';
import { SYNC_SCOPE, fail, ownerMatches } from './model.js';

/**
 * A guard that accepts only tokens carrying one delegated scope. Each private
 * workspace has its own scope (brain_sync for the creator brain,
 * code_brain_sync for the Code Conductor brain), so a token issued for one
 * fails the other. The admin registry it checks is the site's one registry,
 * and its refusals are written to admin_audit_logs like the admin guard's.
 */
export function createWorkspaceSyncGuard(delegatedScope) {
  return createRoleGuard({
    delegatedScope,
    verifier: createTokenVerifier({
      tenantId: process.env.ENTRA_TENANT_ID,
      audience: process.env.ENTRA_API_AUDIENCE,
    }),
    lookupAdmin: (oid) => readDoc('admins', oid, oid),
    auditDenial: writeDenialAudit,
  });
}

let syncGuard;
export function getBrainSyncGuard() {
  syncGuard ||= createWorkspaceSyncGuard(SYNC_SCOPE);
  return syncGuard;
}

/**
 * Sign-in, then the workspace's owner, then (for sync) its desktop client.
 *
 * @param {{requireRole: Function}} guard
 * @param {object} request
 * @param {{enabled: boolean, ownerOid?: string, ownerTenantId?: string,
 *   syncClientId?: string, unavailable: string}} workspace
 * @param {boolean} [sync]
 */
export async function requireWorkspaceOwner(
  guard,
  request,
  workspace,
  sync = false,
) {
  // A switched-off or half-configured workspace refuses as soon as the token
  // is known to be valid and to carry the scope, before the admin registry
  // (a Cosmos read) is consulted. A caller with no or a wrong token still gets
  // 401, so the answer does not say whether the workspace exists.
  if (!(workspace.enabled === true && workspace.ownerOid && workspace.ownerTenantId)) {
    const signedIn = await guard.requireUser(request);
    if (signedIn.error) return signedIn;
    fail(404, 'UNAVAILABLE', workspace.unavailable);
  }
  const auth = await guard.requireRole(request, 'editor');
  if (auth.error) return auth;
  if (!ownerMatches(auth.user, workspace))
    fail(404, 'UNAVAILABLE', workspace.unavailable);
  if (
    sync &&
    (!workspace.syncClientId ||
      auth.user.azp?.toLowerCase() !== workspace.syncClientId.toLowerCase())
  )
    fail(403, 'FORBIDDEN', 'This client cannot synchronize the workspace.');
  return auth;
}

export async function requireBrainOwner(
  guard,
  request,
  env = process.env,
  sync = false,
) {
  return requireWorkspaceOwner(
    guard,
    request,
    {
      enabled: env.BRAIN_ENABLED === 'true',
      ownerOid: env.BRAIN_OWNER_OID,
      ownerTenantId: env.BRAIN_OWNER_TENANT_ID,
      syncClientId: env.BRAIN_SYNC_CLIENT_ID,
      unavailable: 'Second Brain is unavailable for this account.',
    },
    sync,
  );
}
