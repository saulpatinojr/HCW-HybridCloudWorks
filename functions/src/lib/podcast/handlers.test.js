/**
 * Podcast transcript admin routes.
 *
 * The load-bearing assertions: every route is gated (review at publisher),
 * an unpublished article is refused at the door rather than as a failed job,
 * the enqueue writes the same job document `enqueueJob` does, the listing
 * never carries a transcript body, and a reviewer cannot set `failed`.
 *
 * Slice 2 of #437 adds: approval runs the host step and reports it; a host
 * skip or failure never changes what the review wrote; the retry route
 * refuses a draft and re-runs the step for a published one.
 *
 * #1118: the pending marker is reserved on the etag the status write
 * returned, and an approval racing a retry queues one job that both answers
 * name.
 */
import { describe, it, expect, vi } from 'vitest';
import { createPodcastHandlers } from './handlers.js';
import { ARTICLE_CONTAINER, TRANSCRIPT_JOB_TYPE } from './generate.js';
import { PUBLISH_JOB_TYPE } from './publish-transcript.js';
import { STATUS, TRANSCRIPT_CONTAINER, TRANSCRIPT_LIST_FIELDS } from './store.js';
import { JOBS_CONTAINER } from '../jobs.js';

const NOW = new Date('2026-09-08T12:00:00.000Z');
const context = { log: vi.fn(), error: vi.fn() };

const CONFIGURED = { ok: true, podcastId: '4242' };
const NOT_CONFIGURED = {
  ok: false,
  reason:
    'Podbean publishing is not configured: PODBEAN_CLIENT_SECRET (Key Vault secret PODBEAN-CLIENT-SECRET) is not set, so episodes stay on the manual upload path.',
};

const USER = { oid: 'oid-1', email: 'editor@example.test' };
const allowGuard = {
  requireRole: vi.fn(async (_req, role) => ({ user: USER, role, error: null })),
};
const denyGuard = {
  requireRole: vi.fn(async () => ({ user: null, role: null, error: { status: 403, body: '{}' } })),
};
/** Editor, but not publisher: the review route must refuse. */
const editorOnlyGuard = {
  requireRole: vi.fn(async (_req, role) =>
    role === 'publisher'
      ? { user: null, role: null, error: { status: 403, body: '{}' } }
      : { user: USER, role, error: null }
  ),
};

const makeRequest = ({ params = {}, body } = {}) => ({
  params,
  json: async () => {
    if (body === undefined) throw new SyntaxError('no body');
    return body;
  },
});

const published = (over = {}) => ({
  id: 'content-1',
  Title: 'Picking a state backend',
  slug: 'picking-a-state-backend',
  contentStatus: 'published_blog',
  ...over,
});

const makeStore = (over = {}) => ({
  queryDocs: vi.fn(async () => []),
  readDoc: vi.fn(async () => null),
  upsertDoc: vi.fn(async (_c, doc) => doc),
  patchDoc: vi.fn(async (_c, id, updates) => ({ id, ...updates })),
  ...over,
});

/** A stored transcript, as the review and retry routes read it. */
const transcript = (over = {}) => ({
  id: 'article_x',
  sourceId: 'content-1',
  title: 'Picking a state backend',
  summary: 'Where state lives.',
  keyTakeaways: [],
  audioPath: 'article/x.mp3',
  audioError: null,
  status: STATUS.draft,
  approvedAt: null,
  approvedBy: null,
  host: null,
  _etag: '"etag-1"',
  ...over,
});

/** A Podbean client that answers an empty show; the overview tests replace parts of it. */
const makeHostClient = (over = {}) => ({
  getPodcast: vi.fn(async () => ({ podcast: { id: 'p1', title: 'Hybrid Cloud Insights' } })),
  listEpisodes: vi.fn(async () => ({ episodes: [] })),
  getDownloadStats: vi.fn(async () => ({})),
  getCountryStats: vi.fn(async () => ({ US: 3 })),
  getPlatformStats: vi.fn(async () => ({ iOS: 2 })),
  getSourceStats: vi.fn(async () => ({ Spotify: 1 })),
  getUserRetention: vi.fn(async () => ({})),
  getAnalyticReports: vi.fn(async () => ({ followers: 1, likes: 0, comments: 0, total_episode_length: 60 })),
  ...over,
});

const handlers = (
  store,
  guard = allowGuard,
  { hostConfigured = () => CONFIGURED, hostClient = () => makeHostClient() } = {}
) =>
  createPodcastHandlers({
    guard,
    store,
    now: () => NOW,
    uuid: () => 'job-1',
    hostConfigured,
    hostClient,
  });

/**
 * A store holding one transcript whose `_etag` moves on every write, as
 * Cosmos's does, and a jobs container: a transcript patch carrying `ifMatch`
 * lands only on the etag it names, any other is the SDK's 412 (#1118).
 */
const versionedStore = (transcript) => {
  const state = { transcript: { ...transcript }, jobs: new Map(), version: 1 };
  const store = makeStore({
    readDoc: vi.fn(async (container, id) => {
      if (container === JOBS_CONTAINER) return state.jobs.get(id) || null;
      return container === TRANSCRIPT_CONTAINER && id === state.transcript.id
        ? { ...state.transcript }
        : null;
    }),
    upsertDoc: vi.fn(async (container, d) => {
      if (container === JOBS_CONTAINER) state.jobs.set(d.id, { ...d });
      return d;
    }),
    patchDoc: vi.fn(async (container, id, updates, options = {}) => {
      if (container === JOBS_CONTAINER) {
        const job = { ...state.jobs.get(id), ...updates };
        state.jobs.set(id, job);
        return job;
      }
      if (options.ifMatch !== undefined && options.ifMatch !== state.transcript._etag) {
        throw Object.assign(new Error('precondition failed'), { code: 412 });
      }
      state.version += 1;
      Object.assign(state.transcript, updates, { _etag: `"etag-${state.version}"` });
      return { ...state.transcript };
    }),
  });
  return { store, state };
};

describe('auth', () => {
  it('every handler passes a guard denial through with zero store reads', async () => {
    const store = makeStore();
    const h = handlers(store, denyGuard);

    const responses = await Promise.all([
      h.generateTranscript(makeRequest({ body: { articleId: 'content-1' } }), context, {
        enqueue: vi.fn(),
      }),
      h.listTranscripts(makeRequest(), context),
      h.getTranscript(makeRequest({ params: { id: 'article_x' } }), context),
      h.reviewTranscript(makeRequest({ body: { id: 'article_x', status: 'published' } }), context),
      h.publishTranscript(makeRequest({ params: { id: 'article_x' } }), context, {
        enqueue: vi.fn(),
      }),
      h.getHostOverview(makeRequest(), context),
      h.getHostStats(makeRequest(), context),
    ]);

    expect(responses.map((r) => r.status)).toEqual([403, 403, 403, 403, 403, 403, 403]);
    expect(store.queryDocs).not.toHaveBeenCalled();
    expect(store.readDoc).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(store.patchDoc).not.toHaveBeenCalled();
  });

  it('review and the retry are gated at publisher; generate and the reads at editor', async () => {
    const store = makeStore({ readDoc: vi.fn(async () => published()) });
    const h = handlers(store, editorOnlyGuard);

    const review = await h.reviewTranscript(
      makeRequest({ body: { id: 'article_x', status: 'published' } }),
      context
    );
    expect(review.status).toBe(403);
    const retry = await h.publishTranscript(makeRequest({ params: { id: 'article_x' } }), context, {
      enqueue: vi.fn(),
    });
    expect(retry.status).toBe(403);
    expect(store.patchDoc).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();

    const generate = await h.generateTranscript(
      makeRequest({ body: { articleId: 'content-1' } }),
      context,
      { enqueue: vi.fn() }
    );
    expect(generate.status).toBe(202);
    expect((await h.listTranscripts(makeRequest(), context)).status).toBe(200);
  });
});

describe('generateTranscript', () => {
  it('writes a queued job for a published article, sends the message, answers 202', async () => {
    const store = makeStore({ readDoc: vi.fn(async () => published()) });
    const enqueue = vi.fn();
    const res = await handlers(store).generateTranscript(
      makeRequest({ body: { articleId: ' content-1 ' } }),
      context,
      { enqueue }
    );

    expect(res.status).toBe(202);
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      jobId: 'job-1',
      type: TRANSCRIPT_JOB_TYPE,
      status: 'queued',
      poll: 'getJob?jobId=job-1',
      transcriptId: 'article_picking-a-state-backend',
    });
    expect(store.readDoc).toHaveBeenCalledWith(ARTICLE_CONTAINER, 'content-1', 'content-1');
    // The same document shape enqueueJob writes, so the worker, the sweeper
    // and getJob read it identically.
    expect(store.upsertDoc).toHaveBeenCalledWith(JOBS_CONTAINER, {
      id: 'job-1',
      type: TRANSCRIPT_JOB_TYPE,
      payload: { articleId: 'content-1' },
      status: 'queued',
      createdAt: NOW.toISOString(),
      startedAt: null,
      finishedAt: null,
      attempts: 0,
      requestedBy: USER,
      result: null,
      error: null,
    });
    expect(enqueue).toHaveBeenCalledWith({ jobId: 'job-1', type: TRANSCRIPT_JOB_TYPE });
  });

  it('refuses an unpublished article with 409 and a plain sentence, enqueuing nothing', async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => published({ contentStatus: 'approved_blog' })),
    });
    const enqueue = vi.fn();
    const res = await handlers(store).generateTranscript(
      makeRequest({ body: { articleId: 'content-1' } }),
      context,
      { enqueue }
    );

    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).error).toMatch(
      /content-1 is not published; only published articles produce a podcast transcript/
    );
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('404s an article that does not exist', async () => {
    const res = await handlers(makeStore()).generateTranscript(
      makeRequest({ body: { articleId: 'ghost' } }),
      context,
      { enqueue: vi.fn() }
    );
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).error).toMatch(/ghost was not found/);
  });

  it('400s a missing, non-string or oversized articleId with the worker\'s own sentences', async () => {
    // One validator behind both doors: the route must refuse with exactly the
    // message the job would have failed with, or the same input reads as two
    // different faults depending on how it arrived.
    const h = handlers(makeStore());
    const io = { enqueue: vi.fn() };
    const refuse = async (body) => {
      const res = await h.generateTranscript(makeRequest({ body }), context, io);
      expect(res.status).toBe(400);
      return JSON.parse(res.body).error;
    };
    expect(await refuse({})).toBe('articleId is required');
    expect(await refuse({ articleId: '   ' })).toBe('articleId is required');
    expect(await refuse({ articleId: 42 })).toBe('articleId is required');
    expect(await refuse({ articleId: 'x'.repeat(201) })).toBe('articleId is too long');
    expect(io.enqueue).not.toHaveBeenCalled();
  });

  it('400s a body that is not JSON', async () => {
    const io = { enqueue: vi.fn() };
    expect((await handlers(makeStore()).generateTranscript(makeRequest(), context, io)).status).toBe(
      400
    );
    expect(io.enqueue).not.toHaveBeenCalled();
  });

  it('500s when no queue output is wired, rather than writing a job nothing will run', async () => {
    const store = makeStore({ readDoc: vi.fn(async () => published()) });
    const res = await handlers(store).generateTranscript(
      makeRequest({ body: { articleId: 'content-1' } }),
      context
    );
    expect(res.status).toBe(500);
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('500s a store failure without leaking it', async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => {
        throw new Error('cosmos down');
      }),
    });
    const res = await handlers(store).generateTranscript(
      makeRequest({ body: { articleId: 'content-1' } }),
      context,
      { enqueue: vi.fn() }
    );
    expect(res.status).toBe(500);
    expect(res.body).not.toContain('cosmos down');
  });
});

describe('listTranscripts', () => {
  it('projects to the listing allowlist — never the transcript body — and bounds the query', async () => {
    const store = makeStore();
    await handlers(store).listTranscripts(makeRequest(), context);

    const [container, query] = store.queryDocs.mock.calls[0];
    expect(container).toBe(TRANSCRIPT_CONTAINER);
    expect(query).toMatch(/^SELECT TOP \d+ /);
    expect(query).not.toMatch(/SELECT TOP \d+ \*/);
    expect(query).not.toContain('c.transcript');
    for (const field of TRANSCRIPT_LIST_FIELDS) expect(query).toContain(`c.${field}`);
  });

  it('orders newest first in the query, not in memory, so the TOP bound keeps the newest rows', async () => {
    // A bounded query with no ORDER BY hands back any MAX rows; sorting those
    // afterwards would present a stale window as "newest first".
    const store = makeStore();
    await handlers(store).listTranscripts(makeRequest(), context);
    expect(store.queryDocs.mock.calls[0][1]).toMatch(/ ORDER BY c\.generatedAt DESC$/);
  });

  it('returns the rows in the order Cosmos gave them, with a total', async () => {
    const rows = [
      { id: 'article_b', generatedAt: '2026-06-01T00:00:00Z' },
      { id: 'article_a', generatedAt: '2026-01-01T00:00:00Z' },
    ];
    const store = makeStore({ queryDocs: vi.fn(async () => rows) });
    const body = JSON.parse((await handlers(store).listTranscripts(makeRequest(), context)).body);
    expect(body.items.map((t) => t.id)).toEqual(['article_b', 'article_a']);
    expect(body.total).toBe(2);
  });
});

describe('getTranscript', () => {
  it('returns one transcript in full, drafts and failures included', async () => {
    const doc = { id: 'article_x', status: STATUS.failed, error: 'model refused', transcript: [] };
    const store = makeStore({ readDoc: vi.fn(async () => doc) });
    const res = await handlers(store).getTranscript(
      makeRequest({ params: { id: 'article_x' } }),
      context
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).item).toEqual(doc);
    expect(store.readDoc).toHaveBeenCalledWith(TRANSCRIPT_CONTAINER, 'article_x', 'article_x');
  });

  it('carries the host record, on the detail and in the listing allowlist, so the hub can read it', async () => {
    // The hub reads `host` to say published / publishing… / not configured /
    // failed. It is a stored field; no separate route is needed for it.
    const host = { podbean: { episodeId: 'IWPNG2FB3F', pending: false, error: null } };
    const store = makeStore({ readDoc: vi.fn(async () => transcript({ host })) });
    const res = await handlers(store).getTranscript(
      makeRequest({ params: { id: 'article_x' } }),
      context
    );
    expect(JSON.parse(res.body).item.host).toEqual(host);
    expect(TRANSCRIPT_LIST_FIELDS).toContain('host');
  });

  it('404s an unknown id and 400s a missing one', async () => {
    const h = handlers(makeStore());
    expect((await h.getTranscript(makeRequest({ params: { id: 'nope' } }), context)).status).toBe(
      404
    );
    expect((await h.getTranscript(makeRequest(), context)).status).toBe(400);
  });
});

describe('reviewTranscript', () => {
  /** A store holding one draft transcript with audio, ready to approve. */
  const storeWith = (doc = transcript(), over = {}) =>
    makeStore({
      readDoc: vi.fn(async (container, id) =>
        container === TRANSCRIPT_CONTAINER && id === doc.id ? doc : null
      ),
      ...over,
    });

  const review = (body, store = storeWith(), { guard, hostConfigured, enqueue = vi.fn() } = {}) =>
    handlers(store, guard, { hostConfigured }).reviewTranscript(makeRequest({ body }), context, {
      enqueue,
    });

  /** The patch calls on the transcript, in order. */
  const transcriptPatches = (store) =>
    store.patchDoc.mock.calls.filter(([c]) => c === TRANSCRIPT_CONTAINER).map((c) => c[2]);

  it('publishes a transcript and stamps the approver from the guard identity', async () => {
    const store = storeWith();
    const res = await review({ id: 'article_x', status: 'published' }, store);

    expect(res.status).toBe(202);
    expect(store.patchDoc).toHaveBeenCalledWith(
      TRANSCRIPT_CONTAINER,
      'article_x',
      { status: 'published', approvedAt: NOW.toISOString(), approvedBy: 'oid-1' },
      { partitionKey: 'article_x' }
    );
    expect(JSON.parse(res.body)).toMatchObject({ success: true, id: 'article_x', status: 'published' });
  });

  it('runs the host step after approval: writes the publish job, marks the transcript pending, answers 202 with the job', async () => {
    const store = storeWith();
    const enqueue = vi.fn();
    const res = await review({ id: 'article_x', status: 'published' }, store, { enqueue });

    expect(res.status).toBe(202);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      success: true,
      status: 'published',
      jobId: 'job-1',
      poll: 'getJob?jobId=job-1',
      host: { pending: true, jobId: 'job-1', queuedAt: NOW.toISOString() },
    });
    expect(store.upsertDoc).toHaveBeenCalledWith(
      JOBS_CONTAINER,
      expect.objectContaining({
        id: 'job-1',
        type: PUBLISH_JOB_TYPE,
        payload: { transcriptId: 'article_x' },
        status: 'queued',
        requestedBy: USER,
      })
    );
    expect(enqueue).toHaveBeenCalledWith({ jobId: 'job-1', type: PUBLISH_JOB_TYPE });
    // Status first, host second, and the host patch never carries the approval fields.
    const patches = transcriptPatches(store);
    expect(patches).toHaveLength(2);
    expect(patches[0]).toHaveProperty('status', 'published');
    expect(patches[1]).toEqual({
      host: { podbean: { pending: true, jobId: 'job-1', queuedAt: NOW.toISOString() } },
    });
  });

  it('reserves the pending marker on the etag the status write returned, not the one read before the approval (#1118)', async () => {
    // The status write replaces the version the handler read; a reservation
    // conditional on the pre-approval etag would lose to the approval itself.
    const store = storeWith(transcript(), {
      patchDoc: vi.fn(async (_c, id, updates) =>
        updates.status ? { id, ...updates, _etag: '"etag-2"' } : { id, ...updates }
      ),
    });
    const res = await review({ id: 'article_x', status: 'published' }, store);
    expect(res.status).toBe(202);
    expect(store.patchDoc).toHaveBeenCalledWith(
      TRANSCRIPT_CONTAINER,
      'article_x',
      { host: { podbean: { pending: true, jobId: 'job-1', queuedAt: NOW.toISOString() } } },
      { partitionKey: 'article_x', ifMatch: '"etag-2"' }
    );
  });

  it('an approval and a retry landing in the same instant queue one job and agree on it (#1118)', async () => {
    // An already-approved transcript, so both doors are open: approving
    // again re-runs the host step, and so does Publish.
    const { store, state } = versionedStore(transcript({ status: STATUS.published }));
    let n = 0;
    const h = createPodcastHandlers({
      guard: allowGuard,
      store,
      now: () => NOW,
      uuid: () => `job-${(n += 1)}`,
      hostConfigured: () => CONFIGURED,
    });
    const enqueue = vi.fn();

    const [approval, retry] = await Promise.all([
      h.reviewTranscript(makeRequest({ body: { id: 'article_x', status: 'published' } }), context, {
        enqueue,
      }),
      h.publishTranscript(makeRequest({ params: { id: 'article_x' } }), context, { enqueue }),
    ]);

    // Review answers 202 whether it queued or found the retry's job in
    // flight; the retry answers 202 when it won and 409 when it lost. Either
    // way there is one message, one marker, and both name the same job.
    expect(approval.status).toBe(202);
    expect([202, 409]).toContain(retry.status);
    const approvalBody = JSON.parse(approval.body);
    const retryBody = JSON.parse(retry.body);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [{ jobId }] = enqueue.mock.calls[0];
    expect(approvalBody.jobId).toBe(jobId);
    expect(retryBody.jobId).toBe(jobId);
    expect(state.transcript.host.podbean).toEqual({
      pending: true,
      jobId,
      queuedAt: NOW.toISOString(),
    });
    expect(state.transcript).toMatchObject({ status: 'published', approvedBy: 'oid-1' });
    // The winner's job waits for its message; a loser's can never be swept
    // back into the queue.
    const statuses = [...state.jobs.values()].map((job) => job.status).sort();
    expect(statuses).toEqual(statuses.length === 2 ? ['cancelled', 'queued'] : ['queued']);
    expect(state.jobs.get(jobId).status).toBe('queued');
    if (retry.status === 409) {
      expect(retryBody.error).toMatch(new RegExp(`already being published \\(job ${jobId}\\)`));
    }
  });

  it('records not_configured as a skip on the document — status stays published — and answers 200', async () => {
    const store = storeWith();
    const enqueue = vi.fn();
    const res = await review({ id: 'article_x', status: 'published' }, store, {
      enqueue,
      hostConfigured: () => NOT_CONFIGURED,
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).host).toEqual({
      skipped: 'not_configured',
      reason: NOT_CONFIGURED.reason,
      lastAttemptAt: NOW.toISOString(),
      error: null,
    });
    const patches = transcriptPatches(store);
    expect(patches[0]).toMatchObject({ status: 'published', approvedBy: 'oid-1' });
    expect(patches[1].host.podbean.skipped).toBe('not_configured');
    expect(patches[1]).not.toHaveProperty('status');
    expect(enqueue).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('records no_audio when the transcript has none and uploads nothing', async () => {
    const store = storeWith(transcript({ audioPath: null, audioError: 'no speech key' }));
    const enqueue = vi.fn();
    const res = await review({ id: 'article_x', status: 'published' }, store, { enqueue });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('published');
    expect(body.host.skipped).toBe('no_audio');
    expect(body.host.reason).toMatch(/no speech key/);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('keeps the approval, persists SCHEDULE_FAILED on the document and says so when the host step cannot be queued', async () => {
    // The status patch succeeds; the job write fails. The approval happened
    // and must be reported as such — and stored, so a refreshed hub shows
    // the failure and the retry rather than the stale host record.
    const previous = { episodeId: 'IWPNG2FB3F', fileKey: 'k', audioPath: 'article/x.mp3', error: null };
    const store = storeWith(transcript({ host: { podbean: { ...previous, skipped: 'no_audio' } } }), {
      upsertDoc: vi.fn(async () => {
        throw new Error('jobs container down');
      }),
    });
    const res = await review({ id: 'article_x', status: 'published' }, store);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ success: true, status: 'published' });
    expect(body.host.error.code).toBe('SCHEDULE_FAILED');
    expect(res.body).not.toContain('jobs container down');

    const patches = transcriptPatches(store);
    expect(patches).toHaveLength(2);
    expect(patches[0]).toMatchObject({ status: 'published', approvedBy: 'oid-1' });
    expect(patches[1]).toEqual({
      host: {
        podbean: {
          ...previous,
          lastAttemptAt: NOW.toISOString(),
          error: {
            status: null,
            code: 'SCHEDULE_FAILED',
            message: expect.stringMatching(/use Publish to retry/),
            retryable: true,
          },
        },
      },
    });
  });

  it('still answers 200 with the approval when the SCHEDULE_FAILED record itself cannot be written', async () => {
    const store = storeWith(transcript(), {
      upsertDoc: vi.fn(async () => {
        throw new Error('jobs container down');
      }),
      patchDoc: vi.fn(async (_c, id, updates) => {
        if (updates.host) throw new Error('cosmos down');
        return { id, ...updates };
      }),
    });
    const res = await review({ id: 'article_x', status: 'published' }, store);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ success: true, status: 'published' });
    expect(body.host.error.code).toBe('SCHEDULE_FAILED');
    expect(res.body).not.toContain('cosmos down');
    expect(store.patchDoc).toHaveBeenCalledTimes(2);
  });

  describe('ElevenLabs free-plan audio (owner decision 2026-09-26)', () => {
    const freePlan = (over = {}) =>
      transcript({ speechProvider: 'elevenlabs', speechTier: 'free', speechFreePlan: true, ...over });

    it('refuses approval with 409 naming the licence and the upgrade, and writes nothing', async () => {
      const store = storeWith(freePlan());
      const enqueue = vi.fn();
      const res = await review({ id: 'article_x', status: 'published' }, store, { enqueue });

      expect(res.status).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('FREE_PLAN_LICENCE');
      expect(body.error).toMatch(/rendered on the ElevenLabs free plan, which has no commercial licence/);
      expect(body.error).toMatch(/not published to Podbean/);
      expect(body.error).toMatch(/Upgrade to a paid ElevenLabs plan \(https:\/\/elevenlabs\.io\/pricing\)/);
      // No status write, no job, no queue message: the transcript stays a draft.
      expect(store.patchDoc).not.toHaveBeenCalled();
      expect(store.upsertDoc).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('refuses an ElevenLabs render whose plan was never recorded, the same way', async () => {
      const store = storeWith(freePlan({ speechTier: null, speechFreePlan: null }));
      const res = await review({ id: 'article_x', status: 'published' }, store);
      expect(res.status).toBe(409);
      expect(JSON.parse(res.body).error).toMatch(/on a plan that was not recorded/);
      expect(store.patchDoc).not.toHaveBeenCalled();
    });

    it('approves and publishes audio rendered on a paid plan as before', async () => {
      const store = storeWith(freePlan({ speechTier: 'creator', speechFreePlan: false }));
      const enqueue = vi.fn();
      const res = await review({ id: 'article_x', status: 'published' }, store, { enqueue });
      expect(res.status).toBe(202);
      expect(enqueue).toHaveBeenCalledWith({ jobId: 'job-1', type: PUBLISH_JOB_TYPE });
    });

    it('still lets a reviewer withdraw a free-plan transcript to draft', async () => {
      const store = storeWith(freePlan({ status: STATUS.published }));
      const res = await review({ id: 'article_x', status: 'draft' }, store);
      expect(res.status).toBe(200);
      expect(transcriptPatches(store)).toEqual([
        { status: 'draft', approvedAt: null, approvedBy: null },
      ]);
    });
  });

  it('returns a transcript to draft, clearing the stamp, and runs no host step', async () => {
    const store = storeWith(transcript({ status: STATUS.published }));
    const enqueue = vi.fn();
    const res = await review({ id: 'article_x', status: 'draft' }, store, { enqueue });
    expect(res.status).toBe(200);
    expect(transcriptPatches(store)).toEqual([
      { status: 'draft', approvedAt: null, approvedBy: null },
    ]);
    expect(JSON.parse(res.body).host).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('refuses "failed", which belongs to the generator, and any unknown status', async () => {
    const store = storeWith();
    const res = await review({ id: 'article_x', status: 'failed' }, store);
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/status must be "published" or "draft"/);
    expect((await review({ id: 'article_x', status: 'archived' })).status).toBe(400);
    expect(store.patchDoc).not.toHaveBeenCalled();
  });

  it('400s an id over Cosmos\'s 1,023-byte bound with the worker\'s sentence, before any store call', async () => {
    // Bytes, not characters: 400 three-byte characters is 1,200 bytes.
    for (const id of ['x'.repeat(1024), '語'.repeat(400)]) {
      const store = storeWith();
      const res = await review({ id, status: 'published' }, store);
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error).toBe('id is too long');
      expect(store.readDoc).not.toHaveBeenCalled();
      expect(store.patchDoc).not.toHaveBeenCalled();
    }
  });

  it('400s a missing id and a body that is not a JSON object; 404s an unknown transcript', async () => {
    expect((await review({ status: 'published' })).status).toBe(400);
    expect(
      (await handlers(makeStore()).reviewTranscript(makeRequest(), context, { enqueue: vi.fn() }))
        .status
    ).toBe(400);
    const store = storeWith();
    expect((await review({ id: 'ghost', status: 'published' }, store)).status).toBe(404);
    expect(store.patchDoc).not.toHaveBeenCalled();
  });

  it('500s a store failure rather than reporting a change that did not happen', async () => {
    const store = storeWith(transcript(), {
      patchDoc: vi.fn(async () => {
        throw new Error('cosmos down');
      }),
    });
    const res = await review({ id: 'article_x', status: 'published' }, store);
    expect(res.status).toBe(500);
    expect(res.body).not.toContain('cosmos down');
  });
});

describe('publishTranscript — the retry', () => {
  const storeWith = (doc, over = {}) =>
    makeStore({
      readDoc: vi.fn(async (container, id) =>
        container === TRANSCRIPT_CONTAINER && id === doc?.id ? doc : null
      ),
      ...over,
    });

  const retry = (store, { hostConfigured, enqueue = vi.fn(), id = 'article_x' } = {}) =>
    handlers(store, allowGuard, { hostConfigured }).publishTranscript(
      makeRequest({ params: { id } }),
      context,
      { enqueue }
    );

  it('refuses a draft with 409 and queues nothing — approval is what publishes', async () => {
    const store = storeWith(transcript({ status: STATUS.draft }));
    const enqueue = vi.fn();
    const res = await retry(store, { enqueue });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).error).toMatch(/is draft; approve it first/);
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(store.patchDoc).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('re-runs the host step for a published transcript that already has an episode, keeping its id under the pending marker', async () => {
    const previous = { episodeId: 'IWPNG2FB3F', fileKey: 'k', hostStatus: 'publish', error: null };
    const store = storeWith(
      transcript({ status: STATUS.published, host: { podbean: { ...previous, error: { code: 'TIMEOUT' } } } })
    );
    const enqueue = vi.fn();
    const res = await retry(store, { enqueue });

    expect(res.status).toBe(202);
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      id: 'article_x',
      jobId: 'job-1',
      type: PUBLISH_JOB_TYPE,
      status: 'queued',
      poll: 'getJob?jobId=job-1',
      host: { ...previous, error: { code: 'TIMEOUT' }, pending: true, jobId: 'job-1', queuedAt: NOW.toISOString() },
    });
    expect(store.upsertDoc).toHaveBeenCalledWith(
      JOBS_CONTAINER,
      expect.objectContaining({ type: PUBLISH_JOB_TYPE, payload: { transcriptId: 'article_x' } })
    );
    expect(enqueue).toHaveBeenCalledWith({ jobId: 'job-1', type: PUBLISH_JOB_TYPE });
    // The retry never touches the approval.
    for (const [, , patch] of store.patchDoc.mock.calls) {
      expect(Object.keys(patch)).toEqual(['host']);
    }
  });

  it('refuses a published transcript whose audio ElevenLabs rendered on the free plan, queuing nothing', async () => {
    const store = storeWith(
      transcript({
        status: STATUS.published,
        speechProvider: 'elevenlabs',
        speechTier: 'free',
        speechFreePlan: true,
      })
    );
    const enqueue = vi.fn();
    const res = await retry(store, { enqueue });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({
      code: 'FREE_PLAN_LICENCE',
      error: expect.stringMatching(/no commercial licence/),
    });
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(store.patchDoc).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('answers 200 with the skip when Podbean is not configured or the transcript has no audio', async () => {
    const enqueue = vi.fn();
    let res = await retry(storeWith(transcript({ status: STATUS.published })), {
      enqueue,
      hostConfigured: () => NOT_CONFIGURED,
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).host).toMatchObject({ skipped: 'not_configured' });

    res = await retry(storeWith(transcript({ status: STATUS.published, audioPath: null })), { enqueue });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).host).toMatchObject({ skipped: 'no_audio' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('409s while a publish job for the transcript is still in flight, naming it', async () => {
    const doc = transcript({ status: STATUS.published, host: { podbean: { pending: true, jobId: 'job-old' } } });
    const store = makeStore({
      readDoc: vi.fn(async (container, id) => {
        if (container === TRANSCRIPT_CONTAINER) return doc;
        if (container === JOBS_CONTAINER) return { id, status: 'running' };
        return null;
      }),
    });
    const enqueue = vi.fn();
    const res = await retry(store, { enqueue });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ jobId: 'job-old', poll: 'getJob?jobId=job-old' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('400s an id over Cosmos\'s 1,023-byte bound before reading, with the same sentence as review', async () => {
    for (const id of ['x'.repeat(1024), '語'.repeat(400)]) {
      const store = storeWith(null);
      const res = await retry(store, { id });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error).toBe('id is too long');
      expect(store.readDoc).not.toHaveBeenCalled();
    }
    // The detail route reads the same container by the same id: same rule.
    const detail = await handlers(makeStore()).getTranscript(
      makeRequest({ params: { id: '語'.repeat(400) } }),
      context
    );
    expect(detail.status).toBe(400);
    expect(JSON.parse(detail.body).error).toBe('id is too long');
  });

  it('404s an unknown id, 400s a missing one, 500s a store failure without leaking it', async () => {
    expect((await retry(storeWith(null))).status).toBe(404);
    expect((await retry(storeWith(null), { id: ' ' })).status).toBe(400);
    const res = await retry(
      makeStore({
        readDoc: vi.fn(async () => {
          throw new Error('cosmos down');
        }),
      })
    );
    expect(res.status).toBe(500);
    expect(res.body).not.toContain('cosmos down');
  });
});

describe('getHostOverview (#1115)', () => {
  const overviewRequest = (refresh) => ({
    params: {},
    query: new URLSearchParams(refresh === undefined ? '' : `refresh=${refresh}`),
    json: async () => {
      throw new SyntaxError('no body');
    },
  });

  it('is gated at editor and answers { configured: false, reason } without a call when Podbean is not set up', async () => {
    const store = makeStore();
    const client = makeHostClient();
    const h = handlers(store, editorOnlyGuard, {
      hostConfigured: () => NOT_CONFIGURED,
      hostClient: () => client,
    });
    const res = await h.getHostOverview(overviewRequest(), context);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      success: true,
      configured: false,
      reason: NOT_CONFIGURED.reason,
    });
    expect(client.getPodcast).not.toHaveBeenCalled();
    expect(client.listEpisodes).not.toHaveBeenCalled();
    expect(store.queryDocs).not.toHaveBeenCalled();
    expect(store.readDoc).not.toHaveBeenCalled();
  });

  it('answers the joined overview with configured: true, and serves the cache when it is fresh', async () => {
    const cached = {
      id: 'podbean_host_overview',
      configScope: 'admin_config',
      fetchedAt: new Date(NOW.getTime() - 60_000).toISOString(),
      days: 30,
      range: { start: '2026-08-10', end: '2026-09-08' },
      show: { id: 'p1', title: 'Cached', logo: null, website: null },
      episodes: [{ transcriptId: 'article_x', episodeId: 'E1', downloads: { total: 4, byDay: {} }, error: null }],
      downloadsCapped: 0,
      errors: {},
    };
    const store = makeStore({ readDoc: vi.fn(async () => cached) });
    const client = makeHostClient();
    const h = handlers(store, allowGuard, { hostClient: () => client });
    const body = JSON.parse((await h.getHostOverview(overviewRequest(), context)).body);
    expect(body).toMatchObject({ success: true, configured: true, cached: true, days: 30 });
    expect(body.episodes[0].downloads.total).toBe(4);
    expect(body).not.toHaveProperty('configScope');
    expect(client.listEpisodes).not.toHaveBeenCalled();
    expect(store.readDoc).toHaveBeenCalledWith('admin_config', 'podbean_host_overview', 'admin_config');
  });

  it('?refresh=1 reads Podbean live, joins the transcripts, and writes the cache', async () => {
    const stored = transcript({
      id: 'article_x',
      status: STATUS.published,
      host: { podbean: { episodeId: 'E1', permalinkUrl: 'https://podcast.example/e/x/' } },
    });
    const store = makeStore({ queryDocs: vi.fn(async () => [stored]) });
    const client = makeHostClient({
      listEpisodes: vi.fn(async () => ({
        episodes: [
          {
            id: 'E1',
            title: 'Live title',
            status: 'publish',
            permalink_url: 'https://podcast.example/e/live/',
            publish_time: Math.floor(NOW.getTime() / 1000),
          },
        ],
      })),
      getDownloadStats: vi.fn(async () => ({ '2026-09-07': 3 })),
    });
    const h = handlers(store, allowGuard, { hostClient: () => client });
    const res = await h.getHostOverview(overviewRequest('1'), context);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ success: true, configured: true, cached: false, fetchedAt: NOW.toISOString() });
    expect(body.episodes).toEqual([
      {
        transcriptId: 'article_x',
        episodeId: 'E1',
        title: 'Live title',
        hostStatus: 'publish',
        permalinkUrl: 'https://podcast.example/e/live/',
        publishTime: NOW.toISOString(),
        downloads: { total: 3, byDay: { '2026-09-07': 3 } },
        error: null,
      },
    ]);
    // Two reads: the refresh floor check, then the cache write's own freshness check (nothing stored, so an upsert follows).
    expect(store.readDoc).toHaveBeenCalledTimes(2);
    expect(store.upsertDoc).toHaveBeenCalledWith(
      'admin_config',
      expect.objectContaining({ id: 'podbean_host_overview', configScope: 'admin_config' })
    );
    // The log line carries counts, never the title.
    const logged = context.log.mock.calls.flat().join(' ');
    expect(logged).toContain('getPodcastHostOverview: live, 1 rows');
    expect(logged).not.toContain('Live title');
  });

  it('a Podbean failure is still a 200 with the error recorded, and a store failure is a content-free 500', async () => {
    const client = makeHostClient({
      listEpisodes: vi.fn(async () => {
        throw new Error('podbean down');
      }),
    });
    const ok = await handlers(makeStore(), allowGuard, { hostClient: () => client }).getHostOverview(
      overviewRequest(),
      context
    );
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).errors.episodes.code).toBe('UNEXPECTED');

    const broken = makeStore({
      queryDocs: vi.fn(async () => {
        throw Object.assign(new Error('Cosmos said: "Secret title"'), { code: 503 });
      }),
    });
    const failed = await handlers(broken, allowGuard, { hostClient: () => makeHostClient() }).getHostOverview(
      overviewRequest(),
      context
    );
    expect(failed.status).toBe(500);
    expect(JSON.parse(failed.body)).toEqual({ error: 'Failed to read the host overview' });
    expect(context.error).toHaveBeenCalledWith('getPodcastHostOverview failed: 503');
  });
});

describe('getHostStats (#1115)', () => {
  const statsRequest = (query = '') => ({
    params: {},
    query: new URLSearchParams(query),
    json: async () => {
      throw new SyntaxError('no body');
    },
  });

  it('refuses a range it does not offer with 400 before any read, and defaults to 30d', async () => {
    const store = makeStore();
    const client = makeHostClient();
    const h = handlers(store, allowGuard, { hostClient: () => client });
    const bad = await h.getHostStats(statsRequest('range=7d'), context);
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body)).toEqual({ error: 'range must be one of 30d, 90d, 12m' });
    expect(client.getDownloadStats).not.toHaveBeenCalled();
    expect(store.readDoc).not.toHaveBeenCalled();

    const body = JSON.parse((await h.getHostStats(statsRequest(), context)).body);
    expect(body.range).toBe('30d');
    expect(store.readDoc).toHaveBeenCalledWith('admin_config', 'podbean_host_stats_30d', 'admin_config');
  });

  it('answers { configured: false, range, reason } without a call when Podbean is not set up', async () => {
    const client = makeHostClient();
    const h = handlers(makeStore(), allowGuard, {
      hostConfigured: () => NOT_CONFIGURED,
      hostClient: () => client,
    });
    const res = await h.getHostStats(statsRequest('range=12m'), context);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      success: true,
      configured: false,
      range: '12m',
      reason: NOT_CONFIGURED.reason,
    });
    expect(client.getDownloadStats).not.toHaveBeenCalled();
  });

  it('reads the six statistics live on ?refresh=1, caches them per range, and logs codes only', async () => {
    const store = makeStore();
    const client = makeHostClient({
      getDownloadStats: vi.fn(async () => ({ '2026-09-07': 4, '2026-09-08': 1 })),
      getCountryStats: vi.fn(async () => {
        throw new Error('countries down');
      }),
    });
    const h = handlers(store, allowGuard, { hostClient: () => client });
    const res = await h.getHostStats(statsRequest('range=90d&refresh=1'), context);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      success: true,
      configured: true,
      cached: false,
      range: '90d',
      window: { period: 'd', end: '2026-09-08' },
      downloads: { total: 5 },
      countries: null,
      platforms: { iOS: 2 },
      sources: { Spotify: 1 },
      audience: { followers: 1, totalEpisodeLengthSeconds: 60 },
    });
    expect(body.errors.countries.code).toBe('UNEXPECTED');
    expect(store.readDoc).toHaveBeenCalledTimes(2); // the refresh floor check, then the cache write's own pre-read
    expect(store.upsertDoc).toHaveBeenCalledWith(
      'admin_config',
      expect.objectContaining({ id: 'podbean_host_stats_90d', configScope: 'admin_config', range: '90d' })
    );
    expect(context.log).toHaveBeenCalledWith('getPodcastHostStats: 90d live, countries errors');
  });

  it('a store failure is a content-free 500', async () => {
    const broken = makeStore({
      readDoc: vi.fn(async () => null),
      upsertDoc: vi.fn(async () => {
        throw Object.assign(new Error('upsert refused'), { code: 503 });
      }),
    });
    // The cache write failing is NOT a 500: it is logged and the live answer served.
    const h = handlers(broken, allowGuard, { hostClient: () => makeHostClient() });
    expect((await h.getHostStats(statsRequest(), context)).status).toBe(200);

    const hostClient = () => {
      throw Object.assign(new Error('no client'), { code: 'CLIENT_BUILD' });
    };
    const failed = await handlers(makeStore(), allowGuard, { hostClient }).getHostStats(statsRequest(), context);
    expect(failed.status).toBe(500);
    expect(JSON.parse(failed.body)).toEqual({ error: 'Failed to read the host statistics' });
    expect(context.error).toHaveBeenCalledWith('getPodcastHostStats failed: CLIENT_BUILD');
  });
});
