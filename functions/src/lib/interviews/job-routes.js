/**
 * interviews/job-routes.js — the work of each interview job route
 * (enqueue.js has the header that explains them, and wraps each one in its
 * role check and error handling): fetch a recording from a URL, transcribe
 * it, draft from a transcript, or keep a pasted transcript. The URL an
 * editor gives goes into the job payload and the provenance block, never
 * into a log line.
 */
import { json } from '../http/admin-handler.js';
import { JOBS_CONTAINER, TERMINAL_JOB_STATUSES, newJobDoc } from '../jobs.js';
import { checkAudioUrl, FETCH_JOB_TYPE } from './fetch-audio.js';
import { TRANSCRIBE_JOB_TYPE } from './transcribe.js';
import { DRAFT_JOB_TYPE } from './draft.js';
import { checkTranscriptText, storeProvidedTranscript } from './transcript-text.js';
import { MAX_AUDIO_SECONDS, probeAudioDuration, tooLong } from './duration.js';
import { isTombstoned } from './upload-checks.js';

export const CONTENT_CONTAINER = 'content';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const objectOr = (value) => (isObject(value) ? value : {});

/** The route's `{id}`, or '' when it is not an id this site mints. */
export function readInterviewId(request) {
  const raw = request?.params?.id;
  return typeof raw === 'string' && ID.test(raw.trim()) ? raw.trim() : '';
}

/**
 * True while the job a document names is still queued or running.
 *
 * @param {{ readDoc: Function }} store
 * @param {unknown} jobId
 * @returns {Promise<boolean>}
 */
async function jobInFlight(store, jobId) {
  if (typeof jobId !== 'string' || !jobId) return false;
  const job = await store.readDoc(JOBS_CONTAINER, jobId, jobId);
  return Boolean(job) && !TERMINAL_JOB_STATUSES.includes(job.status);
}

/** The 409 the job routes answer once the interview's deletion has started. */
const interviewDeleted = () =>
  json(409, { ok: false, error: 'This interview is being deleted; nothing new was queued.', code: 'INTERVIEW_DELETED' });

/** The interview document, or the refusal to answer. */
async function readInterview({ store }, request) {
  const id = readInterviewId(request);
  if (!id) return { error: json(400, { ok: false, error: 'The interview id in the route is not valid.' }) };
  const doc = await store.readDoc(CONTENT_CONTAINER, id, id);
  if (!doc || doc.type !== 'interview') return { error: json(404, { ok: false, error: 'No interview with that id.' }) };
  return { id, doc };
}

/** The interview, or the refusal: an invalid id, none, or (with `live`) one being deleted. */
async function readLiveInterview(deps, request) {
  const read = await readInterview(deps, request);
  if (!read.error && isTombstoned(read.doc)) return { error: interviewDeleted() };
  return read;
}

/** Write the job document and send the message; the 202 every enqueue answers. */
async function queue({ store, uuid, now }, { type, payload, user, enqueue }) {
  const jobId = uuid();
  const doc = newJobDoc({ id: jobId, type, payload, requestedBy: user, createdAt: now().toISOString() });
  await store.upsertDoc(JOBS_CONTAINER, doc);
  enqueue({ jobId, type });
  return { jobId, body: { ok: true, jobId, type, status: 'queued', poll: `getJob?jobId=${jobId}` } };
}

/** POST cms/interviews/{id}/audio-from-url — editor. */
export async function audioFromUrl(deps, { request, auth, io }) {
  const read = await readLiveInterview(deps, request);
  if (read.error) return read.error;
  const body = (await request.json().catch(() => null)) ?? {};
  const url = checkAudioUrl(body?.url);
  if (!url.ok) return json(400, { ok: false, error: url.error });
  const interview = objectOr(read.doc.interview);
  if (await jobInFlight(deps.store, interview.fetchJobId)) {
    return json(409, { ok: false, error: 'A download for this interview is already running.' });
  }
  const { jobId, body: answer } = await queue(deps, {
    type: FETCH_JOB_TYPE,
    payload: { interviewId: read.id, sourceUrl: url.url },
    user: auth.user,
    enqueue: io.enqueue,
  });
  await deps.store.patchDoc(CONTENT_CONTAINER, read.id, {
    interview: { ...interview, stage: 'fetching', error: null, fetchJobId: jobId },
  });
  return json(202, answer);
}

/** The length, read once from the headers and kept on the document. */
async function recordingLength({ store, storage }, read, audio) {
  if (Number.isFinite(audio.durationSec)) return audio.durationSec;
  if (typeof storage.readBlobRangeForDelivery !== 'function') return null;
  const durationSec = await probeAudioDuration(storage, {
    container: audio.container || 'interviews-audio',
    path: audio.path,
    contentType: audio.contentType,
    bytes: audio.bytes,
  });
  await store.patchDoc(CONTENT_CONTAINER, read.id, {
    provenance: { ...read.doc.provenance, audio: { ...audio, durationSec } },
  });
  return durationSec;
}

/**
 * The refusal for a recording that cannot be transcribed now: none (422),
 * a transcription already running (409), or one too long for one prompt
 * (422); null when it can be.
 */
async function transcribeRefusal(deps, read, audio, current) {
  if (!isObject(audio) || !audio.path) {
    return json(422, { ok: false, error: 'This interview has no recording; upload one or fetch it from a URL first.' });
  }
  if (await jobInFlight(deps.store, current.jobId)) {
    return json(409, { ok: false, error: `Transcript version ${current.version} is already being made.` });
  }
  const durationSec = await recordingLength(deps, read, audio);
  if (!tooLong(durationSec)) return null;
  return json(422, {
    ok: false,
    error: `The recording is ${Math.round(durationSec / 60)} minutes long; Gemini takes at most ${MAX_AUDIO_SECONDS / 3600} hours in one prompt. Split it and upload the parts as separate interviews.`,
    code: 'TOO_LONG',
  });
}

/** POST cms/interviews/{id}/transcribe — editor; the next transcript version. */
export async function transcribe(deps, { request, auth, io }) {
  // A recording whose deletion has started still has its path for a moment.
  const read = await readLiveInterview(deps, request);
  if (read.error) return read.error;
  const audio = isObject(read.doc.provenance) ? read.doc.provenance.audio : null;
  const current = objectOr(read.doc.transcription);
  const refusal = await transcribeRefusal(deps, read, audio, current);
  if (refusal) return refusal;
  const version = (Number.isInteger(current.version) && current.version > 0 ? current.version : 0) + 1;
  const { jobId, body: answer } = await queue(deps, {
    type: TRANSCRIBE_JOB_TYPE,
    payload: { interviewId: read.id, transcriptVersion: version },
    user: auth.user,
    enqueue: io.enqueue,
  });
  const interview = objectOr(read.doc.interview);
  await deps.store.patchDoc(CONTENT_CONTAINER, read.id, {
    transcription: { version, jobId, status: 'queued' },
    interview: { ...interview, stage: 'transcribing', error: null },
  });
  return json(202, { ...answer, transcriptVersion: version });
}

/** POST cms/interviews/{id}/draft — editor; drafts the current transcript version. */
export async function draft(deps, { request, auth, io }) {
  const read = await readInterview(deps, request);
  if (read.error) return read.error;
  const current = objectOr(read.doc.transcription);
  if (!Number.isInteger(current.version) || !['done', 'provided'].includes(current.status)) {
    return json(422, { ok: false, error: 'This interview has no finished transcript to draft from.' });
  }
  const interview = objectOr(read.doc.interview);
  if (await jobInFlight(deps.store, interview.draftJobId)) {
    return json(409, { ok: false, error: 'A draft for this interview is already being made.' });
  }
  const { jobId, body: answer } = await queue(deps, {
    type: DRAFT_JOB_TYPE,
    payload: { interviewId: read.id, transcriptVersion: current.version },
    user: auth.user,
    enqueue: io.enqueue,
  });
  await deps.store.patchDoc(CONTENT_CONTAINER, read.id, {
    interview: { ...interview, stage: 'drafting', error: null, draftJobId: jobId },
  });
  return json(202, { ...answer, transcriptVersion: current.version });
}

/** POST cms/interviews/{id}/transcript — editor; a pasted transcript, no job. */
export async function transcript(deps, { request, context }) {
  const read = await readInterview(deps, request);
  if (read.error) return read.error;
  const body = (await request.json().catch(() => null)) ?? {};
  const text = checkTranscriptText(body);
  if (!text.ok) return json(text.status, { ok: false, error: text.error });
  const current = objectOr(read.doc.transcription);
  if (await jobInFlight(deps.store, current.jobId)) {
    return json(409, { ok: false, error: 'A transcription for this interview is still running; wait for it, or paste the text afterwards.' });
  }
  const report = await storeProvidedTranscript({
    interviewId: read.id,
    text: text.text,
    store: deps.store,
    storage: deps.storage,
    now: deps.now,
    log: context,
  });
  return json(200, { ok: true, ...report });
}
