/**
 * labs/visitor-claim.js — taking a visitor session for its clean-up
 * (visitor-end.js ends it; visitor-session.js has the header that explains
 * the sessions): which records may be taken now, and the claim itself, under
 * the record's ETag, so only one request makes the Coder calls.
 */
import {
  CLEANUP_LEASE_MS,
  FINISH_ATTEMPTS,
  lostRace,
  SESSION_CONTAINER,
  SESSION_STATUS,
  VISITOR_PENDING_DOC_TTL_SECONDS,
} from './visitor-model.js';

/** A count stored in a record: a negative, fractional or text one counts as none. */
export const countOf = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);

/**
 * Can this record be taken up by a stop or the sweep now? An `active` one, or
 * one whose time has come (`retryAt` reached) and that is: cleaning up
 * (`ending`, a claim whose lease has run out), waiting for its next try
 * (`cleanup_pending`), a start whose process never finished
 * (`provisioning`, its lease run out) or a given-up one due another round
 * (`cleanup_failed` with a `retryAt`).
 */
export function claimable(record, nowIso) {
  if (record.status === SESSION_STATUS.active) return true;
  const waiting = [
    SESSION_STATUS.ending,
    SESSION_STATUS.cleanupPending,
    SESSION_STATUS.provisioning,
    SESSION_STATUS.cleanupFailed,
  ].includes(record.status);
  return waiting && typeof record.retryAt === 'string' && record.retryAt <= nowIso;
}

/**
 * Take a session for clean-up, under the ETag it was read with, so that only
 * one request does the Coder calls: the winner gets `ending`, with a lease, a
 * count of tries and a longer `ttl`; the loser is refused with a 412.
 *
 * A claim drops the lab's address (`accessUrl`, #1403 item 6): only a running
 * session needs it, and a record that waits for its clean-up can wait a week.
 * A given-up record claimed for another round starts its count of tries again
 * and counts the round (`cleanupRounds`).
 *
 * Losing is not a failure. A stop and a sweep, or two stops, reach the same
 * session at once. The loser reads the record again: no longer claimable means
 * the winner has it (`taken-elsewhere`), gone means its `ttl` ran out
 * (`gone`); still claimable means something else changed it, and the claim is
 * tried again on the new version, up to FINISH_ATTEMPTS times, then `changed`.
 * Any other error is a real failure and is thrown.
 *
 * `replaceDocIfMatch(containerName, document, options)` takes the whole
 * document, `_etag` inside it, and the partition key in the options (#1383).
 *
 * @returns {Promise<{ outcome: 'claimed', session: object } | { outcome: 'taken-elsewhere', status: string } | { outcome: 'gone' | 'changed' }>}
 *   `status` is what the record that another request holds says now
 */
export async function claimSession(store, session, endStatus, nowMs) {
  if (typeof store.replaceDocIfMatch !== 'function') return claimWithoutEtag(store, session, endStatus, nowMs);

  const nowIso = new Date(nowMs).toISOString();
  let current = session;
  for (let attempt = 0; attempt < FINISH_ATTEMPTS; attempt += 1) {
    const won = await tryClaim(store, current, endStatus, nowMs);
    if (won) return won;
    current = await store.readDoc(SESSION_CONTAINER, session.id, session.id);
    const lost = lostClaim(current, nowIso);
    if (lost) return lost;
  }
  return { outcome: 'changed' };
}

/** The record as a claim writes it: `ending`, with a lease, a count of tries and a longer `ttl`, and no lab address. */
function claimOf({ accessUrl: _address, ...record }, endStatus, nowMs) {
  const newRound = record.status === SESSION_STATUS.cleanupFailed;
  return {
    ...record,
    status: SESSION_STATUS.ending,
    // Only the two final statuses a session can have; a record that says anything else gets the one asked for.
    endStatus: [SESSION_STATUS.ended, SESSION_STATUS.expired].includes(record.endStatus) ? record.endStatus : endStatus,
    endedAt: record.endedAt ?? new Date(nowMs).toISOString(),
    // A count: a negative or fractional one would never reach the bound.
    cleanupAttempts: newRound ? 1 : countOf(record.cleanupAttempts) + 1,
    ...(newRound ? { cleanupRounds: countOf(record.cleanupRounds) + 1 } : {}),
    retryAt: new Date(nowMs + CLEANUP_LEASE_MS).toISOString(),
    ttl: VISITOR_PENDING_DOC_TTL_SECONDS,
  };
}

/**
 * A store without conditional writes, which the Functions app never has
 * (labs-public-http.js hands it cosmos-client.js's): unconditional, so no
 * protection against a second request. One that cannot save at all must
 * not report that it did.
 */
async function claimWithoutEtag(store, session, endStatus, nowMs) {
  if (typeof store.upsertDoc !== 'function') {
    throw new TypeError('The store given to the visitor sessions cannot save a session record.');
  }
  const claimed = claimOf(session, endStatus, nowMs);
  await store.upsertDoc(SESSION_CONTAINER, claimed);
  return { outcome: 'claimed', session: claimed };
}

/** One claim under the record's ETag: the claimed outcome, or null when another writer got there first. */
async function tryClaim(store, current, endStatus, nowMs) {
  try {
    const claimed = claimOf(current, endStatus, nowMs);
    const saved = await store.replaceDocIfMatch(SESSION_CONTAINER, claimed, {
      partitionKey: current.id,
    });
    return { outcome: 'claimed', session: saved ?? claimed };
  } catch (error) {
    if (!lostRace(error)) throw error;
    return null;
  }
}

/** After a lost claim: gone, or held by the winner (no longer claimable); null when it may be tried again. */
function lostClaim(current, nowIso) {
  if (!current) return { outcome: 'gone' };
  if (!claimable(current, nowIso)) return { outcome: 'taken-elsewhere', status: current.status };
  return null;
}
