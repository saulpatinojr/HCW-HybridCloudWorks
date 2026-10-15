/**
 * The Audio tab's ElevenLabs card and the owner's live check (#432,
 * 2026-09-26).
 *
 * Pinned: both routes are gated; an unseeded key is a 200 "not configured"
 * on the status route and a 503 that sends nothing on the sample route; the
 * sample is fixed, two turns, under 300 characters, and goes through the same
 * path an episode takes; a refusal is reported with its own sentence and
 * spends nothing; and "credits left" can never read as unspent because a
 * fresh read lagged.
 *
 * Since #725 the check reads the saved podcast voices and, with none chosen,
 * refuses before sending; and two more routes list the key's voices (marked
 * usable on the plan or not) and proxy one voice's preview.
 *
 * Since 2026-09-27 a stored sample is recorded for a free replay, and the
 * status route returns it as `lastSample` without reaching ElevenLabs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  LAST_SAMPLE_CONFIG_ID,
  NOT_CONFIGURED_REASON,
  SAMPLE_AUDIO_PATH,
  SAMPLE_CHARACTERS,
  SAMPLE_DIALOGUE,
  SAMPLE_MAX_CHARACTERS,
  SAMPLE_MEDIA_URL,
  SEED_KEY_PAGE,
  createElevenLabsHandlers,
} from './elevenlabs-admin.js';
import { USAGE_CONTAINER, USAGE_SOURCES } from '../ai/usage.js';
import {
  SUBSCRIPTION_URL,
  clearSubscriptionCache,
  normalizeSubscription,
} from '../listen-and-learn/speech/elevenlabs-account.js';
import { SpeechError, SpeechNotConfiguredError } from '../listen-and-learn/speech/index.js';
import { VOICES_URL, clearVoicesCache } from '../listen-and-learn/speech/elevenlabs-voices.js';
import { PODCAST_VOICES_CONFIG_ID } from './voice-settings.js';

const NOW = new Date('2026-09-26T12:00:00.000Z');
const KEY_ENV = { ELEVENLABS_API_KEY: 'xi-test-key' };
const context = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

const USER = { oid: 'oid-1' };
const allowGuard = { requireRole: vi.fn(async (_req, role) => ({ user: USER, role, error: null })) };
const denyGuard = {
  requireRole: vi.fn(async () => ({ user: null, error: { status: 403, body: '{}' } })),
};

const FREE_BODY = {
  tier: 'free',
  status: 'free',
  character_count: 0,
  character_limit: 10000,
  next_character_count_reset_unix: 1792972800,
  can_extend_character_limit: false,
  max_credit_limit_extension: 0,
};
const FREE = normalizeSubscription(FREE_BODY);

const USAGE_ROW = {
  completionTokens: 8912,
  estimatedTokens: false,
  timestamp: '2026-09-26T10:00:00.000Z',
  source: 'podcast:audio',
  model: 'eleven_v3',
};

/** The owner's saved choice (admin_config/podcast_voices, #725). */
const VOICES = Object.freeze({ Maya: 'MayaVoice00000000001', Elena: 'ElenaVoice0000000002' });
const VOICES_DOC = { id: PODCAST_VOICES_CONFIG_ID, configScope: 'admin_config', ...VOICES };

const makeStore = (over = {}) => ({
  queryDocs: vi.fn(async () => [USAGE_ROW]),
  upsertDoc: vi.fn(async (_c, doc) => doc),
  readDoc: vi.fn(async (_c, id) => (id === PODCAST_VOICES_CONFIG_ID ? VOICES_DOC : null)),
  ...over,
});
// No sample blob unless a test stores one.
const makeStorage = (over = {}) => ({
  uploadBlob: vi.fn(async () => undefined),
  headBlobForDelivery: vi.fn(async () => null),
  ...over,
});
const ai = { getCostEstimate: vi.fn(() => 0.0257) };

const request = () => ({ json: vi.fn(async () => ({ dialogue: [{ speaker: 'Maya', text: 'x'.repeat(9000) }] })) });

const handlers = ({
  guard = allowGuard,
  store = makeStore(),
  storage = makeStorage(),
  env = KEY_ENV,
  synthesize,
  readAccount,
  fetchImpl,
  listVoices,
  fetchPreview,
  voiceNames,
} = {}) =>
  createElevenLabsHandlers({
    guard,
    store,
    storage,
    ai,
    env,
    now: () => NOW,
    ...(synthesize ? { synthesize } : {}),
    ...(readAccount ? { readAccount } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(listVoices ? { listVoices } : {}),
    ...(fetchPreview ? { fetchPreview } : {}),
    ...(voiceNames ? { voiceNames } : {}),
  });

const body = (res) => JSON.parse(res.body);

const previewRequest = (voiceId) => ({ params: { voiceId }, json: vi.fn() });

/** What `synthesizeDialogue` returns for the sample on a fresh free month. */
const rendered = (over = {}) => ({
  audio: Buffer.from([0xff, 0xfb, 1, 2]),
  contentType: 'audio/mpeg',
  bytes: 4,
  provider: 'elevenlabs',
  model: 'eleven_v3',
  requests: 1,
  estimatedSeconds: 16,
  promptTokens: 0,
  completionTokens: SAMPLE_CHARACTERS,
  estimatedTokens: false,
  characters: SAMPLE_CHARACTERS,
  subscription: FREE,
  ...over,
});

beforeEach(() => {
  clearSubscriptionCache();
  clearVoicesCache();
  context.log.mockClear();
  context.error.mockClear();
});

describe('the sample', () => {
  it('is two turns, one per host, under the owner’s 300-character ceiling', () => {
    expect(SAMPLE_DIALOGUE).toHaveLength(2);
    expect(SAMPLE_DIALOGUE.map((t) => t.speaker)).toEqual(['Maya', 'Elena']);
    expect(SAMPLE_CHARACTERS).toBeLessThanOrEqual(SAMPLE_MAX_CHARACTERS);
    expect(SAMPLE_MAX_CHARACTERS).toBe(300);
    expect(SAMPLE_CHARACTERS).toBe(257);
    expect(Object.isFrozen(SAMPLE_DIALOGUE)).toBe(true);
    expect(Object.isFrozen(SAMPLE_DIALOGUE[0])).toBe(true);
  });
});

describe('auth', () => {
  it('passes a guard denial through on every route, touching nothing', async () => {
    const store = makeStore();
    const storage = makeStorage();
    const synthesize = vi.fn();
    const readAccount = vi.fn();
    const listVoices = vi.fn();
    const fetchPreview = vi.fn();
    const h = handlers({ guard: denyGuard, store, storage, synthesize, readAccount, listVoices, fetchPreview });
    expect((await h.getStatus(request(), context)).status).toBe(403);
    expect((await h.renderSample(request(), context)).status).toBe(403);
    expect((await h.listVoices(request(), context)).status).toBe(403);
    expect((await h.previewVoice(previewRequest(VOICES.Maya), context)).status).toBe(403);
    expect(store.queryDocs).not.toHaveBeenCalled();
    expect(store.readDoc).not.toHaveBeenCalled();
    expect(readAccount).not.toHaveBeenCalled();
    expect(synthesize).not.toHaveBeenCalled();
    expect(listVoices).not.toHaveBeenCalled();
    expect(fetchPreview).not.toHaveBeenCalled();
    expect(storage.uploadBlob).not.toHaveBeenCalled();
    expect(storage.headBlobForDelivery).not.toHaveBeenCalled();
  });

  it('gates all four at editor, the level of the routes that generate podcast audio', async () => {
    const guard = { requireRole: vi.fn(async () => ({ user: USER, error: null })) };
    const h = handlers({ guard, env: {} });
    await h.getStatus(request(), context);
    await h.renderSample(request(), context);
    await h.listVoices(request(), context);
    await h.previewVoice(previewRequest(VOICES.Maya), context);
    expect(guard.requireRole.mock.calls.map(([, role]) => role)).toEqual([
      'editor',
      'editor',
      'editor',
      'editor',
    ]);
  });
});

describe('getStatus', () => {
  it('answers "not configured" as a 200 naming the secret and where to seed it, calling nothing upstream', async () => {
    const readAccount = vi.fn();
    for (const env of [{}, { ELEVENLABS_API_KEY: '@Microsoft.KeyVault(SecretUri=https://v/s/1)' }]) {
      const res = await handlers({ env, readAccount }).getStatus(request(), context);
      expect(res.status).toBe(200);
      expect(body(res)).toMatchObject({
        success: true,
        configured: false,
        reason: NOT_CONFIGURED_REASON,
        subscription: null,
        lastRender: { characters: 8912 },
      });
    }
    expect(readAccount).not.toHaveBeenCalled();
    expect(NOT_CONFIGURED_REASON).toMatch(/ELEVENLABS_API_KEY is not configured/);
    expect(NOT_CONFIGURED_REASON).toContain('ELEVENLABS-API-KEY');
    expect(NOT_CONFIGURED_REASON).toContain('https://elevenlabs.io/app/developers/api-keys');
    expect(SEED_KEY_PAGE).toBe('https://hybridcloudworks.com/admin/integrations?tab=keys');
  });

  it('projects the row’s product beside its source, so an episode written since ADR 0034 slice 5 still reads as one', async () => {
    // The new shape: the task as source, the old slug as product.
    const store = makeStore({
      queryDocs: vi.fn(async () => [{ ...USAGE_ROW, source: 'ai:podcastVoice', product: 'podcast:audio' }]),
    });
    const res = await handlers({ store }).getStatus(request(), context);
    expect(res.status).toBe(200);
    expect(body(res).lastRender).toEqual({
      characters: 8912,
      estimated: false,
      at: '2026-09-26T10:00:00.000Z',
      source: 'ai:podcastVoice',
      product: 'podcast:audio',
      model: 'eleven_v3',
    });
    const [, query] = store.queryDocs.mock.calls[0];
    expect(query).toContain('c.product');
  });

  it('reports the plan, the credits and the reset date, and what the last render billed', async () => {
    const store = makeStore();
    const readAccount = vi.fn(async () => ({ ...FREE, creditsUsed: 8912, creditsLeft: 1088 }));
    const res = await handlers({ store, readAccount }).getStatus(request(), context);

    expect(res.status).toBe(200);
    expect(body(res)).toEqual({
      success: true,
      configured: true,
      reason: null,
      subscription: {
        tier: 'free',
        status: 'free',
        freePlan: true,
        creditsUsed: 8912,
        creditLimit: 10000,
        creditsLeft: 1088,
        overageCredits: 0,
        resetAt: '2026-10-26T00:00:00.000Z',
      },
      subscriptionError: null,
      lastRender: {
        characters: 8912,
        estimated: false,
        at: '2026-09-26T10:00:00.000Z',
        source: 'podcast:audio',
        // A row from before ADR 0034 slice 5: no product; the card falls back to source.
        product: null,
        model: 'eleven_v3',
      },
      lastRenderError: null,
      lastSample: null,
      lastSampleError: null,
      sample: { characters: SAMPLE_CHARACTERS, turns: 2 },
    });
    expect(readAccount).toHaveBeenCalledWith(expect.objectContaining({ key: 'xi-test-key' }));
    const [container, query, params] = store.queryDocs.mock.calls[0];
    expect(container).toBe(USAGE_CONTAINER);
    expect(query).toMatch(/SELECT TOP 1 .* WHERE c\.provider = @provider ORDER BY c\.timestamp DESC/);
    expect(params).toEqual([{ name: '@provider', value: 'elevenlabs' }]);
  });

  it('says there is no render yet only when the usage read worked', async () => {
    let res = await handlers({
      store: makeStore({ queryDocs: vi.fn(async () => []) }),
      readAccount: vi.fn(async () => FREE),
    }).getStatus(request(), context);
    expect(body(res)).toMatchObject({ lastRender: null, lastRenderError: null });

    res = await handlers({
      store: makeStore({
        queryDocs: vi.fn(async () => {
          throw Object.assign(new Error('cosmos down'), { code: 503 });
        }),
      }),
      readAccount: vi.fn(async () => FREE),
    }).getStatus(request(), context);
    expect(res.status).toBe(200);
    expect(body(res)).toMatchObject({
      lastRender: null,
      lastRenderError: 'The usage table could not be read.',
      subscription: { tier: 'free' },
    });
    expect(res.body).not.toContain('cosmos down');
  });

  it('keeps answering when the subscription cannot be read, with the sentence that names the fix', async () => {
    const readAccount = vi.fn(async () => {
      throw new SpeechError(
        'Could not read the ElevenLabs subscription (HTTP 403 insufficient_permissions: the key needs the User → Read permission (user_read), set at https://elevenlabs.io/app/developers/api-keys); nothing was sent, so no credits were spent.'
      );
    });
    const res = await handlers({ readAccount }).getStatus(request(), context);
    expect(res.status).toBe(200);
    expect(body(res)).toMatchObject({
      configured: true,
      subscription: null,
      subscriptionError: expect.stringMatching(/User → Read permission \(user_read\)/),
    });
    expect(res.body).not.toContain('xi-test-key');
  });
});

describe('renderSample', () => {
  it('503s without a key, naming it, and sends nothing', async () => {
    const synthesize = vi.fn();
    const storage = makeStorage();
    const res = await handlers({ env: {}, synthesize, storage }).renderSample(request(), context);
    expect(res.status).toBe(503);
    expect(body(res)).toEqual({ error: NOT_CONFIGURED_REASON, code: 'NOT_CONFIGURED' });
    expect(synthesize).not.toHaveBeenCalled();
    expect(storage.uploadBlob).not.toHaveBeenCalled();
  });

  it('renders the fixed sample through the podcast product, ignoring anything the caller sends', async () => {
    const synthesize = vi.fn(async () => rendered());
    const req = request();
    await handlers({ synthesize, readAccount: vi.fn(async () => FREE) }).renderSample(req, context);
    expect(req.json).not.toHaveBeenCalled();
    expect(synthesize).toHaveBeenCalledWith(
      expect.objectContaining({
        product: 'podcast',
        dialogue: SAMPLE_DIALOGUE,
        env: KEY_ENV,
        voices: VOICES,
      })
    );
  });

  it('reads the saved podcast voices, and with none chosen says so as a 409 that sends nothing', async () => {
    const synthesize = vi.fn();
    const storage = makeStorage();
    const store = makeStore({ readDoc: vi.fn(async () => null) });
    const res = await handlers({ store, storage, synthesize }).renderSample(request(), context);
    expect(res.status).toBe(409);
    expect(body(res)).toEqual({
      error:
        'Choose the podcast voices first: no ElevenLabs voice is saved for Maya and Elena. ' +
        'Pick two under Podcast voices at https://hybridcloudworks.com/admin/platform-settings?tab=audio, then run it again. ' +
        'Nothing was sent, so no credits were spent.',
      code: 'voices_not_chosen',
    });
    expect(store.readDoc).toHaveBeenCalledWith('admin_config', PODCAST_VOICES_CONFIG_ID, 'admin_config');
    expect(synthesize).not.toHaveBeenCalled();
    expect(storage.uploadBlob).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('answers 502 when the saved voices cannot be read, and sends nothing', async () => {
    const synthesize = vi.fn();
    const store = makeStore({
      readDoc: vi.fn(async () => {
        throw Object.assign(new Error('cosmos down'), { code: 503 });
      }),
    });
    const res = await handlers({ store, synthesize }).renderSample(request(), context);
    expect(res.status).toBe(502);
    expect(body(res)).toEqual({
      error: 'The saved podcast voices could not be read.',
      code: 'VOICES_UNREADABLE',
    });
    expect(res.body).not.toContain('cosmos down');
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('stores the MP3, records a podcast:sample usage row and returns the audio, the billing and the credits', async () => {
    const store = makeStore();
    const storage = makeStorage();
    const after = { ...FREE, creditsUsed: 257, creditsLeft: 9743 };
    const readAccount = vi.fn(async () => after);
    const res = await handlers({
      store,
      storage,
      synthesize: vi.fn(async () => rendered()),
      readAccount,
    }).renderSample(request(), context);

    expect(res.status).toBe(200);
    expect(body(res)).toEqual({
      ok: true,
      audioUrl: `/api/public/media/podcast/sample/elevenlabs-live-check.mp3?v=${NOW.getTime()}`,
      audioError: null,
      contentType: 'audio/mpeg',
      bytes: 4,
      durationSeconds: 16,
      requests: 1,
      model: 'eleven_v3',
      characters: 257,
      charactersBilled: 257,
      billedEstimated: false,
      creditsLeftBefore: 10000,
      creditsLeft: 9743,
      creditLimit: 10000,
      tier: 'free',
      freePlan: true,
      resetAt: '2026-10-26T00:00:00.000Z',
      lastSample: {
        audioUrl: `/api/public/media/podcast/sample/elevenlabs-live-check.mp3?v=${NOW.getTime()}`,
        renderedAt: NOW.toISOString(),
        voices: {
          Maya: { voiceId: VOICES.Maya, name: null },
          Elena: { voiceId: VOICES.Elena, name: null },
        },
        charactersBilled: 257,
        billedEstimated: false,
        model: 'eleven_v3',
        recorded: true,
      },
    });

    const [container, path, audio, contentType] = storage.uploadBlob.mock.calls[0];
    expect([container, path, contentType]).toEqual(['podcast', SAMPLE_AUDIO_PATH, 'audio/mpeg']);
    expect(Buffer.isBuffer(audio)).toBe(true);

    const usageWrites = store.upsertDoc.mock.calls.filter(([c]) => c === USAGE_CONTAINER);
    expect(usageWrites).toHaveLength(1);
    const [usageContainer, row] = usageWrites[0];
    expect(usageContainer).toBe(USAGE_CONTAINER);
    expect(row).toMatchObject({
      provider: 'elevenlabs',
      model: 'eleven_v3',
      promptTokens: 0,
      completionTokens: 257,
      source: USAGE_SOURCES.podcastSample,
    });
    expect(USAGE_SOURCES.podcastSample).toBe('podcast:sample');
    // The credits after are a FRESH read, not the cached one the render used.
    expect(readAccount).toHaveBeenCalledWith(expect.objectContaining({ useCache: false }));
  });

  it('never reports the credits as unspent because the fresh read lagged', async () => {
    // ElevenLabs had not yet counted the sample: the read still says 10,000.
    const res = await handlers({
      synthesize: vi.fn(async () => rendered()),
      readAccount: vi.fn(async () => FREE),
    }).renderSample(request(), context);
    expect(body(res).creditsLeft).toBe(10000 - 257);
  });

  it('falls back to before-minus-billed when the fresh read fails', async () => {
    const res = await handlers({
      synthesize: vi.fn(async () => rendered()),
      readAccount: vi.fn(async () => {
        throw new SpeechError('offline');
      }),
    }).renderSample(request(), context);
    expect(res.status).toBe(200);
    expect(body(res)).toMatchObject({ creditsLeft: 9743, creditLimit: 10000, tier: 'free' });
  });

  it('reports a pre-flight refusal as 409 with its sentence, storing and recording nothing', async () => {
    const sentence =
      'ElevenLabs has 100 credits left of 10,000, this episode needs 257; the allowance resets on 2026-10-26 (UTC). Nothing was sent, so no credits were spent.';
    const store = makeStore();
    const storage = makeStorage();
    const res = await handlers({
      store,
      storage,
      synthesize: vi.fn(async () => {
        throw Object.assign(new SpeechError(sentence, { provider: 'elevenlabs' }), {
          code: 'quota_exceeded',
        });
      }),
    }).renderSample(request(), context);
    expect(res.status).toBe(409);
    expect(body(res)).toEqual({ error: sentence, code: 'quota_exceeded' });
    expect(storage.uploadBlob).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('maps the other refusals: a paid-only voice 409, a pin 503, an unreadable account 502', async () => {
    const cases = [
      [Object.assign(new SpeechError('paid only'), { code: 'paid_plan_required' }), 409],
      [Object.assign(new SpeechError('choose first'), { code: 'voices_not_chosen' }), 409],
      [Object.assign(new SpeechError('not an id'), { code: 'invalid_voice' }), 409],
      [new SpeechNotConfiguredError('PODCAST_TTS_PROVIDER pins "elevenlabs", which is not configured'), 503],
      [Object.assign(new SpeechError('Could not read the ElevenLabs subscription'), { code: 'subscription_unavailable' }), 502],
      [new SpeechError('ElevenLabs HTTP 500: boom'), 502],
    ];
    for (const [error, status] of cases) {
      const res = await handlers({
        synthesize: vi.fn(async () => {
          throw error;
        }),
      }).renderSample(request(), context);
      expect(res.status).toBe(status);
      expect(body(res).error).toBe(error.message);
    }
  });

  it('still reports the billing, and records it, when the MP3 could not be stored', async () => {
    const store = makeStore();
    const res = await handlers({
      store,
      storage: makeStorage({
        uploadBlob: vi.fn(async () => {
          throw new Error('container missing');
        }),
      }),
      synthesize: vi.fn(async () => rendered()),
      readAccount: vi.fn(async () => FREE),
    }).renderSample(request(), context);
    expect(res.status).toBe(200);
    expect(body(res)).toMatchObject({
      ok: true,
      audioUrl: null,
      audioError: expect.stringMatching(/rendered and billed but not stored: container missing/),
      charactersBilled: 257,
      // Nothing new to replay: the blob still holds the previous sample.
      lastSample: null,
    });
    // The usage row only; no replay record for audio that was not stored.
    expect(store.upsertDoc).toHaveBeenCalledTimes(1);
    expect(store.upsertDoc.mock.calls[0][0]).toBe(USAGE_CONTAINER);
  });
});

/** The record a stored sample leaves (admin_config/podcast_last_sample). */
const RECORD = Object.freeze({
  id: LAST_SAMPLE_CONFIG_ID,
  configScope: 'admin_config',
  audioUrl: `${SAMPLE_MEDIA_URL}?v=1790000000000`,
  voices: {
    Maya: { voiceId: VOICES.Maya, name: 'Bella' },
    Elena: { voiceId: VOICES.Elena, name: 'Jessica' },
  },
  charactersBilled: 257,
  billedEstimated: false,
  model: 'eleven_v3',
  renderedAt: '2026-09-27T14:03:00.000Z',
});

/** A store whose admin_config holds `docs` by id, and whose usage query answers `rows`. */
const storeWith = (docs, rows = [USAGE_ROW]) =>
  makeStore({
    readDoc: vi.fn(async (_c, id) => docs[id] ?? null),
    queryDocs: vi.fn(async () => rows),
  });
const blobThere = () =>
  makeStorage({
    headBlobForDelivery: vi.fn(async () => ({
      contentType: 'audio/mpeg',
      etag: '"0x8DCDEADBEEF"',
      contentLength: 135671,
    })),
  });

describe('the last sample', () => {
  it('records a stored sample for replay: the versioned URL, both voices with the names at hand, the billing and the time', async () => {
    const store = makeStore();
    const voiceNames = vi.fn(() => new Map([[VOICES.Maya, 'Bella'], [VOICES.Elena, 'Jessica']]));
    const res = await handlers({
      store,
      synthesize: vi.fn(async () => rendered()),
      readAccount: vi.fn(async () => FREE),
      voiceNames,
    }).renderSample(request(), context);

    expect(res.status).toBe(200);
    expect(voiceNames).toHaveBeenCalledWith('xi-test-key');
    const records = store.upsertDoc.mock.calls.filter(([c]) => c === 'admin_config');
    expect(records).toHaveLength(1);
    expect(records[0][1]).toEqual({
      id: 'podcast_last_sample',
      configScope: 'admin_config',
      audioUrl: `/api/public/media/podcast/sample/elevenlabs-live-check.mp3?v=${NOW.getTime()}`,
      voices: {
        Maya: { voiceId: VOICES.Maya, name: 'Bella' },
        Elena: { voiceId: VOICES.Elena, name: 'Jessica' },
      },
      charactersBilled: 257,
      billedEstimated: false,
      model: 'eleven_v3',
      renderedAt: NOW.toISOString(),
    });
    expect(body(res).lastSample).toMatchObject({
      audioUrl: records[0][1].audioUrl,
      voices: { Maya: { name: 'Bella' }, Elena: { name: 'Jessica' } },
      recorded: true,
    });
  });

  it('still answers 200 with the sample when the record cannot be written, and says so in the log', async () => {
    context.warn.mockClear();
    const store = makeStore({
      upsertDoc: vi.fn(async (container, doc) => {
        if (container === 'admin_config') throw Object.assign(new Error('cosmos down'), { code: 503 });
        return doc;
      }),
    });
    const res = await handlers({
      store,
      synthesize: vi.fn(async () => rendered()),
      readAccount: vi.fn(async () => FREE),
    }).renderSample(request(), context);
    expect(res.status).toBe(200);
    expect(body(res).lastSample).toMatchObject({ recorded: true, charactersBilled: 257 });
    expect(context.warn).toHaveBeenCalledWith(expect.stringMatching(/not recorded for replay \(503\)/));
    // The usage row was still written.
    expect(store.upsertDoc.mock.calls.some(([c]) => c === USAGE_CONTAINER)).toBe(true);
  });

  it('returns the recorded sample on the status read once its blob is confirmed, and reaches ElevenLabs for nothing but the plan', async () => {
    const store = storeWith({ [PODCAST_VOICES_CONFIG_ID]: VOICES_DOC, [LAST_SAMPLE_CONFIG_ID]: RECORD });
    const storage = blobThere();
    const readAccount = vi.fn(async () => FREE);
    const fetchImpl = vi.fn();
    const synthesize = vi.fn();
    const listVoices = vi.fn();
    const res = await handlers({ store, storage, readAccount, fetchImpl, synthesize, listVoices }).getStatus(
      request(),
      context
    );
    expect(res.status).toBe(200);
    expect(body(res)).toMatchObject({
      lastSample: {
        audioUrl: '/api/public/media/podcast/sample/elevenlabs-live-check.mp3?v=1790000000000',
        renderedAt: '2026-09-27T14:03:00.000Z',
        voices: {
          Maya: { voiceId: VOICES.Maya, name: 'Bella' },
          Elena: { voiceId: VOICES.Elena, name: 'Jessica' },
        },
        charactersBilled: 257,
        billedEstimated: false,
        model: 'eleven_v3',
        recorded: true,
      },
      lastSampleError: null,
    });
    expect(storage.headBlobForDelivery).toHaveBeenCalledWith('podcast', SAMPLE_AUDIO_PATH);
    expect(store.readDoc).toHaveBeenCalledWith('admin_config', LAST_SAMPLE_CONFIG_ID, 'admin_config');
    // Replay costs nothing: no render, no listing, no fetch of our own.
    expect(synthesize).not.toHaveBeenCalled();
    expect(listVoices).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(storage.uploadBlob).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('returns the sample without a key too, calling nothing upstream, since replaying needs none', async () => {
    const store = storeWith({ [LAST_SAMPLE_CONFIG_ID]: RECORD });
    const readAccount = vi.fn();
    const fetchImpl = vi.fn();
    const res = await handlers({ env: {}, store, storage: blobThere(), readAccount, fetchImpl }).getStatus(
      request(),
      context
    );
    expect(body(res)).toMatchObject({ configured: false, lastSample: { recorded: true } });
    expect(readAccount).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('offers nothing when the blob is gone, and the record as recorded when the blob cannot be checked', async () => {
    const store = storeWith({ [LAST_SAMPLE_CONFIG_ID]: RECORD });
    let res = await handlers({ store, storage: makeStorage(), readAccount: vi.fn(async () => FREE) }).getStatus(
      request(),
      context
    );
    expect(body(res)).toMatchObject({ lastSample: null, lastSampleError: null });

    res = await handlers({
      store,
      storage: makeStorage({
        headBlobForDelivery: vi.fn(async () => {
          throw Object.assign(new Error('storage down'), { code: 'ECONNRESET' });
        }),
      }),
      readAccount: vi.fn(async () => FREE),
    }).getStatus(request(), context);
    expect(body(res)).toMatchObject({
      lastSample: { audioUrl: RECORD.audioUrl, recorded: true },
      lastSampleError: null,
    });
    expect(res.body).not.toContain('storage down');
  });

  it('ignores a record whose URL is not the sample’s own, so the player cannot be pointed elsewhere', async () => {
    for (const audioUrl of [
      'https://evil.example/x.mp3',
      `${SAMPLE_MEDIA_URL}`,
      `${SAMPLE_MEDIA_URL}?v=1&x=https://evil.example`,
      '/api/public/media/podcast/other.mp3?v=1',
      null,
    ]) {
      const store = storeWith({ [LAST_SAMPLE_CONFIG_ID]: { ...RECORD, audioUrl } }, []);
      const res = await handlers({ store, storage: blobThere(), readAccount: vi.fn(async () => FREE) }).getStatus(
        request(),
        context
      );
      // Not the record: the blob itself, at its own URL and version.
      expect(body(res).lastSample).toMatchObject({
        audioUrl: `${SAMPLE_MEDIA_URL}?v=0x8DCDEADBEEF`,
        recorded: false,
      });
      expect(res.body).not.toContain('evil.example');
      expect(res.body).not.toContain('other.mp3');
    }
  });

  it('shows a record whose voices are not ids as voices unknown, not as invented ones', async () => {
    const store = storeWith({
      [LAST_SAMPLE_CONFIG_ID]: { ...RECORD, voices: { Maya: { voiceId: '../x', name: 'Bella' } } },
    });
    const res = await handlers({ store, storage: blobThere(), readAccount: vi.fn(async () => FREE) }).getStatus(
      request(),
      context
    );
    expect(body(res).lastSample).toMatchObject({ voices: null, recorded: true });
  });

  it('returns a sample stored before the record existed, with the voices saved before it was rendered', async () => {
    const sampleRow = {
      completionTokens: 257,
      estimatedTokens: false,
      timestamp: '2026-09-27T14:03:00.000Z',
      model: 'eleven_v3',
    };
    const savedBefore = { ...VOICES_DOC, updatedAt: '2026-09-27T13:50:00.000Z' };
    const store = storeWith({ [PODCAST_VOICES_CONFIG_ID]: savedBefore }, [sampleRow]);
    const res = await handlers({ store, storage: blobThere(), readAccount: vi.fn(async () => FREE) }).getStatus(
      request(),
      context
    );
    expect(body(res).lastSample).toEqual({
      // The version is the blob's etag, so a newer blob gets a new URL.
      audioUrl: `${SAMPLE_MEDIA_URL}?v=0x8DCDEADBEEF`,
      renderedAt: '2026-09-27T14:03:00.000Z',
      voices: {
        Maya: { voiceId: VOICES.Maya, name: null },
        Elena: { voiceId: VOICES.Elena, name: null },
      },
      charactersBilled: 257,
      billedEstimated: false,
      model: 'eleven_v3',
      recorded: false,
    });
    const sampleQuery = store.queryDocs.mock.calls.find(([, , params]) =>
      params.some((p) => p.name === '@source')
    );
    expect(sampleQuery[1]).toMatch(/c\.provider = @provider AND c\.source = @source ORDER BY c\.timestamp DESC/);
    expect(sampleQuery[2]).toEqual([
      { name: '@provider', value: 'elevenlabs' },
      { name: '@source', value: 'podcast:sample' },
    ]);
  });

  it('does not claim the voices of an unrecorded sample when they were saved after it, or at no known time', async () => {
    const sampleRow = { completionTokens: 257, timestamp: '2026-09-27T14:03:00.000Z' };
    for (const updatedAt of ['2026-09-27T15:00:00.000Z', undefined]) {
      const store = storeWith({ [PODCAST_VOICES_CONFIG_ID]: { ...VOICES_DOC, updatedAt } }, [sampleRow]);
      const res = await handlers({ store, storage: blobThere(), readAccount: vi.fn(async () => FREE) }).getStatus(
        request(),
        context
      );
      expect(body(res).lastSample).toMatchObject({ voices: null, recorded: false });
    }
  });

  it('says the last sample could not be read, rather than "none", when its record read fails', async () => {
    const store = makeStore({
      readDoc: vi.fn(async (_c, id) => {
        if (id === LAST_SAMPLE_CONFIG_ID) throw Object.assign(new Error('cosmos down'), { code: 503 });
        return null;
      }),
    });
    const res = await handlers({ store, storage: blobThere(), readAccount: vi.fn(async () => FREE) }).getStatus(
      request(),
      context
    );
    expect(res.status).toBe(200);
    expect(body(res)).toMatchObject({
      lastSample: null,
      lastSampleError: 'The last sample could not be read.',
      subscription: { tier: 'free' },
      lastRender: { characters: 8912 },
    });
    expect(res.body).not.toContain('cosmos down');
  });
});

describe('end to end through the real provider, with fetch mocked', () => {
  it('reads the account, posts the sample once, and reports 257 billed and 9,743 left', async () => {
    let spent = 0;
    const fetchImpl = vi.fn(async (url, init) => {
      if (String(url).startsWith(SUBSCRIPTION_URL)) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ...FREE_BODY, character_count: spent }),
        };
      }
      const posted = JSON.parse(init.body).inputs.reduce((n, i) => n + [...i.text].length, 0);
      spent += posted;
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (name === 'character-cost' ? String(posted) : null) },
        arrayBuffer: async () => Uint8Array.from([0xff, 0xfb, 0x90, 0x64]).buffer,
        text: async () => '',
      };
    });
    const storage = makeStorage();
    const res = await handlers({ storage, fetchImpl }).renderSample(request(), context);

    expect(res.status).toBe(200);
    expect(body(res)).toMatchObject({
      ok: true,
      charactersBilled: 257,
      billedEstimated: false,
      creditsLeftBefore: 10000,
      creditsLeft: 9743,
      tier: 'free',
      freePlan: true,
    });
    const dialogueCalls = fetchImpl.mock.calls.filter(([url]) => String(url).includes('text-to-dialogue'));
    expect(dialogueCalls).toHaveLength(1);
    const inputs = JSON.parse(dialogueCalls[0][1].body).inputs;
    expect(inputs.map((i) => i.text)).toEqual(SAMPLE_DIALOGUE.map((t) => t.text));
    // In the owner's saved voices, one per host.
    expect(inputs.map((i) => i.voice_id)).toEqual([VOICES.Maya, VOICES.Elena]);
    // The key travelled in the header only, and never came back out.
    expect(dialogueCalls[0][1].headers['xi-api-key']).toBe('xi-test-key');
    expect(res.body).not.toContain('xi-test-key');
  });
});

/** Voices as the listing presents them (speech/elevenlabs-voices.js). */
const listed = (over) => ({
  voiceId: 'DefaultVoice00000001',
  name: 'Talia',
  category: 'premade',
  type: 'default',
  labels: { gender: 'female', accent: 'american', age: null, description: null, useCase: null },
  description: null,
  legacy: false,
  tiers: [],
  hasPreview: true,
  ...over,
});
const LISTING = {
  voices: [
    listed(),
    listed({ voiceId: 'LibraryVoice00000003', name: 'Emma', type: 'library', category: 'professional' }),
  ],
  previews: new Map(),
  truncated: false,
};

describe('listVoices', () => {
  it('answers "not configured" as a 200 with no voices, calling nothing upstream', async () => {
    const listVoices = vi.fn();
    const readAccount = vi.fn();
    const res = await handlers({ env: {}, listVoices, readAccount }).listVoices(request(), context);
    expect(res.status).toBe(200);
    expect(body(res)).toMatchObject({ configured: false, reason: NOT_CONFIGURED_REASON, voices: [] });
    expect(listVoices).not.toHaveBeenCalled();
    expect(readAccount).not.toHaveBeenCalled();
  });

  it('lists every voice with whether the free plan allows it, and why not, usable first', async () => {
    const listVoices = vi.fn(async () => LISTING);
    const res = await handlers({ listVoices, readAccount: vi.fn(async () => FREE) }).listVoices(
      request(),
      context
    );
    expect(res.status).toBe(200);
    const answer = body(res);
    expect(answer).toMatchObject({
      success: true,
      configured: true,
      plan: { tier: 'free', freePlan: true },
      subscriptionError: null,
      truncated: false,
      voicesError: null,
      rule: expect.stringMatching(/not Voice Library voices/),
    });
    expect(answer.voices.map((v) => [v.name, v.usable, v.unavailableReason])).toEqual([
      ['Talia', true, null],
      [
        'Emma',
        false,
        'Voice Library voice: the free plan cannot use it through the API (HTTP 402 paid_plan_required).',
      ],
    ]);
    expect(listVoices).toHaveBeenCalledWith(expect.objectContaining({ key: 'xi-test-key' }));
    expect(res.body).not.toContain('xi-test-key');
  });

  it('still lists when the plan cannot be read, judging library voices as the free plan would', async () => {
    const res = await handlers({
      listVoices: vi.fn(async () => LISTING),
      readAccount: vi.fn(async () => {
        throw new SpeechError('Could not read the ElevenLabs subscription (…)');
      }),
    }).listVoices(request(), context);
    expect(res.status).toBe(200);
    const answer = body(res);
    expect(answer.plan).toBeNull();
    expect(answer.subscriptionError).toMatch(/Could not read the ElevenLabs subscription/);
    expect(answer.voices.find((v) => v.name === 'Emma').usable).toBe(false);
  });

  it('reports a refused listing, a key without Voices → Read say, as a state with the fix', async () => {
    const refusal = Object.assign(
      new SpeechError(
        'Could not list the ElevenLabs voices (HTTP 401 missing_permissions: the key needs the Voices → Read permission (voices_read), set at https://elevenlabs.io/app/developers/api-keys).'
      ),
      { code: 'voices_unavailable', status: 401 }
    );
    const res = await handlers({
      listVoices: vi.fn(async () => {
        throw refusal;
      }),
      readAccount: vi.fn(async () => FREE),
    }).listVoices(request(), context);
    // 200, not the upstream 401, which the page would read as its own session.
    expect(res.status).toBe(200);
    expect(body(res)).toMatchObject({ configured: true, voices: [], voicesError: refusal.message });
  });

  it('answers 500 for anything unexpected, without the detail', async () => {
    const res = await handlers({
      listVoices: vi.fn(async () => {
        throw new Error('boom with xi-test-key');
      }),
      readAccount: vi.fn(async () => FREE),
    }).listVoices(request(), context);
    expect(res.status).toBe(500);
    expect(res.body).not.toContain('xi-test-key');
    expect(body(res)).toEqual({ error: 'Failed to list the ElevenLabs voices' });
  });
});

describe('previewVoice', () => {
  const MP3 = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0]);

  it('503s without a key, and 400s an id that is not one, fetching nothing', async () => {
    const fetchPreview = vi.fn();
    let res = await handlers({ env: {}, fetchPreview }).previewVoice(previewRequest(VOICES.Maya), context);
    expect(res.status).toBe(503);
    expect(body(res)).toMatchObject({ code: 'NOT_CONFIGURED' });
    for (const id of ['', 'Kore', '../../x', 'https://evil.example/a.mp3']) {
      res = await handlers({ fetchPreview }).previewVoice(previewRequest(id), context);
      expect(res.status).toBe(400);
    }
    expect(fetchPreview).not.toHaveBeenCalled();
  });

  it('answers the MP3 as audio/mpeg, private to the user, never sniffed', async () => {
    const fetchPreview = vi.fn(async () => ({ audio: MP3, contentType: 'audio/mpeg' }));
    const res = await handlers({ fetchPreview }).previewVoice(previewRequest(VOICES.Maya), context);
    expect(res.status).toBe(200);
    expect(res.headers).toEqual({
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(MP3.length),
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    expect(res.body).toBe(MP3);
    // The caller named an id; the URL is the module's to look up.
    expect(fetchPreview).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'xi-test-key', voiceId: VOICES.Maya })
    );
    expect(Object.keys(fetchPreview.mock.calls[0][0])).not.toContain('url');
  });

  it('maps refusals to 404 and 502 by code, never passing an upstream status through', async () => {
    const cases = [
      [{ code: 'voice_not_listed', status: 404 }, 404],
      [{ code: 'preview_unavailable', status: 404 }, 404],
      [{ code: 'preview_failed', status: 502 }, 502],
      // ElevenLabs's 401 for a key without Voices → Read must not read as a
      // signed-out session to the page.
      [{ code: 'voices_unavailable', status: 401 }, 502],
    ];
    for (const [fields, status] of cases) {
      const error = Object.assign(new SpeechError(`refused: ${fields.code}`), fields);
      const res = await handlers({
        fetchPreview: vi.fn(async () => {
          throw error;
        }),
      }).previewVoice(previewRequest(VOICES.Maya), context);
      expect(res.status).toBe(status);
      expect(body(res)).toEqual({ error: error.message, code: fields.code });
    }
    const res = await handlers({
      fetchPreview: vi.fn(async () => {
        throw new Error('unexpected');
      }),
    }).previewVoice(previewRequest(VOICES.Maya), context);
    expect(res.status).toBe(500);
  });

  it('end to end with fetch mocked: lists the key’s voices, then fetches only the preview host', async () => {
    const previewUrl = `https://storage.googleapis.com/eleven-public-prod/premade/voices/${VOICES.Maya}/p.mp3`;
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).startsWith(VOICES_URL)) {
        const type = new URL(url).searchParams.get('voice_type');
        const voices =
          type === 'default' ? [{ voice_id: VOICES.Maya, name: 'Talia', category: 'premade', preview_url: previewUrl }] : [];
        return { ok: true, status: 200, text: async () => JSON.stringify({ voices, has_more: false }) };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: (n) => (n.toLowerCase() === 'content-type' ? 'audio/mpeg' : null) },
        arrayBuffer: async () => Uint8Array.from(MP3).buffer,
      };
    });
    const res = await handlers({ fetchImpl }).previewVoice(previewRequest(VOICES.Maya), context);
    expect(res.status).toBe(200);
    expect([...res.body]).toEqual([...MP3]);
    const hosts = fetchImpl.mock.calls.map(([url]) => new URL(url).host);
    expect(new Set(hosts)).toEqual(new Set(['api.elevenlabs.io', 'storage.googleapis.com']));
    const [, previewInit] = fetchImpl.mock.calls.find(([url]) => String(url) === previewUrl);
    expect(JSON.stringify(previewInit)).not.toContain('xi-test-key');
  });
});
