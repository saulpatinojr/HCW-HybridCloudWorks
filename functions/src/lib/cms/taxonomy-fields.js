/**
 * `kind` and `ideaOrigin` on a content record (ADR 0033 §4): accepted on
 * create and on update, checked against the stored taxonomy, never trusted
 * as free text.
 *
 * The rule has one asymmetry, on purpose. An entry an administrator has
 * DISABLED is still a real classification — records carry it from before it
 * was switched off — so a record that already holds a disabled id keeps it
 * through an edit. A NEW record, or a record being moved onto a disabled id,
 * is refused with the enabled ids named, because the pickers no longer offer
 * that id and a write landing on it could only have come from a stale tab or
 * a client bug.
 *
 * The taxonomy itself (lists, defaults, derivation from `type` and `source`)
 * is ./taxonomy.js; this module only knows how to check two fields against
 * it. The list filters in cms-content.js use the inverse of that derivation
 * (`derivedKindSources`, `derivedOriginSources`) so a record that predates
 * the taxonomy still matches the kind or origin it is shown under.
 */
import { AuthoredError } from "../http/error-response.js";
import {
  resolveContentTaxonomy,
  resolveIdeaOrigin,
  resolveKind,
} from "./taxonomy.js";

export const TAXONOMY_FIELDS = Object.freeze(["kind", "ideaOrigin"]);

/** The `type` values the pipeline writes; each derives to one kind when none is stored. */
const KNOWN_TYPES = Object.freeze([
  "blog",
  "news",
  "framework",
  "architecture",
  "coder_corner",
]);
/** The `source` values the pipeline writes; each derives to one idea origin. */
const KNOWN_SOURCES = Object.freeze([
  "rss",
  "firecrawl",
  "manual_url",
  "forge-url",
  "recording",
  "drafts",
  "repo",
  "template-form",
]);

/**
 * A kind or idea-origin the saved taxonomy refuses. Every message is written
 * here from the field, the id sent and the allowed ids, so a handler may show
 * it (#945).
 */
export class TaxonomyFieldError extends AuthoredError {
  /** @param {string} message - the refusal, naming the field and the allowed ids */
  constructor(message) {
    super(message);
    this.status = 400;
    this.code = "TAXONOMY";
  }
}

const listFor = (taxonomy, field) =>
  field === "kind" ? taxonomy?.kinds || [] : taxonomy?.ideaOrigins || [];

function normalizeId(value, field) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string")
    throw new TaxonomyFieldError(`${field} must be a string id`);
  return value.trim().toLowerCase();
}

/**
 * Check the two fields in `data` against `taxonomy`.
 *
 * @param {object} data            the incoming fields (only kind / ideaOrigin are read)
 * @param {{kinds: object[], ideaOrigins: object[]}} taxonomy  resolveContentTaxonomy's answer
 * @param {{ existing?: object|null }} [options]  the stored record on an update, so a
 *   disabled id it already carries is accepted
 * @returns {{ kind?: string|null, ideaOrigin?: string|null }} only the fields present in
 *   `data`; `null` clears a field (the record falls back to derivation)
 * @throws {TaxonomyFieldError} 400, naming the allowed ids
 */
export function validateTaxonomyFields(
  data = {},
  taxonomy,
  { existing = null } = {},
) {
  const out = {};
  for (const field of TAXONOMY_FIELDS) {
    const id = Object.hasOwn(data, field)
      ? normalizeId(data[field], field)
      : undefined;
    if (id === undefined) continue;
    out[field] = id === null ? null : checkedId(field, id, taxonomy, existing);
  }
  return out;
}

const FIELD_NOUN = Object.freeze({ kind: "kind", ideaOrigin: "idea origin" });

/**
 * `id` as the taxonomy knows it: a listed entry that is enabled, or one the
 * record already carries (`existing`) even though it has since been
 * disabled. Anything else is refused naming the enabled ids.
 */
function checkedId(field, id, taxonomy, existing) {
  const list = listFor(taxonomy, field);
  const entry = list.find((item) => item.id === id);
  const allowed = () =>
    list
      .filter((item) => item.enabled !== false)
      .map((item) => item.id)
      .join(", ");
  if (!entry) {
    throw new TaxonomyFieldError(
      `${field} "${id}" is not a known ${FIELD_NOUN[field]}; allowed: ${allowed()}`,
    );
  }
  const keepsDisabled = existing && String(existing[field] || "") === id;
  if (entry.enabled === false && !keepsDisabled) {
    throw new TaxonomyFieldError(
      `${field} "${id}" is disabled; allowed: ${allowed()}`,
    );
  }
  return id;
}

/** True when `data` names either field, so a caller can skip the taxonomy read otherwise. */
export function hasTaxonomyFields(data = {}) {
  return TAXONOMY_FIELDS.some(
    (field) => Object.hasOwn(data, field) && data[field] !== undefined,
  );
}

/**
 * Validate against the stored taxonomy, reading it only when needed.
 * `store.readDoc` is the Cosmos client's; a missing or unreadable document
 * means the defaults (resolveContentTaxonomy).
 */
export async function validateTaxonomyFieldsWithStore(store, data, options) {
  if (!hasTaxonomyFields(data)) return {};
  const taxonomy = await resolveContentTaxonomy(store);
  return validateTaxonomyFields(data, taxonomy, options);
}

/** The `type` values whose derived kind is `kind` (records with no stored kind). */
export function derivedKindTypes(kind) {
  return KNOWN_TYPES.filter((type) => resolveKind({ type }) === kind);
}

/**
 * The `source` values whose derived idea origin is `ideaOrigin`, plus
 * whether a record with an unknown or absent source derives to it (only
 * `manual` does).
 */
export function derivedOriginSources(ideaOrigin) {
  return {
    sources: KNOWN_SOURCES.filter(
      (source) => resolveIdeaOrigin({ source }) === ideaOrigin,
    ),
    includesUnknownSource: resolveIdeaOrigin({}) === ideaOrigin,
    knownSources: KNOWN_SOURCES,
  };
}
