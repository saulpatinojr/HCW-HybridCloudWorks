/**
 * What the content workflow routes share: the JSON reply, the actor name,
 * the audit row shape and the body read (PR #841 split of content-workflow.js).
 */
import { errorResponse } from '../http/error-response.js';

export const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const actor = (user) => user.email || user.preferred_username || user.oid || 'admin';

export const readBody = async (request) => (await request.json().catch(() => null)) || {};

/** One admin_audit_logs row, in the shape every workflow write records. */
export const auditRow = (
  uuid,
  { action, user, request, details, contentId, contentTitle, nowIso }
) => ({
  id: uuid(),
  action,
  userId: user.oid ?? user.sub ?? null,
  userEmail: user.email || null,
  timestamp: nowIso,
  details,
  userAgent: request.headers?.get?.('user-agent') || null,
  contentId,
  contentTitle,
  compliance: {
    schemaVersion: 1,
    detailsSanitized: true,
    identityVerified: true,
  },
});

/** The 500 every workflow route answers when a write throws. */
export function workflowFailure(context, label, error, message, request = null) {
  return errorResponse(context, message, error, 500, request);
}
