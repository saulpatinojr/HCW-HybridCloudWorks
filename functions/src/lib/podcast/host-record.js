/**
 * host-record.js — the transcript's `host.podbean` record and the checks
 * around it, shared by the two halves of the host step in
 * publish-transcript.js (the route's reservation) and publish-job.js (the
 * job's run): the transcript id rule, the skips, and the patches that write
 * the record. publish-transcript.js says how the record is used, and
 * exports the shared names again.
 */
import { freePlanRefusal } from './speech-licence.js';
import { TRANSCRIPT_CONTAINER } from './store.js';

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
    const stored = doc?.audioError ? ` (${String(doc.audioError).slice(0, 200)})` : '';
    return {
      skipped: HOST_SKIP.noAudio,
      reason:
        `The transcript has no audio${stored}, so nothing was sent to Podbean; ` +
        'regenerate it once audio synthesis succeeds, then publish again.',
    };
  }
  const refusal = freePlanRefusal(doc);
  if (refusal) return { skipped: HOST_SKIP.freePlanLicence, reason: refusal };
  return null;
}

/** The skip for a transcript that is no longer `published` when the job looks. */
export const notPublishedSkip = (doc) => ({
  skipped: HOST_SKIP.notPublished,
  reason:
    `The transcript is ${doc?.status || 'not published'}, so nothing was sent to Podbean; ` +
    'approving it is what publishes it.',
});

export const skippedPatch = (doc, skip, at) => ({
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

export const pendingPatch = (doc, jobId, at) => ({
  host: { podbean: { ...stableHostRecord(doc?.host), pending: true, jobId, queuedAt: at } },
});

export const patchTranscript = (store, id, patch) =>
  store.patchDoc(TRANSCRIPT_CONTAINER, id, patch, { partitionKey: id });

/** Cosmos's answer, and `patchDoc`'s own, when the document changed since it was read. */
export const isPreconditionFailure = (err) => err?.code === 412;

