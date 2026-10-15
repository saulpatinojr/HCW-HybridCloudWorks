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
import { buildContentImageUpdates } from './content-workflow.js';
import { ADMIN_CONFIG_PARTITION } from './cosmos-client.js';
import { fetchImage as defaultFetchImage, requireImageExtension } from './triggers/fetch-image.js';
import { sourceOf } from './cms/inline-images.js';
import { measureImage, sha256Hex } from './gallery/measure.js';
import { dateValue, GALLERY_MAX_LIMIT, parseGalleryListParams } from './gallery/filters.js';
import {
  GALLERY_COLLECTIONS,
  cleanFolder,
  cleanTagList,
  json,
  optionalInt,
  refuse,
} from './gallery/shared.js';
import { parseStorageRef } from './gallery/storage-ref.js';
import { buildMetadataPatch, validateGalleryImageMetadataRequest } from './gallery/metadata.js';
import {
  CONTENT_USAGE_PROJECTION,
  buildContentUsageIndex,
  normalizeGalleryRow,
} from './gallery/listing.js';
import { applyBulkAction, parseBulkRequest } from './gallery/bulk.js';
import { errorResponse } from './http/error-response.js';
import {
  fetchForImport,
  findImportDuplicate,
  importBlobPath,
  importFileName,
  importRefusal,
  importedImageDoc,
} from './gallery/import.js';

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

/** admin_config document the gallery's folder list lives in (ADR 0033 §4). */
export const GALLERY_FOLDERS_CONFIG_ID = 'gallery_folders';
export const GALLERY_FOLDER_LIMIT = 100;

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

// ── folders ───────────────────────────────────────────────────────────────

export const SEED_FOLDERS = Object.freeze([
  'default',
  'aws',
  'azure',
  'gcp',
  'finops',
  'architecture',
]);

/** The folder list a PUT may store: lowercased, deduplicated, `default` first. */
export function cleanFolderList(value) {
  const folders = new Set(['default']);
  for (const folder of Array.isArray(value) ? value : []) {
    const name = String(folder || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._ -]+/g, '-')
      .slice(0, 40);
    if (name) folders.add(name);
  }
  return [...folders].slice(0, GALLERY_FOLDER_LIMIT);
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
    context.warn?.('gallery blob delete failed:', ref.container, ref.blobName, error?.message);
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

async function readFolders(store) {
  const doc = await store
    .readDoc('admin_config', GALLERY_FOLDERS_CONFIG_ID, ADMIN_CONFIG_PARTITION)
    .catch(() => null);
  return cleanFolderList([...SEED_FOLDERS, ...(doc?.folders || [])]);
}

// ── usage ─────────────────────────────────────────────────────────────────

/** Why a usage read cannot start, or null. */
function usageRefusal(id, collection) {
  if (!id) return refuse(400, 'id required');
  if (!GALLERY_COLLECTIONS.includes(collection)) return refuse(400, 'Invalid collection');
  return null;
}

/** Live content documents pointing at `@u` through any image field. */
const USAGE_QUERY =
  `SELECT TOP 100 ${CONTENT_USAGE_PROJECTION} FROM c WHERE NOT IS_DEFINED(c.softDeletedAt) AND (` +
  'c.heroImageUrl = @u OR c.altCoverImage = @u OR c.contentImageUrl = @u OR c.coverImage = @u OR c["Cover Image"] = @u ' +
  'OR c.aiImageUrls.hero = @u OR c.aiImageUrls.secondary1 = @u OR c.aiImageUrls.secondary2 = @u OR c.aiImageUrls.secondary3 = @u OR c.aiImageUrls.content = @u ' +
  'OR ARRAY_CONTAINS(c.secondaryImageUrls, @u))';

/** Other rows generated for the same content and slot. */
const VARIANTS_QUERY =
  'SELECT TOP 50 c.id, c.imageUrl, c.title, c.createdAt, c.promptSet, c.promptName, c.approvalStatus, c.softDeletedAt, c.archivedAt FROM c WHERE c.contentId = @cid AND c.slot = @slot AND c.id != @id';

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
  const actor = (user) => user.email || user.preferred_username || user.oid || 'admin';
  const guarded = guardedWith(guard);
  const deleteOne = (target, context) => deleteOneRow({ store, storage }, target, context);
  const readBody = async (request) => (await request.json().catch(() => null)) || {};

  return {
    /** POST /api/saveContentImageOrder — source :4967; editor. */
    saveContentImageOrder: guarded(
      'editor',
      'saveContentImageOrder',
      'Failed to save image order',
      async ({ request, user }) => {
        const body = await readBody(request);
        const { contentId, imageUrls = [] } = body;
        if (!contentId || typeof contentId !== 'string') {
          return json(400, { error: 'contentId required' });
        }
        if (!Array.isArray(imageUrls)) {
          return json(400, { error: 'imageUrls array required' });
        }

        const contentData = await store.readDoc('content', contentId, contentId);
        if (!contentData) return json(404, { error: `content ${contentId} not found` });

        const updates = buildContentImageUpdates(imageUrls, contentData);
        await store.patchDoc('content', contentId, {
          heroImageUrl: updates.heroImageUrl || undefined,
          contentImageUrl: updates.contentImageUrl || undefined,
          altCoverImage: updates.altCoverImage || undefined,
          secondaryImageUrls:
            updates.secondaryImageUrls.length > 0 ? updates.secondaryImageUrls : undefined,
          aiImageUrls: updates.aiImageUrls,
          updatedAt: now().toISOString(),
          updatedBy: actor(user),
        });

        return json(200, { success: true, contentId, imageCount: imageUrls.length });
      }
    ),

    /** POST /api/updateGalleryImageMetadata — source :5156; editor; partial. */
    updateGalleryImageMetadata: guarded(
      'editor',
      'updateGalleryImageMetadata',
      'Failed to update image metadata',
      async ({ request, user }) => {
        const body = await readBody(request);
        const validated = validateGalleryImageMetadataRequest(body);
        if (!validated.ok) return json(validated.status, { error: validated.error });
        const { imageId, galleryCollection } = validated;

        const existing = await store.readDoc(galleryCollection, imageId, imageId);
        if (!existing) return json(404, { error: `${galleryCollection}/${imageId} not found` });

        const updateData = buildMetadataPatch(validated, {
          nowIso: now().toISOString(),
          actor: actor(user),
        });
        await store.patchDoc(galleryCollection, imageId, updateData);
        return json(200, { success: true, imageId, galleryCollection, ...updateData });
      }
    ),

    /** POST /api/createManualGalleryImageRecord — source :5304; editor. */
    createManualGalleryImageRecord: guarded(
      'editor',
      'createManualGalleryImageRecord',
      'Failed to create image record',
      async ({ request, user }) => {
        const body = await readBody(request);
        if (!String(body.imageUrl || '').trim()) {
          return json(400, { error: 'imageUrl required' });
        }

        const nowIso = now().toISOString();
        const who = actor(user);
        const customTags = cleanTagList(body.customTags);
        const title = String(body.title || '').trim() || 'Uploaded image';
        const doc = {
          id: uuid(),
          articleId: String(body.articleId || 'manual-upload').trim(),
          contentId: '',
          imageUrl: String(body.imageUrl).trim(),
          provider: String(body.provider || '').trim(),
          title,
          altText: String(body.altText || '').trim() || title,
          caption: String(body.caption || '').trim(),
          license: String(body.license || 'owned')
            .trim()
            .toLowerCase(),
          credit: String(body.credit || '').trim(),
          slot: String(body.slot || '').trim(),
          customTags,
          folder: cleanFolder(body.folder),
          archived: false,
          archivedAt: null,
          softDeletedAt: null,
          theme: String(body.theme || '').trim(),
          style: String(body.style || '').trim(),
          promptSet: String(body.promptSet || '').trim(),
          promptSetId: String(body.promptSet || '').trim(),
          promptName: String(body.promptName || '').trim(),
          promptTemplateVersion: String(body.promptTemplateVersion || '').trim(),
          approvalStatus: String(body.approvalStatus || 'approved').trim(),
          usageCount: 0,
          usedByContentIds: [],
          lastUsedAt: null,
          sourceCollection: 'manual_upload',
          storagePath: String(body.storagePath || '').trim(),
          width: optionalInt(body.width) ?? null,
          height: optionalInt(body.height) ?? null,
          bytes: optionalInt(body.bytes) ?? null,
          format:
            String(body.format || '')
              .trim()
              .toLowerCase()
              .replace(/^image\//, '') || null,
          sha256: /^[a-f0-9]{64}$/i.test(String(body.sha256 || ''))
            ? String(body.sha256).toLowerCase()
            : '',
          createdAt: nowIso,
          createdBy: who,
          updatedAt: nowIso,
          updatedBy: who,
        };
        await store.upsertDoc('generated_content_images', doc);
        return json(200, { success: true, imageId: doc.id });
      }
    ),

    /** POST /api/deleteCuratedGeneratedImage — source :7095; editor. */
    deleteCuratedGeneratedImage: guarded(
      'editor',
      'deleteCuratedGeneratedImage',
      'Failed to delete curated image',
      async ({ request, context }) => {
        const { articleId } = await readBody(request);
        if (!articleId || typeof articleId !== 'string') {
          return json(400, { error: 'articleId is required' });
        }
        const result = await deleteOne(
          { galleryCollection: 'curated_article_images', id: articleId },
          context
        );
        if (!result.ok) return json(result.status, { error: result.error });
        return json(200, {
          success: true,
          articleId,
          storageDeleted: result.storageDeleted,
          sharedWith: result.sharedWith,
        });
      }
    ),

    /** POST /api/deleteContentGeneratedImage — source :7193; editor. */
    deleteContentGeneratedImage: guarded(
      'editor',
      'deleteContentGeneratedImage',
      'Failed to delete generated image',
      async ({ request, context }) => {
        const { imageId } = await readBody(request);
        if (!imageId || typeof imageId !== 'string') {
          return json(400, { error: 'imageId is required' });
        }
        const result = await deleteOne(
          { galleryCollection: 'generated_content_images', id: imageId },
          context
        );
        if (!result.ok) return json(result.status, { error: result.error });
        return json(200, {
          success: true,
          imageId,
          contentId: result.contentId,
          slot: result.slot,
          sourceCollection: 'content',
          storageDeleted: result.storageDeleted,
          sharedWith: result.sharedWith,
        });
      }
    ),

    /**
     * POST /api/cms/images/bulk — { items: [{id, galleryCollection}], action,
     * addTags?, removeTags?, folder?, fields? } → per-item results. One
     * request for a selection, each item patched against ITS OWN document.
     */
    bulkGalleryImages: guarded(
      'editor',
      'bulkGalleryImages',
      'Failed to update images',
      async ({ request, context, user }) => {
        const body = await readBody(request);
        const parsed = parseBulkRequest(body);
        if (!parsed.ok) return json(parsed.status, { error: parsed.error });
        const { action, items } = parsed;
        const stamps = { nowIso: now().toISOString(), actor: actor(user) };
        const results = [];
        for (const item of items) {
          results.push(
            await applyBulkAction({ store, deleteOne }, { item, action, body, stamps, context })
          );
        }
        const updated = results.filter((r) => r.ok).length;
        return json(200, {
          success: updated > 0,
          action,
          updated,
          failed: results.length - updated,
          results,
        });
      }
    ),

    /** GET /api/cms/images/folders — the persisted folder list plus the seeds. */
    getGalleryFolders: guarded(
      'editor',
      'getGalleryFolders',
      'Failed to load folders',
      async () => json(200, { success: true, folders: await readFolders(store) }),
      { withMessage: false }
    ),

    /** PUT /api/cms/images/folders — { folders: [] } replaces the list. */
    putGalleryFolders: guarded(
      'editor',
      'putGalleryFolders',
      'Failed to save folders',
      async ({ request, user }) => {
        const body = await readBody(request);
        if (!Array.isArray(body.folders)) return json(400, { error: 'folders array required' });
        const folders = cleanFolderList(body.folders);
        const nowIso = now().toISOString();
        const existing = await store
          .readDoc('admin_config', GALLERY_FOLDERS_CONFIG_ID, ADMIN_CONFIG_PARTITION)
          .catch(() => null);
        if (existing) {
          await store.patchDoc(
            'admin_config',
            GALLERY_FOLDERS_CONFIG_ID,
            { folders, updatedAt: nowIso, updatedBy: actor(user) },
            { partitionKey: ADMIN_CONFIG_PARTITION }
          );
        } else {
          await store.upsertDoc('admin_config', {
            id: GALLERY_FOLDERS_CONFIG_ID,
            configScope: ADMIN_CONFIG_PARTITION,
            folders,
            createdAt: nowIso,
            updatedAt: nowIso,
            updatedBy: actor(user),
          });
        }
        return json(200, {
          success: true,
          folders: cleanFolderList([...SEED_FOLDERS, ...folders]),
        });
      },
      { withMessage: false }
    ),

    /**
     * POST /api/cms/images/import — { url, title?, folder?, tags?, provider?,
     * slot?, altText?, caption?, license?, credit?, force? }. Fetches through
     * the guarded fetcher (protocol and private-IP checks, size cap, media
     * type gate), stores under covers/image-gallery/imports/, creates the
     * record. A byte-identical or same-URL image already in the gallery
     * answers 409 with that record unless `force` is set.
     */
    importGalleryImage: guarded(
      'editor',
      'importGalleryImage',
      'Failed to import image',
      async ({ request, user }) => {
        const body = await readBody(request);
        const url = String(body.url || '').trim();
        const refused = importRefusal(url, storage);
        if (refused) return json(refused.status, { error: refused.error });

        const fetched = await fetchForImport(fetchImage, url);
        if (!fetched.ok) return json(fetched.status, { error: fetched.error });
        const { buffer, contentType } = fetched;
        const ext = requireImageExtension(contentType);
        const sha = sha256Hex(buffer);
        const source = sourceOf(url);

        const duplicate =
          body.force === true ? null : await findImportDuplicate(store, { sha, source });
        if (duplicate) {
          return json(409, {
            error: 'This image is already in the gallery',
            duplicateOf: duplicate.id,
            imageUrl: duplicate.imageUrl,
            title: duplicate.title,
          });
        }

        const nowIso = now().toISOString();
        const title = String(body.title || '').trim() || importFileName(url) || 'Imported image';
        const blobPath = importBlobPath(title, ext, nowIso);
        await storage.uploadBlob('covers', blobPath, buffer, contentType, { sourceUrl: source });
        const doc = importedImageDoc({
          id: uuid(),
          body,
          url,
          source,
          title,
          blobPath,
          buffer,
          contentType,
          ext,
          sha,
          nowIso,
          who: actor(user),
        });
        await store.upsertDoc('generated_content_images', doc);
        return json(200, {
          success: true,
          imageId: doc.id,
          imageUrl: doc.imageUrl,
          bytes: doc.bytes,
          width: doc.width,
          height: doc.height,
          format: ext,
        });
      }
    ),

    /**
     * GET /api/cms/images/{id}/usage?collection= — the content documents
     * using this image (by URL match on every image field) and its variants
     * (other rows for the same content and slot).
     */
    getImageUsage: guarded(
      'editor',
      'getImageUsage',
      'Failed to read image usage',
      async ({ request }) => {
        const id = String(request.params.id || '').trim();
        const collection = String(request.query.get('collection') || 'generated_content_images');
        const refused = usageRefusal(id, collection);
        if (refused) return json(refused.status, { error: refused.error });
        const row = await store.readDoc(collection, id, id);
        if (!row) return json(404, { error: `${collection}/${id} not found` });
        const item = normalizeGalleryRow(row, collection);
        const usedBy = item.imageUrl
          ? await store.queryDocs('content', USAGE_QUERY, [{ name: '@u', value: item.imageUrl }])
          : [];
        const usage = buildContentUsageIndex(usedBy).get(item.imageUrl) || [];
        const variants =
          item.contentId && item.slot
            ? await store.queryDocs('generated_content_images', VARIANTS_QUERY, [
                { name: '@cid', value: item.contentId },
                { name: '@slot', value: item.slot },
                { name: '@id', value: id },
              ])
            : [];
        return json(200, {
          success: true,
          id,
          imageUrl: item.imageUrl,
          usedBy: usage,
          usageCount: new Set(usage.map((u) => u.id)).size,
          variants: (variants || []).sort(
            (a, b) => dateValue(b.createdAt) - dateValue(a.createdAt)
          ),
        });
      },
      { withMessage: false }
    ),

    /** POST /api/deleteRejectedContent — source :2376/:5807; publisher. */
    deleteRejectedContent: guarded(
      'publisher',
      'deleteRejectedContent',
      'Failed to delete rejected content',
      async ({ request, auth }) => {
        const body = await readBody(request);
        const { olderThanHours = null, limit = 500 } = body;
        const maxLimit = Math.min(Number(limit) || 500, 499);
        const nowDate = now();
        const cutoffMs =
          typeof olderThanHours === 'number' && olderThanHours > 0
            ? nowDate.getTime() - olderThanHours * 60 * 60 * 1000
            : null;

        const rows = await store.queryDocs(
          'content',
          `SELECT TOP ${maxLimit} c.id, c["softDeletedAt"], c["rejectedAt"], c["reviewedAt"], c["updatedAt"] FROM c WHERE c.contentStatus = 'rejected'`,
          []
        );

        const dateOf = (d) => {
          const v = d.rejectedAt || d.reviewedAt || d.updatedAt;
          const parsed = v ? new Date(v) : null;
          return parsed && !Number.isNaN(parsed.getTime()) ? parsed.getTime() : null;
        };
        const toMark = rows.filter((d) => {
          if (d.softDeletedAt) return false;
          if (cutoffMs === null) return true;
          const ref = dateOf(d);
          return ref !== null && ref < cutoffMs;
        });

        const nowIso = nowDate.toISOString();
        for (const doc of toMark) {
          await store.patchDoc('content', doc.id, {
            softDeletedAt: nowIso,
            softDeletedReason: 'rejected_aged_out',
          });
        }

        if (toMark.length > 0) {
          await store.upsertDoc('admin_audit_logs', {
            id: uuid(),
            action: 'soft_deleted_rejected_content',
            actor: 'admin-rpc',
            userId: auth.user.oid ?? null,
            userEmail: auth.user.email || null,
            timestamp: nowIso,
            details: {
              affectedCount: toMark.length,
              examinedCount: rows.length,
              olderThanHours: typeof olderThanHours === 'number' ? olderThanHours : null,
              affectedIds: toMark.slice(0, 50).map((d) => d.id),
            },
            compliance: { schemaVersion: 1, detailsSanitized: true, identityVerified: true },
          });
        }

        return json(200, {
          success: true,
          deletedCount: toMark.length,
          softDeletedCount: toMark.length,
          examinedCount: rows.length,
          hasMore: rows.length === maxLimit,
        });
      }
    ),
  };
}
