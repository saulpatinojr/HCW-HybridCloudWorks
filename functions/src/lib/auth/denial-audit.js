import { randomUUID } from 'node:crypto';
import { upsertDoc } from '../cosmos-client.js';
import { errorCode } from '../http/error-response.js';

/**
 * A guard's denial sink: one `admin_audit_logs` row per refused request
 * (an invalid token, a missing scope, a missing role, a wrong agent key).
 * The Agent Content API's key guard (lib/agent-content/guard.js) records its
 * refusals through it; the admin guard writes its own rows the same way.
 *
 * It never rejects. The guard calls it without awaiting it (require-role.js),
 * so its try/catch only sees a synchronous throw; a failed Cosmos write here
 * would otherwise become an unhandled rejection on a denial path, anonymous
 * routes included. A failure is logged as one content-free line (the error's
 * code, never its message) and the denial answer is unchanged.
 *
 * @param {object} entry
 * @param {{ warn?: Function }} [log]
 * @returns {Promise<void>}
 */
export async function writeDenialAudit(entry, log = console) {
  try {
    await upsertDoc('admin_audit_logs', {
      id: randomUUID(),
      kind: 'auth-denial',
      at: new Date().toISOString(),
      ...entry,
    });
  } catch (error) {
    log.warn?.(`[auth] a denial was not written to admin_audit_logs (${errorCode(error)})`);
  }
}
