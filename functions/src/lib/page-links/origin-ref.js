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
 * ADDING A PAGE. One entry in ORIGIN_PAGES (origin-pages.js), plus its link builder in
 * frontend/src/lib/pageLinks.js (pageLinks.test.js fails until both agree).
 * The checklist is in .claude/CLAUDE.md, "How the admin Pages connect".
 */
import { AuthoredError } from "../http/error-response.js";
import { ORIGIN_PAGES, ORIGIN_PAGE_IDS, trimmedLabel } from "./origin-pages.js";
import { ADMIN_CONFIG_PARTITION } from "../cosmos-client.js";
import {
  AGENT_ID,
  KEY_RECORD_ID,
  enabledCapabilities,
} from "../agent-content/keys.js";

/** Record ids on the Pages below: uuids with a prefix, or fixed seed ids. */
const REF_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const PART_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Input the caller can correct; the Drafts handlers answer it as 400 INVALID. */
export class OriginRefError extends AuthoredError {}

const fail = (message) => {
  throw new OriginRefError(message);
};

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

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

/** Refused because the caller may not read the Page the reference names; answered 403. */
export class OriginRefForbiddenError extends AuthoredError {}

/**
 * Whether the agent key has the switch that lets it read this Page. A person
 * (any caller that is not the agent) is not asked: the route's own role
 * check already covers them, and the Pages on the list need no more than
 * the editor role that Drafts needs.
 */
async function agentMayRead(store, user, page) {
  if (user?.agent !== AGENT_ID) return true;
  const record = await store.readDoc(
    "admin_config",
    KEY_RECORD_ID,
    ADMIN_CONFIG_PARTITION,
  );
  return enabledCapabilities(record || {}).includes(page.agentSection);
}

/**
 * The Pages whose references this caller may not see: none for a person,
 * and for the agent key every Page whose switch is off on it (review of #1890).
 * A reference carries a record's name, so it is shown only to a caller that
 * could read that Page anyway. Read once per request.
 *
 * @returns {Promise<string[]>} nav ids
 */
export async function hiddenOriginPages(store, user) {
  if (user?.agent !== AGENT_ID) return [];
  const record = await store.readDoc(
    "admin_config",
    KEY_RECORD_ID,
    ADMIN_CONFIG_PARTITION,
  );
  const on = enabledCapabilities(record || {});
  return ORIGIN_PAGE_IDS.filter(
    (id) => !on.includes(ORIGIN_PAGES[id].agentSection),
  );
}

/**
 * `value` with every `originRef` that names a hidden Page removed, however
 * deep it sits (a list, a snapshot, one draft). The same value when nothing
 * is hidden. Plain JSON data only, as every answer here is.
 */
export function withoutHiddenOrigins(value, hidden) {
  if (!hidden.length || value === null || typeof value !== "object")
    return value;
  if (Array.isArray(value))
    return value.map((entry) => withoutHiddenOrigins(entry, hidden));
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "originRef" && hidden.includes(entry?.page)) continue;
    out[key] = withoutHiddenOrigins(entry, hidden);
  }
  return out;
}

/**
 * A route answer (`{ status, headers, body }` with a JSON body) with the
 * caller's hidden references removed. Any other answer is returned as it is.
 */
export async function answerWithoutHiddenOrigins(store, user, response) {
  const hidden = await hiddenOriginPages(store, user);
  if (!hidden.length || typeof response?.body !== "string") return response;
  let body;
  try {
    body = JSON.parse(response.body);
  } catch {
    return response;
  }
  return {
    ...response,
    body: JSON.stringify(withoutHiddenOrigins(body, hidden)),
  };
}

/**
 * Whether this caller may filter a list by a Page: false for the agent key when that
 * Page's switch is off, so the filter cannot be used to find which pieces a
 * hidden Page sent.
 */
export async function mayFilterByOrigin(store, user, originPage) {
  if (!originPage) return true;
  return !(await hiddenOriginPages(store, user)).includes(originPage);
}

/**
 * A request's `originRef`, checked against the record it names. Returns the
 * value to store (`{ page, id, part, label }`), or null when the request
 * names none. Throws OriginRefError when the record is missing, deleted or
 * has no such part, and OriginRefForbiddenError when the caller is the agent key and
 * its key's switch for that Page is off (checked before the record is read,
 * so the answer says nothing about the record).
 *
 * @param {{ readDoc: Function }} store
 * @param {unknown} input
 * @param {{ user?: { agent?: string } }} [caller]
 * @returns {Promise<{ page: string, id: string, part: string|null, label: string }|null>}
 */
export async function resolveOriginRef(store, input, { user = null } = {}) {
  const ref = parseOriginRef(input);
  if (!ref) return null;
  const page = ORIGIN_PAGES[ref.page];
  if (!(await agentMayRead(store, user, page))) {
    throw new OriginRefForbiddenError(
      "This key may not send work for this Page: its switch for that section is off.",
    );
  }
  const doc = await store.readDoc(page.container, ref.id, ref.id);
  const verdict = page.check(doc || null, ref.part);
  if (verdict.refusal) fail(verdict.refusal);
  return { ...ref, label: verdict.label };
}

/**
 * The status a route answers a refused reference with: 403 when the caller
 * may not send one for that Page, 400 when the caller can correct it, 0 for
 * any other error (which the route lets through to its own failure path).
 */
export function originRefRefusalStatus(error) {
  if (error instanceof OriginRefForbiddenError) return 403;
  return error instanceof OriginRefError ? 400 : 0;
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
/** Why a list filter is refused, or null when it is usable. */
function originFilterRefusal(originPage, originId) {
  // An id with no Page would otherwise answer the whole unfiltered list,
  // which a caller could take for "the pieces for this record".
  if (!originPage) return originId ? "originId needs originPage" : null;
  if (!Object.hasOwn(ORIGIN_PAGES, originPage)) {
    return `originPage must be one of: ${ORIGIN_PAGE_IDS.join(", ")}`;
  }
  if (originId && !REF_ID_PATTERN.test(originId)) {
    return "originId must be 1-128 letters, digits, hyphens or underscores";
  }
  return null;
}

export function originFilterClause(originPage, originId, parameters) {
  const error = originFilterRefusal(originPage, originId);
  if (error) return { error };
  if (!originPage) return { clause: null };
  parameters.push({ name: "@originPage", value: originPage });
  if (originId) parameters.push({ name: "@originId", value: originId });
  return {
    clause: originId
      ? "(c.originRef.page = @originPage AND c.originRef.id = @originId)"
      : "c.originRef.page = @originPage",
  };
}

export { ORIGIN_PAGES, ORIGIN_PAGE_IDS };
