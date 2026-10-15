/**
 * Render a two-host dialogue to MP3 with Azure AI Speech — the fallback path.
 *
 * This is the one Listen & Learn module with no upstream ancestor. Site-Main
 * synthesised through Cloud Text-to-Speech with Application Default
 * Credentials — a GCP identity this Function App cannot hold, for the same
 * reason Vertex was dropped from the AI router (see ai/router.js). Azure
 * Speech is the Azure-native replacement and is a better fit besides:
 *
 *   - A dialogue is expressed directly. SSML permits many `voice` elements in
 *     one document, each naming a different voice, so alternating hosts are
 *     just alternating elements — no speaker-alias table, no `multiSpeakerMarkup`
 *     and no 4,000-byte-per-request text cap to script around.
 *   - Auth is a resource key in an app setting, resolvable from Key Vault like
 *     every other secret here, with nothing to federate.
 *
 * What replaces the byte cap is a DURATION cap, and it fails dangerously: the
 * REST API silently TRUNCATES output at ten minutes rather than erroring. A
 * dialogue is therefore chunked to a conservative audio budget and the MP3
 * parts are concatenated. Truncation would look like a complete episode that
 * simply stops talking, which is exactly the failure a reviewer would approve
 * without noticing.
 *
 * The key is optional. Without it this module throws `SpeechNotConfiguredError`,
 * which generate.js treats as "publish the transcript, skip the audio" rather
 * than as a failed episode — the feature ships before the key does.
 *
 * Endpoint, headers and output formats verified against the Text-to-speech
 * REST API reference on 2026-08-24.
 *
 * THIS IS THE FALLBACK, not the default — see speech/index.js. Gemini runs on a
 * key the site already holds; this needs a Cognitive Services resource, which
 * is a spend decision. It is kept written and tested because every Gemini TTS
 * model is a preview model, and a GA second path is what makes a model
 * retirement a config change rather than an outage.
 */

/** Neural HD voices, both female, matching script.js's DEFAULT_SPEAKERS. */
export const AZURE_DEFAULT_VOICES = {
  Maya: 'en-US-Ava:DragonHDLatestNeural',
  Elena: 'en-US-Emma:DragonHDLatestNeural',
};

/**
 * 24 kHz / 48 kbps mono MP3 — speech, not music. At roughly 360 KB for a
 * ten-minute episode it streams comfortably and stays cheap to serve through
 * the media route, which puts these bytes through a Function invocation.
 */
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const CONTENT_TYPE = 'audio/mpeg';

/**
 * The API truncates at 600 seconds of audio. 480 is the working budget: the
 * 20% headroom absorbs the error in the estimate below, and being wrong in
 * this direction costs one extra request while being wrong in the other
 * silently deletes the end of an episode.
 */
const MAX_SECONDS_PER_REQUEST = 480;

/**
 * UTF-8 bytes of dialogue per second of speech.
 *
 * Deliberately pessimistic. The voice list publishes `WordsPerMinute` per
 * voice, from about 130 for the slowest en-US voices to 190 for the fastest;
 * a SLOW voice produces fewer bytes per second, so assuming slow over-estimates
 * the duration of a given script and chunks earlier than strictly needed.
 * Estimating with a fast voice would under-estimate duration and walk straight
 * into the truncation this constant exists to avoid.
 */
const BYTES_PER_SECOND = 13;

const MAX_BYTES_PER_REQUEST = MAX_SECONDS_PER_REQUEST * BYTES_PER_SECOND;

/** Retried once each; anything else is a fault the caller should see. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

/**
 * A locally-defined error rather than an import from `./index.js`, which
 * imports this module — a cycle would make one of the two undefined at load.
 * `name` and `provider` are what callers key off, not the constructor.
 */
class AzureSpeechError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'SpeechError';
    this.status = status;
    this.provider = 'azure';
  }
}

class AzureSpeechNotConfiguredError extends AzureSpeechError {
  constructor(message) {
    super(message);
    this.name = 'SpeechNotConfiguredError';
  }
}

function readSetting(env, name) {
  const value = String(env?.[name] || '').trim();
  if (!value || value.startsWith('@Microsoft.KeyVault(')) return '';
  return value;
}

/**
 * Resolve the synthesis endpoint.
 *
 * A full `AZURE_SPEECH_ENDPOINT` wins so a custom subdomain or a sovereign
 * cloud can be pointed at without a code change; otherwise the regional host
 * is built from `AZURE_SPEECH_REGION`.
 */
export function resolveSpeechEndpoint(env = process.env) {
  const explicit = readSetting(env, 'AZURE_SPEECH_ENDPOINT');
  if (explicit) return explicit.replace(/\/+$/, '');
  const region = readSetting(env, 'AZURE_SPEECH_REGION');
  if (!region) return '';
  return `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
}

/** XML text-node escaping. `&` first, or it would double-escape the others. */
export function escapeXml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const byteLength = (text) => Buffer.byteLength(String(text || ''), 'utf8');

/**
 * Split one over-long turn on sentence boundaries.
 *
 * Splitting inside a turn is safe in a way that dropping one is not: both
 * halves are spoken by the same voice, so the listener hears continuous
 * speech. Falls back to a hard byte split only if a single "sentence" is
 * itself over budget, which means punctuation-free text.
 */
/**
 * A sentence with no boundary to use, split on characters: the full chunks,
 * each at most `limit` bytes plus one multi-byte character, and the
 * remainder still open.
 */
function splitByBytes(sentence, limit) {
  const parts = [];
  let chunk = '';
  for (const char of sentence) {
    if (byteLength(chunk) + byteLength(char) > limit) {
      parts.push(chunk.trim());
      chunk = '';
    }
    chunk += char;
  }
  return { parts, remainder: chunk };
}

function splitTurnText(text, limit) {
  const sentences = String(text).match(/[^.!?]+[.!?]*\s*/g) || [String(text)];
  const parts = [];
  let buffer = '';

  for (const sentence of sentences) {
    if (buffer && byteLength(buffer) + byteLength(sentence) > limit) {
      parts.push(buffer.trim());
      buffer = '';
    }
    if (byteLength(sentence) > limit) {
      if (buffer.trim()) parts.push(buffer.trim());
      const split = splitByBytes(sentence, limit);
      parts.push(...split.parts);
      buffer = split.remainder;
      continue;
    }
    buffer += sentence;
  }

  if (buffer.trim()) parts.push(buffer.trim());
  return parts.filter(Boolean);
}

/**
 * Group turns into requests that stay inside the duration budget.
 *
 * Whole turns wherever possible so a speaker change never falls across a
 * request boundary mid-thought; an over-long single turn is split rather than
 * emitted alone and truncated.
 */
export function chunkTurns(turns, limit = MAX_BYTES_PER_REQUEST) {
  const chunks = [];
  let current = [];
  let currentBytes = 0;

  const flush = () => {
    if (current.length) chunks.push(current);
    current = [];
    currentBytes = 0;
  };

  for (const turn of turns) {
    const text = String(turn?.text || '').trim();
    if (!text) continue;
    const speaker = turn.speaker;

    if (byteLength(text) > limit) {
      flush();
      for (const part of splitTurnText(text, limit)) {
        chunks.push([{ speaker, text: part }]);
      }
      continue;
    }

    if (currentBytes + byteLength(text) > limit) flush();
    current.push({ speaker, text });
    currentBytes += byteLength(text);
  }

  flush();
  return chunks;
}

/**
 * One SSML document for one request.
 *
 * Consecutive turns are NOT merged into a single `voice` element even when the
 * same host speaks twice: separate elements give the synthesiser a sentence
 * boundary to breathe on, and merging saved nothing measurable.
 */
export function buildSsml(turns, { voices, lang = 'en-US', speakingRate = 1 }) {
  // A rate of 1 is the voice's own pace and is left unmarked; anything else
  // is a `<prosody rate>` percentage (ADR 0033 §4, per-book speaking rate —
  // Azure is the Listen & Learn provider that supports one).
  const rate = Number(speakingRate);
  const prosody = Number.isFinite(rate) && rate > 0 && rate !== 1;
  const wrap = (text) =>
    prosody ? `<prosody rate="${Math.round(rate * 100)}%">${text}</prosody>` : text;
  const body = turns
    .map((turn) => {
      const voice = voices[turn.speaker];
      if (!voice) {
        throw new AzureSpeechError(
          `No voice configured for speaker "${turn.speaker}" (known: ${Object.keys(voices).join(', ') || 'none'})`
        );
      }
      return `<voice name="${escapeXml(voice)}">${wrap(escapeXml(turn.text))}</voice>`;
    })
    .join('');

  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${escapeXml(lang)}">${body}</speak>`;
}

async function synthesizeOne(ssml, { endpoint, key, fetchImpl, sleep, signal }) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw signal.reason || new Error('aborted');
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': key,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': OUTPUT_FORMAT,
          // Required by the API, and capped at 255 characters.
          'User-Agent': 'HybridCloudWorks-ListenAndLearn/1.0',
        },
        body: ssml,
        signal,
      });
    } catch (err) {
      lastError = new AzureSpeechError(`Failed to reach Azure Speech: ${err.message}`);
      if (attempt === MAX_ATTEMPTS) throw lastError;
      await sleep(attempt * 500);
      continue;
    }

    if (response.ok) {
      return Buffer.from(await response.arrayBuffer());
    }

    // 401 is a rejected key and 400 is bad SSML; neither improves on a retry.
    const detail = await response.text().catch(() => '');
    lastError = new AzureSpeechError(
      `Azure Speech HTTP ${response.status}: ${detail.slice(0, 300) || 'no detail'}`,
      { status: response.status }
    );
    if (!RETRYABLE_STATUSES.has(response.status) || attempt === MAX_ATTEMPTS) throw lastError;
    await sleep(attempt * 500);
  }

  throw lastError;
}

/**
 * Synthesise a whole dialogue, returning one MP3.
 *
 * MP3 parts are concatenated bytewise. That is valid for this format — a
 * constant-bitrate MPEG audio stream is a sequence of self-describing frames
 * with no container header to reconcile — and it is what keeps this a pure
 * function of the API's own output, with no transcoding dependency.
 *
 * @param {object} params
 * @param {{speaker: string, text: string}[]} params.dialogue
 * @param {Record<string,string>} [params.voices] speaker name → Azure voice
 * @param {object} [params.env]
 * @param {Function} [params.fetchImpl]
 * @returns {Promise<{audio: Buffer, contentType: string, bytes: number, requests: number, estimatedSeconds: number}>}
 */
export async function synthesizeWithAzure({
  dialogue,
  // Null rather than DEFAULT_VOICES: a default value here is indistinguishable
  // from a caller passing one, and spreading it last silently outranked the
  // environment override it is supposed to defer to.
  voices = null,
  lang = 'en-US',
  speakingRate = 1,
  env = process.env,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  signal,
} = {}) {
  const turns = (dialogue || []).filter((t) => String(t?.text || '').trim());
  if (turns.length === 0) throw new AzureSpeechError('No dialogue turns to synthesise');

  const key = readSetting(env, 'AZURE_SPEECH_KEY');
  const endpoint = resolveSpeechEndpoint(env);
  if (!key) throw new AzureSpeechNotConfiguredError('AZURE_SPEECH_KEY is not configured');
  if (!endpoint) {
    throw new AzureSpeechNotConfiguredError(
      'Neither AZURE_SPEECH_ENDPOINT nor AZURE_SPEECH_REGION is configured'
    );
  }

  // Precedence, lowest to highest: built-in default, environment override,
  // explicit caller argument.
  const resolvedVoices = {
    ...AZURE_DEFAULT_VOICES,
    ...readVoiceOverrides(env),
    ...(voices || {}),
  };

  const chunks = chunkTurns(turns);
  const parts = [];
  for (const chunk of chunks) {
    if (signal?.aborted) throw signal.reason || new Error('aborted');
    // Sequential on purpose: the parts are concatenated in order, and a
    // parallel burst is the reliable way to meet the per-resource 429.
    parts.push(
      await synthesizeOne(buildSsml(chunk, { voices: resolvedVoices, lang, speakingRate }), {
        endpoint,
        key,
        fetchImpl,
        sleep,
        signal,
      })
    );
  }

  const audio = Buffer.concat(parts);
  const textBytes = turns.reduce((total, turn) => total + byteLength(turn.text), 0);

  return {
    audio,
    contentType: CONTENT_TYPE,
    bytes: audio.length,
    requests: chunks.length,
    estimatedSeconds: Math.round(textBytes / BYTES_PER_SECOND),
  };
}

/**
 * `LISTEN_AND_LEARN_VOICE_MAYA` / `..._ELENA` override a host's voice without a
 * deploy — the setting most likely to be tuned by ear after hearing an episode.
 */
export function readVoiceOverrides(env = process.env) {
  const overrides = {};
  for (const speaker of Object.keys(AZURE_DEFAULT_VOICES)) {
    const value = readSetting(env, `LISTEN_AND_LEARN_VOICE_${speaker.toUpperCase()}`);
    if (value) overrides[speaker] = value;
  }
  return overrides;
}

export const SPEECH_LIMITS = Object.freeze({
  MAX_SECONDS_PER_REQUEST,
  BYTES_PER_SECOND,
  MAX_BYTES_PER_REQUEST,
  OUTPUT_FORMAT,
  CONTENT_TYPE,
});
