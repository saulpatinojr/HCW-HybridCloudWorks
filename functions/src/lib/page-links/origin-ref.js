/**
 * origin-ref.js — "where this came from" for a piece of content that another
 * admin Page sent into the Pipeline (#1886).
 *
 * WHY. The Pipeline (Drafts → Review Queue → Editor → Publish → Live Pages)
 * is the one place content is drafted, reviewed, scheduled and published. A
 * Page such as Ambassador should be able to start a piece there without
 * building a second workflow, and both ends should keep the link: the
 * Pipeline shows which Page and record the piece serves, and the sending Page
 * can list its pieces and their stage.
 *
 * WHAT IS STORED. One field on the content document, `originRef`:
 *
 *   { page, id, part, label }
 *
 *   page   the admin Page that sent it: its nav id (frontend/src/config/adminNav.js),
 *          so the frontend can name and link it from the same registry the sidebar reads
 *   id     the record on that Page (an Ambassador program id)
 *   part   an optional piece of that record (a program's requirement id), or null
 *   label  the record's name when the piece was sent, so a list can show it
 *          without reading the other Page's container
 *
 * It is written once, when the draft is created, and never by a later save:
 * cms/content-update-validation.js refuses it in updateContentItem, and the
 * Drafts save takes only the editor's fields. The reference is checked here
 * against the record it names, so a caller cannot attach a piece to a program
 * that does not exist, or invent a Page.
 *
 * ADDING A PAGE. One entry in ORIGIN_PAGES below, plus its link builder in
 * frontend/src/lib/pageLinks.js (pageLinks.test.js fails until both agree).
 * The checklist is in .claude/CLAUDE.md, "How the admin Pages connect".
 */
import { AuthoredError } from "../http/error-response.js";

/** Record ids on the Pages below: uuids with a prefix, or fixed seed ids. */
const REF_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const PART_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_LABEL_CHARS = 200;

/** Input the caller can correct; the Drafts handlers answer it as 400 INVALID. */
export class OriginRefError extends AuthoredError {}

const fail = (message) => {
  throw new OriginRefError(message);
};

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const trimmedLabel = (value) =>
  String(value || "")
    .trim()
    .slice(0, MAX_LABEL_CHARS);

/**
 * The Pages that may send work into the Pipeline, by nav id.
 *
 *   container    the Cosmos container the record lives in (partition key /id)
 *   ideaOrigin   the taxonomy id a draft from this Page gets when the caller names
 *                none (functions/src/lib/cms/taxonomy.js DEFAULT_IDEA_ORIGINS)
 *   check(doc, part)  the record's label, or a sentence saying why the reference
 *                is refused. `doc` is null when no record has the id.
 */
export const ORIGIN_PAGES = Object.freeze({
  ambassador: Object.freeze({
    container: "ambassador",
    ideaOrigin: "ambassador-requirement",
    check(doc, part) {
      if (!doc || doc.docType !== "program" || doc.softDeletedAt) {
        return { refusal: "No Ambassador program has that id." };
      }
      if (part) {
        const ids = (
          Array.isArray(doc.requirements) ? doc.requirements : []
        ).map((requirement) => requirement?.id);
        if (!ids.includes(part)) {
          return { refusal: `The program has no requirement "${part}".` };
        }
      }
      return { label: trimmedLabel(doc.name) || doc.id };
    },
  }),
});

/** The nav ids of the Pages above, for the frontend mirror test. */
export const ORIGIN_PAGE_IDS = Object.freeze(Object.keys(ORIGIN_PAGES));

/**
 * A request's `originRef` → the shape checked before any read: `null` when
 * the request names none, `{ page, id, part }` otherwise. Throws
 * OriginRefError for anything malformed.
 *
 * @param {unknown} input
 * @returns {{ page: string, id: string, part: string|null }|null}
 */
export function parseOriginRef(input) {
  if (input === undefined || input === null) return null;
  if (!isPlainObject(input)) fail("originRef must be an object.");
  const unknown = Object.keys(input).filter(
    (key) => !["page", "id", "part"].includes(key),
  );
  if (unknown.length) fail(`Not an originRef field: ${unknown.join(", ")}`);
  const { page, id, part } = input;
  if (typeof page !== "string" || !Object.hasOwn(ORIGIN_PAGES, page)) {
    fail(`originRef.page must be one of: ${ORIGIN_PAGE_IDS.join(", ")}`);
  }
  if (typeof id !== "string" || !REF_ID_PATTERN.test(id)) {
    fail("originRef.id must be 1-128 letters, digits, hyphens or underscores.");
  }
  if (part !== undefined && part !== null && part !== "") {
    if (typeof part !== "string" || !PART_ID_PATTERN.test(part)) {
      fail(
        "originRef.part must be 1-64 letters, digits, hyphens or underscores.",
      );
    }
    return { page, id, part };
  }
  return { page, id, part: null };
}

/**
 * A request's `originRef`, checked against the record it names. Returns the
 * value to store (`{ page, id, part, label }`), or null when the request
 * names none. Throws OriginRefError when the record is missing, deleted or
 * has no such part.
 *
 * @param {{ readDoc: Function }} store
 * @param {unknown} input
 * @returns {Promise<{ page: string, id: string, part: string|null, label: string }|null>}
 */
export async function resolveOriginRef(store, input) {
  const ref = parseOriginRef(input);
  if (!ref) return null;
  const page = ORIGIN_PAGES[ref.page];
  const doc = await store.readDoc(page.container, ref.id, ref.id);
  const verdict = page.check(doc || null, ref.part);
  if (verdict.refusal) fail(verdict.refusal);
  return { ...ref, label: verdict.label };
}

/** The ideaOrigin a draft from this reference gets when the caller names none. */
export function defaultIdeaOriginFor(ref) {
  return (ref && ORIGIN_PAGES[ref.page]?.ideaOrigin) || null;
}

/**
 * The stored `originRef` as an answer carries it, or null. Read leniently:
 * a document written before this field, or by hand, has none.
 */
export function originRefOf(doc) {
  const ref = doc?.originRef;
  if (
    !isPlainObject(ref) ||
    typeof ref.page !== "string" ||
    typeof ref.id !== "string"
  ) {
    return null;
  }
  return {
    page: ref.page,
    id: ref.id,
    part: typeof ref.part === "string" && ref.part ? ref.part : null,
    label: trimmedLabel(ref.label) || ref.id,
  };
}

/**
 * The Cosmos clause that matches content sent by one Page, and optionally
 * one record on it: `GET cms/content?originPage=&originId=` (cms-content.js).
 * Returns `{ error }` for a Page that is not in ORIGIN_PAGES or a malformed id.
 */
export function originFilterClause(originPage, originId, parameters) {
  if (!originPage) return { clause: null };
  if (!Object.hasOwn(ORIGIN_PAGES, originPage)) {
    return {
      error: `originPage must be one of: ${ORIGIN_PAGE_IDS.join(", ")}`,
    };
  }
  parameters.push({ name: "@originPage", value: originPage });
  if (!originId) return { clause: "c.originRef.page = @originPage" };
  if (!REF_ID_PATTERN.test(originId)) {
    return {
      error: "originId must be 1-128 letters, digits, hyphens or underscores",
    };
  }
  parameters.push({ name: "@originId", value: originId });
  return {
    clause: "(c.originRef.page = @originPage AND c.originRef.id = @originId)",
  };
}
