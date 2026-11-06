/**
 * The transcription job with a stubbed Gemini client (ADR 0040 D3): the
 * window loop stops on endOfAudio; a re-run resumes from the parts in the
 * container; the window cap holds; the monthly ceiling refuses a request
 * before it is sent, counting every attempt; 429 is retried and 403 is
 * not (through the real client over a fake fetch); the Gemini file is
 * deleted on success and on failure; usage rows are priced at the audio
 * rate; and no log line carries a segment, a name, a URL or a file name.
 */
import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { transcribeWindow as realTranscribeWindow } from './gemini-files.js';
import {
  AUDIO_TOKENS_PER_SECOND,
  CEILING_DEFAULT_USD,
  MAX_AUDIO_SECONDS,
  OUTPUT_TOKEN_ALLOWANCE,
  estimateAudioSeconds,
  maxWindows,
  monthlyCeilingUsd,
  monthTranscriptionSpend,
  parseTranscribePayload,
  requestCostUsd,
  transcribeInterview,
  windowSeconds,
} from './transcribe.js';

const GUEST = 'Alex Example';
const audio = { container: 'interviews-audio', path: 'audio/int-1.mp3', bytes: 8000 * 3600, contentType: 'audio/mpeg', sourceUrl: 'https://secret.example/share/guest-voice.mp3' };
const baseDoc = () => ({
  id: 'int-1',
  type: 'interview',
  guest: { name: GUEST },
  provenance: { source: 'url', audio },
  interview: { stage: 'fetched' },
});

/** A content document, a jobs-free usage ledger and a container, all in memory. */
function makeWorld({ doc = baseDoc(), monthRows = [], parts = {} } = {}) {
  const blobs = { ...parts };
  const usage = [];
  const store = {
    readDoc: vi.fn(async () => doc),
    patchDoc: vi.fn(async () => ({})),
    // The ledger answers the month's rows plus every row this world has written, as Cosmos would.
    queryDocs: vi.fn(async () => [...monthRows, ...usage.map((row) => ({ estimatedCostUsd: row.estimatedCostUsd }))]),
    upsertDoc: vi.fn(async (container, row) => {
      usage.push(row);
      return row;
    }),
  };
  const storage = {
    downloadBlobStream: vi.fn(async () => ({ stream: Readable.from([Buffer.from('audio-bytes')]), contentLength: audio.bytes, contentType: 'audio/mpeg' })),
    readBlobForDelivery: vi.fn(async (container, path) => (blobs[path] ? { body: Buffer.from(blobs[path]) } : null)),
    uploadBlob: vi.fn(async (container, path, body) => {
      blobs[path] = body;
      return 'url';
    }),
    deleteBlob: vi.fn(async (container, path) => {
      delete blobs[path];
    }),
  };
  const ai = {
    modelForTask: vi.fn(async () => ({ task: 'recordingTranscript', provider: 'gemini', model: 'gemini-3.6-flash', selection: 'recommended' })),
    getCostEstimate: () => 0,
    isPriced: () => true,
  };
  return { store, storage, ai, blobs, usage };
}

const segment = (k) => ({ start: k * 3600, end: k * 3600 + 5, speaker: 'Speaker 2', text: `${GUEST} said something in window ${k}` });
/** A Gemini client whose windows are the given results, in order. */
function makeGemini(results, { deleteFails = false } = {}) {
  const queue = [...results];
  return {
    uploadToGemini: vi.fn(async () => ({ name: 'files/abc', uri: 'https://files.example/abc', mimeType: 'audio/mpeg' })),
    transcribeWindow: vi.fn(async ({ assertBudget }) => {
      await assertBudget?.({ attempt: 1 });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return { usage: { promptTokens: 115_200, completionTokens: 800 }, attempts: 1, ...next };
    }),
    deleteFromGemini: vi.fn(async () => {
      if (deleteFails) throw Object.assign(new Error('secret words'), { code: 'GEMINI_HTTP_500' });
      return true;
    }),
  };
}
const run = (world, gemini, over = {}) =>
  transcribeInterview({
    interviewId: 'int-1',
    transcriptVersion: 1,
    store: world.store,
    storage: world.storage,
    ai: world.ai,
    gemini,
    env: { GEMINI_API_KEY: 'test-key' },
    sleep: async () => {},
    now: () => new Date('2026-11-05T10:00:00Z'),
    uuid: () => 'row',
    jobId: 'job-1',
    ...over,
  });

describe('the settings and the arithmetic', () => {
  it('parses the payload, reads the ceiling and the window with their defaults and bounds', () => {
    expect(parseTranscribePayload({ interviewId: 'int-1', transcriptVersion: '3' })).toEqual({ value: { interviewId: 'int-1', transcriptVersion: 3 } });
    expect(parseTranscribePayload({ interviewId: 'int-1', transcriptVersion: 1000 })).toEqual({ error: expect.stringMatching(/transcriptVersion/) });
    expect(parseTranscribePayload({})).toEqual({ error: 'interviewId is required.' });
    expect(monthlyCeilingUsd({})).toBe(CEILING_DEFAULT_USD);
    expect(monthlyCeilingUsd({ INTERVIEW_TRANSCRIPTION_MONTHLY_USD: '25' })).toBe(25);
    expect(monthlyCeilingUsd({ INTERVIEW_TRANSCRIPTION_MONTHLY_USD: '-1' })).toBe(CEILING_DEFAULT_USD);
    expect(windowSeconds({})).toBe(3600);
    expect(windowSeconds({ INTERVIEW_TRANSCRIPTION_WINDOW_MINUTES: '20' })).toBe(1200);
    expect(windowSeconds({ INTERVIEW_TRANSCRIPTION_WINDOW_MINUTES: '1' })).toBe(300);
    expect(windowSeconds({ INTERVIEW_TRANSCRIPTION_WINDOW_MINUTES: '999' })).toBe(7200);
    expect(maxWindows(3600)).toBe(10);
    expect(maxWindows(1200)).toBe(29);
  });

  it('estimates seconds from bytes at a low bitrate, capped at Gemini’s 9.5 hours', () => {
    expect(estimateAudioSeconds({ bytes: 8000 * 60, contentType: 'audio/mpeg' })).toBe(60);
    expect(estimateAudioSeconds({ bytes: 176_400 * 10, contentType: 'audio/wav' })).toBe(10);
    expect(estimateAudioSeconds({ bytes: 500 * 1024 * 1024, contentType: 'audio/mp4' })).toBe(MAX_AUDIO_SECONDS);
    expect(estimateAudioSeconds({ bytes: 0, contentType: 'audio/mpeg' })).toBe(1);
  });

  it('prices a request as the whole file’s audio tokens in and a window’s JSON out, and null for an unpriced model', () => {
    const at = Date.parse('2026-11-05T00:00:00Z');
    // 115,200 audio tokens at $0.75 per 1M plus 16,000 output tokens at $7.50 per 1M.
    expect(requestCostUsd({ provider: 'gemini', model: 'gemini-3.6-flash', promptTokens: 115_200, at })).toBeCloseTo(0.0864 + 0.12, 6);
    expect(requestCostUsd({ provider: 'gemini', model: 'gemini-3.6-flash', promptTokens: 100, completionTokens: 0, at: Date.parse('2027-02-01T00:00:00Z') })).toBeCloseTo(0.00015, 8);
    expect(requestCostUsd({ provider: 'gemini', model: 'gemini-3.8-flash-tts', promptTokens: 100 })).toBeNull();
    expect(OUTPUT_TOKEN_ALLOWANCE).toBe(16_000);
    expect(AUDIO_TOKENS_PER_SECOND).toBe(32);
  });

  it('reads the month’s spend on the task’s own source since the first of the month', async () => {
    const store = { queryDocs: vi.fn(async () => [{ estimatedCostUsd: 1.5 }, { estimatedCostUsd: 0.25 }]) };
    await expect(monthTranscriptionSpend({ store, now: () => new Date('2026-11-17T12:00:00Z') })).resolves.toEqual({ since: '2026-11-01T00:00:00.000Z', costUsd: 1.75 });
    expect(store.queryDocs.mock.calls[0][2]).toEqual([
      { name: '@transcribe', value: 'ai:recordingTranscript' },
      { name: '@draft', value: 'ai:interviewDrafting' },
      { name: '@since', value: '2026-11-01T00:00:00.000Z' },
    ]);
  });
});

describe('transcribeInterview', () => {
  it('uploads once, transcribes window by window until endOfAudio, saves parts then the transcript, deletes the parts and the Gemini file, prices each request at the audio rate, and logs counts only', async () => {
    const world = makeWorld();
    const gemini = makeGemini([{ segments: [segment(0)], endOfAudio: false }, { segments: [segment(1)], endOfAudio: true }]);
    const log = { log: vi.fn(), warn: vi.fn() };
    const report = await run(world, gemini, { log });
    expect(report).toEqual({
      interviewId: 'int-1',
      transcriptVersion: 1,
      windows: 2,
      requests: 2,
      segments: 2,
      promptTokens: 230_400,
      completionTokens: 1600,
      costUsd: expect.any(Number),
      model: 'gemini-3.6-flash',
      provider: 'gemini',
      resumedFrom: 0,
    });
    expect(world.ai.modelForTask).toHaveBeenCalledWith({ task: 'recordingTranscript' });
    expect(world.storage.downloadBlobStream).toHaveBeenCalledWith('interviews-audio', 'audio/int-1.mp3');
    expect(gemini.uploadToGemini).toHaveBeenCalledTimes(1);
    expect(gemini.uploadToGemini.mock.calls[0][0]).toMatchObject({ bytes: audio.bytes, mimeType: 'audio/mpeg' });
    expect(gemini.transcribeWindow.mock.calls.map(([a]) => [a.startSec, a.endSec])).toEqual([
      [0, 3600],
      [3600, 7200],
    ]);
    expect(gemini.transcribeWindow.mock.calls[0][0]).toMatchObject({ fileUri: 'https://files.example/abc', model: 'gemini-3.6-flash' });
    // The parts were written and then removed; the transcript stands.
    expect(Object.keys(world.blobs)).toEqual(['transcripts/int-1/v1.json']);
    expect(world.storage.uploadBlob.mock.calls.map(([, path]) => path)).toEqual([
      'transcripts/int-1/v1.parts/000.json',
      'transcripts/int-1/v1.parts/001.json',
      'transcripts/int-1/v1.json',
    ]);
    const transcript = JSON.parse(world.blobs['transcripts/int-1/v1.json']);
    expect(transcript).toMatchObject({ version: 1, source: 'gemini', model: 'gemini-3.6-flash', provider: 'gemini', windows: 2, segments: [segment(0), segment(1)] });
    expect(transcript.text).toContain(`Speaker 2: ${GUEST} said something in window 0`);
    expect(gemini.deleteFromGemini).toHaveBeenCalledWith(expect.objectContaining({ name: 'files/abc' }));
    // Two usage rows, each at the audio input rate ($0.75 per 1M in November 2026) plus the output rate.
    expect(world.usage).toHaveLength(2);
    expect(world.usage[0]).toMatchObject({ provider: 'gemini', model: 'gemini-3.6-flash', promptTokens: 115_200, completionTokens: 800, source: 'ai:recordingTranscript', selection: 'recommended' });
    expect(world.usage[0].estimatedCostUsd).toBeCloseTo(0.0864 + 0.006, 6);
    expect(report.costUsd).toBeCloseTo(2 * (0.0864 + 0.006), 6);
    // The document: running, then window counts, then done with the record on both blocks.
    expect(world.store.patchDoc.mock.calls[0][2]).toEqual({
      transcription: { version: 1, jobId: 'job-1', status: 'running', model: 'gemini-3.6-flash', provider: 'gemini' },
      interview: { stage: 'transcribing', error: null, window: 0 },
    });
    const last = world.store.patchDoc.mock.calls.at(-1)[2];
    expect(last).toEqual({
      transcription: { version: 1, model: 'gemini-3.6-flash', provider: 'gemini', transcribedAt: '2026-11-05T10:00:00.000Z', windows: 2, jobId: 'job-1', status: 'done' },
      provenance: { source: 'url', audio, transcription: { version: 1, model: 'gemini-3.6-flash', provider: 'gemini', transcribedAt: '2026-11-05T10:00:00.000Z', windows: 2 } },
      interview: { stage: 'transcribed', error: null, window: 2 },
    });
    // Content-free logs: ids, counts, times. Never the guest, the URL, the file name or a segment.
    const lines = [...log.log.mock.calls, ...log.warn.mock.calls].map(([line]) => line);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^interview-transcribe: int-1 v1 window 0 1 segments, 115200\+800 tokens, 1 attempt\(s\), \d+ ms$/);
    expect(lines[2]).toMatch(/^interview-transcribe: int-1 v1 done: 2 window\(s\), 2 request\(s\), 2 segments, 230400\+1600 tokens, \$[\d.]+, \d+ ms$/);
    for (const line of lines) {
      for (const secret of [GUEST, 'secret.example', 'guest-voice', 'said something', 'audio/int-1.mp3', 'files/abc']) {
        expect(line, secret).not.toContain(secret);
      }
    }
  });

  it('resumes from the parts already in the container and uploads only when a window is still to do', async () => {
    const parts = {
      'transcripts/int-1/v1.parts/000.json': JSON.stringify({ segments: [segment(0)], endOfAudio: false }),
    };
    const world = makeWorld({ parts });
    const gemini = makeGemini([{ segments: [segment(1)], endOfAudio: true }]);
    const log = { log: vi.fn() };
    const report = await run(world, gemini, { log });
    expect(report).toMatchObject({ windows: 2, requests: 1, resumedFrom: 1 });
    expect(gemini.uploadToGemini).toHaveBeenCalledTimes(1);
    expect(gemini.transcribeWindow).toHaveBeenCalledTimes(1);
    expect(gemini.transcribeWindow.mock.calls[0][0]).toMatchObject({ startSec: 3600, endSec: 7200 });
    expect(JSON.parse(world.blobs['transcripts/int-1/v1.json']).segments).toEqual([segment(0), segment(1)]);
    expect(log.log.mock.calls.at(-1)[0]).toMatch(/resumed after 1 part\(s\)$/);

    // Every part present, the last with endOfAudio: nothing is uploaded or asked.
    const complete = makeWorld({ parts: { ...parts, 'transcripts/int-1/v1.parts/001.json': JSON.stringify({ segments: [segment(1)], endOfAudio: true }) } });
    const idle = makeGemini([]);
    await expect(run(complete, idle)).resolves.toMatchObject({ windows: 2, requests: 0, resumedFrom: 2 });
    expect(idle.uploadToGemini).not.toHaveBeenCalled();
    expect(idle.deleteFromGemini).not.toHaveBeenCalled();
    expect(complete.usage).toHaveLength(0);
  });

  it('stops with TOO_LONG when the tenth window ends without endOfAudio (a URL fetch with no declared length), never asking an eleventh', async () => {
    const world = makeWorld();
    const gemini = makeGemini(Array.from({ length: 40 }, (_, k) => ({ segments: [segment(k)], endOfAudio: false })));
    const error = await run(world, gemini, { env: { GEMINI_API_KEY: 'k', INTERVIEW_TRANSCRIPTION_MONTHLY_USD: '100' } }).catch((e) => e);
    expect(error).toMatchObject({ code: 'TOO_LONG', status: 422 });
    expect(error.message).toMatch(/still going after 10 windows of 60 minutes/);
    expect(gemini.transcribeWindow).toHaveBeenCalledTimes(10);
    expect(gemini.deleteFromGemini).toHaveBeenCalledTimes(1);
    // The parts stay for the record; no transcript was assembled.
    expect(Object.keys(world.blobs)).toHaveLength(10);
    expect(world.store.patchDoc.mock.calls.at(-1)[2].interview.stage).toBe('failed');
    // Two-hour windows: five, the same stop.
    const wide = makeWorld();
    const long = makeGemini(Array.from({ length: 40 }, (_, k) => ({ segments: [segment(k)], endOfAudio: false })));
    await expect(run(wide, long, { env: { GEMINI_API_KEY: 'k', INTERVIEW_TRANSCRIPTION_WINDOW_MINUTES: '120', INTERVIEW_TRANSCRIPTION_MONTHLY_USD: '100' } })).rejects.toMatchObject({ code: 'TOO_LONG' });
    expect(long.transcribeWindow).toHaveBeenCalledTimes(5);
    // A tenth window that IS the end is a success.
    const ends = makeWorld();
    await expect(run(ends, makeGemini(Array.from({ length: 10 }, (_, k) => ({ segments: [segment(k)], endOfAudio: k === 9 }))), { env: { GEMINI_API_KEY: 'k', INTERVIEW_TRANSCRIPTION_MONTHLY_USD: '100' } })).resolves.toMatchObject({ windows: 10 });
  });

  it('re-reads the month’s spend before each window, so a job running beside this one is counted', async () => {
    const world = makeWorld({ monthRows: [{ estimatedCostUsd: 0.1 }] });
    // Another job's row lands between the windows.
    world.store.queryDocs.mockImplementationOnce(async () => [{ estimatedCostUsd: 0.1 }]).mockImplementation(async () => [{ estimatedCostUsd: 0.1 }, { estimatedCostUsd: 0.3 }, ...world.usage.map((r) => ({ estimatedCostUsd: r.estimatedCostUsd }))]);
    const gemini = makeGemini([{ segments: [segment(0)], endOfAudio: false }, { segments: [segment(1)], endOfAudio: true }]);
    const error = await run(world, gemini, { env: { GEMINI_API_KEY: 'k', INTERVIEW_TRANSCRIPTION_MONTHLY_USD: '0.6' } }).catch((e) => e);
    expect(error).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(error.message).toMatch(/\$0\.49 of the \$0\.6/);
    expect(world.store.queryDocs).toHaveBeenCalledTimes(2);
  });

  it('re-transcribes a window whose part is unreadable', async () => {
    const world = makeWorld({ parts: { 'transcripts/int-1/v1.parts/000.json': 'not json' } });
    const gemini = makeGemini([{ segments: [segment(0)], endOfAudio: true }]);
    await expect(run(world, gemini)).resolves.toMatchObject({ windows: 1, requests: 1, resumedFrom: 0 });
    expect(gemini.transcribeWindow.mock.calls[0][0]).toMatchObject({ startSec: 0 });
  });

  it('refuses to run beside another queued or running transcription of the same interview, whichever door queued it', async () => {
    const doc = { ...baseDoc(), transcription: { version: 1, jobId: 'job-other', status: 'running' } };
    const world = makeWorld({ doc });
    world.store.readDoc = vi.fn(async (container, id) => (container === 'jobs' ? { id, status: 'running' } : doc));
    const gemini = makeGemini([]);
    await expect(run(world, gemini)).rejects.toMatchObject({ code: 'TRANSCRIPTION_IN_FLIGHT', status: 409 });
    expect(gemini.uploadToGemini).not.toHaveBeenCalled();
    // The same job re-queued by the sweeper, or a finished job, does not block.
    const own = makeWorld({ doc: { ...baseDoc(), transcription: { version: 1, jobId: 'job-1', status: 'running' } } });
    await expect(run(own, makeGemini([{ segments: [], endOfAudio: true }]))).resolves.toMatchObject({ windows: 1 });
    const finished = makeWorld({ doc });
    finished.store.readDoc = vi.fn(async (container, id) => (container === 'jobs' ? { id, status: 'failed' } : doc));
    await expect(run(finished, makeGemini([{ segments: [], endOfAudio: true }]))).resolves.toMatchObject({ windows: 1 });
  });

  it('says out loud when a usage row could not be written, since the ceiling reads the rows', async () => {
    const world = makeWorld();
    world.store.upsertDoc = vi.fn(async () => {
      throw new Error('ledger down');
    });
    const log = { log: vi.fn(), warn: vi.fn() };
    await expect(run(world, makeGemini([{ segments: [], endOfAudio: true }]), { log })).resolves.toMatchObject({ windows: 1 });
    expect(log.warn.mock.calls.map(([l]) => l)).toEqual(['interview-transcribe: int-1 v1 window 0 usage row not written']);
  });

  it('refuses with BUDGET_EXCEEDED before the upload when the month plus this request would cross the ceiling, and records the failure on the document', async () => {
    const world = makeWorld({ monthRows: [{ estimatedCostUsd: 9.9 }] });
    const gemini = makeGemini([{ segments: [], endOfAudio: true }]);
    const error = await run(world, gemini).catch((e) => e);
    expect(error).toMatchObject({ code: 'BUDGET_EXCEEDED', status: 429 });
    expect(error.message).toMatch(/\$9\.90 of the \$10 monthly interview ceiling is used since 2026-11-01/);
    expect(world.storage.downloadBlobStream).not.toHaveBeenCalled();
    expect(gemini.uploadToGemini).not.toHaveBeenCalled();
    expect(gemini.transcribeWindow).not.toHaveBeenCalled();
    expect(gemini.deleteFromGemini).not.toHaveBeenCalled();
    expect(world.store.patchDoc.mock.calls.at(-1)[2]).toEqual({
      transcription: { version: 1, jobId: 'job-1', status: 'failed', model: 'gemini-3.6-flash', provider: 'gemini' },
      interview: { stage: 'failed', error: error.message },
    });
  });

  it('counts every attempt against the ceiling: a retry that would cross it is refused before it is sent', async () => {
    // Ceiling 0.35 with 0.10 spent: the first request's estimate (115,200
    // audio tokens at $0.75 per 1M plus the 16,000-token output allowance,
    // about $0.21) fits; after it the job has spent about $0.09, and the
    // second window's estimate would cross the line.
    const world = makeWorld({ monthRows: [{ estimatedCostUsd: 0.1 }] });
    const gemini = makeGemini([{ segments: [segment(0)], endOfAudio: false }, { segments: [segment(1)], endOfAudio: true }]);
    const error = await run(world, gemini, { env: { GEMINI_API_KEY: 'k', INTERVIEW_TRANSCRIPTION_MONTHLY_USD: '0.35' } }).catch((e) => e);
    expect(error).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(gemini.transcribeWindow).toHaveBeenCalledTimes(2);
    expect(world.usage).toHaveLength(1);
    // The first window's part stays for the next run; the Gemini file is gone.
    expect(Object.keys(world.blobs)).toEqual(['transcripts/int-1/v1.parts/000.json']);
    expect(gemini.deleteFromGemini).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 and does not retry a 403, through the real client over a fake fetch, counting the attempts', async () => {
    const answer = (json) => ({
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }], usageMetadata: { promptTokenCount: 115_200, candidatesTokenCount: 10 } }),
    });
    const status = (code) => ({ status: code, headers: { get: () => null }, text: async () => '{"error":{"message":"quota words"}}' });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(status(429))
      .mockResolvedValueOnce(answer({ segments: [segment(0)], endOfAudio: true }));
    const world = makeWorld();
    const gemini = { ...makeGemini([]), transcribeWindow: realTranscribeWindow };
    const report = await run(world, gemini, { env: { GEMINI_API_KEY: 'k', INTERVIEW_TRANSCRIPTION_MONTHLY_USD: '100' }, fetch });
    expect(report).toMatchObject({ windows: 1, requests: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);

    const forbidden = vi.fn(async () => status(403));
    const failed = makeWorld();
    const error = await run(failed, gemini, { env: { GEMINI_API_KEY: 'k' }, fetch: forbidden }).catch((e) => e);
    expect(error).toMatchObject({ code: 'GEMINI_HTTP_403' });
    expect(error.message).not.toContain('quota');
    expect(forbidden).toHaveBeenCalledTimes(1);
    expect(failed.store.patchDoc.mock.calls.at(-1)[2].interview).toEqual({ stage: 'failed', error: 'Gemini answered HTTP 403 to the transcription.' });
  });

  it('deletes the Gemini file on failure, logs a failed delete content-free, and never writes Gemini’s words to the document', async () => {
    const world = makeWorld();
    const gemini = makeGemini([Object.assign(new Error('500 upstream said: secret-words'), { status: 500 })], { deleteFails: true });
    const log = { log: vi.fn(), warn: vi.fn() };
    await expect(run(world, gemini, { log })).rejects.toThrow(/secret-words/);
    expect(gemini.deleteFromGemini).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls.map(([l]) => l)).toEqual(['interview-transcribe: int-1 v1 Gemini file not deleted (GEMINI_HTTP_500)']);
    const stored = world.store.patchDoc.mock.calls.at(-1)[2].interview;
    expect(stored.stage).toBe('failed');
    expect(stored.error).not.toContain('secret-words');
    expect(stored.error).toMatch(/^Transcription failed \(/);
  });

  it('refuses a document without a recording, a task that is not Gemini, and a model unpriced for audio, before anything is sent', async () => {
    const gemini = makeGemini([]);
    const noAudio = makeWorld({ doc: { ...baseDoc(), provenance: {} } });
    await expect(run(noAudio, gemini)).rejects.toMatchObject({ code: 'AUDIO_MISSING', status: 422 });
    const notInterview = makeWorld({ doc: { id: 'int-1', type: 'blog' } });
    await expect(run(notInterview, gemini)).rejects.toMatchObject({ code: 'INTERVIEW_NOT_FOUND' });
    const wrongProvider = makeWorld();
    wrongProvider.ai.modelForTask = vi.fn(async () => ({ provider: 'openai', model: 'gpt-5-mini' }));
    await expect(run(wrongProvider, gemini)).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE', status: 503 });
    const unpriced = makeWorld();
    unpriced.ai.modelForTask = vi.fn(async () => ({ provider: 'gemini', model: 'gemini-9-future' }));
    await expect(run(unpriced, gemini)).rejects.toMatchObject({ code: 'MODEL_UNPRICED', status: 422 });
    expect(gemini.uploadToGemini).not.toHaveBeenCalled();
  });

  it('uses the recording’s known length for the estimate, and refuses a known length over 9.5 hours before anything is sent', async () => {
    // Ten minutes known: 19,200 tokens, about $0.014 plus the output allowance; the bitrate guess would say an hour.
    const known = makeWorld({ doc: { ...baseDoc(), provenance: { source: 'url', audio: { ...audio, durationSec: 600 } } }, monthRows: [{ estimatedCostUsd: 9.85 }] });
    const gemini = makeGemini([{ segments: [], endOfAudio: true }]);
    await expect(run(known, gemini)).resolves.toMatchObject({ windows: 1 });
    const guessed = makeWorld({ monthRows: [{ estimatedCostUsd: 9.85 }] });
    await expect(run(guessed, makeGemini([{ segments: [], endOfAudio: true }]))).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    const long = makeWorld({ doc: { ...baseDoc(), provenance: { source: 'url', audio: { ...audio, durationSec: MAX_AUDIO_SECONDS + 1 } } } });
    const idle = makeGemini([]);
    await expect(run(long, idle)).rejects.toMatchObject({ code: 'TOO_LONG', status: 422 });
    expect(idle.uploadToGemini).not.toHaveBeenCalled();
    const exact = makeWorld({ doc: { ...baseDoc(), provenance: { source: 'url', audio: { ...audio, durationSec: MAX_AUDIO_SECONDS } } } });
    await expect(run(exact, makeGemini([{ segments: [], endOfAudio: true }]), { env: { GEMINI_API_KEY: 'k', INTERVIEW_TRANSCRIPTION_MONTHLY_USD: '100' } })).resolves.toMatchObject({ windows: 1 });
  });

  it('refuses an unseeded key before the upload, with the fixed sentence', async () => {
    const world = makeWorld();
    const gemini = makeGemini([]);
    await expect(run(world, gemini, { env: { GEMINI_API_KEY: '@Microsoft.KeyVault(SecretUri=x)' }, gemini: { ...gemini } })).rejects.toMatchObject({ code: 'GEMINI_NOT_CONFIGURED' });
    expect(gemini.uploadToGemini).not.toHaveBeenCalled();
  });

  it('stops between windows when the job’s signal fires during one, keeping that window’s part and deleting the Gemini file', async () => {
    const controller = new AbortController();
    const world = makeWorld();
    const gemini = makeGemini([{ segments: [segment(0)], endOfAudio: false }, { segments: [segment(1)], endOfAudio: true }]);
    gemini.transcribeWindow.mockImplementationOnce(async () => {
      controller.abort(new Error('job timed out'));
      return { segments: [segment(0)], endOfAudio: false, usage: { promptTokens: 1, completionTokens: 1 }, attempts: 1 };
    });
    await expect(run(world, gemini, { signal: controller.signal })).rejects.toThrow('job timed out');
    expect(gemini.transcribeWindow).toHaveBeenCalledTimes(1);
    expect(Object.keys(world.blobs)).toEqual(['transcripts/int-1/v1.parts/000.json']);
    expect(gemini.deleteFromGemini).toHaveBeenCalledTimes(1);
    const already = new AbortController();
    already.abort(new Error('job timed out'));
    await expect(run(makeWorld(), makeGemini([]), { signal: already.signal })).rejects.toThrow('job timed out');
  });
});

describe('the real clock and wait', () => {
  it('uses its own clock and sleeper when none is given, and reads the month with the real date', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-20T12:00:00Z'));
      const world = makeWorld();
      const gemini = makeGemini([{ segments: [], endOfAudio: true }]);
      const report = await transcribeInterview({ interviewId: 'int-1', transcriptVersion: 1, store: world.store, storage: world.storage, ai: world.ai, gemini, env: { GEMINI_API_KEY: 'k' }, jobId: 'job-1' });
      expect(report.windows).toBe(1);
      expect(world.store.queryDocs.mock.calls[0][2].at(-1)).toEqual({ name: '@since', value: '2026-11-01T00:00:00.000Z' });
      // monthInterviewSpend with its own clock.
      const spend = await monthTranscriptionSpend({ store: { queryDocs: async () => [] } });
      expect(spend.since).toBe('2026-11-01T00:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });
});
