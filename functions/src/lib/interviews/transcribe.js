/**
 * transcribe.js — the `interview-transcribe` job (ADR 0040 D3, #1565).
 *
 *   payload { interviewId, transcriptVersion }
 *     → the document's provenance.audio names the blob
 *     → modelForTask({ task: 'recordingTranscript' }): Gemini, and a model
 *       priced for audio input (model-tables.js AUDIO_INPUT_RATES)
 *     → the blob streamed into Gemini's Files API (gemini-files.js)
 *     → one generateContent call per time window, each window's segments
 *       saved to transcripts/<id>/v<n>.parts/<k>.json as it arrives
 *     → the parts assembled into transcripts/<id>/v<n>.json, the parts
 *       deleted, the Gemini file deleted, the document patched
 *
 * A recording whose length is known is refused over 9.5 hours before the
 * job is queued (enqueue.js, TOO_LONG); one whose length is not known (a
 * URL fetch whose headers gave none) is stopped by this job with the same
 * code when the tenth window ends without `endOfAudio`.
 *
 * RESUME. A job the sweeper re-queues, or one the owner runs again for the
 * same version, reads the parts already in the container and skips those
 * windows; the upload to Gemini happens only when a window is still to do.
 *
 * THE AUDIO IS BILLED ON EVERY REQUEST. Gemini tokenises the whole file on
 * each generateContent call that names it — about 32 tokens a second of
 * audio, the Gemini audio page's figure — whatever window the prompt asks
 * for. So an hour of audio costs its 115,200 input tokens once per window
 * and once per retry, not once per job. Two consequences, both in code:
 *
 *   - Windows are as long as the model's output allows, so there are as
 *     few requests as possible: 60 minutes by default
 *     (INTERVIEW_TRANSCRIPTION_WINDOW_MINUTES, 5 to 120, no deploy to
 *     change it). An hour-long interview is one request; the 9.5-hour cap
 *     Gemini puts on a prompt is ten. [VERIFY on the first real run that a
 *     60-minute window's JSON stays inside the model's output limit; a
 *     window that truncates fails with TRANSCRIPT_SHAPE, and the setting
 *     brings the window down.]
 *   - The monthly ceiling INTERVIEW_TRANSCRIPTION_MONTHLY_USD (default 10)
 *     is checked BEFORE EVERY ATTEMPT, retries included, against the
 *     month's spend on the interview tasks in `ai_usage`
 *     (`ai:recordingTranscript` and `ai:interviewDrafting`, budget.js; re-read
 *     before every window, so two jobs running at once see each other's
 *     rows) plus what this job has spent so far plus this request's
 *     estimate: the whole
 *     file's tokens at the model's audio input rate (plus a small output
 *     allowance). Before the first answer the token count is estimated
 *     from the file's size at a low bitrate (which overstates the length,
 *     so the estimate errs high); after it, Gemini's own promptTokenCount
 *     from the last answer is the estimate. A request that would cross
 *     the ceiling fails the job with BUDGET_EXCEEDED and nothing is sent.
 *     Every answered request writes a usage row (recordAiUsage) priced at
 *     the audio rate, so the Cost page sees it.
 *
 * WHAT IS LOGGED: the interview id, the transcript version, the window
 * index, token counts, bytes, attempts and elapsed time. Never a segment,
 * a speaker's words, a name, the URL or the file name; transcribe.test.js
 * asserts it. What is stored on failure is the job's authored sentence or
 * a code (storedFailure), never Gemini's words.
 */
import { modelForTask as routerModelForTask, getCostEstimate as routerCostEstimate } from '../ai/router.js';
import { audioInputRateFor, modelRatesFor } from '../ai/model-tables.js';
import { featureSource, recordAiUsage } from '../ai/usage.js';
import { readSetting } from '../http/read-setting.js';
import { CEILING_DEFAULT_USD, CEILING_SETTING, budgetExceeded, monthInterviewSpend, monthlyCeilingUsd } from './budget.js';
import { MAX_AUDIO_SECONDS } from './duration.js';
import { storedFailure } from '../http/error-response.js';
import { JobFailedError } from '../jobs.js';
import {
  deleteFromGemini as defaultDelete,
  geminiApiKey,
  transcribeWindow as defaultTranscribeWindow,
  uploadToGemini as defaultUpload,
} from './gemini-files.js';
import { INTERVIEWS_AUDIO_CONTAINER, transcriptBlobPath, transcriptPartPath } from './storage.js';
import { transcriptDocument } from './transcript-text.js';
import { assertNoOtherRun, chooseTranscriptionModel, recordingOf } from './transcribe-checks.js';

export const TRANSCRIBE_JOB_TYPE = 'interview-transcribe';
export const TRANSCRIBE_TASK = 'recordingTranscript';
export const TRANSCRIBE_JOB_MAX_PAYLOAD_BYTES = 1024;
export const TRANSCRIBE_JOB_TIMEOUT_MS = 25 * 60 * 1000;
export const CONTENT_CONTAINER = 'content';

// The ceiling and the length cap live in budget.js and duration.js, shared
// with the drafting job and the enqueue route; re-exported for the callers
// that read them here.
export { CEILING_DEFAULT_USD, CEILING_SETTING, MAX_AUDIO_SECONDS, monthlyCeilingUsd };
export const WINDOW_SETTING = 'INTERVIEW_TRANSCRIPTION_WINDOW_MINUTES';
export const WINDOW_DEFAULT_MINUTES = 60;
export const WINDOW_MIN_MINUTES = 5;
export const WINDOW_MAX_MINUTES = 120;

/** Tokens per second of audio input (the same page). */
export const AUDIO_TOKENS_PER_SECOND = 32;
/** Output tokens allowed for in a request's estimate: a window's JSON. */
export const OUTPUT_TOKEN_ALLOWANCE = 16_000;

/**
 * Bytes a second at a LOW bitrate for each type, so the duration a file's
 * size implies errs long and the cost estimate errs high: 64 kbps for the
 * compressed types, 16-bit stereo at 44.1 kHz for wav.
 */
export const BYTES_PER_SECOND = Object.freeze({
  'audio/mpeg': 8000,
  'audio/mp4': 8000,
  'audio/wav': 176_400,
});

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** `{ interviewId, transcriptVersion }`, or a refusal. Shared with the route that enqueues. */
export function parseTranscribePayload(payload) {
  const interviewId = typeof payload?.interviewId === 'string' ? payload.interviewId.trim() : '';
  if (!ID.test(interviewId)) return { error: 'interviewId is required.' };
  const version = Number(payload?.transcriptVersion);
  if (!Number.isInteger(version) || version < 1 || version > 999) {
    return { error: 'transcriptVersion must be a whole number from 1 to 999.' };
  }
  return { value: { interviewId, transcriptVersion: version } };
}

/** The seconds of audio a file's size implies at the low bitrate, capped at Gemini's limit. */
export function estimateAudioSeconds({ bytes, contentType }) {
  const rate = BYTES_PER_SECOND[contentType] || BYTES_PER_SECOND['audio/mpeg'];
  const seconds = Math.ceil((Number(bytes) || 0) / rate);
  return Math.min(Math.max(seconds, 1), MAX_AUDIO_SECONDS);
}

/** The window length in seconds: the setting within its bounds, else the default. */
export function windowSeconds(env = process.env) {
  const value = Number(readSetting(env, WINDOW_SETTING));
  const minutes = Number.isFinite(value) && value > 0 ? Math.min(Math.max(value, WINDOW_MIN_MINUTES), WINDOW_MAX_MINUTES) : WINDOW_DEFAULT_MINUTES;
  return Math.round(minutes * 60);
}

/** The windows a recording can need at most: Gemini's cap over the window length. */
export const maxWindows = (seconds) => Math.ceil(MAX_AUDIO_SECONDS / seconds);

/**
 * What one request costs at the model's rates: the whole file's audio
 * tokens in, a window's JSON out. Null when the model is not priced for
 * audio, which the job refuses before anything is sent.
 */
export function requestCostUsd({ provider, model, promptTokens, completionTokens = OUTPUT_TOKEN_ALLOWANCE, at = Date.now() }) {
  const audioRate = audioInputRateFor(provider, model, at);
  const rates = modelRatesFor(provider, model, at);
  if (audioRate === null || !rates) return null;
  return (promptTokens * audioRate + completionTokens * rates[1]) / 1_000_000;
}

/** The month's spend on the interview tasks (budget.js), under the name this job's callers use. */
export const monthTranscriptionSpend = monthInterviewSpend;

/** A part the container holds, or null. The parts are JSON this job wrote. */
async function readPart(storage, path) {
  const blob = await storage.readBlobForDelivery(INTERVIEWS_AUDIO_CONTAINER, path);
  if (!blob) return null;
  try {
    const part = JSON.parse(blob.body.toString('utf8'));
    return Array.isArray(part?.segments) ? { segments: part.segments, endOfAudio: part.endOfAudio === true } : null;
  } catch {
    return null;
  }
}

/**
 * Transcribe one interview's recording into one transcript version.
 *
 * @param {object} args
 * @param {string} args.interviewId
 * @param {number} args.transcriptVersion
 * @param {{ readDoc: Function, patchDoc: Function, queryDocs: Function, upsertDoc: Function }} args.store
 * @param {{ downloadBlobStream: Function, readBlobForDelivery: Function, uploadBlob: Function, deleteBlob: Function }} args.storage
 * @param {{ modelForTask: Function, getCostEstimate: Function }} [args.ai] - the router by default
 * @param {{ uploadToGemini: Function, transcribeWindow: Function, deleteFromGemini: Function }} [args.gemini] - gemini-files.js by default
 * @param {object} [args.env]
 * @param {typeof fetch} [args.fetch]
 * @param {(ms: number) => Promise<void>} [args.sleep]
 * @param {() => Date} [args.now]
 * @param {() => string} [args.uuid]
 * @param {{ log?: Function, warn?: Function }} [args.log]
 * @param {AbortSignal} [args.signal]
 * @param {string} [args.jobId]
 * @returns {Promise<{ interviewId: string, transcriptVersion: number, windows: number, requests: number, segments: number, promptTokens: number, completionTokens: number, costUsd: number, model: string, provider: string, resumedFrom: number }>}
 */
export async function transcribeInterview({
  interviewId,
  transcriptVersion,
  store,
  storage,
  ai = { modelForTask: routerModelForTask, getCostEstimate: routerCostEstimate },
  gemini = { uploadToGemini: defaultUpload, transcribeWindow: defaultTranscribeWindow, deleteFromGemini: defaultDelete },
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => new Date(),
  uuid = undefined,
  log = null,
  signal = null,
  jobId = null,
  container = CONTENT_CONTAINER,
}) {
  const startedAt = Date.now();
  const doc = await store.readDoc(container, interviewId, interviewId);
  const audio = recordingOf(doc);
  const interview = isObject(doc.interview) ? doc.interview : {};
  const provenance = isObject(doc.provenance) ? doc.provenance : {};
  await assertNoOtherRun(store, doc, jobId);
  const chosen = await chooseTranscriptionModel(ai);
  const { provider, model } = chosen;

  const run = {
    store,
    storage,
    ai,
    gemini,
    env,
    fetchImpl,
    sleep,
    now,
    uuid,
    log,
    signal,
    container,
    interviewId,
    transcriptVersion,
    audio,
    chosen,
    provider,
    model,
    window: windowSeconds(env),
    ceiling: monthlyCeilingUsd(env),
    month: await monthTranscriptionSpend({ store, now }),
    jobSpentUsd: 0,
    jobTotalUsd: 0,
    promptTokensTotal: 0,
    completionTokensTotal: 0,
    requests: 0,
    knownPromptTokens: null,
    estimatedTokens: Math.ceil(audioSeconds(audio) * AUDIO_TOKENS_PER_SECOND),
    parts: [],
    resumedFrom: 0,
    geminiFile: null,
    apiKey: null,
    patchStage: (stage, extra = {}) =>
      store.patchDoc(container, interviewId, { interview: { ...interview, stage, error: null, ...extra } }),
  };
  /** Before every attempt: this request's estimate against the ceiling. */
  run.assertBudget = () => assertBudget(run);

  await store.patchDoc(container, interviewId, {
    transcription: { version: transcriptVersion, jobId, status: 'running', model, provider },
    interview: { ...interview, stage: 'transcribing', error: null, window: 0 },
  });

  try {
    await runWindows(run);
    assertAudioEnded(run);
    return await finishTranscript(run, { jobId, interview, provenance, startedAt });
  } catch (error) {
    // The document records the failure in the job's own words or a code,
    // never Gemini's. A write refused after the job's deadline is logged by
    // the client and the job document carries the timeout; nothing else.
    const sentence = storedFailure(error, 'Transcription failed.');
    try {
      await store.patchDoc(container, interviewId, {
        transcription: { version: transcriptVersion, jobId, status: 'failed', model, provider },
        interview: { ...interview, stage: 'failed', error: sentence },
      });
    } catch (writeError) {
      log?.warn?.(`${TRANSCRIBE_JOB_TYPE}: v${transcriptVersion} failure not recorded (${writeError?.code ?? 'unknown'})`);
    }
    throw error;
  } finally {
    await releaseGeminiFile(run);
  }
}

/**
 * The real length when the headers gave one (duration.js, read at
 * enqueue), else the bitrate guess that errs long.
 */
function audioSeconds(audio) {
  return Number.isFinite(audio.durationSec) && audio.durationSec > 0
    ? Math.min(audio.durationSec, MAX_AUDIO_SECONDS)
    : estimateAudioSeconds({ bytes: audio.bytes, contentType: audio.contentType });
}

/** This request's estimated cost against the month's ceiling; throws the budget refusal when it would pass it. */
function assertBudget(run) {
  const { provider, model, month, ceiling } = run;
  const promptTokens = run.knownPromptTokens ?? run.estimatedTokens;
  const cost = requestCostUsd({ provider, model, promptTokens, at: run.now() });
  if (month.costUsd + run.jobSpentUsd + cost > ceiling) {
    throw budgetExceeded({ what: 'Transcription', usedUsd: month.costUsd + run.jobSpentUsd, ceiling, since: month.since, costUsd: cost });
  }
}

/** Every window, one after another, from the first part not already stored, until the audio ends. */
async function runWindows(run) {
  const limit = maxWindows(run.window);
  for (let k = 0; k < limit; k += 1) {
    if (run.signal?.aborted) throw run.signal.reason || new Error('aborted');
    const part = await nextPart(run, k);
    if (part.endOfAudio) break;
  }
}

/** Window `k`'s part: the one a run before this one stored, or a new one transcribed now. */
async function nextPart(run, k) {
  const partPath = transcriptPartPath(run.interviewId, run.transcriptVersion, k);
  const existing = await readPart(run.storage, partPath);
  if (existing) {
    run.parts.push(existing);
    run.resumedFrom = k + 1;
    return existing;
  }
  // The month's figure is re-read before each window so a second job
  // running at the same time is counted; this job's own rows are in it
  // by then, so its running total is not added twice.
  if (k > 0 && run.requests > 0) {
    run.month = await monthTranscriptionSpend({ store: run.store, now: run.now });
    run.jobSpentUsd = 0;
  }
  await ensureUploaded(run);
  return transcribeOneWindow(run, k, partPath);
}

/** The recording, uploaded to Gemini once, the first time a window needs it. */
async function ensureUploaded(run) {
  if (run.geminiFile) return;
  run.apiKey = geminiApiKey(run.env);
  // The first request's budget is checked before a byte is uploaded:
  // an upload the ceiling would then refuse is 500 MiB for nothing.
  run.assertBudget();
  const { audio } = run;
  const { stream, contentLength } = await run.storage.downloadBlobStream(INTERVIEWS_AUDIO_CONTAINER, audio.path);
  run.geminiFile = await run.gemini.uploadToGemini({
    stream,
    bytes: Number(audio.bytes) || contentLength,
    mimeType: audio.contentType,
    apiKey: run.apiKey,
    fetch: run.fetchImpl,
    sleep: run.sleep,
    signal: run.signal,
  });
}

/** Count one window's tokens and cost, and write its usage row; answers the cost. */
async function countWindow(run, result, k) {
  const { provider, model, log } = run;
  run.requests += result.attempts;
  run.knownPromptTokens = result.usage.promptTokens || run.knownPromptTokens;
  run.promptTokensTotal += result.usage.promptTokens;
  run.completionTokensTotal += result.usage.completionTokens;
  const costUsd = requestCostUsd({ provider, model, promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens, at: run.now() }) ?? 0;
  run.jobSpentUsd += costUsd;
  run.jobTotalUsd += costUsd;
  const row = await recordAiUsage(
    { store: run.store, ai: run.ai, uuid: run.uuid, now: run.now },
    {
      provider,
      model,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      source: featureSource(TRANSCRIBE_TASK),
      costUsd,
      selection: run.chosen.selection,
    }
  );
  // recordAiUsage swallows a failed write by contract; the ceiling
  // reads the rows, so a missing one is said out loud.
  if (!row) log?.warn?.(`${TRANSCRIBE_JOB_TYPE}: v${run.transcriptVersion} window ${k} usage row not written`);
}

/** Transcribe window `k`, store its part, and move the stage on. */
async function transcribeOneWindow(run, k, partPath) {
  const { log } = run;
  const windowStart = Date.now();
  const result = await run.gemini.transcribeWindow({
    fileUri: run.geminiFile.uri,
    mimeType: run.geminiFile.mimeType,
    model: run.model,
    startSec: k * run.window,
    endSec: (k + 1) * run.window,
    apiKey: run.apiKey,
    fetch: run.fetchImpl,
    sleep: run.sleep,
    assertBudget: run.assertBudget,
    signal: run.signal,
  });
  await countWindow(run, result, k);
  const part = { segments: result.segments, endOfAudio: result.endOfAudio };
  await run.storage.uploadBlob(INTERVIEWS_AUDIO_CONTAINER, partPath, JSON.stringify(part), 'application/json');
  run.parts.push(part);
  log?.log?.(
    `${TRANSCRIBE_JOB_TYPE}: v${run.transcriptVersion} window ${k} ${result.segments.length} segments, ` +
      `${result.usage.promptTokens}+${result.usage.completionTokens} tokens, ${result.attempts} attempt(s), ${Date.now() - windowStart} ms`
  );
  await run.patchStage('transcribing', { window: k + 1 });
  return part;
}

/**
 * A recording with no declared length (a URL fetch whose headers gave
 * none) that is still going when the last allowed window ends is over
 * Gemini's cap: the parts stay for the record, the job stops here.
 */
function assertAudioEnded({ parts, window }) {
  if (parts.length >= maxWindows(window) && !parts[parts.length - 1]?.endOfAudio) {
    throw new JobFailedError(
      `The recording is still going after ${parts.length} windows of ${Math.round(window / 60)} minutes; Gemini takes at most 9.5 hours in one prompt. Split it and upload the parts as separate interviews.`,
      { code: 'TOO_LONG', status: 422 }
    );
  }
}

/** Write the transcript from its parts, drop the parts, record it on the interview, and answer the job's figures. */
async function finishTranscript(run, { jobId, interview, provenance, startedAt }) {
  const { storage, interviewId, transcriptVersion, model, provider, parts, log } = run;
  const segments = parts.flatMap((p) => p.segments);
  const stamp = run.now().toISOString();
  const transcript = transcriptDocument({
    version: transcriptVersion,
    source: 'gemini',
    segments,
    model,
    provider,
    windows: parts.length,
  });
  await storage.uploadBlob(
    INTERVIEWS_AUDIO_CONTAINER,
    transcriptBlobPath(interviewId, transcriptVersion),
    JSON.stringify(transcript),
    'application/json'
  );
  for (let k = 0; k < parts.length; k += 1) {
    await storage.deleteBlob(INTERVIEWS_AUDIO_CONTAINER, transcriptPartPath(interviewId, transcriptVersion, k));
  }
  const record = { version: transcriptVersion, model, provider, transcribedAt: stamp, windows: parts.length };
  await run.store.patchDoc(run.container, interviewId, {
    transcription: { ...record, jobId, status: 'done' },
    provenance: { ...provenance, transcription: record },
    interview: { ...interview, stage: 'transcribed', error: null, window: parts.length },
  });
  const costUsd = parseFloat(run.jobTotalUsd.toFixed(6));
  log?.log?.(
    `${TRANSCRIBE_JOB_TYPE}: v${transcriptVersion} done: ${parts.length} window(s), ${run.requests} request(s), ` +
      `${segments.length} segments, ${run.promptTokensTotal}+${run.completionTokensTotal} tokens, $${costUsd}, ${Date.now() - startedAt} ms` +
      (run.resumedFrom ? `, resumed after ${run.resumedFrom} part(s)` : '')
  );
  return {
    interviewId,
    transcriptVersion,
    windows: parts.length,
    requests: run.requests,
    segments: segments.length,
    promptTokens: run.promptTokensTotal,
    completionTokens: run.completionTokensTotal,
    costUsd,
    model,
    provider,
    resumedFrom: run.resumedFrom,
  };
}

/** The file uploaded to Gemini, deleted once the job is over; a failure here is logged, never thrown. */
async function releaseGeminiFile(run) {
  if (!run.geminiFile) return;
  const { log } = run;
  try {
    await run.gemini.deleteFromGemini({ name: run.geminiFile.name, apiKey: run.apiKey, fetch: run.fetchImpl });
  } catch (deleteError) {
    log?.warn?.(`${TRANSCRIBE_JOB_TYPE}: v${run.transcriptVersion} Gemini file not deleted (${deleteError?.code ?? 'unknown'})`);
  }
}
