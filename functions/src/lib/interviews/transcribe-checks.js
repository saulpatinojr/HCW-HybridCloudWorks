/**
 * interviews/transcribe-checks.js — what the transcription job
 * (transcribe.js) checks before it spends anything: the interview has a
 * recording Gemini can take in one prompt, no other transcription of it is
 * still running, and the task resolves to a Gemini model priced for audio.
 * Each refusal is a JobFailedError sentence written here.
 */
import { audioInputRateFor } from '../ai/model-tables.js';
import { JOBS_CONTAINER, JobFailedError, TERMINAL_JOB_STATUSES } from '../jobs.js';
import { tooLong } from './duration.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The interview's recording (`provenance.audio`); throws when there is no interview, no recording, or one too long. */
export function recordingOf(doc) {
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
  return audio;
}

/**
 * One job per transcript at a time, whichever door queued it: the routes
 * answer 409, and the generic enqueueJob route does not, so the worker
 * checks too. The job the document names is this one (a re-run after the
 * sweeper re-queued it) or a finished one; another still queued or
 * running means this run must not write over its parts.
 */
export async function assertNoOtherRun(store, doc, jobId) {
  const named = isObject(doc.transcription) ? doc.transcription.jobId : null;
  if (typeof named !== 'string' || !named || named === jobId) return;
  const other = await store.readDoc(JOBS_CONTAINER, named, named);
  if (other && !TERMINAL_JOB_STATUSES.includes(other.status)) {
    throw new JobFailedError('Another transcription of this interview is still running; wait for it to finish.', {
      code: 'TRANSCRIPTION_IN_FLIGHT',
      status: 409,
    });
  }
}

/** The model: the task's door, Gemini only, priced for audio. */
export async function chooseTranscriptionModel(ai) {
  const chosen = await ai.modelForTask({ task: 'recordingTranscript' });
  if (chosen.provider !== 'gemini' || !chosen.model) {
    throw new JobFailedError('The Recording transcripts task resolved to no Gemini model; pick one under AI Engine → Tasks.', {
      code: 'MODEL_UNAVAILABLE',
      status: 503,
    });
  }
  if (audioInputRateFor(chosen.provider, chosen.model) === null) {
    throw new JobFailedError(`${chosen.model} has no audio input price in the cost table, so its spend cannot be counted; pick a priced model under AI Engine → Tasks.`, {
      code: 'MODEL_UNPRICED',
      status: 422,
    });
  }
  return chosen;
}
