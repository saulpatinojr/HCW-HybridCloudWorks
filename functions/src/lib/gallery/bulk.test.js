/**
 * The bulk request's shape and the per-item apply (PR #841 split of
 * gallery-images.js). The route-level behaviour stays pinned in
 * gallery-images.test.js; these pin the seams the split exposed.
 */
import { describe, it, expect, vi } from 'vitest';
import { BULK_LIMIT, applyBulkAction, parseBulkRequest } from './bulk.js';

describe('parseBulkRequest', () => {
  it('refuses an unknown action with the list of known ones', () => {
    const parsed = parseBulkRequest({ action: 'explode', items: [{ id: 'a' }] });
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe(400);
    expect(parsed.error).toMatch(/action must be one of .*tag.*delete/);
  });

  it('drops items with no id or an unknown collection, and refuses an empty list', () => {
    const parsed = parseBulkRequest({
      action: 'tag',
      items: [{ id: '' }, { id: 'x', galleryCollection: 'nope' }],
    });
    expect(parsed).toEqual({ ok: false, status: 400, error: 'items required' });
  });

  it('defaults the collection and bounds the list', () => {
    const parsed = parseBulkRequest({ action: 'move', items: [{ id: ' a ' }] });
    expect(parsed).toEqual({
      ok: true,
      action: 'move',
      items: [{ id: 'a', galleryCollection: 'generated_content_images' }],
    });
    const tooMany = parseBulkRequest({
      action: 'move',
      items: Array.from({ length: BULK_LIMIT + 1 }, (_, i) => ({ id: `i${i}` })),
    });
    expect(tooMany.status).toBe(400);
    expect(tooMany.error).toMatch(String(BULK_LIMIT));
  });
});

describe('applyBulkAction', () => {
  const stamps = { nowIso: '2026-10-03T00:00:00.000Z', actor: 'editor@hcw' };
  const item = { id: 'img-1', galleryCollection: 'generated_content_images' };

  it('patches an existing item against its own tags', async () => {
    const store = {
      readDoc: vi.fn(async () => ({ id: 'img-1', customTags: ['keep', 'drop'] })),
      patchDoc: vi.fn(async () => ({})),
    };
    const result = await applyBulkAction(
      { store, deleteOne: vi.fn() },
      { item, action: 'tag', body: { addTags: ['new'], removeTags: ['drop'] }, stamps, context: {} }
    );
    expect(result).toEqual({ id: 'img-1', ok: true, customTags: ['keep', 'new'] });
    expect(store.patchDoc.mock.calls[0][2]).toMatchObject({
      customTags: ['keep', 'new'],
      updatedBy: 'editor@hcw',
    });
  });

  it('answers not found for a missing item and never throws', async () => {
    const store = {
      readDoc: vi.fn(async () => null),
      patchDoc: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const missing = await applyBulkAction(
      { store, deleteOne: vi.fn() },
      { item, action: 'archive', body: {}, stamps, context: {} }
    );
    expect(missing).toEqual({ id: 'img-1', ok: false, error: 'not found' });

    store.readDoc = vi.fn(async () => ({ id: 'img-1' }));
    const failed = await applyBulkAction(
      { store, deleteOne: vi.fn() },
      { item, action: 'archive', body: {}, stamps, context: {} }
    );
    // The store's code, never its sentence (#945).
    expect(failed).toEqual({ id: 'img-1', ok: false, error: 'failed (Error)' });
  });

  it('hands a delete to the row delete and reports its storage outcome', async () => {
    const deleteOne = vi.fn(async () => ({ ok: true, storageDeleted: false }));
    const result = await applyBulkAction(
      { store: {}, deleteOne },
      { item, action: 'delete', body: {}, stamps, context: { warn: vi.fn() } }
    );
    expect(deleteOne).toHaveBeenCalledWith(item, expect.any(Object));
    expect(result).toEqual({ id: 'img-1', ok: true, storageDeleted: false });
  });
});
