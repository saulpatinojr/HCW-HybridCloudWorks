/**
 * The speak-chapter job (ADR 0033 §4): its payload rules, its registration,
 * and the run — a new active version on success with the status kept, a
 * recorded error with the current take kept on failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const registered = [];
vi.mock('../lib/jobs.js', async (importOriginal) => ({
  ...(await importOriginal()),
  registerJobType: vi.fn((type, spec) => registered.push({ type, spec })),
}));

const docs = {
  listen_and_learn: {},
  listen_and_learn_episodes: {},
  admin_config: {},
  ai_usage: {},
};
vi.mock('../lib/cosmos-client.js', () => ({
  readDoc: vi.fn(async (container, id) => docs[container]?.[id] ?? null),
  upsertDoc: vi.fn(async (container, doc) => {
    docs[container] ||= {};
    docs[container][doc.id] = doc;
    return doc;
  }),
  patchDoc: vi.fn(async (container, id, updates) => {
    docs[container][id] = { ...(docs[container][id] || { id }), ...updates };
    return docs[container][id];
  }),
  createDoc: vi.fn(async (container, doc) => {
    docs[container] ||= {};
    docs[container][doc.id || Math.random()] = doc;
    return doc;
  }),
  ADMIN_CONFIG_PARTITION: 'admin_config',
}));
const uploadBlob = vi.fn(async () => {});
vi.mock('../lib/blob-storage.js', () => ({ uploadBlob: (...args) => uploadBlob(...args) }));

const synthesizeDialogue = vi.fn();
vi.mock('../lib/listen-and-learn/speech/index.js', async (importOriginal) => ({
  ...(await importOriginal()),
  synthesizeDialogue: (...args) => synthesizeDialogue(...args),
}));
vi.mock('../lib/ai/usage.js', async (importOriginal) => ({
  ...(await importOriginal()),
  recordAiUsageBatch: vi.fn(async (_deps, rows) =>
    rows.map((r) => ({ ...r, estimatedCostUsd: 0.01 }))
  ),
}));

const { parseSpeakChapterPayload, runSpeakChapter } = await import('./listen-and-learn-jobs.js');
const { SPEAK_CHAPTER_JOB_TYPE } = await import('../lib/listen-and-learn/handlers.js');
const { STATUS } = await import('../lib/listen-and-learn/publish.js');

const context = { log: vi.fn() };
const payload = { platform: 'azure', examCode: 'AZ-104', chapterId: 'manual_x' };

beforeEach(() => {
  docs.listen_and_learn = {
    'azure_az-104': { id: 'azure_az-104', voice: { narrator: 'Puck', speakingRate: 1.2 } },
  };
  docs.listen_and_learn_episodes = {
    manual_x: {
      id: 'manual_x',
      setId: 'azure_az-104',
      kind: 'manual',
      title: 'Chapter X',
      order: 2,
      status: STATUS.published,
      approvedBy: 'o',
      sourceText: 'Read me.',
      audioUrl: '/u/old',
      audioPath: 'azure/az-104/manual_x-20260101000000.mp3',
    },
  };
  synthesizeDialogue.mockReset();
  uploadBlob.mockClear();
});

describe('parseSpeakChapterPayload', () => {
  it('accepts the set and chapter, ignores a model (the task’s, ADR 0034 slice 5) and refuses a malformed id', () => {
    expect(parseSpeakChapterPayload({ ...payload, platform: 'AZURE' }).value).toEqual({
      platform: 'azure',
      examCode: 'AZ-104',
      chapterId: 'manual_x',
    });
    expect(parseSpeakChapterPayload({ ...payload, ttsModel: 'nope' }).value).not.toHaveProperty(
      'ttsModel'
    );
    expect(parseSpeakChapterPayload({ ...payload, chapterId: '../x' }).error).toMatch(/chapterId/);
    expect(parseSpeakChapterPayload({}).error).toMatch(/platform/);
  });
});

describe('registration', () => {
  it('registers the speak job as editor with a small payload, beside the guide job', () => {
    const job = registered.find((r) => r.type === SPEAK_CHAPTER_JOB_TYPE);
    expect(job).toBeTruthy();
    expect(job.spec.role).toBe('editor');
    expect(job.spec.maxPayloadBytes).toBe(1024);
    expect(job.spec.worker).toBe(runSpeakChapter);
    expect(registered.find((r) => r.type === 'generate-listen-and-learn')).toBeTruthy();
  });
});

describe('runSpeakChapter', () => {
  it('speaks the text as a narrator in the book’s voice, uploads a stamped take and keeps the chapter published', async () => {
    synthesizeDialogue.mockResolvedValue({
      audio: Buffer.from([1, 2, 3]),
      contentType: 'audio/mpeg',
      bytes: 3,
      provider: 'gemini',
      model: 'gemini-2.5-flash-preview-tts',
      estimatedSeconds: 4,
      requests: 1,
    });
    const report = await runSpeakChapter(payload, {
      context,
      job: { requestedBy: { oid: 'actor' } },
    });

    const call = synthesizeDialogue.mock.calls[0][0];
    expect(call.dialogue).toEqual([{ speaker: 'Narrator', text: 'Read me.' }]);
    expect(call.voices).toEqual({ Narrator: 'Puck' });
    expect(call.speakingRate).toBe(1.2);
    expect(call.product).toBe('listenAndLearn');

    const [container, path] = uploadBlob.mock.calls[0];
    expect(container).toBe('listenandlearn');
    expect(path).toMatch(/^azure\/az-104\/manual_x-\d{14}\.mp3$/);

    const doc = docs.listen_and_learn_episodes.manual_x;
    expect(doc.status).toBe(STATUS.published);
    expect(doc.approvedBy).toBe('o');
    expect(doc.versions.map((v) => v.active)).toEqual([false, true]);
    expect(doc.versions[1]).toMatchObject({
      generatedBy: 'actor',
      speechProvider: 'gemini',
      costUsd: 0.01,
    });
    expect(doc.audioPath).toBe(path);
    expect(doc.lastError).toBeNull();
    expect(report).toMatchObject({
      chapterId: 'manual_x',
      status: 'published',
      generated: 1,
      withoutAudio: 0,
    });
  });

  it('on a synthesis failure keeps the current take and status and records lastError, then fails the job', async () => {
    const err = new Error('Gemini TTS HTTP 500: boom');
    err.name = 'SpeechError';
    synthesizeDialogue.mockRejectedValue(err);
    await expect(runSpeakChapter(payload, { context })).rejects.toThrow(/HTTP 500/);
    const doc = docs.listen_and_learn_episodes.manual_x;
    expect(doc.status).toBe(STATUS.published);
    expect(doc.audioUrl).toBe('/u/old');
    // The chapter stores a sentence with the error's code, never the
    // provider's words (#945).
    expect(doc.lastError).toMatchObject({
      message: 'The chapter could not be voiced (SpeechError).',
      attempt: 'regeneration',
    });
    expect(JSON.stringify(doc)).not.toContain('boom');
    expect(uploadBlob).not.toHaveBeenCalled();
  });

  it('with no speech provider records audioError and changes nothing else', async () => {
    const err = new Error('No Listen & Learn speech provider is configured');
    err.name = 'SpeechNotConfiguredError';
    synthesizeDialogue.mockRejectedValue(err);
    const report = await runSpeakChapter(payload, { context });
    expect(report.withoutAudio).toBe(1);
    expect(docs.listen_and_learn_episodes.manual_x.audioError).toMatch(
      /not configured|is configured/
    );
    expect(docs.listen_and_learn_episodes.manual_x.audioUrl).toBe('/u/old');
  });

  it('refuses a chapter with no text or that does not exist', async () => {
    docs.listen_and_learn_episodes.manual_x.sourceText = '';
    await expect(runSpeakChapter(payload, { context })).rejects.toThrow(/no text to speak/);
    await expect(
      runSpeakChapter({ ...payload, chapterId: 'manual_missing' }, { context })
    ).rejects.toThrow(/No chapter/);
    expect(synthesizeDialogue).not.toHaveBeenCalled();
  });
});
