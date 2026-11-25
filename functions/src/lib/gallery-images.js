/**
 * Gallery image-record RPCs — saveContentImageOrder,
 * updateGalleryImageMetadata, createManualGalleryImageRecord,
 * deleteCuratedGeneratedImage, deleteContentGeneratedImage,
 * deleteRejectedContent — plus, since ADR 0033 (Creative slice), the media
 * library the Image Gallery page is: `buildGalleryListing` (search, filters,
 * sort, pagination, usage and duplicate detection over both image
 * containers), bulk edits, persisted folders (admin_config/gallery_folders),
 * import-from-URL, and per-image usage.
 *
 * Ported from Site-Main cms-functions.js (:2376-2440, :4967-5330, :7095-7250).
 *
 * The pure parts live in ./gallery/ (PR #841), each re-exported from here so
 * the callers and tests that import them from this path still do:
 *   storage-ref.js  URL or path → the Azure blob it names (and why the
 *                   legacy Google branches stay, #518)
 *   metadata.js     the metadata request and the patch it produces (the
 *                   missing `slot` default is deliberate — see there)
 *   listing.js      the one row shape, usage index, duplicates, listing
 *   bulk.js         bulk edits against each item's own document
 *   import.js       import-from-URL
 *   filters.js, measure.js  the listing filters and the byte readers
 * What stays here is what touches the store and the blobs: the folder list,
 * the row delete, and the routes.
 *
 * A BLOB IS DELETED ONLY WHEN NO OTHER ROW POINTS AT IT. Before the stamped
 * paths, every regeneration of a slot wrote the same blob, so deleting an old
 * history row deleted the CURRENT cover's bytes. The delete now checks both
 * containers for another row with the same URL and leaves the blob when one
 * exists (`storageDeleted: false, sharedWith: n`).
 */
import { randomUUID } from 'node:crypto';
import { fetchImage as defaultFetchImage } from './triggers/fetch-image.js';
import { measureImage, sha256Hex } from './gallery/measure.js';
import { GALLERY_MAX_LIMIT, parseGalleryListParams } from './gallery/filters.js';
import { GALLERY_COLLECTIONS, refuse } from './gallery/shared.js';
import { parseStorageRef } from './gallery/storage-ref.js';
import { errorResponse, errorFacts } from './http/error-response.js';
import {
  saveContentImageOrderRoute,
  updateGalleryImageMetadataRoute,
  createManualGalleryImageRecordRoute,
  deleteCuratedGeneratedImageRoute,
  deleteContentGeneratedImageRoute,
  bulkGalleryImagesRoute,
  getGalleryFoldersRoute,
  putGalleryFoldersRoute,
  importGalleryImageRoute,
  getImageUsageRoute,
  deleteRejectedContentRoute,
} from './gallery-image-routes.js';

export { measureImage, sha256Hex, parseGalleryListParams, GALLERY_MAX_LIMIT };
export { GALLERY_COLLECTIONS } from './gallery/shared.js';
export { KNOWN_STORAGE_CONTAINERS, parseStorageRef } from './gallery/storage-ref.js';
export { validateGalleryImageMetadataRequest, buildMetadataPatch } from './gallery/metadata.js';
export {
  sourceIdFor,
  GALLERY_SOURCES,
  normalizeGalleryRow,
  CONTENT_USAGE_PROJECTION,
  buildContentUsageIndex,
  markDuplicates,
  buildGalleryListing,
} from './gallery/listing.js';
export { BULK_ACTIONS, BULK_LIMIT, buildBulkPatch } from './gallery/bulk.js';
export {
  GALLERY_FOLDERS_CONFIG_ID,
  GALLERY_FOLDER_LIMIT,
  SEED_FOLDERS,
  cleanFolderList,
} from './gallery-image-routes.js';

/** admin_config document the gallery's folder list lives in (ADR 0033 §4). */
/**
 * Source :7160 — dotted paths; undefined = patchDoc deletion. Extended under
 * ADR 0033 to scrub every field a content document can point at an image
 * with: the AI slot map and history, the hero/cover trio, and the secondary
 * list. Before, deleting a gallery row left `heroImageUrl` pointing at a blob
 * that no longer existed.
 */
export function buildContentImageRemovalUpdates(contentData, { slot, imageUrl }) {
  const currentHistory = Array.isArray(contentData.aiImageHistory?.[slot])
    ? contentData.aiImageHistory[slot]
    : [];
  const nextHistory = currentHistory.filter((url) => url !== imageUrl);
  const fallbackUrl = nextHistory[nextHistory.length - 1] || '';
  const updates = {
    [`aiImageHistory.${slot}`]: nextHistory.length > 0 ? nextHistory : undefined,
  };
  if ((contentData.aiImageUrls || {})[slot] === imageUrl) {
    updates[`aiImageUrls.${slot}`] = fallbackUrl || undefined;
  }
  if (slot === 'hero' && contentData.altCoverImage === imageUrl) {
    updates.altCoverImage = fallbackUrl || undefined;
  }
  for (const field of ['heroImageUrl', 'contentImageUrl', 'coverImage']) {
    if (contentData[field] === imageUrl) updates[field] = fallbackUrl || undefined;
  }
  const secondary = Array.isArray(contentData.secondaryImageUrls)
    ? contentData.secondaryImageUrls
    : [];
  if (secondary.includes(imageUrl)) {
    const remaining = secondary.filter((url) => url !== imageUrl);
    updates.secondaryImageUrls = remaining.length > 0 ? remaining : undefined;
  }
  return updates;
}

// ── store and blob operations the routes share ────────────────────────────

/**
 * The scaffold every route shares: the role guard, then the route body,
 * with any throw logged under `label` and answered as a 500 carrying
 * `message` (and the error's own message where the route always has). The
 * body answers everything else (PR #841).
 */
const guardedWith =
  (guard) =>
  (role, label, message, run, { withMessage = true } = {}) =>
  async (request, context) => {
    const auth = await guard.requireRole(request, role);
    if (auth.error) return auth.error;
    try {
      return await run({ request, context, auth, user: auth.user });
    } catch (error) {
      return errorResponse(context, message, error, 500, request);
    }
  };

/** Rows in either container (other than `excludeId`) that point at `imageUrl`. */
async function otherRowsSharing(store, imageUrl, excludeId) {
  if (!imageUrl || typeof store.queryDocs !== 'function') return 0;
  let count = 0;
  for (const collection of GALLERY_COLLECTIONS) {
    try {
      const rows = await store.queryDocs(
        collection,
        'SELECT TOP 10 c.id FROM c WHERE c.imageUrl = @url AND c.id != @id',
        [
          { name: '@url', value: imageUrl },
          { name: '@id', value: excludeId || '' },
        ]
      );
      count += (rows || []).length;
    } catch {
      // Counting is protective; an unreadable container reads as unshared.
    }
  }
  return count;
}

async function deleteBlobFor(storage, { imageUrl, storagePath }, context) {
  const ref = parseStorageRef(storagePath) || parseStorageRef(imageUrl);
  if (!ref) return false;
  try {
    await storage.deleteBlob(ref.container, ref.blobName);
    return true;
  } catch (error) {
    context.warn?.('gallery blob delete failed:', ref.container, errorFacts(error));
    return false;
  }
}

/** Scrub every reference to `imageUrl` on the content doc that owns a row. */
async function scrubContentReferences(store, { contentId, slot, imageUrl }) {
  if (!contentId || contentId === 'manual-upload') return;
  const contentData = await store.readDoc('content', contentId, contentId).catch(() => null);
  if (!contentData) return;
  const updates = buildContentImageRemovalUpdates(contentData, { slot, imageUrl });
  await store.patchDoc('content', contentId, updates);
}

/** Permanent delete of one row: blob (if unshared), content references, the row. */
async function deleteOneRow({ store, storage }, { galleryCollection, id }, context) {
  const row = await store.readDoc(galleryCollection, id, id);
  if (!row) return refuse(404, `${galleryCollection}/${id} not found`);
  const imageUrl = String(row.imageUrl || '').trim();
  const sharedWith = await otherRowsSharing(store, imageUrl, id);
  const storageDeleted =
    sharedWith > 0
      ? false
      : await deleteBlobFor(storage, { imageUrl, storagePath: row.storagePath }, context);

  const owned = galleryCollection === 'generated_content_images';
  const contentId = owned ? String(row.contentId || row.articleId || '').trim() : '';
  const slot = owned ? String(row.slot || 'hero').trim() : '';
  if (owned) await scrubContentReferences(store, { contentId, slot, imageUrl });
  await store.deleteDoc(galleryCollection, id);
  return { ok: true, id, galleryCollection, contentId, slot, storageDeleted, sharedWith };
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ queryDocs: Function, readDoc: Function, upsertDoc: Function, patchDoc: Function, deleteDoc: Function }} deps.store
 * @param {{ deleteBlob: Function, uploadBlob?: Function }} deps.storage
 * @param {Function} [deps.fetchImage] the guarded fetcher (import-from-URL)
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 */
export function createGalleryImageHandlers({
  guard,
  store,
  storage,
  fetchImage = defaultFetchImage,
  now = () => new Date(),
  uuid = randomUUID,
}) {
  const guarded = guardedWith(guard);
  const deps = {
    store,
    storage,
    fetchImage,
    now,
    uuid,
    deleteOne: (target, context) => deleteOneRow({ store, storage }, target, context),
  };
  /** A route body over the shared deps, as the guarded scaffold calls it. */
  const route = (body) => (args) => body(deps, args);

  return {
    saveContentImageOrder: guarded(
      'editor',
      'saveContentImageOrder',
      'Failed to save image order',
      route(saveContentImageOrderRoute)
    ),
    updateGalleryImageMetadata: guarded(
      'editor',
      'updateGalleryImageMetadata',
      'Failed to update image metadata',
      route(updateGalleryImageMetadataRoute)
    ),
    createManualGalleryImageRecord: guarded(
      'editor',
      'createManualGalleryImageRecord',
      'Failed to create image record',
      route(createManualGalleryImageRecordRoute)
    ),
    deleteCuratedGeneratedImage: guarded(
      'editor',
      'deleteCuratedGeneratedImage',
      'Failed to delete curated image',
      route(deleteCuratedGeneratedImageRoute)
    ),
    deleteContentGeneratedImage: guarded(
      'editor',
      'deleteContentGeneratedImage',
      'Failed to delete generated image',
      route(deleteContentGeneratedImageRoute)
    ),
    bulkGalleryImages: guarded(
      'editor',
      'bulkGalleryImages',
      'Failed to update images',
      route(bulkGalleryImagesRoute)
    ),
    getGalleryFolders: guarded(
      'editor',
      'getGalleryFolders',
      'Failed to load folders',
      route(getGalleryFoldersRoute),
      { withMessage: false }
    ),
    putGalleryFolders: guarded(
      'editor',
      'putGalleryFolders',
      'Failed to save folders',
      route(putGalleryFoldersRoute),
      { withMessage: false }
    ),
    importGalleryImage: guarded(
      'editor',
      'importGalleryImage',
      'Failed to import image',
      route(importGalleryImageRoute)
    ),
    getImageUsage: guarded(
      'editor',
      'getImageUsage',
      'Failed to read image usage',
      route(getImageUsageRoute),
      { withMessage: false }
    ),
    deleteRejectedContent: guarded(
      'publisher',
      'deleteRejectedContent',
      'Failed to delete rejected content',
      route(deleteRejectedContentRoute)
    ),
  };
}
