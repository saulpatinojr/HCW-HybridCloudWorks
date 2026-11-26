/**
 * agent-content/admin-key-guard.js — the wrapper that lets an agent key through
 * the admin role guard for the routes in the policy table, and the body rules
 * and identity it acts with there. The table, and the rules it encodes, are
 * in ./admin-access.js, which builds withAgentAccess from this module and
 * re-exports checkBodyRule and agentUserFor.
 */
import { satisfiesRole, minimumRole } from '../auth/roles.js';
import { AGENT_ID, AGENT_USER, agentKeyById, agentKeyFrom, agentUserOf, looksLikeKey } from './keys.js';

/**
 * Read the one body field a rule cares about, from a clone so the handler
 * still gets the body. A body that cannot be read, or is not an object, fails
 * the rule: the handler would refuse it anyway, and the rule must not be
 * passable by sending nothing.
 */
async function bodyOf(request) {
  try {
    const source = typeof request?.clone === 'function' ? request.clone() : request;
    const body = await source.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false };
    return { ok: true, body };
  } catch {
    return { ok: false };
  }
}

/** `a.b.c` read off an object, undefined where the path ends early. */
const pick = (object, path) =>
  path.split('.').reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), object);

/**
 * Whether every body rule of a row holds for this request: `{ ok, reason,
 * field }`. The body is read once; each rule reads its field by path (the
 * create handler keeps the item under `data`, so `data.contentStatus`).
 */
export async function checkBodyRule(row, request) {
  if (!row.body) return { ok: true };
  const read = await bodyOf(request);
  if (!read.ok) return { ok: false, reason: 'body-unreadable', field: row.body[0].field };
  const broken = row.body.find((rule) => breaksBodyRule(rule, read.body));
  return broken ? { ok: false, reason: 'body-not-allowed', field: broken.field } : { ok: true };
}

/** Does this body break one rule: a value outside `allow`, or a value `refuse` names? */
function breaksBodyRule(rule, body) {
  const raw = pick(body, rule.field);
  const value = typeof raw === 'string' ? raw.trim() : raw;
  if (rule.allow && !rule.allow.includes(value)) return true;
  if (!rule.refuse) return false;
  // A refused field is compared as a plain value; anything else that is present (an
  // array, an object) is refused too, because a handler that stores it as given and a
  // reader that calls String() on it would turn ['published'] back into 'published'.
  const present = raw !== undefined && raw !== null;
  const plain = typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number';
  return (present && !plain) || rule.refuse.includes(value);
}

/**
 * The identity a key acts with on a row: its own agent (Koda's when none is
 * named), or the Second Brain's owner for `asOwner` rows.
 *
 * @param {object} row a POLICY row
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [agentId] the key that signed in, from its user's `agent`
 */
export function agentUserFor(row, env = process.env, agentId = AGENT_ID) {
  const entry = agentKeyById(agentId);
  if (!entry) throw new Error('agentUserFor: not an agent key');
  const base = entry.id === AGENT_ID ? AGENT_USER : agentUserOf(entry);
  if (!row.asOwner) return { ...base, roles: [], scp: '' };
  return {
    ...base,
    oid: env.BRAIN_OWNER_OID || base.oid,
    sub: env.BRAIN_OWNER_OID || base.sub,
    tid: env.BRAIN_OWNER_TENANT_ID || null,
    actingFor: 'owner',
    roles: [],
    scp: '',
  };
}

const deny = (status, error) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ok: false, error }),
});

const FORBIDDEN = 'This key may not call that route.';

/**
 * The key-aware guard behind withAgentAccess (admin-access.js). `policy` is
 * that module's matching of a request to the route table: apiPathOf,
 * matchPolicy, sectionsFor and openSection.
 */
export function createKeyAwareGuard(roleGuard, { agentGuard, auditDenial = null, env = process.env }, policy) {
  const deps = { roleGuard, agentGuard, auditDenial, env, policy };
  return {
    ...roleGuard,
    requireRole: (request, required) => keyAwareRequireRole(deps, request, required),
    requireUser: (request) => keyAwareRequireUser(deps, request),
  };
}

/**
 * Write a denial row through the sink, never letting the sink change the
 * refusal. `entry.agent`, when the key is known, names it; otherwise the row
 * names the first key, as it always has.
 */
function auditDenialRow(auditDenial, entry) {
  try {
    const result = auditDenial?.({ kind: 'agent-content-denial', agent: AGENT_ID, ...entry });
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {
    // The refusal is unchanged when the audit sink fails.
  }
}

/** Only a value shaped like a site key takes the key path; a token, or nothing, takes the role guard's. */
const presentsKey = (request) => looksLikeKey(agentKeyFrom(request));

/**
 * Why the policy refuses the key on this request, as `{ reason, extra }`,
 * or null when the row allows it. Checked in this order: the route, the
 * section switch, the role, then the body.
 */
async function policyRefusal({ sectionsFor, openSection }, { row, path, record, minimum }, request) {
  if (!row) return { reason: 'route-not-allowed' };
  const sections = sectionsFor(row, path);
  if (!sections.length) return { reason: 'route-not-allowed' };
  const section = openSection(row, record, path);
  if (!section) return { reason: 'section-off', extra: { section: sections[0] } };
  if (!satisfiesRole(row.role, minimum)) return { reason: 'role', extra: { required: minimum, granted: row.role } };
  const body = await checkBodyRule(row, request);
  return body.ok ? null : { reason: body.reason, extra: { field: body.field } };
}

async function keyAwareRequireRole({ roleGuard, agentGuard, auditDenial, env, policy }, request, required) {
  if (!presentsKey(request)) return roleGuard.requireRole(request, required);

  const minimum = minimumRole(required);
  if (!minimum) throw new Error(`requireRole: unknown role requirement ${JSON.stringify(required)}`);

  // The route is matched before the key is checked, so the key guard's own
  // refusals (wrong, revoked, over the limit) carry the admin surface and
  // the route template too. The concrete path is matched and then dropped:
  // its segments can be document ids, and telemetry is content-free.
  const method = String(request?.method || '').toUpperCase();
  const path = policy.apiPathOf(request);
  const row = policy.matchPolicy(method, path);
  const where = { surface: 'admin', method, route: row ? row.route : 'unlisted' };

  const auth = await agentGuard.authenticate(request, where);
  if (auth.error) return { user: null, role: null, error: auth.error };

  const agent = auth.user?.agent ?? AGENT_ID;
  const refusal = await policyRefusal(policy, { row, path, record: auth.record, minimum }, request);
  if (refusal) {
    auditDenialRow(auditDenial, { outcome: 'denied', reason: refusal.reason, agent, ...where, ...(refusal.extra || {}) });
    return { user: null, role: null, error: deny(403, FORBIDDEN) };
  }

  return { user: agentUserFor(row, env, agent), role: row.role, error: null };
}

/**
 * A key is not a user: the user-only routes (the sign-in expectations, the
 * current-admin status, the bootstrap) refuse it without a verifier round
 * trip, and the refusal is a denial row like any other presented key's.
 */
async function keyAwareRequireUser({ roleGuard, auditDenial }, request) {
  if (!presentsKey(request)) return roleGuard.requireUser(request);
  auditDenialRow(auditDenial, {
    outcome: 'denied',
    reason: 'user-only-route',
    surface: 'admin',
    method: String(request?.method || '').toUpperCase(),
    route: 'unlisted',
  });
  return { user: null, role: null, error: deny(401, 'Authentication required') };
}
