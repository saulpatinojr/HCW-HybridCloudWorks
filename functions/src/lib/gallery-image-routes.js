/**
 * gallery-image-routes.js — the bodies of the Image Gallery routes, the
 * persisted folder list and the per-image usage read. gallery-images.js
 * wires each body behind the role guard (guardedWith) and re-exports the
 * folder names, so callers and tests import what they always did.
 *
 * Each route body takes the shared deps (store, storage, fetchImage, now,
 * uuid, deleteOne) and the guarded call's `{ request, context, auth, user }`.
 */
import { buildContentImageUpdates } from './content-workflow.js';
import { ADMIN_CONFIG_PARTITION } from './cosmos-client.js';
import { requireImageExtension } from './triggers/fetch-image.js';
import { sourceOf } from './cms/inline-images.js';
import { sha256Hex } from './gallery/measure.js';
import { dateValue } from './gallery/filters.js';
import {
  GALLERY_COLLECTIONS,
  cleanFolder,
  cleanTagList,
  json,
  optionalInt,
  refuse,
} from './gallery/shared.js';
import { buildMetadataPatch, validateGalleryImageMetadataRequest } from './gallery/metadata.js';
import {
  CONTENT_USAGE_PROJECTION,
  buildContentUsageIndex,
  normalizeGalleryRow,
} from './gallery/listing.js';
import { applyBulkAction, parseBulkRequest } from './gallery/bulk.js';
import {
  fetchForImport,
  findImportDuplicate,
  importBlobPath,
  importFileName,
  importRefusal,
  importedImageDoc,
} from './gallery/import.js';

export const GALLERY_FOLDERS_CONFIG_ID = 'gallery_folders';
export const GALLERY_FOLDER_LIMIT = 100;

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

export async function readFolders(store) {
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

// ── route bodies ──────────────────────────────────────────────────────────

const actor = (user) => user.email || user.preferred_username || user.oid || 'admin';
const readBody = async (request) => (await request.json().catch(() => null)) || {};

/** POST /api/saveContentImageOrder — source :4967; editor. */
export async function saveContentImageOrderRoute(deps, { request, user }) {
  const { store, now } = deps;
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

/** POST /api/updateGalleryImageMetadata — source :5156; editor; partial. */
export async function updateGalleryImageMetadataRoute(deps, { request, user }) {
  const { store, now } = deps;
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

/** POST /api/createManualGalleryImageRecord — source :5304; editor. */
export async function createManualGalleryImageRecordRoute(deps, { request, user }) {
  const { store, now, uuid } = deps;
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

/** POST /api/deleteCuratedGeneratedImage — source :7095; editor. */
export async function deleteCuratedGeneratedImageRoute(deps, { request, context }) {
  const { deleteOne } = deps;
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

/** POST /api/deleteContentGeneratedImage — source :7193; editor. */
export async function deleteContentGeneratedImageRoute(deps, { request, context }) {
  const { deleteOne } = deps;
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

/**
 * POST /api/cms/images/bulk — { items: [{id, galleryCollection}], action,
 * addTags?, removeTags?, folder?, fields? } → per-item results. One
 * request for a selection, each item patched against ITS OWN document.
 */
export async function bulkGalleryImagesRoute(deps, { request, context, user }) {
  const { store, now, deleteOne } = deps;
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

/** GET /api/cms/images/folders — the persisted folder list plus the seeds. */
export async function getGalleryFoldersRoute(deps, {}) {
  const { store } = deps;
  return json(200, { success: true, folders: await readFolders(store) });
}

/** PUT /api/cms/images/folders — { folders: [] } replaces the list. */
export async function putGalleryFoldersRoute(deps, { request, user }) {
  const { store, now } = deps;
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
}

/**
 * POST /api/cms/images/import — { url, title?, folder?, tags?, provider?,
 * slot?, altText?, caption?, license?, credit?, force? }. Fetches through
 * the guarded fetcher (protocol and private-IP checks, size cap, media
 * type gate), stores under covers/image-gallery/imports/, creates the
 * record. A byte-identical or same-URL image already in the gallery
 * answers 409 with that record unless `force` is set.
 */
export async function importGalleryImageRoute(deps, { request, user }) {
  const { store, storage, fetchImage, now, uuid } = deps;
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

/**
 * GET /api/cms/images/{id}/usage?collection= — the content documents
 * using this image (by URL match on every image field) and its variants
 * (other rows for the same content and slot).
 */
export async function getImageUsageRoute(deps, { request }) {
  const { store } = deps;
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
}

/** POST /api/deleteRejectedContent — source :2376/:5807; publisher. */
export async function deleteRejectedContentRoute(deps, { request, auth }) {
  const { store, now, uuid } = deps;
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
