/**
 * updateContentItem + transitionContentStatus — the two remaining writers on
 * the content container, ported from Site-Main cms-functions.js (:3564 and
 * :6813).
 *
 * Both are PARTIAL writes and therefore go through patchDoc, never upsertDoc:
 * an upsert here would replace the whole document and silently drop every
 * field the caller didn't send (the exact hazard #42's patchDoc exists to
 * prevent). Deletions ride patchDoc's `undefined` convention.
 *
 * Adaptations, each deliberate:
 *   - The source wrapped doc-update + version/audit writes in a Firestore
 *     transaction. Cosmos has no cross-container transaction, so the writes
 *     are sequential with the content patch FIRST: if a later bookkeeping
 *     write fails, the user-visible change has landed and the failure
 *     surfaces as a 500 the caller can retry; the reverse order could record
 *     history for an edit that never happened.
 *   - Version history goes to the `content_versions` container (partition key
 *     /contentId — the migration manifest's one non-/id container), with an
 *     explicit uuid id replacing Firestore's auto-id subcollection doc.
 *   - Audit rows carry ISO timestamps and a uuid id. ipAddress is null for
 *     now: Azure Functions has no trustworthy req.ip equivalent and logging a
 *     spoofable X-Forwarded-For into a compliance record is worse than null —
 *     wire lib/auth/client-identity.js here when its CF_ORIGIN_SECRET path is
 *     configured.
 *   - The publisher gate for going live reads the role resolved by the guard
 *     (admins/{oid} record), the same authority the source's user.adminRole
 *     carried.
 */
import { randomUUID } from "node:crypto";
import { actorName } from "../auth/actor-name.js";
import { isPublicDocument } from "../public-reads.js";
import { normalizeContentBodyFields } from "./content-quality.js";
import { normalizePublishTarget } from "./publish-targets.js";
import {
  validateAndNormalizeUpdateContentItemUpdates,
  normalizeContentUpdatesForBlogOnly,
  normalizeStatusForBlogOnly,
  normalizeCurrentStatusForBlogOnly,
} from "./content-update-validation.js";
import {
  DRAFTS_ONLY_STATUSES,
  VALID_TRANSITIONS,
  buildStatusUpdateData,
  validateTransitionRequest,
} from "./content-status.js";
import {
  TaxonomyFieldError,
  hasTaxonomyFields,
  validateTaxonomyFieldsWithStore,
} from "./taxonomy-fields.js";

const json = (status, body) => ({
  status,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * The first non-empty value of `keys` across `records` in order — the
 * version row reads the update first, then the stored document, under
 * either spelling of the field — or "".
 */
function firstFilled(records, keys) {
  for (const record of records) {
    const value = keys.map((key) => record[key]).find(Boolean);
    if (value) return value;
  }
  return "";
}

/**
 * The content id and the validated, normalised updates a body carries, or
 * the 400 refusing it: a missing id or a non-object `updates`, then any
 * rule the validator throws.
 */
function parseUpdateBody(body) {
  const { contentId, updates = {} } = body || {};
  if (!contentId || typeof updates !== "object") {
    return {
      error: json(400, { error: "contentId and updates object required" }),
    };
  }
  let validatedUpdates;
  try {
    validatedUpdates = validateAndNormalizeUpdateContentItemUpdates(updates);
  } catch (error) {
    return { error: json(400, { error: String(error.message || error) }) };
  }
  return {
    contentId,
    normalizedUpdates: normalizeContentBodyFields(
      normalizeContentUpdatesForBlogOnly(validatedUpdates),
    ),
  };
}

/**
 * kind / ideaOrigin against the saved taxonomy (ADR 0033 §4), written onto
 * `normalizedUpdates`. The current record is passed so a disabled id it
 * already carries survives an edit of other fields; moving onto a disabled
 * id is the 400 returned here. Null when nothing refuses.
 */
async function taxonomyRefusal(store, normalizedUpdates, currentData) {
  if (!hasTaxonomyFields(normalizedUpdates)) return null;
  try {
    Object.assign(
      normalizedUpdates,
      await validateTaxonomyFieldsWithStore(store, normalizedUpdates, {
        existing: currentData,
      }),
    );
    return null;
  } catch (error) {
    if (error instanceof TaxonomyFieldError)
      return json(400, { error: error.message });
    throw error;
  }
}

/**
 * The stored document an update lands on, with the taxonomy fields of the
 * update checked against it — or the 404 / 400 refusing the update.
 */
async function readUpdateTarget(store, contentId, normalizedUpdates) {
  const currentData = await store.readDoc("content", contentId, contentId);
  if (!currentData) {
    return { error: json(404, { error: `Content ${contentId} not found` }) };
  }
  const refused = await taxonomyRefusal(store, normalizedUpdates, currentData);
  return refused ? { error: refused } : { currentData };
}

/**
 * POST/PATCH updateContentItem — validated partial update + version history +
 * audit row. Source :3564.
 *
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ readDoc: Function, patchDoc: Function, upsertDoc: Function }} deps.store
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 */
export function createContentUpdateHandler({
  guard,
  store,
  now = () => new Date(),
  uuid = randomUUID,
}) {
  return async function updateContentItem(request, context) {
    const auth = await guard.requireRole(request, "editor");
    if (auth.error) return auth.error;
    const { user } = auth;

    try {
      const parsed = parseUpdateBody(await request.json().catch(() => null));
      if (parsed.error) return parsed.error;
      const { contentId, normalizedUpdates } = parsed;

      const target = await readUpdateTarget(
        store,
        contentId,
        normalizedUpdates,
      );
      if (target.error) return target.error;
      const { currentData } = target;

      const editor = actorName(user);
      const nowIso = now().toISOString();

      // Content patch first — see the ordering note in the header.
      await store.patchDoc("content", contentId, {
        ...normalizedUpdates,
        updatedAt: nowIso,
        updatedBy: editor,
      });

      await store.upsertDoc("content_versions", {
        id: uuid(),
        contentId,
        title: firstFilled(
          [normalizedUpdates, currentData],
          ["Title", "title"],
        ),
        summary: firstFilled(
          [normalizedUpdates, currentData],
          ["Summary", "summary"],
        ),
        draft: firstFilled(
          [normalizedUpdates, currentData],
          ["blogDraft", "content"],
        ),
        updatedFields: Object.keys(normalizedUpdates),
        versionCreatedAt: nowIso,
        versionCreatedBy: editor,
        versionReason: "review_updated",
      });

      await store.upsertDoc("admin_audit_logs", {
        id: uuid(),
        action: "content_item_updated",
        userId: user.oid || user.sub || null,
        userEmail: user.email || null,
        timestamp: nowIso,
        details: { contentId, updatedFields: Object.keys(normalizedUpdates) },
        userAgent: request.headers?.get?.("user-agent") || null,
        contentId,
        contentTitle: currentData.Title || currentData.title || "",
        compliance: {
          schemaVersion: 1,
          detailsSanitized: true,
          identityVerified: true,
        },
      });

      return json(200, { success: true, contentId });
    } catch (error) {
      context.error("updateContentItem failed:", error);
      return json(500, {
        error: "Failed to update content item",
        message: error?.message || "Unknown error",
      });
    }
  };
}

/**
 * The state machine's core: edge check → status update → audit row, with no
 * HTTP or guard concerns. Extracted (T-606) so the Telegram bot's /reject can
 * run the SAME transition the admin portal does — one writer, not a bot-side
 * copy that would drift. The HTTP handler below calls this after its guard;
 * any other caller is responsible for its own authorization story (the bot's
 * is the webhook secret + chat-id check in lib/telegram/bot.js).
 *
 * Every caller names the role it acts with, as `actorRole`: the handler
 * passes the guard's, the bot says `super_admin` for the owner's chat. A
 * call that names none is refused wherever a role is asked for, rather than
 * waved through (AP-F13, #937): a forgotten argument must not read as the
 * owner.
 *
 * The write is conditioned on the read's `_etag`, so a document that moved
 * between the read and the write is refused with a 409 (`code: 'CONFLICT'`)
 * and nothing is written; archiving and leaving the archive for `published`
 * carry the content's linked legacy blogs with it (findLinkedBlogsToCarry).
 *
 * @returns {{ ok: true, contentId, from, to } |
 *           { ok: false, status: number, error: string, code?: string, allowedTransitions?: string[] }}
 */
export function createContentStatusTransitioner({
  store,
  now = () => new Date(),
  uuid = randomUUID,
}) {
  return async function applyContentStatusTransition({
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
  }) {
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

    // Every edge OUT of a page the public site serves is a publisher's, like
    // every edge into published (transitionRequestRefusal). A document in
    // `published` is on the site whatever its Live flag says
    // (public-reads.js PUBLIC_STATUSES), and isPublicDocument also serves a
    // `Live: true` document in any status and a legacy `Status: 'Live'` one,
    // so a live `editing` page sent to `rejected` comes down as surely as a
    // `published` one does. Gating the status alone left those two shapes
    // to an editor. This is the gate softDeleteLivePage had before Live
    // Pages' Archive replaced it (AP-F13, #937). Checked here rather than
    // with the request's other refusals because the request names only
    // where the document is going; where it is takes the read. A missing
    // role is no role: refused, never a bypass (see the header).
    const onTheSite =
      normalizedCurrentStatus === "published" || isPublicDocument(data);
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
    if (
      DRAFTS_ONLY_STATUSES.includes(normalizedCurrentStatus) ||
      DRAFTS_ONLY_STATUSES.includes(normalizedStatus)
    ) {
      return {
        ok: false,
        status: 409,
        code: "DRAFTS_STAGE",
        error: `${normalizedCurrentStatus} → ${normalizedStatus} is a Drafts stage move; use /admin/drafts (Send to In Review or Back to Drafts).`,
      };
    }

    const allowed = VALID_TRANSITIONS[normalizedCurrentStatus];
    if (!allowed || !allowed.includes(normalizedStatus)) {
      return {
        ok: false,
        status: 400,
        error: `Invalid transition: ${normalizedCurrentStatus} → ${normalizedStatus}`,
        allowedTransitions: allowed || [],
      };
    }

    const nowDate = now();
    const updateData = buildStatusUpdateData(
      data,
      normalizedStatus,
      reviewedBy,
      reviewNotes,
      {
        publishTarget: normalizedPublishTarget,
        markLive,
        now: nowDate,
      },
    );

    // Enforce additional invariants tied to the state machine.
    if (normalizedStatus === "archived") {
      updateData.archivedAt = nowDate.toISOString();
    } else if (normalizedCurrentStatus === "archived") {
      // Leaving the archive (Undo or Restore to live, AP-F13 #937) clears
      // the stamp the Archive board sorts on, as leaving rejected clears
      // rejectedAt below. Null, not undefined: a page that was archived
      // once and is live again should read as never archived.
      updateData.archivedAt = null;
    }
    if (
      normalizedCurrentStatus === "rejected" &&
      normalizedStatus === "inspected"
    ) {
      // "Restore" should remove rejection marker so the doc no longer appears as rejected.
      updateData.rejectedAt = null;
    }

    // Read before any write, so a failed lookup leaves nothing changed.
    const linkedBlogs = await findLinkedBlogsToCarry(store, data, {
      contentId,
      from: normalizedCurrentStatus,
      to: normalizedStatus,
    });

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
      const refusal = lostRaceRefusal(error, contentId);
      if (refusal) return refusal;
      throw error;
    }

    const changedFields = Object.keys(updateData);
    await store.upsertDoc("audits", {
      id: uuid(),
      timestamp: nowDate.toISOString(),
      action: "status_transition",
      resourceType: "content",
      resourceId: contentId,
      resourceTitle: data.Title || data.title || "",
      userId: actor.oid || actor.sub || reviewedBy,
      userName: actor.name || null,
      userEmail: actor.email || null,
      changes: {
        before: { contentStatus: currentStatus },
        after: { contentStatus: normalizedStatus },
        changedFields,
        notes: reviewNotes,
      },
      ipAddress: null, // see header — no trustworthy source until client-identity is wired
      userAgent,
      metadata: {
        ...(legacyBlogId ? { legacyBlogId } : {}),
        ...(linkedBlogs.length
          ? { linkedBlogIds: linkedBlogs.map((blog) => blog.id) }
          : {}),
        authMethod,
        reviewedBy,
      },
      compliance: {
        dataClassification: "internal",
        retentionMonths: 24,
        identityVerified: true,
      },
    });

    // After the audit row, so the row names the blogs this transition
    // carries even if one of these writes then fails (a 500 the caller sees).
    await carryLinkedBlogs(store, linkedBlogs, updateData, {
      contentId,
      to: normalizedStatus,
      nowIso: nowDate.toISOString(),
    });

    return {
      ok: true,
      contentId,
      from: normalizedCurrentStatus,
      to: normalizedStatus,
    };
  };
}

/** What a transition that lost a race with another write answers. */
export const CHANGED_SINCE_READ =
  "The page changed since it was read; reload and try again.";

/**
 * The refusal for a guarded write that lost its race, or null for any other
 * failure: a 412 is the document moving since it was read (409, as the
 * caller's view is what is stale), a 404 it being deleted in between.
 */
function lostRaceRefusal(error, contentId) {
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

/**
 * LEGACY BLOGS GO WITH THEIR PAGE (AP-F13, #937). A `blogs` document linked
 * to a content document — the content's `publishedBlogId`, or a blog naming
 * it as `sourceContentId` or `publishedContentId`, the links
 * timers/content-cleanup.js purges by and Live Pages archives a legacy row
 * through — is served by the public reads on its own `Live`, `Status` and
 * `contentStatus` (public-reads.js isPublicDocument). Archiving the content
 * alone left such a blog on the site. So archiving carries every linked blog
 * the site serves, stamping it `archivedWithContentId`, and leaving the
 * archive for `published` (Undo, Restore to live) carries back exactly the
 * blogs so stamped: a linked blog that was not public before the archive is
 * never made public by its Undo. Done here, on the server, so every caller
 * of the transition (Live Pages, the Archive board) gets it.
 */
const BLOG_VISIBILITY_FIELDS = [
  "Live",
  "Status",
  "contentStatus",
  "scheduledPublishDate",
];

/**
 * The legacy blogs this transition carries with the content: none, those to
 * archive, or those to bring back.
 */
async function findLinkedBlogsToCarry(store, data, { contentId, from, to }) {
  const archiving = to === "archived";
  const restoring = from === "archived" && to === "published";
  if (!archiving && !restoring) return [];
  const linked = await readLinkedBlogs(store, data, contentId);
  return linked.filter((blog) =>
    archiving
      ? isPublicDocument(blog)
      : blog.archivedWithContentId === contentId,
  );
}

/**
 * Every blog linked to the content, once each, with the fields the choice
 * above reads.
 */
async function readLinkedBlogs(store, data, contentId) {
  const byId = new Map();
  if (data.publishedBlogId) {
    const blog = await store.readDoc(
      "blogs",
      data.publishedBlogId,
      data.publishedBlogId,
    );
    if (blog) byId.set(blog.id, blog);
  }
  const rows = await store.queryDocs(
    "blogs",
    "SELECT TOP 50 c.id, c.Live, c.Status, c.contentStatus, c.softDeletedAt, c.softDeleteExpiresAt, c.archivedWithContentId FROM c WHERE c.sourceContentId = @id OR c.publishedContentId = @id",
    [{ name: "@id", value: contentId }],
  );
  for (const row of rows || []) if (!byId.has(row.id)) byId.set(row.id, row);
  return [...byId.values()];
}

/**
 * The content's own visibility fields, as the transition just wrote them,
 * onto each linked blog: archived writes `Live: false`, `Status:
 * 'Archived'`, `contentStatus: 'archived'` and no schedule; published writes
 * `Live` and `contentStatus: 'published'` and drops the `Status` word, as
 * publishing does (content-status.js applyStatusPublished).
 */
async function carryLinkedBlogs(
  store,
  blogs,
  updateData,
  { contentId, to, nowIso },
) {
  if (blogs.length === 0) return;
  const visibility = Object.fromEntries(
    BLOG_VISIBILITY_FIELDS.filter((field) => field in updateData).map(
      (field) => [field, updateData[field]],
    ),
  );
  const marker =
    to === "archived"
      ? { archivedWithContentId: contentId, archivedAt: nowIso }
      : { archivedWithContentId: undefined, archivedAt: null };
  for (const blog of blogs) {
    await store.patchDoc("blogs", blog.id, {
      ...visibility,
      ...marker,
      updatedAt: nowIso,
    });
  }
}

/** The roles that may make content live; editors stop at the review workflow. */
const PUBLISHING_ROLES = ["publisher", "super_admin"];

/**
 * What refuses a transition request before any read: the live transition
 * for a non-publisher (403 — the dedicated publishContent endpoint enforces
 * the same boundary), then the request-shape rules of
 * validateTransitionRequest. Null when nothing refuses. Every edge OUT of a
 * page the public site serves is refused for the same role by the
 * transitioner, once the read has said where the document is (AP-F13, #937).
 */
function transitionRequestRefusal(auth, { normalizedStatus, ...request }) {
  if (
    normalizedStatus === "published" &&
    !PUBLISHING_ROLES.includes(String(auth.role || "").toLowerCase())
  ) {
    return json(403, {
      error: "publisher access required for live publishing",
    });
  }
  const validation = validateTransitionRequest({
    ...request,
    normalizedStatus,
  });
  return validation.ok ? null : json(validation.status, validation.error);
}

/**
 * The content id a transition applies to. Older API calls pass blogId
 * instead of contentId; the document carrying it as publishedBlogId is
 * looked up, or the 404 says there is none.
 */
async function resolveTransitionTarget(store, contentId, blogId) {
  if (contentId) return { resolvedContentId: contentId, legacyBlogId: null };
  const rows = await store.queryDocs(
    "content",
    "SELECT TOP 1 c.id FROM c WHERE c.publishedBlogId = @blogId",
    [{ name: "@blogId", value: blogId }],
  );
  if (rows.length === 0) {
    return {
      error: json(404, {
        error: "legacy content document not found for this blogId",
      }),
    };
  }
  return { resolvedContentId: rows[0].id, legacyBlogId: blogId };
}

/** The transitioner's outcome as the handler's response, the success logged. */
function transitionResponse(
  context,
  result,
  { resolvedContentId, legacyBlogId, reviewedBy },
) {
  if (!result.ok) {
    const { status, ok: _ok, ...errorBody } = result;
    return json(status, errorBody);
  }
  context.warn(
    `transitionStatus ${resolvedContentId}: ${result.from} → ${result.to} by ${reviewedBy}`,
  );
  return json(200, {
    success: true,
    contentId: resolvedContentId,
    legacyBlogId,
    collectionName: "content",
    from: result.from,
    to: result.to,
  });
}

/**
 * POST transitionContentStatus — the state machine's single writer.
 * Source :6813.
 *
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ readDoc: Function, patchDoc: Function, upsertDoc: Function, queryDocs: Function }} deps.store
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 */
export function createContentTransitionHandler({
  guard,
  store,
  now = () => new Date(),
  uuid = randomUUID,
}) {
  const applyTransition = createContentStatusTransitioner({ store, now, uuid });

  return async function transitionContentStatus(request, context) {
    const auth = await guard.requireRole(request, "editor");
    if (auth.error) return auth.error;
    const { user } = auth;

    try {
      const body = (await request.json().catch(() => null)) || {};
      const {
        contentId,
        blogId,
        newStatus,
        publishTarget = null,
        markLive = null,
        reviewNotes = "",
        reviewedBy = user.email ||
          user.preferred_username ||
          user.oid ||
          "admin",
      } = body;

      const normalizedStatus = normalizeStatusForBlogOnly(newStatus);

      // Editors may move content through the review workflow, but the live
      // transition is reserved for publishers.
      const refused = transitionRequestRefusal(auth, {
        contentId,
        blogId,
        normalizedStatus,
        markLive,
        reviewNotes,
        reviewedBy,
      });
      if (refused) return refused;

      const target = await resolveTransitionTarget(
        store,
        contentId || null,
        blogId,
      );
      if (target.error) return target.error;
      const { resolvedContentId, legacyBlogId } = target;

      const result = await applyTransition({
        contentId: resolvedContentId,
        newStatus,
        publishTarget,
        markLive,
        reviewNotes,
        reviewedBy,
        actor: user,
        actorRole: auth.role,
        userAgent: request.headers?.get?.("user-agent") || null,
        legacyBlogId,
      });
      return transitionResponse(context, result, {
        resolvedContentId,
        legacyBlogId,
        reviewedBy,
      });
    } catch (error) {
      context.error("transitionContentStatus failed:", error);
      return json(500, {
        error: "Failed to transition content status",
        message: error?.message || "Unknown error",
      });
    }
  };
}
