/**
 * content-typed-updates.js — the check a content update goes through for
 * the type of document it changes (ADR 0040, D5): an interview's fields are
 * run through the interview schema. Split out of
 * content-update-validation.js, which re-exports it.
 */
import { checkInterviewFields } from "../interviews/sibling-modules.js";
import { ContentValidationError } from "./content-field-checks.js";

/** The interview fields an editor may change through updateContentItem. */
export const INTERVIEW_UPDATE_FIELDS = Object.freeze([
  "title",
  "subtitle",
  "date",
  "guest",
  "bio",
  "image",
  "tags",
  "qa",
  "related",
]);

/**
 * The type-aware check (ADR 0040, D5): on a document of type `interview`,
 * every interview field the update names is run through the interview
 * schema (lib/interviews/schema.js, the jobs slice's) and replaced by its
 * checked form. Any other type, or an update naming none of those fields,
 * passes through untouched. The generic rules above have already run.
 *
 * @param {string} type - the stored document's `type`
 * @param {object} updates - the validated updates
 * @returns {Promise<object>} the updates, with the checked interview fields
 * @throws {ContentValidationError} with the schema's own sentence
 */
export async function validateTypedUpdates(type, updates = {}) {
  const current = String(type || "").toLowerCase();
  assertTypeKept(current, updates);
  if (current !== "interview") return updates;
  const fields = interviewFieldsOf(updates);
  if (Object.keys(fields).length === 0) return updates;
  const checked = await checkInterviewFields(fields);
  if (!checked.ok) throw new ContentValidationError(checked.error);
  return withCheckedFields(updates, fields, checked.value);
}

/**
 * A document becomes an interview through POST cms/interviews only, which
 * writes the consent record from the token; and an interview never stops
 * being one through this route, because the publish gate decides from the
 * document's type whether to demand consent (ADR 0040, D9).
 */
function assertTypeKept(current, updates) {
  for (const key of ["type", "publishTarget", "contentType"]) {
    if (!Object.hasOwn(updates, key) || updates[key] === null) continue;
    const next = String(updates[key] || "").trim().toLowerCase();
    if (next === "interview" && current !== "interview") {
      throw new ContentValidationError(
        `${key} cannot be set to interview here; an interview is created through POST cms/interviews`,
      );
    }
    if (current === "interview" && next !== "interview") {
      throw new ContentValidationError(
        `${key} cannot be changed on an interview; it stays an interview`,
      );
    }
  }
}

/** The interview fields the update names (a null is not naming one). */
function interviewFieldsOf(updates) {
  const fields = {};
  for (const key of INTERVIEW_UPDATE_FIELDS) {
    if (Object.hasOwn(updates, key) && updates[key] !== null) fields[key] = updates[key];
  }
  return fields;
}

/** The updates with each named interview field replaced by its checked form. */
function withCheckedFields(updates, fields, value) {
  const out = { ...updates };
  if (!value || typeof value !== "object") return out;
  for (const key of Object.keys(fields)) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  // The dual-cased title the legacy readers look at.
  if (out.title !== undefined) out.Title = out.title;
  return out;
}
