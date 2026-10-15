/**
 * ElevenLabs — the paid provider (ADR 0029 §2a, #436).
 *
 * The load-bearing assertions are about money and about the one failure a
 * paid provider has that a free one does not. A missing voice must fail before
 * a character is billed; a chunk must never exceed the documented ceiling; the
 * usage row must carry what the API says it charged, not what we think we
 * sent; and an account that is out of credit must be reported as exactly
 * that, once, with no retry that would spend nothing and hide the state.
 *
 * Since the free plan (2026-09-26) every render reads the account first
 * (elevenlabs-account.js). So every stub that reaches the network answers
 * that read through `withAccount`, and the assertions about what was posted
 * look at the dialogue stub alone. The pre-flight has its own section below.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { COST_TABLE, getCostEstimate } from '../../ai/router.js';
import { chunkTurns } from './azure.js';
import {
  ELEVENLABS_DEFAULT_MODEL,
  ELEVENLABS_DEFAULT_VOICES,
  ELEVENLABS_LIMITS,
  ELEVENLABS_OUTPUT_FORMAT,
  MAX_CHARACTERS_PER_REQUEST,
  INVALID_VOICE,
  PAID_PLAN_REQUIRED,
  VOICES_NOT_CHOSEN,
  buildInputs,
  characterCount,
  chunkTurnsByCharacters,
  dialogueCharacters,
  isQuotaExceeded,
  synthesizeWithElevenLabs,
} from './elevenlabs.js';
import { SUBSCRIPTION_URL, clearSubscriptionCache } from './elevenlabs-account.js';

const KEYED_ENV = { ELEVENLABS_API_KEY: 'xi-key' };

/**
 * The owner's choice, as podcast callers pass it (#725). The code has no
 * default voice, so every render below is handed these unless a test is
 * about what happens without them.
 */
const VOICES = Object.freeze({ Maya: 'MayaVoice00000000001', Elena: 'ElenaVoice0000000002' });
const synthesize = (params) => synthesizeWithElevenLabs({ voices: VOICES, ...params });

/** A free-plan account with the whole month left, as the subscription read returns it. */
const FREE_ACCOUNT = {
  tier: 'free',
  status: 'free',
  character_count: 0,
  character_limit: 10000,
  next_character_count_reset_unix: 1792972800, // 2026-10-26T00:00:00Z
  can_extend_character_limit: false,
  max_credit_limit_extension: 0,
};

const accountResponse = (body) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  text: async () => JSON.stringify(body),
});

/**
 * Answer the pre-flight's subscription read with `account` and hand every
 * other call to `dialogue`, so a test's assertions see only what it posted.
 */
const withAccount = (dialogue, account = FREE_ACCOUNT) =>
  vi.fn(async (url, init) =>
    String(url).startsWith(SUBSCRIPTION_URL) ? accountResponse(account) : dialogue(url, init)
  );

beforeEach(() => {
  // Module-level cache: without this one test's account is the next test's.
  clearSubscriptionCache();
});
const isSpeechError = (err) => err?.name === 'SpeechError';

const turn = (speaker, text) => ({ speaker, text });
const DIALOGUE = [turn('Maya', 'Hello there'), turn('Elena', 'Hi back'), turn('Maya', 'And so')];

/** A response carrying MP3-ish bytes and, optionally, the billed-character header. */
const okResponse = (bytes = [0xff, 0xfb, 1, 2], { characterCost } = {}) => ({
  ok: true,
  status: 200,
  headers: {
    get: (name) =>
      name.toLowerCase() === 'character-cost' && characterCost !== undefined
        ? String(characterCost)
        : null,
  },
  arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  text: async () => '',
});

const errorResponse = (status, body = '') => ({
  ok: false,
  status,
  headers: { get: () => null },
  text: async () => body,
  arrayBuffer: async () => new ArrayBuffer(0),
});

const QUOTA_BODY = JSON.stringify({
  detail: {
    status: 'quota_exceeded',
    message: 'This request exceeds your quota of 10000. You have 0 credits remaining.',
  },
});

const noSleep = vi.fn(async () => {});

describe('voices', () => {
  it('has no default voice: the owner chooses both (#725)', () => {
    // Sarah and Aria were refused to a free account made after March 2026
    // (402 paid_plan_required), and the docs name no id such an account is
    // documented to be able to use. An empty default is the honest one.
    expect(ELEVENLABS_DEFAULT_VOICES).toEqual({});
    expect(Object.isFrozen(ELEVENLABS_DEFAULT_VOICES)).toBe(true);
    // The fixture is shaped like real ids, or buildInputs would refuse it.
    for (const id of Object.values(VOICES)) expect(id).toMatch(/^[A-Za-z0-9]{20}$/);
  });

  it('with no voices chosen, says to choose them first and sends nothing', async () => {
    const fetchImpl = vi.fn();
    let caught;
    try {
      await synthesizeWithElevenLabs({ dialogue: DIALOGUE, env: KEYED_ENV, fetchImpl, sleep: noSleep });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ name: 'SpeechError', provider: 'elevenlabs', code: VOICES_NOT_CHOSEN });
    expect(caught.message).toBe(
      'Choose the podcast voices first: no ElevenLabs voice is saved for Maya and Elena. ' +
        'Pick two under Podcast voices at https://hybridcloudworks.com/admin/platform-settings?tab=audio, then run it again. ' +
        'Nothing was sent, so no credits were spent.'
    );
    // Not even the account read: the pre-flight comes after the voices.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('names only the host still without a voice', async () => {
    await expect(
      synthesizeWithElevenLabs({
        dialogue: DIALOGUE,
        voices: { Maya: VOICES.Maya },
        env: KEYED_ENV,
        fetchImpl: vi.fn(),
      })
    ).rejects.toThrow(/^Choose the podcast voices first: no ElevenLabs voice is saved for Elena\./);
  });

  it('refuses a voice that is not an ElevenLabs id, a Gemini name say, before sending', async () => {
    const fetchImpl = vi.fn();
    await expect(
      synthesizeWithElevenLabs({
        dialogue: DIALOGUE,
        voices: { Maya: 'Kore', Elena: VOICES.Elena },
        env: KEYED_ENV,
        fetchImpl,
      })
    ).rejects.toMatchObject({ code: INVALID_VOICE, message: expect.stringMatching(/voice for Maya is not an ElevenLabs voice id/) });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('no longer reads the Listen & Learn voice settings, which belong to Gemini and Azure', async () => {
    const env = { ...KEYED_ENV, LISTEN_AND_LEARN_VOICE_MAYA: 'Kore', LISTEN_AND_LEARN_VOICE_ELENA: 'Aoede' };
    // Without a choice they do not stand in for one ...
    await expect(
      synthesizeWithElevenLabs({ dialogue: DIALOGUE, env, fetchImpl: vi.fn() })
    ).rejects.toMatchObject({ code: VOICES_NOT_CHOSEN });
    // ... and with one they do not override it.
    const dialogue = vi.fn(async () => okResponse());
    await synthesize({ dialogue: DIALOGUE, env, fetchImpl: withAccount(dialogue), sleep: noSleep });
    const body = JSON.parse(dialogue.mock.calls[0][1].body);
    expect(body.inputs.map((i) => i.voice_id)).toEqual([VOICES.Maya, VOICES.Elena, VOICES.Maya]);
  });

  it('builds one input per turn carrying that speaker’s voice id', () => {
    expect(buildInputs(DIALOGUE, VOICES)).toEqual([
      { text: 'Hello there', voice_id: VOICES.Maya },
      { text: 'Hi back', voice_id: VOICES.Elena },
      { text: 'And so', voice_id: VOICES.Maya },
    ]);
  });

  it('fails a turn whose speaker has no voice BEFORE any request is sent', async () => {
    const fetchImpl = vi.fn();
    await expect(
      synthesize({
        dialogue: [turn('Maya', 'Hi'), turn('Narrator', 'Welcome')],
        env: KEYED_ENV,
        fetchImpl,
        sleep: noSleep,
      })
    ).rejects.toThrow(/No voice configured for speaker "Narrator" \(known: Maya, Elena\)/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('checks every chunk before the first request, so a late turn cannot bill an early one', async () => {
    // A missing voice on the LAST turn of a multi-request dialogue.
    const long = 'word '.repeat(300).trim(); // 1,499 chars → forces a second chunk
    const fetchImpl = withAccount(vi.fn(async () => okResponse()));
    await expect(
      synthesize({
        dialogue: [turn('Maya', long), turn('Elena', long), turn('Guest', 'Bye')],
        env: KEYED_ENV,
        fetchImpl,
        sleep: noSleep,
      })
    ).rejects.toThrow(/No voice configured for speaker "Guest"/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('the request', () => {
  it('posts the dialogue endpoint with the key header, the v3 model and the 64 kbps MP3 format', async () => {
    const dialogue = vi.fn(async () => okResponse());
    await synthesize({
      dialogue: DIALOGUE,
      env: KEYED_ENV,
      fetchImpl: withAccount(dialogue),
      sleep: noSleep,
    });

    const [url, init] = dialogue.mock.calls[0];
    expect(url).toBe(
      `https://api.elevenlabs.io/v1/text-to-dialogue?output_format=${ELEVENLABS_OUTPUT_FORMAT}`
    );
    expect(ELEVENLABS_OUTPUT_FORMAT).toBe('mp3_44100_64');
    expect(init.method).toBe('POST');
    expect(init.headers['xi-api-key']).toBe('xi-key');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({
      model_id: ELEVENLABS_DEFAULT_MODEL,
      inputs: buildInputs(DIALOGUE, VOICES),
    });
    expect(ELEVENLABS_DEFAULT_MODEL).toBe('eleven_v3');
  });

  it('honours its own model override and ignores the shared Gemini one', async () => {
    // A Gemini model id in LISTEN_AND_LEARN_TTS_MODEL must not become this
    // request's model_id the day the ElevenLabs key is seeded.
    const dialogue = vi.fn(async () => okResponse());
    const fetchImpl = withAccount(dialogue);
    await synthesize({
      dialogue: DIALOGUE,
      env: {
        ...KEYED_ENV,
        LISTEN_AND_LEARN_TTS_MODEL: 'gemini-3.1-flash-tts-preview',
        LISTEN_AND_LEARN_ELEVENLABS_MODEL: 'eleven_v4',
      },
      fetchImpl,
      sleep: noSleep,
    });
    expect(JSON.parse(dialogue.mock.calls[0][1].body).model_id).toBe('eleven_v4');

    dialogue.mockClear();
    await synthesize({
      dialogue: DIALOGUE,
      env: { ...KEYED_ENV, LISTEN_AND_LEARN_TTS_MODEL: 'gemini-3.1-flash-tts-preview' },
      fetchImpl,
      sleep: noSleep,
    });
    expect(JSON.parse(dialogue.mock.calls[0][1].body).model_id).toBe('eleven_v3');
  });

  it('refuses to run without a key, or with an unresolved Key Vault reference as one', async () => {
    await expect(
      synthesize({ dialogue: DIALOGUE, env: {}, fetchImpl: vi.fn() })
    ).rejects.toThrow(/ELEVENLABS_API_KEY is not configured/);
    await expect(
      synthesize({
        dialogue: DIALOGUE,
        env: { ELEVENLABS_API_KEY: '@Microsoft.KeyVault(SecretUri=https://v/s/1)' },
        fetchImpl: vi.fn(),
      })
    ).rejects.toThrow(/ELEVENLABS_API_KEY is not configured/);
  });

  it('refuses an empty dialogue', async () => {
    await expect(
      synthesize({ dialogue: [turn('Maya', '  ')], env: KEYED_ENV, fetchImpl: vi.fn() })
    ).rejects.toThrow(/No dialogue turns/);
  });
});

describe('chunking at the documented ceiling', () => {
  it('keeps every request at or under 2,000 characters and concatenates the parts in order', async () => {
    expect(MAX_CHARACTERS_PER_REQUEST).toBe(2000);
    // 9,000 bytes — MAX_SCRIPT_BYTES in script.js — as twelve 750-character turns.
    const dialogue = Array.from({ length: 12 }, (_, i) =>
      turn(i % 2 ? 'Elena' : 'Maya', `${String.fromCharCode(65 + i)}`.repeat(750))
    );
    let call = 0;
    const posted = vi.fn(async () => okResponse([call++, 0xff]));

    const result = await synthesize({
      dialogue,
      env: KEYED_ENV,
      fetchImpl: withAccount(posted),
      sleep: noSleep,
    });

    // 750 × 2 = 1,500 fits; 750 × 3 = 2,250 does not — so two turns per request.
    expect(result.requests).toBe(6);
    for (const [, init] of posted.mock.calls) {
      const total = JSON.parse(init.body).inputs.reduce((n, i) => n + i.text.length, 0);
      expect(total).toBeLessThanOrEqual(MAX_CHARACTERS_PER_REQUEST);
    }
    // Parts arrive back in request order: [0,ff,1,ff,2,ff,…].
    expect([...result.audio]).toEqual([0, 0xff, 1, 0xff, 2, 0xff, 3, 0xff, 4, 0xff, 5, 0xff]);
    expect(result.bytes).toBe(12);
  });

  it('never splits a speaker change across a request when whole turns fit', async () => {
    const posted = vi.fn(async () => okResponse());
    await synthesize({
      dialogue: [turn('Maya', 'a'.repeat(1200)), turn('Elena', 'b'.repeat(1200))],
      env: KEYED_ENV,
      fetchImpl: withAccount(posted),
      sleep: noSleep,
    });
    expect(posted).toHaveBeenCalledTimes(2);
    const first = JSON.parse(posted.mock.calls[0][1].body).inputs;
    expect(first).toHaveLength(1);
    expect(first[0].voice_id).toBe(VOICES.Maya);
  });

  it('splits one over-long turn rather than sending it whole and having it refused', async () => {
    const posted = vi.fn(async () => okResponse());
    await synthesize({
      dialogue: [turn('Maya', 'A sentence. '.repeat(250).trim())], // 2,999 chars
      env: KEYED_ENV,
      fetchImpl: withAccount(posted),
      sleep: noSleep,
    });
    expect(posted.mock.calls.length).toBeGreaterThan(1);
    for (const [, init] of posted.mock.calls) {
      const inputs = JSON.parse(init.body).inputs;
      for (const input of inputs) {
        expect(input.text.length).toBeLessThanOrEqual(MAX_CHARACTERS_PER_REQUEST);
        expect(input.voice_id).toBe(VOICES.Maya);
      }
    }
  });

  it('chunks by code points, so a CJK script is not sent in three times the requests', () => {
    // The Azure chunker measures UTF-8 bytes; borrowing it capped every
    // request at 2,000 BYTES, which for three-byte characters is 666
    // characters and three times the requests (Copilot review on #447).
    const turns = Array.from({ length: 6 }, (_, i) =>
      turn(i % 2 ? 'Elena' : 'Maya', '語'.repeat(1000))
    ); // 6,000 code points, 18,000 bytes
    const byCharacters = chunkTurnsByCharacters(turns, MAX_CHARACTERS_PER_REQUEST);
    const byBytes = chunkTurns(turns, MAX_CHARACTERS_PER_REQUEST);

    expect(byCharacters).toHaveLength(3); // two 1,000-character turns per request
    expect(byBytes.length).toBeGreaterThan(byCharacters.length);
    for (const chunk of byCharacters) {
      const total = chunk.reduce((n, t) => n + characterCount(t.text), 0);
      expect(total).toBeLessThanOrEqual(MAX_CHARACTERS_PER_REQUEST);
    }
    // Every character survives the split, in order.
    expect(byCharacters.flat().map((t) => t.text).join('')).toBe('語'.repeat(6000));
  });

  it('splits one over-long CJK turn on its own sentence marks, under the ceiling', () => {
    // 2,500 code points with ideographic full stops: split on 。 rather than
    // mid-sentence, and no part over the ceiling.
    const text = ('日本語の文章です。'.repeat(280)).trim(); // 9 chars × 280 = 2,520
    const chunks = chunkTurnsByCharacters([turn('Maya', text)]);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk).toHaveLength(1);
      expect(chunk[0].speaker).toBe('Maya');
      expect(characterCount(chunk[0].text)).toBeLessThanOrEqual(MAX_CHARACTERS_PER_REQUEST);
      expect(chunk[0].text.endsWith('。')).toBe(true);
    }
    expect(chunks.flat().map((t) => t.text).join('')).toBe(text);
  });

  it('counts characters as code points, so a multi-byte script is not over-counted', () => {
    expect(characterCount('héllo')).toBe(5);
    expect(characterCount('日本語')).toBe(3);
    expect(dialogueCharacters([turn('Maya', 'ab'), turn('Elena', 'cde')])).toBe(5);
  });
});

describe('usage and cost', () => {
  it('reports the billed character count from the character-cost header as the output unit', async () => {
    const fetchImpl = withAccount(vi.fn(async () => okResponse([1, 2, 3, 4], { characterCost: 27 })));
    const result = await synthesize({
      dialogue: DIALOGUE,
      env: KEYED_ENV,
      fetchImpl,
      sleep: noSleep,
    });
    expect(result).toMatchObject({
      model: 'eleven_v3',
      promptTokens: 0,
      completionTokens: 27,
      estimatedTokens: false,
      contentType: 'audio/mpeg',
    });
  });

  it('sums the header across chunks', async () => {
    const fetchImpl = withAccount(vi.fn(async () => okResponse([1], { characterCost: 1200 })));
    const result = await synthesize({
      dialogue: [turn('Maya', 'a'.repeat(1200)), turn('Elena', 'b'.repeat(1200))],
      env: KEYED_ENV,
      fetchImpl,
      sleep: noSleep,
    });
    expect(result.requests).toBe(2);
    expect(result.completionTokens).toBe(2400);
    expect(result.estimatedTokens).toBe(false);
  });

  it('keeps every billed count that did arrive when only some chunks carry the header', async () => {
    // Two chunks of 1,200 characters; the header comes back on the first
    // only. The billed 1,150 is kept, the second chunk is counted as posted,
    // and the row is flagged estimated because one chunk had to be (Copilot
    // on #447). Discarding the header would have thrown away a real figure.
    let call = 0;
    const fetchImpl = withAccount(
      vi.fn(async () => (call++ === 0 ? okResponse([1], { characterCost: 1150 }) : okResponse([2])))
    );
    const result = await synthesize({
      dialogue: [turn('Maya', 'a'.repeat(1200)), turn('Elena', 'b'.repeat(1200))],
      env: KEYED_ENV,
      fetchImpl,
      sleep: noSleep,
    });
    expect(result.requests).toBe(2);
    expect(result.completionTokens).toBe(1150 + 1200);
    expect(result.estimatedTokens).toBe(true);
  });

  it('falls back to its own count, flagged as estimated, when the header is absent', async () => {
    const fetchImpl = withAccount(vi.fn(async () => okResponse()));
    const result = await synthesize({
      dialogue: DIALOGUE,
      env: KEYED_ENV,
      fetchImpl,
      sleep: noSleep,
    });
    // 'Hello there' + 'Hi back' + 'And so' = 11 + 7 + 6
    expect(result.completionTokens).toBe(24);
    expect(result.estimatedTokens).toBe(true);
  });

  it('counts what was actually posted in the fallback, not the untrimmed dialogue', async () => {
    // The chunker trims each turn before sending; a billing row that counted
    // the dialogue as handed in would over-count by the whitespace (Copilot
    // on #447). 'Hello there' (11) + 'Hi back' (7) = 18, not 18 + padding.
    const padded = [turn('Maya', '   Hello there \n'), turn('Elena', '\tHi back   ')];

    const noHeader = vi.fn(async () => okResponse());
    const viaCount = await synthesize({
      dialogue: padded,
      env: KEYED_ENV,
      fetchImpl: withAccount(noHeader),
      sleep: noSleep,
    });
    const posted = noHeader.mock.calls.flatMap(([, init]) => JSON.parse(init.body).inputs);
    expect(posted.map((i) => i.text)).toEqual(['Hello there', 'Hi back']);
    expect(viaCount.completionTokens).toBe(18);
    expect(viaCount.estimatedTokens).toBe(true);

    // The header still wins whenever it is present.
    const withHeader = vi.fn(async () => okResponse([1], { characterCost: 21 }));
    const viaHeader = await synthesize({
      dialogue: padded,
      env: KEYED_ENV,
      fetchImpl: withAccount(withHeader),
      sleep: noSleep,
    });
    expect(viaHeader.completionTokens).toBe(21);
    expect(viaHeader.estimatedTokens).toBe(false);
  });

  it('is priced by the cost table at USD 0.10 per 1,000 characters', () => {
    // The row the usage writer prices with; a 9,000-character episode is 90 cents.
    expect(COST_TABLE.elevenlabs[ELEVENLABS_DEFAULT_MODEL]).toEqual([0, 100.0]);
    expect(getCostEstimate('elevenlabs', ELEVENLABS_DEFAULT_MODEL, 0, 9000)).toBeCloseTo(0.9, 6);
    expect(getCostEstimate('elevenlabs', ELEVENLABS_DEFAULT_MODEL, 0, 1000)).toBeCloseTo(0.1, 6);
  });

  it('derives the duration from the byte count, because the stream is constant-bitrate', async () => {
    // 64 kbps → 8,000 bytes per second.
    const fetchImpl = withAccount(vi.fn(async () => okResponse(new Array(80_000).fill(0))));
    const result = await synthesize({
      dialogue: DIALOGUE,
      env: KEYED_ENV,
      fetchImpl,
      sleep: noSleep,
    });
    expect(result.estimatedSeconds).toBe(10);
  });
});

describe('out of credit', () => {
  it('recognises the documented 401 quota_exceeded body, and a 402', () => {
    expect(isQuotaExceeded(401, QUOTA_BODY)).toBe(true);
    expect(isQuotaExceeded(402, '')).toBe(true);
    expect(isQuotaExceeded(401, JSON.stringify({ detail: { status: 'invalid_api_key' } }))).toBe(
      false
    );
    expect(isQuotaExceeded(401, 'not json')).toBe(false);
    expect(isQuotaExceeded(500, QUOTA_BODY)).toBe(false);
  });

  it('reads the current `code` field as well as the legacy `status`', () => {
    // "status … is a legacy field that is no longer used, instead use the
    // code property" (ElevenLabs, Errors).
    expect(isQuotaExceeded(401, JSON.stringify({ detail: { code: 'quota_exceeded' } }))).toBe(true);
    expect(
      isQuotaExceeded(402, JSON.stringify({ detail: { type: 'payment_required', code: 'insufficient_credits' } }))
    ).toBe(true);
  });

  it('does not read a 402 paid_plan_required as an empty account', () => {
    // What a free-plan key gets for a Voice Library voice. The account has
    // credits; telling the owner to top up would be wrong.
    const body = JSON.stringify({
      detail: {
        type: 'payment_required',
        code: 'paid_plan_required',
        message: 'Free users cannot use library voices via the API.',
        status: 'payment_required',
      },
    });
    expect(isQuotaExceeded(402, body)).toBe(false);
  });

  it('surfaces it once, with the status and a code, and does not retry', async () => {
    const posted = vi.fn(async () => errorResponse(401, QUOTA_BODY));
    const sleep = vi.fn(async () => {});
    let caught;
    try {
      await synthesize({
        dialogue: DIALOGUE,
        env: KEYED_ENV,
        fetchImpl: withAccount(posted),
        sleep,
      });
    } catch (err) {
      caught = err;
    }
    expect(isSpeechError(caught)).toBe(true);
    expect(caught).toMatchObject({ provider: 'elevenlabs', status: 401, code: 'quota_exceeded' });
    expect(caught.message).toMatch(/out of credit/);
    expect(caught.details).toBeUndefined(); // the API's refusal, not the pre-flight's
    expect(posted).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not mistake a rejected key for an empty account', async () => {
    const posted = vi.fn(async () =>
      errorResponse(401, JSON.stringify({ detail: { status: 'invalid_api_key' } }))
    );
    let caught;
    try {
      await synthesize({
        dialogue: DIALOGUE,
        env: KEYED_ENV,
        fetchImpl: withAccount(posted),
        sleep: noSleep,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ status: 401, code: null });
    expect(caught.message).toBe('ElevenLabs answered HTTP 401 invalid_api_key.');
    expect(posted).toHaveBeenCalledTimes(1);
  });

  it('reports a paid-only voice as the plan, once, not as out of credit', async () => {
    const posted = vi.fn(async () =>
      errorResponse(
        402,
        JSON.stringify({
          detail: {
            code: 'paid_plan_required',
            message: 'Free users cannot use library voices via the API.',
          },
        })
      )
    );
    let caught;
    try {
      await synthesize({
        dialogue: DIALOGUE,
        env: KEYED_ENV,
        fetchImpl: withAccount(posted),
        sleep: noSleep,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ provider: 'elevenlabs', status: 402, code: PAID_PLAN_REQUIRED });
    expect(caught.message).toMatch(/refused this on the current plan/);
    // The fix, pointing at the picker. ElevenLabs's own words no longer
    // follow it (#945): the sentence is this module's, shown whole.
    expect(caught.message).toMatch(
      /Choose voices your plan allows under Podcast voices at https:\/\/hybridcloudworks\.com\/admin\/platform-settings\?tab=audio\.$/
    );
    expect(caught.message).not.toMatch(/Free users cannot use library voices/);
    expect(caught.message).not.toMatch(/out of credit/);
    expect(posted).toHaveBeenCalledTimes(1);
  });
});

describe('the credit pre-flight', () => {
  const account = (over = {}) => ({ ...FREE_ACCOUNT, ...over });

  it('reads the subscription with the key before the first dialogue request', async () => {
    const posted = vi.fn(async () => okResponse());
    const fetchImpl = withAccount(posted);
    await synthesize({ dialogue: DIALOGUE, env: KEYED_ENV, fetchImpl, sleep: noSleep });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.elevenlabs.io/v1/user/subscription');
    expect(init.method).toBe('GET');
    expect(init.headers['xi-api-key']).toBe('xi-key');
    expect(String(fetchImpl.mock.calls[1][0])).toMatch(/text-to-dialogue/);
  });

  it('refuses a job the credits left cannot pay for in full, sending nothing', async () => {
    // 1,000 credits left and a 2,400-character job: the render would run dry
    // part-way. The sentence names all three figures and the reset date.
    const posted = vi.fn(async () => okResponse());
    let caught;
    try {
      await synthesize({
        dialogue: [turn('Maya', 'a'.repeat(1200)), turn('Elena', 'b'.repeat(1200))],
        env: KEYED_ENV,
        fetchImpl: withAccount(posted, account({ character_count: 9000 })),
        sleep: noSleep,
      });
    } catch (err) {
      caught = err;
    }
    expect(posted).not.toHaveBeenCalled();
    expect(caught).toMatchObject({
      name: 'SpeechError',
      provider: 'elevenlabs',
      status: null,
      code: 'quota_exceeded',
    });
    expect(caught.details).toMatchObject({ preflight: true, needed: 2400, left: 1000, limit: 10000 });
    expect(caught.message).toBe(
      'ElevenLabs has 1,000 credits left of 10,000, this episode needs 2,400; ' +
        'the allowance resets on 2026-10-26 (UTC). Nothing was sent, so no credits were spent.'
    );
  });

  it('counts the characters actually posted, trimmed, at one credit each', async () => {
    // 'Hello there' + 'Hi back' + 'And so' = 24 characters. 23 left refuses,
    // 24 left renders: the boundary is exact, not padded.
    const tight = [turn('Maya', '  Hello there '), turn('Elena', 'Hi back'), turn('Maya', 'And so')];
    await expect(
      synthesize({
        dialogue: tight,
        env: KEYED_ENV,
        fetchImpl: withAccount(vi.fn(), account({ character_count: 10000 - 23 })),
        sleep: noSleep,
      })
    ).rejects.toMatchObject({ code: 'quota_exceeded' });

    clearSubscriptionCache();
    const posted = vi.fn(async () => okResponse());
    const result = await synthesize({
      dialogue: tight,
      env: KEYED_ENV,
      fetchImpl: withAccount(posted, account({ character_count: 10000 - 24 })),
      sleep: noSleep,
    });
    expect(posted).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ characters: 24, creditsNeeded: 24 });
  });

  it('counts usage-based billing as headroom only when the account has opted in', async () => {
    const job = [turn('Maya', 'a'.repeat(1200)), turn('Elena', 'b'.repeat(1200))];
    const nearlySpent = { tier: 'creator', status: 'active', character_count: 120_000, character_limit: 121_000 };

    // Entitled, and an admin set an extension of 5,000: 1,000 + 5,000 covers 2,400.
    const posted = vi.fn(async () => okResponse());
    await synthesize({
      dialogue: job,
      env: KEYED_ENV,
      fetchImpl: withAccount(
        posted,
        account({ ...nearlySpent, can_extend_character_limit: true, max_credit_limit_extension: 5000 })
      ),
      sleep: noSleep,
    });
    expect(posted).toHaveBeenCalledTimes(2);

    // Entitled but the extension is 0 ("usage-based billing is disabled").
    clearSubscriptionCache();
    await expect(
      synthesize({
        dialogue: job,
        env: KEYED_ENV,
        fetchImpl: withAccount(
          vi.fn(),
          account({ ...nearlySpent, can_extend_character_limit: true, max_credit_limit_extension: 0 })
        ),
        sleep: noSleep,
      })
    ).rejects.toMatchObject({ code: 'quota_exceeded' });
  });

  it('fails closed, sending nothing, when the key cannot read the subscription', async () => {
    const posted = vi.fn(async () => okResponse());
    const fetchImpl = vi.fn(async (url, init) =>
      String(url).startsWith(SUBSCRIPTION_URL)
        ? errorResponse(
            401,
            JSON.stringify({ detail: { status: 'missing_permissions', message: 'user_read' } })
          )
        : posted(url, init)
    );
    let caught;
    try {
      await synthesize({ dialogue: DIALOGUE, env: KEYED_ENV, fetchImpl, sleep: noSleep });
    } catch (err) {
      caught = err;
    }
    expect(posted).not.toHaveBeenCalled();
    expect(caught).toMatchObject({ provider: 'elevenlabs', status: 401, code: 'subscription_unavailable' });
    expect(caught.message).toMatch(/User → Read permission \(user_read\)/);
    expect(caught.message).toMatch(/nothing was sent, so no credits were spent/);
  });

  it('returns the plan the audio was rendered on, as the pre-flight read it', async () => {
    const result = await synthesize({
      dialogue: DIALOGUE,
      env: KEYED_ENV,
      fetchImpl: withAccount(vi.fn(async () => okResponse([1], { characterCost: 24 }))),
      sleep: noSleep,
    });
    expect(result.subscription).toMatchObject({
      tier: 'free',
      freePlan: true,
      creditsLeft: 10000,
      creditLimit: 10000,
      resetAt: '2026-10-26T00:00:00.000Z',
    });
  });

  it('reads the account again after a render, so the next pre-flight sees the spend', async () => {
    const fetchImpl = withAccount(vi.fn(async () => okResponse()));
    await synthesize({ dialogue: DIALOGUE, env: KEYED_ENV, fetchImpl, sleep: noSleep });
    await synthesize({ dialogue: DIALOGUE, env: KEYED_ENV, fetchImpl, sleep: noSleep });
    const reads = fetchImpl.mock.calls.filter(([url]) => String(url).startsWith(SUBSCRIPTION_URL));
    expect(reads).toHaveLength(2);
  });
});

describe('retries', () => {
  it('retries 429 and 5xx, then succeeds', async () => {
    const responses = [errorResponse(429, 'slow down'), errorResponse(503, ''), okResponse([9])];
    const posted = vi.fn(async () => responses.shift());
    const sleep = vi.fn(async () => {});
    const result = await synthesize({
      dialogue: DIALOGUE,
      env: KEYED_ENV,
      fetchImpl: withAccount(posted),
      sleep,
    });
    expect([...result.audio]).toEqual([9]);
    expect(posted).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('gives up after three attempts with the last status attached', async () => {
    const posted = vi.fn(async () => errorResponse(500, 'boom'));
    await expect(
      synthesize({
        dialogue: DIALOGUE,
        env: KEYED_ENV,
        fetchImpl: withAccount(posted),
        sleep: noSleep,
      })
    ).rejects.toMatchObject({ name: 'SpeechError', status: 500, provider: 'elevenlabs' });
    expect(posted).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 400', async () => {
    const posted = vi.fn(async () => errorResponse(400, 'bad inputs'));
    await expect(
      synthesize({
        dialogue: DIALOGUE,
        env: KEYED_ENV,
        fetchImpl: withAccount(posted),
        sleep: noSleep,
      })
    ).rejects.toThrow(/HTTP 400/);
    expect(posted).toHaveBeenCalledTimes(1);
  });

  it('retries a network failure and reports it if it persists', async () => {
    const posted = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    await expect(
      synthesize({
        dialogue: DIALOGUE,
        env: KEYED_ENV,
        fetchImpl: withAccount(posted),
        sleep: noSleep,
      })
    ).rejects.toThrow('Failed to reach ElevenLabs (Error).');
    expect(posted).toHaveBeenCalledTimes(3);
  });
});

describe('limits', () => {
  it('publishes the constants the switch and the docs quote', () => {
    expect(ELEVENLABS_LIMITS).toEqual({
      MAX_CHARACTERS_PER_REQUEST: 2000,
      OUTPUT_FORMAT: 'mp3_44100_64',
      CONTENT_TYPE: 'audio/mpeg',
    });
  });
});
