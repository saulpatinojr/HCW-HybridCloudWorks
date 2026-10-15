/**
 * plaud-embedded.js — the Plaud Embedded Transcription API, the direction the
 * Plaud MCP does not have (#442, part of #432).
 *
 * The MCP reads what Plaud already recorded; this API transcribes audio WE
 * supply. It is server-side and key-authenticated, which is what makes an
 * "upload audio, get a transcript back" flow buildable at all. The key pair
 * is a different credential from the MCP OAuth tokens the Connect tab stores,
 * and both are needed for the two directions.
 *
 * ## What was verified against https://docs.plaud.ai on 2026-09-08
 *
 * Read from `plaud-embedded/transcription-api-overview`,
 * `api-reference/transcription-api/submit-audio-for-transcription`,
 * `api-reference/transcription-api/get-transcription-task`,
 * `plaud-embedded/data-retention` and `plaud-embedded/file-api-overview`:
 *
 *   - Servers: `https://platform-us.plaud.ai/developer/api` (US, default) and
 *     `https://platform-jp.plaud.ai/developer/api`. The path under either is
 *     `/open/partner/ai/transcriptions/` — so the full US create URL is
 *     `https://platform-us.plaud.ai/developer/api/open/partner/ai/transcriptions/`,
 *     exactly what issue #442 quoted.
 *   - Headers: `X-Client-Id` and `X-Client-Api-Key` (the API key is distinct
 *     from the client secret the device SDK uses), `Content-Type: application/json`.
 *   - `POST …/transcriptions/` body: `file_url` (required — "any publicly
 *     accessible audio URL"; M4A, MP3, WAV), `params.transcribe.language`
 *     (BCP-47 or `auto`, default `auto`), `params.transcribe.detection_level`
 *     (`segment` | `chapter`), `params.vad.decode_silence` (bool),
 *     `params.diarization.enabled` (bool), `params.diarization.return_embedding`
 *     (bool), `params.hotwords` (a comma-separated STRING of custom vocabulary,
 *     not an array).
 *   - Response: `{ transcription_id, status, data }`. Status enum: `PENDING`,
 *     `RECEIVED`, `STARTED`, `PROGRESS` (keep polling), `SUCCESS` (results in
 *     `data`), `FAILURE`, `REVOKED` (terminal failures).
 *   - `GET …/transcriptions/{transcription_id}` with the same headers. On
 *     SUCCESS `data` carries `text`, `language`, `duration` (integer SECONDS)
 *     and `results[]` of `{ start, end }` (SECONDS, fractional), `text`,
 *     `speaker_id`, `language`, `language_probabilitiy` (sic).
 *   - Limits: 60 requests a minute; recordings up to 24 hours; diarisation up
 *     to 6 hours; the overview recommends chunking anything over 5 hours.
 *   - Retention: "Transcriptions processed with our APIs are retained for 7
 *     days by default." The result is therefore copied into `recordings`
 *     as soon as it succeeds; nothing here reads it back later.
 *
 * Two things the pages disagree on or leave unsaid, and how this module
 * treats them:
 *
 *   - The overview page describes the result as `data.segments[]` with a
 *     `speaker` field; the reference page (the one with the example) says
 *     `data.results[]` with `speaker_id`. `normalizeEmbeddedResult` accepts
 *     both spellings. Tighten it once a live result has been seen.
 *   - Neither page documents the body of a 401/403/429, nor an error field on
 *     a `FAILURE` result. Failures here carry the HTTP status and whatever
 *     text came back, and a `FAILURE`/`REVOKED` status is reported by name.
 *
 * ## Why the file URL is the public media route
 *
 * The storage account denies direct and SAS reads by network rule (it is
 * closed to the internet; T-105), so a blob URL — signed or not — is
 * one Plaud cannot fetch. The only URL Plaud can read is the site's media
 * delivery route, `mediaUrlFor('podcast', 'uploads/<uuid>.<ext>')`, made
 * absolute with the API's public origin. That URL is unguessable (a v4 UUID
 * in the path) but UNAUTHENTICATED: anyone holding it can download the
 * audio for as long as the blob exists. That is the trade the upload flow
 * makes knowingly, and it is why the path is server-minted rather than
 * caller-chosen.
 *
 * Every call goes through `fetchWithTimeout` and the key is read with
 * `readKey`, so an unseeded `@Microsoft.KeyVault(…)` reference reads as "not
 * configured" and produces a plain sentence rather than a 401 against a
 * literal string.
 */
import { readKey } from '../ai/router.js';
import { fetchWithTimeout } from '../http/fetch-with-timeout.js';

export const CLIENT_ID_SETTING = 'PLAUD_EMBEDDED_CLIENT_ID';
export const API_KEY_SETTING = 'PLAUD_EMBEDDED_API_KEY';
/** Optional override; the US server is the documented default. */
export const BASE_URL_SETTING = 'PLAUD_EMBEDDED_BASE_URL';

export const DEFAULT_BASE_URL = 'https://platform-us.plaud.ai/developer/api';
export const TRANSCRIPTIONS_PATH = '/open/partner/ai/transcriptions/';

/** Verified 2026-09-08 (see header). */
export const STATUS = Object.freeze({
  pending: 'PENDING',
  received: 'RECEIVED',
  started: 'STARTED',
  progress: 'PROGRESS',
  success: 'SUCCESS',
  failure: 'FAILURE',
  revoked: 'REVOKED',
});
export const TERMINAL_STATUSES = Object.freeze([STATUS.success, STATUS.failure, STATUS.revoked]);

/** 60 req/min documented; a poll every 10 s uses a tenth of it. */
export const DEFAULT_POLL_INTERVAL_MS = 10_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/**
 * How long `waitForTranscription` polls when the caller says nothing: twenty
 * minutes, under the 25-minute `transcribe-recording-upload` job budget so
 * the loop ends with a named error rather than the worker being killed. The
 * job passes its own budget explicitly; this is the floor under a caller
 * that forgot, and a missing value must never become a NaN deadline.
 */
export const DEFAULT_WAIT_TIMEOUT_MS = 20 * 60 * 1000;

export class PlaudEmbeddedError extends Error {
  constructor(message, { status = 0, code = null } = {}) {
    super(message);
    this.name = 'PlaudEmbeddedError';
    this.status = status;
    this.code = code;
  }
}

export class PlaudEmbeddedNotConfiguredError extends PlaudEmbeddedError {
  constructor() {
    super(
      `Plaud Embedded is not configured: seed ${CLIENT_ID_SETTING} and ${API_KEY_SETTING} ` +
        `(Key Vault PLAUD-EMBEDDED-CLIENT-ID and PLAUD-EMBEDDED-API-KEY) to transcribe uploaded audio.`,
      { code: 'PLAUD_EMBEDDED_NOT_CONFIGURED' }
    );
    this.name = 'PlaudEmbeddedNotConfiguredError';
  }
}

/** Both halves of the credential, or nothing. */
export function readEmbeddedCredentials(env = process.env) {
  const clientId = readKey(env, CLIENT_ID_SETTING);
  const apiKey = readKey(env, API_KEY_SETTING);
  if (!clientId || !apiKey) return null;
  return { clientId, apiKey };
}

export function isPlaudEmbeddedConfigured(env = process.env) {
  return readEmbeddedCredentials(env) !== null;
}

function baseUrl(env) {
  const configured = readKey(env, BASE_URL_SETTING);
  return (configured || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function headersFor({ clientId, apiKey }) {
  return {
    'X-Client-Id': clientId,
    'X-Client-Api-Key': apiKey,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

function explainHttp(response, body, verb) {
  const detail =
    body?.message || body?.error || body?.detail || body?.raw
      ? `: ${String(body.message || body.error || body.detail || body.raw).slice(0, 300)}`
      : '';
  if (response.status === 401 || response.status === 403) {
    return new PlaudEmbeddedError(
      `Plaud Embedded rejected the client id or API key while trying to ${verb} (HTTP ${response.status})${detail}`,
      { status: response.status, code: 'PLAUD_EMBEDDED_UNAUTHENTICATED' }
    );
  }
  if (response.status === 429) {
    return new PlaudEmbeddedError(
      `Plaud Embedded rate limit reached while trying to ${verb} (60 requests a minute)${detail}`,
      { status: 429, code: 'PLAUD_EMBEDDED_RATE_LIMITED' }
    );
  }
  return new PlaudEmbeddedError(
    `Plaud Embedded answered HTTP ${response.status} while trying to ${verb}${detail}`,
    { status: response.status }
  );
}

/**
 * Submit one audio URL for transcription.
 *
 * Diarisation is always on: speaker turns are what the recording script
 * generator keeps (as paragraph breaks) and what the hub shows. Hotwords are
 * joined into the comma-separated string the API documents.
 *
 * @returns {Promise<{ transcriptionId: string, status: string }>}
 */
export async function createTranscription({
  fileUrl,
  language = 'auto',
  hotwords = [],
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  signal = null,
}) {
  if (signal?.aborted) throw signal.reason || new Error('aborted');
  const credentials = readEmbeddedCredentials(env);
  if (!credentials) throw new PlaudEmbeddedNotConfiguredError();

  const url = String(fileUrl || '').trim();
  if (!/^https:\/\//.test(url)) {
    throw new PlaudEmbeddedError('file_url must be an https URL Plaud can fetch');
  }

  const words = (Array.isArray(hotwords) ? hotwords : [])
    .map((w) => String(w).replace(/,/g, ' ').trim())
    .filter(Boolean);

  const body = {
    file_url: url,
    params: {
      transcribe: { language: String(language || 'auto') },
      diarization: { enabled: true },
      ...(words.length ? { hotwords: words.join(',') } : {}),
    },
  };

  const response = await fetchWithTimeout(fetchImpl, `${baseUrl(env)}${TRANSCRIPTIONS_PATH}`, {
    method: 'POST',
    headers: headersFor(credentials),
    body: JSON.stringify(body),
    timeoutMs,
    signal,
  });
  const json = await readJson(response);
  if (!response.ok) throw explainHttp(response, json, 'submit the audio');

  const transcriptionId = String(json?.transcription_id || '').trim();
  if (!transcriptionId) {
    throw new PlaudEmbeddedError('Plaud Embedded accepted the audio but returned no transcription_id');
  }
  return { transcriptionId, status: String(json?.status || STATUS.pending) };
}

/**
 * Read one transcription task.
 *
 * @returns {Promise<{ transcriptionId: string, status: string, data: object|null }>}
 */
export async function getTranscription({
  transcriptionId,
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  signal = null,
}) {
  if (signal?.aborted) throw signal.reason || new Error('aborted');
  const credentials = readEmbeddedCredentials(env);
  if (!credentials) throw new PlaudEmbeddedNotConfiguredError();
  const id = String(transcriptionId || '').trim();
  if (!id) throw new PlaudEmbeddedError('transcriptionId is required');

  const response = await fetchWithTimeout(
    fetchImpl,
    `${baseUrl(env)}${TRANSCRIPTIONS_PATH}${encodeURIComponent(id)}`,
    { method: 'GET', headers: headersFor(credentials), timeoutMs, signal }
  );
  const json = await readJson(response);
  if (!response.ok) throw explainHttp(response, json, 'read the transcription');

  return {
    transcriptionId: String(json?.transcription_id || id),
    status: String(json?.status || ''),
    data: json?.data && typeof json.data === 'object' ? json.data : null,
  };
}

/**
 * Poll until the task is terminal or the budget runs out.
 *
 * Throws a `PlaudEmbeddedError` on `FAILURE`/`REVOKED` and on timeout — both
 * name the transcription id so an operator can look it up while Plaud still
 * retains it (7 days).
 *
 * @returns {Promise<{ transcriptionId: string, status: 'SUCCESS', data: object }>}
 */
export async function waitForTranscription({
  transcriptionId,
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  now = () => Date.now(),
  signal = null,
}) {
  if (signal?.aborted) throw signal.reason || new Error('aborted');
  // A NaN or non-positive budget would make `deadline` NaN and the loop
  // below endless; refuse it by name instead.
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new PlaudEmbeddedError(
      `waitForTranscription needs a positive timeoutMs in milliseconds; got ${JSON.stringify(timeoutMs)}`
    );
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new PlaudEmbeddedError(
      `waitForTranscription needs a positive intervalMs in milliseconds; got ${JSON.stringify(intervalMs)}`
    );
  }
  const deadline = now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw signal.reason || new Error('aborted');
    const task = await getTranscription({ transcriptionId, env, fetch: fetchImpl, signal });
    if (task.status === STATUS.success) {
      if (!task.data) {
        throw new PlaudEmbeddedError(
          `Plaud Embedded reported SUCCESS for ${task.transcriptionId} but returned no data`
        );
      }
      return task;
    }
    if (task.status === STATUS.failure || task.status === STATUS.revoked) {
      throw new PlaudEmbeddedError(
        `Plaud Embedded transcription ${task.transcriptionId} ended with status ${task.status}`,
        { code: `PLAUD_EMBEDDED_${task.status}` }
      );
    }
    if (now() + intervalMs > deadline) {
      throw new PlaudEmbeddedError(
        `Plaud Embedded transcription ${task.transcriptionId} was still ${task.status || 'pending'} ` +
          `after ${Math.round(timeoutMs / 1000)} s; Plaud retains it for 7 days, so it can be re-read by id`,
        { code: 'PLAUD_EMBEDDED_TIMEOUT' }
      );
    }
    await sleep(intervalMs);
  }
}

const toMs = (seconds) => {
  const n = Number(seconds);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : null;
};

/**
 * The SUCCESS `data` object as `{ segments, durationMs, language, text }`,
 * with segments in the shape `normalizePlaudTranscript` already accepts —
 * `startMs/endMs/text/speaker`, milliseconds — so a transcription that came
 * from an upload and one that came from the MCP script through one path.
 *
 * Accepts `results[]`/`speaker_id` (reference page) and `segments[]`/`speaker`
 * (overview page); see the header.
 */
export function normalizeEmbeddedResult(data) {
  const rows = Array.isArray(data?.results)
    ? data.results
    : Array.isArray(data?.segments)
      ? data.segments
      : [];

  const segments = rows
    .map((row) => {
      const text = String(row?.text ?? row?.content ?? '').trim();
      if (!text) return null;
      const speaker = String(row?.speaker_id ?? row?.speaker ?? '').trim() || null;
      return {
        startMs: toMs(row?.start ?? row?.start_time),
        endMs: toMs(row?.end ?? row?.end_time),
        text,
        speaker,
      };
    })
    .filter(Boolean);

  const last = segments.length ? segments[segments.length - 1].endMs : null;
  const durationMs = toMs(data?.duration) ?? last;

  return {
    segments,
    durationMs,
    language: String(data?.language || '').trim() || null,
    text: String(data?.text || '').trim() || segments.map((s) => s.text).join('\n'),
  };
}
