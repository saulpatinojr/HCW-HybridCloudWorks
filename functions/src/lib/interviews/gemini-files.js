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
import { readKey, parseJsonWithFallbacks } from '../ai/router.js';
import { AuthoredError } from '../http/error-response.js';

export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com';

/** The key's app setting, the same one the router reads (KEY_ENV.gemini). */
export const GEMINI_KEY_SETTING = 'GEMINI_API_KEY';

/** Attempts per window call, and the waits between them (the router's backoff). */
export const WINDOW_ATTEMPTS = 3;
export const RETRY_WAITS_MS = Object.freeze([2000, 4000]);

/** Statuses retried; everything else fails the call at once. */
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

/** Deadlines per request: the upload carries the whole file, a window answers in a few minutes. */
export const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
export const WINDOW_TIMEOUT_MS = 5 * 60 * 1000;
export const ACTIVE_POLL_MS = 2000;
export const ACTIVE_POLL_LIMIT = 60;

/** The most of an answer that is read: a window's JSON is well under this; anything larger is not an answer. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** The host every Gemini URL must be on, the upload URL the start answers with included. */
export const GEMINI_HOST = 'generativelanguage.googleapis.com';
const FILE_NAME = /^files\/[A-Za-z0-9._-]{1,128}$/;

/** A failure this module authored: a status and a code, never Gemini's text. */
export class GeminiFilesError extends AuthoredError {
  /**
   * @param {string} message - a sentence written here
   * @param {{ code: string, status?: number, retryable?: boolean }} fields
   */
  constructor(message, { code, status = null, retryable = false }) {
    super(message, { code });
    this.status = status;
    this.retryable = retryable;
  }
}

/** The key, or a refusal the worker can store. */
export function geminiApiKey(env = process.env) {
  const key = readKey(env, GEMINI_KEY_SETTING);
  if (!key) {
    throw new GeminiFilesError(
      'Gemini is not configured: seed GEMINI_API_KEY in Key Vault before transcribing.',
      { code: 'GEMINI_NOT_CONFIGURED', status: 503 }
    );
  }
  return key;
}

/** `MM:SS` from seconds, for the window prompt. */
export function clock(seconds) {
  const whole = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/**
 * The window prompt. Fixed text: no user text, no file name, no guest name
 * enters it, so there is nothing to fence. The model is told the file may
 * end inside the window and to say so.
 */
export function windowPrompt({ startSec, endSec }) {
  return [
    `Transcribe the audio from ${clock(startSec)} to ${clock(endSec)} only, with speaker labels.`,
    'Label speakers "Speaker 1", "Speaker 2" and so on, consistently across the whole recording.',
    'Write what was said, verbatim, in the language spoken. Do not summarise, do not add anything.',
    'Return JSON only, in this exact shape:',
    '{"segments":[{"start":<seconds>,"end":<seconds>,"speaker":"Speaker 1","text":"..."}],"endOfAudio":<true if the recording ends before or inside this window, else false>}',
    'Times are seconds from the start of the recording. If nothing is spoken in the window, return an empty segments list.',
  ].join('\n');
}

/** True for an https URL on Gemini's host: where the key may be sent. */
export function isGeminiUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && url.hostname === GEMINI_HOST;
  } catch {
    return false;
  }
}

const abortError = (signal) => signal?.reason || Object.assign(new Error('aborted'), { name: 'AbortError' });

/**
 * One request under a deadline and the caller's signal. Answers
 * `{ status, headers, json }` for any status; the caller judges it. A
 * network failure or a timeout is a retryable GeminiFilesError.
 */
async function request(fetchImpl, url, { method, headers, body, duplex, timeoutMs, signal: parentSignal }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
  if (signal.aborted) {
    clearTimeout(timer);
    throw abortError(parentSignal);
  }
  try {
    const response = await fetchImpl(url, {
      method,
      headers,
      body,
      signal,
      ...(duplex ? { duplex } : {}),
    });
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      throw new GeminiFilesError('Gemini answered with more than this job reads.', { code: 'GEMINI_RESPONSE_TOO_LARGE', status: 502 });
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new GeminiFilesError('Gemini answered with more than this job reads.', { code: 'GEMINI_RESPONSE_TOO_LARGE', status: 502 });
    }
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, headers: response.headers, json };
  } catch (error) {
    if (parentSignal?.aborted) throw abortError(parentSignal);
    if (error instanceof GeminiFilesError) throw error;
    if (error?.name === 'AbortError') {
      throw new GeminiFilesError(`Gemini did not answer within ${Math.round(timeoutMs / 1000)} s.`, {
        code: 'GEMINI_TIMEOUT',
        status: 408,
        retryable: true,
      });
    }
    throw new GeminiFilesError('Gemini could not be reached.', {
      code: 'GEMINI_UNREACHABLE',
      status: 503,
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** A non-2xx answer as the error this module stores: status and code only. */
function statusError(status, what) {
  return new GeminiFilesError(`Gemini answered HTTP ${status} to the ${what}.`, {
    code: `GEMINI_HTTP_${status}`,
    status,
    retryable: RETRYABLE.has(status),
  });
}

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

const MAX_SEGMENTS_PER_WINDOW = 2000;
const MAX_SEGMENT_CHARS = 4000;
const MAX_SPEAKER_CHARS = 40;

/**
 * The model's answer as the shape the job stores, or a refusal. Every
 * field is checked at runtime: the answer is untrusted output.
 *
 * @param {unknown} raw
 * @returns {{ segments: Array<{start:number,end:number,speaker:string,text:string}>, endOfAudio: boolean }}
 */
export function parseWindowResult(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.segments)) {
    throw new GeminiFilesError('The transcription answer was not in the expected shape.', {
      code: 'TRANSCRIPT_SHAPE',
      status: 422,
    });
  }
  if (raw.segments.length > MAX_SEGMENTS_PER_WINDOW) {
    throw new GeminiFilesError('The transcription answer had too many segments for one window.', {
      code: 'TRANSCRIPT_SHAPE',
      status: 422,
    });
  }
  const segments = [];
  for (const item of raw.segments) {
    if (!item || typeof item !== 'object') continue;
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (!text) continue;
    const start = Number(item.start);
    const end = Number(item.end);
    const speaker = typeof item.speaker === 'string' && item.speaker.trim() ? item.speaker.trim() : 'Speaker 1';
    segments.push({
      start: Number.isFinite(start) && start >= 0 ? start : 0,
      end: Number.isFinite(end) && end >= 0 ? end : 0,
      speaker: speaker.slice(0, MAX_SPEAKER_CHARS),
      text: text.slice(0, MAX_SEGMENT_CHARS),
    });
  }
  return { segments, endOfAudio: raw.endOfAudio === true };
}

/**
 * One window of the uploaded file as JSON segments, with the usage Gemini
 * reported for the request.
 *
 * @param {object} args
 * @param {string} args.fileUri
 * @param {string} args.mimeType
 * @param {string} args.model
 * @param {number} args.startSec
 * @param {number} args.endSec
 * @param {string} args.apiKey
 * @param {typeof fetch} [args.fetch]
 * @param {(ms: number) => Promise<void>} [args.sleep]
 * @param {(info: { attempt: number }) => Promise<void>|void} [args.assertBudget] - called before
 *   every attempt; a throw ends the call without a request
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{ segments: Array, endOfAudio: boolean, usage: { promptTokens: number, completionTokens: number }, attempts: number }>}
 */
export async function transcribeWindow({
  fileUri,
  mimeType,
  model,
  startSec,
  endSec,
  apiKey,
  fetch: fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  assertBudget = null,
  signal = null,
}) {
  const url = `${GEMINI_API_BASE}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = JSON.stringify({
    contents: [
      {
        role: 'user',
        parts: [{ fileData: { fileUri, mimeType } }, { text: windowPrompt({ startSec, endSec }) }],
      },
    ],
    generationConfig: { responseMimeType: 'application/json', temperature: 0 },
  });
  let lastError = null;
  for (let attempt = 1; attempt <= WINDOW_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw abortError(signal);
    if (attempt > 1) await sleep(RETRY_WAITS_MS[attempt - 2]);
    if (typeof assertBudget === 'function') await assertBudget({ attempt });
    let answer;
    try {
      answer = await request(fetchImpl, url, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body,
        timeoutMs: WINDOW_TIMEOUT_MS,
        signal,
      });
    } catch (error) {
      if (error?.retryable) {
        lastError = error;
        continue;
      }
      throw error;
    }
    if (answer.status < 200 || answer.status >= 300) {
      const error = statusError(answer.status, 'transcription');
      if (error.retryable) {
        lastError = error;
        continue;
      }
      throw error;
    }
    const parts = answer.json?.candidates?.[0]?.content?.parts;
    const text = Array.isArray(parts) ? parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '';
    let parsed;
    try {
      parsed = parseJsonWithFallbacks(text);
    } catch {
      throw new GeminiFilesError('The transcription answer was not JSON.', { code: 'TRANSCRIPT_SHAPE', status: 422 });
    }
    const usage = answer.json?.usageMetadata || {};
    return {
      ...parseWindowResult(parsed),
      usage: {
        promptTokens: Number(usage.promptTokenCount) || 0,
        completionTokens:
          (Number(usage.candidatesTokenCount) || 0) + (Number(usage.thoughtsTokenCount) || 0),
      },
      attempts: attempt,
    };
  }
  throw lastError;
}
