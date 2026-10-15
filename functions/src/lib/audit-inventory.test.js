/**
 * audit-inventory.test.js — Audit trail inventory and client forgery defense tests (AP-B4, #939).
 *
 * Asserts:
 * 1. Client-originated audit logging strictly rejects forged `setting_updated`,
 *    `platform_setting_updated`, `workflow_alert_*`, `secret_*` actions and arbitrary verbs.
 * 2. Details payload size bounds are strictly enforced (max 4096 bytes).
 * 3. All audit writes target the unified `admin_audit_logs` container with TTL and immutability stamps.
 * 4. Mutating CMS/admin handlers emit audit records upon execution or are on an explicit exception list.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  AUDIT_CONTAINER,
  AUDIT_TTL_SECONDS,
  MAX_DETAILS_LENGTH,
  CLIENT_AUDIT_ACTIONS,
  validateClientAuditAction,
  sanitizeAuditDetails,
  recordMutationAudit,
} from './audit.js';
import { createCertificationHandlers } from './admin-crud/certifications.js';
import { createSocialPostHandlers } from './admin-crud/social-posts.js';
import { createBlogHandlers } from './admin-crud/blogs.js';
import { createSpeakerEventHandlers } from './admin-identity/speaker-events.js';
import { createAdminUploadHandlers } from './admin-uploads.js';

describe('AP-B4: Client audit validation and anti-forgery defense', () => {
  it('rejects forged setting updates and unauthorized action strings', () => {
    const forged = [
      'setting_updated',
      'setting_created',
      'platform_setting_updated',
      'platform_settings_saved',
      'workflow_alert_resolved',
      'workflow_alert_reopened',
      'config_updated',
      'admin_bootstrap',
      'secret_rotated',
      'arbitrary_unregistered_action',
      'delete_everything',
    ];

    for (const action of forged) {
      const err = validateClientAuditAction(action);
      expect(err, `Action '${action}' should be refused`).not.toBeNull();
    }
  });

  it('permits allowlisted client actions and namespaced client.* actions', () => {
    for (const action of CLIENT_AUDIT_ACTIONS) {
      expect(validateClientAuditAction(action)).toBeNull();
    }

    expect(validateClientAuditAction('client.dashboard_viewed')).toBeNull();
    expect(validateClientAuditAction('client.custom_event')).toBeNull();
  });

  it('rejects empty or overly long action strings', () => {
    expect(validateClientAuditAction('')).toBe('action is required');
    expect(validateClientAuditAction('   ')).toBe('action is required');
    expect(validateClientAuditAction(null)).toBe('action is required');
    expect(validateClientAuditAction('a'.repeat(121))).toBe('action exceeds 120 characters');
  });

  it('rejects non-object or oversized details payloads', () => {
    expect(sanitizeAuditDetails('string').error).toBe('details must be an object');
    expect(sanitizeAuditDetails([1, 2, 3]).error).toBe('details must be an object');
    expect(sanitizeAuditDetails(null).error).toBe('details must be an object');

    const largeDetails = { data: 'x'.repeat(MAX_DETAILS_LENGTH + 10) };
    expect(sanitizeAuditDetails(largeDetails).error).toContain('maximum allowed size');

    const validDetails = { key: 'value', count: 42 };
    expect(sanitizeAuditDetails(validDetails)).toEqual({ details: validDetails });
  });
});

describe('AP-B4: Unified audit record format and TTL', () => {
  it('writes standard schema with TTL (90 days) and appendOnly compliance stamp', async () => {
    const store = { upsertDoc: vi.fn(async () => {}) };
    const now = () => new Date('2026-10-15T12:00:00.000Z');
    const uuid = () => 'test-audit-uuid-1';

    const doc = await recordMutationAudit(store, {
      action: 'test_mutation',
      actor: { oid: 'user-oid-1', name: 'Test User', email: 'test@hcw.dev' },
      resource: 'test_container:item-1',
      before: { value: 1 },
      after: { value: 2 },
      details: { extra: 'info' },
      now,
      uuid,
    });

    expect(store.upsertDoc).toHaveBeenCalledWith(AUDIT_CONTAINER, doc);
    expect(doc).toEqual({
      id: 'test-audit-uuid-1',
      action: 'test_mutation',
      userId: 'user-oid-1',
      userName: 'Test User',
      userEmail: 'test@hcw.dev',
      resource: 'test_container:item-1',
      before: { value: 1 },
      after: { value: 2 },
      details: { extra: 'info' },
      timestamp: '2026-10-15T12:00:00.000Z',
      ttl: AUDIT_TTL_SECONDS,
      compliance: {
        schemaVersion: 2,
        appendOnly: true,
      },
    });
    expect(AUDIT_TTL_SECONDS).toBe(90 * 86400);
  });
});

describe('AP-B4: Mutating handlers audit inventory', () => {
  const allowGuard = {
    requireRole: vi.fn(async () => ({
      user: { oid: 'editor-1', name: 'Editor User', email: 'editor@hcw.dev' },
      role: 'editor',
      error: null,
    })),
  };

  const fixed = {
    now: () => new Date('2026-10-15T12:00:00.000Z'),
    uuid: () => 'fixed-uuid',
    actor: (u) => u?.email || 'editor@hcw.dev',
  };

  const makeReq = ({ body, params = {}, query = {} } = {}) => ({
    params,
    query: { get: (k) => query[k] ?? null },
    headers: { get: () => 'vitest' },
    json: async () => {
      if (body === undefined) throw new SyntaxError('no body');
      return body;
    },
  });

  const context = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };

  it('certifications mutations audit create, update, delete, and image delete', async () => {
    const store = {
      queryDocs: vi.fn(async () => []),
      readDoc: vi.fn(async () => ({ id: 'c1', name: 'Cert' })),
      upsertDoc: vi.fn(async () => {}),
      patchDoc: vi.fn(async () => ({ id: 'c1', featured: true })),
      deleteDoc: vi.fn(async () => {}),
    };
    const storage = { deleteBlob: vi.fn(async () => {}) };

    const h = createCertificationHandlers({ guard: allowGuard, store, storage, ...fixed });

    await h.createCertification(makeReq({ body: { name: 'New Cert' } }), context);
    expect(store.upsertDoc).toHaveBeenCalledWith(
      AUDIT_CONTAINER,
      expect.objectContaining({ action: 'certification_created' })
    );

    store.upsertDoc.mockClear();
    await h.patchCertification(makeReq({ params: { id: 'c1' }, body: { featured: true } }), context);
    expect(store.upsertDoc).toHaveBeenCalledWith(
      AUDIT_CONTAINER,
      expect.objectContaining({ action: 'certification_updated' })
    );

    store.upsertDoc.mockClear();
    await h.deleteCertification(makeReq({ params: { id: 'c1' } }), context);
    expect(store.upsertDoc).toHaveBeenCalledWith(
      AUDIT_CONTAINER,
      expect.objectContaining({ action: 'certification_deleted' })
    );

    store.upsertDoc.mockClear();
    await h.deleteCertificationImage(makeReq({ body: { path: 'c1/images/badge-1.png' } }), context);
    expect(store.upsertDoc).toHaveBeenCalledWith(
      AUDIT_CONTAINER,
      expect.objectContaining({ action: 'certification_image_deleted' })
    );
  });

  it('social posts mutations audit create, patch, and delete', async () => {
    const store = {
      readDoc: vi.fn(async () => ({ id: 's1', status: 'scheduled', scheduledAt: '2026-10-20T12:00:00Z' })),
      upsertDoc: vi.fn(async () => {}),
      patchDoc: vi.fn(async () => ({ id: 's1', caption: 'Updated' })),
      deleteDoc: vi.fn(async () => {}),
    };

    const h = createSocialPostHandlers({ guard: allowGuard, store, unpublishSocialPost: null, ...fixed });

    await h.createSocialPost(
      makeReq({ body: { text: 'Post text', scheduledAt: '2026-10-20T12:00:00Z', platforms: ['x'] } }),
      context
    );
    expect(store.upsertDoc).toHaveBeenCalledWith(
      AUDIT_CONTAINER,
      expect.objectContaining({ action: 'social_post_created' })
    );

    store.upsertDoc.mockClear();
    await h.patchSocialPost(
      makeReq({ params: { id: 's1' }, body: { caption: 'Updated', scheduledAt: '2026-10-21T12:00:00Z' } }),
      context
    );
    expect(store.upsertDoc).toHaveBeenCalledWith(
      AUDIT_CONTAINER,
      expect.objectContaining({ action: 'social_post_updated' })
    );

    store.upsertDoc.mockClear();
    await h.deleteSocialPost(makeReq({ params: { id: 's1' } }), context);
    expect(store.upsertDoc).toHaveBeenCalledWith(
      AUDIT_CONTAINER,
      expect.objectContaining({ action: 'social_post_deleted' })
    );
  });

  it('speaker events mutations audit upsert and delete', async () => {
    const store = {
      readDoc: vi.fn(async () => ({ id: 'ev1', name: 'Talk' })),
      upsertDoc: vi.fn(async () => {}),
      patchDoc: vi.fn(async () => ({})),
      deleteDoc: vi.fn(async () => {}),
    };

    const h = createSpeakerEventHandlers({ guard: allowGuard, store, ...fixed });

    await h.upsertSpeakerEvent(
      makeReq({ body: { docId: 'ev1', data: { name: 'Keynote', date: '2026-11-01' } } }),
      context
    );
    expect(store.upsertDoc).toHaveBeenCalledWith(
      AUDIT_CONTAINER,
      expect.objectContaining({ action: 'speaker_event_upserted' })
    );

    store.upsertDoc.mockClear();
    await h.deleteSpeakerEvent(makeReq({ body: { docId: 'ev1' } }), context);
    expect(store.upsertDoc).toHaveBeenCalledWith(
      AUDIT_CONTAINER,
      expect.objectContaining({ action: 'speaker_event_deleted' })
    );
  });

  it('admin upload handler audits completed uploads when store is supplied', async () => {
    const store = { upsertDoc: vi.fn(async () => {}) };
    const storage = { uploadBlob: vi.fn(async () => 'https://blob/img.png') };

    const h = createAdminUploadHandlers({
      guard: allowGuard,
      storage,
      store,
      normalizeImage: async (buf, { contentType }) => ({ buffer: buf, contentType, extension: 'png' }),
      ...fixed,
    });

    const res = await h.uploadFile(
      makeReq({
        params: { container: 'certifications' },
        body: {
          path: 'cert-1/images/badge.png',
          contentType: 'image/png',
          dataBase64: Buffer.from('png-data').toString('base64'),
        },
      }),
      context
    );

    expect(res.status).toBe(200);
    expect(store.upsertDoc).toHaveBeenCalledWith(
      AUDIT_CONTAINER,
      expect.objectContaining({
        action: 'admin_upload_completed',
        resource: 'certifications:cert-1/images/badge.png',
      })
    );
  });

  it('blog delete audits to admin_audit_logs with TTL', async () => {
    const store = {
      readDoc: vi.fn(async () => ({ id: 'b1', title: 'Test Blog' })),
      deleteDoc: vi.fn(async () => {}),
      upsertDoc: vi.fn(async () => {}),
    };

    const h = createBlogHandlers({
      guard: {
        requireRole: vi.fn(async () => ({
          user: { oid: 'publisher-1', email: 'pub@hcw.dev' },
          role: 'publisher',
          error: null,
        })),
      },
      store,
      ...fixed,
    });

    const res = await h.deleteBlog(makeReq({ params: { id: 'b1' } }), context);
    expect(res.status).toBe(200);
    expect(store.upsertDoc).toHaveBeenCalledWith(
      AUDIT_CONTAINER,
      expect.objectContaining({
        action: 'blog_deleted',
        ttl: AUDIT_TTL_SECONDS,
      })
    );
  });
});
