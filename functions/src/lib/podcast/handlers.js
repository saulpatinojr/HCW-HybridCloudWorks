/**
 * Podcast transcript admin routes: enqueue a generation, read what was
 * generated, and the review decision (#435).
 *
 * Generation is a job (functions/podcast-jobs.js) because a script, a
 * synthesis and an upload take minutes and an HTTP response is bounded at
 * 230 s. The enqueue is here rather than through the generic
 * `POST /api/enqueueJob` so the refusal an unpublished article earns is a
 * 409 the Publish page can show at once, not a failed job it would have to
 * poll for — the job checks again, as the guard for any other caller.
 *
 * Roles. Generating and reading are `editor`, matching the Listen & Learn
 * routes and the job that does the same work. Approving is `publisher`: it
 * is the act that will put an AI-read episode on the podcast feed under the
 * owner's name — #437 hangs the Podbean publish on it — and "can publish
 * content to live" is what that role is for. Listen & Learn approves at
 * editor; the difference is that a Learn episode goes on a study page and a
 * podcast transcript goes to a host and every subscriber.
 *
 * Approval publishes (#437, ADR 0029 §1b, §1c). Once the review has written
 * `published`, the host step runs through `scheduleHostPublish`: a skip
 * (no audio, Podbean not configured) is recorded on the document at once,
 * otherwise a `publish-podcast-transcript` job is queued and the document
 * is marked `host.podbean.pending`. The response carries that outcome under
 * `host` so the hub can toast it, and answers 202 when a job is in flight.
 * The marker is an etag-conditional reservation (#1118): approval hands
 * `scheduleHostPublish` the document as the status write returned it, with
 * that write's `_etag`, and the retry route hands it the document as read,
 * so an approval and a retry landing in the same instant queue one job and
 * the other answers in flight — 202 here, 409 on the retry — naming it.
 * Three rules hold whatever the host does: a publish failure never
 * un-approves — `status`/`approvedAt` are written here and nowhere in the
 * host path; the retry route below re-runs the same step rather than
 * regenerating, and updates an episode the document already names; and
 * nothing here or in the job writes `podcasts` — the feed stays the ingest
 * boundary, and the site learns of the episode when the timer reads the
 * show's feed. The `host` record itself is read through the existing
 * detail and list routes: it is a stored field, in `TRANSCRIPT_LIST_FIELDS`
 * and in the full document.
 *
 * Approval refuses ElevenLabs free-plan audio (owner decision 2026-09-26,
 * ADR 0029 §2a; speech-licence.js). A transcript whose audio was rendered on
 * the free plan is answered 409 with the licence and the upgrade named, and
 * nothing is written: the status stays draft, so no job is queued and nothing
 * reaches Podbean. The retry route refuses the same way. Withdrawing to
 * draft is never refused.
 *
 * The host overview (#1115) is the one read here that goes to Podbean rather
 * than to Cosmos: what Podbean says now about the episodes the records name,
 * and their downloads (host-reads.js). `editor`, like the list. Without the
 * Podbean settings it answers 200 `{ configured: false, reason }` and calls
 * nothing, the way the ElevenLabs card does; with them, a cached overview
 * unless `?refresh=1`. The host statistics (host-stats.js) are the same
 * shape of route for the Stats tab: `?range=30d|90d|12m`, cached an hour
 * per range.
 */
import { JOBS_CONTAINER, newJobDoc } from '../jobs.js';
import { authoredMessage, errorFacts } from '../http/error-response.js';
import {
  ARTICLE_CONTAINER,
  TRANSCRIPT_JOB_TYPE,
  parseArticleId,
  refusalFor,
} from './generate.js';
import {
  PUBLISH_JOB_TYPE,
  parseTranscriptId,
  recordScheduleFailure,
  scheduleHostPublish,
} from './publish-transcript.js';
import { createPodbeanClient, isConfigured as hostIsConfigured } from './podbean.js';
import { getHostOverview, getHostStats } from './host-routes.js';
import { readBodyObject, readReview, retryRefusal, reviewRefusal } from './review-checks.js';
import {
  STATUS,
  TRANSCRIPT_CONTAINER,
  TRANSCRIPT_LIST_FIELDS,
  setTranscriptStatus,
  transcriptId,
} from './store.js';

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * A ceiling, not a page size. The catalogue is tens of articles; anything
 * past this means a container has run away, which is what is defended against.
 */
const MAX_TRANSCRIPTS = 200;

const LIST_PROJECTION = TRANSCRIPT_LIST_FIELDS.map((field) => `c.${field}`).join(', ');

/**
 * Newest generation first, ordered by Cosmos rather than in memory: with the
 * TOP bound, an unordered query could hand back any MAX_TRANSCRIPTS rows and
 * the newest would be the ones missing. A single-property ORDER BY needs only
 * the range index every path has under the container's `/*` policy — the
 * same shape `public-reads.js` uses for `approvedAt`. Every document
 * store.js writes carries `generatedAt`, so none is excluded by the sort.
 */
const LIST_QUERY = `SELECT TOP ${MAX_TRANSCRIPTS} ${LIST_PROJECTION} FROM c ORDER BY c.generatedAt DESC`;

/**
 * Queue or skip the host step for one published transcript and shape the
 * outcome for a response. A throw here is the caller's to handle, because
 * what it means differs: after an approval the status write has already
 * happened and must be reported; on the retry route nothing has.
 */
async function runHostStep(h, { doc, enqueue, requestedBy, context }) {
  const outcome = await scheduleHostPublish({
    store: h.store,
    doc,
    configured: h.hostConfigured(),
    enqueue,
    requestedBy,
    uuid: h.uuid,
    now: h.now,
  });
  // The outcome and whether a job was queued; no job id or transcript id (#1802).
  context.log?.(
    `podcast host step: ${outcome.outcome}${outcome.jobId ? ' (job queued)' : ''}`
  );
  return {
    ...outcome,
    ...(outcome.jobId ? { poll: `getJob?jobId=${outcome.jobId}` } : {}),
  };
}

/** The article the request names: `{ article, articleId }`, or `{ response }` with the refusal. */
async function articleFor({ store }, request) {
  const body = await readBodyObject(request);
  if (!body) return { response: json(400, { error: 'Body must be a JSON object' }) };
  // The worker's validator, so the route and the job say the same thing.
  const parsedId = parseArticleId(body.articleId);
  if (parsedId.error) return { response: json(400, { error: parsedId.error }) };
  const articleId = parsedId.value;
  const article = await store.readDoc(ARTICLE_CONTAINER, articleId, articleId);
  const refusal = refusalFor(article, articleId);
  if (refusal) return { response: json(article ? 409 : 404, { error: refusal }) };
  return { article, articleId };
}

/** Write and queue the transcript job; 202 with its id. */
async function queueTranscript({ store, now, uuid }, { auth, enqueue, context, articleId, id }) {
  if (typeof enqueue !== 'function') {
    context.error?.('generatePodcastTranscript: no queue output wired');
    return json(500, { error: 'Job queue is not configured' });
  }
  const jobId = uuid();
  const doc = newJobDoc({
    id: jobId,
    type: TRANSCRIPT_JOB_TYPE,
    payload: { articleId },
    requestedBy: auth.user,
    createdAt: now().toISOString(),
  });
  await store.upsertDoc(JOBS_CONTAINER, doc);
  enqueue({ jobId, type: TRANSCRIPT_JOB_TYPE });

  context.log?.('generatePodcastTranscript: queued');
  return json(202, {
    ok: true,
    jobId,
    type: TRANSCRIPT_JOB_TYPE,
    status: 'queued',
    poll: `getJob?jobId=${jobId}`,
    transcriptId: id,
  });
}

/**
 * POST /api/cms/podcast/transcripts/generate — `{ articleId }`.
 * Answers 202 with the job id, like `enqueueJob`; the transcript appears
 * on the hub when the job finishes.
 *
 * @param {object} h - the handlers' dependencies
 * @param {object} request
 * @param {object} context
 * @param {{ enqueue: (message: {jobId: string, type: string}) => void }} io - the queue output
 */
async function generateTranscript(h, request, context, { enqueue } = {}) {
  const auth = await h.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const target = await articleFor(h, request);
    if (target.response) return target.response;
    let id;
    try {
      id = transcriptId(target.article);
    } catch (err) {
      return json(409, { error: authoredMessage(err, 'This article cannot be keyed as a transcript.') });
    }
    return await queueTranscript(h, { auth, enqueue, context, articleId: target.articleId, id });
  } catch (error) {
    context.error('generatePodcastTranscript failed:', errorFacts(error));
    return json(500, { error: 'Failed to queue the transcript' });
  }
}

/** GET /api/cms/podcast/transcripts — every transcript, newest first, no bodies. */
async function listTranscripts({ guard, store }, request, context) {
  const auth = await guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const items = await store.queryDocs(TRANSCRIPT_CONTAINER, LIST_QUERY, []);
    return json(200, { success: true, items, total: items.length });
  } catch (error) {
    context.error('listPodcastTranscripts failed:', errorFacts(error));
    return json(500, { error: 'Failed to list podcast transcripts' });
  }
}

/**
 * GET /api/cms/podcast/transcripts/{id} — one transcript in full, drafts
 * and failures included. This is the review view.
 */
async function getTranscript({ guard, store }, request, context) {
  const auth = await guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    // Same rule as the write routes: an oversized id is a 400 here, not
    // a Cosmos error surfacing as a 500.
    const parsedId = parseTranscriptId(request.params?.id, { field: 'id' });
    if (parsedId.error) return json(400, { error: parsedId.error });
    const id = parsedId.value;

    const item = await store.readDoc(TRANSCRIPT_CONTAINER, id, id);
    if (!item) return json(404, { error: `No podcast transcript ${id}` });
    return json(200, { success: true, item });
  } catch (error) {
    context.error('getPodcastTranscript failed:', errorFacts(error));
    return json(500, { error: 'Failed to get the podcast transcript' });
  }
}

/** After an approval: the host step, and the answer that reports it. */
async function publishAfterReview(h, { state, enqueue, auth, context }) {
  const { id, status, existing, updated } = state;
  // The document as the status write left it, `_etag` included: the
  // reservation is conditional on that version, not on the one read
  // before the approval, which the status write has already replaced.
  const host = await runHostStep(h, {
    doc: { ...existing, ...(updated || {}) },
    enqueue,
    requestedBy: auth.user,
    context,
  });
  const inFlight = host.outcome === 'queued' || host.outcome === 'in_flight';
  return json(inFlight ? 202 : 200, {
    success: true,
    id,
    status,
    item: updated || null,
    host: host.host,
    ...(host.jobId ? { jobId: host.jobId, poll: host.poll } : {}),
  });
}

/** Check, write the status, and run the host step on an approval. Fills `state` as it goes. */
async function applyReview(h, request, context, { auth, enqueue, state }) {
  const review = await readReview(request);
  if (review.response) return review.response;
  state.status = review.status;
  state.id = review.id;
  const { id, status } = state;

  state.existing = await h.store.readDoc(TRANSCRIPT_CONTAINER, id, id);
  const refused = reviewRefusal(state.existing, { id, status, context });
  if (refused) return refused;

  state.updated = await setTranscriptStatus(h.store, {
    id,
    status,
    actorId: auth.user?.oid || null,
    now: h.now().toISOString(),
  });
  context.log?.(`reviewPodcastTranscript: → ${status}`);

  if (status !== STATUS.published) {
    return json(200, { success: true, id, status, item: state.updated || null, host: null });
  }
  return publishAfterReview(h, { state, enqueue, auth, context });
}

/** The answer when the approval was saved but its host step could not be queued. */
function scheduleFailedAnswer({ id, status, updated }) {
  return json(200, {
    success: true,
    id,
    status,
    item: updated,
    host: {
      error: {
        status: null,
        code: 'SCHEDULE_FAILED',
        message:
          'The approval was saved, but the Podbean publish could not be queued; use Publish to retry.',
        retryable: true,
      },
    },
  });
}

/**
 * POST /api/cms/podcast/transcripts/review — `{ id, status: 'published' | 'draft' }`.
 *
 * Publishing also runs the host step (see the header). The response's
 * `host` is the outcome — `{ pending, jobId, … }`, `{ skipped, reason }`
 * — or null when the transcript was withdrawn; the status is 202 while
 * a publish job is in flight and 200 otherwise.
 *
 * @param {object} h - the handlers' dependencies
 * @param {object} request
 * @param {object} context
 * @param {{ enqueue: (message: {jobId: string, type: string}) => void }} io - the queue output
 */
async function reviewTranscript(h, request, context, { enqueue } = {}) {
  const { store, now } = h;
  const auth = await h.guard.requireRole(request, 'publisher');
  if (auth.error) return auth.error;
  const state = { id: '', status: '', existing: null, updated: null };
  try {
    return await applyReview(h, request, context, { auth, enqueue, state });
  } catch (error) {
    // The code only: a RESERVATION_CONTENDED error carries the transcript
    // itself in `latest`, which is content (CodeRabbit on #1125).
    context.error(`reviewPodcastTranscript failed: ${error?.code || 'UNEXPECTED'}`);
    if (!state.updated) return json(500, { error: 'Failed to update the transcript' });
    const { existing, updated } = state;
    // The approval is written; only the host step failed to queue. Say
    // so rather than reporting a change that did happen as a failure —
    // and persist it, so a refreshed hub shows the failure and the retry
    // rather than the stale host record. Best effort: the second write
    // must not turn a saved approval into a 500.
    // From the newest document the scheduler saw, when it says which
    // (RESERVATION_CONTENDED), else the one the host step was handed: the
    // record conditions on that version, so a reservation written since
    // is left alone. No document at all means nothing to record on.
    const stored =
      error?.code === 'TRANSCRIPT_NOT_FOUND'
        ? false
        : await recordScheduleFailure({
            store,
            doc: error?.latest ?? { ...existing, ...updated },
            now,
          });
    context.log?.(
      `reviewPodcastTranscript: host step not queued (SCHEDULE_FAILED ${stored ? 'recorded' : 'not recorded'})`
    );
    return scheduleFailedAnswer(state);
  }
}

/** The retry's answer for the host step's outcome. */
function publishAnswer(id, host) {
  if (host.outcome === 'in_flight') {
    return json(409, {
      error: `Podcast transcript ${id} is already being published (job ${host.jobId}).`,
      host: host.host,
      jobId: host.jobId,
      poll: host.poll,
    });
  }
  if (host.outcome === 'queued') {
    return json(202, {
      ok: true,
      id,
      jobId: host.jobId,
      type: PUBLISH_JOB_TYPE,
      status: 'queued',
      poll: host.poll,
      host: host.host,
    });
  }
  return json(200, { ok: true, id, host: host.host });
}

/** Check the transcript may be published again, and run the host step. */
async function retryPublish(h, request, context, { auth, enqueue }) {
  const parsedId = parseTranscriptId(request.params?.id, { field: 'id' });
  if (parsedId.error) return json(400, { error: parsedId.error });
  const id = parsedId.value;

  const doc = await h.store.readDoc(TRANSCRIPT_CONTAINER, id, id);
  const refused = retryRefusal(doc, { id, context });
  if (refused) return refused;

  const host = await runHostStep(h, { doc, enqueue, requestedBy: auth.user, context });
  return publishAnswer(id, host);
}

/**
 * POST /api/cms/podcast/transcripts/{id}/publish — the retry. Refuses
 * anything not `published` with 409 (approval is what publishes), then
 * runs the same host step approval does: 202 with the job id, 200 with
 * `{ skipped, reason }` when there is nothing to send, 409 when a
 * publish job for this transcript is still in flight.
 *
 * @param {object} h - the handlers' dependencies
 * @param {object} request
 * @param {object} context
 * @param {{ enqueue: (message: {jobId: string, type: string}) => void }} io - the queue output
 */
async function publishTranscript(h, request, context, { enqueue } = {}) {
  const auth = await h.guard.requireRole(request, 'publisher');
  if (auth.error) return auth.error;
  try {
    return await retryPublish(h, request, context, { auth, enqueue });
  } catch (error) {
    context.error(`publishPodcastTranscript failed: ${error?.code || 'UNEXPECTED'}`);
    return json(500, { error: 'Failed to queue the publish' });
  }
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ queryDocs: Function, readDoc: Function, upsertDoc: Function, patchDoc: Function }} deps.store
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 * @param {() => { ok: boolean, reason?: string }} [deps.hostConfigured] `isConfigured` for Podbean; injected for tests
 * @param {() => object} [deps.hostClient] a Podbean client for the overview; injected for tests
 */
export function createPodcastHandlers({
  guard,
  store,
  now = () => new Date(),
  uuid = () => crypto.randomUUID(),
  hostConfigured = () => hostIsConfigured(),
  hostClient = () => createPodbeanClient(),
}) {
  const h = { guard, store, now, uuid, hostConfigured, hostClient };
  return {
    generateTranscript: (request, context, io) => generateTranscript(h, request, context, io),
    listTranscripts: (request, context) => listTranscripts(h, request, context),
    getHostOverview: (request, context) => getHostOverview(h, request, context),
    getHostStats: (request, context) => getHostStats(h, request, context),
    getTranscript: (request, context) => getTranscript(h, request, context),
    reviewTranscript: (request, context, io) => reviewTranscript(h, request, context, io),
    publishTranscript: (request, context, io) => publishTranscript(h, request, context, io),
  };
}
