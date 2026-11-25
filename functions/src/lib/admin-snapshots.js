/**
 * Admin dashboard/queue/publish snapshot RPCs — getQueueSnapshot,
 * getPublishSnapshot, getAdminDashboardSnapshot, recalculateDashboardStats.
 *
 * Ported from Site-Main cms-functions.js (:6038-6170, :6300-6470) with the
 * classification helpers (:88-110, :2000-2130, :2273-2320) verbatim.
 *
 * Cosmos adaptations, each deliberate:
 *   - Firestore `where('x','in',[...])` -> ARRAY_CONTAINS(@list, c.x);
 *     `count()` aggregations -> SELECT VALUE COUNT(1) with the same WHERE.
 *   - Sorting happens in memory on the resolved field. Firestore's orderBy
 *     silently HID documents missing the sort field; here they sort last
 *     instead of vanishing — for an admin queue, showing an item with a
 *     missing timestamp beats hiding it, and the source itself shipped an
 *     unsorted-fetch + JS-sort fallback path accepting these semantics.
 *     The read WINDOW is ordered in Cosmos by `_ts`, which every document
 *     carries, so `TOP n` takes the n most recently written rather than an
 *     arbitrary n (#1013, NEWEST_WRITTEN_FIRST).
 *   - The dashboard stats doc (Firestore `dashboard_stats/v1`) lives in the
 *     existing `system` container as `dashboard_stats_v1`. No container was
 *     migrated for it because it is derived data — recalculateDashboardStats
 *     rebuilds it from a full scan, and the dashboard self-seeds on first
 *     load exactly as the source did.
 */
import { ADMIN_CONTENT_SNAPSHOT_FIELDS } from "./cms-content.js";
import { answerWithoutHiddenOrigins } from "./page-links/origin-ref.js";
import { REVIEW_DECISION_STATUSES } from "./cms/content-status.js";
import { errorFacts, errorResponse } from "./http/error-response.js";
import {
  DASHBOARD_STATS_DOC_ID,
  DASHBOARD_STATS_TYPES,
  emptyDashboardStats,
  isBlockedContentSource,
  matchesAdminContentType,
  matchesQueueStatus,
  matchesTaxonomyFilter,
  summarizeDashboardItems,
  toMillis,
} from "./admin-snapshot-classify.js";

export {
  DASHBOARD_STATS_DOC_ID,
  DASHBOARD_STATS_TYPES,
  emptyDashboardStats,
  getCanonicalContentTypeForAdmin,
  isBlockedContentSource,
  matchesAdminContentType,
  matchesQueueStatus,
  matchesTaxonomyFilter,
  summarizeDashboardItems,
  toMillis,
} from "./admin-snapshot-classify.js";

const json = (status, body) => ({
  status,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const PROJECTION = [
  "c.id",
  ...ADMIN_CONTENT_SNAPSHOT_FIELDS.map((f) => `c["${f}"]`),
].join(", ");

// ── query plumbing ──────────────────────────────────────────────────────────

/**
 * The queue views (source :6333-6358), by what their Cosmos window matches:
 * `statuses` is an ARRAY_CONTAINS over contentStatus, `status` one stored
 * value, `where` a clause of its own. Any other filter is one stored status.
 */
const QUEUE_FILTERS = Object.freeze({
  needs_review: {
    statuses: REVIEW_DECISION_STATUSES,
    sortField: "fetchedAt",
  },
  // forge_ready is publishable (content-status.js PUBLISHABLE_NORMALIZED_STATUSES)
  // and until 2026-10-03 appeared on no screen at all (ADR 0033 §1).
  ready_to_publish: {
    statuses: ["approved", "forge_ready", "published"],
    sortField: "updatedAt",
  },
  published_live: { where: "c.Live = true", sortField: "publishedAt" },
  // The same set the dashboard counts as inProgress (triggers/dashboard-stats.js),
  // so the Editor badge never counts an item this view cannot show. in_review
  // left it on 2026-10-08 for needs_review, as it left the inProgress counter.
  in_progress: {
    statuses: ["approved", "editing", "forge_ready", "needs_rework"],
    sortField: "updatedAt",
  },
  soft_deleted: { status: "rejected", sortField: "fetchedAt" },
});

/** A queue view's WHERE clause and its parameters. */
function queueWhere(view) {
  if (view.statuses) {
    return {
      where: "ARRAY_CONTAINS(@statuses, c.contentStatus)",
      params: [{ name: "@statuses", value: [...view.statuses] }],
    };
  }
  if (view.where) return { where: view.where, params: [] };
  return {
    where: "c.contentStatus = @status",
    params: [{ name: "@status", value: view.status }],
  };
}

/** statusFilter -> { where clause, params, sortField } (source :6333-6358). */
export function queueFilterFor(statusFilter) {
  const view = Object.hasOwn(QUEUE_FILTERS, statusFilter)
    ? QUEUE_FILTERS[statusFilter]
    : { status: String(statusFilter), sortField: "fetchedAt" };
  return { ...queueWhere(view), sortField: view.sortField };
}

/**
 * Not live, exactly as `item.Live !== true` reads in JS. `IS_BOOLEAN` keeps a
 * missing, null or non-boolean Live counted: `c.Live = true` alone is
 * undefined for those, and Cosmos drops a row whose WHERE is undefined.
 */
const NOT_LIVE = "NOT (IS_BOOLEAN(c.Live) AND c.Live = true)";

/**
 * The Publish stage: ready to publish and not yet live (ADR 0033 §1). The
 * ready_to_publish window includes the `published` status, so on its own it
 * also matches every live page. readyCandidates already dropped those in JS,
 * but the COUNT did not, so `readyTotal` counted every live page as staged.
 * The publish page and the dashboard's Publish badge both count this.
 */
export function readyToPublishWhere() {
  const ready = queueFilterFor("ready_to_publish");
  return {
    where: `${ready.where} AND ${NOT_LIVE}`,
    params: ready.params,
    sortField: ready.sortField,
  };
}

const sortDescBy = (field) => (a, b) => toMillis(b[field]) - toMillis(a[field]);

/** Where an item's arrival time is read from, first one present wins. */
const REVIEW_WAIT_FALLBACKS = [
  "fetchedAt",
  "createdAt",
  "Created At",
  "updatedAt",
];

/**
 * When an item started waiting for its review decision: when it was sent to
 * review for an `in_review` item (Drafts' Send to In Review stamps
 * sentToReviewAt), otherwise when it arrived. An article written on the
 * Drafts page has no fetchedAt, so ordering the review view by fetchedAt
 * alone put every article sent from Drafts at the bottom of the queue.
 */
export function reviewWaitingSince(item = {}) {
  const sent =
    String(item.contentStatus || "") === "in_review"
      ? item.sentToReviewAt
      : null;
  return (
    sent ||
    REVIEW_WAIT_FALLBACKS.map((field) => item[field]).find(Boolean) ||
    null
  );
}

const byReviewWaitDesc = (a, b) =>
  toMillis(reviewWaitingSince(b)) - toMillis(reviewWaitingSince(a));

/** A view's in-memory order, where its one sortField is not the whole story. */
const QUEUE_SORTS = Object.freeze({ needs_review: byReviewWaitDesc });

/**
 * The read window the snapshot lists take: the most recently written
 * documents first. `TOP n` with no ORDER BY hands back an arbitrary n, so a
 * queue longer than its window showed the newest of an arbitrary slice
 * (#1013). `_ts` is on every document — the sort fields are not, and a
 * Cosmos ORDER BY on a missing property drops the document (public-reads.js)
 * — and a single-property ORDER BY needs only the range index the content
 * container's `/*` policy gives every path (infra/cosmos-containers.json).
 */
export const NEWEST_WRITTEN_FIRST = " ORDER BY c._ts DESC";

const FULL_SCAN_TOP = 5000; // content is ~1k docs; bounded, not unbounded

/** The content reads the four snapshots share, over one store. */
function createSnapshotReads(store) {
  const countWhere = async (where, params) => {
    const rows = await store.queryDocs(
      "content",
      `SELECT VALUE COUNT(1) FROM c WHERE ${where}`,
      params,
    );
    return Number(rows[0]) || 0;
  };

  const fetchProjected = (where, params, top, orderBy = "") =>
    store.queryDocs(
      "content",
      `SELECT TOP ${top} ${PROJECTION} FROM c WHERE ${where}${orderBy}`,
      params,
    );

  /**
   * A view's window in the view's own order (review of #1021). The `_ts`
   * window is the newest written, which is not the newest by `publishedAt`
   * or `fetchedAt`: a page rewritten lately for an unrelated reason fills it
   * and pushes out an item the view should list first. So the rows that
   * carry the sort field are read ordered by it, in Cosmos, and the rows
   * that lack it (which Cosmos would drop from that ORDER BY, and which the
   * in-memory sort puts last) come from a second window, newest written
   * first. Both are bounded by `top`.
   */
  async function fetchInViewOrder(where, params, top, field) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(field)) {
      throw new Error(
        `fetchInViewOrder: ${JSON.stringify(field)} is not a sort field`,
      );
    }
    const [withField, withoutField] = await Promise.all([
      fetchProjected(
        `(${where}) AND IS_DEFINED(c.${field})`,
        params,
        top,
        ` ORDER BY c.${field} DESC`,
      ),
      fetchProjected(
        `(${where}) AND NOT IS_DEFINED(c.${field})`,
        params,
        top,
        NEWEST_WRITTEN_FIRST,
      ),
    ]);
    return [...(withField || []), ...(withoutField || [])];
  }

  /**
   * The dashboard snapshot's newest review items: the most recently written
   * review items, ordered by how long each has waited. Until #1013 the
   * window was an unordered TOP 30, so "newest" meant the newest of an
   * arbitrary thirty.
   */
  async function recentNeedsReviewItems(limit = 10) {
    const { where, params } = queueFilterFor("needs_review");
    const rows = await fetchProjected(
      where,
      params,
      limit * 3,
      NEWEST_WRITTEN_FIRST,
    );
    return rows
      .filter((item) => !isBlockedContentSource(item))
      .sort(byReviewWaitDesc)
      .slice(0, limit);
  }

  // `url` and `link` are read by isBlockedContentSource; without them a
  // recount could count a document the change-feed maintainer leaves out.
  async function fullScanStats() {
    const rows = await store.queryDocs(
      "content",
      `SELECT TOP ${FULL_SCAN_TOP} c.id, c["contentStatus"], c["Live"], c["type"], c["contentType"], c["publishTarget"], c["targetLandingZone"], c["sourceUrl"], c["sourceUrls"], c["sourceFeed"], c["CD Url"], c["url"], c["link"] FROM c`,
      [],
    );
    return { items: rows, stats: summarizeDashboardItems(rows) };
  }

  return {
    countWhere,
    fetchProjected,
    fetchInViewOrder,
    recentNeedsReviewItems,
    fullScanStats,
  };
}

const seedFromStats = (stats, totalDocs) => {
  const seed = emptyDashboardStats();
  seed.rejected = stats.rejected;
  DASHBOARD_STATS_TYPES.forEach((t) => {
    if (stats[t]) seed[t] = { ...stats[t] };
  });
  seed.totalDocs = totalDocs;
  return seed;
};

/** Times a Recount scans again when the change feed overtakes it. */
const RECOUNT_ATTEMPTS = 3;
const isWriteConflict = (error) =>
  [409, 412].includes(error?.code ?? error?.statusCode);

/**
 * One Recount: the counters' ETag, the scan, the markers, then the counters,
 * written only under that ETag. `{ written: false }` when the content
 * changed during the run: a marker the feed moved after it was read, or a
 * counters document the feed wrote after the ETag was taken (412), or one
 * created meanwhile (409). Nothing the scan computed is written then, so
 * older counts never land over newer ones (review of #1021).
 */
async function recountOnce({ store, reads, now, user, rederiveMarkers }) {
  const before = await store.readDoc(
    "system",
    DASHBOARD_STATS_DOC_ID,
    DASHBOARD_STATS_DOC_ID,
  );
  const scan = await reads.fullScanStats();
  const markers = await rederiveMarkers({ store, items: scan.items, now });
  if (markers.skipped > 0) return { written: false, scan, markers };

  const seed = seedFromStats(scan.stats, scan.items.length);
  seed.id = DASHBOARD_STATS_DOC_ID;
  const nowIso = now().toISOString();
  seed.updatedAt = nowIso;
  seed.recalculatedAt = nowIso;
  seed.recalculatedBy =
    user.email || user.preferred_username || user.oid || "admin";

  // Deliberate full replace (source used .set() without merge): a
  // recalculation must clear drifted keys, not merge over them.
  try {
    if (before?._etag)
      await store.replaceDocIfMatch("system", { ...seed, _etag: before._etag });
    else await store.createDoc("system", seed);
  } catch (error) {
    if (isWriteConflict(error)) return { written: false, scan, markers };
    throw error;
  }
  return { written: true, scan, markers };
}

const isTaxonomyFiltered = ({ kindFilter, ideaOriginFilter }) =>
  (kindFilter && kindFilter !== "all") ||
  (ideaOriginFilter && ideaOriginFilter !== "all");

/**
 * The narrowing a queue view still needs after its Cosmos window: the
 * checks that are derived from fallback fields and cannot be a WHERE clause.
 */
function queueItemFilters({
  statusFilter,
  contentTypeFilter,
  kindFilter,
  ideaOriginFilter,
}) {
  const filters = [(item) => !isBlockedContentSource(item)];
  if (statusFilter === "ready_to_publish" || statusFilter === "in_progress") {
    filters.push((item) => matchesQueueStatus(item, statusFilter));
  } else if (statusFilter === "rejected") {
    filters.push((item) => !item.softDeletedAt);
  } else if (statusFilter === "soft_deleted") {
    filters.push((item) => Boolean(item.softDeletedAt));
  }
  if (contentTypeFilter !== "all") {
    filters.push((item) => matchesAdminContentType(item, contentTypeFilter));
  }
  if (isTaxonomyFiltered({ kindFilter, ideaOriginFilter })) {
    filters.push((item) =>
      matchesTaxonomyFilter(item, { kindFilter, ideaOriginFilter }),
    );
  }
  return filters;
}

/** POST getQueueSnapshot's body as its answer (source :6300). */
async function buildQueueSnapshot({ reads, now }, body) {
  const {
    statusFilter = "needs_review",
    contentTypeFilter = "all",
    kindFilter = "all",
    ideaOriginFilter = "all",
    itemLimit = 100,
  } = body;
  // 1000 cap supports the queue's "All" view (content queue runs 200+).
  const normalizedLimit = Math.min(Math.max(Number(itemLimit) || 100, 1), 1000);
  // Content-type and taxonomy filtering happen in JS (derived from fallback
  // fields); fetch a 3x buffer to survive the discard, as the source did.
  const narrowedInJs =
    contentTypeFilter !== "all" ||
    isTaxonomyFiltered({ kindFilter, ideaOriginFilter });
  const fetchSize = narrowedInJs ? normalizedLimit * 3 : normalizedLimit;

  const { where, params, sortField } = queueFilterFor(statusFilter);
  // The review view orders by a waiting time no one field holds
  // (reviewWaitingSince), and every one of its fields is written no later
  // than the document, so its window is the newest written. Every other view
  // is read in its own sort field's order (fetchInViewOrder).
  const window = Object.hasOwn(QUEUE_SORTS, statusFilter)
    ? reads.fetchProjected(where, params, fetchSize, NEWEST_WRITTEN_FIRST)
    : reads.fetchInViewOrder(where, params, fetchSize, sortField);
  const [totalCount, rawItems] = await Promise.all([
    reads.countWhere(where, params),
    window,
  ]);

  const blockedInPage = rawItems.filter(isBlockedContentSource).length;
  const filters = queueItemFilters({
    statusFilter,
    contentTypeFilter,
    kindFilter,
    ideaOriginFilter,
  });
  const order = Object.hasOwn(QUEUE_SORTS, statusFilter)
    ? QUEUE_SORTS[statusFilter]
    : sortDescBy(sortField);
  const items = rawItems
    .filter((item) => filters.every((keep) => keep(item)))
    .sort(order);

  return {
    success: true,
    generatedAt: now().toISOString(),
    totalCount: Math.max(0, totalCount - blockedInPage),
    items: items.slice(0, normalizedLimit),
  };
}

/**
 * The stored stats document projected to the shape summarizeDashboardItems
 * returns, so the DashboardPage UI needs no changes.
 */
function projectStats(statsDoc) {
  const stats = emptyDashboardStats();
  delete stats.totalDocs;
  delete stats.schemaVersion;
  DASHBOARD_STATS_TYPES.forEach((t) => {
    if (statsDoc[t]) stats[t] = { ...stats[t], ...statsDoc[t] };
  });
  stats.rejected = statsDoc.rejected || 0;
  return stats;
}

/**
 * Not yet seeded (first deploy): live aggregation plus a fire-and-forget
 * seed so subsequent loads take the fast path.
 */
async function scanAndSeedStats({ store, reads, now }, context) {
  const scan = await reads.fullScanStats();
  const seed = seedFromStats(scan.stats, scan.items.length);
  seed.id = DASHBOARD_STATS_DOC_ID;
  seed.updatedAt = now().toISOString();
  store
    .upsertDoc("system", seed)
    .catch((err) =>
      context.warn?.("[dashboard-stats] seed write failed:", errorFacts(err)),
    );
  return scan.stats;
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ queryDocs: Function, readDoc: Function, upsertDoc: Function }} deps.store
 * @param {() => Date} [deps.now]
 */
export function createAdminSnapshotHandlers({
  guard,
  store,
  now = () => new Date(),
}) {
  const reads = createSnapshotReads(store);
  const ctx = { store, reads, now };

  return {
    /** POST /api/getQueueSnapshot — source :6300. */
    async getQueueSnapshot(request, context) {
      const auth = await guard.requireRole(request, "viewer");
      if (auth.error) return auth.error;

      try {
        const body = (await request.json().catch(() => null)) || {};
        return answerWithoutHiddenOrigins(
          store,
          auth.user,
          json(200, await buildQueueSnapshot(ctx, body)),
        );
      } catch (error) {
        return errorResponse(
          context,
          "Failed to generate queue snapshot",
          error,
          500,
          request,
        );
      }
    },

    /** POST /api/getPublishSnapshot — source :6405. */
    async getPublishSnapshot(request, context) {
      const auth = await guard.requireRole(request, "viewer");
      if (auth.error) return auth.error;

      try {
        // Not-live in the query too, so the TOP 150 window is not spent on
        // live pages the JS filter below would discard.
        const ready = readyToPublishWhere();
        const publishedWhere =
          "c.Live = true AND c.contentStatus = 'published'";

        const [readyTotal, readyRows, publishedTotal, publishedRows] =
          await Promise.all([
            reads.countWhere(ready.where, ready.params),
            reads.fetchProjected(ready.where, ready.params, 150),
            reads.countWhere(publishedWhere, []),
            reads.fetchProjected(publishedWhere, [], 100),
          ]);

        const readyCandidates = readyRows
          .filter((item) => item.Live !== true)
          .sort(sortDescBy("updatedAt"))
          .slice(0, 100);
        const publishedItems = [...publishedRows].sort(
          sortDescBy("publishedAt"),
        );

        // The agent key never sees where a piece came from for a Page its key may
        // not read (page-links/origin-ref.js, review of #1890).
        return answerWithoutHiddenOrigins(
          store,
          auth.user,
          json(200, {
            success: true,
            generatedAt: now().toISOString(),
            readyTotal,
            publishedTotal,
            readyCandidates,
            publishedItems,
          }),
        );
      } catch (error) {
        return errorResponse(
          context,
          "Failed to generate publish snapshot",
          error,
          500,
          request,
        );
      }
    },

    /** POST /api/getAdminDashboardSnapshot — source :6038. */
    async getAdminDashboardSnapshot(request, context) {
      const auth = await guard.requireRole(request, "viewer");
      if (auth.error) return auth.error;

      try {
        // readyToPublish is the Publish stage's badge: the stats document
        // has no bucket for it (ready statuses fall in inProgress), so it is
        // one COUNT, the same one getPublishSnapshot's readyTotal runs.
        const ready = readyToPublishWhere();
        const [statsDoc, recentNeedsReview, readyToPublish] = await Promise.all(
          [
            store.readDoc(
              "system",
              DASHBOARD_STATS_DOC_ID,
              DASHBOARD_STATS_DOC_ID,
            ),
            reads.recentNeedsReviewItems(10),
            reads.countWhere(ready.where, ready.params),
          ],
        );
        const stats = statsDoc
          ? projectStats(statsDoc)
          : await scanAndSeedStats(ctx, context);

        return answerWithoutHiddenOrigins(
          store,
          auth.user,
          json(200, {
            success: true,
            generatedAt: now().toISOString(),
            stats,
            readyToPublish,
            recentNeedsReview,
          }),
        );
      } catch (error) {
        return errorResponse(
          context,
          "Failed to generate dashboard snapshot",
          error,
          500,
          request,
        );
      }
    },

    /**
     * POST /api/recalculateDashboardStats — source :6109; full overwrite.
     *
     * Re-derives the per-document markers as well as the counters (#1014).
     * The change-feed maintainer computes every delta from a document's
     * marker, so a recount that rewrote only the counters left any marker
     * written under an older bucket rule (in_review was inProgress until
     * 2026-10-08) to move that document out of the wrong bucket on its next
     * change. Markers first: a run that fails part-way leaves the counters
     * as they were, and pressing Recount again finishes it.
     *
     * A run the change feed overtakes starts again (review of #1021). The
     * counters are written only under the ETag they had before the scan, so
     * a feed delta that landed during the run makes the write a 412 instead
     * of putting the scan's older counts over it; a marker the feed moved
     * after the scan read it (`skipped`) means the same. Either way the scan
     * is out of date, and the run scans again, up to RECOUNT_ATTEMPTS times.
     */
    async recalculateDashboardStats(request, context) {
      const auth = await guard.requireRole(request, "editor");
      if (auth.error) return auth.error;

      try {
        const { user } = auth;
        // Loaded here rather than imported: triggers/dashboard-stats.js
        // imports this module, and a static import back would make the two a
        // cycle whose evaluation order decides whether either loads.
        const { rederiveMarkers } =
          await import("./triggers/dashboard-stats.js");
        for (let attempt = 1; attempt <= RECOUNT_ATTEMPTS; attempt += 1) {
          const outcome = await recountOnce({
            store,
            reads,
            now,
            user,
            rederiveMarkers,
          });
          if (outcome.written) {
            return json(200, {
              success: true,
              totalDocs: outcome.scan.items.length,
              stats: outcome.scan.stats,
              markers: outcome.markers,
              attempts: attempt,
            });
          }
        }
        return json(409, {
          error: "Content changed while recounting",
          message: `Content changed during each of ${RECOUNT_ATTEMPTS} recounts, so the counters were left as they were. Press Recount again in a minute.`,
        });
      } catch (error) {
        return errorResponse(
          context,
          "Failed to recalculate dashboard stats",
          error,
          500,
          request,
        );
      }
    },
  };
}
