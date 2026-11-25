/**
 * developer-api/handlers.js — the Developer API v1 routes (ADR 0042, Phase 1).
 *
 *   GET  status                                              key (any scope)
 *   GET  published-events?from=&to=&q=&limit=                public
 *   GET  speakers?q=                                         public
 *   POST events/{eventId}/call-for-speakers                  key, cfs:manage   open or close a call
 *   POST events/{eventId}/call-for-speakers/submissions      public, rate-limited   send a proposal
 *                                                            (the call's own key may relay them, see submitProposal)
 *   GET  events/{eventId}/call-for-speakers/submissions      key, cfs:manage   list proposals
 *   PUT  events/{eventId}/call-for-speakers/submissions/{submissionId}   key, cfs:manage   accept or reject
 *   DELETE events/{eventId}/call-for-speakers/submissions/{submissionId} key, cfs:manage   delete one proposal
 *
 * No route here publishes, unpublishes or schedules anything (ADR 0042
 * decision 6): the public reads serve the snapshot a human published, and the
 * call-for-speakers writes touch only the organizer's own call and the
 * proposals sent to it.
 *
 * Every keyed write is one `admin_audit_logs` row (recordMutationAudit), with
 * the key id as the actor and never the key. Log lines carry no ids, emails
 * or bodies.
 *
 * A write decided from an earlier read is conditional on what was read
 * (createDoc for a first call, replaceDocIfMatch otherwise, deleteDocIfMatch
 * for a delete) and a lost race answers 409 rather than writing over a change
 * it did not see.
 */
import { randomUUID } from 'node:crypto';
import { assertClientIdentity } from '../auth/client-identity.js';
import { authoredMessage, errorResponse, isAuthoredError } from '../http/error-response.js';
import {
  MAX_LISTED,
  MAX_SUBMISSION_BYTES,
  SUBMISSIONS_PER_CALL_PER_HOUR,
  SUBMISSIONS_PER_CLIENT_PER_HOUR,
} from './cfs.js';
import { listPublishedEvents, listSpeakers, readEventFilters, readSearch } from './directory.js';
import { API_BASE_PATH, REQUESTS_PER_MINUTE, SCOPES, scopesOf } from './keys.js';
import { Answer, json, publicJson, readSnapshot } from './route-kit.js';
import { setCall } from './call-routes.js';
import { deleteSubmission, listSubmissions, reviewSubmission } from './cfs-routes.js';
import { submitProposal } from './proposal-intake.js';

/** What the admin and the status route show about the limits. */
export const LIMITS = Object.freeze({
  keyedRequestsPerMinute: REQUESTS_PER_MINUTE,
  submissionsPerClientPerHour: SUBMISSIONS_PER_CLIENT_PER_HOUR,
  submissionsPerCallPerHour: SUBMISSIONS_PER_CALL_PER_HOUR,
  maxSubmissionBytes: MAX_SUBMISSION_BYTES,
  maxListedProposals: MAX_LISTED,
});

/** [method, path under the base, who] — what the admin and the status route list. */
export const ENDPOINTS = Object.freeze([
  ['GET', 'status', 'key'],
  ['GET', 'published-events', 'public'],
  ['GET', 'speakers', 'public'],
  ['POST', 'events/{eventId}/call-for-speakers', 'cfs:manage'],
  ['POST', 'events/{eventId}/call-for-speakers/submissions', 'public'],
  ['GET', 'events/{eventId}/call-for-speakers/submissions', 'cfs:manage'],
  ['PUT', 'events/{eventId}/call-for-speakers/submissions/{submissionId}', 'cfs:manage'],
  ['DELETE', 'events/{eventId}/call-for-speakers/submissions/{submissionId}', 'cfs:manage'],
]);

const invalid = (error, fallback) => json(400, { ok: false, code: 'INVALID', error: authoredMessage(error, fallback) });

/** One handler: its work, with input errors as 400 and anything else as a sanitized 500. */
const route = (deps, what, work) => async (request, context) => {
  try {
    return await work(deps, request, context);
  } catch (error) {
    if (error instanceof Answer) return error.response;
    if (isAuthoredError(error)) return invalid(error, `Could not ${what}.`);
    return errorResponse(context, `Failed to ${what}`, error, 500, request);
  }
};

/** GET status — the key works: who it is, what it may do, the limits. */
async function status(deps, request) {
  const auth = await deps.guard.authenticate(request);
  if (auth.error) return auth.error;
  return json(200, {
    ok: true,
    organizer: { keyId: auth.record.keyId, name: auth.record.organizerName || null },
    scopes: scopesOf(auth.record),
    scopeCatalogue: SCOPES,
    limits: LIMITS,
    basePath: `/api/${API_BASE_PATH}`,
    endpoints: ENDPOINTS.map(([method, path, who]) => ({ method, path, who })),
  });
}

/** GET published-events — public. */
async function publishedEvents(deps, request) {
  const filters = readEventFilters(request.query);
  const snapshot = await readSnapshot(deps);
  const { events, total } = listPublishedEvents(snapshot, filters);
  return publicJson({ ok: true, events, total, publishedAt: snapshot?.publishedAt || null });
}

/** GET speakers?q= — public. */
async function speakers(deps, request) {
  const q = readSearch(request.query);
  const snapshot = await readSnapshot(deps);
  return publicJson({ ok: true, ...listSpeakers(snapshot, { q }) });
}

/**
 * @param {object} deps
 * @param {{ authenticate: Function, requireScope: Function }} deps.guard the organizer key guard
 * @param {{ readDoc: Function, createDoc: Function, replaceDocIfMatch: Function, queryDocsPage: Function,
 *   deleteDocIfMatch: Function, upsertDoc: Function, incrementIf: Function }} deps.store `upsertDoc`
 *   writes audit rows only; `incrementIf`, `createDoc`, `replaceDocIfMatch` and `readDoc` also
 *   serve the public quota; `readDoc` also reads the key record that owns a call (submitProposal)
 * @param {{ readDoc: Function }} deps.publicStore reads `_snapshots`
 * @param {{ anonymousKey: Function }} deps.identity lib/auth/client-identity.js
 * @param {() => number} [deps.now] epoch milliseconds
 * @param {() => string} [deps.uuid]
 */
export function createDeveloperApiHandlers({ guard, store, publicStore, identity, now = Date.now, uuid = randomUUID }) {
  if (!guard || !store || !publicStore) throw new Error('createDeveloperApiHandlers requires guard, store and publicStore');
  assertClientIdentity(identity, ['anonymousKey']);
  const deps = { guard, store, publicStore, identity, now, uuid };
  return {
    status: route(deps, 'read the key status', status),
    publishedEvents: route(deps, 'list published events', publishedEvents),
    speakers: route(deps, 'find speakers', speakers),
    setCall: route(deps, 'change the call for speakers', setCall),
    submitProposal: route(deps, 'send the proposal', submitProposal),
    listSubmissions: route(deps, 'list the proposals', listSubmissions),
    reviewSubmission: route(deps, 'review the proposal', reviewSubmission),
    deleteSubmission: route(deps, 'delete the proposal', deleteSubmission),
  };
}
