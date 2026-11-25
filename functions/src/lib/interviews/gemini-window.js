/**
 * interviews/gemini-window.js — one window of an uploaded recording
 * transcribed (gemini-files.js has the upload and the header that explains
 * the client): the request with its retries and budget check, and the
 * model's answer checked field by field, since it is untrusted output.
 * gemini-files.js re-exports these, so callers keep one import.
 */
import { parseJsonWithFallbacks } from '../ai/router.js';
import {
  GEMINI_API_BASE,
  GeminiFilesError,
  RETRY_WAITS_MS,
  WINDOW_ATTEMPTS,
  WINDOW_TIMEOUT_MS,
  abortError,
  request,
  statusError,
  windowPrompt,
} from './gemini-http.js';

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
  const segments = raw.segments.map(cleanSegment).filter(Boolean);
  return { segments, endOfAudio: raw.endOfAudio === true };
}

/** One segment of the answer, checked and cut to size; null for one with no text. */
function cleanSegment(item) {
  if (!item || typeof item !== 'object') return null;
  const text = typeof item.text === 'string' ? item.text.trim() : '';
  if (!text) return null;
  const start = Number(item.start);
  const end = Number(item.end);
  const speaker = typeof item.speaker === 'string' && item.speaker.trim() ? item.speaker.trim() : 'Speaker 1';
  return {
    start: Number.isFinite(start) && start >= 0 ? start : 0,
    end: Number.isFinite(end) && end >= 0 ? end : 0,
    speaker: speaker.slice(0, MAX_SPEAKER_CHARS),
    text: text.slice(0, MAX_SEGMENT_CHARS),
  };
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
    let json;
    try {
      json = await windowAttempt(fetchImpl, url, { apiKey, body, signal });
    } catch (error) {
      if (!error?.retryable) throw error;
      lastError = error;
      continue;
    }
    return { ...windowAnswer(json), attempts: attempt };
  }
  throw lastError;
}

/**
 * One request for a window: its JSON, or the error thrown, with
 * `retryable` set when it may be tried again (a transport failure or a
 * status the caller retries).
 */
async function windowAttempt(fetchImpl, url, { apiKey, body, signal }) {
  const answer = await request(fetchImpl, url, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body,
    timeoutMs: WINDOW_TIMEOUT_MS,
    signal,
  });
  if (answer.status < 200 || answer.status >= 300) throw statusError(answer.status, 'transcription');
  return answer.json;
}

/** A successful answer as segments, with the usage Gemini reported. */
function windowAnswer(json) {
  const parts = json?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts) ? parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '';
  let parsed;
  try {
    parsed = parseJsonWithFallbacks(text);
  } catch {
    throw new GeminiFilesError('The transcription answer was not JSON.', { code: 'TRANSCRIPT_SHAPE', status: 422 });
  }
  const usage = json?.usageMetadata || {};
  return {
    ...parseWindowResult(parsed),
    usage: {
      promptTokens: Number(usage.promptTokenCount) || 0,
      completionTokens:
        (Number(usage.candidatesTokenCount) || 0) + (Number(usage.thoughtsTokenCount) || 0),
    },
  };
}
