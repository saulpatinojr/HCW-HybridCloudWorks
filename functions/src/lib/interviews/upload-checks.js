/**
 * interviews/upload-checks.js — the checks of an interview audio upload
 * (interviews/upload.js has the routes and the header that explains the
 * upload): the open request's body, a stored session, the blocks' ids and
 * lengths, and the audio paths this module may name. Pure; upload.js
 * re-exports what callers use.
 */
import {
  AUDIO_TYPES,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_SECONDS,
  audioBlobPath,
  canonicalAudioType,
} from './storage.js';
import { isValidBlobPath } from '../blob-paths.js';

/** Bytes per block: the browser slices at this, and no request is larger. */
export const BLOCK_SIZE = 4 * 1024 * 1024;

/** The most blocks a file at the cap takes; bounds the index and the id width. */
export const MAX_BLOCK_COUNT = Math.ceil(MAX_AUDIO_BYTES / BLOCK_SIZE);

/** The content document's container, partitioned by `/id` like every item. */
export const CONTENT_CONTAINER = 'content';

/** Metadata `source` on the committed blob, so a listing says who wrote it. */
export const UPLOAD_SOURCE = 'interview-upload';

/**
 * Open sessions a document keeps at once. A browser that lost its tab opens
 * a new one and the oldest falls off; the blocks it staged are dropped by
 * Storage a week after the last Put Block.
 */
export const MAX_OPEN_SESSIONS = 4;

/** Interview ids become a blob path segment; one character class, bounded. */
export const INTERVIEW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** The upload id the route carries: a v4 UUID this module minted, nothing else. */
export const UPLOAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One or more digits, no sign, no decimals; the range check comes after. */
export const INDEX_PATTERN = /^\d{1,4}$/;

/**
 * The block id Storage sees for an index: base64 of the zero-padded index,
 * so every id of one blob has the same length (a Put Block List rule) and
 * sorts in content order. Six digits leaves room well past MAX_BLOCK_COUNT.
 *
 * @param {number} index
 * @returns {string}
 */
export function blockIdFor(index) {
  return Buffer.from(String(index).padStart(6, '0'), 'ascii').toString('base64');
}

/**
 * How long block `index` of a `bytes`-long file must be: a full block, or
 * the remainder for the last one. The declared size fixes every length, so a
 * block that is short or long is refused before it is staged.
 *
 * @param {number} bytes
 * @param {number} index
 * @param {number} [blockSize]
 * @returns {number}
 */
export function blockLengthFor(bytes, index, blockSize = BLOCK_SIZE) {
  const count = Math.ceil(bytes / blockSize);
  return index < count - 1 ? blockSize : bytes - (count - 1) * blockSize;
}

function extensionOf(fileName) {
  const segment = String(fileName || '')
    .split(/[\\/]/)
    .pop();
  const dot = segment.lastIndexOf('.');
  if (dot <= 0 || dot === segment.length - 1) return '';
  return segment.slice(dot + 1).toLowerCase();
}

/**
 * Validate the body that opens an upload.
 *
 * @param {unknown} body
 * @returns {{ error: string } | { value: { interviewId: string, contentType: string, ext: string, bytes: number, sha256: string } }}
 *   `error` is a sentence written here, never an error's message.
 */
export function parseOpenBody(body) {
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!raw) return { error: 'Body must be a JSON object' };

  const interviewId = typeof raw.interviewId === 'string' ? raw.interviewId.trim() : '';
  if (!INTERVIEW_ID_PATTERN.test(interviewId)) return { error: 'interviewId is required' };

  const file = fileRefusal(raw);
  if (file.error) return file;
  const { contentType, ext, bytes, sha256 } = file;
  const durationRefusal = durationRefusalOf(raw.durationSec);
  if (durationRefusal) return durationRefusal;
  return { value: { interviewId, contentType, ext, bytes, sha256, durationSec: raw.durationSec } };
}

/** The declared file, checked: `{ contentType, ext, bytes, sha256 }`, or `{ error }`. */
function fileRefusal(raw) {
  // Alias spellings (audio/mp3, audio/x-m4a, ...) fold to the canonical type
  // before the type and extension checks (ADR 0040 D1). Strings only: an
  // object whose toString is null would throw inside String() and turn a bad
  // body into a 500.
  const contentType = typeof raw.contentType === 'string' ? canonicalAudioType(raw.contentType) : null;
  if (!contentType) {
    return { error: `Unsupported audio type; send an ${Object.values(AUDIO_TYPES).join(', ')} file` };
  }
  const ext = AUDIO_TYPES[contentType];
  if (typeof raw.fileName !== 'string' || extensionOf(raw.fileName) !== ext) {
    return { error: 'File extension does not match the declared audio type' };
  }
  const bytesRefusal = bytesRefusalOf(raw.bytes);
  if (bytesRefusal) return { error: bytesRefusal };
  const sha256 = typeof raw.sha256 === 'string' ? raw.sha256.trim().toLowerCase() : '';
  if (!SHA256_PATTERN.test(sha256)) return { error: 'sha256 must be the 64-character hex digest of the file' };
  return { contentType, ext, bytes: raw.bytes, sha256 };
}

/** Why a declared size cannot be uploaded, or null. */
function bytesRefusalOf(bytes) {
  if (!Number.isInteger(bytes) || bytes < 1) return 'bytes must be a whole number of bytes, at least 1';
  if (bytes > MAX_AUDIO_BYTES) return `File exceeds the ${Math.round(MAX_AUDIO_BYTES / 1024 / 1024)} MiB upload limit`;
  return null;
}

/**
 * The browser reads the duration from the file's metadata; a file whose
 * duration cannot be read is refused, and one longer than Gemini takes in
 * one prompt (MAX_AUDIO_SECONDS) is refused with TOO_LONG before a byte is
 * stored. Both are 422: the request is well formed, the file is not fit.
 */
function durationRefusalOf(durationSec) {
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= 0) {
    return {
      error: 'durationSec is required: the length of the recording in seconds',
      code: 'DURATION_REQUIRED',
      status: 422,
    };
  }
  if (durationSec > MAX_AUDIO_SECONDS) {
    return {
      error: `The recording is longer than ${MAX_AUDIO_SECONDS} seconds (9.5 hours), the most one transcription can take`,
      code: 'TOO_LONG',
      status: 422,
    };
  }
  return null;
}

/**
 * Whether a session read back from the document is one this module wrote.
 *
 * The session is trusted at use, and the document it sits on can be edited
 * through the generic content update route by the same role, so every field
 * the block and complete paths rely on is re-derived here from the document
 * id, the session's own id and the three constants rather than taken on
 * faith: a session whose path, type, extension, size or block plan is not
 * exactly what `openUpload` would have minted is treated as absent (404).
 * Exported for its test.
 *
 * @param {{ id: string }} doc
 * @param {object} session
 * @returns {boolean}
 */
export function isSoundSession(doc, session) {
  if (!session || typeof session !== 'object') return false;
  const { uploadId, contentType, ext, path } = session;
  if (!hasSoundIds(doc, uploadId)) return false;
  if (canonicalAudioType(contentType) !== contentType || AUDIO_TYPES[contentType] !== ext) return false;
  if (!isSoundSize(session)) return false;
  return isSoundPath(path, doc.id, uploadId, ext) && SHA256_PATTERN.test(String(session.sha256 || ''));
}

/** The blob path is the one this module mints for this interview and upload, and a valid one. */
const isSoundPath = (path, interviewId, uploadId, ext) =>
  path === audioBlobPath(interviewId, uploadId, ext) && isValidBlobPath(path);

/** The interview's id and the session's upload id are both ones this module could have used. */
const hasSoundIds = (doc, uploadId) =>
  INTERVIEW_ID_PATTERN.test(String(doc?.id || '')) && UPLOAD_ID_PATTERN.test(String(uploadId || ''));

/** A session's size, duration and blocks are ones this module could have written. */
function isSoundSize({ bytes, blockSize, blockCount, durationSec }) {
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > MAX_AUDIO_BYTES) return false;
  if (typeof durationSec !== 'number' || !(durationSec > 0) || durationSec > MAX_AUDIO_SECONDS) return false;
  return blockSize === BLOCK_SIZE && blockCount === Math.ceil(bytes / BLOCK_SIZE);
}

/**
 * Whether a blob path is one this module could have minted for this
 * interview: `audio/<interviewId>/<uploadId>.<ext>` with a UUID and one of
 * the three extensions. Used before a path read back from the document is
 * carried into `superseded`. Exported for its test.
 *
 * @param {string} interviewId
 * @param {unknown} path
 * @returns {boolean}
 */
export function ownsAudioPath(interviewId, path) {
  if (typeof path !== 'string' || !INTERVIEW_ID_PATTERN.test(String(interviewId || ''))) return false;
  const prefix = `audio/${interviewId}/`;
  if (!path.startsWith(prefix) || !isValidBlobPath(path)) return false;
  const rest = path.slice(prefix.length);
  const dot = rest.lastIndexOf('.');
  if (dot <= 0) return false;
  const uploadId = rest.slice(0, dot);
  const ext = rest.slice(dot + 1);
  return UPLOAD_ID_PATTERN.test(uploadId) && Object.values(AUDIO_TYPES).includes(ext);
}

export function readContentLength(request) {
  const raw = request?.headers?.get?.('content-length');
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isInteger(parsed) && parsed >= 0 && String(parsed) === String(raw).trim() ? parsed : NaN;
}

/**
 * Whether the interview's deletion has started. The delete hook (slice C)
 * first writes `provenance.audio.deletedAt` under the document's ETag, then
 * sweeps the interview's whole `audio/<interviewId>/` prefix (ADR 0040 D10).
 * Every route here refuses a tombstoned document with 409 INTERVIEW_DELETED
 * before it stores anything, and a completion that read the document before
 * the tombstone loses its ETag write and deletes the blob it committed.
 *
 * @param {object|null|undefined} doc
 * @returns {boolean}
 */
export function isTombstoned(doc) {
  const at = doc?.provenance?.audio?.deletedAt;
  return typeof at === 'string' ? at.length > 0 : Boolean(at);
}
