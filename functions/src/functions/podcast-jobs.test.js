/**
 * Generation payload validation and the job's registration.
 *
 * The pipeline itself is tested in lib/podcast/generate.test.js; this pins
 * the thin adapter — what the worker accepts, and that it registers at the
 * role of the route that enqueues it.
 */
import { describe, it, expect, vi } from 'vitest';

// The module registers a job type on import, and registerJobType throws on a
// duplicate — so the registry is faked rather than shared across test files.
const registerJobType = vi.fn();
vi.mock('../lib/jobs.js', async (importOriginal) => ({
  ...(await importOriginal()),
  registerJobType: (...args) => registerJobType(...args),
}));
const readDoc = vi.fn();
const patchDoc = vi.fn();
vi.mock('../lib/cosmos-client.js', () => ({
  readDoc: (...args) => readDoc(...args),
  upsertDoc: vi.fn(),
  patchDoc: (...args) => patchDoc(...args),
}));
const deleteBlob = vi.fn();
vi.mock('../lib/blob-storage.js', () => ({
  uploadBlob: vi.fn(),
  readBlobForDelivery: vi.fn(),
  deleteBlob: (...args) => deleteBlob(...args),
}));
vi.mock('../lib/ai/router.js', async (importOriginal) => ({
  ...(await importOriginal()),
  generateJsonResponse: vi.fn(),
  getCostEstimate: vi.fn(),
}));
vi.mock('../lib/cms/publish.js', () => ({ publicUrlOf: vi.fn(() => '') }));
// The upload worker's pipeline is tested in lib/podcast/recording-upload.test.js;
// here it is a seam so the dependencies the worker wires can be inspected.
const transcribeUpload = vi.fn();
vi.mock('../lib/podcast/recording-upload.js', async (importOriginal) => ({
  ...(await importOriginal()),
  transcribeUpload: (...args) => transcribeUpload(...args),
}));

const {
  parsePublishPayload,
  parseTranscriptPayload,
  runTranscriptGeneration,
  runTranscriptPublish,
  runRecordingGeneration,
  runUploadTranscription,
} = await import('./podcast-jobs.js');

// Registration happens once, on import. Vitest 5 clears mock call history
// before each test by default, so the import-time calls are copied here
// before any test runs, rather than read from the mock inside a test.
const registrations = [...registerJobType.mock.calls];

describe('parseTranscriptPayload', () => {
  it('accepts an article id and trims it', () => {
    expect(parseTranscriptPayload({ articleId: ' content-1 ' })).toEqual({
      value: { articleId: 'content-1' },
    });
  });

  it('refuses a missing, blank, non-string or oversized id without throwing', () => {
    expect(parseTranscriptPayload(undefined).error).toBe('articleId is required');
    expect(parseTranscriptPayload({}).error).toBe('articleId is required');
    expect(parseTranscriptPayload({ articleId: '  ' }).error).toBe('articleId is required');
    expect(parseTranscriptPayload({ articleId: 42 }).error).toBe('articleId is required');
    expect(parseTranscriptPayload({ articleId: 'x'.repeat(201) }).error).toBe('articleId is too long');
  });
});

describe('runTranscriptGeneration', () => {
  it('fails a bad payload with the validation message before touching anything', async () => {
    await expect(runTranscriptGeneration({}, { context: { log: vi.fn() } })).rejects.toThrow(
      'articleId is required'
    );
  });
});

describe('parsePublishPayload', () => {
  it('accepts a transcript id and trims it; refuses the rest without throwing', () => {
    expect(parsePublishPayload({ transcriptId: ' article_x ' })).toEqual({
      value: { transcriptId: 'article_x' },
    });
    expect(parsePublishPayload(undefined).error).toBe('transcriptId is required');
    expect(parsePublishPayload({ transcriptId: 7 }).error).toBe('transcriptId is required');
    // Bounded by UTF-8 bytes (Cosmos's 1,023), so a wide-character id of
    // fewer characters is refused too.
    expect(parsePublishPayload({ transcriptId: 'x'.repeat(1024) }).error).toBe(
      'transcriptId is too long'
    );
    expect(parsePublishPayload({ transcriptId: '語'.repeat(400) }).error).toBe(
      'transcriptId is too long'
    );
  });
});

describe('runTranscriptPublish', () => {
  it('fails a bad payload with the validation message before touching anything', async () => {
    readDoc.mockClear();
    await expect(runTranscriptPublish({}, { context: { log: vi.fn() } })).rejects.toThrow(
      'transcriptId is required'
    );
    expect(readDoc).not.toHaveBeenCalled();
  });

  it('records a skip on the document with no key seeded, and reports it — never an error', async () => {
    // No PODBEAN_* in this process: the client reports not configured, the
    // job stores `skipped` and succeeds. Approval stays exactly as written.
    vi.stubEnv('PODBEAN_CLIENT_ID', '');
    vi.stubEnv('PODBEAN_CLIENT_SECRET', '');
    readDoc.mockReset();
    patchDoc.mockReset();
    readDoc.mockResolvedValue({
      id: 'article_x',
      status: 'published',
      audioPath: 'article/x.mp3',
      host: { podbean: { pending: true, jobId: 'job-1' } },
    });
    patchDoc.mockResolvedValue({});
    const context = { log: vi.fn(), warn: vi.fn() };

    const report = await runTranscriptPublish({ transcriptId: 'article_x' }, { context });

    expect(report).toMatchObject({ id: 'article_x', skipped: 'not_configured', error: null });
    expect(patchDoc).toHaveBeenCalledTimes(1);
    const [container, id, patch] = patchDoc.mock.calls[0];
    expect(container).toBe('podcast_transcripts');
    expect(id).toBe('article_x');
    expect(Object.keys(patch)).toEqual(['host']);
    expect(patch.host.podbean).toMatchObject({ skipped: 'not_configured', error: null });
    expect(patch.host.podbean).not.toHaveProperty('pending');
    expect(context.log.mock.calls[0][0]).toMatch(/skipped \(not_configured\)/);
    vi.unstubAllEnvs();
  });
});

describe('registration', () => {
  it('registers generate-podcast-transcript at editor, the role of the route that enqueues it', () => {
    const [type, spec] = registrations.find(
      ([name]) => name === 'generate-podcast-transcript'
    );
    expect(type).toBe('generate-podcast-transcript');
    expect(spec.role).toBe('editor');
    expect(typeof spec.worker).toBe('function');
    // One article id; a payload larger than this is not one.
    expect(spec.maxPayloadBytes).toBeLessThanOrEqual(1024);
  });

  it('registers publish-podcast-transcript at publisher, the role of review and the retry', () => {
    const [type, spec] = registrations.find(
      ([name]) => name === 'publish-podcast-transcript'
    );
    expect(type).toBe('publish-podcast-transcript');
    expect(spec.role).toBe('publisher');
    expect(spec.worker).toBe(runTranscriptPublish);
    expect(spec.maxPayloadBytes).toBeLessThanOrEqual(1024);
    // Above the client's own deadlines (30 s token + 30 s authorise + 300 s PUT
    // + 30 s create, and one re-auth each for the two Podbean calls), so a slow host
    // is recorded as the client's error rather than as a job timeout.
    expect(spec.timeoutMs).toBeGreaterThan(510_000);
    expect(typeof spec.onComplete).toBe('function');
  });

  it('clears the pending marker when the publish job dies around the step, and stays quiet on success', async () => {
    const [, spec] = registrations.find(
      ([name]) => name === 'publish-podcast-transcript'
    );
    const now = () => new Date('2026-09-09T10:00:00.000Z');
    readDoc.mockReset();
    patchDoc.mockReset();
    readDoc.mockResolvedValue({
      id: 'article_x',
      status: 'published',
      host: { podbean: { pending: true, jobId: 'job-1' } },
    });
    patchDoc.mockResolvedValue({});

    await spec.onComplete(
      { job: { payload: { transcriptId: 'article_x' } }, status: 'timeout', error: 'job timed out' },
      { context: {}, now }
    );
    expect(patchDoc).toHaveBeenCalledTimes(1);
    expect(patchDoc.mock.calls[0][2].host.podbean).toEqual({
      lastAttemptAt: '2026-09-09T10:00:00.000Z',
      error: { status: null, code: 'JOB_TIMEOUT', message: 'job timed out', retryable: true },
    });

    patchDoc.mockClear();
    await spec.onComplete(
      { job: { payload: { transcriptId: 'article_x' } }, status: 'succeeded', error: null },
      { context: {}, now }
    );
    expect(patchDoc).not.toHaveBeenCalled();
  });
  it('registers the two recording-side jobs (#442) at editor, like the routes that enqueue them', () => {
    for (const name of ['generate-podcast-transcript-from-recording', 'transcribe-recording-upload']) {
      const [, spec] = registrations.find(([type]) => type === name);
      expect(spec.role, name).toBe('editor');
      expect(typeof spec.worker, name).toBe('function');
      expect(spec.maxPayloadBytes, name).toBeLessThanOrEqual(1024);
    }
  });
});

describe('recording-side workers', () => {
  it('wires the production deleteBlob into the upload worker, so the finally cleanup can run', async () => {
    // Without this the job's `finally` would find no storage seam and leave
    // every upload to the seven-day lifecycle rule.
    transcribeUpload.mockResolvedValueOnce({
      id: 'r1',
      transcriptionId: 't1',
      segments: 0,
      durationMs: null,
      uploadDeleted: true,
    });
    const ctx = { log: vi.fn(), warn: vi.fn() };
    await runUploadTranscription(
      { uploadPath: 'uploads/0d5c3d3e-1f5a-4a1c-9f6d-2b3c4d5e6f70.mp3', title: 't' },
      { context: ctx }
    );
    const deps = transcribeUpload.mock.calls[0][0];
    expect(typeof deps.storage?.deleteBlob).toBe('function');
    await deps.storage.deleteBlob('podcast', 'uploads/x.mp3');
    expect(deleteBlob).toHaveBeenCalledWith('podcast', 'uploads/x.mp3');
    expect(deps.log).toBe(ctx);
    expect(deps.timeoutMs).toBeLessThan(25 * 60 * 1000);
    expect(ctx.log.mock.calls[0][0]).toMatch(/upload deleted/);
  });

  it('fail a bad payload with the validation sentence before touching anything', async () => {
    const ctx = { context: { log: vi.fn() } };
    await expect(runRecordingGeneration({}, ctx)).rejects.toThrow(
      'recordingId or storedRecordingId is required'
    );
    await expect(runRecordingGeneration({ recordingId: 'a', storedRecordingId: 'b' }, ctx)).rejects.toThrow(
      /not both/
    );
    await expect(runUploadTranscription({ title: 't' }, ctx)).rejects.toThrow('uploadPath is required');
    await expect(runUploadTranscription({ uploadPath: 'article/x.mp3', title: 't' }, ctx)).rejects.toThrow(
      'uploadPath is not an upload path'
    );
  });
});

describe('podcast worker abort handling', () => {
  it('throws immediately when signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const signal = controller.signal;
    await expect(runTranscriptGeneration({ articleId: 'art-1' }, { signal })).rejects.toThrow();
    await expect(runTranscriptPublish({ transcriptId: 'tr-1' }, { signal })).rejects.toThrow();
    await expect(runRecordingGeneration({ recordingId: 'rec-1' }, { signal })).rejects.toThrow();
    await expect(
      runUploadTranscription(
        { uploadPath: 'uploads/0d5c3d3e-1f5a-4a1c-9f6d-2b3c4d5e6f70.mp3', title: 't' },
        { signal }
      )
    ).rejects.toThrow();
  });
});
