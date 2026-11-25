/**
 * Render a two-host dialogue with the Gemini TTS models.
 *
 * This is the capability the feature was asked for: a two-host "deep dive" read
 * from source material is what a NotebookLM audio overview is, and these are
 * the models that produce it. It runs on `GEMINI_API_KEY` — the key the text
 * side of the site already uses — so the whole feature needs no new service, no
 * new resource and no new credential.
 *
 * Contract, verified on 2026-09-09 against the Interactions API reference
 * (https://ai.google.dev/api/interactions-api) and the speech-generation guide
 * (https://ai.google.dev/gemini-api/docs/speech-generation):
 *
 *   POST https://generativelanguage.googleapis.com/v1beta/interactions
 *   x-goog-api-key: <key>
 *   { model, input, response_format: {type:'audio'},
 *     generation_config: { speech_config: [{speaker, voice}, …] } }
 *
 * The reply is an **Interaction object**, not an audio payload:
 *
 *   { status: 'completed' | 'incomplete' | 'failed' | 'cancelled' | …,
 *     errors?: [{ code, message }],
 *     steps: [{ type: 'model_output',
 *               content: [{ type: 'audio', data: <base64>,
 *                           mime_type?, sample_rate?, channels? }, …] }],
 *     usage?: { total_input_tokens, total_output_tokens, … } }
 *
 * `output_audio.data`, which this module read until 2026-09-09, is a
 * convenience accessor the Python and JavaScript SDKs expose on *their*
 * Interaction object — the guide's examples use it — and the REST JSON has no
 * such field. Reading it made every 200 with audio in `steps` look like "no
 * audio" (#458). `extractAudio` walks `steps` and keeps the accessor only as a
 * fallback, in case a REST revision adds it.
 *
 * Three properties of that contract shape this module:
 *
 *   - **Multi-speaker takes at most two speakers**, which is exactly the number
 *     this feature has. `assertTwoSpeakers` turns a third into a clear error
 *     rather than an opaque 400.
 *   - **The dialogue is a PROMPT, not markup.** The model is told to speak a
 *     transcript, and the speaker labels in that transcript must match the
 *     `speaker` names in `speech_config` — so the labels are load-bearing and
 *     are written from the same map that assigns the voices.
 *   - **The session context is 32k tokens**, and a whole episode script is
 *     capped at 9,000 bytes (~2.5k tokens) — but a TTS reply is bounded by
 *     AUDIO length, not by the context window, and a 9,000-byte script came
 *     back `incomplete` often enough to be a risk worth removing (ADR 0033
 *     §4, the Audio Library slice). The dialogue is therefore chunked on
 *     sentence boundaries under `GEMINI_MAX_REQUEST_BYTES`, each part is
 *     rendered in its own request, and the PCM is concatenated BEFORE the
 *     one MP3 encode — so the episode is one continuous stream rather than
 *     a byte-joined set of MP3 files. The Azure path chunks against its
 *     ten-minute audio cap for the same reason; the split rule is shared.
 *
 * The audio block's `mime_type`, `sample_rate` and `channels` have no
 * documented defaults. The guide says the models produce 24 kHz 16-bit PCM, so
 * a block that omits them is read as headerless 24 kHz 16-bit mono; one that
 * says `audio/wav`, or whose bytes begin `RIFF`, has its header read for the
 * rate and channel count and stripped. Stereo is averaged to mono because
 * mp3.js encodes mono. Either way the PCM is encoded to MP3 here; see mp3.js
 * for why that is not optional.
 *
 * Legacy preview models and newer structured-speech models coexist here.
 * Azure remains the product's fallback — see speech/index.js.
 */
import { summedTokenUsage } from './gemini-usage.js';
import { assertPcm16, downmixToMono, extractAudio, GeminiSpeechError } from './gemini-audio.js';
import { encodePcmToMp3, pcmDurationSeconds } from './mp3.js';
import { chunkTurns } from './azure.js';

// Reading the audio out of a reply, and the error class, live in
// gemini-audio.js; exported again here so callers keep importing from
// gemini.js.
export { downmixToMono, extractAudio, GeminiSpeechError, parseWav } from './gemini-audio.js';

const INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';

/**
 * Default model, overridable with `LISTEN_AND_LEARN_TTS_MODEL`.
 *
 * `gemini-2.5-flash-preview-tts` is the cheapest sensible voice and, from
 * ADR 0033 §4 on, the one that reads when nothing is stored and nothing is
 * chosen: half the price of 3.1 flash per audio token in `COST_TABLE`, and
 * the admin page says so beside the per-episode estimate. 3.1 flash stays
 * on offer as "Best" (#458). The three TTS models the guide lists on
 * 2026-09-09 are all preview:
 *
 *   gemini-2.5-flash-preview-tts   <- default here (Economy)
 *   gemini-3.1-flash-tts-preview   newest voice, twice the price (Best)
 *   gemini-2.5-pro-preview-tts     higher quality, not offered
 *
 * The same guide lists 30 voices, each with a one-word descriptor, and the two
 * used here are both in it — see GEMINI_DEFAULT_VOICES.
 */
const DEFAULT_MODEL = 'gemini-2.5-flash-preview-tts';

// Google cookbook, read 2026-10-27: 3.8 speaks text verbatim; speaker labels
// and delivery instructions belong in speech_metadata, not the spoken text.
// https://github.com/google-gemini/cookbook/blob/main/quickstarts/Get_started_TTS.ipynb
const STRUCTURED_SPEECH_MODELS = new Set(['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts']);

export function speechInputFor(model, turns, speakers) {
  if (!STRUCTURED_SPEECH_MODELS.has(model)) return buildDialoguePrompt(turns, speakers);
  return turns.map(({ speaker, text }) => ({
    type: 'text',
    text,
    annotations: [{ type: 'speech_metadata', speaker }],
  }));
}

/**
 * The most UTF-8 bytes of dialogue sent in one request. Well under the
 * 9,000-byte script cap, so every episode is at least two requests; chosen
 * so that one part is a few minutes of speech, which the model completes
 * reliably where a whole episode did not (ADR 0033 §4).
 */
export const GEMINI_MAX_REQUEST_BYTES = 4500;
/** Named for index.js, which prices a run against this model before it starts. */
export { DEFAULT_MODEL as GEMINI_DEFAULT_MODEL };


export { GEMINI_AUDIO_TOKENS_PER_SECOND, tokenUsage } from './gemini-usage.js';

/**
 * Voices for the two hosts, chosen by the descriptor the voice list publishes
 * rather than by gender, which it does not publish.
 *
 * The pairing follows the roles script.js already assigns: the lead frames the
 * area (Kore, *Firm*) and the second host asks the question a learner would ask
 * (Leda, *Youthful*). Two distinct descriptors is what a listener needs to tell
 * the hosts apart; anything more specific would be an assumption about voices
 * the documentation does not describe that way. Override per host with
 * `LISTEN_AND_LEARN_VOICE_MAYA` / `…_ELENA`.
 */
export const GEMINI_DEFAULT_VOICES = {
  Maya: 'Kore',
  Elena: 'Leda',
};

/** The API accepts at most two speaker configurations. */
const MAX_SPEAKERS = 2;

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

function readSetting(env, name) {
  const value = String(env?.[name] || '').trim();
  if (!value || value.startsWith('@Microsoft.KeyVault(')) return '';
  return value;
}

/** `LISTEN_AND_LEARN_VOICE_MAYA` etc., so a voice can be changed by ear. */
export function readVoiceOverrides(env = process.env) {
  const overrides = {};
  for (const speaker of Object.keys(GEMINI_DEFAULT_VOICES)) {
    const value = readSetting(env, `LISTEN_AND_LEARN_VOICE_${speaker.toUpperCase()}`);
    if (value) overrides[speaker] = value;
  }
  return overrides;
}

/**
 * Render the dialogue as the transcript the model is asked to speak.
 *
 * The speaker labels must match the `speech_config` names exactly — an
 * unmatched label is read aloud as text instead of switching voice, which
 * sounds like a narrator announcing "Maya colon" before every line. Newlines
 * separate turns because a run-on paragraph invites the model to merge them.
 */
export function buildDialoguePrompt(turns, speakers) {
  const [a, b] = speakers;
  const transcript = turns.map((turn) => `${turn.speaker}: ${turn.text}`).join('\n');
  // One speaker is a narrator reading a chapter (ADR 0033 §4, a manual book
  // chapter spoken from pasted text); "a conversation between A and
  // undefined" would be read aloud as written.
  if (speakers.length === 1) return `TTS the following text read by ${a}:\n${transcript}`;
  return `TTS the following conversation between ${a} and ${b}:\n${transcript}`;
}

/**
 * Split a dialogue into the parts one request may carry: `chunkTurns` from
 * the Azure provider, which keeps turns whole where it can and splits an
 * over-long turn on sentence boundaries, at this provider's byte budget.
 *
 * @param {{speaker: string, text: string}[]} turns
 * @param {number} [limit]
 * @returns {{speaker: string, text: string}[][]}
 */
export function chunkDialogueForGemini(turns, limit = GEMINI_MAX_REQUEST_BYTES) {
  return chunkTurns(turns, limit);
}

/** The distinct speakers in a dialogue, in the order they first appear. */
export function speakersIn(turns) {
  const seen = [];
  for (const turn of turns) {
    if (turn.speaker && !seen.includes(turn.speaker)) seen.push(turn.speaker);
  }
  return seen;
}

function assertTwoSpeakers(speakers, voices) {
  if (speakers.length === 0) throw new GeminiSpeechError('Dialogue names no speakers');
  if (speakers.length > MAX_SPEAKERS) {
    throw new GeminiSpeechError(
      `Gemini multi-speaker TTS accepts at most ${MAX_SPEAKERS} speakers; this dialogue has ${speakers.length} (${speakers.join(', ')})`
    );
  }
  const missing = speakers.filter((s) => !voices[s]);
  if (missing.length) {
    throw new GeminiSpeechError(
      `No voice configured for speaker${missing.length > 1 ? 's' : ''} ${missing.join(', ')} (known: ${Object.keys(voices).join(', ') || 'none'})`
    );
  }
}

async function requestAudio(body, { key, fetchImpl, sleep, signal }) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw signal.reason || new Error('aborted');
    let response;
    try {
      response = await fetchImpl(INTERACTIONS_URL, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      lastError = new GeminiSpeechError(`Failed to reach the Gemini API: ${err.message}`);
      if (attempt === MAX_ATTEMPTS) throw lastError;
      await sleep(attempt * 500);
      continue;
    }

    if (response.ok) return response.json();

    // 400 is a malformed request and 401/403 a rejected key; neither improves
    // on a retry. 429 and 5xx do.
    const detail = await response.text().catch(() => '');
    lastError = new GeminiSpeechError(
      `Gemini TTS HTTP ${response.status}: ${detail.slice(0, 300) || 'no detail'}`,
      { status: response.status }
    );
    if (!RETRYABLE_STATUSES.has(response.status) || attempt === MAX_ATTEMPTS) throw lastError;
    await sleep(attempt * 500);
  }

  throw lastError;
}

/**
 * The reply's shape by type only — `model_output[text]` — never its text.
 * This is what an operator reads on the episode card when there is no audio.
 */
function describeShape(payload) {
  const steps = Array.isArray(payload?.steps) ? payload.steps : [];
  if (steps.length === 0) return payload?.output_audio ? 'output_audio without data' : 'no steps';
  return steps
    .map((step) => {
      const types = Array.isArray(step?.content)
        ? step.content.map((c) => c?.type || 'unknown')
        : [];
      return `${step?.type || 'unknown'}[${types.join(',')}]`;
    })
    .join(', ');
}

/** `errors[]` as `code: message; code: message`, or a note that there were none. */
function describeErrors(payload) {
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  if (errors.length === 0) return 'no error detail';
  return errors
    .map(
      (e) => `${e?.code || 'unknown'}: ${String(e?.message || '').slice(0, 200) || 'no message'}`
    )
    .join('; ');
}

/**
 * @param {object} params
 * @param {{speaker: string, text: string}[]} params.dialogue
 * @param {Record<string,string>|null} [params.voices]
 * @param {object} [params.env]
 * @param {Function} [params.fetchImpl]
 * @returns {Promise<{audio: Buffer, bytes: number, requests: number, model: string, estimatedSeconds: number}>}
 */
export async function synthesizeWithGemini({
  dialogue,
  voices = null,
  env = process.env,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  signal,
}) {
  const key = readSetting(env, 'GEMINI_API_KEY');
  if (!key) throw new GeminiSpeechError('GEMINI_API_KEY is not configured');

  // Precedence, lowest to highest: built-in default, environment override,
  // explicit caller argument.
  const resolvedVoices = {
    ...GEMINI_DEFAULT_VOICES,
    ...readVoiceOverrides(env),
    ...(voices || {}),
  };

  const speakers = speakersIn(dialogue);
  assertTwoSpeakers(speakers, resolvedVoices);

  const model = readSetting(env, 'LISTEN_AND_LEARN_TTS_MODEL') || DEFAULT_MODEL;
  const speechConfig = speakers.map((speaker) => ({ speaker, voice: resolvedVoices[speaker] }));

  // Sequential on purpose: the parts are joined in order, and a parallel
  // burst is the reliable way to meet a 429.
  const chunks = chunkDialogueForGemini(dialogue);
  const parts = [];
  const usages = [];
  for (const [index, chunk] of chunks.entries()) {
    if (signal?.aborted) throw signal.reason || new Error('aborted');
    const payload = await requestAudio(
      {
        model,
        input: speechInputFor(model, chunk, speakers),
        response_format: { type: 'audio' },
        generation_config: { speech_config: speechConfig },
      },
      { key, fetchImpl, sleep, signal }
    );
    parts.push(audioFromReply(payload, { part: index + 1, of: chunks.length }));
    usages.push(payload?.usage);
  }

  const [{ sampleRate }] = parts;
  const odd = parts.find((p) => p.sampleRate !== sampleRate);
  if (odd) {
    throw new GeminiSpeechError(
      `Gemini returned parts at different sample rates (${sampleRate} Hz and ${odd.sampleRate} Hz), which cannot be joined without resampling`
    );
  }
  const pcm = parts.length === 1 ? parts[0].pcm : Buffer.concat(parts.map((p) => p.pcm));

  // The encoder throws a plain Error. The episode card and the provider
  // selector key on SpeechError, so it is rewrapped as one; its messages are
  // byte counts, never content.
  let audio;
  let seconds;
  try {
    audio = encodePcmToMp3(pcm, { sampleRate });
    seconds = pcmDurationSeconds(pcm, sampleRate);
  } catch (err) {
    throw new GeminiSpeechError(`Could not encode the Gemini audio to MP3: ${err.message}`);
  }

  return {
    audio,
    bytes: audio.length,
    requests: chunks.length,
    model,
    estimatedSeconds: Math.round(seconds),
    ...summedTokenUsage(usages, seconds),
  };
}

/**
 * One reply → mono PCM at its sample rate, or a SpeechError saying why not.
 *
 * A 200 is the transport succeeding; whether the model did is `status`.
 * `failed` carries the reason in `errors`; `incomplete` means the model hit
 * a limit, so any audio present would stop mid-sentence and is not shipped.
 * The part number is in every message, because with chunking "part 3 of 4
 * stopped early" is the fact an operator retries on.
 */
function audioFromReply(payload, { part, of }) {
  const where = of > 1 ? ` (part ${part} of ${of})` : '';
  const status = String(payload?.status || 'unknown');
  if (status === 'failed') {
    throw new GeminiSpeechError(
      `Gemini TTS failed${where} (status failed): ${describeErrors(payload)}.`
    );
  }
  if (status === 'incomplete') {
    throw new GeminiSpeechError(
      `Gemini TTS stopped early${where} (status incomplete), so the audio would be truncated: ${describeErrors(payload)}.`
    );
  }

  const found = extractAudio(payload);
  if (!found) {
    // A 200 with no audio is a real outcome — a safety block, or a model that
    // answered in text. Saying what came back instead beats a zero-byte MP3
    // nobody can play, and a shape by type is content-free.
    throw new GeminiSpeechError(
      `Gemini returned no audio for this dialogue${where} (status ${status}; the reply held ${describeShape(payload)}; ${describeErrors(payload)}).`
    );
  }

  const pcm = downmixToMono(found.pcm, found.channels);
  assertPcm16(pcm, `Gemini audio${where}`);
  return { pcm, sampleRate: found.sampleRate };
}
