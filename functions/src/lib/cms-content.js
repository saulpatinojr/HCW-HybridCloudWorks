/**
 * Content CRUD handler logic, ported from Site-Main cms-functions.js.
 *
 * Source semantics preserved (listContentItems :6622, getContentItem :3278):
 *   - list: optional contentStatus filter, limit clamped to 100 (default 25),
 *     NO ordering by default — the source query has no orderBy, and adding
 *     one would change which items appear under the limit. `?sort=` opts a
 *     caller in (LIST_SORT_FIELDS): Live Pages asks for `publishedAt`, which
 *     every published document carries, so the 500 newest live pages come
 *     back rather than 500 arbitrary documents (ADR 0033 §1).
 *   - `?kind=` and `?ideaOrigin=` (ADR 0033 §4) match the stored field OR,
 *     for a record that predates the taxonomy, the value its `type` /
 *     `source` derives to — so the filter agrees with the chip the list shows.
 *   - `?search=` (or `?q=`, AP-F6 #930) matches a substring of the title or
 *     summary under either casing the ingestion paths write, case-
 *     insensitively and from the index; the term is bounded
 *     (LIST_SEARCH_MIN_CHARS..LIST_SEARCH_MAX_CHARS) as `sort` and `limit` are.
 *   - list returns the admin snapshot PROJECTION, not whole documents. Content
 *     bodies (postContent etc.) are large; the queue UI reads only these
 *     fields. Firestore `.select(...)` becomes a Cosmos SELECT projection.
 *   - get: accepts contentId via GET query or POST body, exactly as the
 *     source does; 400 without it, 404 when absent.
 *
 * Auth is the two-gate role guard (lib/auth/require-role.js), replacing the
 * stub-era requireAdminClaims middleware whose audience config (ENTRA_CLIENT_ID)
 * no longer exists in the infrastructure.
 */

import {
  derivedKindTypes,
  derivedOriginSources,
} from "./cms/taxonomy-fields.js";

/**
 * Ported verbatim from Site-Main cms-functions.js:2211
 * (ADMIN_CONTENT_SNAPSHOT_FIELDS). The duplicate casings and spaced names
 * ('CD Url', 'Created At', 'Published At', 'Cover Image') are real field names
 * written by different ingestion paths — project all of them or the queue UI
 * shows "Not provided" for data that exists.
 */
export const ADMIN_CONTENT_SNAPSHOT_FIELDS = [
  "Title",
  "title",
  "Summary",
  "summary",
  "sourceUrl",
  "sourceUrls",
  "sourceFeed",
  "CD Url",
  "type",
  "contentType",
  "publishTarget",
  "targetLandingZone",
  "Cloud Provider",
  "cloudProvider",
  "contentStatus",
  "Live",
  "fetchedAt",
  "createdAt",
  "Created At",
  "updatedAt",
  "reviewedAt",
  "publishedAt",
  "Published At",
  "publishedDate",
  "datePublished",
  "pubDate",
  "keyTopics",
  "Tags",
  "aiTags",
  "forgeGrade",
  "forgeMeta",
  "slug",
  "Slug",
  "category",
  "wordCount",
  "readTime",
  "source",
  "altCoverImage",
  "coverImage",
  "Cover Image",
  "heroImageUrl",
  "contentImageUrl",
  "secondaryImageUrls",
  "aiImageUrls",
  "slugPageUrl",
  "publishedUrl",
  "publicUrl",
  "curatedSubpagePath",
  "format",
  // Workflow-page fields (EditorList/LivePages/Calendar/Published read these
  // from list rows; they came for free when the pages fetched whole docs):
  "Status",
  "scheduledPublishDate",
  "softDeletedAt",
  "softDeleteExpiresAt",
  "archivedAt",
  "blogEditedAt",
  "blogPublishedAt",
  "blogUrl",
  "publishedContentId",
  "sourceContentId",
  "provider",
  "critiqueVerdict",
  "critiqueGenericityScore",
  "critiqueSpecificityScore",
  "critiqueIssues",
  "draftRevised",
  // When Drafts' Send to In Review moved it into the Review Queue: an article
  // written on the page has no fetchedAt, so the queue orders it by this
  // (admin-snapshots.js reviewWaitingSince).
  "sentToReviewAt",
  // Taxonomy (ADR 0033 §4): what the item becomes, how it became an idea.
  "kind",
  "ideaOrigin",
];

export const LIST_DEFAULT_LIMIT = 25;
// 500 matches the workflow pages' fetch windows (EditorList/LivePages/
// Calendar asked Firestore for 500-doc windows); RPC callers pass no limit
// and keep the source default of 25.
export const LIST_MAX_LIMIT = 500;

/** `c["Cover Image"]` quoting handles the spaced/cased field names. */
const PROJECTION = [
  "c.id",
  ...ADMIN_CONTENT_SNAPSHOT_FIELDS.map((f) => `c["${f}"]`),
].join(", ");

/**
 * The fields a caller may order by, newest first. Each is a timestamp the
 * pipeline writes on the documents the caller is listing; a document missing
 * the field is excluded by Cosmos ORDER BY, which is why the default stays
 * unordered and the choice is the caller's.
 */
export const LIST_SORT_FIELDS = Object.freeze([
  "publishedAt",
  "updatedAt",
  "fetchedAt",
  "createdAt",
]);

/**
 * The bounds on a `?search=` term. `sort` is allowlisted and `limit` is
 * clamped; before these the term alone was unbounded, so one character
 * matched most of the container and a multi-kilobyte needle was carried
 * into the query (AP-F6, #930). Outside them the list answers the 400 the
 * sort path answers. Measured on the trimmed term; a blank term is no
 * search at all, not a short one. A page that sends the term mirrors
 * these, so a keystroke below the minimum never becomes a request.
 */
export const LIST_SEARCH_MIN_CHARS = 2;
export const LIST_SEARCH_MAX_CHARS = 100;

/** The version rows a History dialog lists: everything but the body itself. */
const VERSION_LIST_PROJECTION = [
  "c.id",
  "c.contentId",
  "c.title",
  "c.summary",
  "c.versionCreatedAt",
  "c.versionCreatedBy",
  "c.versionReason",
  "c.updatedFields",
  "c.tags",
  "c.authorName",
  "c.publishedDate",
  "LENGTH(c.draft) AS draftChars",
].join(", ");
export const VERSIONS_LIST_LIMIT = 50;

/** `kind` filter: stored, or derived from `type` when nothing is stored. */
export function kindFilterClause(kind, parameters) {
  const types = derivedKindTypes(kind);
  parameters.push({ name: "@kind", value: kind });
  if (types.length === 0) return "c.kind = @kind";
  parameters.push({ name: "@kindTypes", value: types });
  return (
    '(c.kind = @kind OR ((NOT IS_DEFINED(c.kind) OR c.kind = null OR c.kind = "") ' +
    "AND ARRAY_CONTAINS(@kindTypes, LOWER(c.type))))"
  );
}

/** `ideaOrigin` filter: stored, or derived from `source` when nothing is stored. */
export function ideaOriginFilterClause(ideaOrigin, parameters) {
  const { sources, includesUnknownSource, knownSources } =
    derivedOriginSources(ideaOrigin);
  parameters.push({ name: "@ideaOrigin", value: ideaOrigin });
  const unset =
    '(NOT IS_DEFINED(c.ideaOrigin) OR c.ideaOrigin = null OR c.ideaOrigin = "")';
  const derived = [];
  if (sources.length) {
    parameters.push({ name: "@originSources", value: sources });
    derived.push("ARRAY_CONTAINS(@originSources, c.source)");
  }
  if (includesUnknownSource) {
    parameters.push({ name: "@knownSources", value: knownSources });
    derived.push("NOT ARRAY_CONTAINS(@knownSources, c.source)");
  }
  if (derived.length === 0) return "c.ideaOrigin = @ideaOrigin";
  return `(c.ideaOrigin = @ideaOrigin OR (${unset} AND (${derived.join(" OR ")})))`;
}

const json = (status, body) => ({
  status,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// ── the list query ──────────────────────────────────────────────────────────

const queryText = (query, key) => String(query.get(key) || "").trim();
const queryLower = (query, key) => queryText(query, key).toLowerCase();

/** `?status=a,b`: one status is an equality, several an ARRAY_CONTAINS. */
function statusClause(statusParam, parameters) {
  const statuses = statusParam
    ? statusParam
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  if (statuses.length === 1) {
    parameters.push({ name: "@status", value: statuses[0] });
    return "c.contentStatus = @status";
  }
  if (statuses.length > 1) {
    parameters.push({ name: "@statuses", value: statuses });
    return "ARRAY_CONTAINS(@statuses, c.contentStatus)";
  }
  return null;
}

/** `?type=`: case-insensitive (Frameworks/CoderCorner boards). */
function typeClause(type, parameters) {
  if (!type) return null;
  parameters.push({ name: "@type", value: type });
  return "LOWER(c.type) = @type";
}

/**
 * `?search=`: a substring of the title or summary, under both casings the
 * module header names, compared case-insensitively by CONTAINS's third
 * argument. The form this replaces, `CONTAINS(LOWER(field), @lowered)`, is
 * the one Cosmos DB documents as not using the index at all (a full scan:
 * every item of the container loaded, ~70k here across every partition;
 * query advisor QA1006), where CONTAINS on the field itself is a full
 * index scan: the path's distinct indexed values are read and only the
 * matches are loaded.
 *   https://learn.microsoft.com/azure/cosmos-db/index-overview#index-usage
 *   https://learn.microsoft.com/azure/cosmos-db/nosql/query/contains
 *   https://learn.microsoft.com/azure/cosmos-db/nosql/query/lower
 * The parameter keeps the caller's casing: the comparison ignores it, and
 * lowering it here would only suggest the predicate needed it.
 */
function searchClause(search, parameters) {
  if (!search) return null;
  parameters.push({ name: "@search", value: search });
  return (
    "(CONTAINS(c.title, @search, true) OR " +
    'CONTAINS(c["Title"], @search, true) OR ' +
    "CONTAINS(c.summary, @search, true) OR " +
    'CONTAINS(c["Summary"], @search, true))'
  );
}

/**
 * GET /api/cms/content's query string as the Cosmos query and its
 * parameters, or `{ error }` for a sort field the list does not offer or
 * a search term outside LIST_SEARCH_MIN_CHARS..LIST_SEARCH_MAX_CHARS.
 */
export function buildListQuery(query) {
  const sort = queryText(query, "sort");
  if (sort && !LIST_SORT_FIELDS.includes(sort)) {
    return { error: `sort must be one of: ${LIST_SORT_FIELDS.join(", ")}` };
  }
  const search = queryText(query, "search") || queryText(query, "q");
  if (
    search &&
    (search.length < LIST_SEARCH_MIN_CHARS ||
      search.length > LIST_SEARCH_MAX_CHARS)
  ) {
    return {
      error: `search must be ${LIST_SEARCH_MIN_CHARS} to ${LIST_SEARCH_MAX_CHARS} characters`,
    };
  }
  // `?limit=abc` produced `TOP NaN` (a 500 carrying raw Cosmos error
  // text) and `?limit=0` produced `TOP 0` (a silently empty list). Same
  // clamp the four sibling handlers use (T-310).
  const max = Math.min(
    Math.max(Number(query.get("limit")) || LIST_DEFAULT_LIMIT, 1),
    LIST_MAX_LIMIT,
  );
  const parameters = [{ name: "@limit", value: max }];
  const kind = queryLower(query, "kind");
  const ideaOrigin = queryLower(query, "ideaOrigin");
  // In parameter order: each clause pushes its own parameters as it is built.
  const clauses = [
    statusClause(queryText(query, "status"), parameters),
    query.get("live") === "true" ? "c.Live = true" : null,
    typeClause(queryLower(query, "type"), parameters),
    kind ? kindFilterClause(kind, parameters) : null,
    ideaOrigin ? ideaOriginFilterClause(ideaOrigin, parameters) : null,
    searchClause(search, parameters),
  ].filter(Boolean);

  let text = `SELECT TOP @limit ${PROJECTION} FROM c`;
  if (clauses.length > 0) text += ` WHERE ${clauses.join(" AND ")}`;
  if (sort) text += ` ORDER BY c["${sort}"] DESC`;
  return { query: text, parameters };
}

// ── the handlers ────────────────────────────────────────────────────────────

/**
 * Every handler: the editor role, then the body, then one place a failure
 * is logged under `name` and answered as `failure` — never error.message,
 * which is raw Cosmos text on these paths and can carry query structure.
 */
function guarded(guard, { name, failure }, fn) {
  return async (request, context) => {
    const auth = await guard.requireRole(request, "editor");
    if (auth.error) return auth.error;
    try {
      return await fn(request, context);
    } catch (error) {
      context.error(`${name} failed:`, error);
      return json(500, { error: failure });
    }
  };
}

/** The content id of a get: the query on GET, the JSON body otherwise. */
async function contentIdOf(request) {
  if (String(request.method).toUpperCase() === "GET") {
    return request.query.get("contentId");
  }
  const body = await request.json().catch(() => null);
  return body?.contentId;
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard role guard (default-guard.js in prod)
 * @param {{ queryDocs: Function, readDoc: Function, deleteDoc: Function }} deps.store
 */
export function createCmsContentHandlers({
  guard,
  store,
  onContentDeleted = null,
}) {
  return {
    /**
     * GET /api/cms/content — source: listContentItems.
     * status accepts a comma-separated list (the workflow pages query
     * multi-status windows); live=true filters to c.Live = true; type
     * filters case-insensitively (Frameworks/CoderCorner boards); kind and
     * ideaOrigin filter on the taxonomy (stored or derived); sort orders by
     * one of LIST_SORT_FIELDS, newest first; search (or q) finds a title or
     * summary substring, case-insensitively, LIST_SEARCH_MIN_CHARS to
     * LIST_SEARCH_MAX_CHARS long.
     */
    list: guarded(
      guard,
      { name: "listContentItems", failure: "Failed to list content items" },
      async (request) => {
        const built = buildListQuery(request.query);
        if (built.error) return json(400, { error: built.error });
        const items = await store.queryDocs(
          "content",
          built.query,
          built.parameters,
        );
        return json(200, { success: true, items, total: items.length });
      },
    ),

    /** GET|POST /api/cms/content/item — source: getContentItem */
    get: guarded(
      guard,
      { name: "getContentItem", failure: "Failed to get content item" },
      async (request) => {
        const contentId = await contentIdOf(request);
        if (!contentId) return json(400, { error: "contentId required" });
        const item = await store.readDoc("content", contentId, contentId);
        if (!item)
          return json(404, { error: `content ${contentId} not found` });
        return json(200, { success: true, item });
      },
    ),

    /**
     * GET /api/cms/content/{id}/versions — the saved versions of one record,
     * newest first, without bodies (ADR 0033 §1: content_versions was written
     * on every save and read by nothing). Editor role: the same role that
     * writes them.
     */
    listVersions: guarded(
      guard,
      {
        name: "listContentVersions",
        failure: "Failed to list content versions",
      },
      async (request) => {
        const contentId = request.params?.id;
        if (!contentId) return json(400, { error: "id required" });
        const versions = await store.queryDocs(
          "content_versions",
          `SELECT TOP ${VERSIONS_LIST_LIMIT} ${VERSION_LIST_PROJECTION} FROM c WHERE c.contentId = @contentId ORDER BY c.versionCreatedAt DESC`,
          [{ name: "@contentId", value: contentId }],
        );
        return json(200, {
          success: true,
          contentId,
          versions,
          limit: VERSIONS_LIST_LIMIT,
        });
      },
    ),

    /** GET /api/cms/content/{id}/versions/{versionId} — one version, body included. */
    getVersion: guarded(
      guard,
      { name: "getContentVersion", failure: "Failed to read content version" },
      async (request) => {
        const contentId = request.params?.id;
        const versionId = request.params?.versionId;
        if (!contentId || !versionId)
          return json(400, { error: "id and versionId required" });
        // Partitioned by /contentId (the manifest's one non-/id container).
        const version = await store.readDoc(
          "content_versions",
          versionId,
          contentId,
        );
        if (!version || version.contentId !== contentId) {
          return json(404, { error: `version ${versionId} not found` });
        }
        return json(200, { success: true, version });
      },
    ),

    // Creation lives in cms/content-create.js (full source semantics: dedup,
    // quality gate). The interim raw-upsert `save` placeholder is retired —
    // a validation-free write path must not coexist with the real one.

    /** DELETE /api/cms/content/{id} — blob cleanup still pending, as before. */
    remove: guarded(
      guard,
      { name: "cmsDeleteContent", failure: "Failed to delete content" },
      async (request, context) => {
        const id = request.params.id;
        if (!id) return json(400, { error: "id required" });
        await store.deleteDoc("content", id);
        // The change feed never delivers a delete (T-324): the dashboard
        // counters are moved here, best-effort.
        if (onContentDeleted) {
          await onContentDeleted(id).catch((err) =>
            context.warn?.(
              `cmsDeleteContent: counters not updated for ${id}: ${err?.message}`,
            ),
          );
        }
        return json(200, { success: true });
      },
    ),
  };
}
