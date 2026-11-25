/**
 * developer-api/admin-shared.js — what the Developer API's admin routes
 * (admin-handlers.js for the keys, proposal-erasure.js for a speaker's
 * erasure request) have in common: the answer's shape, the refusal a route
 * throws to answer early, who did it, and the audit row each write leaves.
 */

/** Tried this many times when a write loses a race with another one. */
export const WRITE_ATTEMPTS = 2;

export const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

/** Thrown from a route's work to answer with `response` at once (admin-handlers.js `route` catches it). */
export class Answer extends Error {
  constructor(response) {
    super('answered');
    this.response = response;
  }
}

export const actorOf = (user = {}) => [user.email, user.preferred_username, user.oid, user.sub].find(Boolean) || 'admin';

/**
 * One audit row, best effort: a failure is logged with the action's fixed
 * name only, and the route carries on (its write has landed).
 */
export async function audit(deps, action, { user, request, keyId, details = {}, resourceType = 'developer_api_key', resourceId = keyId }) {
  const { log } = deps;
  try {
    await deps.store.upsertDoc('admin_audit_logs', {
      id: deps.uuid(),
      timestamp: deps.now().toISOString(),
      action,
      userId: user.oid || user.sub || null,
      userEmail: user.email || null,
      resourceType,
      resourceId,
      details,
      userAgent: request.headers?.get?.('user-agent') || null,
      compliance: { schemaVersion: 1, detailsSanitized: true, identityVerified: true },
    });
  } catch {
    log.error?.(`[developer-api] audit row ${action} failed`);
  }
}
