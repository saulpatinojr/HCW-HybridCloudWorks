/**
 * The production composition of the Labs agent guard: real token verifier,
 * real Cosmos lookups, real audit sink. Mirrors default-guard.js, including
 * its lazy initialisation — createTokenVerifier throws without
 * ENTRA_TENANT_ID / ENTRA_API_AUDIENCE, and composing it at import time would
 * take the whole Function App down at cold start.
 *
 * The verifier is the same one the admin guard uses: same tenant, same API
 * audience. What separates an agent from an admin is not the token issuer but
 * the App Role in the token and the registry it is checked against — see
 * require-agent.js.
 */
import { createTokenVerifier } from './verify-token.js';
import { createAgentGuard } from './require-agent.js';
import { readDoc } from '../cosmos-client.js';
import { writeDenialAudit } from './denial-audit.js';

let guard = null;

export function getDefaultAgentGuard() {
  if (guard) return guard;
  guard = createAgentGuard({
    verifier: createTokenVerifier({
      tenantId: process.env.ENTRA_TENANT_ID,
      audience: process.env.ENTRA_API_AUDIENCE,
    }),
    // lab_agents is partitioned on /id, and /agentId is identical to /id by
    // construction (infra/main.tf partition-key rationale).
    lookupAgent: (agentId) => readDoc('lab_agents', agentId, agentId),
    // The shared sink the admin and workspace guards write through (#1465).
    // The guard calls it without awaiting it, so the sink must never reject:
    // writeDenialAudit awaits the Cosmos write inside its own try/catch and
    // logs one content-free line (the error's code, never its message) when
    // the write fails. Until #1476 this was a bare upsertDoc call, and a write
    // refused under throttling became an unhandled rejection in the Functions
    // host instead of the clean 401 or 403 the guard had already answered.
    auditDenial: (entry) => writeDenialAudit({ kind: 'agent-auth-denial', ...entry }),
  });
  return guard;
}

/** Test seam: drop the memoised guard so env changes take effect. */
export function resetDefaultAgentGuard() {
  guard = null;
}
