/**
 * developer-api/guard.js — who may call the keyed routes of the Developer API
 * (ADR 0042), following the Agent Content API's guard (ADR 0037,
 * lib/agent-content/guard.js) and the lab agent's (lib/auth/require-agent.js).
 *
 * A separate guard per machine caller: an admin token does not pass here, and
 * neither does Koda's key (a different prefix, refused before any read). The
 * route-inventory test mocks this module by name, so a route that uses it
 * counts as guarded there.
 *
 * Three gates, in order, and a refusal at any of them reads nothing further:
 *
 *   1. The presented value is shaped like an organizer key (keys.js
 *      parseKey). A random token is refused before the database is read.
 *   2. The record the key names exists, is not revoked, and its hash matches,
 *      compared in constant time. No cache: revoking a key in the admin must
 *      cut the next request.
 *   3. The key is under its per-minute limit, counted with the same
 *      compare-and-increment counter the public submission routes use
 *      (submissions.js enforceSubmissionQuota), keyed by key and minute.
 *
 * Then the scope the route needs must be on the key.
 *
 * Every refusal of a presented key whose id names a real record (wrong,
 * revoked, over the limit, or without the scope) is one `admin_audit_logs` row of kind
 * developer-api-denial, with the reason and the key id, never the key. A
 * request with no key, or a value not shaped like one, is refused without a
 * row: internet probes would otherwise be a write each. 401 for a missing,
 * wrong or revoked key (one sentence for all three, so the wording does not say
 * whether a key exists), 403 for a scope that is off, 429 with Retry-After for
 * the limit.
 *
 * THE ROWS ARE CAPPED PER KEY ID (#1777). A key's id is the first part of the
 * key and is not secret, so a caller who has seen one can send wrong keys
 * under it as fast as they like, and the per-minute limit above never counts
 * them (it counts only a key that was right). Wrong, revoked and over-the-limit
 * refusals are therefore counted per key id per minute, through the same
 * counter, and after REFUSAL_ROWS_PER_MINUTE of them the refusal is still
 * answered but writes no row until the next minute, except one: the first
 * refusal past the cap writes a single `developer_api_refusal_cap_reached`
 * row (the key id only), so a reader of the audit log can see that rows were
 * held back in that minute and that a missing reason is not proof it did not
 * happen. The organizer's own right key is never slowed by someone else's
 * wrong ones: a right key under its own limit never reaches this counter.
 *
 * WHAT THE ANSWER DOES AND DOES NOT HIDE. The status and the body are the
 * same for an id that names no key, a wrong key and a revoked key, so the
 * answer itself does not say whether an id is real. Timing is not equalised:
 * a refusal on a real id waits for its counter and its audit row, so it takes
 * longer than a refusal on an id that names nothing. That is accepted (ADR
 * 0042, accepted risks): a key id is 64 random bits and is not treated as a
 * secret.
 */
import { writeDenialAudit } from '../auth/denial-audit.js';
import {
  ADMIN_CONFIG_PARTITION,
  createDoc,
  incrementIf,
  patchDoc,
  readDoc,
  replaceDocIfMatch,
} from '../cosmos-client.js';
import { enforceSubmissionQuota } from '../submissions.js';
import {
  REQUESTS_PER_MINUTE,
  SCOPES,
  developerKeyFrom,
  hashMatches,
  isUsable,
  keyRecordId,
  organizerUser,
  parseKey,
  quotaKeyFor,
  refusalQuotaKeyFor,
  scopesOf,
  secondsToNextMinute,
} from './keys.js';

/** How often lastUsedAt is written: a stamp per call would be a write per call. */
export const LAST_USED_EVERY_MS = 5 * 60 * 1000;
/** Audit rows a minute for wrong, revoked or over-the-limit refusals on one key id. Past it: refused, no row. */
export const REFUSAL_ROWS_PER_MINUTE = 10;
/** The one row written when that cap is first reached in a minute. Its `kind` and `action` in admin_audit_logs. */
export const REFUSAL_CAP_REACHED = 'developer_api_refusal_cap_reached';

const UNAUTHENTICATED =
  'Authentication required: send your organizer key as a Bearer token. The key is missing, wrong or revoked.';

const deny = (status, code, error, headers = {}) => ({
  status,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify({ ok: false, code, error }),
});

const labelOf = (scope) => SCOPES.find((entry) => entry.id === scope)?.label || scope;

/**
 * @param {object} deps
 * @param {{ readDoc: Function, patchDoc: Function, incrementIf: Function, createDoc: Function,
 *   replaceDocIfMatch: Function }} deps.store
 * @param {() => number} [deps.now] epoch milliseconds
 * @param {(entry: object) => unknown} [deps.auditDenial] never awaited; must not throw
 * @param {number} [deps.requestsPerMinute]
 * @param {number} [deps.refusalRowsPerMinute]
 */
export function createDeveloperApiGuard({
  store,
  now = Date.now,
  auditDenial = null,
  requestsPerMinute = REQUESTS_PER_MINUTE,
  refusalRowsPerMinute = REFUSAL_ROWS_PER_MINUTE,
}) {
  if (!store) throw new Error('createDeveloperApiGuard requires a store');

  const audit = (entry) => {
    try {
      const result = auditDenial?.({ kind: 'developer-api-denial', ...entry });
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // The denial answer is unchanged when the audit sink fails.
    }
  };

  /**
   * The row for a refusal that costs the caller nothing to repeat: counted
   * per key id per minute, and written only while under the cap. A fault in
   * the counter (not the cap itself) still writes the row: losing the cap for
   * a moment is better than losing the record of a refusal.
   *
   * Past the cap the same counter is asked once more with a limit one higher.
   * Exactly one caller a minute passes that (the compare-and-increment has
   * one winner), and that one writes the "cap reached" row. Everyone after it
   * is refused both times and writes nothing.
   */
  const auditRefusal = async (keyId, reason, nowMs) => {
    const quotaKey = refusalQuotaKeyFor(keyId, nowMs);
    try {
      await enforceSubmissionQuota(store, quotaKey, { now: nowMs, limit: refusalRowsPerMinute });
    } catch (error) {
      if (error?.code === 'SUBMISSION_RATE_LIMIT') {
        try {
          await enforceSubmissionQuota(store, quotaKey, { now: nowMs, limit: refusalRowsPerMinute + 1 });
        } catch {
          // Already noted this minute, or the counter failed: stay silent.
          return;
        }
        audit({ kind: REFUSAL_CAP_REACHED, outcome: 'rows-held-back', keyId });
        return;
      }
    }
    audit({ outcome: 'denied', reason, keyId });
  };

  /** lastUsedAt, at most once per LAST_USED_EVERY_MS, best effort and never awaited. */
  const touchLastUsed = (record, nowMs) => {
    const last = Date.parse(record.lastUsedAt || '') || 0;
    if (nowMs - last < LAST_USED_EVERY_MS) return;
    Promise.resolve()
      .then(() =>
        store.patchDoc(
          'admin_config',
          record.id,
          { lastUsedAt: new Date(nowMs).toISOString() },
          { partitionKey: ADMIN_CONFIG_PARTITION },
        ),
      )
      .catch(() => {});
  };

  const unauthenticated = () => ({ record: null, user: null, error: deny(401, 'UNAUTHENTICATED', UNAUTHENTICATED) });

  /** The three gates. Resolves `{ record, user }` or `{ error }`, where `error` is the HTTP answer. */
  async function authenticate(request) {
    const secret = developerKeyFrom(request);
    const parsed = parseKey(secret);
    // Missing, or not shaped like an organizer key: no credential at all,
    // refused without a read and without an audit row.
    if (!parsed) return unauthenticated();

    const record = await store.readDoc('admin_config', keyRecordId(parsed.keyId), ADMIN_CONFIG_PARTITION);
    const nowMs = now();
    if (!isUsable(record)) {
      // An id that names no record gets no row: anyone can make a value of the
      // right shape, and a row each would let one caller turn requests into
      // audit writes. A revoked key is a real key still in use, worth a row.
      if (record) await auditRefusal(parsed.keyId, 'revoked-key', nowMs);
      return unauthenticated();
    }
    if (!hashMatches(secret, record.keyHash)) {
      await auditRefusal(parsed.keyId, 'wrong-key', nowMs);
      return unauthenticated();
    }

    try {
      await enforceSubmissionQuota(store, quotaKeyFor(record.keyId, nowMs), {
        now: nowMs,
        limit: requestsPerMinute,
      });
    } catch (error) {
      if (error?.code !== 'SUBMISSION_RATE_LIMIT') throw error;
      await auditRefusal(record.keyId, 'rate-limited', nowMs);
      return {
        record: null,
        user: null,
        error: deny(
          429,
          'RATE_LIMITED',
          `Too many requests: at most ${requestsPerMinute} a minute per key. Wait and try again.`,
          { 'Retry-After': String(secondsToNextMinute(nowMs)) },
        ),
      };
    }

    touchLastUsed(record, nowMs);
    return { record, user: organizerUser(record), error: null };
  }

  /** The gates, then the scope the route needs. */
  async function requireScope(request, scope) {
    const auth = await authenticate(request);
    if (auth.error) return auth;
    if (!scopesOf(auth.record).includes(scope)) {
      audit({ outcome: 'denied', reason: 'scope-off', scope, keyId: auth.record.keyId });
      return {
        record: null,
        user: null,
        error: deny(
          403,
          'FORBIDDEN',
          `This key does not have the "${scope}" scope (${labelOf(scope)}). Ask the site owner to add it.`,
        ),
      };
    }
    return auth;
  }

  return { authenticate, requireScope };
}

let guard = null;

/** The production composition: the real client and the shared denial sink. Lazy, like default-guard.js. */
export function getDeveloperApiGuard() {
  guard ||= createDeveloperApiGuard({
    store: { readDoc, patchDoc, incrementIf, createDoc, replaceDocIfMatch },
    auditDenial: writeDenialAudit,
  });
  return guard;
}

/** Test seam. */
export function resetDeveloperApiGuard() {
  guard = null;
}
