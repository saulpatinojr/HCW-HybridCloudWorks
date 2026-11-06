/**
 * interviewUpload.js — the browser half of the interview recording upload
 * (ADR 0040, D1 and D7; issue #1565).
 *
 * The server half is functions/src/lib/interviews/upload.js:
 *
 *   POST cms/interviews/uploads { interviewId, fileName, contentType, bytes, sha256, durationSec }
 *        → { uploadId, blockSize, blockCount }
 *   PUT  cms/interviews/uploads/{uploadId}/blocks/{index}   one raw 4 MiB body each
 *   POST cms/interviews/uploads/{uploadId}/complete         → { ok, bytes, sha256, contentType }
 *
 * What happens here, in order:
 *
 *   1. The file is checked: one of three audio types (the same alias
 *      spellings the server folds), an extension that agrees with the type,
 *      1 byte to 500 MiB. The server checks all of it again; this is so a
 *      wrong file is refused in a sentence before minutes of work.
 *   2. Its length in seconds is read by the browser from the file's own
 *      headers (`readAudioDuration`). A file whose length cannot be read is
 *      refused (the server would answer DURATION_REQUIRED), and one longer
 *      than 9.5 hours is refused here with TOO_LONG before a byte is sent.
 *   3. Its SHA-256 is computed over the same 4 MiB slices the upload sends,
 *      one slice in memory at a time (lib/sha256.js). If hashing fails the
 *      upload fails: there is no empty-hash fallback, because the server
 *      would refuse the session and the owner would see the wrong reason.
 *   4. The session is opened, and the blocks go up three at a time. A block
 *      that fails on the network or with a 5xx or 429 is re-sent alone, up to
 *      three attempts; any other refusal stops the upload. A block is
 *      idempotent (the same index overwrites itself), so a re-send is safe.
 *   5. The session is completed, and the server checks size and hash.
 *
 * Resuming. `createAudioUpload` returns an object whose `run()` remembers
 * which blocks the server acknowledged. After a failure, calling `run()` again
 * keeps the same session and sends only the blocks that are missing, then
 * completes. A closed tab loses that memory: the owner picks the file again
 * on the interview's page and a new session starts (the ADR's first version;
 * uncommitted blocks expire in Storage after a week).
 *
 * Stops for good, without retry, on `INTERVIEW_DELETED` (409): the interview
 * is being deleted, and sending more would only be refused.
 *
 * Nothing here logs. The file name goes to the server once, in the open body,
 * because the server checks its extension.
 */
import { postJSON, putBytes } from '@/lib/api';
import { Sha256 } from '@/lib/sha256';

/** Bytes per block; the server's BLOCK_SIZE. */
export const BLOCK_SIZE = 4 * 1024 * 1024;
/** The server's MAX_AUDIO_BYTES. */
export const MAX_AUDIO_BYTES = 500 * 1024 * 1024;
/** The server's MAX_AUDIO_SECONDS: Gemini's 9.5 hours per prompt. */
export const MAX_AUDIO_SECONDS = 34_200;
/** Blocks in flight at once. */
export const PARALLEL_BLOCKS = 3;
/** Attempts per block, the first included. */
export const BLOCK_ATTEMPTS = 3;

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
  const size = Number(file.size);
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

/** The byte range of block `index`. */
export function blockRange(size, index, blockSize = BLOCK_SIZE) {
  const start = index * blockSize;
  return [start, Math.min(size, start + blockSize)];
}

/** A slice's bytes. `Blob.arrayBuffer` where it exists, a FileReader where it does not. */
function readSlice(blob) {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * The file's SHA-256 as hex, read one 4 MiB slice at a time. Rejects with
 * `HASH_FAILED` when a slice cannot be read; never resolves to ''.
 *
 * @param {Blob} file
 * @param {{ onProgress?: (done: number, total: number) => void, signal?: AbortSignal, blockSize?: number }} [options]
 * @returns {Promise<string>}
 */
export async function hashFile(file, { onProgress, signal, blockSize = BLOCK_SIZE } = {}) {
  const digest = new Sha256();
  const size = Number(file?.size) || 0;
  const count = Math.max(1, Math.ceil(size / blockSize));
  try {
    for (let index = 0; index < count; index += 1) {
      if (signal?.aborted) throw new UploadError('The upload was stopped.', 'ABORTED');
      const [start, end] = blockRange(size, index, blockSize);
      digest.update(new Uint8Array(await readSlice(file.slice(start, end))));
      onProgress?.(end, size);
    }
    const hex = digest.hex();
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('bad digest');
    return hex;
  } catch (error) {
    if (error instanceof UploadError) throw error;
    throw new UploadError(
      'The recording could not be read to check it. Choose the file again and retry.',
      'HASH_FAILED'
    );
  }
}

/** Whether a failed block is worth sending again: the network, a 5xx, or 429. */
export function isRetryable(error) {
  if (error?.code === 'INTERVIEW_DELETED' || error?.code === 'ABORTED') return false;
  const status = Number(error?.status);
  if (!Number.isInteger(status)) return true;
  return status === 429 || status >= 500;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The sentence and code for a refusal that ends the upload. */
function stopped(error) {
  if (error instanceof UploadError) return error;
  if (error?.code === 'INTERVIEW_DELETED') {
    return new UploadError(
      'This interview is being deleted, so the recording was not kept. Nothing more will be sent.',
      'INTERVIEW_DELETED',
      { status: error.status }
    );
  }
  return new UploadError(
    error?.message || 'The upload failed.',
    error?.code || 'UPLOAD_FAILED',
    error?.status ? { status: error.status } : {}
  );
}

/**
 * One upload of one file to one interview, resumable while the page is open.
 *
 * @param {object} args
 * @param {string} args.interviewId
 * @param {File} args.file
 * @param {number} args.durationSec - read with `readAudioDuration`
 * @param {(progress: { phase: 'hashing'|'uploading'|'completing'|'done', done: number, total: number }) => void} [args.onProgress]
 * @param {{ postJSON?: Function, putBytes?: Function, wait?: (ms: number) => Promise<void> }} [args.deps]
 */
export function createAudioUpload({ interviewId, file, durationSec, onProgress, deps = {} }) {
  const post = deps.postJSON || postJSON;
  const put = deps.putBytes || putBytes;
  const wait = deps.wait || pause;
  const state = { sha256: '', session: null, acknowledged: new Set(), completed: null };
  const report = (phase, done, total) => onProgress?.({ phase, done, total });

  async function sendBlock(index, signal) {
    const [start, end] = blockRange(file.size, index, state.session.blockSize);
    for (let attempt = 1; ; attempt += 1) {
      if (signal?.aborted) throw new UploadError('The upload was stopped.', 'ABORTED');
      try {
        const body = await readSlice(file.slice(start, end));
        await put(`cms/interviews/uploads/${state.session.uploadId}/blocks/${index}`, body, {
          signal,
        });
        return;
      } catch (error) {
        if (attempt >= BLOCK_ATTEMPTS || !isRetryable(error)) throw error;
        await wait(1000 * attempt);
      }
    }
  }

  async function sendMissingBlocks(signal) {
    const { blockCount } = state.session;
    const queue = [];
    for (let i = 0; i < blockCount; i += 1) if (!state.acknowledged.has(i)) queue.push(i);
    let failure = null;
    const doneBytes = () =>
      [...state.acknowledged].reduce((sum, i) => {
        const [s, e] = blockRange(file.size, i, state.session.blockSize);
        return sum + (e - s);
      }, 0);
    report('uploading', doneBytes(), file.size);
    const worker = async () => {
      while (queue.length > 0 && !failure) {
        const index = queue.shift();
        try {
          await sendBlock(index, signal);
          state.acknowledged.add(index);
          report('uploading', doneBytes(), file.size);
        } catch (error) {
          failure = failure || error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL_BLOCKS, queue.length) }, worker));
    if (failure) throw failure;
  }

  return {
    state,
    /**
     * Run the upload, or resume it after a failure. Resolves to the server's
     * completion answer.
     *
     * @param {{ signal?: AbortSignal }} [options]
     */
    async run({ signal } = {}) {
      if (state.completed) return state.completed;
      try {
        const problem = audioFileProblem(file) || durationProblem(durationSec);
        if (problem) {
          const code = durationSec > MAX_AUDIO_SECONDS ? 'TOO_LONG' : 'INVALID_FILE';
          throw new UploadError(problem, code);
        }
        if (!state.sha256) {
          state.sha256 = await hashFile(file, {
            signal,
            onProgress: (done, total) => report('hashing', done, total),
          });
        }
        if (!state.session) {
          const opened = await post('cms/interviews/uploads', {
            interviewId,
            fileName: file.name,
            contentType: audioTypeOf(file),
            bytes: file.size,
            sha256: state.sha256,
            durationSec,
          });
          const expected = Math.ceil(file.size / BLOCK_SIZE);
          if (
            typeof opened?.uploadId !== 'string' ||
            opened.blockSize !== BLOCK_SIZE ||
            opened.blockCount !== expected
          ) {
            throw new UploadError(
              'The server answered the upload with a plan this page does not understand. Reload the page and try again.',
              'BAD_SESSION'
            );
          }
          state.session = {
            uploadId: opened.uploadId,
            blockSize: opened.blockSize,
            blockCount: opened.blockCount,
          };
        }
        await sendMissingBlocks(signal);
        report('completing', file.size, file.size);
        let answer;
        try {
          answer = await post(`cms/interviews/uploads/${state.session.uploadId}/complete`, {});
        } catch (error) {
          // A 422 at completion is a missing block, or a size or hash
          // mismatch after which the server deleted the session's blob (and
          // its staged blocks) but kept the session open. Either way the
          // next run sends every block again on the same session.
          if (error?.status === 422) state.acknowledged.clear();
          throw error;
        }
        state.completed = answer;
        report('done', file.size, file.size);
        return answer;
      } catch (error) {
        throw stopped(error);
      }
    },
  };
}
