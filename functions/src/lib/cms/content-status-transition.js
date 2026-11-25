/**
 * content-status-transition.js — one status transition of a content page:
 * the checks on the edge, the guarded write, the linked blogs and the audit
 * row. createContentStatusTransitioner in content-update.js (whose header
 * describes the rules) runs it, handing in settleLinkedBlogs.
 */
import { isPublicDocument } from "../public-reads.js";
import { normalizePublishTarget } from "./publish-targets.js";
import { carriesLinkedBlogs, linkedBlogsAuditMetadata, readLinkedBlogs } from "./linked-blogs.js";
import {
  normalizeCurrentStatusForBlogOnly,
  normalizeStatusForBlogOnly,
} from "./content-update-validation.js";
import {
  DRAFTS_ONLY_STATUSES,
  VALID_TRANSITIONS,
  buildStatusUpdateData,
} from "./content-status.js";

/** The roles that may make content live; editors stop at the review workflow. */
export const PUBLISHING_ROLES = ["publisher", "super_admin"];

/** What a transition that lost a race with another write answers. */
export const CHANGED_SINCE_READ =
  "The page changed since it was read; reload and try again.";

/**
 * The refusal for a guarded write that lost its race, or null for any other
 * failure: a 412 is the document moving since it was read (409, as the
 * caller's view is what is stale), a 404 it being deleted in between.
 */
export function lostRaceRefusal(error, contentId) {
  if (error?.code === 412) {
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      error: CHANGED_SINCE_READ,
    };
  }
  if (error?.code === 404) {
    return { ok: false, status: 404, error: `Content ${contentId} not found` };
  }
  return null;
}

export async function applyTransition(
  { store, now, uuid, settleLinkedBlogs },
  {
    contentId,
    newStatus,
    publishTarget = null,
    markLive = null,
    reviewNotes = "",
    reviewedBy = "admin",
    actor = {},
    actorRole,
    userAgent = null,
    authMethod = "entra_bearer_token",
    legacyBlogId = null,
  },
) {
  const normalizedStatus = normalizeStatusForBlogOnly(newStatus);
  const normalizedPublishTarget = normalizePublishTarget(publishTarget);

  const data = await store.readDoc("content", contentId, contentId);
  if (!data) {
    return {
      ok: false,
      status: 404,
      error: `Content ${contentId} not found`,
    };
  }

  const currentStatus = data.contentStatus || "ingested";
  const normalizedCurrentStatus =
    normalizeCurrentStatusForBlogOnly(currentStatus);
  const refusal = edgeRefusal({
    data,
    from: normalizedCurrentStatus,
    to: normalizedStatus,
    actorRole,
  });
  if (refusal) return refusal;

  const nowDate = now();
  const updateData = transitionUpdate(data, {
    from: normalizedCurrentStatus,
    to: normalizedStatus,
    reviewedBy,
    reviewNotes,
    publishTarget: normalizedPublishTarget,
    markLive,
    nowDate,
  });

  // Read before any write, so a lookup that cannot be answered leaves
  // nothing changed, and a page with no linked blog (nearly every page)
  // costs nothing more. Which blogs move, and how, is decided again from
  // reads taken after the write (settleLinkedBlogs): a choice made from
  // this read can be stale by the time it is carried out.
  const linkedAtRead = carriesLinkedBlogs(
    normalizedCurrentStatus,
    normalizedStatus,
  )
    ? await readLinkedBlogs(store, data, contentId)
    : [];

  // Under the read's ETag: the publisher gate and the edge check above
  // were decided from `data`, so the write must land on that version or
  // not at all (AP-F13, #937). Unconditioned, an editor's `editing →
  // rejected` read before a publisher set the page live would land after
  // it and take the page down without the role, and an archive and its
  // Undo racing each other would overwrite each other. A lost race is
  // refused, nothing else is written, and the caller reloads.
  try {
    await store.patchDoc("content", contentId, updateData, {
      ifMatch: data._etag,
    });
  } catch (error) {
    const lost = lostRaceRefusal(error, contentId);
    if (lost) return lost;
    throw error;
  }

  // Before the audit row, so the row names the blogs this transition
  // actually moved. A write that fails for any reason but a lost race or
  // a deleted blog is held until the row is written, then surfaces as the
  // 500 the header describes.
  const linked =
    linkedAtRead.length > 0
      ? await settleLinkedBlogs(store, contentId, nowDate.toISOString())
      : null;

  await store.upsertDoc(
    "audits",
    transitionAuditRow({
      id: uuid(),
      nowDate,
      contentId,
      data,
      actor,
      reviewedBy,
      reviewNotes,
      from: currentStatus,
      to: normalizedStatus,
      changedFields: Object.keys(updateData),
      userAgent,
      authMethod,
      legacyBlogId,
      linked,
    }),
  );
  if (linked?.error) throw linked.error;

  return {
    ok: true,
    contentId,
    from: normalizedCurrentStatus,
    to: normalizedStatus,
    ...(linked
      ? {
          linkedBlogs: {
            carried: linked.carried,
            skipped: linked.skipped,
            settled: linked.settled,
          },
        }
      : {}),
  };
}

/**
 * Why the stored document may not take this edge, or null when it may.
 *
 * Every edge OUT of a page the public site serves is a publisher's, like
 * every edge into published (transitionRequestRefusal). A document in
 * `published` is on the site whatever its Live flag says
 * (public-reads.js PUBLIC_STATUSES), and isPublicDocument also serves a
 * `Live: true` document in any status and a legacy `Status: 'Live'` one,
 * so a live `editing` page sent to `rejected` comes down as surely as a
 * `published` one does. Gating the status alone left those two shapes
 * to an editor. This is the gate softDeleteLivePage had before Live
 * Pages' Archive replaced it (AP-F13, #937). Checked here rather than
 * with the request's other refusals because the request names only
 * where the document is going; where it is takes the read. A missing
 * role is no role: refused, never a bypass (see the header).
 */
function edgeRefusal({ data, from, to, actorRole }) {
  const onTheSite = from === "published" || isPublicDocument(data);
  if (
    onTheSite &&
    !PUBLISHING_ROLES.includes(String(actorRole || "").toLowerCase())
  ) {
    return {
      ok: false,
      status: 403,
      error:
        "publisher access required to move a page that is on the public site",
    };
  }

  // The Drafts stage's edges (drafting -> in_review, in_review -> drafting)
  // belong to lib/cms/drafts-handlers.js, which checks where the article
  // came from and conditions the write on the read's ETag. Through here an
  // in_review article from anywhere could be dropped into the owner's
  // Drafts, or a half-written draft pushed on with no title check.
  if (DRAFTS_ONLY_STATUSES.includes(from) || DRAFTS_ONLY_STATUSES.includes(to)) {
    return {
      ok: false,
      status: 409,
      code: "DRAFTS_STAGE",
      error: `${from} → ${to} is a Drafts stage move; use /admin/drafts (Send to In Review or Back to Drafts).`,
    };
  }

  const allowed = VALID_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    return {
      ok: false,
      status: 400,
      error: `Invalid transition: ${from} → ${to}`,
      allowedTransitions: allowed || [],
    };
  }
  return null;
}

/** The fields the transition writes, with the state machine's own invariants. */
function transitionUpdate(
  data,
  { from, to, reviewedBy, reviewNotes, publishTarget, markLive, nowDate },
) {
  const updateData = buildStatusUpdateData(data, to, reviewedBy, reviewNotes, {
    publishTarget,
    markLive,
    now: nowDate,
  });

  // Enforce additional invariants tied to the state machine.
  if (to === "archived") {
    updateData.archivedAt = nowDate.toISOString();
  } else if (from === "archived") {
    // Leaving the archive (Undo or Restore to live, AP-F13 #937) clears
    // the stamp the Archive board sorts on, as leaving rejected clears
    // rejectedAt below. Null, not undefined: a page that was archived
    // once and is live again should read as never archived.
    updateData.archivedAt = null;
  }
  if (from === "rejected" && to === "inspected") {
    // "Restore" should remove rejection marker so the doc no longer appears as rejected.
    updateData.rejectedAt = null;
  }
  return updateData;
}

/** The audit row of one status transition. */
function transitionAuditRow({
  id,
  nowDate,
  contentId,
  data,
  actor,
  reviewedBy,
  reviewNotes,
  from,
  to,
  changedFields,
  userAgent,
  authMethod,
  legacyBlogId,
  linked,
}) {
  return {
    id,
    timestamp: nowDate.toISOString(),
    action: "status_transition",
    resourceType: "content",
    resourceId: contentId,
    resourceTitle: data.Title || data.title || "",
    userId: actor.oid || actor.sub || reviewedBy,
    userName: actor.name || null,
    userEmail: actor.email || null,
    changes: {
      before: { contentStatus: from },
      after: { contentStatus: to },
      changedFields,
      notes: reviewNotes,
    },
    ipAddress: null, // see header — no trustworthy source until client-identity is wired
    userAgent,
    metadata: {
      ...(legacyBlogId ? { legacyBlogId } : {}),
      ...linkedBlogsAuditMetadata(linked),
      authMethod,
      reviewedBy,
    },
    compliance: {
      dataClassification: "internal",
      retentionMonths: 24,
      identityVerified: true,
    },
  };
}
