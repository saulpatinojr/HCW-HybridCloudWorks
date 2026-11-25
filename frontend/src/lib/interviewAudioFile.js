/**
 * The file checks for an interview recording, run in the browser before any
 * upload starts: its type, extension, size and length. Split out of
 * interviewUpload.js, which re-exports everything here and explains the
 * whole upload in its header. The server checks all of it again.
 */

/** The server's MAX_AUDIO_BYTES. */
export const MAX_AUDIO_BYTES = 500 * 1024 * 1024;
/** The server's MAX_AUDIO_SECONDS: Gemini's 9.5 hours per prompt. */
export const MAX_AUDIO_SECONDS = 34_200;

/**
 * The three canonical types and their extensions, and the alias spellings
 * that fold to them. Copied from functions/src/lib/interviews/storage.js;
 * interviewUpload.test.js reads that file and fails if the two drift.
 */
export const AUDIO_TYPES = Object.freeze({
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
});

export const AUDIO_TYPE_ALIASES = Object.freeze({
  'audio/mp3': 'audio/mpeg',
  'audio/x-mp3': 'audio/mpeg',
  'audio/mpeg3': 'audio/mpeg',
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
});

/** The canonical type for a declared one, or null when it is not one of the three. */
export function canonicalAudioType(contentType) {
  const base = String(contentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const type = AUDIO_TYPE_ALIASES[base] || base;
  return Object.hasOwn(AUDIO_TYPES, type) ? type : null;
}

/** A file name's extension, lower case, or ''. */
export function extensionOf(fileName) {
  const segment = String(fileName || '')
    .split(/[\\/]/)
    .pop();
  const dot = segment.lastIndexOf('.');
  if (dot <= 0 || dot === segment.length - 1) return '';
  return segment.slice(dot + 1).toLowerCase();
}

/**
 * The type the upload declares for a file: its own type when the browser
 * gave one, or the type its extension names when the browser gave none (some
 * systems leave `.m4a` untyped).
 *
 * @param {{ name?: string, type?: string }} file
 * @returns {string | null}
 */
export function audioTypeOf(file) {
  const declared = canonicalAudioType(file?.type);
  if (declared) return declared;
  if (file?.type) return null;
  const ext = extensionOf(file?.name);
  const byExtension = Object.entries(AUDIO_TYPES).find(([, value]) => value === ext);
  return byExtension ? byExtension[0] : null;
}

/** An error with a code the page can key on, and a sentence it can show. */
export class UploadError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'UploadError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * Why this file cannot be uploaded, or '' when it can. Size, type and
 * extension; the length is checked separately once it is read.
 *
 * @param {{ name?: string, type?: string, size?: number } | null | undefined} file
 * @returns {string}
 */
export function audioFileProblem(file) {
  if (!file) return 'Choose a recording.';
  const type = audioTypeOf(file);
  if (!type) return 'Choose an MP3, M4A or WAV recording.';
  if (extensionOf(file.name) !== AUDIO_TYPES[type]) {
    return `The file name should end in .${AUDIO_TYPES[type]} for this kind of recording. Rename it and choose it again.`;
  }
  return sizeProblem(file.size);
}

function sizeProblem(bytes) {
  const size = Number(bytes);
  if (!Number.isInteger(size) || size < 1) return 'The recording is empty.';
  if (size > MAX_AUDIO_BYTES) return 'Recordings must be 500 MB or smaller.';
  return '';
}

/**
 * Why a recording of this length cannot be uploaded, or '' when it can.
 *
 * @param {number | null | undefined} seconds
 * @returns {string}
 */
export function durationProblem(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return 'The length of this recording could not be read. Save it again as MP3, M4A or WAV and choose it again.';
  }
  if (seconds > MAX_AUDIO_SECONDS) {
    return `This recording is ${formatDuration(seconds)} long; the most one transcription can take is 9 hours 30 minutes. Split it and add each part as its own interview.`;
  }
  return '';
}

/** `1 h 05 min`, `12 min 30 s` or `45 s`, for the form. */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m > 0) return `${m} min ${String(s).padStart(2, '0')} s`;
  return `${s} s`;
}

/**
 * The recording's length in seconds, as the browser reads it from the file's
 * headers through an `<audio>` element. Rejects with `DURATION_UNREADABLE`
 * when the browser cannot read it within the timeout or reports a length that
 * is not a positive finite number.
 *
 * @param {Blob} file
 * @param {{ createAudio?: () => HTMLAudioElement, timeoutMs?: number }} [deps]
 * @returns {Promise<number>}
 */
export function readAudioDuration(
  file,
  { createAudio = () => document.createElement('audio'), timeoutMs = 20000 } = {}
) {
  return new Promise((resolve, reject) => {
    let url = '';
    let timer = null;
    const audio = createAudio();
    const finish = (error, seconds) => {
      clearTimeout(timer);
      audio.onloadedmetadata = null;
      audio.onerror = null;
      try {
        audio.removeAttribute?.('src');
        if (url) URL.revokeObjectURL(url);
      } catch {
        // releasing the object URL is housekeeping, never a reason to fail
      }
      if (error) reject(error);
      else resolve(seconds);
    };
    const unreadable = () => finish(new UploadError(durationProblem(null), 'DURATION_UNREADABLE'));
    timer = setTimeout(unreadable, timeoutMs);
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      const seconds = Number(audio.duration);
      if (Number.isFinite(seconds) && seconds > 0) finish(null, seconds);
      else unreadable();
    };
    audio.onerror = unreadable;
    try {
      url = URL.createObjectURL(file);
      audio.src = url;
    } catch {
      unreadable();
    }
  });
}
