/**
 * Admin identity RPCs — getCurrentAdminStatus, bootstrapCurrentUserAdmin,
 * recordAdminAudit — plus the speaker-event write RPCs
 * (upsertSpeakerEvent / deleteSpeakerEvent, in ./admin-identity/).
 *
 * Ported from Site-Main cms-functions.js (:3303, :5010, :5078, :6171, :6236)
 * and lib/admin-auth.js. The Firebase-Auth machinery does not survive the
 * port and is replaced deliberately:
 *
 *   - verifyIdToken + custom claims -> the Entra verifier via the guard's
 *     requireUser. getCurrentAdminStatus then answers from the authoritative
 *     admins/{oid} record instead of trusting token claims — the same
 *     authority requireRole's gate 2 uses, and strictly harder to spoof than
 *     the source's claims-only read.
 *   - setAdminRole's custom-claims sync + session revocation has no Entra
 *     equivalent from here (claims come from App Role assignments in the
 *     directory). Bootstrap writes the admins registry record and clears the
 *     guard's role cache; the Entra 'Admin' App Role must ALSO be assigned in
 *     the directory (gate 1) — recorded in the response so the operator sees
 *     the remaining step instead of a mysteriously denied login.
 *   - FINDING-06 upheld: no allow-any escape hatch. First-admin bootstrap
 *     requires the server-only allowlist (CMS_BOOTSTRAP_ALLOWED_UIDS /
 *     CMS_BOOTSTRAP_ALLOWED_EMAILS, or OWNER_ADMIN_UID / OWNER_ADMIN_EMAIL),
 *     where a "uid" is now an Entra object id.
 *
 * Each handler body is a module-level function over `ctx` (guard, store, now,
 * uuid, env, actor); `createAdminIdentityHandlers` only wires them. The admin
 * lifecycle handlers (list, update, deactivate) are in ./admin-lifecycle.js. The
 * speaker-event rules and handlers are ./admin-identity/speaker-event-rules.js
 * and ./admin-identity/speaker-events.js, re-exported here so
 * admin-identity-http.js and every test import exactly what they always did.
 */
import { randomUUID } from 'node:crypto';
import { ADMIN_ROLES, ENTRA_ADMIN_APP_ROLE, ENTRA_API_DELEGATED_SCOPE } from './auth/roles.js';
import { ENTRA_REQUIRED_TOKEN_VERSION } from './auth/verify-token.js';
import { ENTRA_LAB_AGENT_APP_ROLE } from './auth/require-agent.js';
import { actorName } from './auth/actor-name.js';
import { json } from './http/admin-handler.js';
import { errorResponse, errorFacts } from './http/error-response.js';
import { createSpeakerEventHandlers } from './admin-identity/speaker-events.js';
import {
  deactivateAdmin,
  getPermissionsForRole,
  listAdmins,
  updateAdmin,
} from './admin-lifecycle.js';
import {
  validateClientAuditAction,
  sanitizeAuditDetails,
  AUDIT_TTL_SECONDS,
  recordMutationAudit,
} from './audit.js';

export {
  SPEAKER_EVENT_FIELDS,
  SPEAKER_EVENT_STATUSES,
  normalizeSpeakerEventDate,
  validateSpeakerEventData,
} from './admin-identity/speaker-event-rules.js';
export { getPermissionsForRole } from './admin-lifecycle.js';

export const BOOTSTRAP_STATE_DOC_ID = 'bootstrap-state';
export const BOOTSTRAP_STATE_CONTAINER = 'admin_settings';

/** Each sign that a signed-in user is an external/guest account; any one is enough. */
const GUEST_SIGNS = [
  (user) => String(user.userType || user.user_type || '').toLowerCase() === 'guest',
  (user) => user.acct === 1,
  (user) => typeof user.idp === 'string' && user.idp.length > 0,
  (user) => /#EXT#/i.test(String(user.preferred_username || user.upn || user.email || '')),
];

/** Detect whether a user is an external/guest account. */
export function isGuestUser(user) {
  if (!user) return false;
  return GUEST_SIGNS.some((sign) => sign(user));
}

/**
 * Source checkBootstrapAllowlist (:6186), uid = Entra oid.
 * AP-B5: Object IDs only, email-only matching is refused, and guest accounts are rejected.
 */
export function checkBootstrapAllowlist(user, env = process.env) {
  if (isGuestUser(user)) {
    return { ok: false, status: 403, error: 'Guest accounts are not permitted to perform bootstrap' };
  }

  const expandList = (envValues) =>
    envValues.filter(Boolean).flatMap((value) =>
      String(value)
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    );
  const bootstrapAllowedUids = expandList(
    [env.CMS_BOOTSTRAP_ALLOWED_UIDS, env.OWNER_ADMIN_UID]
  );

  if (bootstrapAllowedUids.length === 0) {
    return {
      ok: false,
      status: 503,
      error:
        'Initial bootstrap is locked. Configure bootstrap allowlist env vars with object IDs for the first admin.',
    };
  }

  const oid = user?.oid ?? user?.sub;
  if (!oid || !bootstrapAllowedUids.includes(oid)) {
    return { ok: false, status: 403, error: 'User is not allowed to perform initial bootstrap' };
  }
  return { ok: true };
}

/** Is any admin active? The first bootstrap is the one that finds none. */
async function hasActiveAdmin(store) {
  const activeAdmins = await store.queryDocs(
    'admins',
    'SELECT TOP 1 c.id FROM c WHERE c.active = true',
    []
  );
  return activeAdmins.length > 0;
}

/**
 * Would `bootstrapCurrentUserAdmin` actually succeed for this caller?
 *
 * The frontend used to offer "Bootstrap My Admin Access" to anyone it failed
 * to confirm as an admin, which is how the owner — already holding an
 * `admins` record — was invited to re-provision himself after nothing worse
 * than an expired token (#503). The UI cannot guess this: the gate is the
 * allowlist env vars and the state of the registry, neither of which the
 * browser can see. So it asks, and this answers with the same three-way gate
 * the POST enforces.
 *
 * `record` short-circuits it. An account with a row in `admins` is either an
 * admin already (never on this screen) or one that was deliberately
 * deactivated, and offering the second one a self-promotion to `super_admin`
 * is the opposite of what the deactivation meant.
 */
async function canBootstrapSelf({ store, env }, user, record) {
  if (record) return false;
  if (!checkBootstrapAllowlist(user, env).ok) return false;
  const bootstrapDoc = await store.readDoc(BOOTSTRAP_STATE_CONTAINER, BOOTSTRAP_STATE_DOC_ID, BOOTSTRAP_STATE_DOC_ID).catch(() => null);
  if (bootstrapDoc?.completed === true) return false;
  return !(await hasActiveAdmin(store));
}

/**
 * GET /api/getCurrentAdminStatus — answers from the admins registry.
 *
 * A 200 is an ANSWER: `isAdmin` is true or false because the registry was
 * read. A 401 or a 500 is a check that could not run, and the frontend is
 * required to render those differently (#503) — `requireUser` only ever
 * denies with 401, so a non-200 here is never an authorization verdict.
 *
 * The `isAdmin: false` answer carries `canBootstrap` so the UI can offer
 * the bootstrap button only when it would work.
 */
async function getCurrentAdminStatus(ctx, request, context) {
  const auth = await ctx.guard.requireUser(request);
  if (auth.error) {
    return json(401, { error: 'Invalid token', isAdmin: false });
  }
  try {
    const { user } = auth;
    const oid = user.oid ?? user.sub;
    const email = user.email || user.preferred_username || null;

    const record = await ctx.store.readDoc('admins', oid, oid);
    if (!record || record.active !== true || !record.role) {
      return json(200, {
        isAdmin: false,
        uid: oid,
        email,
        canBootstrap: await canBootstrapSelf(ctx, user, record),
      });
    }
    return json(200, {
      isAdmin: true,
      uid: oid,
      email,
      role: String(record.role).toLowerCase(),
      permissions: Array.isArray(record.permissions)
        ? record.permissions
        : getPermissionsForRole(record.role),
      active: true,
    });
  } catch (error) {
    context.error('getCurrentAdminStatus failed:', errorFacts(error));
    return json(500, { error: 'Failed to get admin status', isAdmin: false });
  }
}

/**
 * GET /api/getAuthExpectations — what the guard actually enforces, for
 * the Admin → Diagnostics page (#355).
 *
 * The page decodes the caller's own access token in the browser and needs
 * something to compare `aud`, `tid` and `roles` against. Building those
 * values into the frontend would only prove the frontend agrees with
 * itself; this returns the audience and tenant the verifier is configured
 * with and the App Role value `requireRole` looks for, so the comparison
 * is against the API as deployed.
 *
 * requireUser, not requireRole: the whole point is diagnosing a caller
 * who holds the App Role but is missing from the registry, and that caller
 * would be refused by the role guard before learning anything. Nothing
 * here is secret — the audience is in every token's `aud`, the tenant is
 * in the SPA's build, and the role and scope values are in this
 * repository. It is an inventory of what the guard checks, not of what it
 * checks against.
 */
async function getAuthExpectations({ guard, env }, request) {
  const auth = await guard.requireUser(request);
  if (auth.error) return auth.error;
  return json(200, {
    expectedAudience: env.ENTRA_API_AUDIENCE || null,
    tenantId: env.ENTRA_TENANT_ID || null,
    adminAppRole: ENTRA_ADMIN_APP_ROLE,
    registryContainer: 'admins',
    // Added with the configuration review surface (#519). Each is a value
    // the guard enforces and the SPA cannot know, so a page that compares
    // against them is comparing against the API as deployed rather than
    // against a frontend constant that agrees with itself.
    requiredScope: ENTRA_API_DELEGATED_SCOPE,
    requiredTokenVersion: ENTRA_REQUIRED_TOKEN_VERSION,
    labAgentAppRole: ENTRA_LAB_AGENT_APP_ROLE,
  });
}

/**
 * The bootstrap gate: with admins already present the caller must hold
 * super_admin; the first bootstrap needs the server-only allowlist. The
 * response that refuses, or null to proceed.
 */
async function bootstrapRefusal({ guard, env }, request, user, initialBootstrap, context) {
  if (!initialBootstrap) {
    const actorAuth = await guard.requireRole(request, 'super_admin');
    return actorAuth.error || null;
  }
  const allowlist = checkBootstrapAllowlist(user, env);
  if (allowlist.ok) return null;
  context.error('Initial bootstrap blocked:', allowlist.error);
  return json(allowlist.status, { error: allowlist.error });
}

/**
 * Is this the first bootstrap, and is the caller refused? A first bootstrap
 * that was already completed answers 409 before the allowlist is read.
 */
async function bootstrapGate(ctx, request, user, context) {
  const initialBootstrap = !(await hasActiveAdmin(ctx.store));
  if (initialBootstrap) {
    const bootstrapDoc = await ctx.store
      .readDoc(BOOTSTRAP_STATE_CONTAINER, BOOTSTRAP_STATE_DOC_ID, BOOTSTRAP_STATE_DOC_ID)
      .catch(() => null);
    if (bootstrapDoc?.completed === true) {
      return {
        initialBootstrap,
        refusal: json(409, { error: 'Initial bootstrap has already been completed' }),
      };
    }
  }
  return {
    initialBootstrap,
    refusal: await bootstrapRefusal(ctx, request, user, initialBootstrap, context),
  };
}

/** Write (patch when present, create otherwise) the caller's registry record. */
async function writeAdminRecord({ store, now }, { oid, email, role, initialBootstrap }) {
  const nowIso = now().toISOString();
  const registryFields = {
    uid: oid,
    email,
    role,
    permissions: getPermissionsForRole(role),
    active: true,
    updatedAt: nowIso,
    updatedBy: oid,
    updateReason: initialBootstrap
      ? 'Initial bootstrap via bootstrapCurrentUserAdmin'
      : 'Role update via bootstrapCurrentUserAdmin',
  };
  const existing = await store.readDoc('admins', oid, oid);
  if (existing) {
    await store.patchDoc('admins', oid, registryFields);
    return;
  }
  await store.upsertDoc('admins', {
    id: oid,
    ...registryFields,
    createdAt: nowIso,
    createdBy: oid,
  });
}

/** POST /api/bootstrapCurrentUserAdmin — first admin, or self role update. */
async function bootstrapCurrentUserAdmin(ctx, request, context) {
  const auth = await ctx.guard.requireUser(request);
  if (auth.error) return auth.error;

  try {
    const body = (await request.json().catch(() => null)) || {};
    const requestedRole = String(body.role || 'super_admin').toLowerCase();
    if (!ADMIN_ROLES[requestedRole.toUpperCase()]) {
      return json(400, { error: 'Invalid role' });
    }

    const { user } = auth;
    const oid = user.oid ?? user.sub;
    const email =
      String(user.email || user.preferred_username || '')
        .trim()
        .toLowerCase() || null;

    const { initialBootstrap, refusal } = await bootstrapGate(ctx, request, user, context);
    if (refusal) return refusal;

    await writeAdminRecord(ctx, { oid, email, role: requestedRole, initialBootstrap });
    if (initialBootstrap) {
      await ctx.store.upsertDoc(BOOTSTRAP_STATE_CONTAINER, {
        id: BOOTSTRAP_STATE_DOC_ID,
        completed: true,
        completedAt: ctx.now().toISOString(),
        completedBy: oid,
      });
    }
    // The 60s role cache must not serve the pre-bootstrap answer.
    ctx.guard.clearCache();

    return json(200, {
      success: true,
      uid: oid,
      email,
      role: requestedRole,
      initialBootstrap,
      // The port's honest difference from Firebase custom claims:
      note: "Registry record written. The Entra 'Admin' App Role must also be assigned to this user in the directory for API access (guard gate 1).",
    });
  } catch (error) {
    return errorResponse(context, 'Failed to bootstrap admin', error, 500, request);
  }
}

/**
 * POST /api/cms/bootstrap/reset — reset one-shot bootstrap flag (super_admin only).
 */
async function resetBootstrapState(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'super_admin');
  if (auth.error) return auth.error;

  try {
    const { user } = auth;
    const actorOid = user.oid ?? user.sub;
    const previous = await ctx.store
      .readDoc(BOOTSTRAP_STATE_CONTAINER, BOOTSTRAP_STATE_DOC_ID, BOOTSTRAP_STATE_DOC_ID)
      .catch(() => null);

    const newState = {
      id: BOOTSTRAP_STATE_DOC_ID,
      completed: false,
      resetAt: ctx.now().toISOString(),
      resetBy: actorOid,
    };
    await ctx.store.upsertDoc(BOOTSTRAP_STATE_CONTAINER, newState);

    await recordMutationAudit(ctx.store, {
      actor: user,
      action: 'bootstrap_reset',
      resource: `${BOOTSTRAP_STATE_CONTAINER}/${BOOTSTRAP_STATE_DOC_ID}`,
      before: previous,
      after: newState,
      now: ctx.now,
      uuid: ctx.uuid,
      context,
    });

    return json(200, { success: true, message: 'Bootstrap state has been reset' });
  } catch (error) {
    return errorResponse(context, 'Failed to reset bootstrap state', error, 500, request);
  }
}

/** POST /api/recordAdminAudit — client-originated audit rows. */
async function recordAdminAudit(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;

  try {
    const body = (await request.json().catch(() => null)) || {};
    const { action, details = {} } = body;
    const actionProblem = validateClientAuditAction(action);
    if (actionProblem) return json(400, { error: actionProblem });

    const detailsResult = sanitizeAuditDetails(details);
    if (detailsResult.error) return json(400, { error: detailsResult.error });

    const { user } = auth;
    const auditId = ctx.uuid();
    await ctx.store.upsertDoc('admin_audit_logs', {
      id: auditId,
      action: String(action),
      userId: user.oid ?? user.sub ?? null,
      userEmail: user.email || null,
      route: details.route || null,
      sessionId: details.sessionId || null,
      timestamp: ctx.now().toISOString(),
      clientTimestamp: details.clientTimestamp || null,
      details: detailsResult.details,
      userAgent: request.headers?.get?.('user-agent') || details.userAgent || null,
      ttl: AUDIT_TTL_SECONDS,
      compliance: { schemaVersion: 1, detailsSanitized: true, identityVerified: true, clientOriginated: true, appendOnly: true },
    });

    return json(200, { success: true, auditId });
  } catch (error) {
    return errorResponse(context, 'Failed to record audit', error, 500, request);
  }
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function, requireUser: Function, clearCache: Function }} deps.guard
 * @param {{ queryDocs: Function, readDoc: Function, upsertDoc: Function, patchDoc: Function, deleteDoc: Function }} deps.store
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 * @param {object} [deps.env]
 */
export function createAdminIdentityHandlers({
  guard,
  store,
  now = () => new Date(),
  uuid = randomUUID,
  env = process.env,
}) {
  const ctx = { guard, store, now, uuid, env, actor: (user) => actorName(user) };

  return {
    getCurrentAdminStatus: (request, context) => getCurrentAdminStatus(ctx, request, context),
    getAuthExpectations: (request) => getAuthExpectations(ctx, request),
    bootstrapCurrentUserAdmin: (request, context) =>
      bootstrapCurrentUserAdmin(ctx, request, context),
    recordAdminAudit: (request, context) => recordAdminAudit(ctx, request, context),
    listAdmins: (request, context) => listAdmins(ctx, request, context),
    updateAdmin: (request, context) => updateAdmin(ctx, request, context),
    deactivateAdmin: (request, context) => deactivateAdmin(ctx, request, context),
    resetBootstrapState: (request, context) => resetBootstrapState(ctx, request, context),
    ...createSpeakerEventHandlers(ctx),
  };
}
