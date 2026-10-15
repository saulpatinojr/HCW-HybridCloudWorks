/**
 * Content workflow write RPCs — saveEditorDraft, unpublishContentToInspected,
 * deleteContentItem, saveContentSchedule, unscheduleContent, softDeleteLivePage,
 * requestContentInspection, resetContentReviewState.
 *
 * Ported from Site-Main cms-functions.js (:3340-3564, :4635-4985, :5827-5906)
 * on patchDoc partial writes, with the sequential-writes-content-first
 * ordering established in content-update.js replacing Firestore transactions.
 *
 * Adaptations, each deliberate:
 *   - EDIT CONFLICT detection (saveEditorDraft): the source compared
 *     blogEditedAt via Timestamp .toMillis(). Cosmos stores ISO strings, so
 *     the comparison parses those too — without this, every migrated (or
 *     previously port-saved) document would read as 0 ms and force=false
 *     saves against stale editors would silently succeed instead of 409ing.
 *   - buildContentImageFieldUpdates' FieldValue.delete() becomes patchDoc's
 *     `undefined` deletion for cleared image slots.
 *   - deleteContentItem tolerates deleting a missing doc (Firestore .delete()
 *     is a no-op there; Cosmos 404s), deletes under the read's ETag, and
 *     writes its own audit row (see the handler).
 *   - softDeleteLivePage keeps the source's resolution order (contentId, then
 *     blogId as a legacy alias for the content id) and its `blogRefs: []` —
 *     the legacy blogs fan-out was already retired upstream.
 *
 * Each handler is a module-level function over `ctx` — the factory's deps —
 * and the factory only binds them (PR #841). The editor save and its pure
 * rules are in ./content-workflow/editor.js, the schedule routes in
 * ./content-workflow/schedule.js; both are re-exported here so every caller
 * and test keeps its import path.
 */
import { randomUUID } from 'node:crypto';
import { normalizeCurrentStatusForBlogOnly } from './cms/content-update-validation.js';
import { actor, auditRow, json, readBody, workflowFailure } from './content-workflow/shared.js';
import { saveEditorDraft } from './content-workflow/editor.js';
import { saveContentSchedule, unscheduleContent } from './content-workflow/schedule.js';

export {
  assertImageUrlList,
  buildContentImageUpdates,
  buildContentImageFieldUpdates,
  editedAtMillis,
  assertNoEditConflict,
  validateSaveEditorDraftBody,
} from './content-workflow/editor.js';

const UNPUBLISHABLE_STATUSES = ['published', 'approved'];

/** Why an unpublish cannot proceed, as the response to send, or null. */
function unpublishRefusal({ contentId, validId, notesOk, currentData, previousStatus }) {
  if (!validId) return json(400, { error: 'contentId required' });
  if (!notesOk) return json(400, { error: 'reviewNotes exceeds 5000 characters' });
  if (!currentData) return json(404, { error: `content ${contentId} not found` });
  if (!UNPUBLISHABLE_STATUSES.includes(previousStatus)) {
    return json(400, {
      error: `Cannot unpublish content from status ${previousStatus}`,
      allowedStatuses: UNPUBLISHABLE_STATUSES,
    });
  }
  return null;
}

/** POST /api/unpublishContentToInspected — source :4635; publisher. */
async function unpublishContentToInspected({ guard, store, now, uuid }, request, context) {
  const auth = await guard.requireRole(request, 'publisher');
  if (auth.error) return auth.error;
  const { user } = auth;

  try {
    const { contentId, reviewNotes = '' } = await readBody(request);
    const validId = Boolean(contentId) && typeof contentId === 'string';
    const notesOk = String(reviewNotes || '').length <= 5000;
    const currentData =
      validId && notesOk ? await store.readDoc('content', contentId, contentId) : null;
    const previousStatus = normalizeCurrentStatusForBlogOnly(
      currentData?.contentStatus || 'ingested'
    );
    const refusal = unpublishRefusal({ contentId, validId, notesOk, currentData, previousStatus });
    if (refusal) return refusal;
    const contentTitle = currentData.Title || currentData.title || '';

    const nowIso = now().toISOString();
    await store.patchDoc('content', contentId, {
      contentStatus: 'inspected',
      Live: false,
      approvedForNews: false,
      scheduledPublishDate: null,
      reviewNotes: String(reviewNotes || ''),
      reviewedAt: nowIso,
      reviewedBy: actor(user),
      updatedAt: nowIso,
      updatedBy: actor(user),
    });

    await store.upsertDoc(
      'admin_audit_logs',
      auditRow(uuid, {
        action: 'content_unpublished',
        user,
        request,
        details: {
          contentId,
          fromStatus: previousStatus,
          toStatus: 'inspected',
          reviewNotes: String(reviewNotes || ''),
        },
        contentId,
        contentTitle,
        nowIso,
      })
    );

    return json(200, {
      success: true,
      contentId,
      from: previousStatus,
      to: 'inspected',
    });
  } catch (error) {
    return workflowFailure(
      context,
      'unpublishContentToInspected',
      error,
      'Failed to unpublish content'
    );
  }
}

export const DELETE_CHANGED_SINCE_READ =
  'This item changed since it was read and was not deleted; reload and try again.';

/**
 * Why a delete must not go ahead, as the response to send, or null: a body
 * whose `expectedStatus` is not a string, or a document no longer in the
 * status the caller read it in.
 */
function deleteRefusal(doc, expectedStatus) {
  if (expectedStatus === null) return null;
  if (typeof expectedStatus !== 'string' || !expectedStatus) {
    return json(400, { error: 'expectedStatus must be a non-empty string when provided' });
  }
  const current = normalizeCurrentStatusForBlogOnly(doc.contentStatus || 'ingested');
  if (current === normalizeCurrentStatusForBlogOnly(expectedStatus)) return null;
  return json(409, {
    error: `This item is ${current} now, not ${expectedStatus}, and was not deleted; reload to see where it is.`,
    code: 'STATUS_CHANGED',
    currentStatus: current,
  });
}

/**
 * The `audits` row for a hard delete, in the shape the status transitioner
 * writes (cms/content-update.js): who, which document, its title and the
 * status it was deleted from.
 */
const deletionAuditRow = (uuid, { user, request, doc, expectedStatus, nowIso }) => ({
  id: uuid(),
  timestamp: nowIso,
  action: 'content_deleted',
  resourceType: 'content',
  resourceId: doc.id,
  resourceTitle: doc.Title || doc.title || '',
  userId: user.oid || user.sub || actor(user),
  userName: user.name || null,
  userEmail: user.email || null,
  changes: {
    before: { contentStatus: doc.contentStatus || 'ingested' },
    after: null,
    changedFields: [],
    notes: '',
  },
  ipAddress: null, // as the transitioner: no trustworthy source yet
  userAgent: request.headers?.get?.('user-agent') || null,
  metadata: {
    ...(expectedStatus ? { expectedStatus } : {}),
    authMethod: 'entra_bearer_token',
    reviewedBy: actor(user),
  },
  compliance: {
    dataClassification: 'internal',
    retentionMonths: 24,
    identityVerified: true,
  },
});

/**
 * Delete the document only if it is still the version that was read. True
 * when this call deleted it; false when it was already gone (Firestore's
 * .delete() on a missing doc is a no-op; keep that). A document that moved
 * in between throws the 412.
 */
async function deleteAsRead(store, doc) {
  try {
    await store.deleteDocIfMatch('content', doc.id, doc._etag);
    return true;
  } catch (err) {
    if (err?.code === 404) return false;
    throw err;
  }
}

/**
 * POST /api/deleteContentItem — source :4724; publisher; hard delete.
 *
 * DECIDED FROM A READ, WRITTEN UNDER ITS ETAG (AP-F13, #937). The Archive
 * board offers Delete permanently on a row it read as archived, and another
 * session may have restored that page since; deleting it then would take a
 * live page down for good. So a body may name the `expectedStatus` the
 * caller read the item in, and the delete goes ahead only while the stored
 * document is still in it (409 `STATUS_CHANGED` otherwise); and every delete
 * is conditioned on the `_etag` of the read it was decided from
 * (deleteDocIfMatch), so a document that moved in between is refused with a
 * 409 and kept. The Archive board names `archived`. The Review Queue's
 * rejected delete and the framework review's delete name none, and keep
 * their rules: the framework page deletes from any review status.
 *
 * AUDITED HERE. The one action with no way back writes its own `audits`
 * row, whichever page asked for it, with the actor the guard verified. It
 * is written after the delete, so no row records a delete that was refused,
 * and a failure to write it is logged rather than reported as a failed
 * delete: the document is gone either way.
 */
async function deleteContentItem({ guard, store, onContentDeleted, now, uuid }, request, context) {
  const auth = await guard.requireRole(request, 'publisher');
  if (auth.error) return auth.error;
  const { user } = auth;

  try {
    const { contentId, expectedStatus = null } = await readBody(request);
    if (!contentId) return json(400, { error: 'contentId required' });

    const doc = await store.readDoc('content', contentId, contentId);
    if (!doc) return json(200, { success: true, contentId });
    const refused = deleteRefusal(doc, expectedStatus);
    if (refused) return refused;

    let deleted;
    try {
      deleted = await deleteAsRead(store, doc);
    } catch (err) {
      if (err?.code === 412) {
        return json(409, { error: DELETE_CHANGED_SINCE_READ, code: 'CONFLICT' });
      }
      throw err;
    }
    if (!deleted) return json(200, { success: true, contentId });

    // Both failure lines are content-free (the PR template's telemetry
    // rule): a fixed sentence and the error's code, never the document id or
    // the error itself, whose message and fields can carry what was sent.
    await store
      .upsertDoc(
        'audits',
        deletionAuditRow(uuid, { user, request, doc, expectedStatus, nowIso: now().toISOString() })
      )
      .catch((err) =>
        context.error(`deleteContentItem: the audit row was not written (${err?.code ?? 'error'})`)
      );
    // The change feed never delivers a delete (T-324): move the dashboard
    // counters here, best-effort.
    if (onContentDeleted) {
      await onContentDeleted(contentId).catch((err) =>
        context.warn?.(
          `deleteContentItem: the dashboard counters were not updated (${err?.code ?? 'error'})`
        )
      );
    }
    return json(200, { success: true, contentId });
  } catch (error) {
    return workflowFailure(context, 'deleteContentItem', error, 'Failed to delete content');
  }
}

/** The live page a soft delete names: by contentId, then blogId as a legacy alias. */
async function resolveLivePage(store, { contentId, blogId }) {
  const doc = contentId ? await store.readDoc('content', contentId, contentId) : null;
  if (!doc && blogId) return store.readDoc('content', blogId, blogId);
  return doc;
}

/** POST /api/softDeleteLivePage — source :5840; publisher; 24h grace. */
async function softDeleteLivePage({ guard, store, now }, request, context) {
  const auth = await guard.requireRole(request, 'publisher');
  if (auth.error) return auth.error;
  const { user } = auth;

  try {
    const { contentId = '', blogId = '', reason = '' } = await readBody(request);
    if (!contentId && !blogId) {
      return json(400, { error: 'contentId or blogId required' });
    }

    const doc = await resolveLivePage(store, { contentId, blogId });
    if (!doc) return json(404, { error: 'No matching live page record found' });

    const nowDate = now();
    const deletedAtIso = nowDate.toISOString();
    const expiresAtIso = new Date(nowDate.getTime() + 24 * 60 * 60 * 1000).toISOString();

    await store.patchDoc('content', doc.id, {
      Live: false,
      Status: 'Archived',
      contentStatus: 'archived',
      archivedAt: deletedAtIso,
      softDeletedAt: deletedAtIso,
      softDeleteExpiresAt: expiresAtIso,
      scheduledPublishDate: null,
      deletionRequestedBy: actor(user),
      deletionReason: String(reason || '').trim(),
      updatedAt: deletedAtIso,
    });

    return json(200, {
      success: true,
      contentId: doc.id,
      blogIds: [], // the legacy blogs fan-out was retired upstream
      softDeleteExpiresAt: expiresAtIso,
    });
  } catch (error) {
    return workflowFailure(context, 'softDeleteLivePage', error, 'Failed to soft-delete page');
  }
}

/**
 * The two editor resets share a shape: a valid id, an existing document,
 * one patch. `fields` is what each one writes beside the stamps.
 */
async function patchExistingContent(
  { guard, store, now },
  request,
  context,
  { label, message, fields }
) {
  const auth = await guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  const { user } = auth;

  try {
    const { contentId } = await readBody(request);
    if (!contentId || typeof contentId !== 'string') {
      return json(400, { error: 'contentId required' });
    }

    const doc = await store.readDoc('content', contentId, contentId);
    if (!doc) return json(404, { error: `content ${contentId} not found` });

    await store.patchDoc('content', contentId, {
      ...fields,
      updatedAt: now().toISOString(),
      updatedBy: actor(user),
    });

    return json(200, { success: true, contentId });
  } catch (error) {
    return workflowFailure(context, label, error, message);
  }
}

/** POST /api/requestContentInspection — source :4839; editor. */
const requestContentInspection = (ctx, request, context) =>
  patchExistingContent(ctx, request, context, {
    label: 'requestContentInspection',
    message: 'Failed to request inspection',
    fields: { inspectTrigger: true, contentStatus: 'ingested' },
  });

/** POST /api/resetContentReviewState — source :4931; editor. */
const resetContentReviewState = (ctx, request, context) =>
  patchExistingContent(ctx, request, context, {
    label: 'resetContentReviewState',
    message: 'Failed to reset review state',
    fields: {
      inspectTrigger: false,
      contentStatus: 'ingested',
      inspectError: null,
      Live: false,
      scheduledPublishDate: null,
    },
  });

const HANDLERS = Object.freeze({
  saveEditorDraft,
  unpublishContentToInspected,
  deleteContentItem,
  saveContentSchedule,
  unscheduleContent,
  softDeleteLivePage,
  requestContentInspection,
  resetContentReviewState,
});

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ readDoc: Function, patchDoc: Function, upsertDoc: Function, deleteDocIfMatch: Function }} deps.store
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 */
export function createContentWorkflowHandlers({
  guard,
  store,
  onContentDeleted = null,
  now = () => new Date(),
  uuid = randomUUID,
}) {
  const ctx = { guard, store, onContentDeleted, now, uuid };
  return Object.fromEntries(
    Object.entries(HANDLERS).map(([name, handler]) => [
      name,
      (request, context) => handler(ctx, request, context),
    ])
  );
}
