/**
 * Bulk edits over a selection of gallery rows: the request's shape and the
 * patch each action writes against the item's OWN document (PR #841 split
 * of gallery-images.js).
 */
import { GALLERY_COLLECTIONS, cleanFolder, cleanTagList, refuse } from './shared.js';
import { errorCode } from '../http/error-response.js';
import { buildMetadataPatch, validateGalleryImageMetadataRequest } from './metadata.js';

export const BULK_ACTIONS = Object.freeze([
  'tag',
  'move',
  'archive',
  'restore',
  'trash',
  'untrash',
  'delete',
  'set',
]);
export const BULK_LIMIT = 200;

/** The item's tags with `removeTags` taken away and `addTags` added. */
function toggledTags(existing, body) {
  const add = cleanTagList(body.addTags);
  const remove = new Set(cleanTagList(body.removeTags));
  const current = cleanTagList(existing.customTags);
  return [...new Set([...current.filter((t) => !remove.has(t)), ...add])];
}

/** Action → the fields it writes on one item, beside the update stamps. */
const BULK_PATCHES = Object.freeze({
  tag: (existing, body) => ({ customTags: toggledTags(existing, body) }),
  move: (_existing, body) => ({ folder: cleanFolder(body.folder) }),
  archive: (_existing, _body, { nowIso }) => ({ archived: true, archivedAt: nowIso }),
  restore: () => ({ archived: false, archivedAt: null, softDeletedAt: null }),
  trash: (_existing, _body, { nowIso }) => ({ softDeletedAt: nowIso }),
  untrash: () => ({ softDeletedAt: null }),
  set: (existing, body, stamps) => {
    const validated = validateGalleryImageMetadataRequest({
      imageId: existing.id,
      galleryCollection: 'generated_content_images',
      ...(body.fields || {}),
    });
    return validated.ok ? buildMetadataPatch(validated, stamps) : {};
  },
});

/**
 * The patch one bulk action produces for one item, given the item's own
 * tags. `tag` ADDS and REMOVES against what the item has — the whole point:
 * the page used to send the toggle set as the new tag list, erasing every
 * tag not on screen.
 */
export function buildBulkPatch(action, existing, body, { nowIso, actor }) {
  const build = Object.hasOwn(BULK_PATCHES, action) ? BULK_PATCHES[action] : null;
  if (!build) return null;
  return { updatedAt: nowIso, updatedBy: actor, ...build(existing, body, { nowIso, actor }) };
}

/** `{ action, items }` of a bulk body, bounded, or the 400 to answer. */
export function parseBulkRequest(body) {
  const action = String(body.action || '').trim();
  if (!BULK_ACTIONS.includes(action)) {
    return refuse(400, `action must be one of ${BULK_ACTIONS.join(', ')}`);
  }
  const items = (Array.isArray(body.items) ? body.items : [])
    .map((item) => ({
      id: String(item?.id || '').trim(),
      galleryCollection: String(item?.galleryCollection || 'generated_content_images'),
    }))
    .filter((item) => item.id && GALLERY_COLLECTIONS.includes(item.galleryCollection));
  if (!items.length) return refuse(400, 'items required');
  if (items.length > BULK_LIMIT) return refuse(400, `At most ${BULK_LIMIT} items per request`);
  return { ok: true, action, items };
}

/** One bulk item: deleted, or patched against ITS OWN document. Never throws. */
export async function applyBulkAction(
  { store, deleteOne },
  { item, action, body, stamps, context }
) {
  try {
    if (action === 'delete') {
      const result = await deleteOne(item, context);
      return result.ok
        ? { id: item.id, ok: true, storageDeleted: result.storageDeleted }
        : { id: item.id, ok: false, error: result.error };
    }
    const existing = await store.readDoc(item.galleryCollection, item.id, item.id);
    if (!existing) return { id: item.id, ok: false, error: 'not found' };
    const patch = buildBulkPatch(action, existing, body, stamps);
    await store.patchDoc(item.galleryCollection, item.id, patch);
    return { id: item.id, ok: true, customTags: patch.customTags };
  } catch (error) {
    // Per item in the answer, so the store's code and never its sentence (#945).
    return { id: item.id, ok: false, error: `failed (${errorCode(error)})` };
  }
}
