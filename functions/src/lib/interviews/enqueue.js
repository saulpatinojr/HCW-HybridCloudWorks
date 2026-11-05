/**
 * enqueue.js — the four admin routes that start interview work (ADR 0040
 * D2, D3; #1565): three queue a job, one stores a pasted transcript.
 *
 *   POST cms/interviews/{id}/audio-from-url  { url }   → interview-fetch-audio
 *   POST cms/interviews/{id}/transcribe      {}        → interview-transcribe (next version)
 *   POST cms/interviews/{id}/draft           {}        → interview-draft (the current version)
 *   POST cms/interviews/{id}/transcript      { text }  → transcripts/<id>/v1.json, no job
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
import { JOBS_CONTAINER, TERMINAL_JOB_STATUSES, newJobDoc } from '../jobs.js';
import { authoredMessage, logFailure } from '../http/error-response.js';
import { checkAudioUrl, FETCH_JOB_TYPE } from './fetch-audio.js';
import { TRANSCRIBE_JOB_TYPE } from './transcribe.js';
import { DRAFT_JOB_TYPE } from './draft.js';
import { checkTranscriptText, storeProvidedTranscript } from './transcript-text.js';

export const CONTENT_CONTAINER = 'content';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The route's `{id}`, or '' when it is not an id this site mints. */
export function readInterviewId(request) {
  const raw = request?.params?.id;
  return typeof raw === 'string' && ID.test(raw.trim()) ? raw.trim() : '';
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ readDoc: Function, upsertDoc: Function, patchDoc: Function }} deps.store
 * @param {{ uploadBlob: Function }} deps.storage
 * @param {() => string} [deps.uuid]
 * @param {() => Date} [deps.now]
 */
export function createInterviewJobHandlers({ guard, store, storage, uuid = randomUUID, now = () => new Date() }) {
  /** The interview document, or the refusal to answer. */
  async function readInterview(request) {
    const id = readInterviewId(request);
    if (!id) return { error: json(400, { ok: false, error: 'The interview id in the route is not valid.' }) };
    const doc = await store.readDoc(CONTENT_CONTAINER, id, id);
    if (!doc || doc.type !== 'interview') return { error: json(404, { ok: false, error: 'No interview with that id.' }) };
    return { id, doc };
  }

  /** True while the job the document names is still queued or running. */
  async function jobInFlight(jobId) {
    if (typeof jobId !== 'string' || !jobId) return false;
    const job = await store.readDoc(JOBS_CONTAINER, jobId, jobId);
    return Boolean(job) && !TERMINAL_JOB_STATUSES.includes(job.status);
  }

  /** Write the job document and send the message; the 202 every enqueue answers. */
  async function queue({ type, payload, user, enqueue }) {
    const jobId = uuid();
    const doc = newJobDoc({ id: jobId, type, payload, requestedBy: user, createdAt: now().toISOString() });
    await store.upsertDoc(JOBS_CONTAINER, doc);
    enqueue({ jobId, type });
    return { jobId, body: { ok: true, jobId, type, status: 'queued', poll: `getJob?jobId=${jobId}` } };
  }

  /** The guard, the body, and a 500 for anything that throws, logged content-free. */
  const guarded = (label, run) => async (request, context, io = {}) => {
    const auth = await guard.requireRole(request, 'editor');
    if (auth.error) return auth.error;
    if (typeof io.enqueue !== 'function' && label !== 'transcript') {
      context.error?.(`${label}: no queue output wired`);
      return json(500, { ok: false, error: 'Job queue is not configured' });
    }
    try {
      return await run({ request, context, auth, io });
    } catch (error) {
      const status = Number(error?.status);
      if (Number.isInteger(status) && status >= 400 && status < 500) {
        return json(status, { ok: false, error: authoredMessage(error, 'The request was refused.') });
      }
      logFailure(context, `interview ${label} failed`, error, request);
      return json(500, { ok: false, error: `Could not ${label} the interview.` });
    }
  };

  return {
    /** POST cms/interviews/{id}/audio-from-url — editor. */
    audioFromUrl: guarded('fetch', async ({ request, auth, io }) => {
      const read = await readInterview(request);
      if (read.error) return read.error;
      const body = (await request.json().catch(() => null)) ?? {};
      const url = checkAudioUrl(body?.url);
      if (!url.ok) return json(400, { ok: false, error: url.error });
      const interview = isObject(read.doc.interview) ? read.doc.interview : {};
      if (await jobInFlight(interview.fetchJobId)) {
        return json(409, { ok: false, error: 'A download for this interview is already running.' });
      }
      const { jobId, body: answer } = await queue({
        type: FETCH_JOB_TYPE,
        payload: { interviewId: read.id, sourceUrl: url.url },
        user: auth.user,
        enqueue: io.enqueue,
      });
      await store.patchDoc(CONTENT_CONTAINER, read.id, {
        interview: { ...interview, stage: 'fetching', error: null, fetchJobId: jobId },
      });
      return json(202, answer);
    }),

    /** POST cms/interviews/{id}/transcribe — editor; the next transcript version. */
    transcribe: guarded('transcribe', async ({ request, auth, io }) => {
      const read = await readInterview(request);
      if (read.error) return read.error;
      const audio = isObject(read.doc.provenance) ? read.doc.provenance.audio : null;
      if (!isObject(audio) || !audio.path) {
        return json(422, { ok: false, error: 'This interview has no recording; upload one or fetch it from a URL first.' });
      }
      const current = isObject(read.doc.transcription) ? read.doc.transcription : {};
      if (await jobInFlight(current.jobId)) {
        return json(409, { ok: false, error: `Transcript version ${current.version} is already being made.` });
      }
      const version = (Number.isInteger(current.version) && current.version > 0 ? current.version : 0) + 1;
      const { jobId, body: answer } = await queue({
        type: TRANSCRIBE_JOB_TYPE,
        payload: { interviewId: read.id, transcriptVersion: version },
        user: auth.user,
        enqueue: io.enqueue,
      });
      const interview = isObject(read.doc.interview) ? read.doc.interview : {};
      await store.patchDoc(CONTENT_CONTAINER, read.id, {
        transcription: { version, jobId, status: 'queued' },
        interview: { ...interview, stage: 'transcribing', error: null },
      });
      return json(202, { ...answer, transcriptVersion: version });
    }),

    /** POST cms/interviews/{id}/draft — editor; drafts the current transcript version. */
    draft: guarded('draft', async ({ request, auth, io }) => {
      const read = await readInterview(request);
      if (read.error) return read.error;
      const current = isObject(read.doc.transcription) ? read.doc.transcription : {};
      if (!Number.isInteger(current.version) || !['done', 'provided'].includes(current.status)) {
        return json(422, { ok: false, error: 'This interview has no finished transcript to draft from.' });
      }
      const interview = isObject(read.doc.interview) ? read.doc.interview : {};
      if (await jobInFlight(interview.draftJobId)) {
        return json(409, { ok: false, error: 'A draft for this interview is already being made.' });
      }
      const { jobId, body: answer } = await queue({
        type: DRAFT_JOB_TYPE,
        payload: { interviewId: read.id, transcriptVersion: current.version },
        user: auth.user,
        enqueue: io.enqueue,
      });
      await store.patchDoc(CONTENT_CONTAINER, read.id, {
        interview: { ...interview, stage: 'drafting', error: null, draftJobId: jobId },
      });
      return json(202, { ...answer, transcriptVersion: current.version });
    }),

    /** POST cms/interviews/{id}/transcript — editor; a pasted transcript, no job. */
    transcript: guarded('transcript', async ({ request, context }) => {
      const read = await readInterview(request);
      if (read.error) return read.error;
      const body = (await request.json().catch(() => null)) ?? {};
      const text = checkTranscriptText(body);
      if (!text.ok) return json(text.status, { ok: false, error: text.error });
      const current = isObject(read.doc.transcription) ? read.doc.transcription : {};
      if (await jobInFlight(current.jobId)) {
        return json(409, { ok: false, error: 'A transcription for this interview is still running; wait for it, or paste the text afterwards.' });
      }
      const report = await storeProvidedTranscript({
        interviewId: read.id,
        text: text.text,
        store,
        storage,
        now,
        log: context,
      });
      return json(200, { ok: true, ...report });
    }),
  };
}
