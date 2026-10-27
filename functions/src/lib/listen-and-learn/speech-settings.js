/**
 * The Gemini TTS models a Listen & Learn episode may be read with, and,
 * since ADR 0033 §4 (Audio Library), the voice a BOOK is read in.
 *
 * THE MODEL IS CHOSEN ON THE TASKS TAB (ADR 0034 slice 5, #860). Until then
 * the choice was made in three places — a stored default in
 * `admin_config/listen_and_learn_speech` on Platform settings, a per-run
 * `ttsModel` on the generation form, and a per-book `voice.model` — with a
 * precedence rule here. All three are gone: the job reads the model for the
 * `listenAndLearnSpeech` task through the router's `modelForTask`, the
 * selection document carries the choice, and the migration
 * (ai/migrate-selection.js) turned a stored default that differed from the
 * recommendation into that task's custom chain, so nothing changed for the
 * owner on merge. A `ttsModel` in a payload and a `model` in a book's voice
 * are IGNORED on write and dropped on read: a client written before this
 * slice still gets its 202, in the task's voice. The stored document's id
 * stays named here because the config loader reads it once as the
 * migration's input (ai/containers.js restates it).
 *
 * The two models stay listed: Best (3.1) and Economy (2.5, the module
 * default, ADR 0033 §4), both priced in `COST_TABLE` with Best at about
 * twice the cost. The 202's estimate, which cannot know the task's choice
 * synchronously, prices every episode at the dearer of the two so it stays
 * a ceiling (listen-and-learn-jobs.js). "Newer certifications: Best; older
 * ones: Economy" stays as guidance for the person choosing, on the Tasks
 * tab now.
 *
 * PER-BOOK VOICE (ADR 0033 §4). A book or course document may carry a `voice`
 * object — which provider reads it, which voice per host and for a
 * narrator, the language and the speaking rate — normalised here by
 * `normalizeVoiceSettings` so a document never holds a voice id the providers
 * would not accept. Gemini voices are the thirty the speech-generation guide
 * lists; Azure voices are free-form neural voice names because the catalogue
 * is regional and too large to pin. Speaking rate applies where the provider
 * supports it (Azure SSML `<prosody rate>`); Gemini TTS has no rate parameter
 * and reads at its own pace, which the admin page says.
 */
import { GEMINI_DEFAULT_MODEL } from './speech/gemini.js';

/**
 * The `admin_config` document the stored default lived in until slice 5
 * (header): read by the config loader as the migration's input, written by
 * nothing any more.
 */
export const LISTEN_AND_LEARN_SPEECH_CONFIG_ID = 'listen_and_learn_speech';

/**
 * The two Gemini TTS models this product has offered, in the order the
 * control showed them. `label` is the owner's wording; `tier` is the stable
 * key the tests use. Economy is the module default (gemini.js) and the
 * legacy fallback; the current reviewed recommendation lives in ai/tasks.js.
 */
export const LISTEN_AND_LEARN_GEMINI_MODELS = Object.freeze([
  Object.freeze({
    id: 'gemini-3.1-flash-tts-preview',
    tier: 'best',
    label: 'Best — newest voice, about twice the cost',
  }),
  Object.freeze({
    id: 'gemini-2.5-flash-preview-tts',
    tier: 'economy',
    label: 'Economy — cheaper',
  }),
]);

export const LISTEN_AND_LEARN_GEMINI_MODEL_IDS = Object.freeze(
  LISTEN_AND_LEARN_GEMINI_MODELS.map((m) => m.id)
);

/**
 * The model that reads when the task resolves to Gemini and names no model:
 * gemini.js's own default, which is Economy. One source, read rather than
 * restated, so the two cannot disagree.
 */
export const LISTEN_AND_LEARN_DEFAULT_MODEL = GEMINI_DEFAULT_MODEL;

// ── voices ──────────────────────────────────────────────────────────────────

/**
 * The thirty Gemini TTS voices, with the one-word descriptor the
 * speech-generation guide gives each (https://ai.google.dev/gemini-api/docs/
 * speech-generation, read 2026-09-09). The descriptor is the only thing the
 * documentation says about a voice, so it is the only thing shown.
 */
export const GEMINI_VOICES = Object.freeze(
  [
    ['Zephyr', 'Bright'],
    ['Puck', 'Upbeat'],
    ['Charon', 'Informative'],
    ['Kore', 'Firm'],
    ['Fenrir', 'Excitable'],
    ['Leda', 'Youthful'],
    ['Orus', 'Firm'],
    ['Aoede', 'Breezy'],
    ['Callirrhoe', 'Easy-going'],
    ['Autonoe', 'Bright'],
    ['Enceladus', 'Breathy'],
    ['Iapetus', 'Clear'],
    ['Umbriel', 'Easy-going'],
    ['Algieba', 'Smooth'],
    ['Despina', 'Smooth'],
    ['Erinome', 'Clear'],
    ['Algenib', 'Gravelly'],
    ['Rasalgethi', 'Informative'],
    ['Laomedeia', 'Upbeat'],
    ['Achernar', 'Soft'],
    ['Alnilam', 'Firm'],
    ['Schedar', 'Even'],
    ['Gacrux', 'Mature'],
    ['Pulcherrima', 'Forward'],
    ['Achird', 'Friendly'],
    ['Zubenelgenubi', 'Casual'],
    ['Vindemiatrix', 'Gentle'],
    ['Sadachbia', 'Lively'],
    ['Sadaltager', 'Knowledgeable'],
    ['Sulafat', 'Warm'],
  ].map(([id, descriptor]) => Object.freeze({ id, descriptor }))
);

export const GEMINI_VOICE_IDS = Object.freeze(GEMINI_VOICES.map((v) => v.id));

/**
 * A handful of Azure neural voices to offer by name. The full catalogue is
 * regional and runs to hundreds; these are the en-US voices the Azure
 * provider's own defaults sit among. Any other well-formed voice name is
 * accepted too (see `isVoiceName`), because an operator may know one.
 */
export const AZURE_VOICES = Object.freeze(
  [
    'en-US-Ava:DragonHDLatestNeural',
    'en-US-Emma:DragonHDLatestNeural',
    'en-US-AvaNeural',
    'en-US-EmmaNeural',
    'en-US-AndrewNeural',
    'en-US-BrianNeural',
    'en-US-JennyNeural',
    'en-US-AriaNeural',
    'en-US-GuyNeural',
    'en-US-DavisNeural',
  ].map((id) => Object.freeze({ id, descriptor: '' }))
);

/** The providers a book may name. `auto` is the product's own order and pin. */
export const VOICE_PROVIDERS = Object.freeze(['auto', 'gemini', 'azure']);

/** The two hosts every dialogue script names (script.js DEFAULT_SPEAKERS). */
export const VOICE_SPEAKERS = Object.freeze(['Maya', 'Elena']);

/** The speaker label a single-voice chapter is read under. */
export const NARRATOR_SPEAKER = 'Narrator';

export const SPEAKING_RATE = Object.freeze({ min: 0.5, max: 2, default: 1 });

/** Gemini's own defaults for the two hosts and a narrator (gemini.js). */
export const DEFAULT_VOICE_SETTINGS = Object.freeze({
  provider: 'auto',
  speakers: Object.freeze({ Maya: 'Kore', Elena: 'Leda' }),
  narrator: 'Kore',
  language: 'en-US',
  speakingRate: SPEAKING_RATE.default,
});

/** A voice id as either provider spells one: letters, digits, `-`, `:`, `_`. */
export function isVoiceName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/.test(value);
}

const LANGUAGE_PATTERN = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|-\d{3})?$/;

const isBlank = (value) => value === undefined || value === null || value === '';
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Each field of a voice body is checked by one function returning `{ value }`
// or `{ error }`; `normalizeVoiceSettings` runs them in the order the errors
// used to be reported and answers with the first one (PR #841).

/** A voice id for one field, or null for an absent one. */
function checkVoice(value, field, geminiBound) {
  if (isBlank(value)) return null;
  if (!isVoiceName(value)) return { error: `${field} is not a voice name` };
  if (geminiBound && !GEMINI_VOICE_IDS.includes(value)) {
    return { error: `${field} must be one of the Gemini voices: ${GEMINI_VOICE_IDS.join(', ')}` };
  }
  return { value };
}

function checkProvider(raw) {
  const provider = raw === undefined ? 'auto' : String(raw);
  return VOICE_PROVIDERS.includes(provider)
    ? { value: provider }
    : { error: `voice.provider must be one of ${VOICE_PROVIDERS.join(', ')}` };
}

/** The two hosts' voices, each defaulting to Gemini's when not named. */
function checkSpeakers(raw, geminiBound) {
  const given = isRecord(raw) ? raw : {};
  const speakers = {};
  for (const speaker of VOICE_SPEAKERS) {
    const checked = checkVoice(given[speaker], `voice.speakers.${speaker}`, geminiBound);
    if (checked?.error) return { error: checked.error };
    speakers[speaker] = checked?.value || DEFAULT_VOICE_SETTINGS.speakers[speaker];
  }
  return { value: speakers };
}

function checkNarrator(raw, geminiBound) {
  const checked = checkVoice(raw, 'voice.narrator', geminiBound);
  if (checked?.error) return { error: checked.error };
  return { value: checked?.value || DEFAULT_VOICE_SETTINGS.narrator };
}

function checkLanguage(raw) {
  const language = isBlank(raw) ? DEFAULT_VOICE_SETTINGS.language : String(raw).trim();
  return LANGUAGE_PATTERN.test(language)
    ? { value: language }
    : { error: 'voice.language must be a BCP 47 tag such as en-US' };
}

function checkSpeakingRate(raw) {
  if (isBlank(raw)) return { value: SPEAKING_RATE.default };
  const rate = Number(raw);
  const inRange = Number.isFinite(rate) && rate >= SPEAKING_RATE.min && rate <= SPEAKING_RATE.max;
  return inRange
    ? { value: Math.round(rate * 100) / 100 }
    : { error: `voice.speakingRate must be between ${SPEAKING_RATE.min} and ${SPEAKING_RATE.max}` };
}

/**
 * A book's voice settings from an untrusted body: `{ value }` or `{ error }`.
 * Absent fields take the defaults; a present field must be well formed, and
 * a voice named for Gemini must be one of its thirty — Gemini refuses an
 * unknown voice with an opaque 400, so the refusal happens here, by sentence.
 * A `model` field is ignored, whatever it holds (header): the model is the
 * task's, and a client written before slice 5 still saves its book.
 *
 * @param {unknown} raw
 */
export function normalizeVoiceSettings(raw) {
  if (raw === undefined || raw === null) return { value: { ...DEFAULT_VOICE_SETTINGS } };
  if (!isRecord(raw)) return { error: 'voice must be an object' };

  const provider = checkProvider(raw.provider);
  // Azure accepts any well-formed voice name; everything else is Gemini-bound.
  const geminiBound = provider.value !== 'azure';
  const checks = [
    ['provider', provider],
    ['speakers', checkSpeakers(raw.speakers, geminiBound)],
    ['narrator', checkNarrator(raw.narrator, geminiBound)],
    ['language', checkLanguage(raw.language)],
    ['speakingRate', checkSpeakingRate(raw.speakingRate)],
  ];
  const failed = checks.find(([, checked]) => checked.error);
  if (failed) return { error: failed[1].error };
  return { value: Object.fromEntries(checks.map(([field, checked]) => [field, checked.value])) };
}

/**
 * The voice settings a stored book carries, defaults filled in, never an
 * error: a document written by hand with a bad voice is read as the
 * defaults rather than failing every read of the book.
 */
export function voiceSettingsOf(doc) {
  const parsed = normalizeVoiceSettings(doc?.voice);
  return parsed.value || { ...DEFAULT_VOICE_SETTINGS };
}

/**
 * The arguments `synthesizeDialogue` takes for a book's voice settings and a
 * dialogue's speakers. Hosts get their per-book voices; a narrator chapter
 * gets the narrator voice; `provider: 'auto'` passes no override. The model
 * is not here: it is the task's (header), handed to the switch by the job.
 *
 * @param {ReturnType<typeof voiceSettingsOf>} voice
 * @param {{ narrator?: boolean }} [options]
 */
export function speechArgsFor(voice, { narrator = false } = {}) {
  const settings = voice || DEFAULT_VOICE_SETTINGS;
  return {
    voices: narrator ? { [NARRATOR_SPEAKER]: settings.narrator } : { ...settings.speakers },
    lang: settings.language,
    speakingRate: settings.speakingRate,
    provider: settings.provider === 'auto' ? null : settings.provider,
  };
}
