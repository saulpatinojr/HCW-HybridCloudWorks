/**
 * One source-grounded episode (#433): the payload rules and the run.
 *
 * The assertions that carry the weight are the refusals and the writes that
 * do NOT happen: a bad list is a sentence at the route, not a job; Gemini
 * absent from the chain is a sentence and zero store writes; and the guide
 * door is never opened for a source episode. The equality pin at the bottom
 * is the one that keeps the form honest — the browser classifies a URL with
 * a copy of the server's rule, and this test runs both over one table.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  LISTEN_AND_LEARN_JOB_TYPE,
  MAX_SOURCE_TITLE_LENGTH,
  generateSourceEpisode,
  parseSourceEpisodePayload,
  resolveSources,
} from './source-episode.js';
import { EPISODE_CONTAINER, SET_CONTAINER, SOURCE_EPISODE_ORDER, STATUS } from './publish.js';
import {
  SpeechNotConfiguredError,
  SpeechError,
  speechNotConfiguredMessage,
} from './speech/index.js';
import { USAGE_SOURCES } from '../ai/usage.js';
import {
  AiNotConfiguredError,
  GROUNDING_LIMITS,
  GroundingIncompleteError,
  isYouTubeVideoUrl,
  validateGroundingSources,
} from '../ai/router.js';
import { classifySourceUrl } from '../../../../frontend/src/lib/sourceUrl.js';

const NOW = '2026-09-09T12:00:00.000Z';

const page = { kind: 'page', url: 'https://example.com/entra', title: 'Entra overview' };
const video = { kind: 'video', url: 'https://www.youtube.com/watch?v=abc123' };

const payload = (over = {}) => ({
  platform: 'azure',
  examCode: 'AZ-104',
  title: 'Entra ID basics',
  sources: [page, video],
  certTitle: 'Azure Administrator',
  ...over,
});

const script = (over = {}) => ({
  title: 'Entra ID in ten minutes',
  summary: 'From an article and a video.',
  keyTakeaways: ['a'],
  speakers: { a: 'Maya', b: 'Elena' },
  dialogue: [{ speaker: 'Maya', text: 'Hello' }],
  byteLength: 5,
  trimmedTurns: 0,
  ...over,
});

function makeStore() {
  const docs = { [SET_CONTAINER]: {}, [EPISODE_CONTAINER]: {} };
  return {
    docs,
    readDoc: vi.fn(async (container, id) => docs[container]?.[id] ?? null),
    upsertDoc: vi.fn(async (container, doc) => {
      docs[container][doc.id] = doc;
      return doc;
    }),
    patchDoc: vi.fn(),
  };
}

const makeStorage = () => ({ uploadBlob: vi.fn(async () => 'ignored') });

const makeAi = () => ({
  generateGroundedJsonResponse: vi.fn(),
  generateJsonResponse: vi.fn(),
  getCostEstimate: vi.fn(() => 0.02),
});

const happyDeps = (over = {}) => ({
  writeScript: vi.fn(async () => script()),
  synthesize: vi.fn(async () => ({
    audio: Buffer.from([1, 2, 3]),
    contentType: 'audio/mpeg',
    bytes: 3,
    provider: 'gemini',
    model: 'gemini-2.5-flash-preview-tts',
    estimatedSeconds: 30,
  })),
  recordUsage: vi.fn(async (rows) => rows.map((r) => ({ ...r, estimatedCostUsd: 0.01 }))),
  ...over,
});

const run = (over = {}) =>
  generateSourceEpisode({
    platform: 'azure',
    examCode: 'AZ-104',
    title: 'Entra ID basics',
    sources: [page, video],
    cert: { title: 'Azure Administrator', slug: 'az-104' },
    store: makeStore(),
    storage: makeStorage(),
    ai: makeAi(),
    env: {},
    actorId: 'oid-1',
    now: NOW,
    deps: happyDeps(),
    ...over,
  });

describe('resolveSources', () => {
  it('returns the router-validated list, pages then videos, with titles kept', () => {
    expect(resolveSources([video, page])).toEqual([page, video]);
  });

  it('dedupes by exact URL and keeps the first title', () => {
    const out = resolveSources([
      { kind: 'page', url: 'https://example.com/a', title: 'First' },
      { kind: 'page', url: 'https://example.com/a', title: 'Second' },
      { kind: 'page', url: 'https://example.com/a ' },
    ]);
    expect(out).toEqual([{ kind: 'page', url: 'https://example.com/a', title: 'First' }]);
  });

  it('omits the title key when none was given, and bounds one that was', () => {
    expect(resolveSources([video])[0]).not.toHaveProperty('title');
    const long = resolveSources([{ ...page, title: 'x'.repeat(500) }]);
    expect(long[0].title).toHaveLength(200);
  });

  it('is the router refusing, in its sentences', () => {
    expect(() => resolveSources([])).toThrow(/at least one source/);
    expect(() =>
      resolveSources([{ kind: 'page', url: 'https://www.youtube.com/watch?v=abc' }])
    ).toThrow(/YouTube URL given as kind 'page'/);
  });
});

describe('parseSourceEpisodePayload', () => {
  it('accepts a well-formed request: kind source, the id, the resolved list', () => {
    const { value, error } = parseSourceEpisodePayload(payload({ platform: 'AZURE' }));
    expect(error).toBeUndefined();
    expect(value).toEqual({
      kind: 'source',
      platform: 'azure',
      examCode: 'AZ-104',
      title: 'Entra ID basics',
      areaSlug: 'source_entra-id-basics',
      sources: [page, video],
      cert: { title: 'Azure Administrator', slug: null },
    });
  });

  it('refuses a YouTube URL given as a page, with the router sentence', () => {
    const { error } = parseSourceEpisodePayload(
      payload({ sources: [{ kind: 'page', url: 'https://youtu.be/abc' }] })
    );
    expect(error).toMatch(
      /Source 1 \(https:\/\/youtu.be\/abc\) is a YouTube URL given as kind 'page'/
    );
  });

  it('refuses an over-cap list rather than truncating it', () => {
    const sources = Array.from({ length: GROUNDING_LIMITS.pages + 1 }, (_, i) => ({
      kind: 'page',
      url: `https://example.com/p${i}`,
    }));
    const { error } = parseSourceEpisodePayload(payload({ sources }));
    expect(error).toMatch(new RegExp(`at most ${GROUNDING_LIMITS.pages} pages`));
  });

  it('refuses an empty list, a non-list, and a non-http URL', () => {
    expect(parseSourceEpisodePayload(payload({ sources: [] })).error).toMatch(
      /at least one source/
    );
    expect(parseSourceEpisodePayload(payload({ sources: 'https://x' })).error).toMatch(
      /at least one source/
    );
    expect(
      parseSourceEpisodePayload(payload({ sources: [{ kind: 'page', url: 'file:///etc/passwd' }] }))
        .error
    ).toMatch(/not an http\(s\) URL/);
  });

  it('requires a title, bounds it, and needs something to slug', () => {
    expect(parseSourceEpisodePayload(payload({ title: '  ' })).error).toBe(
      'title is required for a source-grounded episode'
    );
    expect(
      parseSourceEpisodePayload(payload({ title: 'x'.repeat(MAX_SOURCE_TITLE_LENGTH + 1) })).error
    ).toMatch(/at most 120 characters/);
    expect(parseSourceEpisodePayload(payload({ title: '???' })).error).toMatch(/needs a title/);
    // Whitespace runs collapse so the same title typed twice is the same id.
    expect(parseSourceEpisodePayload(payload({ title: 'Entra   ID\nbasics' })).value.title).toBe(
      'Entra ID basics'
    );
  });

  it('applies the platform and exam-code rules of the guide payload', () => {
    expect(parseSourceEpisodePayload(payload({ platform: 'vmware' })).error).toMatch(
      /not available for "vmware".*azure, github, aws/
    );
    expect(parseSourceEpisodePayload(payload({ examCode: ' ' })).error).toBe(
      'examCode is required'
    );
  });

  it('needs no study guide URL — a source episode is not a guide run', () => {
    expect(parseSourceEpisodePayload(payload({ studyGuideUrl: undefined })).error).toBeUndefined();
  });

  it('does not throw on a missing payload', () => {
    expect(parseSourceEpisodePayload(undefined).error).toBeTruthy();
    expect(parseSourceEpisodePayload(null).error).toBeTruthy();
  });

  it('names the job the guide run uses', () => {
    expect(LISTEN_AND_LEARN_JOB_TYPE).toBe('generate-listen-and-learn');
  });
});

describe('generateSourceEpisode — the run', () => {
  it('scripts through the grounded door, renders audio, and saves one draft of kind source', async () => {
    const store = makeStore();
    const storage = makeStorage();
    const ai = makeAi();
    const deps = happyDeps();

    const report = await run({ store, storage, ai, deps });

    // The script was asked for with the grounding, never with `generate`.
    const call = deps.writeScript.mock.calls[0][0];
    expect(call.grounding).toEqual({ sources: [page, video], ai, generatedAt: NOW });
    expect(call.generate).toBeUndefined();
    expect(call.area).toMatchObject({ slug: 'source_entra-id-basics', name: 'Entra ID basics' });
    expect(call.cert).toEqual({ examCode: 'AZ-104', title: 'Azure Administrator' });

    const doc = store.docs[EPISODE_CONTAINER]['source_entra-id-basics'];
    expect(doc).toMatchObject({
      id: 'source_entra-id-basics',
      setId: 'azure_az-104',
      kind: 'source',
      sources: [page, video],
      status: STATUS.draft,
      order: SOURCE_EPISODE_ORDER,
      videos: [],
      // Stamped per take (ADR 0033 §4), from the run's `now`.
      audioPath: 'azure/az-104/source_entra-id-basics-20260909120000.mp3',
      speechProvider: 'gemini',
      approvedAt: null,
    });
    expect(doc.transcript).toEqual([{ speaker: 'Maya', text: 'Hello' }]);

    expect(report).toMatchObject({
      kind: 'source',
      areaSlug: 'source_entra-id-basics',
      status: STATUS.draft,
      sourceCount: 2,
      generated: 1,
      failed: 0,
      withoutAudio: 0,
      audioBytes: 3,
    });
    // One row (the audio; the stub script reports no usage), summed from what
    // was actually written.
    expect(report.costUsd).toBe(0.01);
  });

  it('creates the set only when it is missing', async () => {
    const store = makeStore();
    await run({ store });
    expect(store.docs[SET_CONTAINER]['azure_az-104']).toMatchObject({
      certTitle: 'Azure Administrator',
      areaCount: 0,
      generatedBy: 'oid-1',
    });

    const existing = { id: 'azure_az-104', areaCount: 5, generatedAt: '2026-08-01' };
    const store2 = makeStore();
    store2.docs[SET_CONTAINER]['azure_az-104'] = existing;
    await run({ store: store2 });
    expect(store2.docs[SET_CONTAINER]['azure_az-104']).toBe(existing);
  });

  it('records the script under its own usage source and the audio under the shared one', async () => {
    const deps = happyDeps({
      writeScript: vi.fn(async ({ usageOut }) => {
        usageOut.push({ provider: 'gemini', model: 'gemini-3.6-flash', promptTokens: 9000 });
        return script();
      }),
    });
    await run({ deps });

    const rows = deps.recordUsage.mock.calls[0][0];
    expect(rows.map((r) => r.source)).toEqual([
      USAGE_SOURCES.listenAndLearnSourceScript,
      'ai:listenAndLearnSpeech',
    ]);
    expect(rows[1].product).toBe(USAGE_SOURCES.listenAndLearnAudio);
    expect(USAGE_SOURCES.listenAndLearnSourceScript).toBe('listen-and-learn:source-script');
    expect(rows[0]).toMatchObject({ provider: 'gemini', promptTokens: 9000 });
  });

  it('asks for the Listen & Learn product with the run’s model, like a guide run', async () => {
    const deps = happyDeps();
    await run({ deps, ttsModel: 'gemini-2.5-flash-preview-tts' });
    expect(deps.synthesize).toHaveBeenCalledTimes(1);
    expect(deps.synthesize.mock.calls[0][0]).toMatchObject({
      product: 'listenAndLearn',
      model: 'gemini-2.5-flash-preview-tts',
    });

    const bare = happyDeps();
    await run({ deps: bare });
    expect(bare.synthesize.mock.calls[0][0]).toMatchObject({
      product: 'listenAndLearn',
      model: null,
    });
  });

  it('with Gemini unavailable: the sentence, no failover, nothing saved', async () => {
    // The refusal is the router's; here it is what the script step throws.
    const store = makeStore();
    const ai = makeAi();
    const deps = happyDeps({
      writeScript: vi.fn(async () => {
        throw new AiNotConfiguredError(
          'Source grounding needs Gemini; it is disabled in the admin portal.'
        );
      }),
    });

    await expect(run({ store, ai, deps })).rejects.toThrow(/Source grounding needs Gemini/);

    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(ai.generateJsonResponse).not.toHaveBeenCalled();
    expect(deps.synthesize).not.toHaveBeenCalled();
    expect(deps.recordUsage).not.toHaveBeenCalled();
  });

  it('refuses a bad list before anything runs, with the route sentence', async () => {
    const store = makeStore();
    const deps = happyDeps();
    await expect(
      run({ store, deps, sources: [{ kind: 'page', url: 'https://youtu.be/abc' }] })
    ).rejects.toThrow(/YouTube URL given as kind 'page'/);
    expect(deps.writeScript).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('records a failed episode of kind source when the model or a source lets it down, then fails the job', async () => {
    const store = makeStore();
    const deps = happyDeps({
      writeScript: vi.fn(async () => {
        // The router's own sentence (authored), as the grounded call throws it.
        throw new GroundingIncompleteError(
          'Gemini could not read a source — https://example.com/entra (paywall).'
        );
      }),
    });

    await expect(run({ store, deps })).rejects.toThrow(/could not read a source/);

    const doc = store.docs[EPISODE_CONTAINER]['source_entra-id-basics'];
    expect(doc).toMatchObject({
      kind: 'source',
      status: STATUS.failed,
      error: expect.stringContaining('paywall'),
      areaName: 'Entra ID basics',
    });
    // No set was created for an episode that failed — nothing to house.
    expect(store.docs[SET_CONTAINER]).toEqual({});
  });

  it('a missing speech key degrades; a broken one fails the episode', async () => {
    const store = makeStore();
    const report = await run({
      store,
      deps: happyDeps({
        synthesize: vi.fn(async () => {
          throw new SpeechNotConfiguredError(speechNotConfiguredMessage('listenAndLearn'));
        }),
      }),
    });
    expect(report.withoutAudio).toBe(1);
    expect(store.docs[EPISODE_CONTAINER]['source_entra-id-basics']).toMatchObject({
      status: STATUS.draft,
      audioUrl: null,
      audioError: expect.stringContaining('GEMINI_API_KEY'),
    });

    const store2 = makeStore();
    await expect(
      run({
        store: store2,
        deps: happyDeps({
          synthesize: vi.fn(async () => {
            throw new SpeechError('Azure Speech HTTP 401: denied', { status: 401 });
          }),
        }),
      })
    ).rejects.toThrow(/401/);
    expect(store2.docs[EPISODE_CONTAINER]['source_entra-id-basics'].status).toBe(STATUS.failed);
  });

  it('a padded exam code and platform build the same ids and blob path as the trimmed ones', async () => {
    // The route and the worker validate the same payload and compute the
    // partition and the document id from the trimmed values; the run must
    // land the episode there, not under a set keyed on the padding.
    const trimmed = makeStore();
    const trimmedStorage = makeStorage();
    await run({ store: trimmed, storage: trimmedStorage });

    const padded = makeStore();
    const paddedStorage = makeStorage();
    const report = await run({
      store: padded,
      storage: paddedStorage,
      platform: 'AZURE',
      examCode: ' AZ-104 ',
      title: '  Entra ID basics ',
      cert: { title: ' Azure Administrator ', slug: ' az-104 ' },
    });

    expect(Object.keys(padded.docs[EPISODE_CONTAINER])).toEqual(
      Object.keys(trimmed.docs[EPISODE_CONTAINER])
    );
    expect(Object.keys(padded.docs[SET_CONTAINER])).toEqual(
      Object.keys(trimmed.docs[SET_CONTAINER])
    );
    const paddedDoc = padded.docs[EPISODE_CONTAINER]['source_entra-id-basics'];
    const trimmedDoc = trimmed.docs[EPISODE_CONTAINER]['source_entra-id-basics'];
    for (const field of ['setId', 'provider', 'examCode', 'areaSlug', 'areaName', 'audioPath']) {
      expect(paddedDoc[field], field).toBe(trimmedDoc[field]);
    }
    expect(paddedDoc.examCode).toBe('AZ-104');
    expect(padded.docs[SET_CONTAINER]['azure_az-104']).toMatchObject({
      examCode: 'AZ-104',
      certTitle: 'Azure Administrator',
      certSlug: 'az-104',
    });
    // The blob upload and the report see the same trimmed values.
    expect(paddedStorage.uploadBlob.mock.calls[0][1]).toBe(
      trimmedStorage.uploadBlob.mock.calls[0][1]
    );
    expect(report).toMatchObject({ examCode: 'AZ-104', platform: 'azure' });
  });

  it('regenerating the same title replaces the same document and keeps its approval (ADR 0033 §4)', async () => {
    const store = makeStore();
    await run({ store });
    store.docs[EPISODE_CONTAINER]['source_entra-id-basics'].status = STATUS.published;
    await run({ store, title: '  entra id BASICS ' });
    expect(Object.keys(store.docs[EPISODE_CONTAINER])).toEqual(['source_entra-id-basics']);
    expect(store.docs[EPISODE_CONTAINER]['source_entra-id-basics'].status).toBe(STATUS.published);
  });
});

describe('the browser classifies a URL by the server rule', () => {
  // One table, both sides. A case is [url, what the server says]: 'video',
  // 'page', or a refusal for anything neither branch accepts.
  const cases = [
    ['https://www.youtube.com/watch?v=abc123', 'video'],
    ['https://youtube.com/watch?v=abc_-1', 'video'],
    ['https://m.youtube.com/watch?v=abc123&t=10s', 'video'],
    ['https://youtu.be/abc123', 'video'],
    ['https://www.youtube.com/shorts/abc123', 'video'],
    ['https://www.youtube.com/watch?v=', 'refused'],
    ['https://www.youtube.com/playlist?list=PL1', 'refused'],
    ['https://www.youtube.com/@channel', 'refused'],
    ['https://youtu.be/', 'refused'],
    ['https://example.com/article', 'page'],
    ['http://example.com/article', 'page'],
    ['https://notyoutube.com/watch?v=abc', 'page'],
    ['ftp://example.com/file', 'refused'],
    ['not a url', 'refused'],
    ['', 'refused'],
  ];

  it.each(cases)('%s → %s', (url, expected) => {
    const server = (() => {
      if (isYouTubeVideoUrl(url)) return 'video';
      try {
        validateGroundingSources([{ kind: 'page', url }]);
        return 'page';
      } catch {
        return 'refused';
      }
    })();
    expect(server).toBe(expected);

    const browser = classifySourceUrl(url);
    expect(browser.error ? 'refused' : browser.kind).toBe(expected);
  });
});
