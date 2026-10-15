/**
 * Admin identity + speaker-event RPCs — behavior pinned to the source
 * (:3303/:5010/:5078/:6171/:6236 and lib/admin-auth.js) with the documented
 * Entra adaptations. The load-bearing assertions: bootstrap's three-way gate
 * (locked / allowlisted / super_admin-required), the status endpoint answering
 * from the registry rather than token claims, and the guard cache clear after
 * a role write.
 */
import { describe, it, expect, vi } from 'vitest';
import { ENTRA_ADMIN_APP_ROLE, ENTRA_API_DELEGATED_SCOPE } from './auth/roles.js';
import { ENTRA_REQUIRED_TOKEN_VERSION } from './auth/verify-token.js';
import { ENTRA_LAB_AGENT_APP_ROLE } from './auth/require-agent.js';
import {
  createAdminIdentityHandlers,
  checkBootstrapAllowlist,
  getPermissionsForRole,
  normalizeSpeakerEventDate,
  validateSpeakerEventData,
} from './admin-identity.js';

const context = { log: vi.fn(), error: vi.fn() };

const USER = { oid: 'oid-1', email: 'first@hcw.dev', preferred_username: 'first@hcw.dev' };

const guardWith = (over = {}) => ({
  requireUser: vi.fn(async () => ({ user: USER, role: null, error: null })),
  requireRole: vi.fn(async () => ({ user: USER, role: 'editor', error: null })),
  clearCache: vi.fn(),
  ...over,
});
const denyUser = {
  requireUser: vi.fn(async () => ({ user: null, role: null, error: { status: 401, body: '{}' } })),
  requireRole: vi.fn(),
  clearCache: vi.fn(),
};

const makeRequest = (body) => ({
  method: 'POST',
  headers: { get: (k) => (k === 'user-agent' ? 'vitest' : null) },
  json: async () => {
    if (body === undefined) throw new SyntaxError('no body');
    return body;
  },
});

function makeStore(over = {}) {
  return {
    queryDocs: vi.fn(async () => []),
    readDoc: vi.fn(async () => null),
    upsertDoc: vi.fn(async (_c, d) => d),
    patchDoc: vi.fn(async (_c, id, u) => ({ id, ...u })),
    deleteDoc: vi.fn(async () => {}),
    ...over,
  };
}

const fixed = { now: () => new Date('2026-08-07T02:00:00.000Z'), uuid: () => 'fixed-uuid' };

describe('helpers', () => {
  it('permissions map carries the exact source strings the frontend gates on', () => {
    expect(getPermissionsForRole('editor')).toContain('write:content');
    expect(getPermissionsForRole('publisher')).toContain('publish:content');
    expect(getPermissionsForRole('super_admin')).toContain('manage:admins');
    expect(getPermissionsForRole('viewer')).toEqual(['read:content', 'read:dashboard']);
    expect(getPermissionsForRole('nonsense')).toEqual([]);
  });

  it('bootstrap allowlist: locked with no env, matches oid or lowercased email', () => {
    expect(checkBootstrapAllowlist(USER, {}).status).toBe(503);
    expect(checkBootstrapAllowlist(USER, { CMS_BOOTSTRAP_ALLOWED_UIDS: 'oid-1' }).ok).toBe(true);
    expect(
      checkBootstrapAllowlist(USER, { CMS_BOOTSTRAP_ALLOWED_EMAILS: 'FIRST@hcw.dev' }).ok
    ).toBe(true);
    expect(checkBootstrapAllowlist(USER, { OWNER_ADMIN_UID: 'someone-else' }).status).toBe(403);
  });

  it('speaker date normalizer answers the calendar day for Date, epoch, string, Timestamp-like, junk', () => {
    expect(normalizeSpeakerEventDate(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01');
    expect(normalizeSpeakerEventDate(1767225600000)).toBe('2026-01-01');
    expect(normalizeSpeakerEventDate('2026-01-01')).toBe('2026-01-01');
    // The leading day is the day the author typed, whatever offset follows it.
    expect(normalizeSpeakerEventDate('2026-01-01T23:30:00-06:00')).toBe('2026-01-01');
    expect(normalizeSpeakerEventDate({ seconds: 1767225600, nanoseconds: 0 })).toBe('2026-01-01');
    expect(normalizeSpeakerEventDate({ _seconds: 1767225600 })).toBe('2026-01-01');
    expect(normalizeSpeakerEventDate('2026-02-30')).toBeNull();
    expect(normalizeSpeakerEventDate('junk')).toBeNull();
    expect(normalizeSpeakerEventDate('')).toBeNull();
  });
});

describe('getCurrentAdminStatus', () => {
  it('401s with isAdmin:false on a bad token', async () => {
    const h = createAdminIdentityHandlers({ guard: denyUser, store: makeStore(), ...fixed });
    const res = await h.getCurrentAdminStatus(makeRequest(), context);
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body).isAdmin).toBe(false);
  });

  it('answers from the registry record, not token claims', async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => ({
        id: 'oid-1',
        role: 'PUBLISHER',
        active: true,
        permissions: null,
      })),
    });
    const h = createAdminIdentityHandlers({ guard: guardWith(), store, ...fixed });
    const body = JSON.parse((await h.getCurrentAdminStatus(makeRequest(), context)).body);
    expect(body).toMatchObject({ isAdmin: true, uid: 'oid-1', role: 'publisher', active: true });
    expect(body.permissions).toContain('publish:content'); // derived when record has none
    expect(store.readDoc).toHaveBeenCalledWith('admins', 'oid-1', 'oid-1');
  });

  it('an inactive or missing record is not an admin', async () => {
    const inactive = makeStore({
      readDoc: vi.fn(async () => ({ id: 'oid-1', role: 'editor', active: false })),
    });
    const h1 = createAdminIdentityHandlers({ guard: guardWith(), store: inactive, ...fixed });
    expect(JSON.parse((await h1.getCurrentAdminStatus(makeRequest(), context)).body).isAdmin).toBe(
      false
    );

    const h2 = createAdminIdentityHandlers({ guard: guardWith(), store: makeStore(), ...fixed });
    expect(JSON.parse((await h2.getCurrentAdminStatus(makeRequest(), context)).body).isAdmin).toBe(
      false
    );
  });

  // #503: the frontend used to offer "Bootstrap My Admin Access" to everyone it
  // could not confirm, because it had no way to know the gate. Now it asks.
  it('canBootstrap is true only with no record, no active admins, and an allowlist match', async () => {
    const h = createAdminIdentityHandlers({
      guard: guardWith(),
      store: makeStore(),
      env: { CMS_BOOTSTRAP_ALLOWED_UIDS: 'oid-1' },
      ...fixed,
    });
    const body = JSON.parse((await h.getCurrentAdminStatus(makeRequest(), context)).body);
    expect(body).toMatchObject({ isAdmin: false, canBootstrap: true });
  });

  it('canBootstrap is false when another admin is already active', async () => {
    const store = makeStore({ queryDocs: vi.fn(async () => [{ id: 'someone-else' }]) });
    const h = createAdminIdentityHandlers({
      guard: guardWith(),
      store,
      env: { CMS_BOOTSTRAP_ALLOWED_UIDS: 'oid-1' },
      ...fixed,
    });
    const body = JSON.parse((await h.getCurrentAdminStatus(makeRequest(), context)).body);
    expect(body.canBootstrap).toBe(false);
  });

  it('canBootstrap is false without an allowlist match, and asks the registry nothing', async () => {
    const store = makeStore();
    const h = createAdminIdentityHandlers({ guard: guardWith(), store, env: {}, ...fixed });
    const body = JSON.parse((await h.getCurrentAdminStatus(makeRequest(), context)).body);
    expect(body.canBootstrap).toBe(false);
    expect(store.queryDocs).not.toHaveBeenCalled();
  });

  // The owner's case in #503, with the deactivation twist: an account that
  // already has a row must never be offered a self-promotion to super_admin.
  it('canBootstrap is false for a deactivated account that still holds a record', async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => ({ id: 'oid-1', role: 'super_admin', active: false })),
    });
    const h = createAdminIdentityHandlers({
      guard: guardWith(),
      store,
      env: { CMS_BOOTSTRAP_ALLOWED_UIDS: 'oid-1' },
      ...fixed,
    });
    const body = JSON.parse((await h.getCurrentAdminStatus(makeRequest(), context)).body);
    expect(body).toMatchObject({ isAdmin: false, canBootstrap: false });
  });
});

describe('getAuthExpectations', () => {
  const env = { ENTRA_API_AUDIENCE: 'api://api-app-id', ENTRA_TENANT_ID: 'tenant-1' };
  // The route is registered GET-only; the shared makeRequest builds a POST.
  const getRequest = () => ({ ...makeRequest(), method: 'GET' });

  it('refuses an unauthenticated caller with the guard’s own response', async () => {
    const h = createAdminIdentityHandlers({ guard: denyUser, store: makeStore(), env, ...fixed });
    const res = await h.getAuthExpectations(getRequest(), context);
    expect(res.status).toBe(401);
  });

  it('returns what the guard enforces, and no registry read is needed to say so', async () => {
    const store = makeStore();
    const h = createAdminIdentityHandlers({ guard: guardWith(), store, env, ...fixed });
    const res = await h.getAuthExpectations(getRequest(), context);
    expect(res.status).toBe(200);
    // toEqual, not toMatchObject: this is a contract the configuration review
    // page compares a live token against, so a field silently disappearing
    // would turn a verdict into a blank rather than into a failure (#519).
    expect(JSON.parse(res.body)).toEqual({
      expectedAudience: 'api://api-app-id',
      tenantId: 'tenant-1',
      adminAppRole: 'Admin',
      registryContainer: 'admins',
      requiredScope: 'access_as_admin',
      requiredTokenVersion: '2.0',
      labAgentAppRole: 'LabAgent',
    });
    expect(store.readDoc).not.toHaveBeenCalled();
  });

  it('does not need the admin role — a role-holder missing from the registry can still ask', async () => {
    const guard = guardWith();
    const h = createAdminIdentityHandlers({ guard, store: makeStore(), env, ...fixed });
    await h.getAuthExpectations(getRequest(), context);
    expect(guard.requireUser).toHaveBeenCalled();
    expect(guard.requireRole).not.toHaveBeenCalled();
  });

  // The point of this endpoint is that the page compares against the API as
  // deployed. Reporting its own literals rather than the guard's constants
  // would let it agree with itself while the guard drifted.
  it('reports the values the guard actually enforces, not copies of them', async () => {
    const h = createAdminIdentityHandlers({
      guard: guardWith(),
      store: makeStore(),
      env,
      ...fixed,
    });
    const body = JSON.parse((await h.getAuthExpectations(getRequest(), context)).body);

    expect(body.adminAppRole).toBe(ENTRA_ADMIN_APP_ROLE);
    expect(body.requiredScope).toBe(ENTRA_API_DELEGATED_SCOPE);
    expect(body.requiredTokenVersion).toBe(ENTRA_REQUIRED_TOKEN_VERSION);
    expect(body.labAgentAppRole).toBe(ENTRA_LAB_AGENT_APP_ROLE);
  });

  it('reports an unset audience as null rather than inventing one', async () => {
    const h = createAdminIdentityHandlers({
      guard: guardWith(),
      store: makeStore(),
      env: {},
      ...fixed,
    });
    const body = JSON.parse((await h.getAuthExpectations(getRequest(), context)).body);
    expect(body.expectedAudience).toBeNull();
    expect(body.tenantId).toBeNull();
  });
});

describe('bootstrapCurrentUserAdmin', () => {
  it('rejects an invalid role before any store access', async () => {
    const store = makeStore();
    const h = createAdminIdentityHandlers({ guard: guardWith(), store, ...fixed });
    expect(
      (await h.bootstrapCurrentUserAdmin(makeRequest({ role: 'godmode' }), context)).status
    ).toBe(400);
    expect(store.queryDocs).not.toHaveBeenCalled();
  });

  it('first admin: locked without allowlist, allowed with it, writes the registry', async () => {
    const env = { CMS_BOOTSTRAP_ALLOWED_UIDS: 'oid-1' };
    const store = makeStore(); // no active admins
    const guard = guardWith();
    const h = createAdminIdentityHandlers({ guard, store, env, ...fixed });

    const res = await h.bootstrapCurrentUserAdmin(makeRequest({}), context);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      success: true,
      uid: 'oid-1',
      role: 'super_admin',
      initialBootstrap: true,
    });
    const doc = store.upsertDoc.mock.calls[0][1];
    expect(doc).toMatchObject({ id: 'oid-1', role: 'super_admin', active: true });
    expect(doc.permissions).toContain('manage:admins');
    expect(guard.clearCache).toHaveBeenCalled(); // stale 60s cache must not survive
    expect(guard.requireRole).not.toHaveBeenCalled(); // no admins yet — allowlist path

    const locked = createAdminIdentityHandlers({
      guard: guardWith(),
      store: makeStore(),
      env: {},
      ...fixed,
    });
    expect((await locked.bootstrapCurrentUserAdmin(makeRequest({}), context)).status).toBe(503);
  });

  it('with existing admins: requires super_admin and patches, not replaces', async () => {
    const store = makeStore({
      queryDocs: vi.fn(async () => [{ id: 'existing-admin' }]),
      readDoc: vi.fn(async () => ({ id: 'oid-1', role: 'editor', createdAt: 'kept' })),
    });
    const guard = guardWith({
      requireRole: vi.fn(async () => ({ user: USER, role: 'super_admin', error: null })),
    });
    const h = createAdminIdentityHandlers({ guard, store, env: {}, ...fixed });
    const res = await h.bootstrapCurrentUserAdmin(makeRequest({ role: 'publisher' }), context);
    expect(JSON.parse(res.body).initialBootstrap).toBe(false);
    expect(guard.requireRole).toHaveBeenCalledWith(expect.anything(), 'super_admin');
    expect(store.patchDoc).toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('denies a non-super_admin when admins already exist', async () => {
    const store = makeStore({ queryDocs: vi.fn(async () => [{ id: 'a' }]) });
    const guard = guardWith({
      requireRole: vi.fn(async () => ({
        user: null,
        role: null,
        error: { status: 403, body: '{}' },
      })),
    });
    const h = createAdminIdentityHandlers({ guard, store, env: {}, ...fixed });
    expect((await h.bootstrapCurrentUserAdmin(makeRequest({}), context)).status).toBe(403);
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(store.patchDoc).not.toHaveBeenCalled();
  });
});

describe('recordAdminAudit', () => {
  it('validates action and details like the source', async () => {
    const h = createAdminIdentityHandlers({ guard: guardWith(), store: makeStore(), ...fixed });
    expect((await h.recordAdminAudit(makeRequest({}), context)).status).toBe(400);
    expect(
      (await h.recordAdminAudit(makeRequest({ action: 'x'.repeat(121) }), context)).status
    ).toBe(400);
    expect(
      (await h.recordAdminAudit(makeRequest({ action: 'ok', details: [1] }), context)).status
    ).toBe(400);
  });

  it('writes the audit row with the source shape', async () => {
    const store = makeStore();
    const h = createAdminIdentityHandlers({ guard: guardWith(), store, ...fixed });
    const res = await h.recordAdminAudit(
      makeRequest({ action: 'page_view', details: { route: '/admin/queue', sessionId: 's1' } }),
      context
    );
    expect(JSON.parse(res.body)).toEqual({ success: true, auditId: 'fixed-uuid' });
    const [container, doc] = store.upsertDoc.mock.calls[0];
    expect(container).toBe('admin_audit_logs');
    expect(doc).toMatchObject({
      id: 'fixed-uuid',
      action: 'page_view',
      userId: 'oid-1',
      route: '/admin/queue',
      sessionId: 's1',
      userAgent: 'vitest',
      compliance: { schemaVersion: 1 },
    });
  });
});

describe('speaker events', () => {
  it('upsert merges by default (patch when present), storing the calendar day', async () => {
    const store = makeStore({ readDoc: vi.fn(async () => ({ id: 'ev1', name: 'kept' })) });
    const h = createAdminIdentityHandlers({ guard: guardWith(), store, ...fixed });
    await h.upsertSpeakerEvent(
      makeRequest({ docId: 'ev1', data: { name: 'Talk', date: { seconds: 1767225600 } } }),
      context
    );
    expect(store.upsertDoc.mock.calls.some(([c]) => c === 'speakerevents')).toBe(false);
    expect(store.upsertDoc.mock.calls.some(([c, d]) => c === 'admin_audit_logs' && d.action === 'speaker_event_upserted')).toBe(true);
    const patch = store.patchDoc.mock.calls[0][2];
    // A calendar day, not UTC midnight: the admin and the widget read it as the
    // day it names in every zone (ADR 0033 §4).
    expect(patch.date).toBe('2026-01-01');
    expect(patch.updatedBy).toBe('first@hcw.dev');
  });

  it('keeps the leading day of a timestamp string and stamps a merge-create as a creation', async () => {
    const store = makeStore({ readDoc: vi.fn(async () => null) });
    const h = createAdminIdentityHandlers({ guard: guardWith(), store, ...fixed });
    await h.upsertSpeakerEvent(
      makeRequest({
        docId: 'ev3',
        data: {
          name: 'Evening talk',
          date: '2026-03-14T23:30:00-06:00',
          cfpDeadline: '2026-01-31',
        },
      }),
      context
    );
    expect(store.patchDoc).not.toHaveBeenCalled();
    const eventDoc = store.upsertDoc.mock.calls.find(([c]) => c === 'speakerevents')?.[1];
    expect(eventDoc).toMatchObject({
      id: 'ev3',
      date: '2026-03-14',
      cfpDeadline: '2026-01-31',
      createdAt: '2026-08-07T02:00:00.000Z',
      createdBy: 'first@hcw.dev',
    });
  });

  it('refuses a field the hub does not declare, a bad URL and an unknown status', async () => {
    const store = makeStore();
    const h = createAdminIdentityHandlers({ guard: guardWith(), store, ...fixed });
    const unknown = await h.upsertSpeakerEvent(
      makeRequest({ docId: 'ev1', data: { name: 'Talk', internalNotes: 'client paid 5k' } }),
      context
    );
    expect(unknown.status).toBe(400);
    expect(JSON.parse(unknown.body).error).toContain('internalNotes');
    expect(
      (
        await h.upsertSpeakerEvent(
          makeRequest({ docId: 'ev1', data: { eventUrl: 'javascript:alert(1)' } }),
          context
        )
      ).status
    ).toBe(400);
    expect(
      (
        await h.upsertSpeakerEvent(
          makeRequest({ docId: 'ev1', data: { status: 'maybe' } }),
          context
        )
      ).status
    ).toBe(400);
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(store.patchDoc).not.toHaveBeenCalled();
  });

  it('reduces sessions and evidence to their declared shape', () => {
    expect(
      validateSpeakerEventData({
        status: 'accepted',
        sessions: [
          { title: ' Keynote ', abstract: 'x', slidesUrl: 'https://s', videoUrl: 'ftp://no' },
          { title: '' },
        ],
        evidence: [{ label: 'Photos', url: 'https://p' }, { url: 'nope' }],
        attendance: '120.7',
      }).value
    ).toEqual({
      status: 'accepted',
      sessions: [{ title: 'Keynote', abstract: 'x', slidesUrl: 'https://s', videoUrl: null }],
      evidence: [{ label: 'Photos', url: 'https://p' }],
      attendance: 120,
    });
  });

  it('merge:false replaces wholesale with creation stamps', async () => {
    const store = makeStore();
    const h = createAdminIdentityHandlers({ guard: guardWith(), store, ...fixed });
    await h.upsertSpeakerEvent(
      makeRequest({ docId: 'ev2', data: { name: 'New talk' }, merge: false }),
      context
    );
    expect(store.patchDoc).not.toHaveBeenCalled();
    expect(store.upsertDoc.mock.calls[0][1]).toMatchObject({
      id: 'ev2',
      name: 'New talk',
      createdAt: '2026-08-07T02:00:00.000Z',
      createdBy: 'first@hcw.dev',
    });
  });

  it('delete 404s a missing event and reports deletedBy on success', async () => {
    const h404 = createAdminIdentityHandlers({ guard: guardWith(), store: makeStore(), ...fixed });
    expect((await h404.deleteSpeakerEvent(makeRequest({ docId: 'nope' }), context)).status).toBe(
      404
    );

    const store = makeStore({ readDoc: vi.fn(async () => ({ id: 'ev1' })) });
    const h = createAdminIdentityHandlers({ guard: guardWith(), store, ...fixed });
    const res = await h.deleteSpeakerEvent(makeRequest({ docId: 'ev1' }), context);
    expect(JSON.parse(res.body)).toEqual({
      success: true,
      docId: 'ev1',
      deletedBy: 'first@hcw.dev',
    });
    expect(store.deleteDoc).toHaveBeenCalledWith('speakerevents', 'ev1');
  });

  it('400s malformed upsert/delete requests before touching the store', async () => {
    const store = makeStore();
    const h = createAdminIdentityHandlers({ guard: guardWith(), store, ...fixed });
    expect((await h.upsertSpeakerEvent(makeRequest({ data: {} }), context)).status).toBe(400);
    expect(
      (await h.upsertSpeakerEvent(makeRequest({ docId: 'x', data: [1] }), context)).status
    ).toBe(400);
    expect((await h.deleteSpeakerEvent(makeRequest({}), context)).status).toBe(400);
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(store.deleteDoc).not.toHaveBeenCalled();
  });
});
