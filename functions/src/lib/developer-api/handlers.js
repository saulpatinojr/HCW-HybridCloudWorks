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
import { recordMutationAudit } from '../audit.js';
import { ORIGIN_NOT_VERIFIED, assertClientIdentity } from '../auth/client-identity.js';
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
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
  encodeListCursor,
  isCallOpen,
  isEventId,
  isSubmissionId,
  ownsCall,
  presentCall,
  presentSubmission,
  readListPaging,
  validateCallChange,
  validateReview,
  validateSubmission,
} from './cfs.js';
import { listPublishedEvents, listSpeakers, readEventFilters, readSearch } from './directory.js';
import {
  API_BASE_PATH,
  REQUESTS_PER_MINUTE,
  SCOPES,
  developerKeyFrom,
  isKeyId,
  isUsable,
  keyRecordId,
  looksLikeKey,
  scopesOf,
} from './keys.js';

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
const NO_PROPOSAL = 'There is no such proposal on this event.';
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
/** How many times a delete reads the proposal again after losing a race, before it answers 409. */
const DELETE_ATTEMPTS = 2;

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

  const readSnapshot = () => publicStore.readDoc('_snapshots', 'speakerevents', 'speakerevents');
  const readCall = (eventId) => store.readDoc(CFS_CONTAINER, callDocId(eventId), eventId);

  /**
   * Is the key that owns this call still a working key? One point read of its
   * record, with no cache, the same read the guard makes: a key revoked a
   * moment ago is seen as revoked by the very next proposal.
   */
  const ownerKeyWorks = async (call) => {
    if (!isKeyId(call?.organizerKeyId)) return false;
    const record = await store.readDoc('admin_config', keyRecordId(call.organizerKeyId), ADMIN_CONFIG_PARTITION);
    return isUsable(record);
  };

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
     *
     * THE ORGANIZER'S RELAY (#1754 review). A browser on the organizer's own
     * site cannot call this route (lib/auth/cors.js answers 403 to an Origin
     * that is not this site's), so the organizer's form posts to their own
     * server and that server sends the proposal on. Every proposal then comes
     * from one address, and the per-caller limit would hold a whole event to
     * five an hour. So a request that carries the key that OWNS this call,
     * with `cfs:manage`, skips the per-caller limit and no other check: the
     * origin check, the body cap, the open-call check and the per-call limit
     * all still apply. A request with no key is handled exactly as before. A
     * working key that does not own the call, or lacks the scope, gets no
     * favour and is counted like any visitor. A key that is wrong or revoked
     * is answered 401 by the guard, so a relay with a dead key finds out.
     *
     * A REVOKED KEY'S CALL TAKES NOTHING (#1777). A call belongs to the key
     * that opened it, and once that key is revoked nobody holds a key that
     * can list, review, delete or close what arrives. So an open call is only
     * open while its key still works: before a proposal is counted against
     * the call or stored, the owning key's record is read (one point read),
     * and a revoked or missing one is answered the same 404 as a closed call.
     * Checked on every proposal rather than by closing the calls at revoke
     * time, so there is no moment between the revoke and the close in which a
     * proposal can still land, and a failed close cannot leave a call open.
     * The owning key relaying its own form was authenticated a few lines up,
     * so that path costs no second read.
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

      const tooLarge = () =>
        json(413, {
          ok: false,
          code: 'TOO_LARGE',
          error: `The proposal is too large: at most ${MAX_SUBMISSION_BYTES} bytes.`,
        });
      // What the client says the size is, before any of it is read. A client
      // can leave the header out or understate it, so the bytes are measured
      // again below.
      const declared = Number(request.headers?.get?.('content-length'));
      if (Number.isFinite(declared) && declared > MAX_SUBMISSION_BYTES) return tooLarge();

      // The relay: only a value shaped like an organizer key is looked up, so
      // an anonymous request costs no key read.
      let relay = null;
      if (looksLikeKey(developerKeyFrom(request))) {
        const auth = await guard.authenticate(request);
        if (auth.error) return auth.error;
        if (scopesOf(auth.record).includes('cfs:manage')) relay = auth.user;
      }

      const raw = typeof request.text === 'function' ? await request.text() : '';
      if (Buffer.byteLength(raw || '', 'utf8') > MAX_SUBMISSION_BYTES) return tooLarge();
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
      // A keyed request reads the call first, to learn whether the key owns
      // it. An anonymous one is counted first, as before, so a caller over
      // the limit costs no read of the call.
      let call = relay ? await readCall(eventId) : null;
      const ownerRelay = Boolean(relay) && ownsCall(call, relay);
      if (!ownerRelay) {
        try {
          await enforceSubmissionQuota(store, clientQuotaKey(clientHash), {
            now: nowMs,
            limit: SUBMISSIONS_PER_CLIENT_PER_HOUR,
          });
        } catch (error) {
          if (error?.code === 'SUBMISSION_RATE_LIMIT') return limited();
          throw error;
        }
      }

      if (!relay) call = await readCall(eventId);
      if (!isCallOpen(call, nowMs)) return notFound(NOT_OPEN);
      if (!ownerRelay && !(await ownerKeyWorks(call))) return notFound(NOT_OPEN);

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
    listSubmissions: route('list the proposals', async (request) => {
      const auth = await guard.requireScope(request, 'cfs:manage');
      if (auth.error) return auth.error;
      const eventId = eventIdOf(request);
      const status = request.query?.get?.('status') || null;
      if (status !== null && !REVIEW_DECISIONS.includes(status)) {
        return json(400, { ok: false, code: 'INVALID', error: `status must be one of: ${REVIEW_DECISIONS.join(', ')}.` });
      }
      const { limit, continuationToken } = readListPaging(request.query, status);
      const call = await ownedCall(eventId, auth.user);
      const parameters = [{ name: '@eventId', value: eventId }];
      let where = "c.docType = 'cfs-submission' AND c.eventId = @eventId";
      if (status) {
        where += ' AND c.status = @status';
        parameters.push({ name: '@status', value: status });
      }
      let page;
      try {
        page = await store.queryDocsPage(
          CFS_CONTAINER,
          `SELECT * FROM c WHERE ${where} ORDER BY c.submittedAt DESC`,
          parameters,
          { partitionKey: eventId, maxItemCount: limit, continuationToken: continuationToken || undefined },
        );
      } catch (error) {
        // A cursor that decodes but that the database does not recognise (an
        // old one, or one made by hand) is the caller's to correct, not a fault.
        if (continuationToken && error?.code === 400) {
          return json(400, {
            ok: false,
            code: 'INVALID',
            error: 'cursor is no longer valid. Start the list again without a cursor.',
          });
        }
        throw error;
      }
      const submissions = (page?.resources || []).map(presentSubmission);
      return json(200, {
        ok: true,
        call: presentCall(call, now()),
        submissions,
        count: submissions.length,
        nextCursor: encodeListCursor({ token: page?.continuationToken, status }),
      });
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
        return notFound(NO_PROPOSAL);
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
        // Deleted between the read and the write: the same answer as a proposal that was never there.
        if (error?.code === 404) return notFound(NO_PROPOSAL);
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
    deleteSubmission: route('delete the proposal', async (request, context) => {
      const auth = await guard.requireScope(request, 'cfs:manage');
      if (auth.error) return auth.error;
      const eventId = eventIdOf(request);
      const submissionId = request.params?.submissionId;
      if (!isSubmissionId(submissionId)) {
        return json(400, { ok: false, code: 'INVALID', error: 'The submission id must be a UUID.' });
      }
      await ownedCall(eventId, auth.user);

      for (let attempt = 0; attempt < DELETE_ATTEMPTS; attempt += 1) {
        const existing = await store.readDoc(CFS_CONTAINER, submissionId, eventId);
        if (!existing || existing.docType !== 'cfs-submission' || existing.eventId !== eventId) {
          return json(200, { ok: true, id: submissionId, deleted: false });
        }
        try {
          await store.deleteDocIfMatch(CFS_CONTAINER, submissionId, existing._etag, eventId);
        } catch (error) {
          if (error?.code === 404) return json(200, { ok: true, id: submissionId, deleted: false });
          if (error?.code === 412) continue;
          throw error;
        }
        await audit(context, 'developer_cfs_submission_deleted', auth.user, {
          resource: `${CFS_CONTAINER}:${submissionId}`,
          // Status only, as for a review: nothing the speaker typed reaches the audit trail.
          before: { status: existing.status },
          after: null,
          details: { eventId, submissionId },
        });
        return json(200, { ok: true, id: submissionId, deleted: true });
      }
      return json(409, { ok: false, code: 'CONFLICT', error: CHANGED });
    }),
  };
}
