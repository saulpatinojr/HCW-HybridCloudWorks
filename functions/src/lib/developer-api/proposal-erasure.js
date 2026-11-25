/**
 * developer-api/proposal-erasure.js — the two admin routes the owner answers
 * a speaker's erasure request with (#1777; a talk proposal holds the
 * speaker's name, email and bio), and the keys list's line about the yearly
 * proposal clean-up. admin-handlers.js's header explains what each route
 * may say and what its audit row carries; the routes are wired there.
 */
import { DeveloperApiInputError } from './keys.js';
import { CFS_CONTAINER, isSubmissionId, normalizeSpeakerEmail } from './cfs.js';
import { AUDIT_ACTION as PROPOSAL_CLEANUP_ACTION } from '../timers/proposal-strip.js';
import { WRITE_ATTEMPTS, audit, json } from './admin-shared.js';

/** The most proposals one erasure search answers. One speaker has a handful; past this the answer says so. */
export const MAX_PROPOSALS_FOUND = 200;

const NO_EVENT_ID =
  'This proposal record is malformed: it has no event id, so it cannot be deleted from here. Remove it by hand in the database (the developer_events container).';

/** The newest of the rows, by timestamp; null for none. */
const newestRow = (rows) =>
  (rows || []).reduce((best, row) => (!best || String(row.timestamp) > String(best.timestamp) ? row : best), null);

/** The clean-up run's audit row as the keys list shows it. */
function presentCleanupRun(newest) {
  const details = newest.details && typeof newest.details === 'object' ? newest.details : {};
  const count = (name) => (Number.isFinite(details[name]) ? details[name] : 0);
  return {
    ranAt: newest.timestamp || null,
    dryRun: details.dryRun !== false,
    cycleYear: Number.isInteger(details.cycleYear) ? details.cycleYear : null,
    eligibleCount: count('eligibleCount'),
    strippedCount: count('strippedCount'),
    leftCount: count('racedCount') + count('failedCount'),
    hasMore: details.hasMore === true,
  };
}

/**
 * What the newest run of the yearly proposal clean-up did (#1777,
 * ../timers/proposal-strip.js), read from its audit row: when it ran,
 * whether it was a dry run, and its counts. Null when it has never run or
 * the row cannot be read; the keys list never fails because of it.
 */
export async function lastProposalCleanup(deps) {
  const { log } = deps;
  try {
    const rows = await deps.store.queryDocs(
      'admin_audit_logs',
      `SELECT TOP 1 c.timestamp, c.details FROM c WHERE c.action = '${PROPOSAL_CLEANUP_ACTION}' ORDER BY c.timestamp DESC`,
      [],
    );
    const newest = newestRow(rows);
    return newest ? presentCleanupRun(newest) : null;
  } catch {
    log.warn?.('[developer-api] the last proposal clean-up run could not be read');
    return null;
  }
}

/**
 * POST cms/developer-api/proposal-search — { speakerEmail }. Where one
 * address has proposals, across every organizer's calls: the first step
 * of an erasure request. Ids, event ids, statuses and dates only.
 *
 * Each search that runs writes one audit row, so there is a record of who
 * looked a person up. A search refused before it runs (no role, a bad
 * address) writes none, like every other refused admin call here. If the
 * row cannot be written the search still answers: `audit` logs a line
 * with no details and carries on, as it does for every other row.
 */
export async function findProposals(deps, { request, user }) {
  const input = await request.json().catch(() => null);
  const speakerEmail = normalizeSpeakerEmail(input?.speakerEmail);
  // One more than the cap, so an answer that was cut short can say so.
  const rows = await deps.store.queryDocs(
    CFS_CONTAINER,
    `SELECT TOP ${MAX_PROPOSALS_FOUND + 1} c.id, c.eventId, c.status, c.submittedAt FROM c WHERE c.docType = 'cfs-submission' AND c.speakerEmail = @speakerEmail`,
    [{ name: '@speakerEmail', value: speakerEmail }],
  );
  const found = (rows || []).slice(0, MAX_PROPOSALS_FOUND).map((row) => ({
    id: row.id,
    eventId: row.eventId || null,
    status: row.status || null,
    submittedAt: row.submittedAt || null,
  }));
  const truncated = (rows || []).length > MAX_PROPOSALS_FOUND;
  await audit(deps, 'developer_cfs_proposal_search', {
    user,
    request,
    resourceType: 'developer_cfs_submission',
    // A search is about no single record, and the address is the one thing that must not be here.
    resourceId: null,
    // Two numbers-and-flags only: not the address, a part of it or a hash of it (a hash of an
    // address can be guessed back), and not the ids, which would point at the person's proposals.
    details: { count: found.length, truncated },
  });
  return json(200, { ok: true, proposals: found, count: found.length, truncated });
}

/** The proposal with this id, across events, with its version; undefined when there is none. */
async function findProposal(store, submissionId) {
  const rows = await store.queryDocs(
    CFS_CONTAINER,
    "SELECT TOP 1 c.id, c.eventId, c.status, c._etag FROM c WHERE c.docType = 'cfs-submission' AND c.id = @id",
    [{ name: '@id', value: submissionId }],
  );
  return (rows || [])[0];
}

/**
 * One delete attempt, conditional on the version that was found: 'deleted',
 * 'gone' (deleted since, or never there) or 'changed' (try again).
 */
async function deleteFound(store, submissionId, found) {
  try {
    await store.deleteDocIfMatch(CFS_CONTAINER, submissionId, found._etag, found.eventId);
    return 'deleted';
  } catch (error) {
    if (error?.code === 404) return 'gone';
    if (error?.code === 412) return 'changed';
    throw error;
  }
}

/**
 * DELETE cms/developer-api/proposals/{submissionId} — delete one proposal
 * for an erasure request, on any organizer's call. The id is found across
 * events, then the delete is conditional on the version that was found.
 * Asking twice is safe: an id that is not there answers 200 with
 * `deleted: false`.
 */
export async function eraseProposal(deps, { request, user }) {
  const submissionId = request.params?.submissionId;
  if (!isSubmissionId(submissionId)) {
    throw new DeveloperApiInputError('The proposal id must be a UUID.');
  }
  const notThere = json(200, { ok: true, id: submissionId, deleted: false });
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const found = await findProposal(deps.store, submissionId);
    if (!found) return notThere;
    // A proposal is stored under its event's id, and the delete needs it to find the record. Every
    // proposal the API writes has one, so a row without it was edited by hand.
    if (typeof found.eventId !== 'string' || !found.eventId) {
      return json(409, { ok: false, code: 'MALFORMED_RECORD', error: NO_EVENT_ID });
    }
    const outcome = await deleteFound(deps.store, submissionId, found);
    if (outcome === 'gone') return notThere;
    if (outcome === 'deleted') return erased(deps, { request, user }, submissionId, found);
  }
  return json(409, {
    ok: false,
    code: 'CONFLICT',
    error: 'The proposal changed while it was being deleted. Try again.',
  });
}

/** The audit row and the answer for a proposal that was deleted. */
async function erased(deps, { request, user }, submissionId, found) {
  await audit(deps, 'developer_cfs_submission_erased', {
    user,
    request,
    resourceType: 'developer_cfs_submission',
    resourceId: submissionId,
    // The event and the status only: nothing the speaker typed, and not the address.
    details: { eventId: found.eventId || null, status: found.status || null },
  });
  return json(200, { ok: true, id: submissionId, eventId: found.eventId || null, deleted: true });
}
