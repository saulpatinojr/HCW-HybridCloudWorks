/**
 * agent-content/guard.js — who may call the Agent Content API (ADR 0037).
 *
 * The fourth guard in this API, beside the admin role guard, the lab agent's
 * App Role guard and the brains' delegated-scope guards. It is deliberately
 * disjoint from all three: an admin token does not pass here, and Koda's key
 * passes nothing that calls `requireRole`. The route-inventory test mocks this
 * module by name, so a route that uses it counts as guarded there.
 *
 * Three gates, in order, and a refusal at any of them reads nothing further:
 *
 *   1. The bearer value is shaped like a key this site issued (keys.js
 *      looksLikeKey). A random token is refused before the database is read.
 *   2. Its SHA-256 matches the hash in the one key record, which is not
 *      revoked. Compared in constant time. No cache: revoking the key on the
 *      Koda tab must cut the next request, the same reason require-agent.js
 *      gives for not caching the lab agent registry.
 *   3. The key is under its per-minute limit, counted with the same
 *      compare-and-increment counter the public submission routes use
 *      (submissions.js enforceSubmissionQuota) under a key that names the
 *      minute, so a burst cannot read-then-write its way past it.
 *
 * Then the capability the route needs must be switched on for the key.
 *
 * Every refusal of a presented value is one `admin_audit_logs` row of kind
 * agent-content-denial, with the reason and never the key or any part of it.
 * A request with no Authorization header at all is refused without a row, as
 * the admin guard refuses one: there is no attempt to describe, and the
 * anonymous probes the internet sends would only fill the log. 401 for a missing,
 * wrong or revoked key (one sentence for all three, so the answer does not
 * say whether a key exists), 403 for a capability that is off, 429 with
 * Retry-After for the limit.
 */
import { bearerTokenFrom } from '../auth/verify-token.js';
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
  AGENT_USER,
  CAPABILITIES,
  KEY_RECORD_ID,
  REQUESTS_PER_MINUTE,
  hashMatches,
  isUsable,
  looksLikeKey,
  quotaKeyFor,
  secondsToNextMinute,
} from './keys.js';

/** How often lastUsedAt is written: a stamp per call would be a write per call. */
export const LAST_USED_EVERY_MS = 5 * 60 * 1000;

const UNAUTHENTICATED =
  'Authentication required: send the agent key as a Bearer token. The key is missing, wrong or revoked.';

const deny = (status, code, error, headers = {}) => ({
  status,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify({ ok: false, code, error }),
});

const labelOf = (capability) =>
  CAPABILITIES.find((entry) => entry.id === capability)?.label || capability;

/**
 * @param {object} deps
 * @param {{ readDoc: Function, patchDoc: Function, incrementIf: Function, createDoc: Function,
 *   replaceDocIfMatch: Function }} deps.store
 * @param {() => number} [deps.now] epoch milliseconds
 * @param {(entry: object) => unknown} [deps.auditDenial] never awaited; must not throw
 * @param {number} [deps.requestsPerMinute]
 */
export function createAgentContentGuard({
  store,
  now = Date.now,
  auditDenial = null,
  requestsPerMinute = REQUESTS_PER_MINUTE,
}) {
  if (!store) throw new Error('createAgentContentGuard requires a store');

  const audit = (entry) => {
    try {
      const result = auditDenial?.({ kind: 'agent-content-denial', agent: AGENT_USER.agent, ...entry });
      // writeDenialAudit never rejects; a test double might. Nothing on a
      // denial path may become an unhandled rejection.
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // The denial answer is unchanged when the audit sink fails.
    }
  };

  /** lastUsedAt, at most once per LAST_USED_EVERY_MS, best effort and never awaited. */
  const touchLastUsed = (record, nowMs) => {
    const last = Date.parse(record.lastUsedAt || '') || 0;
    if (nowMs - last < LAST_USED_EVERY_MS) return;
    Promise.resolve()
      .then(() =>
        store.patchDoc(
          'admin_config',
          KEY_RECORD_ID,
          { lastUsedAt: new Date(nowMs).toISOString() },
          { partitionKey: ADMIN_CONFIG_PARTITION },
        ),
      )
      .catch(() => {});
  };

  /**
   * The three gates. Resolves `{ record, user }` or `{ error }`, where `error`
   * is the HTTP answer to return.
   */
  async function authenticate(request) {
    const secret = bearerTokenFrom(request);
    if (!secret) {
      return { record: null, user: null, error: deny(401, 'UNAUTHENTICATED', UNAUTHENTICATED) };
    }
    if (!looksLikeKey(secret)) {
      audit({ outcome: 'denied', reason: 'not-an-agent-key' });
      return { record: null, user: null, error: deny(401, 'UNAUTHENTICATED', UNAUTHENTICATED) };
    }

    const record = await store.readDoc('admin_config', KEY_RECORD_ID, ADMIN_CONFIG_PARTITION);
    if (!isUsable(record)) {
      audit({ outcome: 'denied', reason: record ? 'revoked-key' : 'no-key' });
      return { record: null, user: null, error: deny(401, 'UNAUTHENTICATED', UNAUTHENTICATED) };
    }
    if (!hashMatches(secret, record.keyHash)) {
      audit({ outcome: 'denied', reason: 'wrong-key' });
      return { record: null, user: null, error: deny(401, 'UNAUTHENTICATED', UNAUTHENTICATED) };
    }

    const nowMs = now();
    try {
      await enforceSubmissionQuota(store, quotaKeyFor(nowMs), { now: nowMs, limit: requestsPerMinute });
    } catch (error) {
      if (error?.code !== 'SUBMISSION_RATE_LIMIT') throw error;
      audit({ outcome: 'denied', reason: 'rate-limited' });
      return {
        record: null,
        user: null,
        error: deny(
          429,
          'RATE_LIMITED',
          `Too many requests: at most ${requestsPerMinute} a minute. Wait and try again.`,
          { 'Retry-After': String(secondsToNextMinute(nowMs)) },
        ),
      };
    }

    touchLastUsed(record, nowMs);
    return { record, user: { ...AGENT_USER, keyHint: record.keyHint || null }, error: null };
  }

  /** The gates, then the capability the route needs. */
  async function requireCapability(request, capability) {
    const auth = await authenticate(request);
    if (auth.error) return auth;
    if (auth.record.capabilities?.[capability] === false) {
      audit({ outcome: 'denied', reason: 'capability-off', capability });
      return {
        record: null,
        user: null,
        error: deny(
          403,
          'FORBIDDEN',
          `Koda's key does not allow this: "${labelOf(capability)}" is switched off on the AI Engine's Koda tab.`,
        ),
      };
    }
    return auth;
  }

  /**
   * The Drafts routes' guard interface, for one capability: the drafts
   * handlers call `guard.requireRole(request, 'editor')` and read `user`, so
   * Koda's key answers in that shape and the routes run unchanged, with
   * Koda's identity on every createdBy, updatedBy and audit row.
   */
  function asRoleGuard(capability) {
    return {
      requireRole: async (request) => {
        const auth = await requireCapability(request, capability);
        return auth.error
          ? { user: null, role: null, error: auth.error }
          : { user: auth.user, role: 'editor', error: null };
      },
    };
  }

  return { authenticate, requireCapability, asRoleGuard };
}

let guard = null;

/** The production composition: the real client and the shared denial sink. Lazy, like default-guard.js. */
export function getAgentContentGuard() {
  guard ||= createAgentContentGuard({
    store: { readDoc, patchDoc, incrementIf, createDoc, replaceDocIfMatch },
    auditDenial: writeDenialAudit,
  });
  return guard;
}

/** Test seam. */
export function resetAgentContentGuard() {
  guard = null;
}
