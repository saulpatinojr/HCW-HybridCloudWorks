/**
 * publish-job.js — the job's half of the host step (publish-transcript.js
 * says how the two halves fit): read the transcript, refuse what should not
 * go, run the step and store the record; and the record a job that died
 * around the step leaves behind. publish-transcript.js exports all of this
 * again.
 */
import { DEFAULT_AUDIO_MIME, publishEpisodeToHost } from './host-publish.js';
import { PODCAST_AUDIO_CONTAINER, STATUS, TRANSCRIPT_CONTAINER } from './store.js';
import {
  hostSkipFor,
  isPreconditionFailure,
  notPublishedSkip,
  patchTranscript,
  skippedPatch,
  stableHostRecord,
} from './host-record.js';

/**
 * Adapt a `readBlobForDelivery`-shaped reader to what `publishEpisodeToHost`
 * wants from `readAudio`. Null stays null (the step records it as a
 * validation failure naming the path). A blob stored without a real content
 * type falls back to `audio/mpeg`, because that is what the generator writes
 * and the `content_type` the upload is authorised for must match the PUT.
 */
export function audioReaderFor(readBlob, container = PODCAST_AUDIO_CONTAINER) {
  return async (audioPath) => {
    const blob = await readBlob(container, audioPath);
    if (!blob) return null;
    const contentType =
      blob.contentType && blob.contentType !== 'application/octet-stream'
        ? blob.contentType
        : DEFAULT_AUDIO_MIME;
    return { bytes: blob.body, contentType };
  };
}

/**
 * The job's half: read the transcript, refuse what should not go, run the
 * step, store the record. Returns the stored `host.podbean`.
 *
 * Throws only when there is no document to record on. A transcript that
 * was withdrawn to draft between enqueue and run is not a failure — it is
 * recorded as `skipped: 'not_published'` and the job succeeds, because the
 * job did exactly what the document allowed.
 *
 * @param {object} deps
 * @param {{ readDoc: Function, patchDoc: Function }} deps.store
 * @param {string} deps.id the transcript id
 * @param {ReturnType<import('./podbean.js').createPodbeanClient>} deps.client
 * @param {(audioPath: string) => Promise<object|null>} deps.readAudio
 * @param {(doc: object) => Promise<string|null>} [deps.resolvePublicUrl] the article's public URL, linked at the end of the notes
 * @param {() => Date} [deps.now]
 */
export async function runHostPublish({
  store,
  id,
  client,
  readAudio,
  resolvePublicUrl,
  now = () => new Date(),
  signal = null,
}) {
  if (signal?.aborted) throw signal.reason || new Error('aborted');
  const doc = await store.readDoc(TRANSCRIPT_CONTAINER, id, id);
  if (!doc) {
    // runJob logs and stores `error.message`, so the message names the
    // condition and not the document; the id rides a property nothing logs.
    throw Object.assign(new Error('podcast transcript not found'), {
      code: 'TRANSCRIPT_NOT_FOUND',
      transcriptId: id,
    });
  }
  const at = now().toISOString();

  const skip =
    doc.status !== STATUS.published ? notPublishedSkip(doc) : hostSkipFor(doc, client?.configured);
  if (skip) {
    const patch = skippedPatch(doc, skip, at);
    await patchTranscript(store, id, patch);
    return patch.host.podbean;
  }

  const publicUrl =
    typeof resolvePublicUrl === 'function' ? (await resolvePublicUrl(doc)) || null : null;

  const patch = await publishEpisodeToHost({
    client,
    readAudio,
    doc: { ...doc, host: { podbean: stableHostRecord(doc.host) } },
    now,
    publicUrl: publicUrl || undefined,
  });
  await patchTranscript(store, id, patch);
  return patch.host.podbean;
}

/** How many versions of the transcript a job-failure record is tried against: the read, and one re-read after a 412. */
const FAILURE_RECORD_ATTEMPTS = 2;

/**
 * The job died around the step rather than in it — a thrown store error, or
 * the platform timeout — so `pending` would otherwise stay true forever and
 * the hub would say "publishing…" about a job that is over. Clear it and
 * record why, retryable, but only while the marker is still set: a worker
 * that stored its outcome a moment before the timer fired has already said
 * something better, and this must not overwrite it.
 *
 * The document's current status decides what is written. A transcript
 * returned to draft while the job was running gets `skipped:
 * 'not_published'`, the same record the worker would have stored had it got
 * that far — not a publish error, which would leave a draft showing a
 * failure and offering a retry the retry route refuses.
 *
 * Only this job's own reservation is cleared, and only the version that was
 * read (#942 follow-up). The hook runs late — after runJob's timeout, or
 * when the sweeper poisons or reaps the job, which now hands it the whole
 * document (#1198) — and by then a newer Publish may hold the marker, or a
 * racing worker may have stored an episode. Clearing either would let a
 * second job put the same episode on the feed. So the marker must name
 * `jobId`, and the write is conditional on the `_etag` read: a 412 is read
 * again (FAILURE_RECORD_ATTEMPTS bounds it), and a marker that moved on is
 * the answer, as recordScheduleFailure treats a newer reservation.
 *
 * Every attempt meeting a 412 while the marker still names this job is the
 * one way this gives up with `pending` left set, so it says so: a warning
 * with a fixed sentence and the attempt count, and no transcript or job id,
 * which the hub's "publishing…" then explains to whoever reads the log.
 *
 * @param {object} deps
 * @param {{ readDoc: Function, patchDoc: Function }} deps.store
 * @param {string} deps.id
 * @param {string} deps.jobId the id of the job whose hook this is
 * @param {'failed' | 'timeout' | string} deps.status the job's terminal status
 * @param {string|null} deps.error the job's recorded error text
 * @param {() => Date} [deps.now]
 * @param {{ warn?: Function }} [deps.log] the hook's context
 * @returns {Promise<boolean>} whether a record was written
 */
export async function recordHostJobFailure({
  store,
  id,
  jobId,
  status,
  error,
  now = () => new Date(),
  log = null,
}) {
  if (!jobId) return false;
  for (let attempt = 1; attempt <= FAILURE_RECORD_ATTEMPTS; attempt += 1) {
    const doc = await store.readDoc(TRANSCRIPT_CONTAINER, id, id);
    const marker = doc?.host?.podbean;
    if (!doc || marker?.pending !== true || marker.jobId !== jobId) return false;
    // Read without its `_etag`: nothing to condition on, so nothing written.
    if (!doc._etag) return false;
    try {
      await store.patchDoc(TRANSCRIPT_CONTAINER, id, jobFailurePatch(doc, { status, error, now }), {
        partitionKey: id,
        ifMatch: doc._etag,
      });
      return true;
    } catch (err) {
      if (!isPreconditionFailure(err)) throw err;
    }
  }
  log?.warn?.(
    `recordHostJobFailure: the publish marker changed on each of ${FAILURE_RECORD_ATTEMPTS} attempts; ` +
      'pending was left set'
  );
  return false;
}

/**
 * What a job that died around the step records on the transcript: the
 * not-published skip for a draft, otherwise a retryable JOB_TIMEOUT or
 * JOB_FAILED error. `pending` is not carried (stableHostRecord drops it).
 */
function jobFailurePatch(doc, { status, error, now }) {
  const at = now().toISOString();
  if (doc.status !== STATUS.published) return skippedPatch(doc, notPublishedSkip(doc), at);
  return {
    host: {
      podbean: {
        ...stableHostRecord(doc.host),
        lastAttemptAt: at,
        error: {
          status: null,
          code: status === 'timeout' ? 'JOB_TIMEOUT' : 'JOB_FAILED',
          message: error || `The publish job ended as ${status}.`,
          retryable: true,
        },
      },
    },
  };
}
