/**
 * The host step around a podcast transcript (#437, slice 2).
 *
 * What is pinned: a skip is recorded as `skipped`, never `error`, and never
 * queues; a queue writes the job document enqueueJob would and marks the
 * transcript pending; the job re-runs the same step idempotently — update,
 * not create, when the document names an episode — and neither success nor
 * failure nor skip ever carries `status`, `approvedAt` or `approvedBy`.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  HOST_SKIP,
  MAX_TRANSCRIPT_ID_BYTES,
  PUBLISH_JOB_TYPE,
  audioReaderFor,
  hostSkipFor,
  parseTranscriptId,
  recordHostJobFailure,
  recordScheduleFailure,
  runHostPublish,
  scheduleHostPublish,
  stableHostRecord,
} from './publish-transcript.js';
import { PodbeanError } from './podbean.js';
import { PODCAST_AUDIO_CONTAINER, TRANSCRIPT_CONTAINER } from './store.js';
import { JOBS_CONTAINER } from '../jobs.js';

const NOW = new Date('2026-09-09T10:00:00.000Z');
const now = () => NOW;
const AT = NOW.toISOString();

const CONFIGURED = { ok: true };
const NOT_CONFIGURED = {
  ok: false,
  reason:
    'Podbean publishing is not configured: PODBEAN_CLIENT_SECRET (Key Vault secret PODBEAN-CLIENT-SECRET) is not set, so episodes stay on the manual upload path.',
};

const USER = { oid: 'oid-1', email: 'publisher@example.test' };

const doc = (over = {}) => ({
  id: 'article_picking-a-state-backend',
  sourceId: 'content-1',
  title: 'Picking a state backend',
  summary: 'Where Terraform state should live and why.',
  keyTakeaways: ['Remote', 'Locked'],
  audioPath: 'article/picking-a-state-backend.mp3',
  status: 'published',
  approvedAt: '2026-09-09T09:00:00.000Z',
  approvedBy: 'oid-1',
  host: null,
  ...over,
});

const makeStore = (over = {}) => ({
  readDoc: vi.fn(async () => null),
  upsertDoc: vi.fn(async (_c, d) => d),
  patchDoc: vi.fn(async (_c, id, updates) => ({ id, ...updates })),
  ...over,
});

const HOST_EPISODE = {
  id: 'IWPNG2FB3F',
  permalink_url: 'https://podcast.hybridcloudworks.com/e/picking-a-state-backend/',
  media_url: 'https://mcdn.podbean.com/mf/web/x/picking-a-state-backend.mp3',
  status: 'publish',
};

/** A client stub with the shape host-publish.js calls. */
const makeClient = (over = {}) => ({
  configured: CONFIGURED,
  authorizeUpload: vi.fn(async () => ({
    presigned_url: 'https://s3.amazonaws.com/b/tmp2/1/picking-a-state-backend.mp3?sig=1',
    file_key: 'tmp2/1/picking-a-state-backend.mp3',
  })),
  uploadMedia: vi.fn(async () => undefined),
  createEpisode: vi.fn(async () => ({ episode: HOST_EPISODE })),
  updateEpisode: vi.fn(async () => ({ episode: HOST_EPISODE })),
  ...over,
});

const readAudio = vi.fn(async () => ({ bytes: Buffer.from('mp3'), contentType: 'audio/mpeg' }));

/** The patch stored on the transcript, if any. */
const hostPatch = (store) => {
  const call = store.patchDoc.mock.calls.find(([c]) => c === TRANSCRIPT_CONTAINER);
  return call ? call[2] : null;
};

describe('parseTranscriptId', () => {
  it('names the field the caller asked for, so a route says "id" and the worker "transcriptId"', () => {
    expect(parseTranscriptId('', { field: 'id' }).error).toBe('id is required');
    expect(parseTranscriptId('x'.repeat(1024), { field: 'id' }).error).toBe('id is too long');
  });

  it('trims and accepts an id; refuses blank, non-string and oversized', () => {
    expect(parseTranscriptId(' article_x ')).toEqual({ value: 'article_x' });
    expect(parseTranscriptId(undefined).error).toBe('transcriptId is required');
    expect(parseTranscriptId('  ').error).toBe('transcriptId is required');
    expect(parseTranscriptId(42).error).toBe('transcriptId is required');
    expect(parseTranscriptId('x'.repeat(MAX_TRANSCRIPT_ID_BYTES)).value).toHaveLength(
      MAX_TRANSCRIPT_ID_BYTES
    );
    expect(parseTranscriptId('x'.repeat(MAX_TRANSCRIPT_ID_BYTES + 1)).error).toBe(
      'transcriptId is too long'
    );
  });

  it('bounds by UTF-8 bytes, as Cosmos does, not by characters', () => {
    // 400 characters, 1,200 bytes: under the limit as a string length, over
    // it as Cosmos measures it. A character count would let this through
    // and the write would fail later, with a worse message.
    const wide = '語'.repeat(400);
    expect(wide.length).toBeLessThan(MAX_TRANSCRIPT_ID_BYTES);
    expect(Buffer.byteLength(wide, 'utf8')).toBeGreaterThan(MAX_TRANSCRIPT_ID_BYTES);
    expect(parseTranscriptId(wide).error).toBe('transcriptId is too long');
  });
});

describe('stableHostRecord', () => {
  it('keeps what host-publish wrote and drops the transient keys', () => {
    expect(
      stableHostRecord({
        podbean: {
          episodeId: 'IWPNG2FB3F',
          fileKey: 'k',
          error: null,
          pending: true,
          jobId: 'job-1',
          queuedAt: AT,
          skipped: 'no_audio',
          reason: 'x',
        },
      })
    ).toEqual({ episodeId: 'IWPNG2FB3F', fileKey: 'k', error: null });
    expect(stableHostRecord(null)).toEqual({});
    expect(stableHostRecord({ podbean: 'junk' })).toEqual({});
  });
});

describe('hostSkipFor', () => {
  it('names configuration first, then audio, then nothing', () => {
    expect(hostSkipFor(doc({ audioPath: null }), NOT_CONFIGURED)).toEqual({
      skipped: HOST_SKIP.notConfigured,
      reason: NOT_CONFIGURED.reason,
    });
    const noAudio = hostSkipFor(doc({ audioPath: null, audioError: 'no speech key' }), CONFIGURED);
    expect(noAudio.skipped).toBe(HOST_SKIP.noAudio);
    expect(noAudio.reason).toMatch(/no audio \(no speech key\)/);
    expect(hostSkipFor(doc(), CONFIGURED)).toBeNull();
    // No configuration object at all is not "not configured".
    expect(hostSkipFor(doc(), undefined)).toBeNull();
  });

  it('skips ElevenLabs free-plan audio as free_plan_licence, naming the licence (2026-09-26)', () => {
    const free = doc({ speechProvider: 'elevenlabs', speechTier: 'free', speechFreePlan: true });
    const skip = hostSkipFor(free, CONFIGURED);
    expect(skip.skipped).toBe(HOST_SKIP.freePlanLicence);
    expect(HOST_SKIP.freePlanLicence).toBe('free_plan_licence');
    expect(skip.reason).toMatch(/no commercial licence/);
    expect(skip.reason).toMatch(/Upgrade to a paid ElevenLabs plan/);
    // Configuration and audio are still named first: they are the nearer fix.
    expect(hostSkipFor(free, NOT_CONFIGURED).skipped).toBe(HOST_SKIP.notConfigured);
    // A paid-plan render publishes as before.
    expect(
      hostSkipFor(doc({ speechProvider: 'elevenlabs', speechTier: 'creator', speechFreePlan: false }), CONFIGURED)
    ).toBeNull();
  });
});

describe('scheduleHostPublish', () => {
  it('writes the job enqueueJob would, marks the transcript pending, sends the message, answers queued', async () => {
    const store = makeStore();
    const enqueue = vi.fn();
    const out = await scheduleHostPublish({
      store,
      doc: doc(),
      configured: CONFIGURED,
      enqueue,
      requestedBy: USER,
      uuid: () => 'job-1',
      now,
    });

    expect(out).toEqual({
      outcome: 'queued',
      jobId: 'job-1',
      host: { pending: true, jobId: 'job-1', queuedAt: AT },
    });
    expect(store.upsertDoc).toHaveBeenCalledWith(JOBS_CONTAINER, {
      id: 'job-1',
      type: PUBLISH_JOB_TYPE,
      payload: { transcriptId: 'article_picking-a-state-backend' },
      status: 'queued',
      createdAt: AT,
      startedAt: null,
      finishedAt: null,
      attempts: 0,
      requestedBy: USER,
      result: null,
      error: null,
    });
    expect(store.patchDoc).toHaveBeenCalledWith(
      TRANSCRIPT_CONTAINER,
      'article_picking-a-state-backend',
      { host: { podbean: { pending: true, jobId: 'job-1', queuedAt: AT } } },
      { partitionKey: 'article_picking-a-state-backend' }
    );
    expect(enqueue).toHaveBeenCalledWith({ jobId: 'job-1', type: PUBLISH_JOB_TYPE });
    // The job document is written before the marker names it.
    expect(store.upsertDoc.mock.invocationCallOrder[0]).toBeLessThan(
      store.patchDoc.mock.invocationCallOrder[0]
    );
  });

  it('keeps the stable host record under the pending marker, so the hub still shows the episode', async () => {
    const store = makeStore();
    const previous = { episodeId: 'IWPNG2FB3F', fileKey: 'k', hostStatus: 'published', error: null };
    const out = await scheduleHostPublish({
      store,
      doc: doc({ host: { podbean: { ...previous, skipped: 'no_audio', reason: 'old' } } }),
      configured: CONFIGURED,
      enqueue: vi.fn(),
      uuid: () => 'job-2',
      now,
    });
    expect(out.host).toEqual({ ...previous, pending: true, jobId: 'job-2', queuedAt: AT });
  });

  it('records not_configured as a skip — not an error — and queues nothing', async () => {
    const store = makeStore();
    const enqueue = vi.fn();
    const out = await scheduleHostPublish({
      store,
      doc: doc(),
      configured: NOT_CONFIGURED,
      enqueue,
      now,
    });

    expect(out.outcome).toBe('skipped');
    expect(out.host).toEqual({
      skipped: 'not_configured',
      reason: NOT_CONFIGURED.reason,
      lastAttemptAt: AT,
      error: null,
    });
    expect(hostPatch(store)).toEqual({ host: { podbean: out.host } });
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('records no_audio when the transcript has no audioPath and uploads nothing', async () => {
    const store = makeStore();
    const enqueue = vi.fn();
    const out = await scheduleHostPublish({
      store,
      doc: doc({ audioPath: null, audioError: 'ElevenLabs answered 401' }),
      configured: CONFIGURED,
      enqueue,
      now,
    });
    expect(out.outcome).toBe('skipped');
    expect(out.host.skipped).toBe('no_audio');
    expect(out.host.reason).toMatch(/ElevenLabs answered 401/);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('never writes status, approvedAt or approvedBy', async () => {
    for (const configured of [CONFIGURED, NOT_CONFIGURED]) {
      const store = makeStore();
      await scheduleHostPublish({ store, doc: doc(), configured, enqueue: vi.fn(), now });
      const patch = hostPatch(store);
      expect(Object.keys(patch)).toEqual(['host']);
    }
  });

  it('refuses to double-queue while the job it names is still queued or running', async () => {
    const store = makeStore({
      readDoc: vi.fn(async (c, id) => (c === JOBS_CONTAINER ? { id, status: 'running' } : null)),
    });
    const enqueue = vi.fn();
    const pending = { pending: true, jobId: 'job-old', queuedAt: AT };
    const out = await scheduleHostPublish({
      store,
      doc: doc({ host: { podbean: pending } }),
      configured: CONFIGURED,
      enqueue,
      now,
    });
    expect(out).toEqual({ outcome: 'in_flight', jobId: 'job-old', host: pending });
    expect(store.readDoc).toHaveBeenCalledWith(JOBS_CONTAINER, 'job-old', 'job-old');
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('treats a pending marker whose job is finished or gone as stale and queues again', async () => {
    for (const job of [null, { id: 'job-old', status: 'timeout' }]) {
      const store = makeStore({ readDoc: vi.fn(async () => job) });
      const enqueue = vi.fn();
      const out = await scheduleHostPublish({
        store,
        doc: doc({ host: { podbean: { pending: true, jobId: 'job-old' } } }),
        configured: CONFIGURED,
        enqueue,
        uuid: () => 'job-new',
        now,
      });
      expect(out.outcome).toBe('queued');
      expect(enqueue).toHaveBeenCalledWith({ jobId: 'job-new', type: PUBLISH_JOB_TYPE });
    }
  });

  it('throws when no queue output is wired, before writing a job nothing will run', async () => {
    const store = makeStore();
    await expect(
      scheduleHostPublish({ store, doc: doc(), configured: CONFIGURED, now })
    ).rejects.toThrow(/no queue output wired/);
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(store.patchDoc).not.toHaveBeenCalled();
  });
});

describe('audioReaderFor', () => {
  it('reads from the podcast container and hands the step bytes plus content type', async () => {
    const readBlob = vi.fn(async () => ({ body: Buffer.from('abc'), contentType: 'audio/mpeg' }));
    const read = audioReaderFor(readBlob);
    expect(await read('article/x.mp3')).toEqual({ bytes: Buffer.from('abc'), contentType: 'audio/mpeg' });
    expect(readBlob).toHaveBeenCalledWith(PODCAST_AUDIO_CONTAINER, 'article/x.mp3');
  });

  it('falls back to audio/mpeg for an untyped blob and passes a missing blob through as null', async () => {
    const read = audioReaderFor(async () => ({
      body: Buffer.from('abc'),
      contentType: 'application/octet-stream',
    }));
    expect((await read('x')).contentType).toBe('audio/mpeg');
    expect(await audioReaderFor(async () => null)('x')).toBeNull();
  });
});

describe('runHostPublish', () => {
  const run = (store, client, extra = {}) =>
    runHostPublish({
      store,
      id: 'article_picking-a-state-backend',
      client,
      readAudio,
      now,
      ...extra,
    });

  it('creates the episode on first publish and stores the record with episodeId', async () => {
    const stored = doc({ host: { podbean: { pending: true, jobId: 'job-1', queuedAt: AT } } });
    const store = makeStore({ readDoc: vi.fn(async () => stored) });
    const client = makeClient();

    const record = await run(store, client, {
      resolvePublicUrl: async () => 'https://hybridcloudworks.com/blog/picking-a-state-backend',
    });

    expect(client.createEpisode).toHaveBeenCalledTimes(1);
    expect(client.updateEpisode).not.toHaveBeenCalled();
    expect(client.createEpisode.mock.calls[0][0]).toMatchObject({
      title: 'Picking a state backend',
      media_key: 'tmp2/1/picking-a-state-backend.mp3',
      status: 'publish',
      type: 'public',
      content: expect.stringContaining(
        '<a href="https://hybridcloudworks.com/blog/picking-a-state-backend">'
      ),
    });
    expect(client.authorizeUpload).toHaveBeenCalledWith({
      filename: 'picking-a-state-backend.mp3',
      filesize: 3,
      contentType: 'audio/mpeg',
    });
    expect(client.uploadMedia).toHaveBeenCalledWith(
      'https://s3.amazonaws.com/b/tmp2/1/picking-a-state-backend.mp3?sig=1',
      Buffer.from('mp3'),
      'audio/mpeg'
    );
    expect(record).toEqual({
      episodeId: 'IWPNG2FB3F',
      permalinkUrl: HOST_EPISODE.permalink_url,
      mediaUrl: HOST_EPISODE.media_url,
      hostStatus: 'publish',
      audioPath: 'article/picking-a-state-backend.mp3',
      fileKey: 'tmp2/1/picking-a-state-backend.mp3',
      publishedAt: AT,
      lastAttemptAt: AT,
      error: null,
    });
    // The transient marker is gone from what was stored, and only `host` was written.
    expect(hostPatch(store)).toEqual({ host: { podbean: record } });
    expect(record).not.toHaveProperty('pending');
  });

  it('adds no article link when the article has no public URL', async () => {
    const store = makeStore({ readDoc: vi.fn(async () => doc()) });
    const client = makeClient();
    await run(store, client, { resolvePublicUrl: async () => '' });
    expect(client.createEpisode.mock.calls[0][0].content).not.toContain('<a ');
  });

  it('updates — never creates — when the document already names a Podbean episode', async () => {
    const previous = {
      episodeId: 'IWPNG2FB3F',
      permalinkUrl: 'https://podcast.hybridcloudworks.com/e/picking-a-state-backend/',
      hostStatus: 'publish',
      audioPath: 'article/picking-a-state-backend.mp3',
      fileKey: 'tmp2/1/picking-a-state-backend.mp3',
      publishedAt: '2026-09-01T00:00:00.000Z',
      lastAttemptAt: '2026-09-01T00:00:00.000Z',
      error: { status: 500, code: 'UPSTREAM', message: 'boom', retryable: true },
    };
    const store = makeStore({
      readDoc: vi.fn(async () => doc({ host: { podbean: { ...previous, pending: true, jobId: 'j' } } })),
    });
    const client = makeClient();

    const record = await run(store, client);

    expect(client.createEpisode).not.toHaveBeenCalled();
    expect(client.updateEpisode).toHaveBeenCalledWith('IWPNG2FB3F', expect.objectContaining({ title: 'Picking a state backend' }));
    // Same audio path → no re-upload.
    expect(client.authorizeUpload).not.toHaveBeenCalled();
    expect(record).toMatchObject({ episodeId: 'IWPNG2FB3F', publishedAt: previous.publishedAt, error: null });
    expect(record).not.toHaveProperty('pending');
    expect(record).not.toHaveProperty('jobId');
  });

  it('records a host failure under host.podbean.error and leaves the approval alone', async () => {
    const stored = doc({ host: { podbean: { pending: true, jobId: 'job-1' } } });
    const store = makeStore({ readDoc: vi.fn(async () => stored) });
    const client = makeClient({
      createEpisode: vi.fn(async () => {
        throw new PodbeanError('Podbean answered 502 while creating the episode.', {
          status: 502,
          code: 'UPSTREAM',
          retryable: true,
        });
      }),
    });

    const record = await run(store, client);

    expect(record.error).toEqual({
      status: 502,
      code: 'UPSTREAM',
      message: 'Podbean answered 502 while creating the episode.',
      retryable: true,
    });
    expect(record.pending).toBeUndefined();
    const patch = hostPatch(store);
    expect(Object.keys(patch)).toEqual(['host']);
    expect(patch.host.podbean).not.toHaveProperty('status');
    expect(patch.host.podbean).not.toHaveProperty('approvedAt');
  });

  it('skips a transcript withdrawn to draft between enqueue and run, without a network call', async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => doc({ status: 'draft', host: { podbean: { pending: true, jobId: 'j' } } })),
    });
    const client = makeClient();
    const untouched = vi.fn();
    const record = await run(store, client, { readAudio: untouched });
    expect(record).toEqual({
      skipped: 'not_published',
      reason: expect.stringMatching(/is draft/),
      lastAttemptAt: AT,
      error: null,
    });
    expect(client.createEpisode).not.toHaveBeenCalled();
    expect(untouched).not.toHaveBeenCalled();
  });

  it('skips not_configured and no_audio in the job too, so a key removed after enqueue is not an error', async () => {
    const notConfigured = makeClient({ configured: NOT_CONFIGURED });
    let store = makeStore({ readDoc: vi.fn(async () => doc()) });
    expect((await run(store, notConfigured)).skipped).toBe('not_configured');
    expect(notConfigured.createEpisode).not.toHaveBeenCalled();

    const client = makeClient();
    store = makeStore({ readDoc: vi.fn(async () => doc({ audioPath: null })) });
    expect((await run(store, client)).skipped).toBe('no_audio');
    expect(client.authorizeUpload).not.toHaveBeenCalled();
  });

  it('never uploads ElevenLabs free-plan audio, even for a transcript that is published', async () => {
    // Approval refuses these (handlers.js); the job is the second guard, for
    // a document that became published some other way.
    const store = makeStore({
      readDoc: vi.fn(async () =>
        doc({
          speechProvider: 'elevenlabs',
          speechTier: 'free',
          speechFreePlan: true,
          host: { podbean: { pending: true, jobId: 'j' } },
        })
      ),
    });
    const client = makeClient();
    const untouched = vi.fn();
    const record = await run(store, client, { readAudio: untouched });
    expect(record).toEqual({
      skipped: 'free_plan_licence',
      reason: expect.stringMatching(/rendered on the ElevenLabs free plan/),
      lastAttemptAt: AT,
      error: null,
    });
    expect(untouched).not.toHaveBeenCalled();
    expect(client.authorizeUpload).not.toHaveBeenCalled();
    expect(client.createEpisode).not.toHaveBeenCalled();
    expect(Object.keys(hostPatch(store))).toEqual(['host']);
  });

  it('publishes ElevenLabs audio rendered on a paid plan exactly as before', async () => {
    const store = makeStore({
      readDoc: vi.fn(async () =>
        doc({ speechProvider: 'elevenlabs', speechTier: 'creator', speechFreePlan: false })
      ),
    });
    const client = makeClient();
    const record = await run(store, client);
    expect(client.createEpisode).toHaveBeenCalledTimes(1);
    expect(record).toMatchObject({ episodeId: 'IWPNG2FB3F', error: null });
  });

  it('throws when the transcript does not exist — there is nothing to record on — without naming it', async () => {
    // runJob logs and stores the message; the id travels on a property.
    const error = await run(makeStore(), makeClient()).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('podcast transcript not found');
    expect(error.message).not.toContain('article_picking-a-state-backend');
    expect(error.code).toBe('TRANSCRIPT_NOT_FOUND');
    expect(error.transcriptId).toBe('article_picking-a-state-backend');
  });
});

describe('recordScheduleFailure', () => {
  it('stores a terminal, retryable SCHEDULE_FAILED record over the stable host fields, touching nothing else', async () => {
    const store = makeStore();
    const stable = { episodeId: 'IWPNG2FB3F', fileKey: 'k', audioPath: 'a.mp3', publishedAt: '2026-09-01T00:00:00.000Z' };
    const ok = await recordScheduleFailure({
      store,
      doc: doc({ host: { podbean: { ...stable, pending: true, jobId: 'stale' } } }),
      now,
    });
    expect(ok).toBe(true);
    const patch = hostPatch(store);
    expect(Object.keys(patch)).toEqual(['host']);
    expect(patch.host.podbean).toEqual({
      ...stable,
      lastAttemptAt: AT,
      error: {
        status: null,
        code: 'SCHEDULE_FAILED',
        message: expect.stringMatching(/use Publish to retry/),
        retryable: true,
      },
    });
    expect(patch.host.podbean).not.toHaveProperty('pending');
  });

  it('never throws — a failed write answers false', async () => {
    const store = makeStore({
      patchDoc: vi.fn(async () => {
        throw new Error('cosmos down');
      }),
    });
    await expect(recordScheduleFailure({ store, doc: doc(), now })).resolves.toBe(false);
  });
});

describe('recordHostJobFailure', () => {
  const failure = (store, status = 'timeout') =>
    recordHostJobFailure({
      store,
      id: 'article_x',
      status,
      error: status === 'timeout' ? 'job timed out' : 'cosmos down',
      now,
    });

  it('clears a pending marker the job left behind and records a retryable error on a published transcript', async () => {
    const store = makeStore({
      readDoc: vi.fn(async () => ({
        id: 'article_x',
        status: 'published',
        host: { podbean: { episodeId: 'IWPNG2FB3F', pending: true, jobId: 'j' } },
      })),
    });
    expect(await failure(store)).toBe(true);
    expect(hostPatch(store)).toEqual({
      host: {
        podbean: {
          episodeId: 'IWPNG2FB3F',
          lastAttemptAt: AT,
          error: { status: null, code: 'JOB_TIMEOUT', message: 'job timed out', retryable: true },
        },
      },
    });
    const failed = makeStore({
      readDoc: vi.fn(async () => ({
        id: 'article_x',
        status: 'published',
        host: { podbean: { pending: true } },
      })),
    });
    await failure(failed, 'failed');
    expect(hostPatch(failed).host.podbean.error.code).toBe('JOB_FAILED');
  });

  it('records not_published — not a publish error — when the transcript was returned to draft meanwhile', async () => {
    // A draft showing "publish failed" with a retry the retry route refuses
    // is the wrong record; the worker would have written this skip itself.
    for (const status of ['draft', undefined]) {
      const store = makeStore({
        readDoc: vi.fn(async () => ({
          id: 'article_x',
          status,
          host: { podbean: { episodeId: 'IWPNG2FB3F', pending: true, jobId: 'j' } },
        })),
      });
      expect(await failure(store)).toBe(true);
      expect(hostPatch(store)).toEqual({
        host: {
          podbean: {
            episodeId: 'IWPNG2FB3F',
            skipped: 'not_published',
            reason: expect.stringMatching(new RegExp(`is ${status || 'not published'}`)),
            lastAttemptAt: AT,
            error: null,
          },
        },
      });
    }
  });

  it('does not overwrite an outcome the worker stored before the timer fired, nor touch a missing document', async () => {
    const settled = makeStore({
      readDoc: vi.fn(async () => ({ id: 'article_x', host: { podbean: { episodeId: 'IWPNG2FB3F', error: null } } })),
    });
    expect(await failure(settled)).toBe(false);
    expect(settled.patchDoc).not.toHaveBeenCalled();

    const missing = makeStore();
    expect(await failure(missing)).toBe(false);
    expect(missing.patchDoc).not.toHaveBeenCalled();
  });
});
