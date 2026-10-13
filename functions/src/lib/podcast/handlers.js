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
 * unless `?refresh=1`.
 */
import { JOBS_CONTAINER, newJobDoc } from '../jobs.js';
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
import { readHostOverview } from './host-reads.js';
import { freePlanRefusal } from './speech-licence.js';
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

/** The 409 for ElevenLabs free-plan audio (speech-licence.js), or null. */
function licenceRefusal(doc, context, route) {
  const licence = freePlanRefusal(doc);
  if (!licence) return null;
  context.log?.(`${route}: refused (free_plan_licence)`);
  return json(409, { error: licence, code: 'FREE_PLAN_LICENCE' });
}

/**
 * Why a review may not proceed, as a response, or null. A missing transcript
 * is 404. Approving free-plan audio is 409, checked before the status write
 * so the refusal changes nothing and queues no host step. Withdrawing to
 * draft is never refused.
 */
function reviewRefusal(existing, { id, status, context }) {
  if (!existing) return json(404, { error: `No podcast transcript ${id}` });
  if (status !== STATUS.published) return null;
  return licenceRefusal(existing, context, 'reviewPodcastTranscript');
}

/**
 * Why a publish retry may not proceed, as a response, or null: a missing
 * transcript (404), one that is not approved (409 — approval is what
 * publishes), or approved free-plan audio (409).
 */
function retryRefusal(doc, { id, context }) {
  if (!doc) return json(404, { error: `No podcast transcript ${id}` });
  if (doc.status !== STATUS.published) {
    return json(409, {
      error:
        `Podcast transcript ${id} is ${doc.status || 'not published'}; ` +
        'approve it first — publishing to Podbean is what approval does.',
    });
  }
  return licenceRefusal(doc, context, 'publishPodcastTranscript');
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
  /**
   * Queue or skip the host step for one published transcript and shape the
   * outcome for a response. A throw here is the caller's to handle, because
   * what it means differs: after an approval the status write has already
   * happened and must be reported; on the retry route nothing has.
   */
  async function runHostStep({ doc, enqueue, requestedBy, context }) {
    const outcome = await scheduleHostPublish({
      store,
      doc,
      configured: hostConfigured(),
      enqueue,
      requestedBy,
      uuid,
      now,
    });
    // Outcome and the job id (a correlation id), never the transcript id.
    context.log?.(
      `podcast host step: ${outcome.outcome}${outcome.jobId ? ` (job ${outcome.jobId})` : ''}`
    );
    return {
      ...outcome,
      ...(outcome.jobId ? { poll: `getJob?jobId=${outcome.jobId}` } : {}),
    };
  }

  return {
    /**
     * POST /api/cms/podcast/transcripts/generate — `{ articleId }`.
     * Answers 202 with the job id, like `enqueueJob`; the transcript appears
     * on the hub when the job finishes.
     *
     * @param {{ enqueue: (message: {jobId: string, type: string}) => void }} io - the queue output
     */
    async generateTranscript(request, context, { enqueue } = {}) {
      const auth = await guard.requireRole(request, 'editor');
      if (auth.error) return auth.error;
      try {
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== 'object') {
          return json(400, { error: 'Body must be a JSON object' });
        }
        // The worker's validator, so the route and the job say the same thing.
        const parsedId = parseArticleId(body.articleId);
        if (parsedId.error) return json(400, { error: parsedId.error });
        const articleId = parsedId.value;

        const article = await store.readDoc(ARTICLE_CONTAINER, articleId, articleId);
        const refusal = refusalFor(article, articleId);
        if (refusal) return json(article ? 409 : 404, { error: refusal });

        let id;
        try {
          id = transcriptId(article);
        } catch (err) {
          return json(409, { error: err.message });
        }

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

        context.log?.(`generatePodcastTranscript: queued ${jobId} for ${id}`);
        return json(202, {
          ok: true,
          jobId,
          type: TRANSCRIPT_JOB_TYPE,
          status: 'queued',
          poll: `getJob?jobId=${jobId}`,
          transcriptId: id,
        });
      } catch (error) {
        context.error('generatePodcastTranscript failed:', error);
        return json(500, { error: 'Failed to queue the transcript' });
      }
    },

    /** GET /api/cms/podcast/transcripts — every transcript, newest first, no bodies. */
    async listTranscripts(request, context) {
      const auth = await guard.requireRole(request, 'editor');
      if (auth.error) return auth.error;
      try {
        const items = await store.queryDocs(TRANSCRIPT_CONTAINER, LIST_QUERY, []);
        return json(200, { success: true, items, total: items.length });
      } catch (error) {
        context.error('listPodcastTranscripts failed:', error);
        return json(500, { error: 'Failed to list podcast transcripts' });
      }
    },

    /**
     * GET /api/cms/podcast/host/overview[?refresh=1] — what Podbean says now
     * about the show and its episodes, joined to the transcripts that
     * published them, with each episode's downloads over the last thirty
     * days (host-reads.js). Served from `admin_config/podbean_host_overview`
     * while that is under fifteen minutes old unless `refresh=1`. Without the
     * Podbean settings, 200 `{ configured: false, reason }` and no call.
     */
    async getHostOverview(request, context) {
      const auth = await guard.requireRole(request, 'editor');
      if (auth.error) return auth.error;
      try {
        const configured = hostConfigured();
        if (!configured.ok) {
          return json(200, { success: true, configured: false, reason: configured.reason });
        }
        const refresh = request.query?.get?.('refresh') === '1';
        const overview = await readHostOverview({
          client: hostClient(),
          store,
          now,
          refresh,
          log: context.log,
        });
        // Counts and codes only: the rows carry episode titles.
        context.log?.(
          `getPodcastHostOverview: ${overview.cached ? 'cached' : 'live'}, ${overview.episodes.length} rows, ` +
            `${Object.keys(overview.errors || {}).join(',') || 'no'} errors`
        );
        return json(200, { success: true, configured: true, ...overview });
      } catch (error) {
        context.error(`getPodcastHostOverview failed: ${error?.code || 'UNEXPECTED'}`);
        return json(500, { error: 'Failed to read the host overview' });
      }
    },

    /**
     * GET /api/cms/podcast/transcripts/{id} — one transcript in full, drafts
     * and failures included. This is the review view.
     */
    async getTranscript(request, context) {
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
        context.error('getPodcastTranscript failed:', error);
        return json(500, { error: 'Failed to get the podcast transcript' });
      }
    },

    /**
     * POST /api/cms/podcast/transcripts/review — `{ id, status: 'published' | 'draft' }`.
     *
     * Publishing also runs the host step (see the header). The response's
     * `host` is the outcome — `{ pending, jobId, … }`, `{ skipped, reason }`
     * — or null when the transcript was withdrawn; the status is 202 while
     * a publish job is in flight and 200 otherwise.
     *
     * @param {{ enqueue: (message: {jobId: string, type: string}) => void }} io - the queue output
     */
    async reviewTranscript(request, context, { enqueue } = {}) {
      const auth = await guard.requireRole(request, 'publisher');
      if (auth.error) return auth.error;
      let id = '';
      let status = '';
      let existing = null;
      let updated = null;
      try {
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== 'object') {
          return json(400, { error: 'Body must be a JSON object' });
        }
        status = String(body.status || '').trim();

        // 'failed' is written by the generator, never chosen by a reviewer:
        // `draft` is how a reviewer withdraws one, and it leaves a record.
        if (status !== STATUS.published && status !== STATUS.draft) {
          return json(400, {
            error: `status must be "${STATUS.published}" or "${STATUS.draft}"`,
          });
        }
        // The worker's validator (Cosmos's 1,023-byte id bound), so an
        // oversized id is a 400 with the job's own sentence, not a 500.
        const parsedId = parseTranscriptId(body.id, { field: 'id' });
        if (parsedId.error) return json(400, { error: parsedId.error });
        id = parsedId.value;

        existing = await store.readDoc(TRANSCRIPT_CONTAINER, id, id);
        const refused = reviewRefusal(existing, { id, status, context });
        if (refused) return refused;

        updated = await setTranscriptStatus(store, {
          id,
          status,
          actorId: auth.user?.oid || null,
          now: now().toISOString(),
        });
        context.log?.(`reviewPodcastTranscript: → ${status} by ${auth.user?.oid || 'unknown'}`);

        if (status !== STATUS.published) {
          return json(200, { success: true, id, status, item: updated || null, host: null });
        }

        // The document as the status write left it, `_etag` included: the
        // reservation is conditional on that version, not on the one read
        // before the approval, which the status write has already replaced.
        const host = await runHostStep({
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
      } catch (error) {
        // The code only: a RESERVATION_CONTENDED error carries the transcript
        // itself in `latest`, which is content (CodeRabbit on #1125).
        context.error(`reviewPodcastTranscript failed: ${error?.code || 'UNEXPECTED'}`);
        if (!updated) return json(500, { error: 'Failed to update the transcript' });
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
    },

    /**
     * POST /api/cms/podcast/transcripts/{id}/publish — the retry. Refuses
     * anything not `published` with 409 (approval is what publishes), then
     * runs the same host step approval does: 202 with the job id, 200 with
     * `{ skipped, reason }` when there is nothing to send, 409 when a
     * publish job for this transcript is still in flight.
     *
     * @param {{ enqueue: (message: {jobId: string, type: string}) => void }} io - the queue output
     */
    async publishTranscript(request, context, { enqueue } = {}) {
      const auth = await guard.requireRole(request, 'publisher');
      if (auth.error) return auth.error;
      try {
        const parsedId = parseTranscriptId(request.params?.id, { field: 'id' });
        if (parsedId.error) return json(400, { error: parsedId.error });
        const id = parsedId.value;

        const doc = await store.readDoc(TRANSCRIPT_CONTAINER, id, id);
        const refused = retryRefusal(doc, { id, context });
        if (refused) return refused;

        const host = await runHostStep({ doc, enqueue, requestedBy: auth.user, context });
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
      } catch (error) {
        context.error(`publishPodcastTranscript failed: ${error?.code || 'UNEXPECTED'}`);
        return json(500, { error: 'Failed to queue the publish' });
      }
    },
  };
}
