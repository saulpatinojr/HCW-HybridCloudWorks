/**
 * admin-snapshot-classify.js — the classification helpers of the admin
 * snapshots (source cms-functions.js :88-110, :2000-2130, :2273-2320,
 * verbatim): which source is blocked, which admin type an item is, which
 * queue view it belongs in, and the dashboard counts. Pure; split out of
 * admin-snapshots.js, which re-exports the public names so callers and tests
 * import what they always did.
 */
import { REVIEW_DECISION_STATUSES } from "./cms/content-status.js";
import { resolveIdeaOrigin, resolveKind } from "./cms/taxonomy.js";

// ── classification helpers (verbatim) ──────────────────────────────────────

const BLOCKED_CONTENT_HOSTS = new Set(["stackfeed.io"]);

function normalizeHostname(value) {
  if (!value || typeof value !== "string") return "";
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function isBlockedContentSource(data = {}) {
  const fields = [
    data.sourceUrl,
    data.url,
    data.link,
    data["CD Url"],
    data.sourceFeed,
    ...(Array.isArray(data.sourceUrls) ? data.sourceUrls : []),
  ];
  return fields.some((value) =>
    BLOCKED_CONTENT_HOSTS.has(normalizeHostname(value)),
  );
}

export function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

const SUPPORTED_ADMIN_TYPES = new Set([
  "blog",
  "framework",
  "architecture",
  "coder_corner",
  "interview",
]);

export function getCanonicalContentTypeForAdmin(data = {}) {
  const raw = data.type || data.contentType || data.publishTarget || "blog";
  const normalized = String(raw || "")
    .trim()
    .toLowerCase();
  if (normalized === "news" || normalized === "rss") return "news";
  if (SUPPORTED_ADMIN_TYPES.has(normalized)) return normalized;
  return "blog";
}

export function matchesAdminContentType(item = {}, contentTypeFilter = "all") {
  const canonical = getCanonicalContentTypeForAdmin(item);
  if (contentTypeFilter === "all") return true;
  if (contentTypeFilter === "blog")
    return canonical === "blog" || canonical === "news";
  return canonical === contentTypeFilter;
}

/**
 * The taxonomy filters (ADR 0033 §4), on the resolved value: a record with
 * nothing stored matches the kind its `type` derives to and the origin its
 * `source` derives to, which is what the chip on its card says.
 */
export function matchesTaxonomyFilter(
  item = {},
  { kindFilter = "all", ideaOriginFilter = "all" },
) {
  if (kindFilter && kindFilter !== "all" && resolveKind(item) !== kindFilter)
    return false;
  if (
    ideaOriginFilter &&
    ideaOriginFilter !== "all" &&
    resolveIdeaOrigin(item) !== ideaOriginFilter
  ) {
    return false;
  }
  return true;
}

/** draft, ingested, inspected and in_review (content-status.js REVIEW_DECISION_STATUSES). */
const NEEDS_REVIEW_STATUSES = new Set(REVIEW_DECISION_STATUSES);
const READY_STATUSES = new Set(["approved", "forge_ready", "published"]);
/**
 * Not in progress: rejected and archived are out of the pipeline; drafting
 * is the Drafts stage, not the pipeline yet (/admin/drafts lists it); the
 * needs-review statuses have their own view. needs_rework is the inspector's
 * "come back to this"; it IS in progress, and the dashboard counts it so
 * (ADR 0033 §1).
 */
const NOT_IN_PROGRESS_STATUSES = new Set([
  "rejected",
  "archived",
  "drafting",
  ...NEEDS_REVIEW_STATUSES,
]);

/** The queue views that are not one stored status, by what they match. */
const QUEUE_VIEWS = {
  needs_review: (status) => NEEDS_REVIEW_STATUSES.has(status),
  ready_to_publish: (status, item) =>
    READY_STATUSES.has(status) && item.Live !== true,
  published_live: (_status, item) => item.Live === true,
  in_progress: (status, item) =>
    !NOT_IN_PROGRESS_STATUSES.has(status) && item.Live !== true,
};

export function matchesQueueStatus(item = {}, statusFilter = "needs_review") {
  const status = String(item.contentStatus || "ingested");
  const view = Object.hasOwn(QUEUE_VIEWS, statusFilter)
    ? QUEUE_VIEWS[statusFilter]
    : null;
  return view ? view(status, item) : status === statusFilter;
}

export const DASHBOARD_STATS_TYPES = [
  "blog",
  "framework",
  "architecture",
  "coder_corner",
  "interview",
  "news",
];
export const DASHBOARD_STATS_DOC_ID = "dashboard_stats_v1"; // in the `system` container

export function emptyDashboardStats() {
  const stats = { rejected: 0, totalDocs: 0, schemaVersion: 1 };
  DASHBOARD_STATS_TYPES.forEach((type) => {
    stats[type] = { needsReview: 0, inProgress: 0, published: 0, total: 0 };
  });
  return stats;
}

export function summarizeDashboardItems(items = []) {
  const summary = {
    blog: { needsReview: 0, inProgress: 0, published: 0, total: 0 },
    framework: { needsReview: 0, inProgress: 0, published: 0, total: 0 },
    architecture: { needsReview: 0, inProgress: 0, published: 0, total: 0 },
    coder_corner: { needsReview: 0, inProgress: 0, published: 0, total: 0 },
    interview: { needsReview: 0, inProgress: 0, published: 0, total: 0 },
    news: { needsReview: 0, inProgress: 0, published: 0, total: 0 },
    rejected: 0,
  };

  items
    .filter((item) => !isBlockedContentSource(item))
    .forEach((item) => {
      const type = getCanonicalContentTypeForAdmin(item);
      const bucket = summary[type] || summary.blog;
      const status = String(item.contentStatus || "ingested");

      if (status === "rejected") {
        summary.rejected += 1;
        return;
      }
      // Not the pipeline yet — see classifyContentBucket in
      // triggers/dashboard-stats.js, which this must agree with.
      if (status === "drafting") return;

      bucket.total += 1;

      if (item.Live === true) {
        bucket.published += 1;
        return;
      }

      if (NEEDS_REVIEW_STATUSES.has(status)) {
        bucket.needsReview += 1;
      } else if (status !== "archived") {
        // Everything else not-yet-Live (approved, editing, needs_rework,
        // forge_ready, published staged but Live=false) is in progress.
        bucket.inProgress += 1;
      }
    });

  return summary;
}
