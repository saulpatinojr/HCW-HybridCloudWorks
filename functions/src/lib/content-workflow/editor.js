/**
 * saveEditorDraft and the pure rules under it: the image-slot shaping, the
 * edit-conflict check and the body validation (PR #841 split of
 * content-workflow.js; ported from Site-Main cms-functions.js :3340-3564).
 *
 * EDIT CONFLICT detection: the source compared blogEditedAt via Timestamp
 * .toMillis(). Cosmos stores ISO strings, so the comparison parses those too
 * — without this, every migrated (or previously port-saved) document would
 * read as 0 ms and force=false saves against stale editors would silently
 * succeed instead of 409ing.
 */
import { ensureTldrSectionAtEnd } from '../cms/content-quality.js';
import {
  ContentValidationError,
  assertStringLength,
  assertOptionalDateString,
} from '../cms/content-update-validation.js';
import { authoredMessage } from '../http/error-response.js';
import { actor, auditRow, json, readBody, workflowFailure } from './shared.js';

/**
 * The ordered image URLs of an editor save: absolute http(s), bounded.
 *
 * @param {unknown} [urls] - the list sent
 * @returns {string[]}
 * @throws {ContentValidationError}
 */
export function assertImageUrlList(urls = []) {
  if (!Array.isArray(urls)) {
    throw new ContentValidationError('orderedImageUrls must be an array');
  }
  return urls.map((value) => {
    const normalized = String(value || '').trim();
    if (!normalized) return normalized;
    if (!/^https?:\/\//i.test(normalized)) {
      throw new ContentValidationError('orderedImageUrls must contain absolute http(s) URLs');
    }
    if (normalized.length > 2048) {
      throw new ContentValidationError('orderedImageUrls contains an entry that exceeds 2048 characters');
    }
    return normalized;
  });
}

/** Source :596 — hero/secondary/aiImageUrls slots from the ordered list. */
export function buildContentImageUpdates(urls = [], existing = {}) {
  const normalized = (Array.isArray(urls) ? urls : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .slice(0, 4);

  const heroImageUrl = normalized[0] || null;
  const secondaryImageUrls = normalized.slice(1, 4);
  const nextAiImageUrls = {};
  ['hero', 'secondary1', 'secondary2', 'secondary3'].forEach((slot, index) => {
    if (normalized[index]) {
      nextAiImageUrls[slot] = normalized[index];
    }
  });

  if (existing?.aiImageUrls?.content && normalized.includes(existing.aiImageUrls.content)) {
    nextAiImageUrls.content = existing.aiImageUrls.content;
  }

  return {
    heroImageUrl,
    contentImageUrl: heroImageUrl,
    altCoverImage: heroImageUrl,
    secondaryImageUrls,
    aiImageUrls: nextAiImageUrls,
  };
}

/** Source :625 — cleared slots become deletions (undefined = patchDoc delete). */
export function buildContentImageFieldUpdates(imageUpdates = {}) {
  return {
    heroImageUrl: imageUpdates.heroImageUrl || undefined,
    contentImageUrl: imageUpdates.contentImageUrl || undefined,
    altCoverImage: imageUpdates.altCoverImage || undefined,
    secondaryImageUrls:
      Array.isArray(imageUpdates.secondaryImageUrls) && imageUpdates.secondaryImageUrls.length > 0
        ? imageUpdates.secondaryImageUrls
        : undefined,
    aiImageUrls: imageUpdates.aiImageUrls || {},
  };
}

/** Millis from Timestamp-like, Date, or ISO string — see header. */
export function editedAtMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

export function assertNoEditConflict(currentData, expectedEditedAtMs, force) {
  const currentEditedAtMs = editedAtMillis(currentData.blogEditedAt);
  if (!force && Number(currentEditedAtMs) !== Number(expectedEditedAtMs || 0)) {
    throw new Error('EDIT_CONFLICT');
  }
}

/** The comma-separated tag list, bounded; throws past the limits. */
function normalizedTagsOf(tags) {
  const normalizedTags = String(tags || '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
  if (normalizedTags.length > 25) {
    throw new ContentValidationError('tags exceeds 25 entries');
  }
  normalizedTags.forEach((tag) => {
    if (tag.length > 80) {
      throw new ContentValidationError('tag exceeds 80 characters');
    }
  });
  return normalizedTags;
}

/** Source :3396 — validate/normalize the saveEditorDraft body. */
export function validateSaveEditorDraftBody(body) {
  try {
    const normalizedDraft = ensureTldrSectionAtEnd(
      assertStringLength(body.draft, 'draft', 200000, { allowEmpty: true })
    );
    assertStringLength(body.title, 'title', 250, { allowEmpty: true });
    const resolvedAuthor =
      assertStringLength(body.authorName, 'authorName', 120, {
        allowEmpty: true,
      }).trim() || 'Hybrid Cloud Works';
    assertStringLength(body.summary, 'summary', 5000, { allowEmpty: true });
    assertStringLength(body.sidebarContent, 'sidebarContent', 12000, {
      allowEmpty: true,
    });
    const validatedImageUrls = assertImageUrlList(body.orderedImageUrls)
      .filter(Boolean)
      .slice(0, 4);
    const nextPublishedDate = assertOptionalDateString(body.publishedDate, 'publishedDate');
    const normalizedTags = normalizedTagsOf(body.tags);
    return {
      ok: true,
      normalizedDraft,
      resolvedAuthor,
      normalizedTags,
      validatedImageUrls,
      nextPublishedDate,
    };
  } catch (error) {
    // The validators' sentences are authored; anything else is not ours to show (#945).
    return { ok: false, error: authoredMessage(error, 'The draft could not be validated.') };
  }
}

/** The editor fields of a save body, defaulted as the route always has. */
function draftFields(body) {
  const {
    draft = '',
    title = '',
    authorName = '',
    publishedDate = '',
    summary = '',
    tags = '',
    sidebarContent = '',
    orderedImageUrls = [],
  } = body;
  return {
    draft,
    title,
    authorName,
    publishedDate,
    summary,
    tags,
    sidebarContent,
    orderedImageUrls,
  };
}

/**
 * Everything a draft save needs before it writes — the validated fields,
 * the current document and the conflict check — or the response refusing
 * it, in the order the route always checked: 400, 400, 404, 409.
 */
async function prepareDraftSave(store, body) {
  const { contentId, expectedEditedAtMs = 0, force = false } = body;
  if (!contentId || typeof contentId !== 'string') {
    return { error: json(400, { error: 'contentId required' }) };
  }
  const fields = draftFields(body);
  const validation = validateSaveEditorDraftBody(fields);
  if (!validation.ok) return { error: json(400, { error: validation.error }) };
  const currentData = await store.readDoc('content', contentId, contentId);
  if (!currentData) return { error: json(404, { error: `content ${contentId} not found` }) };
  try {
    assertNoEditConflict(currentData, expectedEditedAtMs, force);
  } catch {
    return { error: json(409, { error: 'EDIT_CONFLICT' }) };
  }
  return { contentId, force, fields, validation, currentData };
}

/**
 * The status a save leaves: a live article keeps its status through a save
 * — `published` with the Live flag is the canonical spelling, `published_*`
 * the Firestore-era one (ADR 0033 §1). Anything else becomes `editing`.
 */
function nextStatusOf(currentData) {
  const currentStatus = String(currentData.contentStatus || '');
  const staysPublished =
    currentStatus.startsWith('published_') ||
    (currentStatus === 'published' && currentData.Live === true);
  return staysPublished ? currentStatus : 'editing';
}

/** The content patch a draft save writes. */
function draftPatch({ fields, validation, currentData, nowIso, by }) {
  const { normalizedDraft, resolvedAuthor, normalizedTags, validatedImageUrls, nextPublishedDate } =
    validation;
  return {
    blogDraft: normalizedDraft,
    Title: String(fields.title || ''),
    title: String(fields.title || ''),
    editorAuthor: resolvedAuthor,
    siteAuthor: resolvedAuthor,
    publishedDate: nextPublishedDate,
    Summary: String(fields.summary || ''),
    summary: String(fields.summary || ''),
    sidebarContent: String(fields.sidebarContent || ''),
    Tags: normalizedTags,
    ...buildContentImageFieldUpdates(buildContentImageUpdates(validatedImageUrls, currentData)),
    blogEditedAt: nowIso,
    contentStatus: nextStatusOf(currentData),
    updatedAt: nowIso,
    updatedBy: by,
  };
}

/** The content_versions row a draft save records. */
function draftVersionRow({ id, contentId, force, fields, validation, currentData, nowIso, by }) {
  const { normalizedDraft, resolvedAuthor, normalizedTags, validatedImageUrls, nextPublishedDate } =
    validation;
  return {
    id,
    contentId,
    title: fields.title || currentData.Title || currentData.title || '',
    summary: fields.summary || currentData.Summary || currentData.summary || '',
    draft: normalizedDraft || '',
    authorName: resolvedAuthor || '',
    tags: normalizedTags || [],
    sidebarContent: fields.sidebarContent || '',
    publishedDate: nextPublishedDate || currentData.publishedDate || '',
    orderedImageUrls: validatedImageUrls || [],
    versionCreatedAt: nowIso,
    versionCreatedBy: by,
    versionReason: force ? 'draft_force_saved' : 'draft_saved',
  };
}

/** POST /api/saveEditorDraft — source :3437; 409 on edit conflict. */
export async function saveEditorDraft({ guard, store, now, uuid }, request, context) {
  const auth = await guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  const { user } = auth;

  try {
    const prepared = await prepareDraftSave(store, await readBody(request));
    if (prepared.error) return prepared.error;
    const { contentId, force, validation, currentData } = prepared;
    const currentTitle = currentData.Title || currentData.title || '';
    const nowIso = now().toISOString();
    const by = actor(user);

    await store.patchDoc('content', contentId, draftPatch({ ...prepared, nowIso, by }));
    await store.upsertDoc(
      'content_versions',
      draftVersionRow({ ...prepared, id: uuid(), nowIso, by })
    );
    await store.upsertDoc(
      'admin_audit_logs',
      auditRow(uuid, {
        action: force ? 'draft_force_saved' : 'draft_saved',
        user,
        request,
        details: {
          contentId,
          force: Boolean(force),
          fieldUpdated: 'blogDraft',
          imageCount: validation.validatedImageUrls.length,
        },
        contentId,
        contentTitle: currentTitle,
        nowIso,
      })
    );

    return json(200, {
      success: true,
      contentId,
      // The marker this write just stamped. The editor needs it for two
      // things it could not do without it (T-208):
      //
      //   1. Recognise its OWN write when the poll returns it. The client
      //      used a one-shot boolean, which was consumed by whatever the
      //      next poll happened to return — under `onSnapshot` that was our
      //      own write within milliseconds; under a 20-second poll it can be
      //      a collaborator's, and adopting their marker lets the next save
      //      pass this very conflict check and overwrite them silently.
      //   2. Send a correct `expectedEditedAtMs` on an immediately
      //      following save. Without it the client keeps the pre-save value
      //      until the next poll, so a second save inside the poll window
      //      conflicts with the caller's own previous one.
      blogEditedAt: nowIso,
      normalizedDraft: validation.normalizedDraft,
      editorAuthor: validation.resolvedAuthor,
      tagCount: validation.normalizedTags.length,
    });
  } catch (error) {
    return workflowFailure(context, 'saveEditorDraft', error, 'Failed to save draft');
  }
}
