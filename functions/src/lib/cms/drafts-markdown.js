/**
 * drafts-markdown.js — the pure half of "Paste or upload a markdown draft"
 * (POST cms/drafts/from-markdown, owner decision 2026-10-25: drafts live in
 * the private Obsidian vault and in this admin, not in the public repository).
 *
 * The request carries a whole markdown file, front matter and all, in the
 * format docs/content/blog-template.md describes. It is read by the parser
 * the removed docs/content import used (repo-draft.js parseRepoDraft, which
 * takes text and needs no repository path), then checked by the same field
 * validator a draft typed on the page goes through (drafts.js
 * validateDraftFields), so a file cannot carry anything a typed draft could
 * not. The repository-path checks (checkRepoDraftPath and the raw-URL
 * builders) belonged to the removed fetch from GitHub; nothing here fetches,
 * and they are untouched.
 *
 * Nothing here does I/O, and nothing here logs the markdown.
 *
 * ONE ARTICLE, ONE ID. The document id is derived from the normalised title
 * (the same normaliser the dedup gate uses), the way the import derives its
 * id from the repository path. Two uploads of the same article, even at the
 * same instant, race to the same id and the create is create-only
 * (drafts-handlers.js), so the second is told "already present" rather than
 * written again.
 */
import { createHash } from "node:crypto";
import { AuthoredError } from "../http/error-response.js";
import { normalizeTitleForDedup } from "./content-dedup.js";
import { MAX_DRAFT_BODY_BYTES, DRAFT_ORIGINS } from "./drafts.js";
import { parseRepoDraft } from "./repo-draft.js";

/** The two values the request's `origin` may take, and the `draftOrigin` each is stored as. */
export const MARKDOWN_ORIGINS = Object.freeze({
  vault: DRAFT_ORIGINS.vault,
  paste: DRAFT_ORIGINS.paste,
  // DRAFT_ORIGINS.agent is deliberately absent: a request body cannot claim
  // it. The Agent Content API's handlers pass it as the forced `origin` of
  // readMarkdownRequest (drafts-handlers.js createFromMarkdown).
});

/**
 * Room for the front matter on top of the body cap. The body itself is held
 * to MAX_DRAFT_BODY_BYTES by validateDraftFields; this bounds the whole file
 * before it is parsed.
 */
export const FRONT_MATTER_ALLOWANCE_BYTES = 16 * 1024;
export const MAX_MARKDOWN_BYTES =
  MAX_DRAFT_BODY_BYTES + FRONT_MATTER_ALLOWANCE_BYTES;
/**
 * The whole request, as JSON: every quote, backslash and newline in the file
 * can double in size once escaped, so twice the file plus a little.
 */
export const MAX_REQUEST_BYTES = MAX_MARKDOWN_BYTES * 2 + 1024;

/** Thrown for a request the owner can correct; the handler answers 400 with the message. */
export class MarkdownRequestError extends AuthoredError {}

/**
 * The namespace for markdownDraftContentId. Fixed forever, for the reason
 * repo-draft.js REPO_DRAFT_ID_NAMESPACE is: changing it would give every
 * draft already sent in a different id, and a second upload would duplicate.
 */
export const MARKDOWN_DRAFT_ID_NAMESPACE = "5d0a3a1e-6f0b-4c52-9f1e-0e2b7c3d8a41";

/**
 * A deterministic, UUID-shaped document id for an article's title (RFC 9562
 * version 5: SHA-1 over the namespace and the name). Case, accents and
 * punctuation do not change it (normalizeTitleForDedup), so "Landing Zones:
 * First Steps" and "landing zones first steps" are one article.
 *
 * @param {string} title
 * @returns {string|null} null when the title normalises to nothing
 */
export function markdownDraftContentId(title) {
  const name = normalizeTitleForDedup(title);
  if (!name) return null;
  const namespace = Buffer.from(
    MARKDOWN_DRAFT_ID_NAMESPACE.replace(/-/g, ""),
    "hex",
  );
  const bytes = createHash("sha1")
    .update(namespace)
    .update(Buffer.from(`markdown-draft:${name}`, "utf8"))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The request body → the markdown and the draftOrigin it is stored under.
 *
 * A caller whose origin is fixed by its handlers (the Agent Content API,
 * ADR 0037) passes it as `forcedOrigin`; the body's `origin` is then not
 * read at all, so it can neither claim another origin nor be required.
 *
 * @param {unknown} body - the parsed JSON
 * @param {{ origin?: string|null }} [options] - `origin`: the forced draftOrigin
 * @returns {{ markdown: string, draftOrigin: string }}
 * @throws {MarkdownRequestError}
 */
export function readMarkdownRequest(body, { origin: forcedOrigin = null } = {}) {
  const { markdown, origin } = body && typeof body === "object" ? body : {};
  const draftOrigin =
    forcedOrigin ||
    (Object.hasOwn(MARKDOWN_ORIGINS, origin) ? MARKDOWN_ORIGINS[origin] : null);
  if (!draftOrigin) {
    throw new MarkdownRequestError(
      `origin must be "vault" (a file from your vault) or "paste" (text pasted into the page).`,
    );
  }
  if (typeof markdown !== "string" || !markdown.trim()) {
    throw new MarkdownRequestError(
      "markdown is required: the whole text of the draft file, front matter included.",
    );
  }
  return { markdown, draftOrigin };
}

/** Is the file over the cap? Measured in UTF-8 bytes, as the body cap is. */
export const isMarkdownTooLarge = (markdown) =>
  Buffer.byteLength(markdown, "utf8") > MAX_MARKDOWN_BYTES;

/**
 * A markdown file → the eight editor fields validateDraftFields takes, plus
 * what the parser noticed (warnings, embed fences). Pure.
 *
 * @param {string} markdown
 * @returns {{ ok: true, fields: object, warnings: string[], embeds: object }
 *   | { ok: false, code: string, error: string }}
 */
export function parseMarkdownDraft(markdown) {
  const parsed = parseRepoDraft(markdown);
  if (!parsed.ok) return parsed;
  const { draft } = parsed;
  return {
    ok: true,
    fields: {
      title: draft.title,
      subtitle: draft.subtitle,
      date: draft.date,
      track: draft.track,
      part: draft.part,
      tags: draft.tags,
      reading: draft.reading,
      body: draft.body,
    },
    warnings: draft.warnings,
    embeds: draft.embeds,
  };
}
