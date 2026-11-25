/**
 * enqueue.js — the four admin routes that start interview work (ADR 0040
 * D2, D3; #1565): three queue a job, one stores a pasted transcript.
 *
 *   POST cms/interviews/{id}/audio-from-url  { url }   → interview-fetch-audio
 *   POST cms/interviews/{id}/transcribe      {}        → interview-transcribe (next version)
 *   POST cms/interviews/{id}/draft           {}        → interview-draft (the current version)
 *   POST cms/interviews/{id}/transcript      { text }  → transcripts/<id>/v1.json, no job
 *
 * The transcribe route also reads the recording's length from its headers
 * the first time (duration.js), stores it as `provenance.audio.durationSec`,
 * and refuses a recording over Gemini's 9.5-hour cap with TOO_LONG
 * (422) before any job is queued, since every window request would attach
 * the whole file and the first would fail after a full upload.
 *
 * All four are `editor`, the role of the job types they queue
 * (jobs.roles.test.js pairs them). Each reads the interview document first
 * and refuses with 404 when it is not an interview, so a job is never queued
 * for a document that cannot carry its result; each refuses with 409 while
 * a job of the same kind for that document is still `queued` or `running`,
 * read from the job document the interview names, so two "Transcribe"
 * taps make one job. The queue message goes out through the same Storage
 * Queue output binding `enqueueJob` uses (functions/interviews-jobs.js).
 *
 * The routes never write a transcript or a Q&A themselves, and the URL an
 * editor gives goes into the job payload and the provenance block, never
 * into a log line.
 */
import { randomUUID } from 'node:crypto';
import { json } from '../http/admin-handler.js';
import { JOBS_CONTAINER, MAX_REQUEUE_COUNT, RUNNING_GRACE_MS, STALE_QUEUED_MS, TERMINAL_JOB_STATUSES } from '../jobs.js';
import { authoredMessage, logFailure } from '../http/error-response.js';
import { FETCH_TIMEOUT_MS } from './fetch-audio.js';
import { TRANSCRIBE_JOB_TIMEOUT_MS } from './transcribe.js';
import { audioFromUrl, draft, transcribe, transcript } from './job-routes.js';

export { CONTENT_CONTAINER, readInterviewId } from './job-routes.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * True while a job that can still be working names the recording: the
 * download that stores it, or the transcription that reads it. The draft
 * reads only the transcript, so it does not count.
 *
 * A job whose worker died keeps its `queued` or `running` status until the
 * job sweeper reaps it, and the sweeper is a timer that may be switched off.
 * So a job counts only while it is inside its own budget plus the sweeper's
 * grace (a queued one also gets the sweeper's re-send allowance): past that
 * it is treated as lost, the same rule the sweeper applies, and a lost job
 * cannot hold a recording's deletion (a consent withdrawal, say) forever.
 *
 * @param {{ readDoc: Function }} store
 * @param {object} doc - the interview document
 * @param {Date} [at] - now
 * @returns {Promise<boolean>}
 */
export async function recordingInUse(store, doc, at = new Date()) {
  const interview = isObject(doc?.interview) ? doc.interview : {};
  const transcription = isObject(doc?.transcription) ? doc.transcription : {};
  return (
    (await jobStillWorking(store, interview.fetchJobId, FETCH_TIMEOUT_MS, at)) ||
    jobStillWorking(store, transcription.jobId, TRANSCRIBE_JOB_TIMEOUT_MS, at)
  );
}

/** A job not yet ended and not yet past the point the sweeper would call it lost. */
async function jobStillWorking(store, jobId, budgetMs, at) {
  if (typeof jobId !== 'string' || !jobId) return false;
  const job = await store.readDoc(JOBS_CONTAINER, jobId, jobId);
  if (!job || TERMINAL_JOB_STATUSES.includes(job.status)) return false;
  const running = job.status === 'running';
  const since = Date.parse(running ? job.startedAt : job.createdAt);
  // An undated job is not evidence of a lost one (the sweeper leaves it too).
  if (!Number.isFinite(since)) return true;
  const allowance =
    budgetMs + RUNNING_GRACE_MS + (running ? 0 : STALE_QUEUED_MS * (MAX_REQUEUE_COUNT + 1));
  return at.getTime() - since <= allowance;
}

/** The guard, the body, and a 500 for anything that throws, logged content-free. */
const guarded = (deps, label, run) => async (request, context, io = {}) => {
  const auth = await deps.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  if (typeof io.enqueue !== 'function' && label !== 'transcript') {
    context.error?.(`${label}: no queue output wired`);
    return json(500, { ok: false, error: 'Job queue is not configured' });
  }
  try {
    return await run(deps, { request, context, auth, io });
  } catch (error) {
    const status = Number(error?.status);
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      return json(status, { ok: false, error: authoredMessage(error, 'The request was refused.') });
    }
    logFailure(context, `interview ${label} failed`, error, request);
    return json(500, { ok: false, error: `Could not ${label} the interview.` });
  }
};

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ readDoc: Function, upsertDoc: Function, patchDoc: Function }} deps.store
 * @param {{ uploadBlob: Function, readBlobRangeForDelivery: Function }} deps.storage
 * @param {() => string} [deps.uuid]
 * @param {() => Date} [deps.now]
 */
export function createInterviewJobHandlers({ guard, store, storage, uuid = randomUUID, now = () => new Date() }) {
  const deps = { guard, store, storage, uuid, now };
  return {
    audioFromUrl: guarded(deps, 'fetch', audioFromUrl),
    transcribe: guarded(deps, 'transcribe', transcribe),
    draft: guarded(deps, 'draft', draft),
    transcript: guarded(deps, 'transcript', transcript),
  };
}
