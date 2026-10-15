/**
 * audit.js — Centralized audit trail helper and client action allowlist (AP-B4, #939).
 *
 * Implements:
 * 1. Client-originated action validation & allowlist (prevents forged 'setting_updated' rows).
 * 2. Details payload size bounding (max 4,096 bytes).
 * 3. Shared `recordMutationAudit` helper for all mutating admin/CMS routes.
 * 4. Document schema standard with TTL (90 days) and immutable compliance stamp.
 */

import { randomUUID } from 'node:crypto';

export const AUDIT_CONTAINER = 'admin_audit_logs';
export const AUDIT_TTL_SECONDS = 90 * 86400; // 90 days in seconds
export const MAX_DETAILS_LENGTH = 4096;

/**
 * Allowlisted client-originated action names.
 * These match the actions the admin UI legitimately dispatches via logAdminAction.
 */
export const CLIENT_AUDIT_ACTIONS = Object.freeze(new Set([
  'page_view',
  'draft_saved',
  'content_published_live',
  'content_images_rehosted',
  'framework_deleted',
  'content_slug_set',
  'podcast_transcript_queued',
  'content_images_reordered',
  'content_forge_enqueued',
  'bulk_delete_rejected',
  'content_deleted_from_rejected_queue',
]));

/**
 * Validates an action submitted by a client.
 * Returns an error string if invalid, or null if allowed.
 */
export function validateClientAuditAction(action) {
  if (!action || typeof action !== 'string') return 'action is required';
  const trimmed = action.trim();
  if (trimmed.length === 0) return 'action is required';
  if (trimmed.length > 120) return 'action exceeds 120 characters';

  // Explicitly reject forged setting updates or system-level actions
  if (
    /^(setting_|platform_setting_|workflow_|config_|admin_bootstrap|secret_)/i.test(trimmed) ||
    trimmed.toLowerCase().includes('setting')
  ) {
    return 'Action not permitted for client-originated audit logging';
  }

  // Allow explicitly registered client actions or namespaced client.* actions
  if (!CLIENT_AUDIT_ACTIONS.has(trimmed) && !trimmed.startsWith('client.')) {
    return `Action '${trimmed}' is not an authorized client audit action`;
  }

  return null;
}

/**
 * Validates and bounds the details object.
 */
export function sanitizeAuditDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return { error: 'details must be an object' };
  }
  let str;
  try {
    str = JSON.stringify(details);
  } catch {
    return { error: 'details must be serializable JSON' };
  }
  if (str.length > MAX_DETAILS_LENGTH) {
    return { error: `details exceeds maximum allowed size of ${MAX_DETAILS_LENGTH} bytes` };
  }
  return { details };
}

/**
 * Standard backend audit helper for mutating handlers.
 * Writes a row to admin_audit_logs with actor, action, resource, before and after snapshots.
 *
 * @param {{ upsertDoc: Function }} store
 * @param {object} params
 * @param {string} params.action - The mutation action (e.g. 'certification_created', 'social_post_deleted')
 * @param {object} params.actor - Authenticated user/agent context ({ oid, sub, email, name })
 * @param {string} [params.resource] - The resource identifier or container:id
 * @param {object} [params.before] - State before mutation (or null for creates)
 * @param {object} [params.after] - State after mutation (or null for deletes)
 * @param {object} [params.details] - Arbitrary additional metadata
 * @param {() => Date} [params.now]
 * @param {() => string} [params.uuid]
 * @param {object} [params.context] - Azure Functions invocation context for logging
 */
export async function recordMutationAudit(store, {
  action,
  actor,
  resource = null,
  before = null,
  after = null,
  details = {},
  now = () => new Date(),
  uuid = randomUUID,
  context = null,
}) {
  if (!store?.upsertDoc) return null;

  const doc = {
    id: uuid(),
    action,
    userId: actor?.oid || actor?.sub || actor?.id || null,
    userName: actor?.name || null,
    userEmail: actor?.email || actor?.preferred_username || null,
    resource: resource ? String(resource) : null,
    before: before ?? null,
    after: after ?? null,
    details: details ?? {},
    timestamp: now().toISOString(),
    ttl: AUDIT_TTL_SECONDS,
    compliance: { schemaVersion: 2, appendOnly: true },
  };

  try {
    await store.upsertDoc(AUDIT_CONTAINER, doc);
  } catch (err) {
    context?.warn?.(`recordMutationAudit: failed to record audit row for ${action}: ${err?.message || err}`);
  }

  return doc;
}
