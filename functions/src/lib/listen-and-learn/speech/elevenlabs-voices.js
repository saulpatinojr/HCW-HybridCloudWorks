/**
 * The ElevenLabs voices this key may use, for the owner to pick the two
 * podcast hosts by ear (#725; ADR 0029 §2a, amended 2026-09-26 twice).
 *
 * Written after the owner's first live check on the free plan was refused:
 * "Free users cannot use library voices via the API" (402
 * `paid_plan_required`). The code's defaults, Sarah and Aria, are Default and
 * Legacy voices that an account created in March 2026 or later does not have,
 * so for that account they are library voices. Choosing voices by id from a
 * help page is what went wrong; this module lists what the account itself
 * says it has. Which of those the plan allows is elevenlabs-voice-plan.js;
 * fetching a preview safely is elevenlabs-preview.js.
 *
 * ## The listing
 *
 * `GET https://api.elevenlabs.io/v2/voices`
 * (https://elevenlabs.io/docs/api-reference/voices/search, read 2026-09-26).
 * `/v1/voices` is filed under "Legacy" in the same reference, so v2 it is.
 * Paginated with `page_size` (at most 100) and the `next_page_token` /
 * `has_more` pair, which the reference says to rely on rather than
 * `total_count`; `include_total_count=false` because that count "incurs a
 * performance cost" and nothing here shows it.
 *
 * **What tells default, own and library voices apart.** The voice object
 * carries no single "type" field. The listing's `voice_type` filter is the
 * documented classifier: `default`, `personal`, `workspace` and `community`,
 * where "'non-community' is equal to 'personal' and 'workspace' combined
 * (excludes library copies)" (the search reference above; the filter value
 * was added 2026-04-13, https://elevenlabs.io/docs/changelog/2026/4/13). So
 * the account is listed three times, `default`, `non-community` and
 * `community`, and each voice is labelled by the listing that returned it
 * rather than guessed from `category` or `is_owner`.
 *
 * **Permission.** A restricted key needs **Voices → Read** (`voices_read`,
 * named in https://elevenlabs.io/docs/api-reference/service-accounts/api-keys/list)
 * for the listing. It is a third permission beside the two the podcast
 * already needed; without it the listing answers 401 or 403 and the sentence
 * says which permission to add, and where.
 *
 * ## The cache
 *
 * One listing per key for `VOICES_CACHE_TTL_MS`, in process memory, keyed the
 * way the subscription cache is (see "Cache keying" in elevenlabs-account.js).
 * A picker that plays a dozen previews reads the account once. Which voices
 * are usable is worked out per request from the plan, so an upgrade shows at
 * once. The preview URLs stay server-side; the page only learns whether a
 * voice has one.
 */
import {
  API_KEYS_PAGE,
  ElevenLabsSpeechError,
  errorCode,
  isPermissionAnswer,
  isRetryableStatus,
} from './elevenlabs-account.js';
import { errorCode as failureCode } from '../../http/error-response.js';
import { fetchListedPreview, isAllowedPreviewUrl } from './elevenlabs-preview.js';

// One import surface for the routes and the picker's tests.
export {
  MAX_PREVIEW_BYTES,
  PREVIEW_FAILED,
  PREVIEW_HOST,
  PREVIEW_PATH_PREFIX,
  PREVIEW_UNAVAILABLE,
  VOICE_NOT_LISTED,
  isAllowedPreviewUrl,
  looksLikeMp3,
} from './elevenlabs-preview.js';
export {
  FREE_PLAN_RULE,
  VOICE_ID_PATTERN,
  isElevenLabsVoiceId,
  voiceUsability,
  voicesForPlan,
} from './elevenlabs-voice-plan.js';

export const VOICES_URL = 'https://api.elevenlabs.io/v2/voices';

/** The permission a restricted key needs to list voices. */
export const VOICES_PERMISSION = 'voices_read';

/** Long enough for a picking session; short enough that a new voice shows soon. */
export const VOICES_CACHE_TTL_MS = 5 * 60_000;

/** The documented maximum page size. */
export const VOICES_PAGE_SIZE = 100;

/** Pages per listing. 500 voices of one type is more than any account here holds. */
export const MAX_VOICE_PAGES = 5;

/**
 * `voice_type` → how the page names it. In this order: a voice that somehow
 * came back from two listings keeps the first, most permissive label.
 */
export const VOICE_LISTINGS = Object.freeze([
  Object.freeze({ voiceType: 'default', type: 'default' }),
  Object.freeze({ voiceType: 'non-community', type: 'own' }),
  Object.freeze({ voiceType: 'community', type: 'library' }),
]);

/** `code` for a listing that could not be read. */
export const VOICES_UNAVAILABLE = 'voices_unavailable';

const MAX_ATTEMPTS = 3;
const MAX_LABEL_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 300;

const voicesError = (reason, status = null) =>
  new ElevenLabsSpeechError(`Could not list the ElevenLabs voices (${reason}).`, {
    status,
    code: VOICES_UNAVAILABLE,
  });

/** The sentence for a non-2xx listing answer. Names the fix; never the key. */
function listingRefusal(status, text) {
  const code = errorCode(text);
  const label = `HTTP ${status}${code ? ` ${code}` : ''}`;
  if (isPermissionAnswer(status, text)) {
    return voicesError(
      `${label}: the key needs the Voices → Read permission (${VOICES_PERMISSION}), set at ${API_KEYS_PAGE}`,
      status
    );
  }
  if (status === 401) return voicesError(`${label}: ElevenLabs rejected the key`, status);
  return voicesError(label, status);
}

function pageUrl(voiceType, pageToken) {
  const params = new URLSearchParams({
    page_size: String(VOICES_PAGE_SIZE),
    voice_type: voiceType,
    include_total_count: 'false',
  });
  if (pageToken) params.set('next_page_token', pageToken);
  return `${VOICES_URL}?${params.toString()}`;
}

/** A 2xx answer's JSON, or the refusal for one that is not. */
async function pageBody(response) {
  const text = await response.text().catch(() => '');
  if (!response.ok) return { refusal: listingRefusal(response.status, text) };
  try {
    return { body: JSON.parse(text) };
  } catch {
    throw voicesError('the answer was not JSON', response.status);
  }
}

/** One page, retried on 429 and 5xx as every other ElevenLabs read here is. */
async function fetchPage({ key, voiceType, pageToken, fetchImpl, sleep }) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(pageUrl(voiceType, pageToken), {
        method: 'GET',
        headers: { 'xi-api-key': key, Accept: 'application/json' },
      });
    } catch (err) {
      lastError = voicesError(`could not reach ElevenLabs (${failureCode(err?.cause ?? err)})`);
      if (attempt === MAX_ATTEMPTS) throw lastError;
      await sleep(attempt * 500);
      continue;
    }
    const { body, refusal } = await pageBody(response);
    if (!refusal) return body;
    lastError = refusal;
    if (!isRetryableStatus(response.status) || attempt === MAX_ATTEMPTS) throw lastError;
    await sleep(attempt * 500);
  }
  throw lastError;
}

/** Every page of one `voice_type`, up to MAX_VOICE_PAGES; `truncated` when more remained. */
async function fetchListing({ key, voiceType, fetchImpl, sleep }) {
  const voices = [];
  let pageToken = null;
  for (let page = 0; page < MAX_VOICE_PAGES; page += 1) {
    const body = await fetchPage({ key, voiceType, pageToken, fetchImpl, sleep });
    if (!Array.isArray(body?.voices)) throw voicesError('the answer carried no voices list');
    voices.push(...body.voices);
    pageToken = typeof body.next_page_token === 'string' ? body.next_page_token : null;
    if (body.has_more !== true || !pageToken) return { voices, truncated: false };
  }
  return { voices, truncated: true };
}

const boundedText = (value, max) => {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
};

const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * The labels the page shows. ElevenLabs's labels are free-form strings; older
 * voices spell the use case `use case`, newer ones `use_case`.
 */
function presentLabels(labels) {
  const raw = isPlainObject(labels) ? labels : {};
  const read = (...names) =>
    names.map((name) => boundedText(raw[name], MAX_LABEL_LENGTH)).find(Boolean) ?? null;
  return {
    gender: read('gender'),
    accent: read('accent'),
    age: read('age'),
    description: read('description', 'descriptive'),
    useCase: read('use_case', 'use case'),
  };
}

/** `available_for_tiers` as trimmed, non-empty strings. */
const presentTiers = (tiers) =>
  (Array.isArray(tiers) ? tiers : [])
    .filter((tier) => typeof tier === 'string' && tier.trim())
    .map((tier) => tier.trim());

/** One raw voice → what the page is told, plus the preview URL kept here. */
function presentVoice(raw, type) {
  const voiceId = typeof raw?.voice_id === 'string' ? raw.voice_id.trim() : '';
  const previewUrl = isAllowedPreviewUrl(raw?.preview_url) ? raw.preview_url : null;
  return {
    voice: {
      voiceId,
      name: boundedText(raw?.name, MAX_LABEL_LENGTH) || voiceId,
      category: boundedText(raw?.category, MAX_LABEL_LENGTH),
      type,
      labels: presentLabels(raw?.labels),
      description: boundedText(raw?.description, MAX_DESCRIPTION_LENGTH),
      legacy: raw?.is_legacy === true,
      tiers: presentTiers(raw?.available_for_tiers),
      hasPreview: previewUrl !== null,
    },
    previewUrl,
  };
}

/**
 * Add one listing's voices to `collected`, labelled `type`. A voice already
 * collected keeps its first label, and a voice with no id is dropped.
 */
function addVoices(collected, rawVoices, type) {
  const seen = new Set(collected.voices.map((voice) => voice.voiceId));
  for (const raw of rawVoices) {
    const { voice, previewUrl } = presentVoice(raw, type);
    if (!voice.voiceId || seen.has(voice.voiceId)) continue;
    seen.add(voice.voiceId);
    collected.voices.push(voice);
    if (previewUrl) collected.previews.set(voice.voiceId, previewUrl);
  }
}

/** key → { voices, previews, truncated, expiresAt }. */
const cache = new Map();

/** Drop every cached listing. For tests. */
export function clearVoicesCache() {
  cache.clear();
}

/**
 * The account's voices, labelled by type, from the three listings. Cached.
 *
 * @returns {Promise<{ voices: object[], previews: Map<string,string>, truncated: boolean }>}
 */
export async function readVoices({
  key,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  useCache = true,
} = {}) {
  if (!key) throw voicesError('ELEVENLABS_API_KEY is not configured');
  const hit = useCache ? cache.get(key) : null;
  if (hit && hit.expiresAt > now()) return hit;

  const collected = { voices: [], previews: new Map(), truncated: false };
  // Sequential, like the dialogue requests: three small reads, and a burst
  // is the reliable way to meet the per-account 429.
  for (const { voiceType, type } of VOICE_LISTINGS) {
    const listing = await fetchListing({ key, voiceType, fetchImpl, sleep });
    collected.truncated ||= listing.truncated;
    addVoices(collected, listing.voices, type);
  }

  const value = { ...collected, expiresAt: now() + VOICES_CACHE_TTL_MS };
  cache.set(key, value);
  return value;
}

/**
 * The voice names this key's cached listing holds, by id; empty when no
 * listing is cached or it has expired. It reads the cache only and never
 * lists, so it sends nothing to ElevenLabs. The live check's record keeps the
 * names when they are at hand this way (podcast/elevenlabs-admin.js).
 *
 * @returns {Map<string, string>}
 */
export function cachedVoiceNames(key, now = Date.now) {
  const hit = key ? cache.get(key) : null;
  if (!hit || hit.expiresAt <= now()) return new Map();
  return new Map(hit.voices.map((voice) => [voice.voiceId, voice.name]));
}

/**
 * One voice's preview, as MP3 bytes, looked up in this key's listing (see
 * `fetchListedPreview` in elevenlabs-preview.js). The caller supplies an id,
 * never a URL.
 *
 * @returns {Promise<{ audio: Buffer, contentType: 'audio/mpeg' }>}
 */
export const fetchVoicePreview = (params) =>
  fetchListedPreview({ listVoices: readVoices, ...params });
