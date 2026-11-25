/**
 * labs/visitor-refunds.js — giving a visitor's daily start back, at most
 * once, when the start never ran (visitor-session.js has the header that
 * explains it).
 */
import { errorKind } from './visitor-session.js';
import { isConflict, QUOTA_CONTAINER } from './visitor-slots.js';

/**
 * A daily start is given back at most once, and a give-back that fails is
 * tried again (#1464 review, finding C and round 2). The start's counter
 * (`visitor-quota:<hash>:<day>`) is never decreased. Instead a start that made
 * no lab writes a refund document, `visitor-refund:<session id>`, with a
 * create: a second create of the same id is refused (409) and counts as done,
 * so however many requests or sweeps try, there is one refund per session.
 * The start then allows the daily limit plus the refunds of that counter
 * (`countRefunds`). A query that misses a refund just written only refuses a
 * start it could have allowed, which is the safe side.
 *
 * The record says where it is in `dailyCapRefund`: `pending` while the start
 * is under way or its refund is not yet written, `given` once the refund
 * document exists, `spent` once the session started. The marker turns to
 * `given` only after the document is written, so a refund that failed is
 * still `pending`, and the sweep writes it on its next try before it saves the
 * record as over.
 */
export const DAILY_CAP_REFUND = Object.freeze({ pending: 'pending', given: 'given', spent: 'spent' });
export const REFUND_PREFIX = 'visitor-refund:';
/** A refund lives as long as the counter it adds to (two days, the counter's own ttl). */
export const REFUND_TTL_SECONDS = 86400 * 2;

/**
 * Does this record still owe its daily start back? Only a start that never
 * ran says `pending` (a session that started says `spent`, and one saved before
 * the marker existed says nothing), so the marker alone answers it, whatever
 * the record's status is now (a claim makes it `ending`).
 */
export function refundOwed(record) {
  return record?.dailyCapRefund === DAILY_CAP_REFUND.pending && typeof record.dailyCap?.id === 'string';
}

/**
 * Write the refund document of a start that made no lab. True when it exists
 * now (written here, or by an earlier try: 409); false when it could not be
 * written, for the caller to try again later. Never throws.
 */
export async function recordRefund(store, record, nowMs, log) {
  if (typeof store.createDoc !== 'function' || typeof record?.dailyCap?.id !== 'string') return false;
  try {
    await store.createDoc(QUOTA_CONTAINER, {
      id: `${REFUND_PREFIX}${record.id}`,
      kind: 'visitor_refund',
      quotaId: record.dailyCap.id,
      createdAt: new Date(nowMs).toISOString(),
      ttl: REFUND_TTL_SECONDS,
    });
    return true;
  } catch (error) {
    if (isConflict(error)) return true;
    log?.(`visitor-session: a daily start could not be given back yet (${errorKind(error)})`);
    return false;
  }
}

export const REFUND_QUERY = 'SELECT * FROM c WHERE c.kind = @kind AND c.quotaId = @quotaId';

/** How many starts of this counter were given back. Store faults are thrown. */
export async function countRefunds(store, quotaId) {
  const rows = await store.queryDocs(QUOTA_CONTAINER, REFUND_QUERY, [
    { name: '@kind', value: 'visitor_refund' },
    { name: '@quotaId', value: quotaId },
  ]);
  return Array.isArray(rows) ? rows.length : 0;
}
