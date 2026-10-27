/**
 * The recording → transcript pipeline.
 *
 * Three behaviours carry the weight: a rejected or missing Plaud credential
 * is refused before the model is called (so a refusal costs nothing and
 * names the Connect tab), a stored recording scripts without touching the
 * MCP, and the shared tail from generate.js behaves the same here — an
 * audio failure is recorded on the saved draft rather than thrown.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  PLAUD_CONNECT_SENTENCE,
  RECORDINGS_CONTAINER,
  RECORDING_JOB_TYPE,
  generateTranscriptFromRecording,
  isPlaudCredentialFailure,
  parseRecordingPayload,
  parseToolResult,
  readPlaudRecording,
  refusalForPlaud,
} from './recording-generate.js';
import { STATUS, TRANSCRIPT_CONTAINER } from './store.js';
import { SpeechError } from '../listen-and-learn/speech/index.js';
import { USAGE_SOURCES } from '../ai/usage.js';

const NOW = '2026-09-08T12:00:00.000Z';

/** Enough speech to clear MIN_TRANSCRIPT_BYTES (400) comfortably. */
const line = (i) =>
  `Utterance number ${i}: we talked about landing zones, private endpoints and why the hub ` +
  `network owns DNS. It ran long, but the point about identity boundaries landed.`;

const utterance = (i, speaker) => ({
  start_time: 3080 + i * 30_000,
  end_time: 33_010 + i * 30_000,
  content: line(i),
  speaker,
  original_speaker: speaker,
});

const transcriptResult = () => ({
  file_id: 'rec-1',
  segments: [utterance(0, 'Speaker 1'), utterance(1, 'Speaker 2'), utterance(2, 'Speaker 1')],
});

const fileResult = (over = {}) => ({
  id: 'rec-1',
  name: 'Landing zone review',
  start_at: '2026-08-06T09:35:00.000Z',
  duration: 93_010,
  source_list: [],
  ...over,
});

/** An MCP outcome carrying JSON as text, the way the proxy hands it back. */
const okOutcome = (value) => ({ ok: true, result: JSON.stringify(value), raw: {} });

const script = (over = {}) => ({
  title: 'Landing zones, retold',
  summary: 'What the session decided.',
  keyTakeaways: ['Hub owns DNS'],
  speakers: { a: 'Maya', b: 'Elena' },
  dialogue: [{ speaker: 'Maya', text: 'Hello' }],
  byteLength: 5,
  trimmedTurns: 0,
  truncated: false,
  attributionLeaks: [],
  source: { kind: 'plaud', recordingId: 'rec-1', title: 'Landing zone review' },
  ...over,
});

function makeStore({ recordings = {}, mcp = {} } = {}) {
  const docs = {
    [RECORDINGS_CONTAINER]: recordings,
    mcp_servers: mcp,
    [TRANSCRIPT_CONTAINER]: {},
    ai_usage: {},
  };
  return {
    docs,
    readDoc: vi.fn(async (container, id) => docs[container]?.[id] ?? null),
    upsertDoc: vi.fn(async (container, doc) => {
      docs[container] ??= {};
      docs[container][doc.id] = doc;
      return doc;
    }),
    patchDoc: vi.fn(),
  };
}

const makeStorage = () => ({ uploadBlob: vi.fn(async () => 'https://ignored') });
const makeAi = () => ({ generateJsonResponse: vi.fn(), getCostEstimate: vi.fn(() => 0.01) });

/** A Plaud that answers both reads. */
const happyCallTool = () =>
  vi.fn(async ({ tool }) => {
    if (tool === 'get_file') return okOutcome(fileResult());
    if (tool === 'get_transcript') return okOutcome(transcriptResult());
    return { ok: false, error: `unexpected tool ${tool}` };
  });

const happyDeps = (over = {}) => ({
  callTool: happyCallTool(),
  writeScript: vi.fn(async ({ usageOut }) => {
    usageOut?.push({ provider: 'anthropic', model: 'claude-sonnet-4-6', promptTokens: 10, completionTokens: 20 });
    return script();
  }),
  synthesize: vi.fn(async () => ({
    audio: Buffer.from([1, 2, 3]),
    contentType: 'audio/mpeg',
    bytes: 3,
    requests: 1,
    provider: 'gemini',
    model: 'gemini-2.5-flash-preview-tts',
    estimatedSeconds: 42,
    promptTokens: 100,
    completionTokens: 900,
  })),
  ...over,
});

const run = ({ store = makeStore(), storage = makeStorage(), ai = makeAi(), deps, ...over } = {}) =>
  generateTranscriptFromRecording({
    recordingId: 'rec-1',
    store,
    storage,
    ai,
    env: {},
    now: NOW,
    deps: happyDeps(deps),
    ...over,
  });

describe('parseRecordingPayload', () => {
  it('accepts exactly one id, trimmed', () => {
    expect(parseRecordingPayload({ recordingId: ' rec-1 ' })).toEqual({
      value: { recordingId: 'rec-1' },
    });
    expect(parseRecordingPayload({ storedRecordingId: 'a1b2' })).toEqual({
      value: { storedRecordingId: 'a1b2' },
    });
  });

  it('refuses none, both, oversized and unkeyable ids without throwing', () => {
    expect(parseRecordingPayload(undefined).error).toMatch(/recordingId or storedRecordingId is required/);
    expect(parseRecordingPayload({}).error).toMatch(/is required/);
    expect(parseRecordingPayload({ recordingId: 'a', storedRecordingId: 'b' }).error).toMatch(/not both/);
    expect(parseRecordingPayload({ recordingId: 'x'.repeat(201) }).error).toBe('recordingId is too long');
    expect(parseRecordingPayload({ storedRecordingId: '../etc' }).error).toMatch(
      /storedRecordingId contains characters/
    );
    expect(parseRecordingPayload({ recordingId: 42 }).error).toMatch(/is required/);
  });

  it('exports the job type the handler and the worker share', () => {
    expect(RECORDING_JOB_TYPE).toBe('generate-podcast-transcript-from-recording');
  });
});

describe('credential failure detection', () => {
  it('reads the proxy code, the Plaud revocation code and a bare 401', () => {
    expect(isPlaudCredentialFailure({ ok: false, code: 'UNAUTHENTICATED', error: 'x' })).toBe(true);
    expect(isPlaudCredentialFailure({ ok: false, error: 'CLIENT_USER_AUTH_REVOKED' })).toBe(true);
    expect(isPlaudCredentialFailure({ ok: false, error: 'MCP server returned HTTP 401' })).toBe(true);
    expect(isPlaudCredentialFailure({ ok: false, error: 'MCP server returned HTTP 500' })).toBe(false);
    expect(isPlaudCredentialFailure({ ok: true, result: '{}' })).toBe(false);
  });

  it('refuses at the door when no token is stored, and only then', () => {
    expect(refusalForPlaud(null)).toBe(PLAUD_CONNECT_SENTENCE);
    expect(refusalForPlaud({ id: 'plaud', enabled: true })).toBe(PLAUD_CONNECT_SENTENCE);
    expect(refusalForPlaud({ id: 'plaud', oauthToken: '   ' })).toBe(PLAUD_CONNECT_SENTENCE);
    expect(refusalForPlaud({ id: 'plaud', oauthToken: 'eyJ…' })).toBeNull();
  });

  it('parses JSON text, prefers structuredContent, and gives null for neither', () => {
    expect(parseToolResult(okOutcome({ a: 1 }))).toEqual({ a: 1 });
    expect(parseToolResult({ ok: true, result: 'x', raw: { structuredContent: { b: 2 } } })).toEqual({
      b: 2,
    });
    expect(parseToolResult({ ok: true, result: 'not json' })).toBeNull();
  });
});

describe('readPlaudRecording', () => {
  it('reads the file for its title and times, the transcript for its segments', async () => {
    const callTool = happyCallTool();
    const out = await readPlaudRecording({ callTool, recordingId: 'rec-1' });
    expect(callTool.mock.calls.map((c) => c[0].tool)).toEqual(['get_file', 'get_transcript']);
    expect(callTool).toHaveBeenCalledWith({ tool: 'get_file', arguments: { file_id: 'rec-1' } });
    expect(out.recording).toMatchObject({
      id: 'rec-1',
      title: 'Landing zone review',
      recordedAt: '2026-08-06T09:35:00.000Z',
      durationMs: 93_010,
    });
    expect(out.segments).toHaveLength(3);
    expect(out.segments[0]).toMatchObject({ startMs: 3080, speaker: 'Speaker 1' });
  });

  it("falls back to get_file's source_list when get_transcript is empty", async () => {
    const callTool = vi.fn(async ({ tool }) => {
      if (tool === 'get_file') {
        return okOutcome(
          fileResult({
            source_list: [{ data_type: 'transaction', data: transcriptResult().segments }],
          })
        );
      }
      return okOutcome({ file_id: 'rec-1', segments: [] });
    });
    const out = await readPlaudRecording({ callTool, recordingId: 'rec-1' });
    expect(out.segments).toHaveLength(3);
  });

  it('names the Connect tab when either read is a credential failure', async () => {
    const revoked = vi.fn(async () => ({ ok: false, error: 'CLIENT_USER_AUTH_REVOKED' }));
    await expect(readPlaudRecording({ callTool: revoked, recordingId: 'rec-1' })).rejects.toThrow(
      PLAUD_CONNECT_SENTENCE
    );

    const revokedOnTranscript = vi.fn(async ({ tool }) =>
      tool === 'get_file' ? okOutcome(fileResult()) : { ok: false, code: 'UNAUTHENTICATED', error: 'x' }
    );
    await expect(
      readPlaudRecording({ callTool: revokedOnTranscript, recordingId: 'rec-1' })
    ).rejects.toThrow(PLAUD_CONNECT_SENTENCE);
  });

  it('names the tool and the recording on any other failure', async () => {
    // The tool's text stays out of the stored sentence; its code does not (#945).
    const broken = vi.fn(async () => ({ ok: false, error: 'MCP server returned HTTP 502' }));
    await expect(readPlaudRecording({ callTool: broken, recordingId: 'rec-1' })).rejects.toThrow(
      'Plaud could not return get_file for recording rec-1.'
    );
    const coded = vi.fn(async () => ({ ok: false, error: 'the tool said so', code: -32603 }));
    await expect(readPlaudRecording({ callTool: coded, recordingId: 'rec-1' })).rejects.toThrow(
      'Plaud could not return get_file for recording rec-1 (-32603).'
    );
  });
});

describe('a full run from the Plaud library', () => {
  it('reads through the MCP, scripts with the podcast feature, voices, saves plaud_<id>, records spend', async () => {
    const store = makeStore();
    const storage = makeStorage();
    const deps = happyDeps();
    const ai = makeAi();

    const report = await generateTranscriptFromRecording({
      recordingId: 'rec-1',
      store,
      storage,
      ai,
      env: {},
      now: NOW,
      deps,
    });

    const { recording, segments, generate } = deps.writeScript.mock.calls[0][0];
    expect(recording).toMatchObject({ id: 'rec-1', title: 'Landing zone review' });
    expect(segments).toHaveLength(3);
    await generate({ prompt: 'p', purpose: 'analysis' });
    expect(ai.generateJsonResponse).toHaveBeenCalledWith({
      prompt: 'p',
      purpose: 'analysis',
      feature: 'podcastScript',
    });

    expect(storage.uploadBlob.mock.calls[0].slice(0, 2)).toEqual(['podcast', 'plaud/rec-1.mp3']);
    expect(storage.uploadBlob.mock.calls[0][4]).toEqual({
      sourceKind: 'plaud',
      sourceId: 'rec-1',
      sourceSlug: '',
    });

    const saved = store.docs[TRANSCRIPT_CONTAINER]['plaud_rec-1'];
    expect(saved).toMatchObject({
      id: 'plaud_rec-1',
      sourceKind: 'plaud',
      sourceId: 'rec-1',
      sourceSlug: null,
      sourceTitle: 'Landing zone review',
      sourceProvider: null,
      status: STATUS.draft,
      audioUrl: '/api/public/media/podcast/plaud/rec-1.mp3',
      audioError: null,
      source: { kind: 'plaud', recordingId: 'rec-1', title: 'Landing zone review' },
      attributionLeaks: [],
      host: null,
    });

    expect(Object.values(store.docs.ai_usage).map((r) => r.source).sort()).toEqual(
      ['ai:podcastVoice', USAGE_SOURCES.podcastScript].sort()
    );
    expect(report).toMatchObject({
      id: 'plaud_rec-1',
      sourceKind: 'plaud',
      recordingId: 'rec-1',
      storedRecordingId: null,
      status: STATUS.draft,
      audioBytes: 3,
      attributionLeaks: [],
      costUsd: 0.02,
    });
  });

  it('carries the generator’s attribution leaks onto the document and the report', async () => {
    const store = makeStore();
    const report = await run({
      store,
      deps: { writeScript: vi.fn(async () => script({ attributionLeaks: ['Speaker 2'] })) },
    });
    expect(store.docs[TRANSCRIPT_CONTAINER]['plaud_rec-1'].attributionLeaks).toEqual(['Speaker 2']);
    expect(report.attributionLeaks).toEqual(['Speaker 2']);
  });
});

describe('a full run from a stored recording', () => {
  it('reads recordings/<id>, never calls the MCP, and saves recording_<id>', async () => {
    const store = makeStore({
      recordings: {
        'a1b2-c3': {
          id: 'a1b2-c3',
          title: 'Uploaded stand-up',
          source: 'plaud-embedded',
          createdAt: NOW,
          durationMs: 120_000,
          segments: [
            { startMs: 0, endMs: 30_000, text: line(0), speaker: 'Speaker 1' },
            { startMs: 30_000, endMs: 60_000, text: line(1), speaker: 'Speaker 2' },
          ],
        },
      },
    });
    const deps = happyDeps();
    const report = await run({ store, deps, recordingId: undefined, storedRecordingId: 'a1b2-c3' });

    expect(deps.callTool).not.toHaveBeenCalled();
    const { recording, segments } = deps.writeScript.mock.calls[0][0];
    expect(recording).toMatchObject({ id: 'a1b2-c3', title: 'Uploaded stand-up', durationMs: 120_000 });
    expect(segments).toHaveLength(2);
    expect(store.docs[TRANSCRIPT_CONTAINER]['recording_a1b2-c3']).toMatchObject({
      sourceKind: 'recording',
      sourceId: 'a1b2-c3',
      sourceTitle: 'Uploaded stand-up',
    });
    expect(report).toMatchObject({ id: 'recording_a1b2-c3', storedRecordingId: 'a1b2-c3', recordingId: null });
  });

  it('reads a manual paste through the normaliser’s plain-text rules', async () => {
    const store = makeStore({
      recordings: {
        paste1: {
          id: 'paste1',
          title: 'Pasted notes',
          source: 'manual_upload',
          transcript: `Speaker 1: ${line(0)}\nSpeaker 2: ${line(1)}`,
        },
      },
    });
    const deps = happyDeps();
    await run({ store, deps, recordingId: undefined, storedRecordingId: 'paste1' });
    const { segments } = deps.writeScript.mock.calls[0][0];
    expect(segments.map((s) => s.speaker)).toEqual(['Speaker 1', 'Speaker 2']);
  });

  it('refuses a missing stored recording by name, before the model', async () => {
    const deps = happyDeps();
    await expect(run({ deps, recordingId: undefined, storedRecordingId: 'nope' })).rejects.toThrow(
      /Recording nope was not found/
    );
    expect(deps.writeScript).not.toHaveBeenCalled();
  });
});

describe('refusals cost nothing', () => {
  it('a revoked credential: the Connect-tab sentence, generate never called, nothing written', async () => {
    const store = makeStore();
    const ai = makeAi();
    const deps = happyDeps({
      callTool: vi.fn(async () => ({ ok: false, error: 'MCP server returned HTTP 401', code: 'UNAUTHENTICATED' })),
    });
    await expect(run({ store, ai, deps })).rejects.toThrow(PLAUD_CONNECT_SENTENCE);

    expect(deps.writeScript).not.toHaveBeenCalled();
    expect(ai.generateJsonResponse).not.toHaveBeenCalled();
    expect(deps.synthesize).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('an empty transcript: the real generator refuses before calling generate, and the failure is recorded', async () => {
    // No writeScript override: this is generateRecordingScript itself,
    // guarding the case where both reads succeeded and said nothing.
    const store = makeStore();
    const ai = makeAi();
    const callTool = vi.fn(async ({ tool }) =>
      tool === 'get_file' ? okOutcome(fileResult()) : okOutcome({ file_id: 'rec-1', segments: [] })
    );
    // `writeScript: undefined` falls through resolvePipelineDeps to the real generator.
    await expect(run({ store, ai, deps: { callTool, writeScript: undefined } })).rejects.toThrow(
      /no transcript text/
    );

    expect(ai.generateJsonResponse).not.toHaveBeenCalled();
    expect(store.docs[TRANSCRIPT_CONTAINER]['plaud_rec-1']).toMatchObject({
      status: STATUS.failed,
      sourceKind: 'plaud',
      error: expect.stringMatching(/no transcript text/),
    });
  });

  it('requires an id, with the sentences the route uses', async () => {
    await expect(run({ recordingId: '  ' })).rejects.toThrow(/is required/);
  });
});

describe('audio failures degrade; the transcript is still saved', () => {
  it('a broken provider is recorded on the draft, not thrown', async () => {
    const store = makeStore();
    const report = await run({
      store,
      deps: {
        synthesize: vi.fn(async () => {
          throw new SpeechError('TTS returned 401');
        }),
      },
    });
    const saved = store.docs[TRANSCRIPT_CONTAINER]['plaud_rec-1'];
    expect(saved.status).toBe(STATUS.draft);
    expect(saved.audioUrl).toBeNull();
    expect(saved.audioError).toBe('TTS returned 401');
    expect(report.audioError).toBe('TTS returned 401');
    expect(Object.values(store.docs.ai_usage).map((r) => r.source)).toEqual([USAGE_SOURCES.podcastScript]);
  });
});

describe('script failures', () => {
  it('records the failure under the recording id and rethrows the model error', async () => {
    const store = makeStore();
    await expect(
      run({
        store,
        deps: {
          writeScript: vi.fn(async () => {
            throw new Error('model refused');
          }),
        },
      })
    ).rejects.toThrow('model refused');
    expect(store.docs[TRANSCRIPT_CONTAINER]['plaud_rec-1']).toMatchObject({
      status: STATUS.failed,
      error: 'The script could not be written (Error).',
      sourceTitle: 'Landing zone review',
    });
  });
});
