/**
 * origin-pages.js — the list of admin Pages that may send work into the
 * Pipeline (#1886), and how each one's reference is checked.
 *
 * Kept apart from origin-ref.js on purpose: this file imports nothing, so the
 * browser's mirror test (frontend/src/lib/pageLinks.test.js) can read the list
 * without loading the database client or the agent key code, which the
 * frontend's own CI job does not install. Add a Page here, then follow the
 * checklist in .claude/CLAUDE.md, "How the admin Pages connect".
 */

/** Labels are trimmed and capped at this length. */
export const MAX_LABEL_CHARS = 200;

export const trimmedLabel = (value) =>
  String(value || "")
    .trim()
    .slice(0, MAX_LABEL_CHARS);

/**
 * Whether a stored record counts as deleted. Speaking and Certifications
 * delete a record outright today, so a missing record is the usual case;
 * a `softDeletedAt` stamp (from a restore or a hand edit) is refused the
 * same way, as the Pipeline and Ambassador treat it.
 */
const isDeleted = (doc) => ![undefined, null, "", false].includes(doc?.softDeletedAt);

/**
 * A check for a Page whose records have a name and no parts: refuses a
 * missing or deleted record and any `part`, and labels the reference with
 * the first non-empty name field.
 */
function namedRecordCheck({ missing, noParts, nameFields }) {
  return (doc, part) => {
    if (!doc || isDeleted(doc)) return { refusal: missing };
    if (part) return { refusal: noParts };
    const name = nameFields.map((field) => trimmedLabel(doc[field])).find(Boolean);
    return { label: name || doc.id };
  };
}

/**
 * The Pages that may send work into the Pipeline, by nav id.
 *
 *   container    the Cosmos container the record lives in (partition key /id)
 *   agentSection the switch on the agent key that lets it read this Page
 *                (agent-content/keys.js CAPABILITIES). A reference names a record
 *                and returns its name, so the agent key may send one only when it could
 *                read the Page anyway (review of #1886).
 *   ideaOrigin   the taxonomy id a draft from this Page gets when the caller names
 *                none (functions/src/lib/cms/taxonomy.js DEFAULT_IDEA_ORIGINS)
 *   check(doc, part)  the record's label, or a sentence saying why the reference
 *                is refused. `doc` is null when no record has the id.
 */
export const ORIGIN_PAGES = Object.freeze({
  ambassador: Object.freeze({
    container: "ambassador",
    agentSection: "admin.spotlight",
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
  // A talk (a stored speaking event, from Sessionize or entered by hand):
  // its recap or write-up. The names are the ones the Speaking Page shows
  // and the evidence import reads (ambassador/import-readers.js).
  speaking: Object.freeze({
    container: "speakerevents",
    agentSection: "admin.spotlight",
    ideaOrigin: "speaker-engagement",
    check: namedRecordCheck({
      missing: "No stored talk has that id.",
      noParts: "A talk has no parts to name.",
      nameFields: ["eventName", "name", "title"],
    }),
  }),
  // A certification: study notes, or what was learned for it. `name` is the
  // one field the Certifications Page requires (admin-crud/certification-rules.js).
  certifications: Object.freeze({
    container: "certifications",
    agentSection: "admin.spotlight",
    ideaOrigin: "certification-objective",
    check: namedRecordCheck({
      missing: "No certification has that id.",
      noParts: "A certification has no parts to name.",
      nameFields: ["name"],
    }),
  }),
});

/** The nav ids of the Pages above, for the frontend mirror test. */
export const ORIGIN_PAGE_IDS = Object.freeze(Object.keys(ORIGIN_PAGES));
