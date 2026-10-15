/**
 * podcast-jobs.js — podcast transcript generation as a platform job (#435).
 *
 * One article is one model call, one or two synthesis requests and one
 * upload — minutes, not seconds — so the Publish page enqueues
 * `generate-podcast-transcript` through `POST /api/cms/podcast/transcripts/generate`
 * and the worker runs here under the non-HTTP timeout, exactly as
 * `generate-listen-and-learn` does. The document in `podcast_transcripts` is
 * the record; the job result is a small report of it.
 *
 * The second job, `publish-podcast-transcript` (#437, ADR 0029 §1b, §1c), is
 * the host step approval queues: read the MP3 from the `podcast` container,
 * put it on Podbean, store the outcome under `host.podbean`. It is
 * `publisher` because the route that queues it is, and because it is the act
 * that puts an AI-read episode on the feed under the owner's name. It never
 * writes `status` or `approvedAt`, and it never writes `podcasts` — the feed
 * is the ingest boundary. The episode notes end with a link to the article's
 * public URL when the article document carries one.
 */
import { readDoc, upsertDoc, patchDoc } from '../lib/cosmos-client.js';
import { deleteBlob, readBlobForDelivery, uploadBlob } from '../lib/blob-storage.js';
import { generateJsonResponse, getCostEstimate, modelForTask } from '../lib/ai/router.js';
import { publicUrlOf } from '../lib/cms/publish.js';
import { registerJobType } from '../lib/jobs.js';
import {
  ARTICLE_CONTAINER,
  TRANSCRIPT_JOB_TYPE,
  generateTranscriptFromArticle,
  parseArticleId,
} from '../lib/podcast/generate.js';
import {
  PUBLISH_JOB_TYPE,
  audioReaderFor,
  parseTranscriptId,
  recordHostJobFailure,
  runHostPublish,
} from '../lib/podcast/publish-transcript.js';
import { createPodbeanClient } from '../lib/podcast/podbean.js';
import {
  RECORDING_JOB_TYPE,
  generateTranscriptFromRecording,
  parseRecordingPayload,
} from '../lib/podcast/recording-generate.js';
import {
  UPLOAD_JOB_TYPE,
  parseUploadPayload,
  transcribeUpload,
} from '../lib/podcast/recording-upload.js';

/**
 * Validate a generate payload. Returns `{ value }` or `{ error }` so the rule
 * is testable on its own and the worker stays a thin adapter. The rule
 * itself is `parseArticleId`, shared with the route that enqueues, so a
 * refusal reads the same whichever door it came through.
 */
export function parseTranscriptPayload(payload) {
  const parsed = parseArticleId(payload?.articleId);
  if (parsed.error) return { error: parsed.error };
  return { value: { articleId: parsed.value } };
}

/** One generation run against production dependencies. */
export async function runTranscriptGeneration(payload, { context, signal } = {}) {
  if (signal?.aborted) throw signal.reason || new Error('aborted');
  const parsed = parseTranscriptPayload(payload);
  if (parsed.error) throw new Error(parsed.error);

  const report = await generateTranscriptFromArticle({
    articleId: parsed.value.articleId,
    store: { readDoc, upsertDoc, patchDoc },
    storage: { uploadBlob },
    // modelForTask: the podcastVoice task's model (ADR 0034 slice 5).
    ai: { generateJsonResponse, getCostEstimate, modelForTask },
    signal,
  });

  context?.log?.(
    `${TRANSCRIPT_JOB_TYPE}: ${report.id} drafted` +
      (report.audioError ? ` without audio (${report.audioError})` : ` with ${report.audioBytes} B of audio`) +
      `, $${report.costUsd} spent`
  );

  return report;
}

registerJobType(TRANSCRIPT_JOB_TYPE, {
  // Generates and stores a draft; approving it is a separate, publisher-gated
  // action. Same level as the route that enqueues it and as
  // generate-listen-and-learn, which does the same kind of work.
  role: 'editor',
  description:
    'Script a two-host podcast episode from one published article, synthesise the audio and save the transcript as a draft for review on the Recording Hub.',
  // One article id.
  maxPayloadBytes: 512,
  // One model call plus one or two synthesis requests plus an upload, with
  // headroom for a slow provider.
  timeoutMs: 10 * 60 * 1000,
  worker: runTranscriptGeneration,
});

/** Validate a publish payload: `{ transcriptId }`. Same rule as the routes. */
export function parsePublishPayload(payload) {
  const parsed = parseTranscriptId(payload?.transcriptId);
  if (parsed.error) return { error: parsed.error };
  return { value: { transcriptId: parsed.value } };
}

/**
 * The article's public URL for the episode notes' link, or null. A read failure here
 * is logged and costs the link, not the publish: an episode without a page
 * link is still an episode, and the retry route recovers the link later.
 * The log line carries the job id and the error's code — never a document
 * id or the raw message; the job document records the rest.
 */
async function resolveArticleUrl(doc, { context, jobId }) {
  if (!doc?.sourceId) return null;
  try {
    const article = await readDoc(ARTICLE_CONTAINER, doc.sourceId, doc.sourceId);
    return publicUrlOf(article || {}) || null;
  } catch (error) {
    context?.warn?.(
      `${PUBLISH_JOB_TYPE}: job ${jobId ?? 'unknown'} publishes without the article link ` +
        `(article read failed: ${error?.code ?? error?.statusCode ?? 'unknown'})`
    );
    return null;
  }
}

/** One publish run against production dependencies. */
export async function runTranscriptPublish(payload, { context, job, signal } = {}) {
  if (signal?.aborted) throw signal.reason || new Error('aborted');
  const parsed = parsePublishPayload(payload);
  if (parsed.error) throw new Error(parsed.error);
  const id = parsed.value.transcriptId;
  const jobId = job?.id ?? null;

  const record = await runHostPublish({
    store: { readDoc, patchDoc },
    id,
    client: createPodbeanClient({ signal }),
    readAudio: audioReaderFor(readBlobForDelivery),
    resolvePublicUrl: (doc) => resolveArticleUrl(doc, { context, jobId }),
    signal,
  });

  // Content-free: the outcome and the error code, keyed by the job id. The
  // transcript id and the host's episode id are on the document and in the
  // job result, not in the log.
  const outcome = record.skipped
    ? `skipped (${record.skipped})`
    : record.error
      ? `failed (${record.error.code})`
      : 'on the host';
  context?.log?.(`${PUBLISH_JOB_TYPE}: job ${jobId ?? 'unknown'} ${outcome}`);

  return {
    id,
    episodeId: record.episodeId ?? null,
    permalinkUrl: record.permalinkUrl ?? null,
    hostStatus: record.hostStatus ?? null,
    skipped: record.skipped ?? null,
    error: record.error ?? null,
  };
}

registerJobType(PUBLISH_JOB_TYPE, {
  // The role of POST cms/podcast/transcripts/review and …/{id}/publish, the
  // two routes that queue it: this is what puts an episode on the feed.
  role: 'publisher',
  description:
    'Upload an approved podcast transcript’s audio to Podbean and create or update its episode; the outcome is recorded on the transcript under host.podbean.',
  // One transcript id.
  maxPayloadBytes: 512,
  // The client's own deadlines (30 s token, 30 s upload authorisation, 300 s
  // PUT, 30 s create) sum to six and a half minutes, and eight and a half if
  // both Podbean calls spend their one re-auth (a token and a repeat, 60 s
  // each); this sits above that so a slow host is recorded as the client's
  // specific error rather than as a job timeout.
  timeoutMs: 10 * 60 * 1000,
  worker: runTranscriptPublish,
  /**
   * A job that died around the step (a thrown store error, the timeout, a
   * poisoned or reaped job) would leave host.podbean.pending true forever;
   * clear it and say why — but only this job's own reservation, under the
   * version read, so a newer Publish's marker or a stored episode stands.
   */
  onComplete: async ({ job, status, error }, { now }) => {
    if (status === 'succeeded') return;
    const parsed = parsePublishPayload(job?.payload);
    if (parsed.error) return;
    await recordHostJobFailure({
      store: { readDoc, patchDoc },
      id: parsed.value.transcriptId,
      jobId: job?.id,
      status,
      error,
      now,
    });
  },
});

// ---------------------------------------------------------------------------
// Recording side (#442): script a recording; transcribe an upload.
// ---------------------------------------------------------------------------

/** One recording → transcript run against production dependencies. */
export async function runRecordingGeneration(payload, { context, signal } = {}) {
  if (signal?.aborted) throw signal.reason || new Error('aborted');
  const parsed = parseRecordingPayload(payload);
  if (parsed.error) throw new Error(parsed.error);

  const report = await generateTranscriptFromRecording({
    ...parsed.value,
    store: { readDoc, upsertDoc, patchDoc },
    storage: { uploadBlob },
    // modelForTask: the podcastVoice task's model (ADR 0034 slice 5).
    ai: { generateJsonResponse, getCostEstimate, modelForTask },
    signal,
  });

  context?.log?.(
    `${RECORDING_JOB_TYPE}: ${report.id} drafted` +
      (report.audioError ? ` without audio (${report.audioError})` : ` with ${report.audioBytes} B of audio`) +
      (report.attributionLeaks.length ? `, ${report.attributionLeaks.length} attribution leak(s) to review` : '') +
      `, $${report.costUsd} spent`
  );

  return report;
}

registerJobType(RECORDING_JOB_TYPE, {
  // Same level as generate-podcast-transcript and the route that enqueues
  // it: a draft, with approval a separate publisher-gated act.
  role: 'editor',
  description:
    'Script a two-host podcast episode from one Plaud library recording (read through the MCP with the stored token) or one stored recording, synthesise the audio and save the transcript as a draft for review on the Recording Hub.',
  // One recording id, either kind.
  maxPayloadBytes: 512,
  // Two MCP reads, one model call, one or two synthesis requests, an upload.
  timeoutMs: 10 * 60 * 1000,
  worker: runRecordingGeneration,
});

/** Headroom under the job timeout so the poll loop ends with a named error, not a kill. */
const UPLOAD_JOB_TIMEOUT_MS = 25 * 60 * 1000;
const UPLOAD_POLL_BUDGET_MS = UPLOAD_JOB_TIMEOUT_MS - 60 * 1000;

/** One upload → Plaud Embedded → stored transcript, against production dependencies. */
export async function runUploadTranscription(payload, { context, signal } = {}) {
  if (signal?.aborted) throw signal.reason || new Error('aborted');
  const parsed = parseUploadPayload(payload);
  if (parsed.error) throw new Error(parsed.error);

  const report = await transcribeUpload({
    ...parsed.value,
    store: { readDoc, upsertDoc, patchDoc },
    storage: { deleteBlob },
    timeoutMs: UPLOAD_POLL_BUDGET_MS,
    log: context,
    signal,
  });

  context?.log?.(
    `${UPLOAD_JOB_TYPE}: recording ${report.id} stored from Plaud transcription ${report.transcriptionId} ` +
      `(${report.segments} segments, upload ${report.uploadDeleted ? 'deleted' : 'kept'})`
  );

  return report;
}

registerJobType(UPLOAD_JOB_TYPE, {
  // The route that enqueues it is editor; the result is a stored transcript
  // that nothing publishes.
  role: 'editor',
  description:
    'Hand one uploaded audio file to the Plaud Embedded Transcription API, poll until it is transcribed and store the transcript in recordings for the Recording Hub.',
  // A blob path and a title.
  maxPayloadBytes: 1024,
  // Plaud transcribes at roughly real time or faster; a two-hour recording
  // fits, and the poll loop stops with a named error a minute before this.
  timeoutMs: UPLOAD_JOB_TIMEOUT_MS,
  worker: runUploadTranscription,
});
