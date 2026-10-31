import { randomUUID } from 'node:crypto';
import { upsertDoc } from '../cosmos-client.js';

/**
 * The guard's denial sink: one `admin_audit_logs` row per refused request
 * (an invalid token, a missing scope, a missing role). Shared by the default
 * admin guard and the private workspaces' sync guards, so a refusal on any of
 * them is recorded the same way. Failures inside the sink are swallowed by
 * the guard itself (require-role.js).
 */
export function writeDenialAudit(entry) {
  return upsertDoc('admin_audit_logs', {
    id: randomUUID(),
    kind: 'auth-denial',
    at: new Date().toISOString(),
    ...entry,
  });
}
