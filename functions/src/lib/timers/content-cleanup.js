/**
 * content-cleanup.js — the two reapers behind `cleanupRejectedContent`
 * (04:00 UTC) and `cleanupSoftDeletedContent` (every 4 h).
 *
 * Ported from Site-Main `cms/cleanup.js` (088f458). The first is soft: a
 * rejection older than the cutoff gets `softDeletedAt`, so a misclick stays
 * recoverable for the second reaper's grace window (7 days at the call
 * site). The second is hard: the content document, every blog linked to it
 * (`publishedBlogId`, and `blogs.sourceContentId`), and its `content_versions`
 * rows (a container here, not a subcollection — so they CAN be deleted).
 *
 * Firestore's 500-write batch cap shaped the upstream code; Cosmos has no
 * batch here, so each document is its own operation and a failure stops the
 * run at that document rather than rolling anything back.
 *
 * The hard reaper is DRY-RUN until `CONTENT_HARD_DELETE=true` (the T-302 rule:
 * arming the timer and arming the deletion are two decisions), and it never
 * deletes a document whose mark has no recorded origin. Three things write
 * `softDeletedAt`: the admin soft-delete route, which also writes
 * `deletionRequestedBy`; and the two rejected-content agers (this file and the
 * gallery route), which write `softDeletedReason: 'rejected_aged_out'`. A mark
 * carrying neither — a migrated document, or a writer nobody has audited — is
 * refused and left for a human: the admin content queue lists it under the
 * `soft_deleted` filter. Every run logs one summary line, idle runs included,
 * so the per-category host.json override (T-766) has something to witness.
 *
 * COUNTERS. The change feed never delivers a delete (T-324), so every hard
 * delete here moves the dashboard counters itself through the same stats
 * maintainer the delete endpoints call (`onContentDeleted`, defaulting to
 * createDashboardStatsMaintainer over `store`). Until 2026-10-03 the purge
 * skipped this and `dashboard_stats_v1` drifted upward by one per purged
 * document until someone pressed Recalculate (ADR 0033 §1). Best-effort, after
 * the delete that matters: a counter that fails to move is a warning, not a
 * document that fails to go.
 */
import { getDocDateValue } from "../cms/content-dedup.js";
import { createDashboardStatsMaintainer } from "../triggers/dashboard-stats.js";
import { writeSystemAudit } from "./workflow-records.js";
import { errorFacts } from "../http/error-response.js";

export function getRejectionReferenceDate(data) {
  return (
    getDocDateValue(data?.rejectedAt) ||
    getDocDateValue(data?.reviewedAt) ||
    getDocDateValue(data?.updatedAt) ||
    null
  );
}

/** Who put the deletion mark on a document — the only thing the hard reaper trusts. */
export function deletionOrigin(doc) {
  if (doc?.deletionRequestedBy) return "user";
  if (doc?.softDeletedReason === "rejected_aged_out") return "policy";
  return "unknown";
}

/**
 * The aged rows sorted by what the reaper may do with them: `eligible` has a
 * recorded origin and is counted by who put the mark there; `refusedIds` is
 * every row whose mark has none, the query's and the in-memory check's.
 */
export function partitionByOrigin(candidates, unknownRows) {
  const eligible = [];
  const refusedIds = unknownRows.map((d) => d.id);
  let userRequestedCount = 0;
  let policyCount = 0;
  for (const doc of candidates) {
    const origin = deletionOrigin(doc);
    if (origin === "unknown") {
      refusedIds.push(doc.id);
      continue;
    }
    if (origin === "user") userRequestedCount += 1;
    else policyCount += 1;
    eligible.push(doc);
  }
  return { eligible, refusedIds, userRequestedCount, policyCount };
}

/** Every blog linked to the document (`publishedBlogId`, `blogs.sourceContentId`), deleted; the count. */
async function deleteLinkedBlogs(store, doc) {
  const blogIds = new Set();
  if (
    doc.publishedBlogId &&
    (await store.readDoc("blogs", doc.publishedBlogId, doc.publishedBlogId))
  ) {
    blogIds.add(doc.publishedBlogId);
  }
  const related = await store.queryDocs(
    "blogs",
    "SELECT c.id FROM c WHERE c.sourceContentId = @id",
    [{ name: "@id", value: doc.id }],
  );
  for (const blog of related || []) blogIds.add(blog.id);
  for (const blogId of blogIds) await store.deleteDoc("blogs", blogId, blogId);
  return blogIds.size;
}

/** The document's content_versions rows, deleted best-effort; the count. */
async function deleteVersions(store, doc, log) {
  let deleted = 0;
  try {
    const versions = await store.queryDocs(
      "content_versions",
      "SELECT c.id FROM c WHERE c.contentId = @id",
      [{ name: "@id", value: doc.id }],
    );
    for (const version of versions || []) {
      await store.deleteDoc("content_versions", version.id, doc.id);
      deleted += 1;
    }
  } catch (err) {
    log.warn?.(
      `[cleanupSoftDeletedContent] versions cleanup failed for ${doc.id}: ${errorFacts(err)}`,
    );
  }
  return deleted;
}

/**
 * One eligible document, gone: its blogs, the document itself, then the
 * counters and its versions, each best-effort after the delete that matters.
 */
async function purgeDocument({ store, log, countersAfterDelete }, doc) {
  const blogs = await deleteLinkedBlogs(store, doc);
  await store.deleteDoc("content", doc.id, doc.id);
  try {
    await countersAfterDelete(doc.id);
  } catch (err) {
    log.warn?.(
      `[cleanupSoftDeletedContent] counters not updated for ${doc.id}: ${errorFacts(err)}`,
    );
  }
  const versions = await deleteVersions(store, doc, log);
  return { blogs, versions };
}

/**
 * Mark rejected content older than `olderThanHours` as soft-deleted.
 *
 * @param {{ store, now, log, auditOpts }} deps
 */
async function softDeleteRejected(
  { store, now, log, auditOpts },
  { olderThanHours = null, limit = 500 } = {},
) {
  const maxLimit = Math.min(Number(limit) || 500, 500);
  const cutoff =
    typeof olderThanHours === "number" && olderThanHours > 0
      ? new Date(now().getTime() - olderThanHours * 60 * 60 * 1000)
      : null;
  const rows = await store.queryDocs(
    "content",
    `SELECT TOP ${maxLimit} c.id, c.softDeletedAt, c.rejectedAt, c.reviewedAt, c.updatedAt FROM c WHERE c.contentStatus = 'rejected'`,
    [],
  );
  const examined = (rows || []).length;
  const toMark = (rows || []).filter((data) => {
    if (data.softDeletedAt) return false;
    if (!cutoff) return true;
    const reference = getRejectionReferenceDate(data);
    return reference && reference < cutoff;
  });
  if (!toMark.length) {
    return {
      deletedCount: 0,
      softDeletedCount: 0,
      examinedCount: examined,
      hasMore: examined === maxLimit,
    };
  }
  const stamp = now().toISOString();
  for (const doc of toMark) {
    await store.patchDoc("content", doc.id, {
      softDeletedAt: stamp,
      softDeletedReason: "rejected_aged_out",
    });
  }
  await writeSystemAudit(
    store,
    {
      action: "cron_soft_deleted_rejected_content",
      source: "cleanupRejectedContent",
      details: {
        affectedCount: toMark.length,
        examinedCount: examined,
        olderThanHours:
          typeof olderThanHours === "number" ? olderThanHours : null,
        affectedIds: toMark.slice(0, 50).map((d) => d.id),
        truncatedAffectedIds: toMark.length > 50,
      },
    },
    auditOpts,
  );
  log.log?.(
    `[cleanupRejectedContent] soft-deleted ${toMark.length} of ${examined}`,
  );
  return {
    deletedCount: toMark.length,
    softDeletedCount: toMark.length,
    examinedCount: examined,
    hasMore: examined === maxLimit,
  };
}

/**
 * Hard-delete content soft-deleted longer than `olderThanHours` ago, with its
 * blogs and versions. Dry-run unless `CONTENT_HARD_DELETE=true`; documents
 * whose mark has no recorded origin are refused in both modes.
 *
 * @param {{ store, now, log, env, auditOpts, countersAfterDelete }} deps
 */
async function hardDeleteSoftDeleted(
  { store, now, log, env, auditOpts, countersAfterDelete },
  { olderThanHours = 24, limit = 200 } = {},
) {
  const deleteEnabled = env.CONTENT_HARD_DELETE === "true";
  const maxLimit = Math.min(Number(limit) || 200, 500);
  const cutoff = new Date(
    now().getTime() - olderThanHours * 60 * 60 * 1000,
  ).toISOString();
  // Origin is decided in the query, not only in memory: if unknown-origin
  // rows shared the TOP window with eligible ones, enough of them would
  // starve the eligible rows forever (they are never deleted, so they never
  // leave the window). Eligible and refused are two bounded queries, and
  // the in-memory check below stays as a second guard on what came back.
  const params = [{ name: "@cutoff", value: cutoff }];
  const agedClause =
    "IS_DEFINED(c.softDeletedAt) AND c.softDeletedAt != null AND c.softDeletedAt <= @cutoff";
  const knownOriginClause =
    '((IS_STRING(c.deletionRequestedBy) AND c.deletionRequestedBy != "") OR c.softDeletedReason = "rejected_aged_out")';
  const candidates =
    (await store.queryDocs(
      "content",
      `SELECT TOP ${maxLimit} c.id, c.publishedBlogId, c.deletionRequestedBy, c.softDeletedReason FROM c WHERE ${agedClause} AND ${knownOriginClause}`,
      params,
    )) || [];
  const unknownRows =
    (await store.queryDocs(
      "content",
      `SELECT TOP ${maxLimit} c.id FROM c WHERE ${agedClause} AND NOT ${knownOriginClause}`,
      params,
    )) || [];

  const { eligible, refusedIds, userRequestedCount, policyCount } =
    partitionByOrigin(candidates, unknownRows);
  const examinedCount = candidates.length + unknownRows.length;

  const summary = {
    dryRun: !deleteEnabled,
    examinedCount,
    eligibleCount: eligible.length,
    userRequestedCount,
    policyCount,
    refusedCount: refusedIds.length,
    deletedContentCount: 0,
    deletedBlogCount: 0,
    deletedVersionCount: 0,
    // Either window full means another pass is needed: the eligible one for
    // the next deleting run, the refused one for the human review list.
    hasMore: candidates.length === maxLimit || unknownRows.length === maxLimit,
    refusedHasMore: unknownRows.length === maxLimit,
  };
  // Counts only: a document id is an identifier, and traces stay content-free.
  if (refusedIds.length) {
    log.warn?.(
      `[cleanupSoftDeletedContent] refused ${refusedIds.length} document(s) whose deletion mark has no recorded origin — left for review`,
    );
  }
  if (!deleteEnabled) {
    log.log?.(
      `[cleanupSoftDeletedContent] dry-run: would delete content=${eligible.length} (user=${userRequestedCount}, policy=${policyCount}) refused=${refusedIds.length} examined=${examinedCount}`,
    );
    return summary;
  }
  if (!examinedCount) {
    log.log?.(
      "[cleanupSoftDeletedContent] content=0 blogs=0 versions=0 refused=0 examined=0",
    );
    return summary;
  }

  // From here the run is armed and examined something. The audit entry is
  // written even when nothing was eligible, because the refused ids are what
  // a human needs to find the documents the reaper would not touch.
  let deletedBlogCount = 0;
  let versionsDeleted = 0;
  for (const doc of eligible) {
    const gone = await purgeDocument({ store, log, countersAfterDelete }, doc);
    deletedBlogCount += gone.blogs;
    versionsDeleted += gone.versions;
  }
  await writeSystemAudit(
    store,
    {
      action: "cron_hard_deleted_soft_deleted_content",
      source: "cleanupSoftDeletedContent",
      details: {
        deletedContentCount: eligible.length,
        deletedBlogCount,
        deletedVersionCount: versionsDeleted,
        userRequestedCount,
        policyCount,
        refusedCount: refusedIds.length,
        olderThanHours,
        affectedIds: eligible.slice(0, 50).map((d) => d.id),
        truncatedAffectedIds: eligible.length > 50,
        refusedIds: refusedIds.slice(0, 50),
        truncatedRefusedIds: refusedIds.length > 50,
      },
    },
    auditOpts,
  );
  log.log?.(
    `[cleanupSoftDeletedContent] content=${eligible.length} blogs=${deletedBlogCount} versions=${versionsDeleted} refused=${refusedIds.length} examined=${examinedCount}`,
  );
  return {
    ...summary,
    deletedContentCount: eligible.length,
    deletedBlogCount,
    deletedVersionCount: versionsDeleted,
  };
}

export function createContentCleanup({
  store,
  now = () => new Date(),
  uuid,
  log = {},
  env = process.env,
  onContentDeleted = null,
}) {
  const deps = {
    store,
    now,
    log,
    env,
    auditOpts: { now, ...(uuid && { uuid }) },
    countersAfterDelete:
      onContentDeleted ||
      ((contentId) =>
        createDashboardStatsMaintainer({ store, now, log }).applyTransition({
          contentId,
          afterData: null,
        })),
  };
  return {
    softDeleteRejected: (options) => softDeleteRejected(deps, options),
    hardDeleteSoftDeleted: (options) => hardDeleteSoftDeleted(deps, options),
  };
}
