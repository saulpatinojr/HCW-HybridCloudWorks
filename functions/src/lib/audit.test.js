import { describe, it, expect, vi } from 'vitest';
import {
  AUDIT_CONTAINER,
  AUDIT_TTL_SECONDS,
  validateClientAuditAction,
  sanitizeAuditDetails,
  recordMutationAudit,
} from './audit.js';

describe('audit.js (AP-B4, #939)', () => {
  describe('validateClientAuditAction', () => {
    it('accepts legitimate client audit actions from logAdminAction', () => {
      const allowed = [
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
      ];
      for (const action of allowed) {
        expect(validateClientAuditAction(action)).toBeNull();
      }
    });

    it('accepts custom actions with client.* prefix', () => {
      expect(validateClientAuditAction('client.custom_ui_action')).toBeNull();
    });

    it('strictly refuses forged setting updates and server actions', () => {
      const forged = [
        'setting_updated',
        'setting_created',
        'platform_setting_updated',
        'platform_settings_put',
        'workflow_alert_updated',
        'config_item_saved',
        'admin_bootstrap',
        'secret_rotated',
        'my_setting_change',
      ];
      for (const action of forged) {
        const err = validateClientAuditAction(action);
        expect(err).toBe('Action not permitted for client-originated audit logging');
      }
    });

    it('refuses unallowlisted random actions without client. prefix', () => {
      const err = validateClientAuditAction('arbitrary_action_name');
      expect(err).toContain('not an authorized client audit action');
    });

    it('refuses empty or excessively long actions', () => {
      expect(validateClientAuditAction('')).toBe('action is required');
      expect(validateClientAuditAction(null)).toBe('action is required');
      expect(validateClientAuditAction('a'.repeat(121))).toBe('action exceeds 120 characters');
    });
  });

  describe('sanitizeAuditDetails', () => {
    it('accepts valid small objects', () => {
      const res = sanitizeAuditDetails({ route: '/admin', id: 123 });
      expect(res.error).toBeUndefined();
      expect(res.details).toEqual({ route: '/admin', id: 123 });
    });

    it('rejects non-objects or arrays', () => {
      expect(sanitizeAuditDetails('string').error).toBe('details must be an object');
      expect(sanitizeAuditDetails([1, 2]).error).toBe('details must be an object');
      expect(sanitizeAuditDetails(null).error).toBe('details must be an object');
    });

    it('rejects details exceeding 4096 bytes', () => {
      const big = { data: 'x'.repeat(4500) };
      const res = sanitizeAuditDetails(big);
      expect(res.error).toContain('exceeds maximum allowed size');
    });
  });

  describe('recordMutationAudit', () => {
    it('writes a standardized row to admin_audit_logs with TTL and schema metadata', async () => {
      const store = { upsertDoc: vi.fn(async () => {}) };
      const actor = { oid: 'user-oid-1', email: 'admin@example.com', name: 'Admin User' };
      const now = () => new Date('2026-10-15T12:00:00.000Z');
      const uuid = () => 'audit-uuid-1';

      const doc = await recordMutationAudit(store, {
        action: 'certification_created',
        actor,
        resource: 'certifications:cert-123',
        before: null,
        after: { title: 'Azure Solutions Architect' },
        details: { vendor: 'Microsoft' },
        now,
        uuid,
      });

      expect(store.upsertDoc).toHaveBeenCalledWith(AUDIT_CONTAINER, {
        id: 'audit-uuid-1',
        action: 'certification_created',
        userId: 'user-oid-1',
        userName: 'Admin User',
        userEmail: 'admin@example.com',
        resource: 'certifications:cert-123',
        before: null,
        after: { title: 'Azure Solutions Architect' },
        details: { vendor: 'Microsoft' },
        timestamp: '2026-10-15T12:00:00.000Z',
        ttl: AUDIT_TTL_SECONDS,
        compliance: { schemaVersion: 2, appendOnly: true },
      });
      expect(doc.id).toBe('audit-uuid-1');
    });

    it('catches store errors gracefully and warns rather than throwing', async () => {
      const store = { upsertDoc: vi.fn(async () => { throw new Error('Cosmos unavailable'); }) };
      const warn = vi.fn();
      await expect(
        recordMutationAudit(store, {
          action: 'social_post_deleted',
          actor: { oid: 'u1' },
          context: { warn },
        })
      ).resolves.toBeDefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Cosmos unavailable'));
    });
  });
});
