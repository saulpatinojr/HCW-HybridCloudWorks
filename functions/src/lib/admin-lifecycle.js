/**
 * Admin lifecycle RPCs — listAdmins, updateAdmin, deactivateAdmin — and the
 * role-to-permissions map they write. Split out of admin-identity.js, which
 * wires these into its handler factory and re-exports
 * getPermissionsForRole, so callers and tests import what they always did.
 *
 * Each handler is a module-level function over `ctx` (guard, store, now,
 * uuid), the same shape as the rest of admin-identity.js.
 */
import { ADMIN_ROLES } from './auth/roles.js';
import { json } from './http/admin-handler.js';
import { errorResponse } from './http/error-response.js';
import { recordMutationAudit } from './audit.js';

/** Verbatim from Site-Main lib/admin-auth.js — the frontend gates UI on these. */
export function getPermissionsForRole(role) {
  const permissionMap = {
    viewer: ['read:content', 'read:dashboard'],
    editor: ['read:content', 'read:dashboard', 'write:content', 'review:content'],
    publisher: [
      'read:content',
      'read:dashboard',
      'write:content',
      'review:content',
      'publish:content',
    ],
    super_admin: [
      'read:content',
      'read:dashboard',
      'write:content',
      'review:content',
      'publish:content',
      'manage:admins',
      'manage:settings',
    ],
  };
  return permissionMap[String(role || '').toLowerCase()] || [];
}

/**
 * GET /api/cms/admins — list all admin records (super_admin only).
 */
export async function listAdmins(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'super_admin');
  if (auth.error) return auth.error;

  try {
    const docs = await ctx.store.queryDocs(
      'admins',
      'SELECT c.id, c.uid, c.email, c.role, c.permissions, c.active, c.createdAt, c.createdBy, c.updatedAt, c.updatedBy, c.updateReason FROM c'
    );
    const admins = (docs || []).sort((a, b) =>
      String(a.email || a.id).localeCompare(String(b.email || b.id))
    );
    return json(200, { admins });
  } catch (error) {
    return errorResponse(context, 'Failed to list admins', error, 500, request);
  }
}

/** The admin record a PATCH names, as `{ targetId, existing }`, or `{ error }` with the 400 or 404. */
async function readTargetAdmin(store, request) {
  const targetId = request.params?.id || request.params?.adminId;
  if (!targetId) return { error: json(400, { error: 'Admin ID is required' }) };
  const existing = await store.readDoc('admins', targetId, targetId);
  if (!existing) return { error: json(404, { error: 'Admin record not found' }) };
  return { targetId, existing };
}

/**
 * What a PATCH body asks to change on `existing`, or `{ error }` with the 400
 * that refuses it: an unknown role, or taking away the last active super
 * admin. `demotesSuperAdmin` says whether an active super admin loses that.
 */
async function planAdminChange(store, body, existing) {
  const requestedRole = body.role ? String(body.role).toLowerCase() : undefined;
  if (requestedRole && !ADMIN_ROLES[requestedRole.toUpperCase()]) {
    return { error: json(400, { error: 'Invalid role' }) };
  }

  const requestedActive = typeof body.active === 'boolean' ? body.active : undefined;
  const updateReason = String(body.reason || body.updateReason || 'Admin updated via lifecycle API');
  const newActive = requestedActive !== undefined ? requestedActive : existing.active;

  const isCurrentlyActiveSuperAdmin = existing.role === 'super_admin' && existing.active === true;
  const willBeActiveSuperAdmin =
    (requestedRole ? requestedRole === 'super_admin' : existing.role === 'super_admin') && newActive;
  const demotesSuperAdmin = isCurrentlyActiveSuperAdmin && !willBeActiveSuperAdmin;

  if (demotesSuperAdmin) {
    const activeSuperAdmins = await store.queryDocs(
      'admins',
      "SELECT c.id FROM c WHERE c.active = true AND c.role = 'super_admin'"
    );
    if (activeSuperAdmins.length <= 1) {
      return { error: json(400, { error: 'Cannot demote or deactivate the last active super admin' }) };
    }
  }

  return { newRole: requestedRole ?? existing.role, newActive, updateReason, demotesSuperAdmin };
}

/**
 * PATCH /api/cms/admins/{id} — change role or active status (super_admin only).
 * Prevents demoting or deactivating the last active super admin.
 * Writes before-and-after audit and clears guard role cache.
 */
export async function updateAdmin(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'super_admin');
  if (auth.error) return auth.error;

  try {
    const { user } = auth;
    const actorOid = user.oid ?? user.sub;
    const target = await readTargetAdmin(ctx.store, request);
    if (target.error) return target.error;
    const { targetId, existing } = target;

    const body = (await request.json().catch(() => null)) || {};
    const change = await planAdminChange(ctx.store, body, existing);
    if (change.error) return change.error;
    const { newRole, newActive, updateReason, demotesSuperAdmin } = change;
    const nowIso = ctx.now().toISOString();

    const patchedFields = {
      role: newRole,
      permissions: getPermissionsForRole(newRole),
      active: newActive,
      updatedAt: nowIso,
      updatedBy: actorOid,
      updateReason,
    };

    await ctx.store.patchDoc('admins', targetId, patchedFields);

    // Evict cached role entries immediately so changes take effect without waiting 60s
    ctx.guard.clearCache();

    const updatedDoc = { ...existing, ...patchedFields };

    await recordMutationAudit(ctx.store, {
      actor: user,
      action: demotesSuperAdmin ? 'admin_demoted' : 'admin_role_changed',
      resource: `admins/${targetId}`,
      before: { id: existing.id, role: existing.role, active: existing.active },
      after: { id: updatedDoc.id, role: updatedDoc.role, active: updatedDoc.active },
      details: { reason: updateReason, targetOid: targetId },
      now: ctx.now,
      uuid: ctx.uuid,
      context,
    });

    return json(200, { success: true, admin: updatedDoc });
  } catch (error) {
    return errorResponse(context, 'Failed to update admin', error, 500, request);
  }
}

export async function deactivateAdmin(ctx, request, context) {
  const reqWithDeactivate = {
    ...request,
    json: async () => ({ active: false, reason: 'Deactivated via admin lifecycle API' }),
  };
  return updateAdmin(ctx, reqWithDeactivate, context);
}
