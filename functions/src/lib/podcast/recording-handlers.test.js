/**
 * Recording-side podcast routes.
 *
 * The load-bearing assertions: both routes are gated at editor, the Plaud
 * door refuses without a stored token (409, the Connect-tab sentence) and a
 * missing stored recording is a 404, the enqueue writes the same job
 * document `enqueueJob` does, and the upload route refuses an oversized,
 * non-audio or unconfigured request before anything is stored.
 */
import { describe, it, expect, vi } from 'vitest';
import { createPodcastRecordingHandlers } from './recording-handlers.js';
import { PLAUD_CONNECT_SENTENCE, RECORDING_JOB_TYPE } from './recording-generate.js';
import { MAX_TITLE_CHARS, UPLOAD_JOB_MAX_PAYLOAD_BYTES, UPLOAD_JOB_TYPE } from './recording-upload.js';
import { API_KEY_SETTING, CLIENT_ID_SETTING } from './plaud-embedded.js';
import { JOBS_CONTAINER, jobPayloadBytes } from '../jobs.js';

const NOW = new Date('2026-09-08T12:00:00.000Z');
const context = { log: vi.fn(), error: vi.fn() };
const USER = { oid: 'oid-1', email: 'editor@example.test' };
const allowGuard = { requireRole: vi.fn(async (_req, role) => ({ user: USER, role, error: null })) };
const denyGuard = {
  requireRole: vi.fn(async () => ({ user: null, role: null, error: { status: 403, body: '{}' } })),
};
const configured = { [CLIENT_ID_SETTING]: 'client-1', [API_KEY_SETTING]: 'key-1' };

const makeRequest = ({ body, headers = {} } = {}) => ({
  params: {},
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  json: async () => {
    if (body === undefined) throw new SyntaxError('no body');
    return body;
  },
});

const makeStore = (docs = {}) => ({
  docs,
  readDoc: vi.fn(async (container, id) => docs[container]?.[id] ?? null),
  upsertDoc: vi.fn(async (_c, doc) => doc),
});
const makeStorage = () => ({
  uploadBlob: vi.fn(async () => 'https://ignored'),
  deleteBlob: vi.fn(async () => {}),
});

const handlers = ({ store = makeStore(), storage = makeStorage(), guard = allowGuard, env = configured } = {}) =>
  createPodcastRecordingHandlers({
    guard,
    store,
    storage,
    env,
    now: () => NOW,
    uuid: () => '0d5c3d3e-1f5a-4a1c-9f6d-2b3c4d5e6f70',
  });

const audioBody = (over = {}) => ({
  title: 'Stand-up',
  fileName: 'standup.mp3',
  contentType: 'audio/mpeg',
  dataBase64: Buffer.from('not really audio').toString('base64'),
  ...over,
});

describe('auth', () => {
  it('both handlers pass a guard denial through with zero store or storage calls', async () => {
    const store = makeStore();
    const storage = makeStorage();
    const h = handlers({ store, storage, guard: denyGuard });
    const responses = await Promise.all([
      h.generateFromRecording(makeRequest({ body: { recordingId: 'rec-1' } }), context, { enqueue: vi.fn() }),
      h.uploadRecording(makeRequest({ body: audioBody() }), context, { enqueue: vi.fn() }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([403, 403]);
    expect(store.readDoc).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(storage.uploadBlob).not.toHaveBeenCalled();
    expect(allowGuard.requireRole).not.toHaveBeenCalledWith(expect.anything(), 'publisher');
  });
});

describe('generateFromRecording', () => {
  it('queues a Plaud recording when a token is stored, writing the job document enqueueJob writes', async () => {
    const store = makeStore({ mcp_servers: { plaud: { id: 'plaud', enabled: true, oauthToken: 'eyJ' } } });
    const enqueue = vi.fn();
    const res = await handlers({ store }).generateFromRecording(
      makeRequest({ body: { recordingId: ' rec-1 ' } }),
      context,
      { enqueue }
    );

    expect(res.status).toBe(202);
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      jobId: '0d5c3d3e-1f5a-4a1c-9f6d-2b3c4d5e6f70',
      type: RECORDING_JOB_TYPE,
      status: 'queued',
      poll: 'getJob?jobId=0d5c3d3e-1f5a-4a1c-9f6d-2b3c4d5e6f70',
      transcriptId: 'plaud_rec-1',
    });
    expect(store.upsertDoc).toHaveBeenCalledWith(JOBS_CONTAINER, {
      id: '0d5c3d3e-1f5a-4a1c-9f6d-2b3c4d5e6f70',
      type: RECORDING_JOB_TYPE,
      payload: { recordingId: 'rec-1' },
      status: 'queued',
      createdAt: NOW.toISOString(),
      startedAt: null,
      finishedAt: null,
      attempts: 0,
      requestedBy: { oid: 'oid-1', email: 'editor@example.test' },
      result: null,
      error: null,
    });
    expect(enqueue).toHaveBeenCalledWith({
      jobId: '0d5c3d3e-1f5a-4a1c-9f6d-2b3c4d5e6f70',
      type: RECORDING_JOB_TYPE,
    });
  });

  it('refuses at the door with the Connect-tab sentence when no token is stored', async () => {
    for (const mcp of [{}, { plaud: { id: 'plaud', enabled: true } }]) {
      const store = makeStore({ mcp_servers: mcp });
      const enqueue = vi.fn();
      const res = await handlers({ store }).generateFromRecording(
        makeRequest({ body: { recordingId: 'rec-1' } }),
        context,
        { enqueue }
      );
      expect(res.status).toBe(409);
      expect(JSON.parse(res.body).error).toBe(PLAUD_CONNECT_SENTENCE);
      expect(enqueue).not.toHaveBeenCalled();
      expect(store.upsertDoc).not.toHaveBeenCalled();
    }
  });

  it('queues a stored recording that exists, and 404s one that does not', async () => {
    const store = makeStore({ recordings: { u1: { id: 'u1', title: 'x' } } });
    const enqueue = vi.fn();
    const ok = await handlers({ store }).generateFromRecording(
      makeRequest({ body: { storedRecordingId: 'u1' } }),
      context,
      { enqueue }
    );
    expect(ok.status).toBe(202);
    expect(JSON.parse(ok.body).transcriptId).toBe('recording_u1');
    expect(store.upsertDoc.mock.calls[0][1].payload).toEqual({ storedRecordingId: 'u1' });
    // The Plaud door is not consulted for a stored recording.
    expect(store.readDoc).not.toHaveBeenCalledWith('mcp_servers', 'plaud', 'plaud');

    const missing = await handlers({ store }).generateFromRecording(
      makeRequest({ body: { storedRecordingId: 'nope' } }),
      context,
      { enqueue }
    );
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body).error).toBe('Recording nope was not found');
  });

  it('400s a bad body with the worker’s own sentence', async () => {
    const h = handlers();
    expect((await h.generateFromRecording(makeRequest(), context, { enqueue: vi.fn() })).status).toBe(400);
    const res = await h.generateFromRecording(
      makeRequest({ body: { recordingId: 'a', storedRecordingId: 'b' } }),
      context,
      { enqueue: vi.fn() }
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/not both/);
  });

  it('500s when no queue output is wired, after the door check, without a job document', async () => {
    const store = makeStore({ mcp_servers: { plaud: { oauthToken: 'eyJ' } } });
    const res = await handlers({ store }).generateFromRecording(
      makeRequest({ body: { recordingId: 'rec-1' } }),
      context
    );
    expect(res.status).toBe(500);
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });
});

describe('uploadRecording', () => {
  it('stores the audio under a minted path with overwrite:false and queues the transcription', async () => {
    const store = makeStore();
    const storage = makeStorage();
    const enqueue = vi.fn();
    const res = await handlers({ store, storage }).uploadRecording(
      makeRequest({ body: audioBody({ contentType: 'audio/mp3', fileName: 'Talk.MP3' }) }),
      context,
      { enqueue }
    );

    expect(res.status).toBe(202);
    const body = JSON.parse(res.body);
    expect(body).toEqual({
      ok: true,
      jobId: '0d5c3d3e-1f5a-4a1c-9f6d-2b3c4d5e6f70',
      type: UPLOAD_JOB_TYPE,
      status: 'queued',
      poll: 'getJob?jobId=0d5c3d3e-1f5a-4a1c-9f6d-2b3c4d5e6f70',
      uploadPath: 'uploads/0d5c3d3e-1f5a-4a1c-9f6d-2b3c4d5e6f70.mp3',
      audioUrl: '/api/public/media/podcast/uploads/0d5c3d3e-1f5a-4a1c-9f6d-2b3c4d5e6f70.mp3',
      bytes: 16,
    });
    expect(storage.uploadBlob).toHaveBeenCalledWith(
      'podcast',
      'uploads/0d5c3d3e-1f5a-4a1c-9f6d-2b3c4d5e6f70.mp3',
      expect.any(Buffer),
      'audio/mpeg',
      { source: 'recording-upload', uploadedBy: 'oid-1' },
      { overwrite: false }
    );
    expect(store.upsertDoc.mock.calls[0][1]).toMatchObject({
      type: UPLOAD_JOB_TYPE,
      payload: { uploadPath: 'uploads/0d5c3d3e-1f5a-4a1c-9f6d-2b3c4d5e6f70.mp3', title: 'Stand-up' },
    });
    expect(enqueue).toHaveBeenCalledWith({ jobId: '0d5c3d3e-1f5a-4a1c-9f6d-2b3c4d5e6f70', type: UPLOAD_JOB_TYPE });
  });

  it('503s with the configuration sentence before reading the body when Plaud Embedded is unset', async () => {
    const storage = makeStorage();
    const request = makeRequest({ body: audioBody() });
    request.json = vi.fn(request.json);
    const res = await handlers({ storage, env: {} }).uploadRecording(request, context, { enqueue: vi.fn() });
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).error).toMatch(/PLAUD_EMBEDDED_CLIENT_ID and PLAUD_EMBEDDED_API_KEY/);
    expect(request.json).not.toHaveBeenCalled();
    expect(storage.uploadBlob).not.toHaveBeenCalled();
  });

  it('413s an oversized request on Content-Length before the body is read', async () => {
    const request = makeRequest({ body: audioBody(), headers: { 'content-length': String(60 * 1024 * 1024) } });
    request.json = vi.fn(request.json);
    const res = await handlers().uploadRecording(request, context, { enqueue: vi.fn() });
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body).error).toBe('File exceeds the 40MB upload limit');
    expect(request.json).not.toHaveBeenCalled();
  });

  it('413s an oversized base64 string before decoding it', async () => {
    const storage = makeStorage();
    const res = await handlers({ storage }).uploadRecording(
      makeRequest({ body: audioBody({ dataBase64: 'A'.repeat(Math.ceil((40 * 1024 * 1024) / 3) * 4 + 4) }) }),
      context,
      { enqueue: vi.fn() }
    );
    expect(res.status).toBe(413);
    expect(storage.uploadBlob).not.toHaveBeenCalled();
  });

  it('413s a title that fits MAX_TITLE_CHARS but not the job’s payload bound, before storing anything (#942)', async () => {
    // 200 characters, each JSON-escaped to six bytes (\u0001): over the
    // upload job's 1024-byte bound once the blob path is added.
    const title = '\u0001'.repeat(MAX_TITLE_CHARS);
    expect(jobPayloadBytes({ uploadPath: 'uploads/x.mp3', title })).toBeGreaterThan(UPLOAD_JOB_MAX_PAYLOAD_BYTES);
    const store = makeStore();
    const storage = makeStorage();
    const enqueue = vi.fn();

    const res = await handlers({ store, storage }).uploadRecording(
      makeRequest({ body: audioBody({ title }) }),
      context,
      { enqueue }
    );

    expect(res.status).toBe(413);
    expect(JSON.parse(res.body).error).toBe(
      'The title is too long to queue with the upload; use a shorter title.'
    );
    expect(storage.uploadBlob).not.toHaveBeenCalled();
    expect(storage.deleteBlob).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('415s a non-audio type or a mismatched extension, 400s a missing title or body', async () => {
    const h = handlers();
    const at = (body) => h.uploadRecording(makeRequest({ body }), context, { enqueue: vi.fn() });
    expect((await at(audioBody({ contentType: 'text/html', fileName: 'x.html' }))).status).toBe(415);
    expect((await at(audioBody({ fileName: 'x.wav' }))).status).toBe(415);
    expect((await at(audioBody({ title: '  ' }))).status).toBe(400);
    expect((await at(audioBody({ dataBase64: '' }))).status).toBe(400);
    expect((await at(audioBody({ dataBase64: '!!!' }))).status).toBe(400);
    expect((await h.uploadRecording(makeRequest(), context, { enqueue: vi.fn() })).status).toBe(400);
  });

  describe('an upload whose job cannot be queued is deleted again', () => {
    const expectedPath = 'uploads/0d5c3d3e-1f5a-4a1c-9f6d-2b3c4d5e6f70.mp3';

    it('when the job document write throws: the blob is deleted and the 500 stands', async () => {
      const store = makeStore();
      store.upsertDoc = vi.fn(async () => {
        throw new Error('cosmos down');
      });
      const storage = makeStorage();
      const res = await handlers({ store, storage }).uploadRecording(
        makeRequest({ body: audioBody() }),
        context,
        { enqueue: vi.fn() }
      );
      expect(res.status).toBe(500);
      expect(JSON.parse(res.body).error).toBe('Failed to upload the recording');
      expect(storage.uploadBlob).toHaveBeenCalledTimes(1);
      expect(storage.deleteBlob).toHaveBeenCalledWith('podcast', expectedPath);
    });

    it('when the queue send throws, and when no queue output is wired', async () => {
      const throwing = makeStorage();
      const res = await handlers({ storage: throwing }).uploadRecording(
        makeRequest({ body: audioBody() }),
        context,
        {
          enqueue: () => {
            throw new Error('queue unavailable');
          },
        }
      );
      expect(res.status).toBe(500);
      expect(throwing.deleteBlob).toHaveBeenCalledWith('podcast', expectedPath);

      const unwired = makeStorage();
      const noQueue = await handlers({ storage: unwired }).uploadRecording(
        makeRequest({ body: audioBody() }),
        context
      );
      expect(noQueue.status).toBe(500);
      expect(JSON.parse(noQueue.body).error).toBe('Job queue is not configured');
      expect(unwired.deleteBlob).toHaveBeenCalledWith('podcast', expectedPath);
    });

    it('a delete that fails is logged content-free and does not mask the enqueue error', async () => {
      const store = makeStore();
      store.upsertDoc = vi.fn(async () => {
        throw new Error('cosmos down');
      });
      const storage = makeStorage();
      storage.deleteBlob = vi.fn(async () => {
        throw Object.assign(new Error('Server busy; secret-path-in-message'), { statusCode: 503 });
      });
      const ctx = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };
      const res = await handlers({ store, storage }).uploadRecording(
        makeRequest({ body: audioBody() }),
        ctx,
        { enqueue: vi.fn() }
      );
      expect(res.status).toBe(500);
      expect(JSON.parse(res.body).error).toBe('Failed to upload the recording');
      // The enqueue error is what reaches the error log — as a code and a
      // message, never the error object; the delete is a warning.
      expect(ctx.error).toHaveBeenCalledTimes(1);
      expect(ctx.error.mock.calls[0]).toHaveLength(1);
      expect(ctx.error.mock.calls[0][0]).toBe('uploadPodcastRecording failed (n/a): cosmos down');
      expect(ctx.warn).toHaveBeenCalledTimes(1);
      const line = ctx.warn.mock.calls[0][0];
      expect(line).toMatch(/upload blob not deleted after a failed enqueue \(503\)/);
      expect(line).not.toContain(expectedPath);
      expect(line).not.toContain('secret-path');
    });

    it('is not attempted on the success path', async () => {
      const storage = makeStorage();
      const res = await handlers({ storage }).uploadRecording(makeRequest({ body: audioBody() }), context, {
        enqueue: vi.fn(),
      });
      expect(res.status).toBe(202);
      expect(storage.deleteBlob).not.toHaveBeenCalled();
    });
  });

  it('names the Terraform apply when the blob container does not exist yet', async () => {
    const storage = {
      uploadBlob: vi.fn(async () => {
        throw Object.assign(new Error('The specified container does not exist.'), { statusCode: 404 });
      }),
    };
    const res = await handlers({ storage }).uploadRecording(makeRequest({ body: audioBody() }), context, {
      enqueue: vi.fn(),
    });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).error).toMatch(/"podcast" is not provisioned yet.*Terraform apply/);
  });
});
