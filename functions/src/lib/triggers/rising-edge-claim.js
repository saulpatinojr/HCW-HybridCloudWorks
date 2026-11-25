/**
 * rising-edge-claim.js — "run this once per request" for flag-driven triggers.
 *
 * Ported from Site-Main `lib/triggers/rising-edge-claim.js` (088f458). A
 * trigger watching a boolean request flag reads LIVE state and records a claim
 * on the document — the claiming delivery's event id and when — so a
 * redelivery of the same write, a flag already cleared by the first run, and a
 * concurrent delivery all skip. The claim goes FIRST (opposite of the value
 * marker): the work is expensive and one-shot, so a crash costs one lost
 * request instead of a second paid image generation.
 *
 * On Cosmos the single-document transaction is an etag-conditioned replace:
 * read, evaluate, replace-if-match, retry on 412.
 */

/** A claim older than this is abandoned and taken over. Must outlast the longest claiming run. */
export const DEFAULT_CLAIM_TIMEOUT_MS = 15 * 60 * 1000;

export const SKIP_REASONS = Object.freeze({
  DOCUMENT_MISSING: 'document_missing',
  FLAG_NOT_SET: 'flag_not_set',
  ALREADY_RUN_BY_THIS_EVENT: 'already_run_by_this_event',
  CLAIMED_BY_ANOTHER_RUN: 'claimed_by_another_run',
  CLAIM_TIMESTAMP_UNREADABLE: 'claim_timestamp_unreadable',
  CLAIM_CONTENDED: 'claim_contended',
});

export const CLAIM_REASONS = Object.freeze({
  CLAIMED: 'claimed',
  RECLAIMED_STALE: 'reclaimed_stale',
});

function toMillis(value) {
  if (value === null || value === undefined) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Decide whether this delivery should do the work. Pure.
 * @param {object|null|undefined} data - LIVE document data
 * @param {{ flagField: string, claimField: string, claimedAtField: string, eventId: string, now: number, claimTimeoutMs?: number }} spec
 * @returns {{ claim: boolean, reason: string }}
 */
export function evaluateRisingEdgeClaim(data, spec) {
  if (!data) return { claim: false, reason: SKIP_REASONS.DOCUMENT_MISSING };
  if (data[spec.flagField] !== true) return { claim: false, reason: SKIP_REASONS.FLAG_NOT_SET };
  const existingClaim = data[spec.claimField];
  if (!existingClaim) return { claim: true, reason: CLAIM_REASONS.CLAIMED };
  return existingClaimDecision(data, existingClaim, spec);
}

/** The decision when the document already carries a claim: this event's, a live one, or a stale one. */
function existingClaimDecision(
  data,
  existingClaim,
  { claimedAtField, eventId, now, claimTimeoutMs = DEFAULT_CLAIM_TIMEOUT_MS }
) {
  if (existingClaim === eventId)
    return { claim: false, reason: SKIP_REASONS.ALREADY_RUN_BY_THIS_EVENT };
  const claimedAt = toMillis(data[claimedAtField]);
  // A claim we cannot date is refused, not taken over: stalling is visible and
  // cheap, running twice is silent and paid.
  if (claimedAt === null) return { claim: false, reason: SKIP_REASONS.CLAIM_TIMESTAMP_UNREADABLE };
  if (now - claimedAt < claimTimeoutMs)
    return { claim: false, reason: SKIP_REASONS.CLAIMED_BY_ANOTHER_RUN };
  return { claim: true, reason: CLAIM_REASONS.RECLAIMED_STALE };
}

/** The fields a completion (or failure) write uses to release a claim. */
export function releaseRisingEdgeClaim({ claimField, claimedAtField }) {
  return { [claimField]: null, [claimedAtField]: null };
}

/**
 * Take the claim against live state with an etag-conditioned replace.
 *
 * @param {{ readDoc: Function, replaceDocIfMatch: Function }} store
 * @param {string} containerName
 * @param {string} id
 * @param {{ flagField: string, claimField: string, claimedAtField: string, eventId: string, now?: () => Date, attempts?: number }} spec
 * @returns {Promise<{ claim: boolean, reason: string, data: object|null }>}
 */
export async function claimRisingEdge(store, containerName, id, spec) {
  const now = spec.now || (() => new Date());
  const attempts = spec.attempts || 3;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const data = await store.readDoc(containerName, id, id);
    const decision = evaluateRisingEdgeClaim(data, { ...spec, now: now().getTime() });
    if (!decision.claim) return { ...decision, data };
    const claimed = {
      ...data,
      [spec.claimField]: spec.eventId,
      [spec.claimedAtField]: now().toISOString(),
    };
    try {
      const stored = await store.replaceDocIfMatch(containerName, claimed);
      return { claim: true, reason: decision.reason, data: stored || claimed };
    } catch (err) {
      if (err?.code !== 412 && err?.statusCode !== 412) throw err;
      // Someone else wrote between read and replace; re-read and re-evaluate.
    }
  }
  return { claim: false, reason: SKIP_REASONS.CLAIM_CONTENDED, data: null };
}
