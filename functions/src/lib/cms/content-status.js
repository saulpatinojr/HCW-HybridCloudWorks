/**
 * Content status state machine — transitions table, per-status appliers, and
 * the update payload builder for transitionContentStatus.
 *
 * Ported from Site-Main cms-functions.js (VALID_TRANSITIONS :2322,
 * STATUS_APPLIERS + buildStatusUpdateData :558, validateTransitionRequest
 * :6750, canPublishFromStatus :2249 area). The transition table is the single
 * source of truth for "can this be published?" — the source comment records
 * that a second divergent copy once stranded items in retry/alert loops, so
 * this port keeps exactly one table.
 *
 * Adaptations for Cosmos, each deliberate:
 *   - `FieldValue.delete()` becomes `undefined`, the deletion convention
 *     patchDoc already defines (an undefined value removes the field via its
 *     read-modify-write path).
 *   - `FieldValue.serverTimestamp()` becomes an injected `now` Date, written
 *     as an ISO string — the same shape the migration gives every timestamp.
 *   - Dates resolved from existing docs may be ISO strings (migrated shape),
 *     so toValidDate parses strings as well as Date/Timestamp — mirroring the
 *     getDocDateValue adaptation in content-dedup.js.
 */
import { normalizePublishTarget } from './publish-targets.js';
import { normalizeCurrentStatusForBlogOnly } from './content-update-validation.js';

/**
 * The Drafts stage (owner request 2026-10-03): an article the owner is
 * writing on /admin/drafts. Deliberately NOT `draft`, which already means
 * something else here — createContentDocument's default and
 * draft-from-recording's status, and one of forgeScheduled's
 * CANDIDATE_STATUSES, so a `draft` document can be picked up and rewritten by
 * the autonomous forge. A hand-written article must never be.
 *
 * Its one forward edge is in_review (Send to In Review); in_review's edge
 * back is Back to Drafts. Both are walked only by lib/cms/drafts-handlers.js,
 * under the read's ETag: DRAFTS_ONLY_STATUSES below makes the generic
 * transitioner (transitionContentStatus, the Telegram bot) refuse any edge
 * that enters or leaves this status, the way it reserves `published` for
 * publishers.
 */
export const DRAFTS_STAGE_STATUS = 'drafting';
export const DRAFTS_ONLY_STATUSES = Object.freeze([DRAFTS_STAGE_STATUS]);

/**
 * The statuses that wait on a reviewer's decision: the Review Queue's default
 * view, the dashboard's `needsReview` counter, and the Decision Center's
 * review queue (#1013, #1014) all read this one list.
 *
 * `in_review` joined it on 2026-10-08. Drafts' Send to In Review and the
 * repository import both write it, and until then it was counted on the
 * Editor badge while the Editor list (editing, approved, forge_ready,
 * needs_rework) could not show it and the Review Queue's default view did
 * not list it: an article sent for review appeared on no "decide this"
 * surface at all.
 */
export const REVIEW_DECISION_STATUSES = Object.freeze(['draft', 'ingested', 'inspected', 'in_review']);

export const VALID_TRANSITIONS = {
  drafting: ['in_review'],
  draft: ['ingested', 'in_review', 'approved', 'published', 'rejected'],
  ingested: ['inspected', 'in_review', 'approved', 'published', 'rejected'],
  inspected: ['in_review', 'approved', 'published', 'rejected'],
  needs_rework: ['inspected', 'in_review', 'approved', 'published', 'rejected'],
  // drafting: Back to Drafts, for an article that came from the Drafts stage.
  in_review: ['approved', 'published', 'rejected', 'drafting'],
  approved: ['editing', 'published', 'rejected'],
  editing: ['approved', 'forge_ready', 'published', 'in_review', 'rejected'],
  // forge_ready — ContentForge generated + graded above threshold; staged for
  // one-click human publish. Set by the forgeArticle pipeline.
  forge_ready: ['published', 'editing', 'rejected'],
  published: ['archived', 'editing', 'inspected', 'rejected'],
  rejected: ['inspected', 'in_review', 'archived'],
  // published: the way back from the Archive board, and the Undo on Live
  // Pages' ten-second toast (AP-F13, #937). The port kept the source graph's
  // "no resurrect-to-live" until 2026-10-15; an archive that cannot be undone
  // is a delete with a kinder name. Publisher-only, like every edge into
  // `published` (transitionRequestRefusal), and audited like every edge.
  archived: ['in_review', 'rejected', 'published'],
};

export const VALID_STATUSES = Object.keys(VALID_TRANSITIONS);

// The single source of truth for "can this be published?", in normalized
// status terms — see the header for why there must be exactly one copy.
export const PUBLISHABLE_NORMALIZED_STATUSES = ['approved', 'forge_ready', 'published'];

/**
 * @param {string} status - raw or normalized contentStatus
 * @returns {boolean} whether the publish pipeline will accept it
 */
export function canPublishFromStatus(status) {
  return PUBLISHABLE_NORMALIZED_STATUSES.includes(normalizeCurrentStatusForBlogOnly(status));
}

/** Date from Date / Firestore-style Timestamp / ISO string, else null. */
export function toValidDate(value) {
  if (!value) return null;
  const parsed = value?.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function resolvePreferredPublishedDate(data = {}) {
  const candidates = [
    data.publishedDate,
    data.datePublished,
    data['Published At'],
    data.publishedAt,
  ];

  for (const candidate of candidates) {
    const parsed = toValidDate(candidate);
    if (parsed) return parsed;
  }

  return null;
}

function applyStatusApproved(updateData, data, ctx) {
  updateData.approvedForNews = false;
  updateData.publishTarget = ctx.resolvedPublishTarget;
  if (!data.blogDraft) {
    updateData.blogDraft = data.content || data.Content || '';
  }
}

function applyStatusEditing(updateData, data) {
  if (!data.blogDraft) {
    updateData.blogDraft = data.content || data.Content || '';
  }
}

/**
 * Going live: the publish dates (the resolved one where there is one, now
 * otherwise), the target, Live from markLive (true when unsaid), and no
 * `Status` word on a live page, which a page back from the archive would
 * otherwise still carry.
 */
function applyStatusPublished(updateData, data, ctx) {
  const fallbackTimestamp = ctx.nowIso;
  const resolvedIso = ctx.resolvedPublishedDate ? ctx.resolvedPublishedDate.toISOString() : null;
  updateData.publishedAt = resolvedIso || fallbackTimestamp;
  if (resolvedIso) {
    updateData['Published At'] = resolvedIso;
    updateData.publishedDate = resolvedIso;
    updateData.datePublished = resolvedIso;
  }
  updateData.publishTarget = ctx.resolvedPublishTarget;
  updateData.Live = ctx.markLive === null ? true : Boolean(ctx.markLive);
  updateData.approvedForNews = false;
  // A page coming back from the archive (Undo, AP-F13 #937) carries the
  // `Status: 'Archived'` the archive wrote; a live page does not say that.
  if (updateData.Live) updateData.Status = undefined;
}

/**
 * OFF THE SITE MEANS EVERY GATE. The public reads admit a document on any of
 * three words — `Live`, the legacy `Status: 'Live'`, or a published
 * contentStatus (public-reads.js isPublicDocument and SQL_PUBLIC_CLAUSE) — so
 * taking a page down has to turn all three, not just the flag. Rejected and
 * archived write the legacy word too, the way softDeleteLivePage always did;
 * public-reads.test.js applies these patches to a legacy document and checks
 * nothing serves it (AP-F13, #937).
 *
 * AND NO SCHEDULE LEFT BEHIND. Both also clear scheduledPublishDate, with
 * null as unscheduleContent writes it and as softDeleteLivePage and
 * unpublishContentToInspected (content-workflow.js) always did. A schedule
 * outliving the page is a stall to timers/publishing-watchdog.js, which
 * counts `Live = false` with a past scheduledPublishDate as overdue and
 * raises a critical alert on every run: a page scheduled, published by hand
 * and then archived from Live Pages would alert until someone edited the
 * document. An item rejected while scheduled is the same document in the
 * same query, so rejected clears it too; Restore and Undo leave it cleared,
 * and the Calendar is where a new date is set.
 */
function applyStatusRejected(updateData, data, ctx) {
  updateData.Live = false;
  updateData.Status = 'Rejected';
  updateData.rejectedAt = ctx.nowIso;
  updateData.scheduledPublishDate = null;
}

/**
 * Archiving, under the same two rules as rejecting above: every public gate
 * turned off, and no schedule left behind.
 */
function applyStatusArchived(updateData) {
  updateData.Live = false;
  updateData.Status = 'Archived';
  updateData.scheduledPublishDate = null;
}

function applyStatusForgeReady(updateData) {
  updateData.Live = false;
}

const STATUS_APPLIERS = {
  approved: applyStatusApproved,
  editing: applyStatusEditing,
  forge_ready: applyStatusForgeReady, // Live=false while staged for publish
  published: applyStatusPublished,
  rejected: applyStatusRejected,
  archived: applyStatusArchived,
};

/**
 * The patch payload for a status transition. `undefined` values are deletions
 * (patchDoc's convention, replacing FieldValue.delete()).
 *
 * @param {object} data current document
 * @param {string} newStatus normalized target status
 * @param {string} reviewedBy
 * @param {string} reviewNotes
 * @param {{publishTarget?: string|null, markLive?: boolean|null, now?: Date}} options
 */
export function buildStatusUpdateData(data, newStatus, reviewedBy, reviewNotes, options = {}) {
  const { publishTarget = null, markLive = null, now = new Date() } = options;
  const ctx = {
    resolvedPublishTarget: normalizePublishTarget(
      publishTarget,
      data.publishTarget || data.type || data.contentType
    ),
    resolvedPublishedDate: resolvePreferredPublishedDate(data),
    markLive,
    nowIso: now.toISOString(),
  };
  const updateData = {
    contentStatus: newStatus,
    reviewedBy,
    reviewedAt: ctx.nowIso,
    reviewNotes,
  };

  const applier = STATUS_APPLIERS[newStatus];
  if (applier) applier(updateData, data, ctx);

  if (newStatus !== 'rejected') {
    updateData.softDeletedAt = undefined;
    // Both halves of isSoftDeleted (public-reads.js): a page the old Delete
    // Live Page had soft-deleted can be restored through Undo (AP-F13, #937)
    // only if the expiry goes with the stamp.
    updateData.softDeleteExpiresAt = undefined;
    updateData.softDeletedReason = undefined;
    updateData.rejectedAt = undefined;
  }

  return updateData;
}

/** Request-shape validation for transitionContentStatus (source :6750). */
export function validateTransitionRequest({
  contentId,
  blogId,
  normalizedStatus,
  markLive,
  reviewNotes,
  reviewedBy,
}) {
  if (contentId && typeof contentId !== 'string') {
    return { ok: false, status: 400, error: { error: 'contentId must be a string' } };
  }
  if (blogId && typeof blogId !== 'string') {
    return { ok: false, status: 400, error: { error: 'blogId must be a string' } };
  }
  if (markLive !== null && markLive !== undefined && typeof markLive !== 'boolean') {
    return {
      ok: false,
      status: 400,
      error: { error: 'markLive must be boolean when provided' },
    };
  }
  if (String(reviewNotes || '').length > 5000) {
    return { ok: false, status: 400, error: { error: 'reviewNotes exceeds 5000 characters' } };
  }
  if (String(reviewedBy || '').length > 240) {
    return { ok: false, status: 400, error: { error: 'reviewedBy exceeds 240 characters' } };
  }
  if ((!contentId && !blogId) || !normalizedStatus) {
    return {
      ok: false,
      status: 400,
      error: { error: 'contentId (or blogId) and newStatus required' },
    };
  }
  if (!VALID_STATUSES.includes(normalizedStatus)) {
    return {
      ok: false,
      status: 400,
      error: { error: `Invalid status: ${normalizedStatus}`, validStatuses: VALID_STATUSES },
    };
  }
  return { ok: true };
}
