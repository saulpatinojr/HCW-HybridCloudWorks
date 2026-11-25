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
import { getJSON, postJSON, putBytes } from '@/lib/api';
import {
  MAX_AUDIO_SECONDS,
  UploadError,
  audioFileProblem,
  audioTypeOf,
  durationProblem,
} from './interviewAudioFile';
import { BLOCK_SIZE, blockRange, hashFile, readSlice } from './interviewUploadBlocks';

// The file checks and the block hashing live in two sibling files. Their
// public parts are re-exported here, so callers keep one import path.
export {
  MAX_AUDIO_BYTES,
  MAX_AUDIO_SECONDS,
  AUDIO_TYPES,
  AUDIO_TYPE_ALIASES,
  canonicalAudioType,
  extensionOf,
  audioTypeOf,
  UploadError,
  audioFileProblem,
  durationProblem,
  formatDuration,
  readAudioDuration,
} from './interviewAudioFile';
export { BLOCK_SIZE, blockRange, hashFile } from './interviewUploadBlocks';

/** Blocks in flight at once. */
export const PARALLEL_BLOCKS = 3;
/** The upload id the server mints: a v4-shaped UUID (upload.js UPLOAD_ID_PATTERN). */
const UPLOAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Attempts per block, the first included. */
export const BLOCK_ATTEMPTS = 3;

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
 * @param {{ postJSON?: Function, getJSON?: Function, putBytes?: Function, wait?: (ms: number) => Promise<void> }} [args.deps]
 */
export function createAudioUpload({ interviewId, file, durationSec, onProgress, deps = {} }) {
  const post = deps.postJSON || postJSON;
  const get = (route) => (deps.getJSON || getJSON)(route);
  const put = deps.putBytes || putBytes;
  const wait = deps.wait || pause;
  const state = {
    sha256: '',
    session: null,
    acknowledged: new Set(),
    completed: null,
    stopped: null,
  };
  const report = (phase, done, total) => onProgress?.({ phase, done, total });
  const upload = { interviewId, file, post, get, put, wait, state, report };

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
      // A refusal that ends the upload for good is remembered, so a second
      // run sends nothing more.
      if (state.stopped) throw state.stopped;
      try {
        const problem = audioFileProblem(file) || durationProblem(durationSec);
        if (problem) {
          throw new UploadError(
            problem,
            durationSec > MAX_AUDIO_SECONDS ? 'TOO_LONG' : 'INVALID_FILE'
          );
        }
        if (!state.sha256) {
          state.sha256 = await hashFile(file, {
            signal,
            onProgress: (done, total) => report('hashing', done, total),
          });
        }
        if (!state.session) state.session = await openSession(upload, durationSec);
        await sendMissingBlocks(upload, signal);
        report('completing', file.size, file.size);
        const answer = await complete(upload);
        state.completed = answer;
        report('done', file.size, file.size);
        return answer;
      } catch (error) {
        const final = stopped(error);
        if (final.code === 'INTERVIEW_DELETED') state.stopped = final;
        throw final;
      }
    },
  };
}

// The steps of one upload. Each takes the upload's parts (`upload`): the file,
// the interview, the request functions, `state` and `report`.

async function sendBlock({ file, put, wait, state }, index, signal) {
  const [start, end] = blockRange(file.size, index, state.session.blockSize);
  for (let attempt = 1; ; attempt += 1) {
    if (signal?.aborted) throw new UploadError('The upload was stopped.', 'ABORTED');
    try {
      const body = await readSlice(file.slice(start, end));
      // Checked again after the read: Stop pressed while a slice was being
      // read must not let that block go.
      if (signal?.aborted) throw new UploadError('The upload was stopped.', 'ABORTED');
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

async function sendMissingBlocks(upload, signal) {
  const { file, state, report } = upload;
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
        await sendBlock(upload, index, signal);
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

/** Open the session, and check the plan the server answers with. */
async function openSession({ interviewId, file, post, state }, durationSec) {
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
    !UPLOAD_ID_PATTERN.test(opened.uploadId) ||
    opened.blockSize !== BLOCK_SIZE ||
    opened.blockCount !== expected
  ) {
    throw new UploadError(
      'The server answered the upload with a plan this page does not understand. Reload the page and try again.',
      'BAD_SESSION'
    );
  }
  return {
    uploadId: opened.uploadId,
    blockSize: opened.blockSize,
    blockCount: opened.blockCount,
  };
}

/** Commit the blocks; the server checks the size and the hash. */
async function complete(upload) {
  const { post, state } = upload;
  try {
    return await post(`cms/interviews/uploads/${state.session.uploadId}/complete`, {});
  } catch (error) {
    // A 422 at completion is a missing block, or a size or hash mismatch
    // after which the server deleted the session's blob (and its staged
    // blocks) but kept the session open. Either way the next run sends
    // every block again on the same session.
    if (error?.status === 422) state.acknowledged.clear();
    // A 409 is either "already completed" (an earlier completion landed
    // but its answer was lost, a timeout say) or "the interview changed,
    // try again"; the server gives neither a code. The interview itself
    // says which: if it points at this upload, the recording is stored.
    if (error?.status === 409 && error?.code !== 'INTERVIEW_DELETED') {
      return completedEarlier(upload, error);
    }
    throw error;
  }
}

/** The completion an earlier attempt made, read back from the interview, or the 409 again. */
async function completedEarlier({ interviewId, get, state }, conflict) {
  const read = await get(`cms/interviews/${encodeURIComponent(interviewId)}`).catch(() => null);
  const audio = read?.interview?.provenance?.audio;
  if (audio && audio.uploadId === state.session.uploadId) {
    return { ok: true, bytes: audio.bytes, sha256: audio.sha256, contentType: audio.contentType };
  }
  throw conflict;
}
