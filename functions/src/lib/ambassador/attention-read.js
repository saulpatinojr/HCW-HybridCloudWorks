/**
 * The reads behind ambassadorAttention (attention.js): the programs, the
 * applications whose dates still matter, and this year's evidence. Bounded
 * and projected; deleted rows are left out by the query and again by the
 * pure step, so either alone is enough.
 *
 * A missing `ambassador` container (not provisioned yet) reads as empty, the
 * way every Dashboard source treats it, and is reported as `missing`: the
 * Telegram sync must not read "nothing to remind" from a list it could not
 * read, or it would remove every Ambassador row (review of #1894).
 */
import { CONTAINER } from "./model.js";
import { OPEN_APPLICATION_STATUSES, ambassadorAttention } from "./attention.js";
import { isContainerMissing } from "../calendar/collectors.js";

/**
 * Rows read per kind, newest change first. The lists hold tens of rows today;
 * the cap keeps a bad day bounded, and `truncated` says when it was reached.
 */
export const ATTENTION_READ_LIMIT = 500;

const NOT_DELETED =
  "(NOT IS_DEFINED(c.softDeletedAt) OR IS_NULL(c.softDeletedAt))";

/** A sentinel for "the container is not there", kept apart from an empty list. */
const MISSING = Symbol("missing");

async function rows(store, query, parameters) {
  try {
    return (await store.queryDocs(CONTAINER, query, parameters)) || [];
  } catch (error) {
    if (isContainerMissing(error)) return MISSING;
    throw error;
  }
}

/**
 * @param {{ queryDocs: Function }} store
 * @param {string} today YYYY-MM-DD (UTC)
 * @returns {Promise<{ items: ReturnType<typeof ambassadorAttention>, truncated: boolean, missing: boolean }>}
 */
export async function readAmbassadorAttention(store, today) {
  const limit = ATTENTION_READ_LIMIT;
  const read = await Promise.all([
    rows(
      store,
      `SELECT TOP ${limit} c.id, c.name, c.enabled, c.membershipStatus, c.upkeep, c.reminders, c.softDeletedAt FROM c WHERE c.docType = 'program' AND ${NOT_DELETED} ORDER BY c._ts DESC`,
      [],
    ),
    rows(
      store,
      `SELECT TOP ${limit} c.id, c.programId, c.title, c.status, c.submissionDeadline, c.renewalDate, c.expirationDate, c.softDeletedAt FROM c WHERE c.docType = 'application' AND ARRAY_CONTAINS(@open, c.status) AND ${NOT_DELETED} ORDER BY c._ts DESC`,
      [{ name: "@open", value: OPEN_APPLICATION_STATUSES }],
    ),
    // Upkeep counts the current quarter or year; both start on or after 1 January.
    rows(
      store,
      `SELECT TOP 2000 c.id, c.date, c.programIds, c.sourceModule, c.softDeletedAt FROM c WHERE c.docType = 'evidence' AND c.date >= @since AND ${NOT_DELETED} ORDER BY c._ts DESC`,
      [{ name: "@since", value: `${today.slice(0, 4)}-01-01` }],
    ),
  ]);
  const missing = read.includes(MISSING);
  const [programs, applications, evidence] = read.map((list) =>
    list === MISSING ? [] : list,
  );
  return {
    missing,
    items: ambassadorAttention({ programs, applications, evidence, today }),
    truncated:
      programs.length >= limit ||
      applications.length >= limit ||
      evidence.length >= 2000,
  };
}
