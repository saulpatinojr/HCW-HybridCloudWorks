/**
 * cloudflare/rules-routes.js — the Cloudflare page's rule routes (#1905):
 * list the zone's rulesets, read one phase's rules, replace one phase's
 * rules. A phase is the point in handling a request where a group of rules
 * runs. There is no delete.
 *
 * WHAT A READ SHOWS. Some rules carry a secret: the origin rule in
 * `http_request_late_transform` sets the header that proves a request came
 * through Cloudflare, and its value is the origin secret. So:
 *
 *   - A phase that may not be replaced (anything not in EDITABLE_PHASES)
 *     answers only each rule's id, description, expression, action and
 *     enabled flag. Never its action_parameters, or anything else.
 *   - An editable phase answers its rules in full, because the editor needs
 *     them, except that a header value under a name that sounds secret
 *     (secret, token, auth, key) is replaced with REDACTED_VALUE. A
 *     replacement that sends that marker back is refused: the real value
 *     is not known here, so it is changed in the Cloudflare dashboard.
 *   - The rulesets list and the status route never carry rules at all.
 *
 * A REPLACEMENT IS CHECKED FOR FRESHNESS. The phase read answers its
 * ruleset's `version` (Cloudflare's own, or its last_updated when it has
 * none); the replacement must send it back as `expectedVersion` (null for a
 * phase with no rules yet). The phase is read again just before the write,
 * and a different version is refused with 409 and nothing written, so a page
 * opened earlier cannot quietly overwrite a newer change.
 *
 * WHAT A REPLACEMENT MAY BE. Only an editable phase; never an empty list
 * (that deletes every rule in the phase); in the custom security rules,
 * never a rule whose action is `skip` (it lets requests past the other
 * checks); and, from an agent key, never a list that leaves out a rule the
 * phase has now (an agent key adds and changes rules; only the owner
 * removes one, 403 CLOUDFLARE_OWNER_ONLY).
 */
import { Refusal, bad, bodyOf, json, paramOf, protectedRefusal, refuseUnknownFields } from './input.js';
import { isAgentUser } from '../agent-content/agent-keys.js';
import { recordChange, requireOurZone } from './record.js';
import { REDACTED_VALUE, REFUSED_FIREWALL_ACTION, isEditablePhase, phaseProtection } from './protected.js';

export const PHASE_PATTERN = /^[a-z0-9_]{1,64}$/;
export const MAX_RULES = 100;
export { REDACTED_VALUE };
/** A name that sounds as if it holds a secret. */
export const SECRET_NAME = /secret|token|auth|key/i;

const FIREWALL_CUSTOM = 'http_request_firewall_custom';
/** Cloudflare's own stamps on a rule it returned; dropped so a rule sent back unchanged is not refused. */
const STAMPS = ['version', 'last_updated'];

/** A copy of `node` with the `value` of every object under a secret-sounding name hidden. */
function redactDeep(node, name = '') {
  if (Array.isArray(node)) return node.map((item) => redactDeep(item, name));
  if (!node || typeof node !== 'object') return node;
  const out = Object.fromEntries(Object.entries(node).map(([key, value]) => [key, redactDeep(value, key)]));
  if (SECRET_NAME.test(name) && Object.hasOwn(out, 'value')) out.value = REDACTED_VALUE;
  return out;
}

/** An editable phase's rule in full, its secret-sounding values hidden. */
const redactedRule = (rule) => redactDeep(rule);

/** A read-only phase's rule: what it matches and what it does, nothing it carries. */
const summaryRule = (rule) => ({
  id: rule?.id ?? null,
  description: rule?.description ?? null,
  expression: rule?.expression ?? null,
  action: rule?.action ?? null,
  enabled: rule?.enabled ?? null,
});

/** A phase's rules as an answer may show them. */
export function rulesFor(phase, rules) {
  const list = Array.isArray(rules) ? rules : [];
  return list.map(isEditablePhase(phase) ? redactedRule : summaryRule);
}

/** A ruleset's version as the freshness check compares it: Cloudflare's version, else last_updated, else null. */
export const versionOf = (ruleset) => (ruleset ? String(ruleset.version ?? ruleset.last_updated ?? '') || null : null);

export const STALE_MESSAGE = 'This phase changed since you opened it; reload it and make your change again.';

const pickRuleset = (ruleset) => ({
  id: ruleset?.id ?? null,
  name: ruleset?.name ?? null,
  phase: ruleset?.phase ?? null,
  kind: ruleset?.kind ?? null,
  description: ruleset?.description ?? null,
  version: versionOf(ruleset),
  locked: phaseProtection(ruleset?.phase) !== null,
  lockedReason: phaseProtection(ruleset?.phase),
});

/** A ruleset with its rules, as the phase routes answer it. */
const rulesetView = (phase, ruleset) => ({ ...pickRuleset(ruleset), rules: rulesFor(phase, ruleset?.rules) });

/** GET cms/cloudflare/rulesets. Metadata only: no rules. */
export async function listRulesets({ client }) {
  const rulesets = await client.listRulesets();
  return json(200, { ok: true, rulesets: (Array.isArray(rulesets) ? rulesets : []).map(pickRuleset) });
}

/** The phase in the path, checked. */
function phaseOf(request) {
  const phase = paramOf(request, 'phase');
  if (!PHASE_PATTERN.test(phase)) throw bad('The phase must be 1 to 64 lower-case letters, digits or underscores.');
  return phase;
}

/** GET cms/cloudflare/rulesets/phases/{phase}. */
export async function getPhase({ request, client }) {
  const phase = phaseOf(request);
  const ruleset = await client.getPhase(phase);
  return json(200, {
    ok: true,
    ruleset: ruleset ? rulesetView(phase, ruleset) : null,
    version: versionOf(ruleset),
    editable: isEditablePhase(phase),
    locked: phaseProtection(phase) !== null,
    lockedReason: phaseProtection(phase),
  });
}

const isRule = (rule) => Boolean(rule) && typeof rule === 'object' && !Array.isArray(rule);
const withoutStamps = (rule) => Object.fromEntries(Object.entries(rule).filter(([key]) => !STAMPS.includes(key)));

/** Refuses what a phase's new rules may not hold. */
function refuseRuleContents(phase, rules) {
  if (JSON.stringify(rules).includes(REDACTED_VALUE)) {
    throw bad('A rule still holds a hidden value. That value is a secret this page never reads, so a rule holding one is changed in the Cloudflare dashboard.');
  }
  const skips = phase === FIREWALL_CUSTOM && rules.some((rule) => String(rule.action ?? '').toLowerCase() === REFUSED_FIREWALL_ACTION);
  if (skips) throw bad('A custom security rule may not skip: it would let matching requests past the other security checks.');
}

/** Refuses a body without `expectedVersion`, or one that is neither text nor null. */
function refuseVersionShape(body) {
  const value = body.expectedVersion;
  const shaped = value === null || (typeof value === 'string' && value.length > 0 && value.length <= 64);
  if (!Object.hasOwn(body, 'expectedVersion') || !shaped) {
    throw bad('Send expectedVersion: the version the phase read answered (null for a phase with no rules yet).');
  }
}

/** Refuses (409, nothing written) when the phase changed since the caller read it; else answers the phase as it is now. */
async function refuseStale(client, phase, expectedVersion) {
  const current = await client.getPhase(phase);
  if (versionOf(current) !== expectedVersion) throw new Refusal(STALE_MESSAGE, { status: 409, code: 'CLOUDFLARE_STALE' });
  return current;
}

export const AGENT_REMOVAL_MESSAGE =
  'An agent key may add or change rules but not remove one. Removing a rule is done by the owner on the Cloudflare page.';

/** The ids of a list of rules, leaving out any rule without one. */
const idsOf = (rules) => (Array.isArray(rules) ? rules : []).map((rule) => rule?.id).filter((id) => typeof id === 'string' && id);

/**
 * Refuses (403, nothing written) an agent key's list that leaves out a rule
 * the phase has now. Every current rule's id must be in the new list, so an
 * agent key may add rules and change existing ones but never drop one. A
 * person (super_admin) may remove rules; the page asks them to type a
 * confirmation first.
 */
function refuseAgentRemoval(user, current, rules) {
  if (!isAgentUser(user)) return;
  const kept = new Set(idsOf(rules));
  if (idsOf(current?.rules).some((id) => !kept.has(id))) {
    throw new Refusal(AGENT_REMOVAL_MESSAGE, { status: 403, code: 'CLOUDFLARE_OWNER_ONLY' });
  }
}

/** A phase's new rules, checked for shape. Cloudflare checks what each rule says. */
function rulesBody(phase, body) {
  refuseUnknownFields(body, ['rules', 'description', 'expectedVersion']);
  refuseVersionShape(body);
  if (!Array.isArray(body.rules) || body.rules.length > MAX_RULES) throw bad(`rules must be a list of at most ${MAX_RULES} rules.`);
  if (body.rules.length === 0) throw bad('rules may not be empty: an empty list deletes every rule in the phase, and deleting is done in the Cloudflare dashboard.');
  if (!body.rules.every(isRule)) throw bad('Each rule must be an object.');
  refuseRuleContents(phase, body.rules);
  const out = { rules: body.rules.map(withoutStamps) };
  if (body.description !== undefined) {
    if (typeof body.description !== 'string' || body.description.length > 500) throw bad('description must be text of at most 500 characters.');
    out.description = body.description;
  }
  return out;
}

/** PUT cms/cloudflare/rulesets/phases/{phase}. */
export async function putPhase(call) {
  const { request, client, user } = call;
  const phase = phaseOf(request);
  const reason = phaseProtection(phase);
  if (reason) throw protectedRefusal('That rule phase may not be changed from here', reason);
  const body = await bodyOf(request);
  const sent = rulesBody(phase, body);
  await requireOurZone(client);
  const current = await refuseStale(client, phase, body.expectedVersion);
  refuseAgentRemoval(user, current, sent.rules);
  const saved = await client.putPhase(phase, sent);
  const count = sent.rules.length;
  const audited = await recordChange(call, { family: 'rules', phase, count }, `replaced the Cloudflare rules in the ${phase} phase (${count} rule(s)).`);
  return json(200, { ok: true, ruleset: rulesetView(phase, saved), audited });
}
