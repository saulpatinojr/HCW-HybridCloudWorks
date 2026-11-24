/**
 * log-json.js — print a run's summary in a log line without its ids (#1802).
 *
 * Log lines here are content-free: no document ids, tokens, file paths, route
 * values or payloads. A timer or a change-feed handler ends by printing the
 * small summary its run returned, and a summary is built far from the line
 * that prints it, so an id put into one (`{ id: doc.id, mirrored: 'skipped' }`)
 * reached the log unseen. `jsonForLog` is the one way a whole value is
 * printed: it is `JSON.stringify` that leaves out every field named like a
 * stored id, at any depth.
 *
 * It judges a field by its NAME only. A sentence under another name
 * (`reason`, `error`) is printed as it is, so a summary's sentences are
 * fixed words or `errorCode(err)` (lib/http/error-response.js), written that
 * way where the summary is built.
 *
 * `functions/src/lib/http/no-ids-in-logs.test.js` holds the rest: it fails
 * when a log line prints an id, or prints a whole value with
 * `JSON.stringify` and not with this.
 */

/**
 * A name that says "this holds the id of a stored thing": `id`, `ids`,
 * `_id`, `oid` (a signed-in person's id in the sign-in directory), `sub`,
 * `uid`, and anything that ends in `Id`, `Ids`, `ID` or `IDs` (`contentId`,
 * `jobId`, `refusedIds`). Shared with the test so the two cannot drift.
 */
export const STORED_ID_NAME = /^(?:id|ids|_id|oid|sub|uid)$|(?:Id|Ids|ID|IDs)$/;

/**
 * Names shaped like an id that are not the id of a stored thing: the two
 * reference numbers the host gives each run, which exist to be logged.
 */
export const RUN_REFERENCE_NAMES = new Set(['invocationId', 'correlationId']);

/**
 * `JSON.stringify` for a log line: every field named like a stored id is
 * left out, at any depth.
 *
 * @param {unknown} value - the summary to print
 * @param {{ keep?: string[] }} [options] - `keep` names id-shaped fields
 *   that are not stored ids (a backup run's date label, say); each use says
 *   why beside it
 * @returns {string | undefined} what `JSON.stringify` would return
 */
export function jsonForLog(value, { keep = [] } = {}) {
  const kept = new Set([...RUN_REFERENCE_NAMES, ...keep]);
  return JSON.stringify(value, (key, field) => (STORED_ID_NAME.test(key) && !kept.has(key) ? undefined : field));
}
