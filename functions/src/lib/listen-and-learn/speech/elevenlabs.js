/**
 * Render a two-host dialogue to MP3 with ElevenLabs.
 *
 * Added when the owner approved a paid ElevenLabs plan on 2026-09-08 (ADR 0029
 * §2a, #436). It is the PODCAST voice — article and Plaud transcripts that go
 * to Podbean — and only that (owner rule 2026-09-09, §2b): Listen & Learn is
 * read by Gemini TTS and never by this module, whatever keys are present.
 * The product switch in speech/index.js is what enforces that.
 *
 * **Started on the free plan (owner, 2026-09-26; §2a amended).** Before its
 * first dialogue request a render reads the account and refuses a job the
 * credits left cannot pay for in full, so a free month of 10,000 credits is
 * never half-spent on an episode that cannot finish. The result also carries
 * the plan the audio was rendered on, which is what the podcast's approval
 * step checks: free-plan audio has no commercial licence and is not published.
 * Both live in elevenlabs-account.js.
 *
 * Contract, verified against the Text to Dialogue API reference and capability
 * guide on 2026-09-08:
 *
 *   POST https://api.elevenlabs.io/v1/text-to-dialogue?output_format=mp3_44100_64
 *   xi-api-key: <key>
 *   { model_id: 'eleven_v3', inputs: [{ text, voice_id }, …] }
 *
 * Four properties of that contract shape this module:
 *
 *   - **The dialogue is structured, not prompted.** Every turn is an
 *     `inputs[]` entry carrying its own `voice_id`, so alternating hosts are
 *     alternating entries — no speaker labels to keep in step with a voice
 *     table, as the Gemini path must. A turn whose speaker has no voice is
 *     therefore a hard error BEFORE any request is sent: there is nothing to
 *     put in `voice_id`, and the API would reject it after the bytes had been
 *     uploaded.
 *   - **The response is MP3.** `output_format` is a query parameter with a
 *     documented enum; `mp3_44100_64` is 64 kbps constant-bitrate mono, the
 *     bitrate mp3.js encodes the Gemini PCM to, so the stored bytes-per-second
 *     are the same whichever provider ran and mp3.js is bypassed entirely.
 *     (Only the 192 kbps MP3 and the 44.1 kHz PCM/WAV formats are tier-gated.)
 *   - **A request is capped at 2,000 characters.** The capability guide says to
 *     "keep the total length of all `inputs[].text` values at or below 2,000
 *     characters per request for reliable generation" and to concatenate the
 *     resulting audio, so a 9,000-byte episode is four or five requests.
 *     `chunkTurnsByCharacters` below measures CODE POINTS, the unit the
 *     ceiling is stated in and the unit the API bills. The Azure chunker
 *     measures UTF-8 bytes; borrowing it was safe but wasteful — a CJK script
 *     is three bytes a character and would have gone out in three times as
 *     many requests as it needed.
 *   - **Billing is per character**, USD 0.10 per 1,000 on the plans in
 *     question, and the API reports what it charged in a `character-cost`
 *     response header. That figure is preferred over our own count for the
 *     usage row: what was billed beats what was sent. On a plan's allowance
 *     the same figure is credits: Eleven v3 costs one credit per character
 *     (https://elevenlabs.io/pricing), which is what the pre-flight counts.
 *
 * ## How cost is recorded
 *
 * `ai_usage` rows carry `promptTokens` / `completionTokens` and are priced by
 * `getCostEstimate(provider, model, in, out)` against `COST_TABLE`, and the
 * admin usage page totals those columns client-side. Inventing a "characters"
 * column would need a second code path in the page and in `totalCostUsd`, and
 * every historical row would lack it. So a character IS the output unit here:
 * `completionTokens` is the billed character count, `promptTokens` is 0, and
 * `COST_TABLE.elevenlabs[model]` is expressed as USD per 1M characters (0.10
 * per 1,000 = 100 per 1M). `getCostEstimate` then prices the row without
 * knowing the unit changed, which is the whole point. The row is flagged
 * `estimatedTokens` only when the header was absent and the count is ours.
 *
 * ## Out of credit
 *
 * Two layers. The pre-flight above refuses a job the account cannot pay for,
 * before anything is sent. Behind it, a request that still meets an empty
 * account (a second render racing this one, or a key whose own credit limit
 * is tighter than the account's) is refused by the API: **401** with
 * `detail.status === 'quota_exceeded'` (ElevenLabs help centre, "API - Error
 * Code 400 or 401"), or **402** `insufficient_credits`
 * (https://elevenlabs.io/docs/eleven-api/resources/errors). Neither improves
 * on a retry, so neither is retried, and both carry `code: 'quota_exceeded'`
 * and the HTTP status. The pre-flight refusal carries the same code, with
 * `details.preflight` set. Nothing falls back to another provider on it: the
 * podcast has one provider (§2b), and generate.js records the sentence as
 * the draft's `audioError`.
 *
 * A 402 is not always about credit. ElevenLabs also answers 402
 * `paid_plan_required` when a free-plan key asks for a Voice Library voice
 * ("Free users cannot use library voices via the API",
 * https://elevenlabs.io/docs/overview/capabilities/voices). Reporting that as
 * "out of credit" would send the owner to top up an account that has
 * credits, so it is reported as its own code.
 *
 * ## Voices
 *
 * Two, one per host script.js writes (DEFAULT_SPEAKERS, Maya and Elena), and
 * **the owner chooses them** (#725). Precedence, highest first:
 *
 *   1. `voices`, which every podcast caller passes: the choice stored in
 *      `admin_config/podcast_voices` from the Audio tab's Podcast voices
 *      picker (podcast/voice-settings.js), read by podcast/generate.js for an
 *      episode and podcast/elevenlabs-admin.js for the live check;
 *   2. `ELEVENLABS_DEFAULT_VOICES`, which is **empty**.
 *
 * Empty on purpose. The first live check on the free plan, 2026-09-26, was
 * refused with 402 `paid_plan_required`: "Free users cannot use library
 * voices via the API". The defaults were Sarah (`EXAVITQu4vr4xnSDxMaL`), a
 * Default voice "only available for accounts that were created before March
 * 2026" and expiring 2026-12-31
 * (https://elevenlabs.io/docs/help-center/product/voices/my-voices/what-are-default-voices),
 * and Aria (`9BWtsMINqrJLrRacOk9x`), a Legacy voice the API routes to "Zoe"
 * (https://elevenlabs.io/docs/help-center/product/voices/my-voices/what-are-legacy-voices).
 * This account is newer, so to it both are library voices. The replacement
 * table on the Default voices page names new voices (Talia for Sarah, and so
 * on). It prints no ids, and its links open a Voice Library search, and
 * Voice Library voices "are not available via the API to free tier users"
 * (https://elevenlabs.io/docs/overview/capabilities/voices). Read on
 * 2026-09-26, the docs therefore name no id a free account made after March
 * 2026 is documented to be able to use. So there is no default to guess:
 * with nothing chosen a render stops before it sends anything, with
 * `code: 'voices_not_chosen'` and a sentence that says where to choose.
 *
 * `LISTEN_AND_LEARN_VOICE_MAYA` / `…_ELENA` are NOT read here any more. They
 * are Gemini's and Azure's, for Listen & Learn, and a Gemini voice name in
 * them was one step from being posted here as a `voice_id` (§2b, #725).
 */
import {
  ElevenLabsSpeechError,
  PAID_PLAN_REQUIRED,
  VOICE_PICKER_PAGE,
  assertCreditsCover,
  creditsNeeded as creditsNeededFor,
  dialogueRefusal,
  invalidateSubscription,
  isQuotaExceeded,
} from './elevenlabs-account.js';
import { isElevenLabsVoiceId } from './elevenlabs-voice-plan.js';
import { DEFAULT_SPEAKERS } from '../script.js';

const DIALOGUE_URL = 'https://api.elevenlabs.io/v1/text-to-dialogue';

/**
 * The only model the dialogue endpoint serves. Overridable with
 * `LISTEN_AND_LEARN_ELEVENLABS_MODEL` for the day that changes — its own
 * setting rather than the shared `LISTEN_AND_LEARN_TTS_MODEL`, because a
 * Gemini model id left in that one would be sent here as `model_id` the
 * moment this key was seeded and fail every run with a 400.
 */
export const ELEVENLABS_DEFAULT_MODEL = 'eleven_v3';
export const ELEVENLABS_MODEL_SETTING = 'LISTEN_AND_LEARN_ELEVENLABS_MODEL';

/**
 * 64 kbps CBR mono MP3 — the bitrate mp3.js already stores, so the media
 * route serves the same bytes-per-second whichever provider read the episode.
 */
export const ELEVENLABS_OUTPUT_FORMAT = 'mp3_44100_64';
const OUTPUT_BITS_PER_SECOND = 64_000;
const CONTENT_TYPE = 'audio/mpeg';

/** Documented ceiling on the summed `inputs[].text` length per request. */
export const MAX_CHARACTERS_PER_REQUEST = 2000;

/** None: the owner chooses (see "Voices" in the header). */
export const ELEVENLABS_DEFAULT_VOICES = Object.freeze({});

/** The hosts a podcast script is written for; a turn by either needs a chosen voice. */
const PODCAST_HOSTS = new Set(Object.values(DEFAULT_SPEAKERS));

/** `code` for a render with no voice chosen for a host. Nothing is sent. */
export const VOICES_NOT_CHOSEN = 'voices_not_chosen';

/** `code` for a voice that is not an ElevenLabs voice id. Nothing is sent. */
export const INVALID_VOICE = 'invalid_voice';

/** Attempts per request. Which statuses are retried is `dialogueRefusal`'s call. */
const MAX_ATTEMPTS = 3;

// The error class and the reading of a refusal live in elevenlabs-account.js,
// not `./index.js`, which imports this module: a cycle would make one of the
// two undefined at load. Re-exported here, where their callers and tests
// have always imported them from.
export { PAID_PLAN_REQUIRED, isQuotaExceeded };

function readSetting(env, name) {
  const value = String(env?.[name] || '').trim();
  if (!value || value.startsWith('@Microsoft.KeyVault(')) return '';
  return value;
}

/** "Choose the podcast voices first: …", naming the hosts with no voice. */
export function voicesNotChosenMessage(hosts) {
  return (
    `Choose the podcast voices first: no ElevenLabs voice is saved for ${hosts.join(' and ')}. ` +
    `Pick two under Podcast voices at ${VOICE_PICKER_PAGE}, then run it again. ` +
    'Nothing was sent, so no credits were spent.'
  );
}

/** Characters as the API counts them: code points, not UTF-16 units. */
export const characterCount = (text) => [...String(text ?? '')].length;

/** Sum of every turn's text, for the cost estimate and the usage row. */
export function dialogueCharacters(turns) {
  return (turns || []).reduce((total, turn) => total + characterCount(turn?.text), 0);
}

/**
 * Split one over-long turn on sentence boundaries, measured in code points.
 *
 * Both halves are spoken by the same voice, so the listener hears continuous
 * speech. Falls back to a per-character split only when a single "sentence"
 * is itself over the limit, which means punctuation-free text.
 */
function splitTurnText(text, limit) {
  const sentences = String(text).match(/[^.!?。！？]+[.!?。！？]*\s*/g) || [String(text)];
  const parts = [];
  let buffer = '';

  for (const sentence of sentences) {
    if (buffer && characterCount(buffer) + characterCount(sentence) > limit) {
      parts.push(buffer.trim());
      buffer = '';
    }
    if (characterCount(sentence) > limit) {
      if (buffer.trim()) parts.push(buffer.trim());
      buffer = '';
      let chunk = '';
      for (const char of sentence) {
        if (characterCount(chunk) + 1 > limit) {
          parts.push(chunk.trim());
          chunk = '';
        }
        chunk += char;
      }
      buffer = chunk;
      continue;
    }
    buffer += sentence;
  }

  if (buffer.trim()) parts.push(buffer.trim());
  return parts.filter(Boolean);
}

/**
 * Group turns into requests of at most `limit` CODE POINTS of text.
 *
 * The same policy as azure.js's `chunkTurns` — whole turns wherever possible
 * so a speaker change never falls across a request boundary mid-thought, an
 * over-long turn split rather than sent whole and refused — in the unit this
 * API states its ceiling and its bill in. `text.length` would count UTF-16
 * units and over-count astral characters; bytes would over-count everything
 * outside ASCII.
 *
 * @param {{speaker: string, text: string}[]} turns
 * @param {number} [limit]
 * @returns {{speaker: string, text: string}[][]}
 */
export function chunkTurnsByCharacters(turns, limit = MAX_CHARACTERS_PER_REQUEST) {
  const chunks = [];
  let current = [];
  let currentCount = 0;

  const flush = () => {
    if (current.length) chunks.push(current);
    current = [];
    currentCount = 0;
  };

  for (const turn of turns) {
    const text = String(turn?.text || '').trim();
    if (!text) continue;
    const speaker = turn.speaker;
    const count = characterCount(text);

    if (count > limit) {
      flush();
      for (const part of splitTurnText(text, limit)) {
        chunks.push([{ speaker, text: part }]);
      }
      continue;
    }

    if (currentCount + count > limit) flush();
    current.push({ speaker, text });
    currentCount += count;
  }

  flush();
  return chunks;
}

/**
 * The `inputs` array for one request.
 *
 * Checked for every turn up front rather than lazily: the point of a hard
 * error here is that it happens before a byte is uploaded or a character is
 * billed. Three refusals, each with its own sentence: a host with no voice
 * chosen (`voices_not_chosen`, which says where to choose), a voice that is
 * not an ElevenLabs id (`invalid_voice`, a Gemini or Azure name in the wrong
 * place), and a speaker the script should never have written.
 */
export function buildInputs(turns, voices) {
  const unchosen = [
    ...new Set(turns.filter((t) => !voices[t.speaker] && PODCAST_HOSTS.has(t.speaker)).map((t) => t.speaker)),
  ];
  if (unchosen.length > 0) {
    throw new ElevenLabsSpeechError(voicesNotChosenMessage(unchosen), { code: VOICES_NOT_CHOSEN });
  }
  return turns.map((turn) => {
    const voiceId = voices[turn.speaker];
    if (!voiceId) {
      throw new ElevenLabsSpeechError(
        `No voice configured for speaker "${turn.speaker}" (known: ${Object.keys(voices).join(', ') || 'none'})`
      );
    }
    if (!isElevenLabsVoiceId(voiceId)) {
      throw new ElevenLabsSpeechError(
        `The voice for ${turn.speaker} is not an ElevenLabs voice id (20 letters and digits). ` +
          `Choose the podcast voices at ${VOICE_PICKER_PAGE}. Nothing was sent, so no credits were spent.`,
        { code: INVALID_VOICE }
      );
    }
    return { text: turn.text, voice_id: voiceId };
  });
}

async function synthesizeOne(inputs, { key, model, fetchImpl, sleep }) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(`${DIALOGUE_URL}?output_format=${ELEVENLABS_OUTPUT_FORMAT}`, {
        method: 'POST',
        headers: {
          'xi-api-key': key,
          'Content-Type': 'application/json',
          Accept: CONTENT_TYPE,
        },
        body: JSON.stringify({ model_id: model, inputs }),
      });
    } catch (err) {
      lastError = new ElevenLabsSpeechError(`Failed to reach ElevenLabs: ${err.message}`);
      if (attempt === MAX_ATTEMPTS) throw lastError;
      await sleep(attempt * 500);
      continue;
    }

    if (response.ok) {
      const audio = Buffer.from(await response.arrayBuffer());
      // `Number(null)` is 0, which would read as "billed nothing"; only a
      // header that is actually present and numeric counts as the API's word.
      const header = response.headers?.get?.('character-cost');
      const billed = header === null || header === undefined || header === '' ? NaN : Number(header);
      return { audio, billedCharacters: Number.isFinite(billed) ? billed : null };
    }

    // Out of credit and a paid-only voice are named and never retried; 429
    // and 5xx are retried; anything else is reported as the API said it.
    const refusal = dialogueRefusal(response.status, await response.text().catch(() => ''));
    lastError = refusal.error;
    if (!refusal.retryable || attempt === MAX_ATTEMPTS) throw lastError;
    await sleep(attempt * 500);
  }

  throw lastError;
}

/**
 * Synthesise a whole dialogue, returning one MP3.
 *
 * MP3 parts are concatenated bytewise, as azure.js does and for the same
 * reason: a constant-bitrate MPEG audio stream is a sequence of
 * self-describing frames with no container header to reconcile.
 *
 * @param {object} params
 * @param {{speaker: string, text: string}[]} params.dialogue
 * @param {Record<string,string>|null} [params.voices] speaker name → voice id
 * @param {object} [params.env]
 * @param {Function} [params.fetchImpl]
 * @returns {Promise<{audio: Buffer, contentType: string, bytes: number, requests: number, model: string, estimatedSeconds: number, promptTokens: number, completionTokens: number, estimatedTokens: boolean, characters: number, creditsNeeded: number, subscription: ReturnType<typeof import('./elevenlabs-account.js').normalizeSubscription>}>}
 *   `subscription` is the account as the pre-flight read it, before this
 *   render spent anything. Its `tier` and `freePlan` are what the podcast
 *   records on the transcript. `characters` is the code points posted.
 */
export async function synthesizeWithElevenLabs({
  dialogue,
  voices = null,
  env = process.env,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const turns = (dialogue || []).filter((t) => String(t?.text || '').trim());
  if (turns.length === 0) throw new ElevenLabsSpeechError('No dialogue turns to synthesise');

  const key = readSetting(env, 'ELEVENLABS_API_KEY');
  if (!key) throw new ElevenLabsSpeechError('ELEVENLABS_API_KEY is not configured');

  // Precedence, lowest to highest: the built-in default (none), then the
  // caller's `voices`, which for the podcast is the owner's stored choice.
  // No environment override: see "Voices" in the header.
  const resolvedVoices = {
    ...ELEVENLABS_DEFAULT_VOICES,
    ...(voices || {}),
  };

  const model = readSetting(env, ELEVENLABS_MODEL_SETTING) || ELEVENLABS_DEFAULT_MODEL;

  // Every chunk's inputs are built before the first request, so a missing
  // voice on the last turn fails the run before the first turn is billed.
  const chunks = chunkTurnsByCharacters(turns, MAX_CHARACTERS_PER_REQUEST).map((chunk) =>
    buildInputs(chunk, resolvedVoices)
  );
  const postedCharacters = (inputs) =>
    inputs.reduce((total, input) => total + characterCount(input.text), 0);
  const characters = chunks.reduce((total, inputs) => total + postedCharacters(inputs), 0);

  // The pre-flight: read the account and refuse, before the first request,
  // a job it cannot pay for in full. After the voice check, so a missing
  // voice still fails with no network call at all; before any dialogue
  // request, so a refusal spends nothing. A failed read refuses too — see
  // "Why a failed read fails CLOSED" in elevenlabs-account.js.
  const subscription = await assertCreditsCover({ key, characters, fetchImpl, sleep });

  const parts = [];
  // Per chunk: the API's own count when the `character-cost` header came
  // back, else the code points this chunk actually posted. Summed that way,
  // a header present on some chunks and absent on others still counts every
  // billed figure that did arrive, and the row is flagged estimated if any
  // chunk had to be counted by us.
  let completionTokens = 0;
  let anyEstimated = false;
  try {
    for (const inputs of chunks) {
      // Sequential on purpose: the parts are concatenated in order, and a
      // parallel burst is the reliable way to meet the per-account 429.
      const { audio, billedCharacters } = await synthesizeOne(inputs, {
        key,
        model,
        fetchImpl,
        sleep,
      });
      parts.push(audio);
      if (billedCharacters === null) {
        // Counted over the inputs actually posted — after the chunker trimmed
        // and split them — not over the dialogue as handed in. This is a
        // billing row: what was sent is what counts, and a turn's surrounding
        // whitespace was not sent.
        completionTokens += postedCharacters(inputs);
        anyEstimated = true;
      } else {
        completionTokens += billedCharacters;
      }
    }
  } finally {
    // Spent or failed part-way, the cached account no longer says what is
    // left; the next pre-flight must read it again.
    invalidateSubscription(key);
  }

  const audio = Buffer.concat(parts);

  return {
    audio,
    contentType: CONTENT_TYPE,
    bytes: audio.length,
    requests: chunks.length,
    model,
    // CBR, so the byte count is the duration; no estimate needed.
    estimatedSeconds: Math.round((audio.length * 8) / OUTPUT_BITS_PER_SECOND),
    promptTokens: 0,
    completionTokens,
    estimatedTokens: anyEstimated,
    characters,
    creditsNeeded: creditsNeededFor(characters),
    subscription,
  };
}

export const ELEVENLABS_LIMITS = Object.freeze({
  MAX_CHARACTERS_PER_REQUEST,
  OUTPUT_FORMAT: ELEVENLABS_OUTPUT_FORMAT,
  CONTENT_TYPE,
});
