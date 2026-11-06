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
import { MAX_AUDIO_SECONDS, tooLong } from './duration.js';
import { storedFailure } from '../http/error-response.js';
import { JOBS_CONTAINER, JobFailedError, TERMINAL_JOB_STATUSES } from '../jobs.js';
import {
  deleteFromGemini as defaultDelete,
  geminiApiKey,
  transcribeWindow as defaultTranscribeWindow,
  uploadToGemini as defaultUpload,
} from './gemini-files.js';
import { INTERVIEWS_AUDIO_CONTAINER, transcriptBlobPath, transcriptPartPath } from './storage.js';
import { transcriptDocument } from './transcript-text.js';

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
  if (!doc || doc.type !== 'interview') {
    throw new JobFailedError('No interview with that id.', { code: 'INTERVIEW_NOT_FOUND', status: 404 });
  }
  const audio = isObject(doc.provenance) && isObject(doc.provenance.audio) ? doc.provenance.audio : null;
  if (!audio?.path || !audio.contentType) {
    throw new JobFailedError('This interview has no recording to transcribe; upload one or fetch it from a URL first.', {
      code: 'AUDIO_MISSING',
      status: 422,
    });
  }
  // A known length over Gemini's cap would fail on the first request after
  // the whole upload; the enqueue route refuses it first, and so does the
  // worker for a job queued through the generic door.
  if (tooLong(audio.durationSec)) {
    throw new JobFailedError(
      `The recording is ${Math.round(audio.durationSec / 60)} minutes long; Gemini takes at most 9.5 hours in one prompt. Split it and upload the parts as separate interviews.`,
      { code: 'TOO_LONG', status: 422 }
    );
  }
  const interview = isObject(doc.interview) ? doc.interview : {};
  const provenance = isObject(doc.provenance) ? doc.provenance : {};
  const patchStage = (stage, extra = {}) =>
    store.patchDoc(container, interviewId, { interview: { ...interview, stage, error: null, ...extra } });

  // One job per transcript at a time, whichever door queued it: the routes
  // answer 409, and the generic enqueueJob route does not, so the worker
  // checks too. The job the document names is this one (a re-run after the
  // sweeper re-queued it) or a finished one; another still queued or
  // running means this run must not write over its parts.
  const named = isObject(doc.transcription) ? doc.transcription.jobId : null;
  if (typeof named === 'string' && named && named !== jobId) {
    const other = await store.readDoc(JOBS_CONTAINER, named, named);
    if (other && !TERMINAL_JOB_STATUSES.includes(other.status)) {
      throw new JobFailedError('Another transcription of this interview is still running; wait for it to finish.', {
        code: 'TRANSCRIPTION_IN_FLIGHT',
        status: 409,
      });
    }
  }

  // The model: the task's door, Gemini only, priced for audio.
  const chosen = await ai.modelForTask({ task: 'recordingTranscript' });
  if (chosen.provider !== 'gemini' || !chosen.model) {
    throw new JobFailedError('The Recording transcripts task resolved to no Gemini model; pick one under AI Engine → Tasks.', {
      code: 'MODEL_UNAVAILABLE',
      status: 503,
    });
  }
  const { provider, model } = chosen;
  if (audioInputRateFor(provider, model) === null) {
    throw new JobFailedError(`${model} has no audio input price in the cost table, so its spend cannot be counted; pick a priced model under AI Engine → Tasks.`, {
      code: 'MODEL_UNPRICED',
      status: 422,
    });
  }

  const window = windowSeconds(env);
  const limit = maxWindows(window);
  const ceiling = monthlyCeilingUsd(env);
  let month = await monthTranscriptionSpend({ store, now });
  let jobSpentUsd = 0;
  let jobTotalUsd = 0;
  let promptTokensTotal = 0;
  let completionTokensTotal = 0;
  let requests = 0;
  let knownPromptTokens = null;
  // The real length when the headers gave one (duration.js, read at
  // enqueue), else the bitrate guess that errs long.
  const seconds = Number.isFinite(audio.durationSec) && audio.durationSec > 0
    ? Math.min(audio.durationSec, MAX_AUDIO_SECONDS)
    : estimateAudioSeconds({ bytes: audio.bytes, contentType: audio.contentType });
  const estimatedTokens = Math.ceil(seconds * AUDIO_TOKENS_PER_SECOND);

  /** Before every attempt: this request's estimate against the ceiling. */
  const assertBudget = () => {
    const promptTokens = knownPromptTokens ?? estimatedTokens;
    const cost = requestCostUsd({ provider, model, promptTokens, at: now() });
    if (month.costUsd + jobSpentUsd + cost > ceiling) {
      throw budgetExceeded({ what: 'Transcription', usedUsd: month.costUsd + jobSpentUsd, ceiling, since: month.since, costUsd: cost });
    }
  };

  await store.patchDoc(container, interviewId, {
    transcription: { version: transcriptVersion, jobId, status: 'running', model, provider },
    interview: { ...interview, stage: 'transcribing', error: null, window: 0 },
  });

  const parts = [];
  let resumedFrom = 0;
  let geminiFile = null;
  let apiKey = null;
  try {
    for (let k = 0; k < limit; k += 1) {
      if (signal?.aborted) throw signal.reason || new Error('aborted');
      const partPath = transcriptPartPath(interviewId, transcriptVersion, k);
      const existing = await readPart(storage, partPath);
      if (existing) {
        parts.push(existing);
        resumedFrom = k + 1;
        if (existing.endOfAudio) break;
        continue;
      }
      // The month's figure is re-read before each window so a second job
      // running at the same time is counted; this job's own rows are in it
      // by then, so its running total is not added twice.
      if (k > 0 && requests > 0) {
        month = await monthTranscriptionSpend({ store, now });
        jobSpentUsd = 0;
      }
      if (!geminiFile) {
        apiKey = geminiApiKey(env);
        // The first request's budget is checked before a byte is uploaded:
        // an upload the ceiling would then refuse is 500 MiB for nothing.
        assertBudget();
        const { stream, contentLength } = await storage.downloadBlobStream(INTERVIEWS_AUDIO_CONTAINER, audio.path);
        geminiFile = await gemini.uploadToGemini({
          stream,
          bytes: Number(audio.bytes) || contentLength,
          mimeType: audio.contentType,
          apiKey,
          fetch: fetchImpl,
          sleep,
          signal,
        });
      }
      const windowStart = Date.now();
      const result = await gemini.transcribeWindow({
        fileUri: geminiFile.uri,
        mimeType: geminiFile.mimeType,
        model,
        startSec: k * window,
        endSec: (k + 1) * window,
        apiKey,
        fetch: fetchImpl,
        sleep,
        assertBudget,
        signal,
      });
      requests += result.attempts;
      knownPromptTokens = result.usage.promptTokens || knownPromptTokens;
      promptTokensTotal += result.usage.promptTokens;
      completionTokensTotal += result.usage.completionTokens;
      const costUsd = requestCostUsd({ provider, model, promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens, at: now() }) ?? 0;
      jobSpentUsd += costUsd;
      jobTotalUsd += costUsd;
      const row = await recordAiUsage(
        { store, ai, uuid, now },
        {
          provider,
          model,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          source: featureSource(TRANSCRIBE_TASK),
          costUsd,
          selection: chosen.selection,
        }
      );
      // recordAiUsage swallows a failed write by contract; the ceiling
      // reads the rows, so a missing one is said out loud.
      if (!row) log?.warn?.(`${TRANSCRIBE_JOB_TYPE}: ${interviewId} v${transcriptVersion} window ${k} usage row not written`);
      const part = { segments: result.segments, endOfAudio: result.endOfAudio };
      await storage.uploadBlob(INTERVIEWS_AUDIO_CONTAINER, partPath, JSON.stringify(part), 'application/json');
      parts.push(part);
      log?.log?.(
        `${TRANSCRIBE_JOB_TYPE}: ${interviewId} v${transcriptVersion} window ${k} ${result.segments.length} segments, ` +
          `${result.usage.promptTokens}+${result.usage.completionTokens} tokens, ${result.attempts} attempt(s), ${Date.now() - windowStart} ms`
      );
      await patchStage('transcribing', { window: k + 1 });
      if (result.endOfAudio) break;
    }

    // A recording with no declared length (a URL fetch whose headers gave
    // none) that is still going when the last allowed window ends is over
    // Gemini's cap: the parts stay for the record, the job stops here.
    if (parts.length >= limit && !parts[parts.length - 1]?.endOfAudio) {
      throw new JobFailedError(
        `The recording is still going after ${parts.length} windows of ${Math.round(window / 60)} minutes; Gemini takes at most 9.5 hours in one prompt. Split it and upload the parts as separate interviews.`,
        { code: 'TOO_LONG', status: 422 }
      );
    }
    const segments = parts.flatMap((p) => p.segments);
    const stamp = now().toISOString();
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
    await store.patchDoc(container, interviewId, {
      transcription: { ...record, jobId, status: 'done' },
      provenance: { ...provenance, transcription: record },
      interview: { ...interview, stage: 'transcribed', error: null, window: parts.length },
    });
    const costUsd = parseFloat(jobTotalUsd.toFixed(6));
    log?.log?.(
      `${TRANSCRIBE_JOB_TYPE}: ${interviewId} v${transcriptVersion} done: ${parts.length} window(s), ${requests} request(s), ` +
        `${segments.length} segments, ${promptTokensTotal}+${completionTokensTotal} tokens, $${costUsd}, ${Date.now() - startedAt} ms` +
        (resumedFrom ? `, resumed after ${resumedFrom} part(s)` : '')
    );
    return {
      interviewId,
      transcriptVersion,
      windows: parts.length,
      requests,
      segments: segments.length,
      promptTokens: promptTokensTotal,
      completionTokens: completionTokensTotal,
      costUsd,
      model,
      provider,
      resumedFrom,
    };
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
      log?.warn?.(`${TRANSCRIBE_JOB_TYPE}: ${interviewId} v${transcriptVersion} failure not recorded (${writeError?.code ?? 'unknown'})`);
    }
    throw error;
  } finally {
    if (geminiFile) {
      try {
        await gemini.deleteFromGemini({ name: geminiFile.name, apiKey, fetch: fetchImpl });
      } catch (deleteError) {
        log?.warn?.(`${TRANSCRIBE_JOB_TYPE}: ${interviewId} v${transcriptVersion} Gemini file not deleted (${deleteError?.code ?? 'unknown'})`);
      }
    }
  }
}
