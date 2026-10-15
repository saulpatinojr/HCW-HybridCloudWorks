/**
 * drafts.js — the pure half of the Drafts stage (owner request 2026-10-03):
 * articles the owner writes on /admin/drafts, saved in the site, and sent on
 * to In Review when they are ready.
 *
 * Nothing here does I/O. The routes and the store are ./drafts-handlers.js,
 * the GitHub import ./drafts-import.js. This module decides what a draft may
 * contain, the documents it is written as and the views the page receives;
 * ./drafts-stage.js (re-exported from here) decides where a document is,
 * which moves are allowed from there, and what each transition writes.
 *
 * ONE DOCUMENT, NOT TWO. A draft is an ordinary `content` document — the same
 * container, the same shape the repository import has written since
 * 2026-09-28 — at contentStatus `drafting` (content-status.js
 * DRAFTS_STAGE_STATUS). Send to In Review moves that same document to
 * `in_review`; Back to Drafts moves it back. So there is never a second copy
 * to drift from the first, and "deleting a draft that is In Review also
 * removes the In Review item" holds by construction: they are one document.
 * No new container, no new index, no Terraform.
 *
 * WHAT A DRAFT CAN NEVER BE. Every draft is written `Live: false`,
 * `Status: 'Draft'` and `contentStatus: 'drafting'`, and the edit payload is
 * an allow-list of the eight editor fields — so no Drafts route can set a
 * workflow field, a slug, or anything a public read keys on
 * (public-reads.js isPublicDocument, the manifest's PUBLISHED_PREDICATE).
 * isPublicDocument also refuses `drafting` outright (NEVER_PUBLIC_STATUSES).
 *
 * THE BODY IS STORED AS WRITTEN while it is a draft. normalizeContentBodyFields
 * (trim, TL;DR to the end) runs once, at Send to In Review — the point where
 * the article enters the pipeline, which is where createContentDocument runs
 * it for every other writer. Running it on every save would move the owner's
 * text around under the cursor.
 */
import { AuthoredError } from "../http/error-response.js";
import {
  MAX_SUBTITLE_CHARS,
  MAX_TAG_CHARS,
  MAX_TAGS,
  MAX_TITLE_CHARS,
  isCalendarDate,
} from "./repo-draft.js";
import { MAX_DRAFT_BYTES } from "./repo-draft-source.js";
import {
  assertStringArray,
  assertStringLength,
  isPlainObject,
} from "./content-update-validation.js";
import { getPrimaryContentBody } from "./content-quality.js";
import { DRAFTS_STAGE_STATUS } from "./content-status.js";
import {
  DRAFT_ORIGINS,
  allowedActions,
  stageOf,
  statusOf,
} from "./drafts-stage.js";
import { resolveIdeaOrigin, resolveKind } from "./taxonomy.js";

// The stage half lives in ./drafts-stage.js; re-exported so callers import
// the Drafts stage from one place.
export * from "./drafts-stage.js";

/**
 * The body cap. The same number the repository import caps a fetched file at
 * (repo-draft-source.js), so an article imported from docs/content is never
 * too large to save again. Measured in UTF-8 bytes, as that cap is.
 */
export const MAX_DRAFT_BODY_BYTES = MAX_DRAFT_BYTES;
export const MAX_TRACK_CHARS = 40;
export const MAX_PART_CHARS = 20;
export const MAX_READING_MINUTES = 999;

/**
 * The editor's fields — the seven front-matter keys docs/content/blog-template.md
 * names, the body, and the two taxonomy fields (ADR 0033 §4: what the draft
 * will become, how it became an idea). A save carries these and nothing else.
 */
export const DRAFT_FIELDS = Object.freeze([
  "title",
  "subtitle",
  "date",
  "track",
  "part",
  "tags",
  "reading",
  "body",
  "kind",
  "ideaOrigin",
]);

/** What a draft written on the page is until the owner says otherwise. */
export const DRAFT_TAXONOMY_DEFAULTS = Object.freeze({
  kind: "article",
  ideaOrigin: "manual",
});

/** The id shape taxonomy.js stores; membership is the handler's check (it has the store). */
const TAXONOMY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/;

function readTaxonomyId(value, name) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") fail(`${name} must be a string`);
  const id = value.trim().toLowerCase();
  if (!TAXONOMY_ID_PATTERN.test(id)) {
    fail(
      `${name} must be a taxonomy id (2-40 lower-case letters, digits or hyphens)`,
    );
  }
  return id;
}

/** Thrown for input the owner can correct; the handler answers 400 with the message (authored, #945). */
export class DraftInputError extends AuthoredError {}

const fail = (message) => {
  throw new DraftInputError(message);
};

/**
 * The tags of a save, as a de-duplicated list.
 *
 * @param {unknown} value - a list or a comma-separated string
 * @returns {string[]}
 * @throws {ContentValidationError}
 */
function readTags(value) {
  if (value === undefined || value === null || value === "") return [];
  const list = typeof value === "string" ? value.split(",") : value;
  // assertStringArray throws a ContentValidationError: authored, shown as
  // the 400 the same way a DraftInputError is (drafts-handlers answerFor).
  const tags = assertStringArray(list, "tags", {
    maxItems: MAX_TAGS,
    maxItemLength: MAX_TAG_CHARS,
  });
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

function readReading(value) {
  if (value === undefined || value === null || value === "") return null;
  const minutes =
    typeof value === "number" ? value : Number(String(value).trim());
  if (
    !Number.isInteger(minutes) ||
    minutes < 1 ||
    minutes > MAX_READING_MINUTES
  ) {
    fail(`reading must be a whole number of minutes, 1-${MAX_READING_MINUTES}`);
  }
  return minutes;
}

function readDate(value) {
  const date = String(value ?? "").trim();
  if (!date) return null;
  if (!isCalendarDate(date)) fail("date must be a calendar date, YYYY-MM-DD");
  return date;
}

/**
 * One text field of a save, trimmed and within its length.
 *
 * @param {unknown} value - the field
 * @param {string} name - its name, for the refusal
 * @param {number} max - the ceiling
 * @param {{ required?: boolean }} [options]
 * @returns {string}
 * @throws {DraftInputError|ContentValidationError}
 */
function readText(value, name, max, { required = false } = {}) {
  if (value !== undefined && value !== null && typeof value !== "string") {
    fail(`${name} must be a string`);
  }
  return assertStringLength(value, name, max, {
    allowEmpty: !required,
  }).trim();
}

/**
 * A save's payload → the eight fields, normalised. Throws DraftInputError,
 * or the ContentValidationError of a length or list rule; both are authored.
 *
 * An allow-list, so `contentStatus`, `Live`, `Status`, `slug` and every other
 * field FORBIDDEN_CONTENT_UPDATE_KEYS protects are refused by not being one
 * of the eight — named in the error, so a client bug is visible.
 *
 * @param {unknown} input
 * @returns {{ title: string, subtitle: string, date: string|null, track: string|null,
 *   part: string|null, tags: string[], reading: number|null, body: string,
 *   kind: string|null, ideaOrigin: string|null }}
 */
export function validateDraftFields(input) {
  if (!isPlainObject(input)) fail("A JSON object of draft fields is required.");
  const unknown = Object.keys(input).filter(
    (key) => !DRAFT_FIELDS.includes(key),
  );
  if (unknown.length) fail(`Not a draft field: ${unknown.join(", ")}`);

  const body = input.body ?? "";
  if (typeof body !== "string") fail("body must be a string");
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > MAX_DRAFT_BODY_BYTES) {
    fail(`The body is ${bytes} bytes; at most ${MAX_DRAFT_BODY_BYTES}.`);
  }
  return {
    title: readText(input.title, "title", MAX_TITLE_CHARS, { required: true }),
    subtitle: readText(input.subtitle, "subtitle", MAX_SUBTITLE_CHARS),
    date: readDate(input.date),
    track: readText(input.track, "track", MAX_TRACK_CHARS) || null,
    part: readText(input.part, "part", MAX_PART_CHARS) || null,
    tags: readTags(input.tags),
    reading: readReading(input.reading),
    body,
    kind: readTaxonomyId(input.kind, "kind"),
    ideaOrigin: readTaxonomyId(input.ideaOrigin, "ideaOrigin"),
  };
}

/** The document fields the eight editor fields map to — the repository import's names. */
function documentFields(fields) {
  return {
    Title: fields.title,
    title: fields.title,
    Summary: fields.subtitle,
    summary: fields.subtitle,
    Content: fields.body,
    content: fields.body,
    postContent: fields.body,
    Tags: fields.tags,
    // `undefined` deletes on a patch (patchDoc's convention) and is dropped
    // from a create: no reading time stated, none stored.
    readTime: fields.reading ? `${fields.reading} min` : undefined,
    // The taxonomy fields only when the save names them: an older page that
    // sends neither leaves the stored classification alone.
    ...(fields.kind && { kind: fields.kind }),
    ...(fields.ideaOrigin && { ideaOrigin: fields.ideaOrigin }),
    frontMatter: {
      title: fields.title,
      subtitle: fields.subtitle,
      date: fields.date,
      track: fields.track,
      part: fields.part,
      tags: fields.tags,
      reading: fields.reading,
    },
  };
}

/**
 * The fields that make a document a draft and keep it off every public read.
 * Applied last on every create, so nothing spread before them can win.
 */
export const DRAFT_INVARIANTS = Object.freeze({
  contentStatus: DRAFTS_STAGE_STATUS,
  Live: false,
  Status: "Draft",
  approvedForBlog: false,
  approvedForNews: false,
  // The change-feed inspector would rewrite a hand-written article with a
  // model's summary of it (repo-draft.js buildRepoDraftData, same reason).
  inspectTrigger: false,
});

/**
 * A new draft written on the page. No slug (the slug-holders probe is not
 * status-filtered, so a draft holding one would push a published article onto
 * a suffix — repo-draft.js), no dedup fields (a half-written draft must not
 * make the dedup gate refuse other content by title; they are stamped at Send
 * to In Review), no provider (inferred from the tags at Send to In Review, set
 * on the review board otherwise).
 */
export function buildNewDraftDocument({
  id,
  fields,
  editor,
  now = () => new Date(),
}) {
  const stamp = now().toISOString();
  const { readTime, ...rest } = documentFields(fields);
  return {
    id,
    type: "blog",
    publishTarget: "blog",
    ...rest,
    ...(readTime && { readTime }),
    keyTopics: fields.tags,
    Author: "Hybrid Cloud Works",
    source: "drafts",
    sourceTrustLevel: "manual",
    trustedSource: true,
    kind: fields.kind || DRAFT_TAXONOMY_DEFAULTS.kind,
    ideaOrigin: fields.ideaOrigin || DRAFT_TAXONOMY_DEFAULTS.ideaOrigin,
    draftOrigin: DRAFT_ORIGINS.site,
    storageCollection: "content",
    createdBy: editor,
    "Created At": stamp,
    updatedAt: stamp,
    updatedBy: editor,
    ...DRAFT_INVARIANTS,
  };
}

/**
 * A docs/content file, as a draft: repo-draft.js buildRepoDraftData's document
 * (the existing import's shape, provenance and all) with the Drafts stage's
 * status and stamping in place of in_review's.
 */
export function asImportedDraft(
  repoData,
  { id, editor, now = () => new Date() },
) {
  const stamp = now().toISOString();
  return {
    ...repoData,
    id,
    // A repository article is a hand-written article (ADR 0033 §4).
    kind: DRAFT_TAXONOMY_DEFAULTS.kind,
    ideaOrigin: DRAFT_TAXONOMY_DEFAULTS.ideaOrigin,
    draftOrigin: DRAFT_ORIGINS.repo,
    storageCollection: "content",
    createdBy: editor,
    "Created At": stamp,
    updatedAt: stamp,
    updatedBy: editor,
    ...DRAFT_INVARIANTS,
  };
}

/**
 * The patch a Save applies. `blogDraft` only when the document already has one
 * — approval copies the body into an absent blogDraft and keeps a present one
 * (content-status.js), so a stale one left here would be the text the editor
 * opens after approval (repo-draft.js made the same choice for re-imports).
 */
export function buildDraftUpdate(
  fields,
  { current = {}, editor, now = () => new Date() },
) {
  const stamp = now().toISOString();
  return {
    ...documentFields(fields),
    ...(typeof current.blogDraft === "string" && { blogDraft: fields.body }),
    updatedAt: stamp,
    updatedBy: editor,
  };
}

// ── what the page receives ─────────────────────────────────────────────────

function readingOf(doc) {
  const fromReadTime = /^(\d{1,3})\b/.exec(String(doc.readTime || ""))?.[1];
  if (fromReadTime) return Number(fromReadTime);
  const fromFrontMatter = Number(doc.frontMatter?.reading);
  return Number.isInteger(fromFrontMatter) && fromFrontMatter > 0
    ? fromFrontMatter
    : null;
}

/** One row of the list. No body: the list is read on every visit. */
export function toDraftSummary(doc = {}) {
  return {
    id: doc.id,
    title: String(doc.Title || doc.title || "").trim() || "Untitled draft",
    subtitle: String(doc.Summary ?? doc.summary ?? ""),
    contentStatus: statusOf(doc),
    stage: stageOf(doc),
    live: doc.Live === true,
    origin: doc.draftOrigin || (doc.repoPath ? DRAFT_ORIGINS.repo : null),
    kind: resolveKind(doc),
    ideaOrigin: resolveIdeaOrigin(doc),
    repoPath: doc.repoPath || null,
    updatedAt: doc.updatedAt || doc["Created At"] || null,
    etag: doc._etag || null,
    actions: allowedActions(doc),
  };
}

/** The open draft: the summary plus the eight editor fields. */
export function toDraftView(doc = {}) {
  const front = doc.frontMatter || {};
  const tags = Array.isArray(doc.Tags)
    ? doc.Tags
    : Array.isArray(front.tags)
      ? front.tags
      : [];
  return {
    ...toDraftSummary(doc),
    fields: {
      title: String(doc.Title || doc.title || ""),
      subtitle: String(doc.Summary ?? doc.summary ?? ""),
      date: front.date || null,
      track: front.track || null,
      part: front.part || null,
      tags: tags.map(String),
      reading: readingOf(doc),
      body: getPrimaryContentBody(doc),
      kind: resolveKind(doc),
      ideaOrigin: resolveIdeaOrigin(doc),
    },
  };
}
