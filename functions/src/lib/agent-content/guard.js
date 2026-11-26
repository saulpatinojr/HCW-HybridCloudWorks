/**
 * agent-content/guard.js — who may call the Agent Content API (ADR 0037).
 *
 * The fourth guard in this API, beside the admin role guard, the lab agent's
 * App Role guard and the brains' delegated-scope guards. It is deliberately
 * disjoint from all three on this API: an admin token does not pass here.
 * Since ADR 0038 the key also passes the admin role guard, but only for the
 * allow-listed admin routes in admin-access.js, which composes this guard's
 * `authenticate` with its own policy. The route-inventory test mocks this
 * module by name, so a route that uses it counts as guarded there.
 *
 * Three gates, in order, and a refusal at any of them reads nothing further:
 *
 *   1. The presented value is shaped like a key this site issued (keys.js
 *      looksLikeKey). A random token is refused before the database is read.
 *      The key is read from the shapes connectors send (agentKeyFrom):
 *      `Authorization: Bearer <key>`, the bare key as the Authorization
 *      value, or an X-API-Key / X-Agent-Key header; never a query string.
 *   2. Its SHA-256 matches the hash in one of the key records (one per
 *      agent key, agent-keys.js), which is not revoked. Each record is
 *      compared in constant time, in the list's order, and the first that
 *      matches names the key: the request then acts as that key's agent,
 *      with that key's switches, limit and audit rows. A missing or revoked
 *      record matches nothing. No cache: revoking a key on its tab must cut
 *      the next request, the same reason require-agent.js gives for not
 *      caching the lab agent registry.
 *   3. The key is under its own per-minute limit, counted with the same
 *      compare-and-increment counter the public submission routes use
 *      (submissions.js enforceSubmissionQuota) under a key that names the
 *      minute, so a burst cannot read-then-write its way past it.
 *
 * Then the capability the route needs must be switched on for the key.
 *
 * Every refusal of a presented site key (one shaped like ours: wrong, revoked,
 * over the limit, or without the capability) is one `admin_audit_logs` row of
 * kind agent-content-denial, with the reason and never the key or any part of
 * it. A request with no key header, or with a value not shaped like a site
 * key, is refused without a row, as the admin guard refuses
 * a missing token: there is no attempt worth describing, and the anonymous
 * probes the internet sends would otherwise be a write each. 401 for a missing,
 * wrong or revoked key (one sentence for all three, so the answer does not
 * say whether a key exists), 403 for a capability that is off, 429 with
 * Retry-After for the limit.
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
  AGENT_KEYS,
  AGENT_USER,
  CAPABILITIES,
  REQUESTS_PER_MINUTE,
  agentUserOf,
  hashMatches,
  isUsable,
  looksLikeKey,
  quotaKeyFor,
  secondsToNextMinute,
  agentKeyFrom,
  enabledCapabilities,
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

// agentKeyFrom and KEY_HEADERS moved to keys.js (ADR 0038), where the admin
// role guard reads them too; re-exported so nothing that imported them here
// has to move.
export { agentKeyFrom, KEY_HEADERS } from './keys.js';


/**
 * Write one denial row through the sink. `where` is what the caller knows
 * about the request that the guard does not: the admin surface and the route
 * template, when the admin role guard delegates here (admin-access.js, ADR
 * 0038). The v1 routes pass nothing.
 */
function audit(auditDenial, entry, where = {}) {
  try {
    // `agent` is the key's own id once a key is matched; before that (a
    // wrong, revoked or missing key) no key is known, and the row names
    // the first key, as it always has.
    const result = auditDenial?.({ kind: 'agent-content-denial', agent: AGENT_USER.agent, ...where, ...entry });
    // writeDenialAudit never rejects; a test double might. Nothing on a
    // denial path may become an unhandled rejection.
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {
    // The denial answer is unchanged when the audit sink fails.
  }
}

/** lastUsedAt, at most once per LAST_USED_EVERY_MS, best effort and never awaited. */
function touchLastUsed(store, key, record, nowMs) {
  const last = Date.parse(record.lastUsedAt || '') || 0;
  if (nowMs - last < LAST_USED_EVERY_MS) return;
  Promise.resolve()
    .then(() =>
      store.patchDoc(
        'admin_config',
        key.recordId,
        { lastUsedAt: new Date(nowMs).toISOString() },
        { partitionKey: ADMIN_CONFIG_PARTITION },
      ),
    )
    .catch(() => {});
}

/** The 401 every failed key check answers with. */
const unauthenticated = () => ({ record: null, user: null, error: deny(401, 'UNAUTHENTICATED', UNAUTHENTICATED) });

/**
 * One key's record, or null when there is none. A document whose own id is
 * not the record id asked for is no record of this key.
 */
async function readKeyRecord(store, key) {
  const record = await store.readDoc('admin_config', key.recordId, ADMIN_CONFIG_PARTITION);
  if (!record) return null;
  return typeof record.id === 'string' && record.id !== key.recordId ? null : record;
}

/**
 * Why no key matched, for the denial row: no record at all, records that
 * are all revoked, or a key that is none of the live ones.
 */
function noMatchReason(seen) {
  if (seen.some(isUsable)) return 'wrong-key';
  return seen.some(Boolean) ? 'revoked-key' : 'no-key';
}

/**
 * `{ key, record }` for the agent key whose live hash `secret` matches;
 * null, after its denial row, when none does. The records are read in the
 * list's order and the reads stop at the first match.
 */
async function matchingRecord({ store, auditDenial }, secret, where) {
  const seen = [];
  for (const key of AGENT_KEYS) {
    const record = await readKeyRecord(store, key);
    seen.push(record);
    if (isUsable(record) && hashMatches(secret, record.keyHash)) return { key, record };
  }
  audit(auditDenial, { outcome: 'denied', reason: noMatchReason(seen) }, where);
  return null;
}

/** The per-minute limit: the 429 answer, after its denial row, when this request is over it; null when not. */
async function rateLimitRefusal({ store, auditDenial, requestsPerMinute }, key, nowMs, where) {
  try {
    await enforceSubmissionQuota(store, quotaKeyFor(nowMs, key.id), { now: nowMs, limit: requestsPerMinute });
    return null;
  } catch (error) {
    if (error?.code !== 'SUBMISSION_RATE_LIMIT') throw error;
    audit(auditDenial, { outcome: 'denied', reason: 'rate-limited', agent: key.id }, where);
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
}

/**
 * The three gates. Resolves `{ record, user }` or `{ error }`, where `error`
 * is the HTTP answer to return.
 */
async function authenticate(deps, request, where = {}) {
  const secret = agentKeyFrom(request);
  // No key, or a value not shaped like a site key, is no credential at all:
  // refused without a store read and without an audit row, so the random
  // tokens internet scanners send cannot turn into a write per request on
  // admin_audit_logs.
  if (!secret || !looksLikeKey(secret)) return unauthenticated();

  const match = await matchingRecord(deps, secret, where);
  if (!match) return unauthenticated();
  const { key, record } = match;

  const nowMs = deps.now();
  const limited = await rateLimitRefusal(deps, key, nowMs, where);
  if (limited) return limited;

  touchLastUsed(deps.store, key, record, nowMs);
  return { record, user: { ...agentUserOf(key), keyHint: record.keyHint || null }, error: null };
}

/** The gates, then the capability the route needs. */
async function requireCapability(deps, request, capability) {
  const auth = await authenticate(deps, request);
  if (auth.error) return auth;
  // What the record allows, with the defaults filled in, so an older key
  // record is read the same way as a new one: a switch it never stored
  // takes today's default, and a switch stored false stays off.
  if (!enabledCapabilities(auth.record).includes(capability)) {
    audit(deps.auditDenial, { outcome: 'denied', reason: 'capability-off', capability, agent: auth.user.agent });
    const name = auth.user.name;
    return {
      record: null,
      user: null,
      error: deny(
        403,
        'FORBIDDEN',
        `${name}'s key does not allow this: "${labelOf(capability)}" is switched off on the AI Engine's ${name} tab.`,
      ),
    };
  }
  return auth;
}

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
  const deps = { store, now, auditDenial, requestsPerMinute };
  return {
    authenticate: (request, where = {}) => authenticate(deps, request, where),
    requireCapability: (request, capability) => requireCapability(deps, request, capability),
  };
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
