/**
 * labs/visitor-slots.js — the documents that make a visitor start atomic:
 * the per-visitor start lock and the concurrent-lab slots (visitor-
 * session.js has the header that explains them).
 */
import { lostRace, mayHoldLab, PROVISION_LEASE_MS, SESSION_CONTAINER } from './visitor-model.js';

/**
 * The documents that make a start atomic (#1464 review, finding A). They live
 * in `submission_quota` (partition key `/id`, beside the daily counters), and
 * each is taken with a create that Cosmos refuses with 409 when the id is
 * already there, so two requests cannot both take one, however close together
 * they run and whatever a query would have shown each of them.
 *
 *  - `visitor-start:<hash>`: one start at a time per visitor. It holds for
 *    PROVISION_LEASE_MS (`expiresAt`), is let go when the start ends, and a
 *    lock whose time has passed is taken over with a conditional replace.
 *  - `visitor-slot:<n>` for n below the concurrent limit: one per lab the
 *    visitors may hold at once, and every holder owns one (round 3): a
 *    record that may still hold a lab, or a start that has taken its slot and
 *    not yet written its record. Under the start lock, a holding record that
 *    no slot names is given one first, and only then does the start take its
 *    own, or is refused as full. A slot never ages out (`ttl: -1`). It is let
 *    go when its session no longer holds a lab, and one that was never let go
 *    (its process died) is taken over only once it is older than
 *    PROVISION_LEASE_MS and its holder no longer holds a lab, so the slots
 *    mend themselves and cannot stay full for ever.
 */
export const QUOTA_CONTAINER = 'submission_quota';
export const START_LOCK_PREFIX = 'visitor-start:';
export const SLOT_PREFIX = 'visitor-slot:';

export const isConflict = (error) => error?.code === 409 || error?.statusCode === 409;

/** Take the visitor's start lock, or null when another start of theirs holds it. Store faults are thrown. */
export async function takeStartLock(store, clientHash, sessionId, nowMs) {
  const id = `${START_LOCK_PREFIX}${clientHash}`;
  const lock = {
    id,
    kind: 'visitor_start_lock',
    sessionId,
    expiresAt: new Date(nowMs + PROVISION_LEASE_MS).toISOString(),
    ttl: Math.ceil(PROVISION_LEASE_MS / 1000),
  };
  try {
    return (await store.createDoc(QUOTA_CONTAINER, lock)) ?? lock;
  } catch (error) {
    if (!isConflict(error)) throw error;
  }
  const current = await store.readDoc(QUOTA_CONTAINER, id, id);
  if (!current || current.expiresAt > new Date(nowMs).toISOString()) return null;
  try {
    return await store.replaceDocIfMatch(QUOTA_CONTAINER, { ...lock, _etag: current._etag }, { partitionKey: id });
  } catch (error) {
    if (lostRace(error)) return null;
    throw error;
  }
}

/** Let the start lock go by marking it run out. A failure is no fault: it runs out on its own. */
export async function releaseStartLock(store, lock, nowMs) {
  if (!lock?._etag || typeof store.replaceDocIfMatch !== 'function') return;
  try {
    await store.replaceDocIfMatch(
      QUOTA_CONTAINER,
      { ...lock, sessionId: null, expiresAt: new Date(nowMs).toISOString() },
      { partitionKey: lock.id }
    );
  } catch {
    // Another start took it over, or it aged out: either way it is not ours.
  }
}

/** Is a taken slot free to take over? Let go, or old enough to judge and its session holds no lab. */
export async function slotIsFree(store, slot, nowMs) {
  if (!slot.sessionId) return true;
  const takenMs = Date.parse(slot.takenAt);
  if (!Number.isFinite(takenMs) || takenMs > nowMs - PROVISION_LEASE_MS) return false;
  const holder = await store.readDoc(SESSION_CONTAINER, slot.sessionId, slot.sessionId);
  return !mayHoldLab(holder);
}

/**
 * A slot document never ages out (`ttl: -1` on the item, since the
 * container's own default is two hours) (#1464 review, round 3). It is let go
 * when its session's clean-up is confirmed (`releaseSlot`), or taken over
 * after the holder check (`slotIsFree`), and by nothing else: a slot that aged
 * out while its record still held a lab would let a new start take it while
 * the old workspace was still on the host.
 */
export const SLOT_TTL_SECONDS = -1;

/**
 * Take one of the `max` slots for `holderId` (a new start's session, or a
 * holding record that no slot names yet): its number, or null when all are
 * held. A slot that already names the holder is its own, also when another
 * start wrote it a moment ago. Store faults are thrown.
 */
export async function takeSlot(store, holderId, max, nowMs) {
  const nowIso = new Date(nowMs).toISOString();
  for (let n = 0; n < max; n += 1) {
    if (await tryTakeSlot(store, n, holderId, { nowMs, nowIso })) return n;
  }
  return null;
}

/** Slot `n` for this holder: made new, already its own, or taken over once free; false when another holds it. */
async function tryTakeSlot(store, n, holderId, { nowMs, nowIso }) {
  const id = `${SLOT_PREFIX}${n}`;
  const slot = { id, kind: 'visitor_slot', sessionId: holderId, takenAt: nowIso, ttl: SLOT_TTL_SECONDS };
  try {
    await store.createDoc(QUOTA_CONTAINER, slot);
    return true;
  } catch (error) {
    if (!isConflict(error)) throw error;
  }
  const current = await store.readDoc(QUOTA_CONTAINER, id, id);
  if (current?.sessionId === holderId) return true;
  if (!current || !(await slotIsFree(store, current, nowMs))) return false;
  try {
    await store.replaceDocIfMatch(QUOTA_CONTAINER, { ...slot, _etag: current._etag }, { partitionKey: id });
    return true;
  } catch (error) {
    if (!lostRace(error)) throw error;
    const after = await store.readDoc(QUOTA_CONTAINER, id, id);
    return after?.sessionId === holderId;
  }
}

/** The ids the `max` slot documents name now (a slot let go names none). Store faults are thrown. */
export async function slotHolders(store, max) {
  const ids = new Set();
  for (let n = 0; n < max; n += 1) {
    const id = `${SLOT_PREFIX}${n}`;
    const doc = await store.readDoc(QUOTA_CONTAINER, id, id);
    if (typeof doc?.sessionId === 'string' && doc.sessionId) ids.add(doc.sessionId);
  }
  return ids;
}

/**
 * Let a session's slot go, when its record says it no longer holds a lab.
 * Only the session that holds the slot lets it go; a failure is no fault,
 * because a slot that was not let go is taken over later (`slotIsFree`).
 */
export async function releaseSlot(store, record, nowMs) {
  if (!Number.isInteger(record?.slot) || typeof store.replaceDocIfMatch !== 'function') return;
  const id = `${SLOT_PREFIX}${record.slot}`;
  try {
    const current = await store.readDoc(QUOTA_CONTAINER, id, id);
    if (!current || current.sessionId !== record.id) return;
    await store.replaceDocIfMatch(
      QUOTA_CONTAINER,
      { ...current, sessionId: null, freedAt: new Date(nowMs).toISOString() },
      { partitionKey: id }
    );
  } catch {
    // Taken over later by a start, once it is old enough.
  }
}
