/**
 * interviews/gemini-http.js — the request layer under Gemini's Files API
 * client (gemini-files.js, whose header explains the client): the
 * constants, the error this module stores (status and code, never Gemini's
 * words), one bounded request, and the prompt for one window.
 * gemini-files.js re-exports what callers use.
 */
import { readKey } from '../ai/router.js';
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
export const FILE_NAME = /^files\/[A-Za-z0-9._-]{1,128}$/;

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

export const abortError = (signal) => signal?.reason || Object.assign(new Error('aborted'), { name: 'AbortError' });

/**
 * One request under a deadline and the caller's signal. Answers
 * `{ status, headers, json }` for any status; the caller judges it. A
 * network failure or a timeout is a retryable GeminiFilesError.
 */
export async function request(fetchImpl, url, { method, headers, body, duplex, timeoutMs, signal: parentSignal }) {
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
export function statusError(status, what) {
  return new GeminiFilesError(`Gemini answered HTTP ${status} to the ${what}.`, {
    code: `GEMINI_HTTP_${status}`,
    status,
    retryable: RETRYABLE.has(status),
  });
}
