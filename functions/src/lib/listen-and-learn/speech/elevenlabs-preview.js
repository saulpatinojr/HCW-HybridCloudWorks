/**
 * The preview fetch behind the Podcast voices picker, and the allowlist that
 * keeps it from being an open proxy (#725; ADR 0029 §2a, amended 2026-09-26).
 *
 * Each ElevenLabs voice has a `preview_url` on a third-party host. The site's
 * CSP (`frontend/staticwebapp.config.json`) allows media from 'self' only,
 * and it is not widened for this. So an editor route fetches the preview and
 * hands the bytes to the page, which decodes them with Web Audio.
 *
 * A URL is fetched only when
 *
 *   - it came from the account's own voice listing, never from the caller:
 *     the route takes a voice id and elevenlabs-voices.js looks its preview
 *     up;
 *   - it is `https://storage.googleapis.com/eleven-public-prod/…`, the host
 *     and bucket every `preview_url` in ElevenLabs's reference carries
 *     (https://elevenlabs.io/docs/api-reference/legacy/voices/get-all for a
 *     premade voice, https://elevenlabs.io/docs/api-reference/voices/voice-library/get-shared
 *     for a library one, both read 2026-09-26). The host alone would not do:
 *     that host serves every public bucket on Google Cloud, so the bucket
 *     prefix is part of the allowlist, checked on the parsed,
 *     dot-segment-normalised path;
 *   - it carries no port, credentials, query or fragment.
 *
 * The fetch sends no key (the preview host is public storage, not
 * ElevenLabs's API), refuses redirects, stops reading past
 * `MAX_PREVIEW_BYTES`, and hands back the bytes only if they begin like an
 * MP3.
 */
import { codeShaped, errorCode as failureCode } from '../../http/error-response.js';
import { ElevenLabsSpeechError } from './elevenlabs-account.js';
import { isElevenLabsVoiceId } from './elevenlabs-voice-plan.js';

/** The preview allowlist: exactly this host, and inside this bucket. */
export const PREVIEW_HOST = 'storage.googleapis.com';
export const PREVIEW_PATH_PREFIX = '/eleven-public-prod/';

/** A preview is a few seconds of MP3, a few hundred kilobytes. */
export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

/** `code` for a voice with no preview on the allowlisted host. */
export const PREVIEW_UNAVAILABLE = 'preview_unavailable';

/** `code` for a preview fetch that failed, or answered something it must not. */
export const PREVIEW_FAILED = 'preview_failed';

/** `code` for an id that is not one, or not one this key can list. */
export const VOICE_NOT_LISTED = 'voice_not_listed';

const MAX_URL_LENGTH = 2048;
const PREVIEW_CONTENT_TYPES = [
  /^audio\//i,
  /^application\/octet-stream/i,
  /^binary\/octet-stream/i,
];

/**
 * Every property a preview URL must have, one rule each, so no rule can be
 * lost in a long condition. Applied to the parsed URL, whose `pathname` has
 * had `.` and `..` segments resolved, percent-encoded ones included.
 */
const PREVIEW_URL_RULES = Object.freeze([
  (url) => url.protocol === 'https:',
  (url) => url.hostname === PREVIEW_HOST,
  (url) => url.port === '',
  (url) => url.username === '',
  (url) => url.password === '',
  (url) => url.search === '',
  (url) => url.hash === '',
  (url) => url.pathname.startsWith(PREVIEW_PATH_PREFIX),
  (url) => url.pathname.length > PREVIEW_PATH_PREFIX.length,
]);

/** Whether `value` is a preview URL this module will fetch (see the header). */
export function isAllowedPreviewUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) {
    return false;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return PREVIEW_URL_RULES.every((rule) => rule(url));
}

const previewError = (message, code, status = null) =>
  new ElevenLabsSpeechError(message, { status, code });

const overCap = (limit) =>
  previewError(`The preview is over the ${limit}-byte cap.`, PREVIEW_FAILED, 502);

/** Whether the first bytes are an ID3 tag or an MPEG audio frame sync. */
export function looksLikeMp3(bytes) {
  if (!bytes || bytes.length < 3) return false;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true; // "ID3"
  return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
}

/** A streamed body, read chunk by chunk and cancelled the moment it passes `limit`. */
async function readStream(reader, limit) {
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(parts);
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw overCap(limit);
    }
    parts.push(Buffer.from(value));
  }
}

/** The body, read no further than `limit` bytes. */
async function readCapped(response, limit) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    throw previewError(
      `The preview is ${declared} bytes, over the ${limit}-byte cap.`,
      PREVIEW_FAILED,
      502
    );
  }
  const reader = response.body?.getReader?.();
  if (reader) return readStream(reader, limit);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > limit) throw overCap(limit);
  return bytes;
}

/**
 * A Content-Type header as a sentence may name it: `type/subtype` when both
 * halves have the door's code shape, else a fixed phrase. The header is the
 * host's, so nothing else of it is repeated (#945).
 *
 * @param {string} header - the response's Content-Type
 * @returns {string}
 */
function namedMediaType(header) {
  const [type = '', subtype = ''] = header.split(';')[0].trim().toLowerCase().split('/');
  const a = codeShaped(type);
  const b = codeShaped(subtype);
  return a && b ? `${a}/${b}` : 'an unexpected content type';
}

/**
 * Refuse a response that is not a successful audio answer.
 *
 * @param {Response} response - the preview host's answer
 * @returns {void}
 */
function assertAudioResponse(response) {
  if (!response.ok) {
    throw previewError(`The preview host answered HTTP ${response.status}.`, PREVIEW_FAILED, 502);
  }
  const type = String(response.headers?.get?.('content-type') || '');
  if (type && !PREVIEW_CONTENT_TYPES.some((pattern) => pattern.test(type))) {
    throw previewError(
      `The preview host answered ${namedMediaType(type)}, not audio.`,
      PREVIEW_FAILED,
      502
    );
  }
}

/**
 * The MP3 at `previewUrl`, which must pass the allowlist. It is checked here,
 * at the point of use, whatever the caller already checked: the allowlist is
 * the reason this is not an open proxy.
 *
 * @returns {Promise<{ audio: Buffer, contentType: 'audio/mpeg' }>}
 */
export async function fetchPreviewAudio(previewUrl, { fetchImpl = fetch } = {}) {
  if (!isAllowedPreviewUrl(previewUrl)) {
    throw previewError(
      'ElevenLabs has no preview for this voice on its preview host.',
      PREVIEW_UNAVAILABLE,
      404
    );
  }
  let response;
  try {
    // No key: the preview host is public storage, not ElevenLabs's API, and
    // the key must never travel anywhere else. No redirects: one could leave
    // the allowlist.
    response = await fetchImpl(previewUrl, {
      method: 'GET',
      redirect: 'error',
      headers: { Accept: 'audio/mpeg' },
    });
  } catch (err) {
    throw previewError(
      `Could not fetch the preview (${failureCode(err?.cause ?? err)}).`,
      PREVIEW_FAILED,
      502
    );
  }
  assertAudioResponse(response);
  const audio = await readCapped(response, MAX_PREVIEW_BYTES);
  if (!looksLikeMp3(audio)) {
    throw previewError('The preview host answered something that is not MP3.', PREVIEW_FAILED, 502);
  }
  return { audio, contentType: 'audio/mpeg' };
}

/**
 * One voice's preview, looked up in the key's own listing: the voice must be
 * in it, and the URL the listing holds must still pass the allowlist. The
 * caller supplies an id, never a URL. `listVoices` is elevenlabs-voices.js's
 * `readVoices`, passed in so this module need not import the listing.
 *
 * @returns {Promise<{ audio: Buffer, contentType: 'audio/mpeg' }>}
 */
export async function fetchListedPreview({
  key,
  voiceId,
  fetchImpl = fetch,
  sleep,
  now,
  listVoices,
}) {
  if (!isElevenLabsVoiceId(voiceId)) {
    throw previewError('That is not an ElevenLabs voice id.', VOICE_NOT_LISTED, 400);
  }
  const { voices, previews } = await listVoices({ key, fetchImpl, sleep, now });
  if (!voices.some((voice) => voice.voiceId === voiceId)) {
    throw previewError(
      'That voice is not one this ElevenLabs key can list.',
      VOICE_NOT_LISTED,
      404
    );
  }
  return fetchPreviewAudio(previews.get(voiceId), { fetchImpl });
}
