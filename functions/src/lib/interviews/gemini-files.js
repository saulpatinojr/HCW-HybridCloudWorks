/**
 * gemini-files.js — the Gemini Files API and the one audio prompt the
 * interview transcription sends (ADR 0040 D3, #1565).
 *
 * Three calls, each over REST with `fetch` and the `GEMINI_API_KEY` secret,
 * the way router.js calls generateContent — there is no SDK in this
 * repository and no reason to add one for three endpoints:
 *
 *   uploadToGemini    the two-step resumable upload (start, then the bytes
 *                     to the upload URL the start answered with), then a
 *                     short poll until the file is ACTIVE. The body is a
 *                     STREAM: a recording of up to 500 MiB is never held.
 *   transcribeWindow  one generateContent call for one time window of the
 *                     uploaded file, asking for JSON segments with speaker
 *                     labels. Retried up to three times on 408, 429 and 5xx
 *                     with a 2 s then 4 s wait (the router's own policy);
 *                     400, 401 and 403 fail at once with a code.
 *   deleteFromGemini  removes the file when the job ends. Gemini would
 *                     delete it after 48 hours anyway; the job does not wait.
 *
 * THE KEY NEVER LEAVES THIS MODULE. It is read with the router's `readKey`
 * (an unresolved Key Vault reference reads as unset), sent as a header, and
 * appears in no error, no log line and no URL. Every error thrown here is
 * written from the HTTP status and a code, never from Gemini's own words,
 * so a worker may store it (`storedFailure`) and log it content-free.
 *
 * THE AUDIO IS COUNTED ON EVERY REQUEST. Gemini tokenises the whole file
 * for each generateContent call that names it (about 32 tokens a second of
 * audio), whatever window the prompt asks for, so every attempt — a retry
 * included — costs the full file's input tokens. The caller's
 * `assertBudget` hook is called before each attempt with the attempt number
 * so the monthly ceiling is checked per request, not per job
 * (lib/interviews/transcribe.js), and the windows are as long as the
 * model's output allows so there are as few requests as possible.
 *
 * Nothing here is called from a route: the transcription job is the one
 * caller, and every test stubs `fetch`.
 */
import { Readable } from 'node:stream';
import {
  ACTIVE_POLL_LIMIT,
  ACTIVE_POLL_MS,
  FILE_NAME,
  GEMINI_API_BASE,
  GeminiFilesError,
  UPLOAD_TIMEOUT_MS,
  WINDOW_TIMEOUT_MS,
  abortError,
  isGeminiUrl,
  request,
  statusError,
} from './gemini-http.js';

export {
  ACTIVE_POLL_LIMIT,
  ACTIVE_POLL_MS,
  GEMINI_API_BASE,
  GEMINI_HOST,
  GEMINI_KEY_SETTING,
  GeminiFilesError,
  MAX_RESPONSE_BYTES,
  RETRY_WAITS_MS,
  UPLOAD_TIMEOUT_MS,
  WINDOW_ATTEMPTS,
  WINDOW_TIMEOUT_MS,
  clock,
  geminiApiKey,
  isGeminiUrl,
  windowPrompt,
} from './gemini-http.js';
export { parseWindowResult, transcribeWindow } from './gemini-window.js';

/**
 * Upload a stream to Gemini's Files API and wait until the file is ACTIVE.
 *
 * @param {object} args
 * @param {import('node:stream').Readable} args.stream - the audio bytes
 * @param {number} args.bytes - their length, which the resumable protocol declares up front
 * @param {string} args.mimeType - one of the three audio types
 * @param {string} args.apiKey
 * @param {typeof fetch} [args.fetch]
 * @param {(ms: number) => Promise<void>} [args.sleep]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{ name: string, uri: string, mimeType: string }>}
 */
export async function uploadToGemini({
  stream,
  bytes,
  mimeType,
  apiKey,
  fetch: fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  signal = null,
}) {
  const length = Number(bytes);
  if (!Number.isInteger(length) || length <= 0) {
    throw new GeminiFilesError('The recording has no length to upload.', { code: 'AUDIO_EMPTY', status: 422 });
  }
  const start = await request(fetchImpl, `${GEMINI_API_BASE}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(length),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    // No display name: a file name is the owner's data and Gemini needs none.
    body: JSON.stringify({ file: {} }),
    timeoutMs: WINDOW_TIMEOUT_MS,
    signal,
  });
  if (start.status < 200 || start.status >= 300) throw statusError(start.status, 'upload start');
  const uploadUrl = start.headers?.get?.('x-goog-upload-url');
  // The key goes to this URL as a header, so it must be Gemini's own host.
  if (!uploadUrl || !isGeminiUrl(uploadUrl)) {
    throw new GeminiFilesError('Gemini answered the upload start without an upload URL.', {
      code: 'GEMINI_NO_UPLOAD_URL',
      status: 502,
    });
  }

  const body = typeof stream?.getReader === 'function' ? stream : Readable.toWeb(stream);
  const finish = await request(fetchImpl, uploadUrl, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Length': String(length),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body,
    duplex: 'half',
    timeoutMs: UPLOAD_TIMEOUT_MS,
    signal,
  });
  if (finish.status < 200 || finish.status >= 300) throw statusError(finish.status, 'upload');
  let file = finish.json?.file;
  if (!FILE_NAME.test(String(file?.name ?? '')) || typeof file?.uri !== 'string' || !isGeminiUrl(file.uri)) {
    throw new GeminiFilesError('Gemini answered the upload without a file record.', {
      code: 'GEMINI_NO_FILE',
      status: 502,
    });
  }

  // A large file is PROCESSING for a moment; a prompt that names it before
  // it is ACTIVE is refused, so wait, briefly and boundedly.
  for (let poll = 0; file.state === 'PROCESSING' && poll < ACTIVE_POLL_LIMIT; poll += 1) {
    if (signal?.aborted) throw abortError(signal);
    await sleep(ACTIVE_POLL_MS);
    const read = await request(fetchImpl, `${GEMINI_API_BASE}/v1beta/${file.name}`, {
      method: 'GET',
      headers: { 'x-goog-api-key': apiKey },
      timeoutMs: WINDOW_TIMEOUT_MS,
      signal,
    });
    if (read.status < 200 || read.status >= 300) throw statusError(read.status, 'file read');
    file = { ...file, ...(read.json || {}) };
  }
  if (file.state && file.state !== 'ACTIVE') {
    throw new GeminiFilesError(`Gemini could not process the recording (state ${String(file.state).replace(/[^A-Z_]/g, '')}).`, {
      code: 'GEMINI_FILE_NOT_ACTIVE',
      status: 422,
    });
  }
  return { name: file.name, uri: file.uri, mimeType: file.mimeType || mimeType };
}

/**
 * Delete an uploaded file. Best effort by contract: a 404 is success (the
 * 48-hour expiry or an earlier delete got there first); any other failure
 * is thrown for the caller to log content-free.
 */
export async function deleteFromGemini({ name, apiKey, fetch: fetchImpl = globalThis.fetch, signal = null }) {
  if (!FILE_NAME.test(String(name ?? ''))) return false;
  const gone = await request(fetchImpl, `${GEMINI_API_BASE}/v1beta/${name}`, {
    method: 'DELETE',
    headers: { 'x-goog-api-key': apiKey },
    timeoutMs: WINDOW_TIMEOUT_MS,
    signal,
  });
  if (gone.status === 404) return true;
  if (gone.status < 200 || gone.status >= 300) throw statusError(gone.status, 'file delete');
  return true;
}
