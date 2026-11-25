/**
 * developer-api/cfs-routes.js — the call-for-speakers routes of the Developer
 * API v1 (ADR 0042) that list, review or delete the proposals sent to a
 * call (a call is opened in call-routes.js, a proposal arrives through
 * proposal-intake.js). handlers.js
 * wires each one through its `route` and holds the header that says what they may write and log; every write
 * here decided from an earlier read is conditional on what was read.
 */
import {
  CFS_CONTAINER,
  REVIEW_DECISIONS,
  encodeListCursor,
  isSubmissionId,
  presentCall,
  presentSubmission,
  readListPaging,
  validateReview,
} from './cfs.js';
import { isStripped } from './proposal-cycle.js';
import {
  Answer,
  CHANGED,
  NO_PROPOSAL,
  STRIPPED,
  audit,
  eventIdOf,
  isConflict,
  json,
  notFound,
  ownedCall,
  readJson,
} from './route-kit.js';

/** How many times a delete reads the proposal again after losing a race, before it answers 409. */
const DELETE_ATTEMPTS = 2;

/** The status filter from the query, or null; an unknown one is the 400 answer. */
function statusFilterOf(request) {
  const status = request.query?.get?.('status') || null;
  if (status !== null && !REVIEW_DECISIONS.includes(status)) {
    throw new Answer(
      json(400, { ok: false, code: 'INVALID', error: `status must be one of: ${REVIEW_DECISIONS.join(', ')}.` }),
    );
  }
  return status;
}

/** One page of a call's proposals, newest first, with the status filter when there is one. */
async function readProposalPage(deps, { eventId, status, limit, continuationToken }) {
  const parameters = [{ name: '@eventId', value: eventId }];
  let where = "c.docType = 'cfs-submission' AND c.eventId = @eventId";
  if (status) {
    where += ' AND c.status = @status';
    parameters.push({ name: '@status', value: status });
  }
  try {
    return await deps.store.queryDocsPage(
      CFS_CONTAINER,
      `SELECT * FROM c WHERE ${where} ORDER BY c.submittedAt DESC`,
      parameters,
      { partitionKey: eventId, maxItemCount: limit, continuationToken: continuationToken || undefined },
    );
  } catch (error) {
    // A cursor that decodes but that the database does not recognise (an
    // old one, or one made by hand) is the caller's to correct, not a fault.
    if (continuationToken && error?.code === 400) {
      throw new Answer(
        json(400, {
          ok: false,
          code: 'INVALID',
          error: 'cursor is no longer valid. Start the list again without a cursor.',
        }),
      );
    }
    throw error;
  }
}

/**
 * GET events/{eventId}/call-for-speakers/submissions?status=&limit=&cursor= — cfs:manage.
 *
 * Newest first, one page at a time. With no `limit` the answer carries up
 * to MAX_LISTED proposals, as it always did. `nextCursor` is null on the
 * last page; otherwise send it back as `cursor` (with the same `status`)
 * for the next page. `count` is the number in THIS answer, and a page can
 * hold fewer than `limit` while `nextCursor` is still set, so the cursor,
 * not the count, says whether there is more.
 */
export async function listSubmissions(deps, request) {
  const auth = await deps.guard.requireScope(request, 'cfs:manage');
  if (auth.error) return auth.error;
  const eventId = eventIdOf(request);
  const status = statusFilterOf(request);
  const { limit, continuationToken } = readListPaging(request.query, status);
  const call = await ownedCall(deps, eventId, auth.user);
  const page = await readProposalPage(deps, { eventId, status, limit, continuationToken });
  const submissions = (page?.resources || []).map(presentSubmission);
  return json(200, {
    ok: true,
    call: presentCall(call, deps.now()),
    submissions,
    count: submissions.length,
    nextCursor: encodeListCursor({ token: page?.continuationToken, status }),
  });
}

/** The proposal id from the route; one that is not a UUID is the 400 answer. */
function submissionIdOf(request) {
  const submissionId = request.params?.submissionId;
  if (!isSubmissionId(submissionId)) {
    throw new Answer(json(400, { ok: false, code: 'INVALID', error: 'The submission id must be a UUID.' }));
  }
  return submissionId;
}

/** True when `existing` is a proposal on this event (not absent, not another kind of record). */
const isProposalOn = (existing, eventId) =>
  Boolean(existing) && existing.docType === 'cfs-submission' && existing.eventId === eventId;

/** Replace the proposal as read (its ETag is in `next`); a lost race is the 409, a delete since the 404. */
async function writeReview(deps, eventId, next) {
  try {
    return await deps.store.replaceDocIfMatch(CFS_CONTAINER, next, { partitionKey: eventId });
  } catch (error) {
    if (isConflict(error)) throw new Answer(json(409, { ok: false, code: 'CONFLICT', error: CHANGED }));
    // Deleted between the read and the write: the same answer as a proposal that was never there.
    if (error?.code === 404) throw new Answer(notFound(NO_PROPOSAL));
    throw error;
  }
}

/** PUT events/{eventId}/call-for-speakers/submissions/{submissionId} — cfs:manage. Records a decision; publishes nothing. */
export async function reviewSubmission(deps, request, context) {
  const auth = await deps.guard.requireScope(request, 'cfs:manage');
  if (auth.error) return auth.error;
  const eventId = eventIdOf(request);
  const submissionId = submissionIdOf(request);
  const review = validateReview(await readJson(request));
  await ownedCall(deps, eventId, auth.user);

  const existing = await deps.store.readDoc(CFS_CONTAINER, submissionId, eventId);
  if (!isProposalOn(existing, eventId)) return notFound(NO_PROPOSAL);
  // A stripped proposal's decision is final (#1777): its speaker details are gone, so accepting it
  // now would accept a talk nobody can be reached about, and a new note would never be removed.
  if (isStripped(existing)) return json(409, { ok: false, code: 'PROPOSAL_STRIPPED', error: STRIPPED });
  const nowIso = new Date(deps.now()).toISOString();
  const decided = review.decision !== 'pending';
  const next = {
    ...existing,
    status: review.decision,
    reviewNote: review.note,
    reviewedAt: decided ? nowIso : null,
    reviewedBy: decided ? auth.user.oid : null,
  };
  const written = await writeReview(deps, eventId, next);
  await audit(deps, context, 'developer_cfs_submission_reviewed', auth.user, {
    resource: `${CFS_CONTAINER}:${submissionId}`,
    // Status only: the proposal's text and the speaker's email stay out of the audit trail.
    before: { status: existing.status },
    after: { status: review.decision },
    details: { eventId, submissionId },
  });
  return json(200, { ok: true, submission: presentSubmission(written || next) });
}

/**
 * One delete attempt, conditional on the version that was read: 'deleted',
 * 'gone' (deleted since) or 'changed' (read again).
 */
async function deleteRead(deps, { submissionId, eventId, existing }) {
  try {
    await deps.store.deleteDocIfMatch(CFS_CONTAINER, submissionId, existing._etag, eventId);
    return 'deleted';
  } catch (error) {
    if (error?.code === 404) return 'gone';
    if (error?.code === 412) return 'changed';
    throw error;
  }
}

/**
 * DELETE events/{eventId}/call-for-speakers/submissions/{submissionId} — cfs:manage.
 *
 * Removes one proposal of this key's own call for good: the speaker's
 * name, email, bio and talk leave the database (#1777; a speaker may ask
 * for that). Another organizer's event is the same 404 as no call at all.
 * Asking twice is safe: a proposal that is already gone answers 200 with
 * `deleted: false`. The delete is conditional on the version that was
 * read; a proposal that changed in between (a review landing) is read
 * again and deleted, and only a second lost race answers 409.
 */
export async function deleteSubmission(deps, request, context) {
  const auth = await deps.guard.requireScope(request, 'cfs:manage');
  if (auth.error) return auth.error;
  const eventId = eventIdOf(request);
  const submissionId = submissionIdOf(request);
  await ownedCall(deps, eventId, auth.user);

  for (let attempt = 0; attempt < DELETE_ATTEMPTS; attempt += 1) {
    const existing = await deps.store.readDoc(CFS_CONTAINER, submissionId, eventId);
    if (!isProposalOn(existing, eventId)) return json(200, { ok: true, id: submissionId, deleted: false });
    const outcome = await deleteRead(deps, { submissionId, eventId, existing });
    if (outcome === 'gone') return json(200, { ok: true, id: submissionId, deleted: false });
    if (outcome === 'deleted') {
      await audit(deps, context, 'developer_cfs_submission_deleted', auth.user, {
        resource: `${CFS_CONTAINER}:${submissionId}`,
        // Status only, as for a review: nothing the speaker typed reaches the audit trail.
        before: { status: existing.status },
        after: null,
        details: { eventId, submissionId },
      });
      return json(200, { ok: true, id: submissionId, deleted: true });
    }
  }
  return json(409, { ok: false, code: 'CONFLICT', error: CHANGED });
}
