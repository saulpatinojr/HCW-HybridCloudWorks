/**
 * The four routes that start interview work (ADR 0040): the guard first,
 * 404 for a document that is not an interview, 400 for a bad URL or an
 * empty transcript, 422 for a step whose input is missing, 409 while the
 * same job is still queued or running, and a 202 that writes the job
 * document, sends the queue message and marks the interview's stage.
 */
import { describe, it, expect, vi } from 'vitest';
import { createInterviewJobHandlers, readInterviewId, recordingInUse } from './enqueue.js';

const user = { oid: '00000000-0000-0000-0000-000000000001', email: 'editor@example.test' };
const guard = { requireRole: vi.fn(async () => ({ user, role: 'editor', error: null })) };
const refusing = { requireRole: vi.fn(async () => ({ error: { status: 403, body: '{"error":"Requires editor or higher"}' } })) };
const context = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
const request = (id, body = {}) => ({ method: 'POST', params: { id }, json: async () => body, headers: { get: () => null } });
const parse = (res) => ({ status: res.status, body: JSON.parse(res.body) });

function makeDeps({ doc, jobs = {} } = {}) {
  const docs = { 'int-1': doc ?? { id: 'int-1', type: 'interview', interview: { stage: 'uploading' }, provenance: { audio: { path: 'audio/int-1.mp3' } } }, ...jobs };
  const store = {
    readDoc: vi.fn(async (container, id) => docs[id] ?? null),
    upsertDoc: vi.fn(async (container, document) => document),
    patchDoc: vi.fn(async () => ({})),
  };
  const storage = { uploadBlob: vi.fn(async () => 'url'), readBlobRangeForDelivery: vi.fn(async () => null) };
  const io = { enqueue: vi.fn() };
  const handlers = createInterviewJobHandlers({ guard, store, storage, uuid: () => 'job-new', now: () => new Date('2026-11-05T10:00:00Z') });
  return { store, storage, io, handlers };
}

describe('readInterviewId', () => {
  it('accepts an id this site mints and nothing else', () => {
    expect(readInterviewId({ params: { id: 'int-1' } })).toBe('int-1');
    expect(readInterviewId({ params: { id: '../x' } })).toBe('');
    expect(readInterviewId({ params: {} })).toBe('');
    expect(readInterviewId({})).toBe('');
  });
});

describe('every route', () => {
  it('answers the guard’s refusal before reading anything, and 500 without a queue output', async () => {
    const { store } = makeDeps();
    const handlers = createInterviewJobHandlers({ guard: refusing, store, storage: { uploadBlob: vi.fn() } });
    for (const name of ['audioFromUrl', 'transcribe', 'draft', 'transcript']) {
      const res = await handlers[name](request('int-1', { url: 'https://a.example/x.mp3', text: 'Speaker 1: hi' }), context, { enqueue: vi.fn() });
      expect(res.status, name).toBe(403);
    }
    expect(store.readDoc).not.toHaveBeenCalled();
    const { handlers: wired } = makeDeps({ doc: { id: 'int-1', type: 'interview', provenance: { audio: { path: 'a' } }, transcription: { version: 1, status: 'done' } } });
    for (const name of ['audioFromUrl', 'transcribe', 'draft']) {
      expect(parse(await wired[name](request('int-1', { url: 'https://a.example/x.mp3' }), context, {})), name).toEqual({ status: 500, body: { ok: false, error: 'Job queue is not configured' } });
    }
    // The transcript route queues nothing, so it needs no output.
    expect(parse(await wired.transcript(request('int-1', { text: 'Speaker 1: hi' }), context, {})).status).toBe(200);
  });

  it('answers 400 for an invalid route id and 404 for a document that is not an interview', async () => {
    const { handlers, io } = makeDeps({ jobs: { 'blog-1': { id: 'blog-1', type: 'blog' } } });
    expect(parse(await handlers.transcribe(request('../etc'), context, io)).status).toBe(400);
    expect(parse(await handlers.transcribe(request('missing'), context, io)).status).toBe(404);
    expect(parse(await handlers.draft(request('blog-1'), context, io)).status).toBe(404);
    expect(io.enqueue).not.toHaveBeenCalled();
  });

  it('answers a thrown authored 4xx with its sentence and anything else with a fixed 500, logged content-free', async () => {
    const { handlers, io, store } = makeDeps();
    store.upsertDoc = vi.fn(async () => {
      throw Object.assign(new Error('Cosmos said: secret path /dbs/x'), { code: 503 });
    });
    const res = parse(await handlers.transcribe(request('int-1'), context, io));
    expect(res).toEqual({ status: 500, body: { ok: false, error: 'Could not transcribe the interview.' } });
    expect(JSON.stringify(context.error.mock.calls)).not.toContain('secret path');
  });
});

describe('POST cms/interviews/{id}/audio-from-url', () => {
  it('queues interview-fetch-audio with the URL in the payload, marks the stage, and never logs the URL', async () => {
    const { handlers, io, store } = makeDeps();
    const res = parse(await handlers.audioFromUrl(request('int-1', { url: 'https://files.example/guest.mp3' }), context, io));
    expect(res).toEqual({ status: 202, body: { ok: true, jobId: 'job-new', type: 'interview-fetch-audio', status: 'queued', poll: 'getJob?jobId=job-new' } });
    expect(store.upsertDoc).toHaveBeenCalledWith('jobs', expect.objectContaining({ id: 'job-new', type: 'interview-fetch-audio', payload: { interviewId: 'int-1', sourceUrl: 'https://files.example/guest.mp3' }, requestedBy: user, status: 'queued' }));
    expect(io.enqueue).toHaveBeenCalledWith({ jobId: 'job-new', type: 'interview-fetch-audio' });
    expect(store.patchDoc).toHaveBeenCalledWith('content', 'int-1', { interview: { stage: 'fetching', error: null, fetchJobId: 'job-new' } });
    expect(JSON.stringify([...context.log.mock.calls, ...context.warn.mock.calls])).not.toContain('files.example');
  });

  it('refuses a bad URL with 400 and a download still running with 409', async () => {
    const { handlers, io } = makeDeps();
    expect(parse(await handlers.audioFromUrl(request('int-1', { url: 'http://files.example/guest.mp3' }), context, io))).toEqual({ status: 400, body: { ok: false, error: 'Only an https:// URL is fetched.' } });
    expect(parse(await handlers.audioFromUrl(request('int-1', {}), context, io)).status).toBe(400);
    const busy = makeDeps({
      doc: { id: 'int-1', type: 'interview', interview: { stage: 'fetching', fetchJobId: 'job-old' } },
      jobs: { 'job-old': { id: 'job-old', status: 'running' } },
    });
    expect(parse(await busy.handlers.audioFromUrl(request('int-1', { url: 'https://files.example/guest.mp3' }), context, busy.io)).status).toBe(409);
    expect(busy.io.enqueue).not.toHaveBeenCalled();
    // A finished job does not block the next download.
    const done = makeDeps({
      doc: { id: 'int-1', type: 'interview', interview: { fetchJobId: 'job-old' } },
      jobs: { 'job-old': { id: 'job-old', status: 'failed' } },
    });
    expect(parse(await done.handlers.audioFromUrl(request('int-1', { url: 'https://files.example/guest.mp3' }), context, done.io)).status).toBe(202);
  });
});

describe('POST cms/interviews/{id}/transcribe', () => {
  it('queues the next transcript version and records it on the document', async () => {
    const { handlers, io, store } = makeDeps({ doc: { id: 'int-1', type: 'interview', provenance: { audio: { path: 'audio/int-1.mp3' } }, transcription: { version: 2, jobId: 'job-old', status: 'done' }, interview: { stage: 'ready' } }, jobs: { 'job-old': { id: 'job-old', status: 'succeeded' } } });
    const res = parse(await handlers.transcribe(request('int-1'), context, io));
    expect(res).toMatchObject({ status: 202, body: { ok: true, jobId: 'job-new', type: 'interview-transcribe', transcriptVersion: 3 } });
    expect(store.upsertDoc.mock.calls[0][1].payload).toEqual({ interviewId: 'int-1', transcriptVersion: 3 });
    expect(store.patchDoc).toHaveBeenCalledWith('content', 'int-1', {
      transcription: { version: 3, jobId: 'job-new', status: 'queued' },
      interview: { stage: 'transcribing', error: null },
    });
  });

  it('reads the recording’s length once from its headers, stores it, and refuses one over 9.5 hours with TOO_LONG before queuing', async () => {
    // A wav header: 16 kHz mono 16-bit (32,000 bytes a second) and a data chunk of 9.5 hours plus one second.
    const wav = (seconds) => {
      const head = Buffer.alloc(44);
      head.write('RIFF', 0, 'latin1');
      head.write('WAVE', 8, 'latin1');
      head.write('fmt ', 12, 'latin1');
      head.writeUInt32LE(16, 16);
      head.writeUInt32LE(32000, 28);
      head.write('data', 36, 'latin1');
      head.writeUInt32LE(seconds * 32000, 40);
      return head;
    };
    const tooLong = makeDeps({ doc: { id: 'int-1', type: 'interview', provenance: { audio: { container: 'interviews-audio', path: 'audio/int-1.wav', contentType: 'audio/wav', bytes: 1 } } } });
    tooLong.storage.readBlobRangeForDelivery = vi.fn(async () => ({ body: wav(9.5 * 3600 + 1) }));
    const refused = parse(await tooLong.handlers.transcribe(request('int-1'), context, tooLong.io));
    expect(refused).toMatchObject({ status: 422, body: { code: 'TOO_LONG', error: expect.stringMatching(/570 minutes long; Gemini takes at most 9.5 hours/) } });
    expect(tooLong.io.enqueue).not.toHaveBeenCalled();
    expect(tooLong.store.patchDoc).toHaveBeenCalledWith('content', 'int-1', { provenance: { audio: expect.objectContaining({ durationSec: 9.5 * 3600 + 1 }) } });
    // Exactly 9.5 hours is taken.
    const exact = makeDeps({ doc: { id: 'int-1', type: 'interview', provenance: { audio: { container: 'interviews-audio', path: 'audio/int-1.wav', contentType: 'audio/wav', bytes: 1 } } } });
    exact.storage.readBlobRangeForDelivery = vi.fn(async () => ({ body: wav(9.5 * 3600) }));
    expect(parse(await exact.handlers.transcribe(request('int-1'), context, exact.io)).status).toBe(202);
    // A stored length is not read again; a stored length over the cap is refused without a read.
    const stored = makeDeps({ doc: { id: 'int-1', type: 'interview', provenance: { audio: { path: 'audio/int-1.mp3', contentType: 'audio/mpeg', bytes: 1, durationSec: 40_000 } } } });
    expect(parse(await stored.handlers.transcribe(request('int-1'), context, stored.io)).status).toBe(422);
    expect(stored.storage.readBlobRangeForDelivery).not.toHaveBeenCalled();
    // Headers that cannot be read store null and let the job's estimate decide.
    const unknown = makeDeps({ doc: { id: 'int-1', type: 'interview', provenance: { audio: { path: 'audio/int-1.mp3', contentType: 'audio/mpeg', bytes: 10 } } } });
    unknown.storage.readBlobRangeForDelivery = vi.fn(async () => ({ body: Buffer.from('not audio') }));
    expect(parse(await unknown.handlers.transcribe(request('int-1'), context, unknown.io)).status).toBe(202);
    expect(unknown.store.patchDoc.mock.calls[0][2].provenance.audio.durationSec).toBeNull();
  });

  it('starts at version 1, refuses 422 without a recording and 409 while the current version is being made', async () => {
    const first = makeDeps();
    expect(parse(await first.handlers.transcribe(request('int-1'), context, first.io)).body.transcriptVersion).toBe(1);
    const noAudio = makeDeps({ doc: { id: 'int-1', type: 'interview' } });
    expect(parse(await noAudio.handlers.transcribe(request('int-1'), context, noAudio.io))).toMatchObject({ status: 422 });
    const busy = makeDeps({
      doc: { id: 'int-1', type: 'interview', provenance: { audio: { path: 'a' } }, transcription: { version: 1, jobId: 'job-old', status: 'queued' } },
      jobs: { 'job-old': { id: 'job-old', status: 'queued' } },
    });
    expect(parse(await busy.handlers.transcribe(request('int-1'), context, busy.io))).toEqual({ status: 409, body: { ok: false, error: 'Transcript version 1 is already being made.' } });
    expect(busy.io.enqueue).not.toHaveBeenCalled();
  });
});

describe('an interview whose deletion has started (provenance.audio.deletedAt)', () => {
  const tombstoned = {
    id: 'int-1',
    type: 'interview',
    interview: { stage: 'fetched' },
    provenance: { audio: { path: 'audio/int-1.mp3', deletedAt: '2026-11-05T09:59:00Z' } },
  };

  it('queues no transcription, though the recording still has its path', async () => {
    const { handlers, io, store } = makeDeps({ doc: tombstoned });
    const res = parse(await handlers.transcribe(request('int-1'), context, io));
    expect(res).toEqual({ status: 409, body: { ok: false, error: 'This interview is being deleted; nothing new was queued.', code: 'INTERVIEW_DELETED' } });
    expect(io.enqueue).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(store.patchDoc).not.toHaveBeenCalled();
  });

  it('queues no download either', async () => {
    const { handlers, io } = makeDeps({ doc: tombstoned });
    const res = parse(await handlers.audioFromUrl(request('int-1', { url: 'https://files.example/guest.mp3' }), context, io));
    expect(res.body.code).toBe('INTERVIEW_DELETED');
    expect(io.enqueue).not.toHaveBeenCalled();
  });
});

describe('recordingInUse', () => {
  const store = (jobs) => ({ readDoc: vi.fn(async (container, id) => jobs[id] ?? null) });

  it('is true while the download or the transcription named on the document is queued or running', async () => {
    expect(await recordingInUse(store({ f: { status: 'running' } }), { interview: { fetchJobId: 'f' } })).toBe(true);
    expect(await recordingInUse(store({ t: { status: 'queued' } }), { transcription: { jobId: 't' } })).toBe(true);
  });

  it('stops counting a job past its budget plus the sweeper grace: a lost worker cannot hold the delete', async () => {
    const at = new Date('2026-11-05T12:00:00Z');
    const minutesAgo = (m) => new Date(at.getTime() - m * 60_000).toISOString();
    const doc = { transcription: { jobId: 't' } };
    // The transcription budget is 25 minutes, the grace 5: 29 minutes running is still working.
    expect(await recordingInUse(store({ t: { status: 'running', startedAt: minutesAgo(29) } }), doc, at)).toBe(true);
    expect(await recordingInUse(store({ t: { status: 'running', startedAt: minutesAgo(31) } }), doc, at)).toBe(false);
    // A queued job also gets the sweeper's four 10-minute re-sends.
    expect(await recordingInUse(store({ t: { status: 'queued', createdAt: minutesAgo(60) } }), doc, at)).toBe(true);
    expect(await recordingInUse(store({ t: { status: 'queued', createdAt: minutesAgo(80) } }), doc, at)).toBe(false);
    // The download's budget is 10 minutes.
    const fetchDoc = { interview: { fetchJobId: 'f' } };
    expect(await recordingInUse(store({ f: { status: 'running', startedAt: minutesAgo(14) } }), fetchDoc, at)).toBe(true);
    expect(await recordingInUse(store({ f: { status: 'running', startedAt: minutesAgo(16) } }), fetchDoc, at)).toBe(false);
  });

  it('is false once those jobs have ended, when none is named, and for a running draft', async () => {
    const ended = store({ f: { status: 'succeeded' }, t: { status: 'failed' } });
    expect(await recordingInUse(ended, { interview: { fetchJobId: 'f' }, transcription: { jobId: 't' } })).toBe(false);
    expect(await recordingInUse(store({}), {})).toBe(false);
    // The draft reads the transcript, not the recording.
    expect(await recordingInUse(store({ d: { status: 'running' } }), { interview: { draftJobId: 'd' } })).toBe(false);
  });
});

describe('POST cms/interviews/{id}/draft', () => {
  it('queues interview-draft for the current transcript version and marks the stage', async () => {
    const { handlers, io, store } = makeDeps({ doc: { id: 'int-1', type: 'interview', transcription: { version: 2, status: 'done' }, interview: { stage: 'transcribed' } } });
    const res = parse(await handlers.draft(request('int-1'), context, io));
    expect(res).toMatchObject({ status: 202, body: { type: 'interview-draft', transcriptVersion: 2 } });
    expect(store.upsertDoc.mock.calls[0][1].payload).toEqual({ interviewId: 'int-1', transcriptVersion: 2 });
    expect(store.patchDoc).toHaveBeenCalledWith('content', 'int-1', { interview: { stage: 'drafting', error: null, draftJobId: 'job-new' } });
    const provided = makeDeps({ doc: { id: 'int-1', type: 'interview', transcription: { version: 1, status: 'provided' } } });
    expect(parse(await provided.handlers.draft(request('int-1'), context, provided.io)).status).toBe(202);
  });

  it('refuses 422 without a finished transcript and 409 while a draft is being made', async () => {
    for (const transcription of [undefined, { version: 1, status: 'running' }, { version: 1, status: 'failed' }]) {
      const deps = makeDeps({ doc: { id: 'int-1', type: 'interview', transcription } });
      expect(parse(await deps.handlers.draft(request('int-1'), context, deps.io)).status, JSON.stringify(transcription)).toBe(422);
    }
    const busy = makeDeps({
      doc: { id: 'int-1', type: 'interview', transcription: { version: 1, status: 'done' }, interview: { draftJobId: 'job-old' } },
      jobs: { 'job-old': { id: 'job-old', status: 'running' } },
    });
    expect(parse(await busy.handlers.draft(request('int-1'), context, busy.io)).status).toBe(409);
  });
});

describe('POST cms/interviews/{id}/transcript', () => {
  it('stores a pasted transcript as version 1 without a job', async () => {
    const { handlers, io, store, storage } = makeDeps({ doc: { id: 'int-1', type: 'interview' } });
    const res = parse(await handlers.transcript(request('int-1', { text: 'Speaker 1: Why?\nSpeaker 2: Because.' }), context, io));
    expect(res).toEqual({ status: 200, body: { ok: true, interviewId: 'int-1', version: 1, segments: 2, chars: 35 } });
    expect(storage.uploadBlob).toHaveBeenCalledWith('interviews-audio', 'transcripts/int-1/v1.json', expect.any(String), 'application/json');
    expect(io.enqueue).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('refuses an empty text with 400, an over-long one with 413, and a running transcription with 409', async () => {
    const { handlers, io } = makeDeps({ doc: { id: 'int-1', type: 'interview' } });
    expect(parse(await handlers.transcript(request('int-1', {}), context, io)).status).toBe(400);
    expect(parse(await handlers.transcript(request('int-1', { text: 'x'.repeat(400_001) }), context, io)).status).toBe(413);
    const busy = makeDeps({
      doc: { id: 'int-1', type: 'interview', transcription: { version: 1, jobId: 'job-old', status: 'running' } },
      jobs: { 'job-old': { id: 'job-old', status: 'running' } },
    });
    expect(parse(await busy.handlers.transcript(request('int-1', { text: 'Speaker 1: hi' }), context, busy.io)).status).toBe(409);
  });
});

describe('POST cms/interviews/{id}/transcribe without a range reader', () => {
  it('queues without probing the length when the storage seam cannot read a range', async () => {
    const { handlers, io, store } = makeDeps();
    const bare = createInterviewJobHandlers({ guard, store, storage: { uploadBlob: vi.fn() }, uuid: () => 'job-new', now: () => new Date('2026-11-05T10:00:00Z') });
    expect(parse(await bare.transcribe(request('int-1'), context, io)).status).toBe(202);
    expect(store.patchDoc.mock.calls.every(([, , patch]) => !patch.provenance)).toBe(true);
    expect(handlers).toBeDefined();
  });
});

describe('defaults and unreadable bodies', () => {
  it('mints its own job id and clock, and reads a body that is not JSON as empty', async () => {
    const { store, storage, io } = makeDeps({ doc: { id: 'int-1', type: 'interview' } });
    const handlers = createInterviewJobHandlers({ guard, store, storage });
    const notJson = { ...request('int-1'), json: async () => { throw new SyntaxError('Unexpected token'); } };
    expect(parse(await handlers.audioFromUrl(notJson, context, io))).toEqual({ status: 400, body: { ok: false, error: 'url is required.' } });
    expect(parse(await handlers.transcript(notJson, context, io)).status).toBe(400);
    const queued = parse(await handlers.audioFromUrl(request('int-1', { url: 'https://files.example/a.mp3' }), context, io));
    expect(queued.body.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.upsertDoc.mock.calls[0][1].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
