/**
 * developer-api/handlers.js — the Developer API v1 routes (ADR 0042, Phase 1).
 *
 *   GET  status                                              key (any scope)
 *   GET  published-events?from=&to=&q=&limit=                public
 *   GET  speakers?q=                                         public
 *   POST events/{eventId}/call-for-speakers                  key, cfs:manage   open or close a call
 *   POST events/{eventId}/call-for-speakers/submissions      public, rate-limited   send a proposal
 *   GET  events/{eventId}/call-for-speakers/submissions      key, cfs:manage   list proposals
 *   PUT  events/{eventId}/call-for-speakers/submissions/{submissionId}   key, cfs:manage   accept or reject
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
 * (createDoc for a first call, replaceDocIfMatch otherwise) and a lost race
 * answers 409 rather than writing over a change it did not see.
 */
import { randomUUID } from 'node:crypto';
import { recordMutationAudit } from '../audit.js';
import { ORIGIN_NOT_VERIFIED, assertClientIdentity } from '../auth/client-identity.js';
import { authoredMessage, errorResponse, isAuthoredError } from '../http/error-response.js';
import { enforceSubmissionQuota } from '../submissions.js';
import {
  CFS_CONTAINER,
  MAX_LISTED,
  MAX_SUBMISSION_BYTES,
  REVIEW_DECISIONS,
  SUBMISSIONS_PER_CALL_PER_HOUR,
  SUBMISSIONS_PER_CLIENT_PER_HOUR,
  callDocId,
  callQuotaKey,
  clientQuotaKey,
  composeCall,
  composeSubmission,
  isCallOpen,
  isEventId,
  isSubmissionId,
  ownsCall,
  presentCall,
  presentSubmission,
  validateCallChange,
  validateReview,
  validateSubmission,
} from './cfs.js';
import { listPublishedEvents, listSpeakers, readEventFilters, readSearch } from './directory.js';
import { API_BASE_PATH, REQUESTS_PER_MINUTE, SCOPES, scopesOf } from './keys.js';

/** What the admin and the status route show about the limits. */
export const LIMITS = Object.freeze({
  keyedRequestsPerMinute: REQUESTS_PER_MINUTE,
  submissionsPerClientPerHour: SUBMISSIONS_PER_CLIENT_PER_HOUR,
  submissionsPerCallPerHour: SUBMISSIONS_PER_CALL_PER_HOUR,
  maxSubmissionBytes: MAX_SUBMISSION_BYTES,
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
]);

const PUBLIC_CACHE_SECONDS = 300;

const json = (status, body, headers = {}) => ({
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  body: JSON.stringify(body),
});
const publicJson = (body) => json(200, body, { 'Cache-Control': `public, max-age=${PUBLIC_CACHE_SECONDS}` });
const invalid = (error, fallback) => json(400, { ok: false, code: 'INVALID', error: authoredMessage(error, fallback) });
const notFound = (error) => json(404, { ok: false, code: 'NOT_FOUND', error });
const NO_CALL = 'There is no call for speakers on this event for this key.';
const NOT_OPEN = 'This event has no open call for speakers.';
const CHANGED = 'The record changed while this request was being made. Read it again and retry.';

/** Thrown inside a handler to answer with a ready response. */
class Answer extends Error {
  constructor(response) {
    super('answered');
    this.response = response;
  }
}

const isConflict = (error) => error?.code === 409 || error?.code === 412;

/**
 * @param {object} deps
 * @param {{ authenticate: Function, requireScope: Function }} deps.guard the organizer key guard
 * @param {{ readDoc: Function, createDoc: Function, replaceDocIfMatch: Function, queryDocs: Function,
 *   upsertDoc: Function, incrementIf: Function }} deps.store `upsertDoc` writes audit rows only;
 *   `incrementIf`, `createDoc`, `replaceDocIfMatch` and `readDoc` also serve the public quota
 * @param {{ readDoc: Function }} deps.publicStore reads `_snapshots`
 * @param {{ anonymousKey: Function }} deps.identity lib/auth/client-identity.js
 * @param {() => number} [deps.now] epoch milliseconds
 * @param {() => string} [deps.uuid]
 */
export function createDeveloperApiHandlers({ guard, store, publicStore, identity, now = Date.now, uuid = randomUUID }) {
  if (!guard || !store || !publicStore) throw new Error('createDeveloperApiHandlers requires guard, store and publicStore');
  assertClientIdentity(identity, ['anonymousKey']);

  const readSnapshot = () => publicStore.readDoc('_snapshots', 'speakerevents', 'speakerevents');
  const readCall = (eventId) => store.readDoc(CFS_CONTAINER, callDocId(eventId), eventId);

  const audit = (context, action, user, { resource, before = null, after = null, details = {} }) =>
    recordMutationAudit(store, {
      action,
      actor: user,
      resource,
      before,
      after,
      details: { ...details, developerKeyId: user.developerKeyId },
      now: () => new Date(now()),
      uuid,
      context,
    });

  /** One handler: its work, with input errors as 400 and anything else as a sanitized 500. */
  const route = (what, work) => async (request, context) => {
    try {
      return await work(request, context);
    } catch (error) {
      if (error instanceof Answer) return error.response;
      if (isAuthoredError(error)) return invalid(error, `Could not ${what}.`);
      return errorResponse(context, `Failed to ${what}`, error, 500, request);
    }
  };

  const eventIdOf = (request) => {
    const eventId = request.params?.eventId;
    if (!isEventId(eventId)) {
      throw new Answer(
        json(400, {
          ok: false,
          code: 'INVALID',
          error: 'The event id must be 3 to 80 lower-case letters, digits or hyphens.',
        }),
      );
    }
    return eventId;
  };

  /** The call this key owns on this event, or a 404 answer (the same one whether absent or another's). */
  const ownedCall = async (eventId, user) => {
    const call = await readCall(eventId);
    if (!ownsCall(call, user)) throw new Answer(notFound(NO_CALL));
    return call;
  };

  const readJson = async (request) => {
    try {
      return await request.json();
    } catch {
      throw new Answer(json(400, { ok: false, code: 'INVALID', error: 'The body must be valid JSON.' }));
    }
  };

  return {
    /** GET status — the key works: who it is, what it may do, the limits. */
    status: route('read the key status', async (request) => {
      const auth = await guard.authenticate(request);
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
    }),

    /** GET published-events — public. */
    publishedEvents: route('list published events', async (request) => {
      const filters = readEventFilters(request.query);
      const snapshot = await readSnapshot();
      const { events, total } = listPublishedEvents(snapshot, filters);
      return publicJson({ ok: true, events, total, publishedAt: snapshot?.publishedAt || null });
    }),

    /** GET speakers?q= — public. */
    speakers: route('find speakers', async (request) => {
      const q = readSearch(request.query);
      const snapshot = await readSnapshot();
      return publicJson({ ok: true, ...listSpeakers(snapshot, { q }) });
    }),

    /** POST events/{eventId}/call-for-speakers — cfs:manage. Opens or closes this key's call. */
    setCall: route('change the call for speakers', async (request, context) => {
      const auth = await guard.requireScope(request, 'cfs:manage');
      if (auth.error) return auth.error;
      const eventId = eventIdOf(request);
      const change = validateCallChange(await readJson(request), now());
      const existing = await readCall(eventId);
      if (existing && !ownsCall(existing, auth.user)) return notFound(NO_CALL);
      if (!existing && change.action === 'close') return notFound(NO_CALL);
      // The site's own published events are not an organizer's to claim: a
      // call on one would collect speakers' details under the owner's event.
      if (!existing) {
        const snapshot = await readSnapshot();
        const reserved = Array.isArray(snapshot?.items) && snapshot.items.some((item) => String(item?.id) === eventId);
        if (reserved) {
          return json(409, {
            ok: false,
            code: 'EVENT_ID_RESERVED',
            error: 'That event id belongs to one of the site\'s own events. Choose another id for your event.',
          });
        }
      }

      const nowIso = new Date(now()).toISOString();
      const next = composeCall({ eventId, existing, change, user: auth.user, nowIso });
      let written;
      try {
        written = existing
          ? await store.replaceDocIfMatch(CFS_CONTAINER, { ...next, _etag: existing._etag }, { partitionKey: eventId })
          : await store.createDoc(CFS_CONTAINER, next);
      } catch (error) {
        if (isConflict(error)) return json(409, { ok: false, code: 'CONFLICT', error: CHANGED });
        throw error;
      }
      const call = written || next;
      await audit(context, change.action === 'open' ? 'developer_cfs_opened' : 'developer_cfs_closed', auth.user, {
        resource: `${CFS_CONTAINER}:${callDocId(eventId)}`,
        before: existing ? presentCall(existing, now()) : null,
        after: presentCall(call, now()),
        details: { eventId },
      });
      return json(existing ? 200 : 201, { ok: true, call: presentCall(call, now()) });
    }),

    /**
     * POST events/{eventId}/call-for-speakers/submissions — public.
     * Origin verified (Cloudflare), body capped, then two limits: per caller
     * and per call, both hourly, through the same counter as public/submissions.
     */
    submitProposal: route('send the proposal', async (request, context) => {
      let clientHash;
      try {
        clientHash = identity.anonymousKey(request).key;
      } catch (error) {
        if (error?.code !== ORIGIN_NOT_VERIFIED) throw error;
        context.warn?.('[developer-api] proposal refused: unverified origin');
        return json(403, { ok: false, code: 'FORBIDDEN', error: 'Forbidden' });
      }
      const eventId = eventIdOf(request);

      const raw = typeof request.text === 'function' ? await request.text() : '';
      if (Buffer.byteLength(raw || '', 'utf8') > MAX_SUBMISSION_BYTES) {
        return json(413, {
          ok: false,
          code: 'TOO_LARGE',
          error: `The proposal is too large: at most ${MAX_SUBMISSION_BYTES} bytes.`,
        });
      }
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(400, { ok: false, code: 'INVALID', error: 'The body must be valid JSON.' });
      }
      const value = validateSubmission(body);

      const nowMs = now();
      const limited = () =>
        json(429, { ok: false, code: 'RATE_LIMITED', error: 'Too many proposals. Try again later.' }, { 'Retry-After': '3600' });
      try {
        await enforceSubmissionQuota(store, clientQuotaKey(clientHash), {
          now: nowMs,
          limit: SUBMISSIONS_PER_CLIENT_PER_HOUR,
        });
      } catch (error) {
        if (error?.code === 'SUBMISSION_RATE_LIMIT') return limited();
        throw error;
      }

      const call = await readCall(eventId);
      if (!isCallOpen(call, nowMs)) return notFound(NOT_OPEN);

      try {
        await enforceSubmissionQuota(store, callQuotaKey(eventId), { now: nowMs, limit: SUBMISSIONS_PER_CALL_PER_HOUR });
      } catch (error) {
        if (error?.code === 'SUBMISSION_RATE_LIMIT') return limited();
        throw error;
      }

      const doc = composeSubmission({ eventId, value, id: uuid(), nowIso: new Date(nowMs).toISOString() });
      await store.createDoc(CFS_CONTAINER, doc);
      context.log?.('[developer-api] proposal accepted for review');
      return json(201, { ok: true, id: doc.id, status: 'pending' });
    }),

    /** GET events/{eventId}/call-for-speakers/submissions?status= — cfs:manage. */
    listSubmissions: route('list the proposals', async (request) => {
      const auth = await guard.requireScope(request, 'cfs:manage');
      if (auth.error) return auth.error;
      const eventId = eventIdOf(request);
      const status = request.query?.get?.('status') || null;
      if (status !== null && !REVIEW_DECISIONS.includes(status)) {
        return json(400, { ok: false, code: 'INVALID', error: `status must be one of: ${REVIEW_DECISIONS.join(', ')}.` });
      }
      const call = await ownedCall(eventId, auth.user);
      const parameters = [{ name: '@eventId', value: eventId }];
      let where = "c.docType = 'cfs-submission' AND c.eventId = @eventId";
      if (status) {
        where += ' AND c.status = @status';
        parameters.push({ name: '@status', value: status });
      }
      const rows = await store.queryDocs(
        CFS_CONTAINER,
        `SELECT TOP ${MAX_LISTED} * FROM c WHERE ${where} ORDER BY c.submittedAt DESC`,
        parameters,
        { partitionKey: eventId },
      );
      const submissions = (rows || []).map(presentSubmission);
      return json(200, { ok: true, call: presentCall(call, now()), submissions, count: submissions.length });
    }),

    /** PUT events/{eventId}/call-for-speakers/submissions/{submissionId} — cfs:manage. Records a decision; publishes nothing. */
    reviewSubmission: route('review the proposal', async (request, context) => {
      const auth = await guard.requireScope(request, 'cfs:manage');
      if (auth.error) return auth.error;
      const eventId = eventIdOf(request);
      const submissionId = request.params?.submissionId;
      if (!isSubmissionId(submissionId)) {
        return json(400, { ok: false, code: 'INVALID', error: 'The submission id must be a UUID.' });
      }
      const review = validateReview(await readJson(request));
      await ownedCall(eventId, auth.user);

      const existing = await store.readDoc(CFS_CONTAINER, submissionId, eventId);
      if (!existing || existing.docType !== 'cfs-submission' || existing.eventId !== eventId) {
        return notFound('There is no such proposal on this event.');
      }
      const nowIso = new Date(now()).toISOString();
      const next = {
        ...existing,
        status: review.decision,
        reviewNote: review.note,
        reviewedAt: review.decision === 'pending' ? null : nowIso,
        reviewedBy: review.decision === 'pending' ? null : auth.user.oid,
      };
      let written;
      try {
        written = await store.replaceDocIfMatch(CFS_CONTAINER, next, { partitionKey: eventId });
      } catch (error) {
        if (isConflict(error)) return json(409, { ok: false, code: 'CONFLICT', error: CHANGED });
        throw error;
      }
      await audit(context, 'developer_cfs_submission_reviewed', auth.user, {
        resource: `${CFS_CONTAINER}:${submissionId}`,
        // Status only: the proposal's text and the speaker's email stay out of the audit trail.
        before: { status: existing.status },
        after: { status: review.decision },
        details: { eventId, submissionId },
      });
      return json(200, { ok: true, submission: presentSubmission(written || next) });
    }),
  };
}
