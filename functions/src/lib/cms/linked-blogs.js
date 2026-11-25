/**
 * linked-blogs.js — the legacy `blogs` documents linked to a content page,
 * and how a status transition carries them with the page (AP-F13, #937).
 * Used by content-update.js, whose settleLinkedBlogs runs the rounds.
 */
import { isPublicDocument } from "../public-reads.js";
import { normalizeCurrentStatusForBlogOnly } from "./content-update-validation.js";

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
 *
 * FENCED AGAINST THE NEXT TRANSITION. The content write is guarded by its
 * ETag; the blogs are a second container, with no transaction across the
 * two. Carrying what was decided before the write let two transitions
 * cross: a restore publishes the page and pauses, an archive then finds no
 * public blog to carry (they are still archived) and archives the page, and
 * the restore wakes and publishes the blogs, leaving a copy of an archived
 * page on the site; the mirror order left a live page with its blogs
 * hidden. Re-checking only the transition's own work afterwards is not
 * enough either, because the archive can read the blogs before the restore
 * carries them and write the page after the restore has checked. So the
 * blogs are settled against the content as it reads AFTER the write, not
 * against the edge that was asked for (settleLinkedBlogs): an archived page
 * takes down every linked blog the site serves, a published one brings back
 * the blogs it archived, and any other status moves none. Each blog is
 * written under the ETag of the read that chose it, and once the round's
 * writes are done the content is read again; if it moved, or a blog did, the
 * round runs again from fresh reads. Every carrying transition settles after
 * its own write, so the one that wrote the page last settles against its
 * final status, and an earlier one that wrote a blog from an older read of
 * the page then finds the page moved and settles again: the blogs end in
 * agreement with the page's final status.
 *
 * What that rests on: each read seeing the latest committed write. The
 * account runs at Session consistency (infra/cosmos.tf), under which a read
 * from another instance can trail a write by the replication delay, so the
 * fence narrows a pause of any length to that delay rather than closing it
 * outright; the conditional writes themselves are checked against the
 * current version and are exact.
 */
const BLOG_VISIBILITY_FIELDS = [
  "Live",
  "Status",
  "contentStatus",
  "scheduledPublishDate",
];

/** How many times the blogs are settled again when the page or a blog moves underneath them. */
export const MAX_SETTLE_ROUNDS = 3;

/**
 * Whether an edge moves the linked blogs at all: entering the archive, from
 * any status, and leaving it for `published`. Every other edge leaves them
 * where they are, and reads none of them.
 */
export function carriesLinkedBlogs(from, to) {
  return to === "archived" || (from === "archived" && to === "published");
}

/**
 * Every blog linked to the content, once each, with the fields the choice
 * below reads and the `_etag` its write is conditioned on.
 */
export async function readLinkedBlogs(store, data, contentId) {
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
    "SELECT TOP 50 c.id, c._etag, c.Live, c.Status, c.contentStatus, c.softDeletedAt, c.softDeleteExpiresAt, c.archivedWithContentId FROM c WHERE c.sourceContentId = @id OR c.publishedContentId = @id",
    [{ name: "@id", value: contentId }],
  );
  for (const row of rows || []) if (!byId.has(row.id)) byId.set(row.id, row);
  return [...byId.values()];
}

/**
 * The linked blogs that disagree with the content as it now reads: under an
 * archived page, every one the site serves; under a published page, the
 * ones it archived; under any other status, none.
 */
function blogsOutOfStep(content, blogs, contentId) {
  const status = normalizeCurrentStatusForBlogOnly(
    content.contentStatus || "ingested",
  );
  if (status === "archived") {
    return blogs.filter((blog) => isPublicDocument(blog));
  }
  if (status === "published") {
    return blogs.filter((blog) => blog.archivedWithContentId === contentId);
  }
  return [];
}

/**
 * The content's own visibility fields, as it now reads, onto a linked blog:
 * an archived page has `Live: false`, `Status: 'Archived'`, `contentStatus:
 * 'archived'` and no schedule; a published one has `Live` and `contentStatus:
 * 'published'` and no `Status` word, as publishing writes it
 * (content-status.js applyStatusPublished). A field the page does not carry
 * is removed from the blog. Archiving stamps the blog with the page and the
 * page's archive time; bringing it back clears both.
 */
function blogPatchFor(content, contentId, nowIso) {
  const visibility = Object.fromEntries(
    BLOG_VISIBILITY_FIELDS.map((field) => [field, content[field]]),
  );
  const archived =
    normalizeCurrentStatusForBlogOnly(content.contentStatus || "ingested") ===
    "archived";
  const marker = archived
    ? {
        archivedWithContentId: contentId,
        archivedAt: content.archivedAt || nowIso,
      }
    : { archivedWithContentId: undefined, archivedAt: null };
  return { ...visibility, ...marker, updatedAt: nowIso };
}

/**
 * One blog's write, under the ETag of the read that chose it: `written`;
 * `changed` when another write landed on the blog since that read (a 412,
 * so the next round decides again from a fresh read rather than
 * overwriting it); or `gone` when it was deleted in between (a 404, nothing
 * left to agree with the page). Any other failure is thrown.
 */
async function patchBlogAsRead(store, blog, patch) {
  try {
    await store.patchDoc("blogs", blog.id, patch, { ifMatch: blog._etag });
    return "written";
  } catch (error) {
    if (error?.code === 412) return "changed";
    if (error?.code === 404) return "gone";
    throw error;
  }
}

/** Add `id` to `list` unless it is there already, keeping first-seen order. */
export const addOnce = (list, id) => {
  if (!list.includes(id)) list.push(id);
};

/**
 * One settling round against `content`: every linked blog out of step with
 * it is written, and the ids that lost a race to another write are returned
 * for the next round to decide again.
 */
export async function settleRound(store, content, contentId, nowIso, outcome) {
  const linked = await readLinkedBlogs(store, content, contentId);
  const patch = blogPatchFor(content, contentId, nowIso);
  const changed = [];
  for (const blog of blogsOutOfStep(content, linked, contentId)) {
    const result = await patchBlogAsRead(store, blog, patch);
    if (result === "written") addOnce(outcome.carried, blog.id);
    else if (result === "gone") addOnce(outcome.skipped, blog.id);
    else changed.push(blog.id);
  }
  return changed;
}

/**
 * What the audit row records of the blogs a transition settled: the ids it
 * wrote, the ids it could not settle, and that it did not finish, each only
 * when there is something to say.
 */
export function linkedBlogsAuditMetadata(linked) {
  if (!linked) return {};
  return {
    ...(linked.carried.length ? { linkedBlogIds: linked.carried } : {}),
    ...(linked.skipped.length ? { linkedBlogIdsSkipped: linked.skipped } : {}),
    ...(linked.settled ? {} : { linkedBlogsSettled: false }),
  };
}
