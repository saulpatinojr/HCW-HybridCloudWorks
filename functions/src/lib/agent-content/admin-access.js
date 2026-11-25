/**
 * agent-content/admin-access.js — the admin routes Koda's key may call, and
 * the guard wrapper that lets it (ADR 0038).
 *
 * ADR 0037 kept Koda's key out of every `/api/cms/*` route on purpose: the
 * key passed nothing that called `requireRole`. The owner's instruction of
 * 2026-11-01 widened Koda's job from "write drafts" to "work the Pipeline,
 * Enhanced, Spotlight and Second Brain sections and read Platform health and
 * integrations", creating and reviewing but never deleting. Mirroring a
 * hundred routes under /api/agent-content/v1 would have been a second copy
 * of every handler, so the key is instead accepted by the admin role guard
 * itself, through `withAgentAccess`, and only for the routes in `POLICY`.
 *
 * The rules, all enforced here and tested in admin-access.test.js:
 *
 *   - A DELETE is never allowed, whatever the route. A POST or PUT that
 *     deletes or trashes (deleteContentItem, softDeleteLivePage, the
 *     doc-vault DELETE) is simply not in the table.
 *   - Publishing stays a human act (ADR 0037): publishContent,
 *     saveContentSchedule, unscheduleContent, unpublishContentToInspected,
 *     the slug and rehost writes, and the podcast publish are not listed, and
 *     a `transitionContentStatus` to `published` or `archived`, an
 *     `enqueueJob` of `publish-content`, and a `createContentItem` asking to
 *     be born published are refused by the body rules below.
 *   - Settings writes, secrets, credentials, admins, AI routing, MCP, the
 *     lab agent registry, the Coder token and every Amplify route are not
 *     listed: the owner named the sections Koda works in, and those are not
 *     among them. Platform Settings may be read (owner request 2026-11-10,
 *     "all platform items"), never written: its autoposting settings decide
 *     what is published.
 *   - Each route belongs to a section switch on the Koda tab
 *     (keys.js CAPABILITIES, the `admin.*` ids). A section that is off
 *     refuses its routes with 403 and an audit row, like a capability.
 *   - The key acts as `koda (agent)` everywhere except the Second Brain,
 *     which is the owner's private workspace partitioned by the owner's
 *     object id: there the key acts as the owner (`asOwner`), so the notes
 *     it writes land in the owner's partition. Audit rows still say which
 *     key did it.
 *   - The role each route requires is the role the policy grants: `editor`
 *     for nearly everything, `publisher` for the Doc Vault (whose reads
 *     already need it) and for acknowledging or resolving a workflow alert
 *     (whose handler needs it), and `viewer` for the health reads. A route whose
 *     handler asks for more than the grant is refused with 403.
 *
 * Every refusal of a presented key is an `admin_audit_logs` row of kind
 * agent-content-denial with `surface: 'admin'`, the reason
 * (`route-not-allowed`, `section-off`, `role`, `body-not-allowed`,
 * `body-unreadable`, `user-only-route`, or the key guard's own `wrong-key`,
 * `revoked-key`, `no-key`, `rate-limited`), the method and the route as the
 * policy spells it (the template, or `unlisted`), and never the key, the
 * body or the concrete path, whose segments can be document ids.
 */
import { satisfiesRole, minimumRole } from '../auth/roles.js';
import { AGENT_ID, AGENT_USER, agentKeyFrom, looksLikeKey } from './keys.js';
import {
  apiPathOf,
  matchPolicy,
  openSection,
  sectionsFor,
} from './admin-policy.js';

export {
  ADMIN_SECTION_IDS,
  CREATE_STATUSES_REFUSED,
  JOB_TYPES_ALLOWED,
  LEGACY_LIVE_STATUSES,
  POLICY,
  TRANSITION_TARGETS_ALLOWED,
  WORKFLOW_ALERT_ACTIONS_ALLOWED,
  apiPathOf,
  describePolicy,
  matchPolicy,
  openSection,
  sectionsFor,
  templateToPattern,
} from './admin-policy.js';

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

/** The identity the key acts with on a row: Koda, or the Second Brain's owner for `asOwner` rows. */
export function agentUserFor(row, env = process.env) {
  if (!row.asOwner) return { ...AGENT_USER, roles: [], scp: '' };
  return {
    ...AGENT_USER,
    oid: env.BRAIN_OWNER_OID || AGENT_USER.oid,
    sub: env.BRAIN_OWNER_OID || AGENT_USER.sub,
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
 * Wrap the admin role guard so a request that presents a site key takes the
 * key path (authenticate, then the policy), and every other request takes
 * the role guard's own path unchanged.
 *
 * @param {{ requireRole: Function, requireUser: Function }} roleGuard
 * @param {object} deps
 * @param {{ authenticate: (request: object) => Promise<{record: object|null, user: object|null, error: object|null}> }} deps.agentGuard
 * @param {(entry: object) => unknown} [deps.auditDenial] the denial sink; never awaited, must not throw synchronously
 * @param {NodeJS.ProcessEnv} [deps.env]
 */
export function withAgentAccess(roleGuard, { agentGuard, auditDenial = null, env = process.env }) {
  const deps = { roleGuard, agentGuard, auditDenial, env };
  return {
    ...roleGuard,
    requireRole: (request, required) => keyAwareRequireRole(deps, request, required),
    requireUser: (request) => keyAwareRequireUser(deps, request),
  };
}

/** Write a denial row through the sink, never letting the sink change the refusal. */
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
async function policyRefusal({ row, path, record, minimum }, request) {
  if (!row) return { reason: 'route-not-allowed' };
  const sections = sectionsFor(row, path);
  if (!sections.length) return { reason: 'route-not-allowed' };
  const section = openSection(row, record, path);
  if (!section) return { reason: 'section-off', extra: { section: sections[0] } };
  if (!satisfiesRole(row.role, minimum)) return { reason: 'role', extra: { required: minimum, granted: row.role } };
  const body = await checkBodyRule(row, request);
  return body.ok ? null : { reason: body.reason, extra: { field: body.field } };
}

async function keyAwareRequireRole({ roleGuard, agentGuard, auditDenial, env }, request, required) {
  if (!presentsKey(request)) return roleGuard.requireRole(request, required);

  const minimum = minimumRole(required);
  if (!minimum) throw new Error(`requireRole: unknown role requirement ${JSON.stringify(required)}`);

  // The route is matched before the key is checked, so the key guard's own
  // refusals (wrong, revoked, over the limit) carry the admin surface and
  // the route template too. The concrete path is matched and then dropped:
  // its segments can be document ids, and telemetry is content-free.
  const method = String(request?.method || '').toUpperCase();
  const path = apiPathOf(request);
  const row = matchPolicy(method, path);
  const where = { surface: 'admin', method, route: row ? row.route : 'unlisted' };

  const auth = await agentGuard.authenticate(request, where);
  if (auth.error) return { user: null, role: null, error: auth.error };

  const refusal = await policyRefusal({ row, path, record: auth.record, minimum }, request);
  if (refusal) {
    auditDenialRow(auditDenial, { outcome: 'denied', reason: refusal.reason, ...where, ...(refusal.extra || {}) });
    return { user: null, role: null, error: deny(403, FORBIDDEN) };
  }

  return { user: agentUserFor(row, env), role: row.role, error: null };
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
