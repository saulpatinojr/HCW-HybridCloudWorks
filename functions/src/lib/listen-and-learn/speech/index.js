/**
 * Turn a two-host dialogue into an episode MP3.
 *
 * Three providers, selected the way the AI router selects text models: a key
 * makes a provider POSSIBLE, and the first configured one in preference order
 * runs. Seed nothing and synthesis reports itself as not configured, which
 * generate.js treats as "publish the transcript, skip the audio" rather than as
 * a failed episode.
 *
 * Which providers, and in what order, depends on the PRODUCT asking (owner rule
 * 2026-09-09, ADR 0029 §2b). Until then one global order served every caller,
 * with ElevenLabs first because its key was present — so the paid podcast voice
 * read every Listen & Learn episode, and the `LISTEN_AND_LEARN_TTS_PROVIDER`
 * pin, read for every caller, would have pinned the podcast too. Every entry
 * point now takes `product` and refuses to guess without one:
 *
 *   product          providers, in order    pin setting                     why
 *   ───────────────  ─────────────────────  ──────────────────────────────  ───────────────────────────────────
 *   listenAndLearn   gemini, azure          LISTEN_AND_LEARN_TTS_PROVIDER   Gemini TTS is the study-podcast
 *                                                                            voice, generated on demand and
 *                                                                            stored as MP3, on the key the text
 *                                                                            side already holds. Azure AI Speech
 *                                                                            is the GA fallback for the day the
 *                                                                            preview Gemini TTS models retire.
 *   podcast          elevenlabs             PODCAST_TTS_PROVIDER            ElevenLabs is ONLY the podcast
 *                                                                            voice — article and Plaud
 *                                                                            transcripts to Podbean. Never for
 *                                                                            Listen & Learn.
 *
 * A pin is an instruction, not a preference: it must name one of ITS product's
 * providers, and a pinned provider that is not configured FAILS rather than
 * falling through, because falling through would silently produce episodes in
 * a voice nobody chose. A pin naming a provider from the other product fails
 * with the rule above in the message. Nothing falls through between products
 * either: the podcast product with no ElevenLabs key is "not configured" — a
 * saved draft with `audioError` naming `ELEVENLABS_API_KEY` — not a Gemini
 * reading. The out-of-credit fallthrough #447 added (ElevenLabs → Gemini) is
 * gone with it: its only use was the cross-product one this rule forbids.
 *
 * THE MODEL IS THE TASK'S (ADR 0034 slice 5, #860). `synthesizeDialogue` and
 * `estimateSpeechCostUsd` take `model`, and the caller reads it from the
 * selection document through the router's `modelForTask` — the Listen &
 * Learn job for `listenAndLearnSpeech`, the podcast pipeline for
 * `podcastVoice` (SPEECH_TASKS) — in place of the per-run, per-book and
 * stored fields the settings pages used to carry. A model is handed to the
 * provider whose id-space it belongs to and to no other: a `gemini-*-tts*`
 * id overlays the Gemini setting, an `eleven_*` id overlays the ElevenLabs
 * setting, and a Gemini id reaching the podcast is ignored exactly as before
 * (elevenlabs.js header: it would be sent as `model_id` and fail every run).
 * With no model — a caller with no resolver, a unit test — each provider
 * reads its own setting and module default, as it always has.
 *
 * All three return MP3, so everything downstream — the blob path, the stored
 * `contentType`, the `<audio>` element — is identical whichever ran. That is
 * deliberate: the provider is an implementation detail of this directory and
 * must not leak into the document shape.
 */
import { getCostEstimate } from '../../ai/router.js';
import { USAGE_SOURCES, featureSource } from '../../ai/usage.js';
import {
  synthesizeWithElevenLabs,
  ELEVENLABS_DEFAULT_VOICES,
  ELEVENLABS_DEFAULT_MODEL,
  ELEVENLABS_MODEL_SETTING,
  dialogueCharacters,
} from './elevenlabs.js';
import {
  synthesizeWithGemini,
  GEMINI_DEFAULT_VOICES,
  GEMINI_DEFAULT_MODEL,
  GEMINI_AUDIO_TOKENS_PER_SECOND,
} from './gemini.js';
import { synthesizeWithAzure, AZURE_DEFAULT_VOICES, SPEECH_LIMITS } from './azure.js';

export { encodePcmToMp3, MP3_BITRATE_KBPS } from './mp3.js';

/** Every provider returns this, so the caller never branches on which ran. */
export const CONTENT_TYPE = 'audio/mpeg';

/** The setting gemini.js reads its model from; `model` overrides it per call. */
export const GEMINI_MODEL_SETTING = 'LISTEN_AND_LEARN_TTS_MODEL';

/** The task each product's model is chosen under on the Tasks tab (ai/tasks.js). */
export const SPEECH_TASKS = Object.freeze({
  listenAndLearn: 'listenAndLearnSpeech',
  podcast: 'podcastVoice',
});

/** The slug each product's audio rows carried as `source` before slice 5, kept as `product` (ai/usage.js). */
export const SPEECH_USAGE_PRODUCTS = Object.freeze({
  listenAndLearn: USAGE_SOURCES.listenAndLearnAudio,
  podcast: USAGE_SOURCES.podcastAudio,
});

/**
 * The usage rows a rendered dialogue earns, for `recordAiUsageBatch`: one
 * row under the product's task (`ai:<task>` as `source`, the old slug as
 * `product`, ADR 0034 slice 5) when a provider spoke, none when the audio
 * step was skipped (`audio.speechProvider` null — not configured, or an
 * error the pipeline recorded instead). The one shape every pipeline
 * writes — Listen & Learn guide and source episodes, a spoken chapter, the
 * podcast — so the Usage tab reads one row kind for audio.
 *
 * @param {keyof typeof SPEECH_PRODUCTS} product
 * @param {{ speechProvider?: string|null, speechModel?: string|null, promptTokens?: number,
 *   completionTokens?: number, estimatedTokens?: boolean }} audio  renderAudio's result
 * @returns {Array<object>}
 */
export function speechUsageRows(product, audio) {
  const name = resolveProduct(product);
  if (!audio?.speechProvider) return [];
  return [
    {
      provider: audio.speechProvider,
      model: audio.speechModel,
      promptTokens: audio.promptTokens,
      completionTokens: audio.completionTokens,
      estimatedTokens: audio.estimatedTokens,
      source: featureSource(SPEECH_TASKS[name]),
      product: SPEECH_USAGE_PRODUCTS[name],
    },
  ];
}

/** True for an id in ElevenLabs's own space (`eleven_*`); any other is Gemini's. */
const isElevenLabsModel = (model) => /^eleven_/i.test(String(model || ''));

export class SpeechError extends Error {
  constructor(message, { status = null, provider = null } = {}) {
    super(message);
    this.name = 'SpeechError';
    this.status = status;
    this.provider = provider;
  }
}

/** Thrown when no key is configured, so a caller can degrade instead of fail. */
export class SpeechNotConfiguredError extends SpeechError {
  constructor(message = 'No speech provider is configured') {
    super(message);
    this.name = 'SpeechNotConfiguredError';
  }
}

/**
 * A Key Vault reference that failed to resolve arrives as the literal
 * `@Microsoft.KeyVault(...)` string. That is not a key — the same rule the AI
 * router applies in `readKey`, repeated here because this directory does not
 * import it.
 */
export function readSetting(env, name) {
  const value = String(env?.[name] || '').trim();
  if (!value || value.startsWith('@Microsoft.KeyVault(')) return '';
  return value;
}

const PROVIDERS = [
  {
    name: 'elevenlabs',
    keys: ['ELEVENLABS_API_KEY'],
    requirement: 'ELEVENLABS_API_KEY',
    synthesize: synthesizeWithElevenLabs,
  },
  {
    name: 'gemini',
    keys: ['GEMINI_API_KEY'],
    requirement: 'GEMINI_API_KEY',
    synthesize: synthesizeWithGemini,
  },
  {
    name: 'azure',
    // Azure needs a key AND somewhere to send it; a key with no region is not
    // a usable configuration, so it does not count as one.
    keys: ['AZURE_SPEECH_KEY'],
    extra: ['AZURE_SPEECH_REGION', 'AZURE_SPEECH_ENDPOINT'],
    requirement: 'AZURE_SPEECH_KEY together with AZURE_SPEECH_REGION or AZURE_SPEECH_ENDPOINT',
    synthesize: synthesizeWithAzure,
  },
];

const providerByName = (name) => PROVIDERS.find((p) => p.name === name);

/**
 * Product → the providers it may use, in preference order. The table in the
 * header, as code. Frozen: the rule is the owner's, not a caller's to extend.
 */
export const SPEECH_PRODUCTS = Object.freeze({
  listenAndLearn: Object.freeze(['gemini', 'azure']),
  podcast: Object.freeze(['elevenlabs']),
});

/** The pin setting each product reads — and the only one it reads. */
export const SPEECH_PIN_SETTINGS = Object.freeze({
  listenAndLearn: 'LISTEN_AND_LEARN_TTS_PROVIDER',
  podcast: 'PODCAST_TTS_PROVIDER',
});

const PRODUCT_LABELS = Object.freeze({
  listenAndLearn: 'Listen & Learn',
  podcast: 'podcast',
});

/** The rule a cross-product pin is refused with, so the message teaches it. */
const PRODUCT_RULE =
  'ElevenLabs is only the podcast voice; Listen & Learn audio is Gemini TTS, with Azure AI Speech as the fallback (ADR 0029 §2b)';

/**
 * The product a caller named, or a plain-sentence error. Own-key lookup, so
 * `constructor` and `__proto__` are unknown products rather than functions.
 */
function resolveProduct(product) {
  const key = String(product ?? '');
  if (product === undefined || product === null || !Object.hasOwn(SPEECH_PRODUCTS, key)) {
    const known = Object.keys(SPEECH_PRODUCTS).join(', ');
    throw new Error(
      product === undefined || product === null
        ? `Speech needs a product to choose a provider for (one of ${known}); none was given`
        : `Speech was asked for on behalf of unknown product ${JSON.stringify(product)}; known products are ${known}`
    );
  }
  return key;
}

const isConfigured = (env) => (p) =>
  p.keys.every((k) => readSetting(env, k)) &&
  (!p.extra || p.extra.some((k) => readSetting(env, k)));

/** The product's providers with a usable configuration, in its preference order. */
function configuredProviders(env, product) {
  return SPEECH_PRODUCTS[product].map(providerByName).filter(isConfigured(env));
}

/**
 * "No Listen & Learn speech provider is configured — set GEMINI_API_KEY, or …":
 * the sentence `synthesizeDialogue` degrades with, naming each of the
 * product's providers' REAL requirement (Azure is not configured by its key
 * alone). Exported so the pipelines' tests can assert the sentence their
 * `audioError` will carry.
 */
export function speechNotConfiguredMessage(product) {
  const name = resolveProduct(product);
  const needs = SPEECH_PRODUCTS[name].map((provider) => providerByName(provider).requirement);
  return `No ${PRODUCT_LABELS[name]} speech provider is configured — set ${needs.join(', or ')}`;
}

/**
 * The provider that would run for a product, or null.
 *
 * The product's pin setting names one outright — an instruction rather than a
 * preference, so a pin that is not configured FAILS rather than falling
 * through, and a pin naming the other product's provider fails with the rule.
 *
 * @param {object} [env]
 * @param {{product: keyof typeof SPEECH_PRODUCTS}} options
 */
export function resolveSpeechProvider(env = process.env, { product, provider = null } = {}) {
  const name = resolveProduct(product);
  const allowed = SPEECH_PRODUCTS[name];
  const configured = configuredProviders(env, name);
  const pinSetting = SPEECH_PIN_SETTINGS[name];

  // A book's own choice (ADR 0033 §4) outranks the pin: it is the more
  // specific instruction, and it is held to the same rule — one of the
  // product's providers, configured, or a sentence rather than a fallthrough.
  const chosen = String(provider || '')
    .trim()
    .toLowerCase();
  if (chosen) {
    const match = configured.find((p) => p.name === chosen);
    if (match) return match;
    if (allowed.includes(chosen)) {
      throw new SpeechNotConfiguredError(
        `The book asks for "${chosen}", which is not configured (${providerByName(chosen).requirement})`
      );
    }
    throw new SpeechNotConfiguredError(
      `The book asks for "${chosen}", which is not a ${PRODUCT_LABELS[name]} provider — ${PRODUCT_RULE}. ${PRODUCT_LABELS[name]} may use ${allowed.join(' or ')}`
    );
  }

  const pinned = readSetting(env, pinSetting).toLowerCase();
  if (pinned) {
    const match = configured.find((p) => p.name === pinned);
    if (match) return match;
    if (allowed.includes(pinned)) {
      throw new SpeechNotConfiguredError(`${pinSetting} pins "${pinned}", which is not configured`);
    }
    if (providerByName(pinned)) {
      throw new SpeechNotConfiguredError(
        `${pinSetting} pins "${pinned}", which is not a ${PRODUCT_LABELS[name]} provider — ${PRODUCT_RULE}. ${PRODUCT_LABELS[name]} may pin ${allowed.join(' or ')}`
      );
    }
    throw new SpeechNotConfiguredError(
      `${pinSetting} is "${pinned}"; ${PRODUCT_LABELS[name]} providers are ${allowed.join(', ')}`
    );
  }

  return configured[0] || null;
}

/**
 * Every provider a product knows, for the admin page's Advanced section
 * (ADR 0033 §4): whether it is configured, what configuring it takes, whether
 * the product may use it at all, and which one would run today with no
 * per-book choice — so the fallback behaviour is read from the server rather
 * than described from memory. Never throws: an unusable pin is reported as
 * `wouldRun: null` with its sentence in `pinError`.
 *
 * @param {object} [env]
 * @param {{product: keyof typeof SPEECH_PRODUCTS}} options
 */
export function describeSpeechProviders(env = process.env, { product } = {}) {
  const name = resolveProduct(product);
  const allowed = SPEECH_PRODUCTS[name];
  const pinSetting = SPEECH_PIN_SETTINGS[name];
  let wouldRun = null;
  let pinError = null;
  try {
    wouldRun = resolveSpeechProvider(env, { product: name })?.name || null;
  } catch (err) {
    if (err?.name !== 'SpeechNotConfiguredError') throw err;
    pinError = err.message;
  }
  return {
    product: name,
    order: [...allowed],
    pin: { setting: pinSetting, value: readSetting(env, pinSetting).toLowerCase() || null },
    wouldRun,
    pinError,
    providers: PROVIDERS.map((p) => ({
      id: p.name,
      configured: isConfigured(env)(p),
      requirement: p.requirement,
      allowed: allowed.includes(p.name),
      // Why a provider is off the list for this product, by the owner's rule.
      reason: allowed.includes(p.name) ? null : PRODUCT_RULE,
    })),
  };
}

/**
 * The turns that will actually be spoken, as they will be spoken: blank turns
 * dropped and each remaining text trimmed.
 *
 * One helper for both `synthesizeDialogue` and `estimateSpeechCostUsd`, so
 * the estimate can never count a turn synthesis would drop, nor whitespace
 * synthesis would strip — every provider trims a turn before sending it, and
 * a byte or character count taken before that trim overstated the figure
 * shown to the operator. Before the filter was shared, a whitespace-only
 * dialogue estimated $0 while synthesis refused it.
 *
 * @param {{speaker: string, text: string}[]|null|undefined} dialogue
 * @returns {{speaker: string, text: string}[]}
 */
export function speakableTurns(dialogue) {
  return (dialogue || [])
    .map((t) => ({ ...t, text: String(t?.text || '').trim() }))
    .filter((t) => t.text);
}

/**
 * The environment a provider runs with. A chosen model is handed to the
 * provider through the setting it already reads — an overlay on a COPY of
 * the env, never a write to `process.env` — so the provider module is
 * untouched and the precedence "caller's choice beats the setting" holds in
 * one place. Each provider takes only an id of its own (header): Gemini any
 * id that is not ElevenLabs's, ElevenLabs an `eleven_*` id; Azure has no
 * model to choose.
 */
function providerEnv(provider, env, model) {
  if (!model) return env;
  if (provider.name === 'gemini' && !isElevenLabsModel(model)) {
    return { ...env, [GEMINI_MODEL_SETTING]: model };
  }
  if (provider.name === 'elevenlabs' && isElevenLabsModel(model)) {
    return { ...env, [ELEVENLABS_MODEL_SETTING]: model };
  }
  return env;
}

/**
 * Synthesise a whole dialogue, returning one MP3.
 *
 * Exactly one provider is tried: the product's resolved one. Any failure —
 * a bad request, a rejected key, an exhausted account, a 5xx that survived
 * its retries — fails the call, because retrying elsewhere would hide a fault
 * behind a different voice, and because the other voice may belong to the
 * other product.
 *
 * @param {object} params
 * @param {keyof typeof SPEECH_PRODUCTS} params.product
 * @param {{speaker: string, text: string}[]} params.dialogue
 * @param {Record<string,string>} [params.voices] speaker name → provider voice
 * @param {string|null} [params.model] the task's model (header): a Gemini id for Gemini, an `eleven_*` id for ElevenLabs; ignored by Azure
 * @param {string|null} [params.provider] a book's own provider (ADR 0033 §4); null for the product's order and pin
 * @param {string} [params.lang] BCP 47 tag; Azure puts it on the SSML, Gemini infers it
 * @param {number} [params.speakingRate] 1 is the voice's pace; Azure honours it, Gemini has no rate
 * @param {object} [params.env]
 * @param {Function} [params.fetchImpl]
 * @returns {Promise<{audio: Buffer, contentType: string, bytes: number, provider: string, requests: number}>}
 */
export async function synthesizeDialogue({
  product,
  dialogue,
  voices = null,
  model = null,
  provider: chosenProvider = null,
  lang = 'en-US',
  speakingRate = 1,
  env = process.env,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const name = resolveProduct(product);
  const turns = speakableTurns(dialogue);
  if (turns.length === 0) throw new SpeechError('No dialogue turns to synthesise');

  const provider = resolveSpeechProvider(env, { product: name, provider: chosenProvider });
  if (!provider) throw new SpeechNotConfiguredError(speechNotConfiguredMessage(name));

  const result = await provider.synthesize({
    dialogue: turns,
    voices,
    lang,
    speakingRate,
    env: providerEnv(provider, env, model),
    fetchImpl,
    sleep,
  });
  return { ...result, provider: provider.name, contentType: CONTENT_TYPE };
}

/**
 * The model the current settings would use for a provider — the same rule
 * each provider applies when it runs, so the estimate prices what will
 * actually be called. For Gemini a caller's `model` wins, as it does in
 * `providerEnv`.
 */
function modelFor(providerName, env, model) {
  if (providerName === 'elevenlabs') {
    return (
      (isElevenLabsModel(model) ? model : null) ||
      readSetting(env, ELEVENLABS_MODEL_SETTING) ||
      ELEVENLABS_DEFAULT_MODEL
    );
  }
  if (providerName === 'gemini') {
    return (
      (model && !isElevenLabsModel(model) ? model : null) ||
      readSetting(env, GEMINI_MODEL_SETTING) ||
      GEMINI_DEFAULT_MODEL
    );
  }
  return null;
}

/**
 * What Gemini TTS would charge to read this many UTF-8 bytes with `model`.
 *
 * Best-effort and deliberately high: bytes → seconds at the pessimistic
 * speaking rate azure.js chunks with → audio tokens at the published
 * per-second rate, rounded UP to a whole token → the model's output price in
 * `COST_TABLE`. Every step over-estimates, which is the right direction for
 * a figure shown before spending — `Math.round` here could round a fractional
 * token count down and put the "ceiling" below the exact value (Copilot on
 * the PR). Exported so the settings page can price each model choice at the
 * script ceiling with the same arithmetic the 202 uses.
 *
 * @param {string} model a Gemini TTS model id
 * @param {number} bytes UTF-8 bytes of dialogue
 * @returns {number|null} USD, or null when the model is not priced
 */
export function estimateGeminiCostUsd(model, bytes) {
  const seconds = Math.max(0, Number(bytes) || 0) / SPEECH_LIMITS.BYTES_PER_SECOND;
  const audioTokens = Math.ceil(seconds * GEMINI_AUDIO_TOKENS_PER_SECOND);
  return getCostEstimate('gemini', model, 0, audioTokens);
}

/**
 * What a dialogue of this size would cost to read, BEFORE reading it.
 *
 * Provider-aware. ElevenLabs is exact in its unit — characters × the rate in
 * `COST_TABLE`, the same arithmetic the usage row is priced with afterwards.
 * Gemini is `estimateGeminiCostUsd` above. Azure Speech is not in the cost
 * table, so its estimate is honestly `null` rather than a guess.
 *
 * Pass `dialogue` when there is one, or `ceilingBytes` when there is not yet —
 * the enqueue handler estimates against the script's byte ceiling before any
 * script exists. Two units are in play and they are kept apart, in the names
 * as well as the arithmetic: ElevenLabs bills CHARACTERS (code points), while
 * the speaking-rate constant borrowed from azure.js is UTF-8 BYTES per second.
 * A dialogue is therefore measured both ways and both counts are returned. A
 * ceiling is BYTES only: a byte count is never fewer than a character count,
 * so pricing ElevenLabs against it over-estimates, which is the direction a
 * figure shown before spending must err in — and `characters` is `null` in
 * that case rather than a byte count wearing the wrong name.
 *
 * @param {object} params
 * @param {keyof typeof SPEECH_PRODUCTS} params.product
 * @param {{speaker: string, text: string}[]} [params.dialogue]
 * @param {number} [params.ceilingBytes] a ceiling in UTF-8 bytes (see above)
 * @param {string|null} [params.model] the task's model, applied to the provider it belongs to (header)
 * @param {object} [params.env]
 * @returns {{provider: string, model: string|null, bytes: number, characters: number|null, estimatedCostUsd: number|null}|null}
 *   `bytes` is what was measured or the ceiling; `characters` is the
 *   dialogue's code-point count (the ElevenLabs billing unit) or null when
 *   only a ceiling was given. null when no provider is configured (or the
 *   pin is unusable), and null when there is nothing to price — no ceiling
 *   and no speakable turn — since synthesis would refuse that dialogue rather
 *   than read it for free.
 */
export function estimateSpeechCostUsd({
  product,
  dialogue = null,
  ceilingBytes = null,
  model = null,
  provider: chosenProvider = null,
  env = process.env,
} = {}) {
  const name = resolveProduct(product);
  let provider;
  try {
    provider = resolveSpeechProvider(env, { product: name, provider: chosenProvider });
  } catch (err) {
    if (err?.name === 'SpeechNotConfiguredError') return null;
    throw err;
  }
  if (!provider) return null;

  // `Number(null)` is 0, so the null check comes first or a dialogue is
  // never counted.
  const hasCeiling =
    ceilingBytes !== null && ceilingBytes !== undefined && Number.isFinite(Number(ceilingBytes));
  // Up, never to nearest: a fractional ceiling must not price below itself.
  const ceiling = hasCeiling ? Math.max(0, Math.ceil(Number(ceilingBytes))) : null;
  // The same filter synthesis applies, so a blank turn is never priced — and
  // a dialogue that is nothing but blank turns is "nothing to price", not $0.
  const turns = speakableTurns(dialogue);
  if (!hasCeiling && turns.length === 0) return null;
  const characters = hasCeiling ? null : dialogueCharacters(turns);
  const bytes = hasCeiling ? ceiling : dialogueBytes(turns);
  const chosenModel = modelFor(provider.name, env, model);

  let estimatedCostUsd = null;
  if (provider.name === 'elevenlabs') {
    // Characters when known; the byte ceiling otherwise, which is an upper
    // bound on characters.
    estimatedCostUsd = getCostEstimate('elevenlabs', chosenModel, 0, characters ?? bytes);
  } else if (provider.name === 'gemini') {
    estimatedCostUsd = estimateGeminiCostUsd(chosenModel, bytes);
  }

  return { provider: provider.name, model: chosenModel, bytes, characters, estimatedCostUsd };
}

/** UTF-8 bytes of every turn's text — the unit azure.js's speaking rate is in. */
function dialogueBytes(turns) {
  return turns.reduce(
    (total, turn) => total + Buffer.byteLength(String(turn?.text ?? ''), 'utf8'),
    0
  );
}

/** Exposed so the admin surface can say which voices an episode was read in. */
export const DEFAULT_VOICES = Object.freeze({
  gemini: GEMINI_DEFAULT_VOICES,
  azure: AZURE_DEFAULT_VOICES,
  elevenlabs: ELEVENLABS_DEFAULT_VOICES,
});
