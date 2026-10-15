/**
 * Provider selection, per product.
 *
 * The rule is the AI router's — a key makes a provider possible, and the
 * first configured one in preference order runs — applied per PRODUCT (owner
 * rule 2026-09-09, ADR 0029 §2b): Listen & Learn is Gemini then Azure, the
 * podcast is ElevenLabs alone, and nothing crosses over whatever keys exist.
 *
 * Until 2026-09-09 one global order put ElevenLabs first for every caller,
 * so the paid podcast voice read Listen & Learn and the Listen & Learn pin
 * governed the podcast. The tests of that order are replaced here by tests
 * of the product table, as §2b says they would be.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getCostEstimate } from '../../ai/router.js';
import { SPEECH_LIMITS } from './azure.js';
import { SUBSCRIPTION_URL, clearSubscriptionCache } from './elevenlabs-account.js';
import {
  CONTENT_TYPE,
  DEFAULT_VOICES,
  GEMINI_MODEL_SETTING,
  SPEECH_PIN_SETTINGS,
  SPEECH_PRODUCTS,
  SPEECH_USAGE_PRODUCTS,
  SpeechNotConfiguredError,
  estimateGeminiCostUsd,
  estimateSpeechCostUsd,
  readSetting,
  resolveSpeechProvider,
  speakableTurns,
  speechUsageRows,
  synthesizeDialogue,
} from './index.js';

const ELEVEN = { ELEVENLABS_API_KEY: 'e' };
const GEMINI = { GEMINI_API_KEY: 'g' };
const AZURE = { AZURE_SPEECH_KEY: 'a', AZURE_SPEECH_REGION: 'eastus' };
const ALL = { ...ELEVEN, ...GEMINI, ...AZURE };

const LL = { product: 'listenAndLearn' };
/**
 * The podcast product, with the voices every podcast caller passes: the
 * owner's stored choice (#725). ElevenLabs has no default voice, so a render
 * without them refuses before sending. The other entry points ignore
 * `voices`, so the same object serves resolveSpeechProvider and the estimate.
 */
const PODCAST_VOICES = Object.freeze({
  Maya: 'MayaVoice00000000001',
  Elena: 'ElenaVoice0000000002',
});
const POD = { product: 'podcast', voices: PODCAST_VOICES };

const DIALOGUE = [
  { speaker: 'Maya', text: 'Hello' },
  { speaker: 'Elena', text: 'Hi' },
];

const pcmBase64 = (samples = 2400) =>
  Buffer.from(new Int16Array(samples).fill(500).buffer).toString('base64');

const geminiOk = () =>
  vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      status: 'completed',
      steps: [
        {
          type: 'model_output',
          content: [
            { type: 'audio', data: pcmBase64(), mime_type: 'audio/L16', sample_rate: 24000 },
          ],
        },
      ],
    }),
  }));

const azureOk = () =>
  vi.fn(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => Uint8Array.from([0xff, 0xfb, 1, 2]).buffer,
  }));

/**
 * ElevenLabs reads the account before it renders (elevenlabs-account.js), so
 * an ElevenLabs stub answers that read with a free month and hands the
 * dialogue request to `dialogue`. `dialogueCalls` is what was posted.
 */
const FREE_ACCOUNT = JSON.stringify({
  tier: 'free',
  status: 'free',
  character_count: 0,
  character_limit: 10000,
  next_character_count_reset_unix: 1792972800,
  can_extend_character_limit: false,
  max_credit_limit_extension: 0,
});
const elevenLabs = (dialogue) =>
  vi.fn(async (url) =>
    String(url).startsWith(SUBSCRIPTION_URL)
      ? { ok: true, status: 200, text: async () => FREE_ACCOUNT }
      : dialogue()
  );
const dialogueCalls = (fetchImpl) =>
  fetchImpl.mock.calls.filter(([url]) => String(url).includes('/v1/text-to-dialogue'));

const elevenOk = () =>
  elevenLabs(() => ({
    ok: true,
    status: 200,
    headers: { get: (n) => (n === 'character-cost' ? '7' : null) },
    arrayBuffer: async () => Uint8Array.from([0xff, 0xfb, 9, 9]).buffer,
    text: async () => '',
  }));

const QUOTA_BODY = JSON.stringify({ detail: { status: 'quota_exceeded', message: 'no credits' } });
const elevenOutOfCredit = () =>
  elevenLabs(() => ({
    ok: false,
    status: 401,
    headers: { get: () => null },
    text: async () => QUOTA_BODY,
  }));

beforeEach(() => {
  clearSubscriptionCache();
});

/** Route by host, so one fetch stub can prove which provider was reached. */
const byHost = (handlers) =>
  vi.fn(async (url, init) => {
    const host = new URL(url).hostname;
    const handler = Object.entries(handlers).find(([needle]) => host.includes(needle))?.[1];
    if (!handler) throw new Error(`unexpected host ${host}`);
    return handler(url, init);
  });

const noSleep = async () => {};

describe('readSetting', () => {
  it('treats an unresolved Key Vault reference as absent, not as a key', () => {
    // App Service hands the literal string through when a reference fails to
    // resolve. Sending it as a key produces a 401 that looks like a bad secret.
    expect(readSetting({ K: '@Microsoft.KeyVault(SecretUri=https://v/s/1)' }, 'K')).toBe('');
    expect(readSetting({ K: '  k  ' }, 'K')).toBe('k');
    expect(readSetting({}, 'K')).toBe('');
  });
});

describe('the product table', () => {
  it('is the owner’s rule: Gemini then Azure for Listen & Learn, ElevenLabs alone for the podcast', () => {
    expect(SPEECH_PRODUCTS).toEqual({
      listenAndLearn: ['gemini', 'azure'],
      podcast: ['elevenlabs'],
    });
    expect(Object.isFrozen(SPEECH_PRODUCTS)).toBe(true);
    expect(Object.isFrozen(SPEECH_PRODUCTS.listenAndLearn)).toBe(true);
  });

  it('gives each product its own pin setting', () => {
    expect(SPEECH_PIN_SETTINGS).toEqual({
      listenAndLearn: 'LISTEN_AND_LEARN_TTS_PROVIDER',
      podcast: 'PODCAST_TTS_PROVIDER',
    });
  });

  it('refuses to choose without a product, in a sentence', () => {
    // A caller that forgot the product is the defect this table exists to
    // remove; guessing a default would reintroduce it silently.
    expect(() => resolveSpeechProvider(ALL)).toThrow(
      /Speech needs a product to choose a provider for \(one of listenAndLearn, podcast\); none was given/
    );
    expect(() => resolveSpeechProvider(ALL, {})).toThrow(/none was given/);
    expect(() => resolveSpeechProvider(ALL, { product: 'newsletter' })).toThrow(
      /unknown product "newsletter"; known products are listenAndLearn, podcast/
    );
    // Own-key lookup: inherited names are not products.
    expect(() => resolveSpeechProvider(ALL, { product: 'constructor' })).toThrow(/unknown product/);
    expect(() => estimateSpeechCostUsd({ ceilingBytes: 9000, env: ALL })).toThrow(/none was given/);
  });

  it('refuses to synthesise without a product before touching any provider', async () => {
    const fetchImpl = vi.fn();
    await expect(synthesizeDialogue({ dialogue: DIALOGUE, env: ALL, fetchImpl })).rejects.toThrow(
      /none was given/
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('resolveSpeechProvider — Listen & Learn', () => {
  it('returns nothing when no provider has a key', () => {
    expect(resolveSpeechProvider({}, LL)).toBeNull();
  });

  it('chooses Gemini even when the ElevenLabs key is present', () => {
    // The defect: ElevenLabs first in a global order read every study
    // episode the moment its key landed. ElevenLabs is the podcast voice only.
    expect(resolveSpeechProvider(ALL, LL).name).toBe('gemini');
    expect(resolveSpeechProvider({ ...ELEVEN, ...GEMINI }, LL).name).toBe('gemini');
    expect(resolveSpeechProvider(GEMINI, LL).name).toBe('gemini');
  });

  it('never offers ElevenLabs, even as the only configured provider', () => {
    expect(resolveSpeechProvider(ELEVEN, LL)).toBeNull();
    expect(resolveSpeechProvider({ ...ELEVEN, ...AZURE }, LL).name).toBe('azure');
  });

  it('falls back to Azure when only it is configured', () => {
    expect(resolveSpeechProvider(AZURE, LL).name).toBe('azure');
    expect(resolveSpeechProvider({ ...GEMINI, ...AZURE }, LL).name).toBe('gemini');
  });

  it('does not count an Azure key with nowhere to send it', () => {
    // A key and no region is not a usable configuration; treating it as one
    // would pick Azure and then fail every episode.
    expect(resolveSpeechProvider({ AZURE_SPEECH_KEY: 'a' }, LL)).toBeNull();
    expect(
      resolveSpeechProvider(
        { AZURE_SPEECH_KEY: 'a', AZURE_SPEECH_ENDPOINT: 'https://h/cognitiveservices/v1' },
        LL
      ).name
    ).toBe('azure');
  });

  it('ignores an unresolved Key Vault reference when deciding', () => {
    expect(
      resolveSpeechProvider({ GEMINI_API_KEY: '@Microsoft.KeyVault(SecretUri=https://v/s/1)' }, LL)
    ).toBeNull();
    expect(
      resolveSpeechProvider(
        { GEMINI_API_KEY: '@Microsoft.KeyVault(SecretUri=https://v/s/1)', ...AZURE },
        LL
      ).name
    ).toBe('azure');
  });

  it('honours a pin naming one of its own providers', () => {
    expect(resolveSpeechProvider({ ...ALL, LISTEN_AND_LEARN_TTS_PROVIDER: 'azure' }, LL).name).toBe(
      'azure'
    );
    expect(
      resolveSpeechProvider({ ...ALL, LISTEN_AND_LEARN_TTS_PROVIDER: 'gemini' }, LL).name
    ).toBe('gemini');
    expect(
      resolveSpeechProvider({ ...ALL, LISTEN_AND_LEARN_TTS_PROVIDER: 'Gemini' }, LL).name
    ).toBe('gemini');
  });

  it('fails a pin that is not configured rather than falling through', () => {
    // Falling through would silently produce episodes in a voice nobody chose.
    expect(() =>
      resolveSpeechProvider({ ...GEMINI, LISTEN_AND_LEARN_TTS_PROVIDER: 'azure' }, LL)
    ).toThrow(/LISTEN_AND_LEARN_TTS_PROVIDER pins "azure", which is not configured/);
    expect(() =>
      resolveSpeechProvider({ ...AZURE, LISTEN_AND_LEARN_TTS_PROVIDER: 'gemini' }, LL)
    ).toThrow(SpeechNotConfiguredError);
  });

  it('refuses a pin naming elevenlabs with a sentence quoting the rule, key or no key', () => {
    const rule =
      /LISTEN_AND_LEARN_TTS_PROVIDER pins "elevenlabs", which is not a Listen & Learn provider — ElevenLabs is only the podcast voice; Listen & Learn audio is Gemini TTS, with Azure AI Speech as the fallback \(ADR 0029 §2b\)\. Listen & Learn may pin gemini or azure/;
    expect(() =>
      resolveSpeechProvider({ ...ALL, LISTEN_AND_LEARN_TTS_PROVIDER: 'elevenlabs' }, LL)
    ).toThrow(rule);
    expect(() =>
      resolveSpeechProvider({ ...GEMINI, LISTEN_AND_LEARN_TTS_PROVIDER: 'ElevenLabs' }, LL)
    ).toThrow(rule);
    expect(() =>
      resolveSpeechProvider({ ...ALL, LISTEN_AND_LEARN_TTS_PROVIDER: 'elevenlabs' }, LL)
    ).toThrow(SpeechNotConfiguredError);
  });

  it('names its own providers when the pin is not one at all', () => {
    expect(() =>
      resolveSpeechProvider({ ...GEMINI, LISTEN_AND_LEARN_TTS_PROVIDER: 'polly' }, LL)
    ).toThrow(
      /LISTEN_AND_LEARN_TTS_PROVIDER is "polly"; Listen & Learn providers are gemini, azure/
    );
  });

  it('does not read the podcast’s pin', () => {
    expect(resolveSpeechProvider({ ...ALL, PODCAST_TTS_PROVIDER: 'polly' }, LL).name).toBe(
      'gemini'
    );
  });
});

describe('resolveSpeechProvider — podcast', () => {
  it('is ElevenLabs when its key is present', () => {
    expect(resolveSpeechProvider(ALL, POD).name).toBe('elevenlabs');
    expect(resolveSpeechProvider(ELEVEN, POD).name).toBe('elevenlabs');
  });

  it('never falls back to Gemini or Azure', () => {
    // A podcast episode in the study-podcast voice is the wrong product's
    // voice, not a degraded reading; without the key there is no provider.
    expect(resolveSpeechProvider({ ...GEMINI, ...AZURE }, POD)).toBeNull();
    expect(resolveSpeechProvider({}, POD)).toBeNull();
  });

  it('reads only its own pin, and only for its own provider', () => {
    expect(resolveSpeechProvider({ ...ALL, PODCAST_TTS_PROVIDER: 'elevenlabs' }, POD).name).toBe(
      'elevenlabs'
    );
    expect(() =>
      resolveSpeechProvider({ ...GEMINI, PODCAST_TTS_PROVIDER: 'elevenlabs' }, POD)
    ).toThrow(/PODCAST_TTS_PROVIDER pins "elevenlabs", which is not configured/);
    expect(() => resolveSpeechProvider({ ...ALL, PODCAST_TTS_PROVIDER: 'gemini' }, POD)).toThrow(
      /PODCAST_TTS_PROVIDER pins "gemini", which is not a podcast provider — ElevenLabs is only the podcast voice.*podcast may pin elevenlabs/
    );
    // The Listen & Learn pin — the one Terraform sets to "gemini" — does not
    // reach the podcast. Before 2026-09-09 it did, which is what made the
    // owner's setting unsafe to apply.
    expect(
      resolveSpeechProvider({ ...ALL, LISTEN_AND_LEARN_TTS_PROVIDER: 'gemini' }, POD).name
    ).toBe('elevenlabs');
  });
});

describe('synthesizeDialogue', () => {
  it('reads Listen & Learn with Gemini when every key is present, and reports which provider ran', async () => {
    const eleven = elevenOk();
    const gemini = geminiOk();
    const fetchImpl = byHost({ 'elevenlabs.io': eleven, 'googleapis.com': gemini });

    const result = await synthesizeDialogue({ ...LL, dialogue: DIALOGUE, env: ALL, fetchImpl });

    expect(result.provider).toBe('gemini');
    expect(result.model).toBe('gemini-2.5-flash-preview-tts');
    expect(result).not.toHaveProperty('fellBackFrom');
    expect(gemini).toHaveBeenCalledTimes(1);
    expect(eleven).not.toHaveBeenCalled();
  });

  it('reads the podcast with ElevenLabs', async () => {
    const eleven = elevenOk();
    const gemini = geminiOk();
    const fetchImpl = byHost({ 'elevenlabs.io': eleven, 'googleapis.com': gemini });

    const result = await synthesizeDialogue({ ...POD, dialogue: DIALOGUE, env: ALL, fetchImpl });

    expect(result.provider).toBe('elevenlabs');
    expect(result.model).toBe('eleven_v3');
    expect(dialogueCalls(eleven)).toHaveLength(1);
    expect(eleven).toHaveBeenCalledTimes(2); // the pre-flight read, then the dialogue
    expect(gemini).not.toHaveBeenCalled();
    // The plan the audio was rendered on rides out with it, for the podcast
    // to record (ADR 0029 §2a, 2026-09-26).
    expect(result.subscription).toMatchObject({ tier: 'free', freePlan: true });
  });

  it('routes Listen & Learn to Azure when that is the configured one', async () => {
    const fetchImpl = azureOk();
    const result = await synthesizeDialogue({ ...LL, dialogue: DIALOGUE, env: AZURE, fetchImpl });

    expect(result.provider).toBe('azure');
    expect(fetchImpl.mock.calls[0][0]).toContain('tts.speech.microsoft.com');
  });

  it('returns the same content type whichever provider ran', async () => {
    // The provider is an implementation detail of this directory: the blob
    // path, the stored contentType and the <audio> element must not vary.
    const viaEleven = await synthesizeDialogue({
      ...POD,
      dialogue: DIALOGUE,
      env: ELEVEN,
      fetchImpl: elevenOk(),
    });
    const viaGemini = await synthesizeDialogue({
      ...LL,
      dialogue: DIALOGUE,
      env: GEMINI,
      fetchImpl: geminiOk(),
    });
    const viaAzure = await synthesizeDialogue({
      ...LL,
      dialogue: DIALOGUE,
      env: AZURE,
      fetchImpl: azureOk(),
    });

    expect(viaEleven.contentType).toBe(CONTENT_TYPE);
    expect(viaGemini.contentType).toBe(CONTENT_TYPE);
    expect(viaAzure.contentType).toBe(CONTENT_TYPE);
    expect(CONTENT_TYPE).toBe('audio/mpeg');
  });

  describe('the Gemini model', () => {
    const modelSent = (fetchImpl) => JSON.parse(fetchImpl.mock.calls[0][1].body).model;

    it('is the caller’s choice when one is given', async () => {
      const fetchImpl = geminiOk();
      const result = await synthesizeDialogue({
        ...LL,
        dialogue: DIALOGUE,
        model: 'gemini-2.5-flash-preview-tts',
        env: { ...GEMINI, [GEMINI_MODEL_SETTING]: 'gemini-3.1-flash-tts-preview' },
        fetchImpl,
      });
      expect(modelSent(fetchImpl)).toBe('gemini-2.5-flash-preview-tts');
      expect(result.model).toBe('gemini-2.5-flash-preview-tts');
    });

    it('is the setting when the caller chose nothing, and the module default under that', async () => {
      const pinned = geminiOk();
      await synthesizeDialogue({
        ...LL,
        dialogue: DIALOGUE,
        env: { ...GEMINI, [GEMINI_MODEL_SETTING]: 'gemini-2.5-flash-preview-tts' },
        fetchImpl: pinned,
      });
      expect(modelSent(pinned)).toBe('gemini-2.5-flash-preview-tts');

      const bare = geminiOk();
      await synthesizeDialogue({
        ...LL,
        dialogue: DIALOGUE,
        model: null,
        env: GEMINI,
        fetchImpl: bare,
      });
      // Economy, the cheapest sensible voice (ADR 0033 §4).
      expect(modelSent(bare)).toBe('gemini-2.5-flash-preview-tts');
    });

    it('never writes the choice into the caller’s env', async () => {
      const env = { ...GEMINI };
      await synthesizeDialogue({
        ...LL,
        dialogue: DIALOGUE,
        model: 'gemini-2.5-flash-preview-tts',
        env,
        fetchImpl: geminiOk(),
      });
      expect(env).toEqual(GEMINI);
    });


    it('an eleven_* id reaches ElevenLabs and no other provider (ADR 0034 slice 5: the task’s model, by id-space)', async () => {
      // The podcastVoice task resolves to an ElevenLabs id; a Gemini id for
      // Listen & Learn never reaches ElevenLabs, as the test above holds.
      const fetchImpl = elevenOk();
      const result = await synthesizeDialogue({
        ...POD,
        dialogue: DIALOGUE,
        model: 'eleven_v4',
        env: ELEVEN,
        fetchImpl,
      });
      expect(result.model).toBe('eleven_v4');
      expect(JSON.parse(dialogueCalls(fetchImpl)[0][1].body).model_id).toBe('eleven_v4');
      // And the estimate prices the same model the render would use.
      expect(
        estimateSpeechCostUsd({ product: 'podcast', dialogue: DIALOGUE, model: 'eleven_v4', env: ELEVEN })
      ).toMatchObject({ provider: 'elevenlabs', model: 'eleven_v4' });
      // An ElevenLabs id handed to Listen & Learn is not a Gemini model and is ignored there.
      expect(
        estimateSpeechCostUsd({ product: 'listenAndLearn', dialogue: DIALOGUE, model: 'eleven_v3', env: GEMINI })
      ).toMatchObject({ provider: 'gemini', model: 'gemini-2.5-flash-preview-tts' });
    });
    it('is ignored by the podcast, whose model is ElevenLabs’s own', async () => {
      const fetchImpl = elevenOk();
      const result = await synthesizeDialogue({
        ...POD,
        dialogue: DIALOGUE,
        model: 'gemini-2.5-flash-preview-tts',
        env: ELEVEN,
        fetchImpl,
      });
      expect(result.model).toBe('eleven_v3');
      expect(JSON.parse(dialogueCalls(fetchImpl)[0][1].body).model_id).toBe('eleven_v3');
    });
  });

  describe('nothing falls through', () => {
    it('surfaces ElevenLabs’s out-of-credit error to the podcast rather than reading it with Gemini', async () => {
      // #447 fell through to Gemini here. That was the cross-product path
      // the owner's rule forbids, and it is gone rather than scoped.
      const eleven = elevenOutOfCredit();
      const gemini = geminiOk();
      const fetchImpl = byHost({ 'elevenlabs.io': eleven, 'googleapis.com': gemini });

      await expect(
        synthesizeDialogue({ ...POD, dialogue: DIALOGUE, env: ALL, fetchImpl, sleep: noSleep })
      ).rejects.toMatchObject({
        name: 'SpeechError',
        provider: 'elevenlabs',
        status: 401,
        code: 'quota_exceeded',
      });
      expect(dialogueCalls(eleven)).toHaveLength(1); // not retried
      expect(gemini).not.toHaveBeenCalled();
    });

    it('does not fall back to Gemini when the ElevenLabs pre-flight refuses the job either', async () => {
      // Too few credits for the job: refused before any dialogue request,
      // and still not read with Gemini.
      const eleven = vi.fn(async (url) =>
        String(url).startsWith(SUBSCRIPTION_URL)
          ? {
              ok: true,
              status: 200,
              text: async () =>
                JSON.stringify({ ...JSON.parse(FREE_ACCOUNT), character_count: 10000 }),
            }
          : { ok: true, status: 200 }
      );
      const gemini = geminiOk();
      const fetchImpl = byHost({ 'elevenlabs.io': eleven, 'googleapis.com': gemini });

      await expect(
        synthesizeDialogue({ ...POD, dialogue: DIALOGUE, env: ALL, fetchImpl, sleep: noSleep })
      ).rejects.toMatchObject({
        provider: 'elevenlabs',
        code: 'quota_exceeded',
        details: expect.objectContaining({ preflight: true, left: 0 }),
      });
      expect(dialogueCalls(eleven)).toHaveLength(0);
      expect(gemini).not.toHaveBeenCalled();
    });

    it('does not fall back on any other failure either', async () => {
      // A rejected key or a 5xx elsewhere would hide a fault behind a
      // different voice.
      const eleven = elevenLabs(() => ({
        ok: false,
        status: 401,
        headers: { get: () => null },
        text: async () => JSON.stringify({ detail: { status: 'invalid_api_key' } }),
      }));
      const gemini = geminiOk();
      const fetchImpl = byHost({ 'elevenlabs.io': eleven, 'googleapis.com': gemini });

      await expect(
        synthesizeDialogue({ ...POD, dialogue: DIALOGUE, env: ALL, fetchImpl, sleep: noSleep })
      ).rejects.toThrow(/ElevenLabs answered HTTP 401/);
      expect(gemini).not.toHaveBeenCalled();
    });
  });

  describe('not configured', () => {
    it('degrades Listen & Learn with a distinguishable error naming its own requirements', async () => {
      // generate.js keys off this name to publish a transcript-only episode
      // rather than failing the area. Azure is not configured by its key
      // alone (PROVIDERS.extra), and ElevenLabs is not a thing to seed for
      // this product, so it is not named.
      const fetchImpl = vi.fn();
      const attempt = synthesizeDialogue({ ...LL, dialogue: DIALOGUE, env: ELEVEN, fetchImpl });
      await expect(attempt).rejects.toBeInstanceOf(SpeechNotConfiguredError);
      await expect(attempt).rejects.toThrow(
        /^No Listen & Learn speech provider is configured — set GEMINI_API_KEY, or AZURE_SPEECH_KEY together with AZURE_SPEECH_REGION or AZURE_SPEECH_ENDPOINT$/
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('degrades the podcast naming ELEVENLABS_API_KEY, whatever other keys exist', async () => {
      // lib/podcast/generate.js records this sentence as the draft's
      // audioError; a Gemini key present is not a reason to read with it.
      const fetchImpl = vi.fn();
      const attempt = synthesizeDialogue({
        ...POD,
        dialogue: DIALOGUE,
        env: { ...GEMINI, ...AZURE },
        fetchImpl,
      });
      await expect(attempt).rejects.toBeInstanceOf(SpeechNotConfiguredError);
      await expect(attempt).rejects.toThrow(
        /^No podcast speech provider is configured — set ELEVENLABS_API_KEY$/
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('reports an unusable pin by the same name, so the caller degrades the same way', async () => {
      await expect(
        synthesizeDialogue({
          ...LL,
          dialogue: DIALOGUE,
          env: { ...ALL, LISTEN_AND_LEARN_TTS_PROVIDER: 'elevenlabs' },
          fetchImpl: vi.fn(),
        })
      ).rejects.toBeInstanceOf(SpeechNotConfiguredError);
    });
  });

  it('refuses an empty dialogue before choosing a provider', async () => {
    await expect(
      synthesizeDialogue({ ...LL, dialogue: [{ speaker: 'Maya', text: '  ' }], env: GEMINI })
    ).rejects.toThrow(/No dialogue turns/);
  });

  it('publishes a default voice map for every provider, and none for ElevenLabs, whose voices the owner chooses', () => {
    expect(Object.keys(DEFAULT_VOICES).sort()).toEqual(['azure', 'elevenlabs', 'gemini']);
    // The two Listen & Learn providers name the same two hosts the script writes.
    for (const provider of ['gemini', 'azure']) {
      expect(Object.keys(DEFAULT_VOICES[provider])).toEqual(['Maya', 'Elena']);
    }
    // The podcast's come from admin_config/podcast_voices (#725).
    expect(DEFAULT_VOICES.elevenlabs).toEqual({});
  });

  it('refuses a podcast render with no voices chosen, before anything is sent', async () => {
    const fetchImpl = elevenOk();
    await expect(
      synthesizeDialogue({ product: 'podcast', dialogue: DIALOGUE, env: ALL, fetchImpl })
    ).rejects.toMatchObject({ provider: 'elevenlabs', code: 'voices_not_chosen' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('estimateSpeechCostUsd', () => {
  it('is null when nothing is configured for the product, or the pin is unusable', () => {
    expect(estimateSpeechCostUsd({ ...LL, dialogue: DIALOGUE, env: {} })).toBeNull();
    // ElevenLabs alone configures nothing for Listen & Learn.
    expect(estimateSpeechCostUsd({ ...LL, dialogue: DIALOGUE, env: ELEVEN })).toBeNull();
    expect(estimateSpeechCostUsd({ ...POD, dialogue: DIALOGUE, env: GEMINI })).toBeNull();
    expect(
      estimateSpeechCostUsd({
        ...LL,
        dialogue: DIALOGUE,
        env: { ...ALL, LISTEN_AND_LEARN_TTS_PROVIDER: 'elevenlabs' },
      })
    ).toBeNull();
  });

  it('prices Listen & Learn with Gemini even when the ElevenLabs key is present', () => {
    const estimate = estimateSpeechCostUsd({ ...LL, ceilingBytes: 9000, env: ALL });
    expect(estimate.provider).toBe('gemini');
    expect(estimate.model).toBe('gemini-2.5-flash-preview-tts');
  });

  it('returns null, not $0, for a dialogue synthesis would refuse', async () => {
    // Copilot review on #447: a whitespace-only dialogue estimated 0 while
    // synthesizeDialogue threw "No dialogue turns to synthesise".
    const blank = [
      { speaker: 'Maya', text: '  ' },
      { speaker: 'Elena', text: '' },
    ];
    expect(estimateSpeechCostUsd({ ...POD, dialogue: blank, env: ELEVEN })).toBeNull();
    expect(estimateSpeechCostUsd({ ...POD, dialogue: [], env: ELEVEN })).toBeNull();
    expect(estimateSpeechCostUsd({ ...POD, env: ELEVEN })).toBeNull();
    await expect(synthesizeDialogue({ ...POD, dialogue: blank, env: ELEVEN })).rejects.toThrow(
      /No dialogue turns/
    );
    // A ceiling is still priced with no dialogue: that is the enqueue path.
    expect(
      estimateSpeechCostUsd({ ...POD, ceilingBytes: 9000, env: ELEVEN }).estimatedCostUsd
    ).toBe(0.9);
  });

  it('counts exactly the turns synthesis would speak, through one shared filter', async () => {
    // The estimate and the synthesis use the same exported helper, so a turn
    // dropped by one is dropped by the other: the estimate of a dialogue with
    // blank turns equals the estimate of the filtered dialogue, and the
    // request synthesis sends contains only the filtered turns.
    const mixed = [
      { speaker: 'Maya', text: 'Hello' },
      { speaker: 'Elena', text: '   ' },
      { speaker: 'Elena', text: 'Hi' },
      { speaker: 'Maya', text: '' },
    ];
    expect(speakableTurns(mixed)).toEqual([
      { speaker: 'Maya', text: 'Hello' },
      { speaker: 'Elena', text: 'Hi' },
    ]);
    expect(speakableTurns(null)).toEqual([]);
    expect(estimateSpeechCostUsd({ ...POD, dialogue: mixed, env: ELEVEN })).toEqual(
      estimateSpeechCostUsd({ ...POD, dialogue: speakableTurns(mixed), env: ELEVEN })
    );
    expect(estimateSpeechCostUsd({ ...POD, dialogue: mixed, env: ELEVEN }).characters).toBe(7);

    const fetchImpl = elevenOk();
    await synthesizeDialogue({ ...POD, dialogue: mixed, env: ELEVEN, fetchImpl });
    const sent = JSON.parse(dialogueCalls(fetchImpl)[0][1].body).inputs.map((i) => i.text);
    expect(sent).toEqual(speakableTurns(mixed).map((t) => t.text));
  });

  it('counts turns trimmed, as the providers send them, so padding never inflates the figure', () => {
    // Every provider trims a turn before posting it; a count taken before the
    // trim overstated the estimate shown to the operator (Copilot on #447).
    const trimmed = [
      { speaker: 'Maya', text: 'Hello there' },
      { speaker: 'Elena', text: 'Hi back' },
    ];
    const padded = [
      { speaker: 'Maya', text: '   Hello there \n' },
      { speaker: 'Elena', text: '\t Hi back   ' },
    ];
    expect(speakableTurns(padded)).toEqual(trimmed);
    for (const [product, env] of [
      [POD, ELEVEN],
      [LL, GEMINI],
    ]) {
      expect(estimateSpeechCostUsd({ ...product, dialogue: padded, env })).toEqual(
        estimateSpeechCostUsd({ ...product, dialogue: trimmed, env })
      );
    }
    expect(estimateSpeechCostUsd({ ...POD, dialogue: padded, env: ELEVEN })).toMatchObject({
      characters: 18,
      bytes: 18,
    });
  });

  it('prices the podcast by characters at the cost-table rate, before any request', () => {
    // 'Hello' + 'Hi' = 7 characters at USD 0.10 per 1,000.
    expect(estimateSpeechCostUsd({ ...POD, dialogue: DIALOGUE, env: ALL })).toEqual({
      provider: 'elevenlabs',
      model: 'eleven_v3',
      bytes: 7,
      characters: 7,
      estimatedCostUsd: 0.0007,
    });
  });

  it('accepts a byte ceiling when there is no dialogue yet, and does not call it characters', () => {
    // A 9,000-byte ceiling is at most 9,000 characters, 90 cents an episode.
    // `characters` is null because none were counted.
    expect(estimateSpeechCostUsd({ ...POD, ceilingBytes: 9000, env: ELEVEN })).toMatchObject({
      provider: 'elevenlabs',
      bytes: 9000,
      characters: null,
      estimatedCostUsd: 0.9,
    });
  });

  it('gives a best-effort figure for Gemini that over- rather than under-estimates', () => {
    // 9,000 bytes ÷ 13 bytes/s ≈ 692 s × 32 tokens/s ≈ 22,154 tokens at
    // USD 20 per 1M (the 3.1 flash rate) ≈ USD 0.44 — above twice the
    // ~USD 0.17 an episode measured on 2.5 flash, which is priced at half that.
    const estimate = estimateSpeechCostUsd({
      ...LL,
      ceilingBytes: 9000,
      model: 'gemini-3.1-flash-tts-preview',
      env: GEMINI,
    });
    expect(estimate.provider).toBe('gemini');
    expect(estimate.model).toBe('gemini-3.1-flash-tts-preview');
    expect(estimate.estimatedCostUsd).toBeGreaterThan(0.34);
    expect(estimate.estimatedCostUsd).toBeLessThan(0.6);
    expect(estimate.estimatedCostUsd).toBe(
      estimateGeminiCostUsd('gemini-3.1-flash-tts-preview', 9000)
    );
    // The default, Economy, is half of that (ADR 0033 §4).
    const economy = estimateSpeechCostUsd({ ...LL, ceilingBytes: 9000, env: GEMINI });
    expect(economy.model).toBe('gemini-2.5-flash-preview-tts');
    expect(economy.estimatedCostUsd).toBeCloseTo(estimate.estimatedCostUsd / 2, 6);
  });

  it('rounds a fractional token count UP, so the ceiling is never below the exact value', () => {
    // 1 byte ÷ 13 bytes/s × 32 tokens/s ≈ 2.46 tokens: Math.round gave 2,
    // below the exact figure a "ceiling" must not sit under (Copilot on the
    // PR). Checked across a spread of sizes, and for the byte ceiling too.
    const exact = (model, bytes) =>
      getCostEstimate('gemini', model, 0, (bytes / SPEECH_LIMITS.BYTES_PER_SECOND) * 32);
    for (const bytes of [1, 7, 13, 100, 8999, 9000]) {
      for (const model of ['gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts']) {
        expect(estimateGeminiCostUsd(model, bytes)).toBeGreaterThanOrEqual(exact(model, bytes));
      }
    }
    expect(estimateGeminiCostUsd('gemini-3.1-flash-tts-preview', 1)).toBe(
      getCostEstimate('gemini', 'gemini-3.1-flash-tts-preview', 0, 3)
    );
    // A fractional byte ceiling is taken up to the next whole byte, not to nearest.
    expect(estimateSpeechCostUsd({ ...LL, ceilingBytes: 12.2, env: GEMINI })).toMatchObject({
      bytes: 13,
    });
    expect(
      estimateSpeechCostUsd({ ...POD, ceilingBytes: 12.2, env: ELEVEN }).estimatedCostUsd
    ).toBe(getCostEstimate('elevenlabs', 'eleven_v3', 0, 13));
  });

  it('prices the Economy model at half the Best model, from the cost table', () => {
    const best = estimateGeminiCostUsd('gemini-3.1-flash-tts-preview', 9000);
    const economy = estimateGeminiCostUsd('gemini-2.5-flash-preview-tts', 9000);
    expect(best).toBeGreaterThan(0);
    expect(economy).toBeCloseTo(best / 2, 6);
    expect(estimateGeminiCostUsd('gemini-2.5-flash-preview-tts', 0)).toBe(0);
  });

  it('measures Gemini in bytes, so a non-ASCII script is never priced below its ASCII twin', () => {
    // The speaking rate borrowed from azure.js is UTF-8 bytes per second;
    // dividing a character count by it under-estimated every non-ASCII
    // script (Copilot review on #447). Same code-point length, more bytes.
    const ascii = [{ speaker: 'Maya', text: 'a'.repeat(1300) }];
    const accented = [{ speaker: 'Maya', text: 'é'.repeat(1300) }]; // 2 bytes each
    const cjk = [{ speaker: 'Maya', text: '語'.repeat(1300) }]; // 3 bytes each

    const cost = (dialogue) =>
      estimateSpeechCostUsd({ ...LL, dialogue, env: GEMINI }).estimatedCostUsd;
    expect(cost(ascii)).toBeGreaterThan(0);
    expect(cost(accented)).toBeCloseTo(cost(ascii) * 2, 6);
    expect(cost(cjk)).toBeCloseTo(cost(ascii) * 3, 6);
    // The billed unit for ElevenLabs is still characters, unchanged by width.
    expect(estimateSpeechCostUsd({ ...POD, dialogue: cjk, env: ELEVEN }).characters).toBe(1300);
    expect(estimateSpeechCostUsd({ ...POD, dialogue: cjk, env: ELEVEN }).estimatedCostUsd).toBe(
      estimateSpeechCostUsd({ ...POD, dialogue: ascii, env: ELEVEN }).estimatedCostUsd
    );
  });

  it('treats a bare ceiling as bytes, so it never sits below any script that fits under it', () => {
    // The enqueue path passes MAX_SCRIPT_BYTES with no dialogue. A 9,000-byte
    // script of three-byte characters is the widest that fits.
    const widest = [{ speaker: 'Maya', text: '語'.repeat(3000) }];
    for (const [product, env] of [
      [LL, GEMINI],
      [POD, ELEVEN],
    ]) {
      const ceiling = estimateSpeechCostUsd({
        ...product,
        ceilingBytes: 9000,
        env,
      }).estimatedCostUsd;
      const actual = estimateSpeechCostUsd({ ...product, dialogue: widest, env }).estimatedCostUsd;
      expect(ceiling).toBeGreaterThanOrEqual(actual);
    }
    // And a plain ASCII script under the ceiling is priced strictly below it.
    const plain = [{ speaker: 'Maya', text: 'a'.repeat(8000) }];
    expect(
      estimateSpeechCostUsd({ ...LL, ceilingBytes: 9000, env: GEMINI }).estimatedCostUsd
    ).toBeGreaterThan(
      estimateSpeechCostUsd({ ...LL, dialogue: plain, env: GEMINI }).estimatedCostUsd
    );
  });

  it('is honest that Azure Speech is not priced', () => {
    expect(estimateSpeechCostUsd({ ...LL, ceilingBytes: 9000, env: AZURE })).toEqual({
      provider: 'azure',
      model: null,
      bytes: 9000,
      characters: null,
      estimatedCostUsd: null,
    });
  });

  it('follows a pin, a model choice and a model setting, in that order', () => {
    expect(
      estimateSpeechCostUsd({
        ...LL,
        ceilingBytes: 1000,
        env: { ...ALL, LISTEN_AND_LEARN_TTS_PROVIDER: 'azure' },
      }).provider
    ).toBe('azure');
    // The caller's choice beats the setting; the setting beats the default.
    const chosen = estimateSpeechCostUsd({
      ...LL,
      ceilingBytes: 9000,
      model: 'gemini-2.5-flash-preview-tts',
      env: { ...GEMINI, [GEMINI_MODEL_SETTING]: 'gemini-3.1-flash-tts-preview' },
    });
    expect(chosen.model).toBe('gemini-2.5-flash-preview-tts');
    expect(chosen.estimatedCostUsd).toBe(
      estimateGeminiCostUsd('gemini-2.5-flash-preview-tts', 9000)
    );
    expect(
      estimateSpeechCostUsd({
        ...LL,
        ceilingBytes: 1000,
        env: { ...GEMINI, [GEMINI_MODEL_SETTING]: 'gemini-2.5-pro-preview-tts' },
      }).model
    ).toBe('gemini-2.5-pro-preview-tts');
    // The podcast prices its own model setting and ignores the Gemini one.
    expect(
      estimateSpeechCostUsd({
        ...POD,
        ceilingBytes: 1000,
        model: 'gemini-2.5-flash-preview-tts',
        env: {
          ...ELEVEN,
          [GEMINI_MODEL_SETTING]: 'gemini-3.1-flash-tts-preview',
          LISTEN_AND_LEARN_ELEVENLABS_MODEL: 'eleven_v4',
        },
      })
    ).toMatchObject({ provider: 'elevenlabs', model: 'eleven_v4', estimatedCostUsd: 0.1 });
  });
});

describe('speechUsageRows — the one audio row every pipeline writes (ADR 0034 slice 5)', () => {
  const audio = {
    speechProvider: 'gemini',
    speechModel: 'gemini-2.5-flash-preview-tts',
    promptTokens: 12,
    completionTokens: 3400,
    estimatedTokens: true,
  };

  it('writes the row under the product’s task, with the old slug as product', () => {
    expect(speechUsageRows('listenAndLearn', audio)).toEqual([
      {
        provider: 'gemini',
        model: 'gemini-2.5-flash-preview-tts',
        promptTokens: 12,
        completionTokens: 3400,
        estimatedTokens: true,
        source: 'ai:listenAndLearnSpeech',
        product: 'listen-and-learn:audio',
      },
    ]);
    expect(speechUsageRows('podcast', { ...audio, speechProvider: 'elevenlabs', speechModel: 'eleven_v3' })[0]).toMatchObject({
      provider: 'elevenlabs',
      source: 'ai:podcastVoice',
      product: 'podcast:audio',
    });
    expect(SPEECH_USAGE_PRODUCTS).toEqual({
      listenAndLearn: 'listen-and-learn:audio',
      podcast: 'podcast:audio',
    });
  });

  it('writes nothing when no provider spoke, and refuses an unknown product like every entry point', () => {
    expect(speechUsageRows('listenAndLearn', { speechProvider: null })).toEqual([]);
    expect(speechUsageRows('podcast', { error: 'not configured' })).toEqual([]);
    expect(speechUsageRows('podcast', null)).toEqual([]);
    expect(() => speechUsageRows('radio', audio)).toThrow(/unknown product "radio"/);
    expect(() => speechUsageRows(undefined, audio)).toThrow(/none was given/);
  });
});
