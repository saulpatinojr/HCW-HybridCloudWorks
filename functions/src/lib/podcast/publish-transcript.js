/**
 * publish-transcript.js — the host step for a podcast transcript: what an
 * approval queues, what the job then does, and the record both leave on the
 * document (#437, slice 2; ADR 0029 §1b, §1c).
 *
 * ## Two doors, one path
 *
 * Approval (`POST cms/podcast/transcripts/review` → `published`) and the
 * retry button (`POST cms/podcast/transcripts/{id}/publish`) both call
 * `scheduleHostPublish`. It answers the two cases that need no network on the
 * spot — no audio on the transcript, or Podbean not configured — as a
 * `skipped` record, and otherwise writes a `publish-podcast-transcript` job,
 * marks the document `pending` and sends the queue message. The job
 * (`runHostPublish`, wired in functions/podcast-jobs.js) reads the audio from
 * the `podcast` blob container, calls `publishEpisodeToHost` and stores what
 * it returns. Retry is therefore never a regeneration: it re-runs the same
 * step on the same document, and `host-publish.js` updates the Podbean
 * episode the document already names rather than creating a second one.
 *
 * ## Why a job and not an inline call
 *
 * The client's own deadlines are 30 s for the token, 30 s for the upload
 * authorisation, 300 s for the PUT and 30 s for the episode create — over six
 * minutes worst case against an HTTP response bounded at 230 s, and tens of
 * seconds in the ordinary case for a 10 MB MP3. An approval that blocked on
 * that would leave a reviewer watching a spinner for a step whose failure, by
 * design, does not change the approval. So the status is written, the job is
 * queued, the response says `pending` with the job id, and the hub shows
 * "publishing…" until the document says otherwise.
 *
 * ## The record: `host.podbean`
 *
 * The stable keys are `host-publish.js`'s (`episodeId`, `permalinkUrl`,
 * `mediaUrl`, `hostStatus`, `audioPath`, `fileKey`, `publishedAt`,
 * `lastAttemptAt`, `error`). This file adds transient ones it strips before
 * the step runs, so they never leak into a stored success or failure:
 *
 *     pending    true from enqueue until the job writes its outcome
 *     jobId      that job, so the hub can poll getJob
 *     queuedAt   when
 *     skipped    'not_configured' | 'no_audio' | 'not_published' | 'free_plan_licence'
 *     reason     the sentence for it
 *
 * The record was `host.rsscom` until the show moved to Podbean on 2026-10-13
 * (ADR 0029 §1c). Nothing reads that key any more and nothing migrates it:
 * publishing to the old host was never configured, so the only thing a
 * production document ever held there is `skipped: 'not_configured'`, which
 * says nothing about Podbean. A transcript approved before the move shows no
 * host record until its first Podbean attempt, and Publish makes one.
 *
 * `free_plan_licence` is the job's own guard for ElevenLabs free-plan audio
 * (speech-licence.js, ADR 0029 §2a amended 2026-09-26). Approval and the
 * retry route refuse such a transcript with 409 before they get here
 * (handlers.js). The job checks again because it re-reads the document, and a
 * document can become published by some path other than those two.
 *
 * `skipped` is not `error`. Nothing was attempted, so the hub says "not
 * configured" rather than "failed", and the operator's fix is seeding two
 * Key Vault secrets rather than reading an upstream status. A skip clears
 * `error` and a queue clears `skipped`: the record carries one outcome, the
 * latest, and `lastAttemptAt` dates it. The stable keys survive both, so a
 * transcript that already has a host episode keeps showing it while a retry
 * is in flight.
 *
 * ## One reservation per document (#1118)
 *
 * The pending marker is the reservation, and since this change it is
 * etag-conditional: `scheduleHostPublish` writes it with `patchDoc`'s
 * `ifMatch` set to the `_etag` the document was read at, so the write lands
 * only on the version the decision was made about. Before, the in-flight
 * check read `pending` and then wrote it unconditionally, and an approval
 * and a retry landing in the same instant could both pass the check and
 * queue two jobs; two first runs would then both see no earlier attempt and
 * both create, and the feed would carry the episode twice. `host-publish.js`
 * reconciles a create whose answer was lost, but it cannot tell two live
 * creates apart, so creates on one document must be serial, and this is
 * where that is made true.
 *
 * The order is still job document, marker, message — so a marker never
 * names a job that was not written — and a marker refused with 412 means
 * someone else wrote the document between the read and the write. The
 * document is re-read once. A live reservation on it (`pending` with a job
 * still queued or running) is theirs: the loser answers `in_flight` with
 * their job id, exactly as it would had it read the marker in the first
 * place, and cancels the job document it wrote so the stale-queued sweeper
 * (lib/jobs.js) cannot re-enqueue it later and run the second job after
 * all. Anything else — the other job already finished and stored its
 * outcome, a reviewer withdrew the transcript, an unrelated field moved —
 * is not a publish in flight, and answering "in flight" would send the hub
 * to poll a job that does not exist. So the reservation is tried once more
 * against the fresh document, and from its stable record: a marker built
 * from the stale copy would drop an `episodeId` the finished job had just
 * recorded, and the next run would create a second episode — the very
 * thing the condition exists to prevent. A second 412 is answered as
 * `in_flight` if the writer was a reservation and as a thrown
 * `RESERVATION_CONTENDED` otherwise, with the job cancelled either way, so
 * nothing is ever enqueued without a marker that names it. Both callers
 * already handle the throw: the review handler records `SCHEDULE_FAILED`
 * and keeps the approval, the retry route answers 500.
 *
 * The marker write is one `set /host` under an IfMatch condition rather
 * than a `replaceDocIfMatch` of the whole document: one round trip, atomic
 * on the etag, and it carries only the field it changes. Both surface a
 * lost race as `{ code: 412 }`, the shape `lab-agent.js` keys on since #1093.
 *
 * ## What never happens here
 *
 * `status`, `approvedAt` and `approvedBy` are never in a patch this file
 * writes: a publish that fails, or is skipped, leaves the approval exactly
 * as the reviewer made it. And nothing writes `podcasts` — the feed is the
 * ingest boundary (ADR 0029 §1b, "What does not"). The site learns of the
 * episode when `timers/podcasts.js` reads the show's feed, exactly as it
 * does for one uploaded by hand, and the accepted cost is the lag between
 * approval and appearance that the hub explains.
 *
 * ## The article link
 *
 * The job resolves the article's public URL through `publicUrlOf` (the same
 * precedence the Social Hub uses) and hands it to `host-publish.js`, which
 * links it at the end of the episode notes — Podbean has no separate link
 * field. A transcript whose article carries no public URL is published
 * without one. The lookup is injected here so the step is testable without
 * the content container.
 */
import { JOBS_CONTAINER, TERMINAL_JOB_STATUSES, newJobDoc } from '../jobs.js';
import { DEFAULT_AUDIO_MIME, publishEpisodeToHost } from './host-publish.js';
import { freePlanRefusal } from './speech-licence.js';
import { PODCAST_AUDIO_CONTAINER, STATUS, TRANSCRIPT_CONTAINER } from './store.js';

/** The platform job that runs the host step. Registered in functions/podcast-jobs.js. */
export const PUBLISH_JOB_TYPE = 'publish-podcast-transcript';

export const HOST_SKIP = Object.freeze({
  notConfigured: 'not_configured',
  noAudio: 'no_audio',
  notPublished: 'not_published',
  freePlanLicence: 'free_plan_licence',
});

/**
 * Cosmos bounds an item's `id` at 1,023 **bytes** — "Maximum length of ID
 * value: 1,023 bytes", Per-item limits, https://learn.microsoft.com/azure/cosmos-db/concepts-limits#per-item-limits
 * — so the check is on the UTF-8 encoding, not on `String.length`: a
 * 400-character id of three-byte characters is 1,200 bytes and would be
 * refused by Cosmos while passing a character count.
 */
export const MAX_TRANSCRIPT_ID_BYTES = 1023;

/**
 * The one validator for a transcript id, shared by the routes that read or
 * enqueue (`field: 'id'`, the request's name for it) and the worker that runs
 * (`transcriptId`, the payload's), so every door refuses the same input with
 * the same sentence and an oversized id is a 400 here rather than a Cosmos
 * error surfacing as a 500. Returns `{ value }` or `{ error }`.
 *
 * @param {unknown} raw
 * @param {{ field?: string }} [options] the name the sentence uses for the field
 */
export function parseTranscriptId(raw, { field = 'transcriptId' } = {}) {
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!id) return { error: `${field} is required` };
  if (Buffer.byteLength(id, 'utf8') > MAX_TRANSCRIPT_ID_BYTES) {
    return { error: `${field} is too long` };
  }
  return { value: id };
}

const TRANSIENT_KEYS = new Set(['pending', 'jobId', 'queuedAt', 'skipped', 'reason']);

/**
 * The stable half of `host.podbean` — what `host-publish.js` wrote, without
 * the transient keys this file adds. This is what the step is handed as the
 * previous record, so `pending`/`skipped` never ride `...previous` into a
 * stored outcome.
 */
export function stableHostRecord(host) {
  const record = host?.podbean && typeof host.podbean === 'object' ? host.podbean : {};
  const stable = {};
  for (const [key, value] of Object.entries(record)) {
    if (!TRANSIENT_KEYS.has(key)) stable[key] = value;
  }
  return stable;
}

/**
 * Whether there is anything to send, decided without a network call.
 *
 * Configuration first, then the document: until the two secrets are seeded
 * every transcript reads "not configured", which names the one fix; once
 * they are, a transcript without audio reads "no audio", which names the
 * other. Nothing is uploaded without audio. Audio that ElevenLabs rendered
 * on the free plan reads "free plan licence", and is never uploaded either
 * (speech-licence.js).
 *
 * @param {object} doc the transcript document
 * @param {{ ok: boolean, reason?: string }} [configured] `isConfigured(env)` or `client.configured`
 * @returns {{ skipped: string, reason: string } | null}
 */
export function hostSkipFor(doc, configured) {
  if (configured && configured.ok === false) {
    return { skipped: HOST_SKIP.notConfigured, reason: configured.reason };
  }
  if (!doc?.audioPath) {
    const cause = doc?.audioError ? ` (${String(doc.audioError).slice(0, 200)})` : '';
    return {
      skipped: HOST_SKIP.noAudio,
      reason:
        `The transcript has no audio${cause}, so nothing was sent to Podbean; ` +
        'regenerate it once audio synthesis succeeds, then publish again.',
    };
  }
  const refusal = freePlanRefusal(doc);
  if (refusal) return { skipped: HOST_SKIP.freePlanLicence, reason: refusal };
  return null;
}

/** The skip for a transcript that is no longer `published` when the job looks. */
const notPublishedSkip = (doc) => ({
  skipped: HOST_SKIP.notPublished,
  reason:
    `The transcript is ${doc?.status || 'not published'}, so nothing was sent to Podbean; ` +
    'approving it is what publishes it.',
});

const skippedPatch = (doc, skip, at) => ({
  host: {
    podbean: {
      ...stableHostRecord(doc?.host),
      skipped: skip.skipped,
      reason: skip.reason,
      lastAttemptAt: at,
      error: null,
    },
  },
});

const pendingPatch = (doc, jobId, at) => ({
  host: { podbean: { ...stableHostRecord(doc?.host), pending: true, jobId, queuedAt: at } },
});

const patchTranscript = (store, id, patch) =>
  store.patchDoc(TRANSCRIPT_CONTAINER, id, patch, { partitionKey: id });

/**
 * How many versions of the document the reservation is tried against: the
 * one handed in, then one re-read. Each round ends on a read, not a write,
 * so a competitor's reservation is answered as in flight however late it
 * lands; only two consecutive writes by something other than a reservation
 * exhaust it.
 */
export const RESERVATION_ATTEMPTS = 2;

/** The error code when the document moved on every attempt and nothing was queued. */
export const RESERVATION_CONTENDED = 'RESERVATION_CONTENDED';

/**
 * The `_etag` a conditional write needs, or a throw: a document handed over
 * without one cannot be reserved, and writing the marker unconditionally
 * instead would be the race this file exists to close.
 */
function etagOf(doc) {
  const etag = doc?._etag;
  if (typeof etag !== 'string' || etag === '') {
    throw new Error(
      `${PUBLISH_JOB_TYPE}: the transcript carries no _etag, so the pending marker cannot be reserved; nothing was queued`
    );
  }
  return etag;
}

/** Cosmos's answer, and `patchDoc`'s own, when the document changed since it was read. */
const isPreconditionFailure = (err) => err?.code === 412;

/**
 * The reservation: the pending marker, written only if the document is still
 * the version `doc` was read as. Returns the patch written. Throws
 * `{ code: 412 }` when it is not.
 */
async function reservePending(store, doc, jobId, at) {
  const patch = pendingPatch(doc, jobId, at);
  await store.patchDoc(TRANSCRIPT_CONTAINER, doc.id, patch, {
    partitionKey: doc.id,
    ifMatch: etagOf(doc),
  });
  return patch;
}

/**
 * Whether a publish job the document names is still queued or running. A
 * job document that is gone, or terminal, means the marker is stale — an
 * `onComplete` that could not run, a container wiped — and a new job may go.
 */
async function jobInFlight(store, jobId) {
  if (!jobId) return false;
  const job = await store.readDoc(JOBS_CONTAINER, jobId, jobId);
  return Boolean(job) && !TERMINAL_JOB_STATUSES.includes(job.status);
}

/** The document's host record while a live publish job holds it, else null. */
async function liveReservation(store, doc) {
  const current = doc?.host?.podbean;
  if (current?.pending === true && (await jobInFlight(store, current.jobId))) return current;
  return null;
}

/**
 * The job document a lost reservation wrote is never run: no message names
 * it, and marking it terminal keeps the stale-queued sweeper from
 * re-enqueueing it ten minutes on and running the second job after all.
 * Best effort. If this write fails the caller still answers for the job
 * that did win, because the alternative — reporting a failure while a
 * publish is in flight — would have the review handler record
 * `SCHEDULE_FAILED` over the winner's marker and reopen the door to a third
 * job. A job the sweeper does requeue runs the step against a document that
 * by then names the winner's episode, and updates it.
 */
async function releaseJob(store, jobId, at) {
  try {
    await store.patchDoc(JOBS_CONTAINER, jobId, {
      status: 'cancelled',
      finishedAt: at,
      error: 'Not run: another publish of this transcript reserved it first.',
    });
  } catch {
    // See above.
  }
}

/**
 * Decide and record what happens to one approved transcript: skip it on the
 * spot, refuse to double-queue it, or write the job and reserve the document
 * for it.
 *
 * The caller has already checked `status === 'published'`; this does not,
 * because the review handler calls it in the same breath as the status
 * write and holds the pre-write document.
 *
 * `doc` must carry the `_etag` it was read at — the one the status write
 * returned, after an approval — because the pending marker is written only
 * if the document is still that version (see the header, "One reservation
 * per document"). Two schedules racing on one document therefore queue one
 * job: the loser answers `in_flight` naming the winner's job.
 *
 * @param {object} deps
 * @param {{ readDoc: Function, upsertDoc: Function, patchDoc: Function }} deps.store
 * @param {object} deps.doc the transcript as stored, with its `_etag`
 * @param {{ ok: boolean, reason?: string }} deps.configured `isConfigured(env)`
 * @param {(message: { jobId: string, type: string }) => void} deps.enqueue the queue output
 * @param {{ oid?: string, email?: string }} [deps.requestedBy]
 * @param {() => string} [deps.uuid]
 * @param {() => Date} [deps.now]
 * @returns {Promise<{ outcome: 'skipped' | 'in_flight' | 'queued', host: object, jobId?: string }>}
 * @throws when `doc` has no `_etag` (before any write), when no queue output
 *   is wired, when the transcript is gone on the re-read
 *   (`code: 'TRANSCRIPT_NOT_FOUND'`), or when the document changed on every
 *   attempt (`code: RESERVATION_CONTENDED`). Nothing is enqueued on any of them.
 */
export async function scheduleHostPublish({
  store,
  doc,
  configured,
  enqueue,
  requestedBy,
  uuid = () => crypto.randomUUID(),
  now = () => new Date(),
}) {
  const id = doc.id;
  const at = now().toISOString();

  const skip = hostSkipFor(doc, configured);
  if (skip) {
    const patch = skippedPatch(doc, skip, at);
    await patchTranscript(store, id, patch);
    return { outcome: 'skipped', host: patch.host.podbean };
  }

  const held = await liveReservation(store, doc);
  if (held) return { outcome: 'in_flight', jobId: held.jobId, host: held };

  if (typeof enqueue !== 'function') {
    throw new Error(`${PUBLISH_JOB_TYPE}: no queue output wired`);
  }
  // Refused before the job document exists, so a caller that lost the etag
  // leaves nothing behind for the sweeper.
  etagOf(doc);

  // Job document first, then the marker, then the message — the same order
  // as enqueueJob, so a marker never names a job that was not written, and a
  // message lost after the write is the sweeper's ordinary case.
  const jobId = uuid();
  await store.upsertDoc(
    JOBS_CONTAINER,
    newJobDoc({
      id: jobId,
      type: PUBLISH_JOB_TYPE,
      payload: { transcriptId: id },
      requestedBy,
      createdAt: at,
    })
  );

  let current = doc;
  for (let attempt = 1; attempt <= RESERVATION_ATTEMPTS; attempt += 1) {
    try {
      const patch = await reservePending(store, current, jobId, at);
      enqueue({ jobId, type: PUBLISH_JOB_TYPE });
      return { outcome: 'queued', jobId, host: patch.host.podbean };
    } catch (err) {
      if (!isPreconditionFailure(err)) throw err;
    }

    // Someone wrote the document between the read and the write. Their live
    // reservation is the answer; anything else is tried once more against
    // the fresh document, whose stable record the marker must now carry.
    current = await store.readDoc(TRANSCRIPT_CONTAINER, id, id);
    if (!current) {
      await releaseJob(store, jobId, at);
      throw Object.assign(new Error('podcast transcript not found'), {
        code: 'TRANSCRIPT_NOT_FOUND',
        transcriptId: id,
      });
    }
    const theirs = await liveReservation(store, current);
    if (theirs) {
      await releaseJob(store, jobId, at);
      return { outcome: 'in_flight', jobId: theirs.jobId, host: theirs };
    }
  }

  await releaseJob(store, jobId, at);
  throw Object.assign(
    new Error(
      `${PUBLISH_JOB_TYPE}: the transcript changed on every attempt to reserve it; nothing was queued`
    ),
    // `latest` is the document as last re-read, so a failure record written
    // for this error conditions on it rather than on the stale copy the
    // caller holds (CodeRabbit on #1125): a winner's episodeId stays.
    { code: RESERVATION_CONTENDED, transcriptId: id, latest: current }
  );
}

/**
 * The approval was written but the host step could not be queued — a jobs
 * container write or the pending patch threw, or the reservation was
 * contended on every attempt. Persist that as a terminal, retryable record
 * so the hub shows "publish failed, retry" after a refresh rather than the
 * stale `host` it would otherwise read. Best effort: this never throws,
 * because the approval has already happened and must be reported as such
 * whatever the second write does. Returns whether the record was stored.
 *
 * Unconditional on purpose: `doc` is the pre-approval read, whose etag the
 * status write has already moved past, and a record that exists to say
 * "nothing was queued" has no version to be conditional on.
 *
 * @param {object} deps
 * @param {{ patchDoc: Function }} deps.store
 * @param {object} deps.doc the transcript as read before the approval
 * @param {() => Date} [deps.now]
 * @returns {Promise<boolean>}
 */
export async function recordScheduleFailure({ store, doc, now = () => new Date() }) {
  // No document, or one read without its `_etag`: nothing this can condition
  // on, so nothing is written. An unconditional write here would be the race
  // the reservation closes, by another door (CodeRabbit on #1125).
  if (!doc?.id || !doc._etag) return false;
  const patch = {
    host: {
      podbean: {
        ...stableHostRecord(doc?.host),
        lastAttemptAt: now().toISOString(),
        error: {
          status: null,
          code: 'SCHEDULE_FAILED',
          message:
            'The approval was saved, but the Podbean publish could not be queued; use Publish to retry.',
          retryable: true,
        },
      },
    },
  };
  try {
    // Conditional on the version the record was built from, when one is
    // known: a 412 means a newer reservation or outcome landed since, and
    // overwriting it with this stale record could drop a winner's episodeId
    // (CodeRabbit on #1125). That newer state stands; false says so.
    await store.patchDoc(TRANSCRIPT_CONTAINER, doc.id, patch, {
      partitionKey: doc.id,
      ifMatch: doc._etag,
    });
    return true;
  } catch {
    return false;
  }
}

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
 * @param {object} deps
 * @param {{ readDoc: Function, patchDoc: Function }} deps.store
 * @param {string} deps.id
 * @param {'failed' | 'timeout' | string} deps.status the job's terminal status
 * @param {string|null} deps.error the job's recorded error text
 * @param {() => Date} [deps.now]
 * @returns {Promise<boolean>} whether a record was written
 */
export async function recordHostJobFailure({ store, id, status, error, now = () => new Date() }) {
  const doc = await store.readDoc(TRANSCRIPT_CONTAINER, id, id);
  if (!doc || doc.host?.podbean?.pending !== true) return false;
  const at = now().toISOString();

  const patch =
    doc.status !== STATUS.published
      ? skippedPatch(doc, notPublishedSkip(doc), at)
      : {
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
  await patchTranscript(store, id, patch);
  return true;
}
