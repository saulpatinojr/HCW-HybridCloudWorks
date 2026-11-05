/**
 * interviews-jobs.js — the interview jobs and the routes that queue them
 * (ADR 0040 D2, D3, D4; #1565).
 *
 * Three job types on the platform jobs framework (lib/jobs.js), each
 * `editor` because the route that queues it is, and each a draft-making
 * step that publishes nothing:
 *
 *   interview-fetch-audio   a URL, through the fetch guard, into the
 *                           private container (lib/interviews/fetch-audio.js)
 *   interview-transcribe    the recording to Gemini, window by window,
 *                           into a transcript version (lib/interviews/transcribe.js)
 *   interview-draft         the transcript to a Q&A list through the text
 *                           router, guarded (lib/interviews/draft.js)
 *
 * A job does not queue the next one: the queue worker has no queue output
 * binding, and a job that re-queued itself would be a second door past the
 * route's checks. Each job leaves the document at a stage the admin page
 * reads (`fetched`, `transcribed`, `ready`), and the page — slice D's
 * poller, or the owner's "Transcribe again" and "Draft again" — calls the
 * next route. The four routes are in lib/interviews/enqueue.js; the queue
 * output here is the one `enqueueJob` and the Listen & Learn routes use.
 */
import { output } from '@azure/functions';
import { httpRoute } from '../lib/auth/http-route.js';
import { getDefaultGuard } from '../lib/auth/default-guard.js';
import { queryDocs, readDoc, upsertDoc, patchDoc } from '../lib/cosmos-client.js';
import {
  deleteBlob,
  downloadBlobStream,
  readBlobForDelivery,
  readBlobRangeForDelivery,
  uploadBlob,
  uploadBlobFromStream,
} from '../lib/blob-storage.js';
import { JOBS_QUEUE, JobFailedError, registerJobType } from '../lib/jobs.js';
import { createInterviewJobHandlers } from '../lib/interviews/enqueue.js';
import {
  FETCH_JOB_MAX_PAYLOAD_BYTES,
  FETCH_JOB_TYPE,
  FETCH_TIMEOUT_MS,
  fetchAudioToContainer,
  parseFetchPayload,
} from '../lib/interviews/fetch-audio.js';
import {
  TRANSCRIBE_JOB_MAX_PAYLOAD_BYTES,
  TRANSCRIBE_JOB_TIMEOUT_MS,
  TRANSCRIBE_JOB_TYPE,
  parseTranscribePayload,
  transcribeInterview,
} from '../lib/interviews/transcribe.js';
import { DRAFT_JOB_MAX_PAYLOAD_BYTES, DRAFT_JOB_TYPE, draftInterview, parseDraftPayload } from '../lib/interviews/draft.js';

// ── workers ─────────────────────────────────────────────────────────────────

/** One URL fetch against production dependencies. */
export async function runFetchAudio(payload, { context, job, signal } = {}) {
  if (signal?.aborted) throw signal.reason || new Error('aborted');
  const parsed = parseFetchPayload(payload);
  if (parsed.error) throw new JobFailedError(parsed.error);
  return fetchAudioToContainer({
    ...parsed.value,
    store: { readDoc, patchDoc },
    storage: { uploadBlobFromStream, deleteBlob },
    log: context,
    signal,
    ...(job?.id ? { uploadId: job.id } : {}),
  });
}

registerJobType(FETCH_JOB_TYPE, {
  // The route that queues it is editor; the result is a private blob.
  role: 'editor',
  description:
    'Fetch an interview recording from an https URL through the fetch guard into the private interviews-audio container, and record it on the interview.',
  maxPayloadBytes: FETCH_JOB_MAX_PAYLOAD_BYTES,
  // The guard's own 10-minute deadline over the whole download; the default
  // job budget is the same, so a slow host is the guard's named error.
  timeoutMs: FETCH_TIMEOUT_MS,
  worker: runFetchAudio,
});

/** One transcription against production dependencies. */
export async function runTranscribe(payload, { context, job, signal } = {}) {
  if (signal?.aborted) throw signal.reason || new Error('aborted');
  const parsed = parseTranscribePayload(payload);
  if (parsed.error) throw new JobFailedError(parsed.error);
  return transcribeInterview({
    ...parsed.value,
    store: { readDoc, patchDoc, queryDocs, upsertDoc },
    storage: { downloadBlobStream, readBlobForDelivery, uploadBlob, deleteBlob },
    log: context,
    signal,
    jobId: job?.id ?? null,
  });
}

registerJobType(TRANSCRIBE_JOB_TYPE, {
  // The route that queues it is editor; the result is a transcript nothing publishes.
  role: 'editor',
  description:
    'Send an interview recording to Gemini through its Files API, transcribe it window by window with speaker labels, and store the transcript version in the private container.',
  maxPayloadBytes: TRANSCRIBE_JOB_MAX_PAYLOAD_BYTES,
  // Under the 30-minute Flex Consumption function timeout; the parts on the
  // blob let a re-run resume where a timed-out job stopped.
  timeoutMs: TRANSCRIBE_JOB_TIMEOUT_MS,
  worker: runTranscribe,
});

/** One draft against production dependencies. */
export async function runDraft(payload, { context, signal } = {}) {
  if (signal?.aborted) throw signal.reason || new Error('aborted');
  const parsed = parseDraftPayload(payload);
  if (parsed.error) throw new JobFailedError(parsed.error);
  return draftInterview({
    ...parsed.value,
    store: { readDoc, patchDoc, queryDocs },
    storage: { readBlobForDelivery },
    log: context,
    signal,
  });
}

registerJobType(DRAFT_JOB_TYPE, {
  // The route that queues it is editor; the draft waits for the owner's review.
  role: 'editor',
  description:
    'Turn an interview transcript into a question-and-answer draft through the interviewDrafting task, check every quote and answer against the transcript, and store the list on the interview for review.',
  maxPayloadBytes: DRAFT_JOB_MAX_PAYLOAD_BYTES,
  // One or two model calls, each inside the router's own attempt timeouts.
  timeoutMs: 5 * 60 * 1000,
  worker: runDraft,
});

// ── routes ──────────────────────────────────────────────────────────────────

const queueOutput = output.storageQueue({
  queueName: JOBS_QUEUE,
  connection: 'AzureWebJobsStorage',
});

const handlers = () =>
  createInterviewJobHandlers({
    guard: getDefaultGuard(),
    store: { readDoc, upsertDoc, patchDoc },
    storage: { uploadBlob, readBlobRangeForDelivery },
  });

/** The queue output as the enqueue handlers take it. */
const queueIo = (context) => ({
  enqueue: (message) => context.extraOutputs.set(queueOutput, message),
});

httpRoute('cmsInterviewAudioFromUrl', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'cms/interviews/{id}/audio-from-url',
  extraOutputs: [queueOutput],
  handler: (request, context) => handlers().audioFromUrl(request, context, queueIo(context)),
});

httpRoute('cmsInterviewTranscribe', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'cms/interviews/{id}/transcribe',
  extraOutputs: [queueOutput],
  handler: (request, context) => handlers().transcribe(request, context, queueIo(context)),
});

httpRoute('cmsInterviewDraft', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'cms/interviews/{id}/draft',
  extraOutputs: [queueOutput],
  handler: (request, context) => handlers().draft(request, context, queueIo(context)),
});

httpRoute('cmsInterviewTranscript', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'cms/interviews/{id}/transcript',
  handler: (request, context) => handlers().transcript(request, context),
});
