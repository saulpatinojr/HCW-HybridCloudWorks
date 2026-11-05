/**
 * The interview jobs' registrations and thin workers (ADR 0040): each type
 * is registered at editor with its payload bound and budget, each worker
 * refuses a bad payload with the shared rule before touching a dependency,
 * and passes the job's signal and context on. The pipelines themselves are
 * tested in lib/interviews/*.test.js; here they are seams.
 */
import { describe, it, expect, vi } from 'vitest';

// The module registers job types on import, and registerJobType throws on a
// duplicate — so the registry is faked rather than shared across test files.
const registerJobType = vi.fn();
vi.mock('../lib/jobs.js', async (importOriginal) => ({
  ...(await importOriginal()),
  registerJobType: (...args) => registerJobType(...args),
}));
vi.mock('../lib/cosmos-client.js', () => ({
  readDoc: vi.fn(),
  upsertDoc: vi.fn(),
  patchDoc: vi.fn(),
  queryDocs: vi.fn(),
}));
vi.mock('../lib/blob-storage.js', () => ({
  deleteBlob: vi.fn(),
  downloadBlobStream: vi.fn(),
  readBlobForDelivery: vi.fn(),
  uploadBlob: vi.fn(),
  uploadBlobFromStream: vi.fn(),
}));
vi.mock('../lib/auth/default-guard.js', () => ({ getDefaultGuard: () => ({ requireRole: vi.fn() }) }));
vi.mock('@azure/functions', () => ({
  app: { http: vi.fn() },
  output: { storageQueue: (options) => ({ type: 'queue', ...options }) },
}));
const fetchAudioToContainer = vi.fn(async () => ({ bytes: 1 }));
vi.mock('../lib/interviews/fetch-audio.js', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchAudioToContainer: (...args) => fetchAudioToContainer(...args),
}));
const transcribeInterview = vi.fn(async () => ({ windows: 1 }));
vi.mock('../lib/interviews/transcribe.js', async (importOriginal) => ({
  ...(await importOriginal()),
  transcribeInterview: (...args) => transcribeInterview(...args),
}));
const draftInterview = vi.fn(async () => ({ items: 1 }));
vi.mock('../lib/interviews/draft.js', async (importOriginal) => ({
  ...(await importOriginal()),
  draftInterview: (...args) => draftInterview(...args),
}));

const { runDraft, runFetchAudio, runTranscribe } = await import('./interviews-jobs.js');
const registrations = [...registerJobType.mock.calls];
const { app } = await import('@azure/functions');
// Copied at import time for the same reason: the routes are registered once.
const httpRegistrations = [...app.http.mock.calls];
const context = { log: vi.fn(), warn: vi.fn() };

describe('registrations', () => {
  it('registers the three types at editor, with a 1 KiB payload and their budgets', () => {
    const specs = Object.fromEntries(registrations.map(([type, spec]) => [type, spec]));
    expect(Object.keys(specs).sort()).toEqual(['interview-draft', 'interview-fetch-audio', 'interview-transcribe']);
    for (const spec of Object.values(specs)) {
      expect(spec.role).toBe('editor');
      expect(spec.maxPayloadBytes).toBe(1024);
      expect(typeof spec.worker).toBe('function');
    }
    expect(specs['interview-fetch-audio'].timeoutMs).toBe(10 * 60 * 1000);
    expect(specs['interview-transcribe'].timeoutMs).toBe(25 * 60 * 1000);
    expect(specs['interview-draft'].timeoutMs).toBe(5 * 60 * 1000);
  });
});

describe('the workers', () => {
  it('refuse a bad payload with the shared rule, as a JobFailedError, before any dependency is touched', async () => {
    await expect(runFetchAudio({ interviewId: 'int-1', sourceUrl: 'http://x.example/a.mp3' }, { context })).rejects.toMatchObject({ message: 'Only an https:// URL is fetched.' });
    await expect(runTranscribe({ interviewId: 'int-1' }, { context })).rejects.toMatchObject({ message: expect.stringMatching(/transcriptVersion/) });
    await expect(runDraft({}, { context })).rejects.toMatchObject({ message: 'interviewId is required.' });
    expect(fetchAudioToContainer).not.toHaveBeenCalled();
    expect(transcribeInterview).not.toHaveBeenCalled();
    expect(draftInterview).not.toHaveBeenCalled();
  });

  it('hand the parsed payload, the context as the log and the signal to their pipelines', async () => {
    const signal = new AbortController().signal;
    await expect(runFetchAudio({ interviewId: 'int-1', sourceUrl: 'https://x.example/a.mp3' }, { context, signal })).resolves.toEqual({ bytes: 1 });
    expect(fetchAudioToContainer.mock.calls[0][0]).toMatchObject({ interviewId: 'int-1', sourceUrl: 'https://x.example/a.mp3', log: context, signal });
    await expect(runTranscribe({ interviewId: 'int-1', transcriptVersion: '2' }, { context, signal, job: { id: 'job-9' } })).resolves.toEqual({ windows: 1 });
    expect(transcribeInterview.mock.calls[0][0]).toMatchObject({ interviewId: 'int-1', transcriptVersion: 2, log: context, signal, jobId: 'job-9' });
    expect(Object.keys(transcribeInterview.mock.calls[0][0].storage).sort()).toEqual(['deleteBlob', 'downloadBlobStream', 'readBlobForDelivery', 'uploadBlob']);
    await expect(runDraft({ interviewId: 'int-1', transcriptVersion: 1 }, { context, signal })).resolves.toEqual({ items: 1 });
    expect(draftInterview.mock.calls[0][0]).toMatchObject({ interviewId: 'int-1', transcriptVersion: 1, log: context, signal });
  });

  it('stop at once on a signal that has already fired', async () => {
    const controller = new AbortController();
    controller.abort(new Error('job timed out'));
    for (const run of [runFetchAudio, runTranscribe, runDraft]) {
      await expect(run({ interviewId: 'int-1', transcriptVersion: 1, sourceUrl: 'https://x.example/a.mp3' }, { context, signal: controller.signal })).rejects.toThrow('job timed out');
    }
  });
});

describe('the routes', () => {
  it('registers the four cms/interviews routes, the three enqueues with the jobs queue output and the transcript route without', async () => {
    const byRoute = Object.fromEntries(httpRegistrations.map(([, options]) => [options.route, options]));
    expect(Object.keys(byRoute).sort()).toEqual([
      'cms/interviews/{id}/audio-from-url',
      'cms/interviews/{id}/draft',
      'cms/interviews/{id}/transcribe',
      'cms/interviews/{id}/transcript',
    ]);
    for (const route of ['cms/interviews/{id}/audio-from-url', 'cms/interviews/{id}/transcribe', 'cms/interviews/{id}/draft']) {
      expect(byRoute[route].extraOutputs, route).toEqual([{ type: 'queue', queueName: 'platform-jobs', connection: 'AzureWebJobsStorage' }]);
    }
    expect(byRoute['cms/interviews/{id}/transcript'].extraOutputs).toBeUndefined();
    for (const options of Object.values(byRoute)) {
      expect(options.methods).toEqual(['POST', 'OPTIONS']);
      expect(options.authLevel).toBe('anonymous');
    }
  });
});
