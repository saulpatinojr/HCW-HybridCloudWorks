/**
 * cloudflare/rules-guards.js — what an agent key may not do to a phase's
 * rules, and the check that catches a write landing between the freshness
 * check and this write (#1903, #1910). Split out of rules-routes.js, which
 * reads them, to keep each file small; the behaviour is unchanged.
 *
 *   - An agent key may add and change rules but never remove one.
 *   - In the guarded phases (custom security rules and the rate limit) it
 *     may not switch a rule off or add one switched off, nor set a custom
 *     response.
 *   - In any phase, it may not add, change, switch off or move a rule that
 *     sets an owner-only zone setting for the requests it matches, such as
 *     a configuration rule's `ssl` or a response header rule's
 *     Strict-Transport-Security (#1931). Such a rule the owner made may come
 *     back unchanged.
 *
 * A super_admin person may do all of these.
 */
import { Refusal } from './input.js';
import { isAgentUser } from '../agent-content/agent-keys.js';
import { ownerOnlyRuleTouches } from './protected.js';
import { actorOf } from './record.js';

const FIREWALL_CUSTOM = 'http_request_firewall_custom';

/** The phases whose rules protect the site: an agent key may not switch one off or give it a custom response. */
export const GUARDED_PHASES = Object.freeze([FIREWALL_CUSTOM, 'http_ratelimit']);

/** A ruleset's version as the freshness check compares it: Cloudflare's version, else last_updated, else null. */
export const versionOf = (ruleset) => (ruleset ? String(ruleset.version ?? ruleset.last_updated ?? '') || null : null);

/** A 403 refusal: what an agent key may not do, which the owner does on the Cloudflare page. */
const ownerOnly = (message) => new Refusal(message, { status: 403, code: 'CLOUDFLARE_OWNER_ONLY' });

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
export function refuseAgentRemoval(user, current, rules) {
  if (!isAgentUser(user)) return;
  const kept = new Set(idsOf(rules));
  if (idsOf(current?.rules).some((id) => !kept.has(id))) throw ownerOnly(AGENT_REMOVAL_MESSAGE);
}

export const AGENT_DISABLE_MESSAGE =
  'An agent key may not switch a security or rate limiting rule off, or add one that starts switched off: a rule switched off is removed in effect. Switching a rule off is done by the owner on the Cloudflare page.';
export const AGENT_RESPONSE_MESSAGE =
  'An agent key may not set a custom response (action_parameters.response) on a security or rate limiting rule. That is done by the owner on the Cloudflare page.';

/** Whether a rule is switched on: Cloudflare reads a rule with no `enabled` as on. */
const isOn = (rule) => rule?.enabled === undefined || rule?.enabled === true;

/** Refuses (403) an agent key's custom response in a guarded phase. Needs no read, so it runs before any Cloudflare call. */
export function refuseAgentResponse(user, phase, rules) {
  if (!isAgentUser(user) || !GUARDED_PHASES.includes(phase)) return;
  const responds = rules.some((rule) => rule.action_parameters && typeof rule.action_parameters === 'object' && Object.hasOwn(rule.action_parameters, 'response'));
  if (responds) throw ownerOnly(AGENT_RESPONSE_MESSAGE);
}

/**
 * Refuses (403) an agent key's list, in a guarded phase, that switches a
 * rule off: a current rule that is on and comes back not on, or a new rule
 * (an id the phase does not hold) that is not on. A rule already off may
 * stay off.
 */
export function refuseAgentDisable(user, phase, current, rules) {
  if (!isAgentUser(user) || !GUARDED_PHASES.includes(phase)) return;
  const before = new Map((Array.isArray(current?.rules) ? current.rules : []).filter((rule) => typeof rule?.id === 'string' && rule.id).map((rule) => [rule.id, rule]));
  const switchedOff = rules.some((rule) => {
    if (isOn(rule)) return false;
    const was = typeof rule.id === 'string' ? before.get(rule.id) : undefined;
    return !was || isOn(was);
  });
  if (switchedOff) throw ownerOnly(AGENT_DISABLE_MESSAGE);
}

/** A value as text with every object's keys in order, so two equal rules give the same text whatever order their fields came in. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The value a touch names in its rule: the field of action_parameters, or the header. */
function touchedValue(rule, touch) {
  const parameters = rule.action_parameters;
  return touch.place === 'header' ? parameters.headers[touch.key] : parameters[touch.key];
}

/**
 * The rules of a list that set something only the owner may set, in the
 * list's order, each as `{ id, touches, fingerprint }`. The fingerprint is
 * what decides that setting for the requests the rule matches: what the rule
 * matches, whether it is on, its action and the values it sets for owner-only
 * settings. Nothing else in the rule counts, so an agent key may still change
 * the rest of such a rule.
 */
function ownerOnlyRules(phase, rules) {
  return (Array.isArray(rules) ? rules : []).flatMap((rule) => {
    const touches = ownerOnlyRuleTouches(phase, rule);
    if (!touches.length) return [];
    const values = Object.fromEntries(touches.map((touch) => [touch.key, touchedValue(rule, touch)]));
    const fingerprint = canonical({ expression: rule.expression ?? null, on: isOn(rule), action: rule.action ?? null, values });
    return [{ id: typeof rule.id === 'string' ? rule.id : null, touches, fingerprint }];
  });
}

/** Whether two owner-only rules are the same rule deciding the same thing. */
const sameRule = (a, b) => Boolean(a && b && a.id && a.id === b.id && a.fingerprint === b.fingerprint);

/** The longest name a refusal repeats back; a field a caller made up can be any length. */
const MAX_NAME_IN_MESSAGE = 64;

/** The 403 refusal for one owner-only touch, naming the key, the setting and the reason. */
function ownerOnlyRuleRefusal(user, phase, touch) {
  const name = touch.name.slice(0, MAX_NAME_IN_MESSAGE);
  const what = touch.place === 'header' ? `the ${name} header` : `the field ${name}`;
  const setting = touch.setting ? `the zone setting ${touch.setting}, which only the owner changes` : 'a zone setting this page does not know';
  const message = `${actorOf(user)} (an agent key) may not add, change, switch off or move a rule in the ${phase} phase that sets ${what}: it changes ${setting}. ${touch.reason}`;
  return new Refusal(message, { status: 403, code: 'CLOUDFLARE_OWNER_ONLY', reason: touch.reason });
}

/**
 * Refuses (403, nothing written) an agent key's list that adds, changes,
 * switches off, strips or moves a rule setting an owner-only zone setting
 * (protected.js RULE_SETTING_PARAMETERS, #1931). The rules in the new list
 * that set one must be the very rules the phase holds now, in the same
 * order, each deciding the same thing; order counts because when two rules
 * match a request, the later one's value is the one used. A rule the owner
 * made may therefore come back unchanged, which an agent key must do,
 * since it may not leave a rule out. A person (super_admin) may do all of it.
 */
export function refuseAgentOwnerOnlyRules(user, phase, current, rules) {
  if (!isAgentUser(user)) return;
  const now = ownerOnlyRules(phase, current?.rules);
  const sent = ownerOnlyRules(phase, rules);
  if (now.length === sent.length && now.every((rule, index) => sameRule(rule, sent[index]))) return;
  // Name what changed: a rule sent that the phase does not hold as it is,
  // else a current one that did not come back as it is, else (only the
  // order moved) the first current one.
  const culprit = sent.find((rule) => !now.some((held) => sameRule(held, rule))) ?? now.find((held) => !sent.some((rule) => sameRule(held, rule))) ?? now[0];
  throw ownerOnlyRuleRefusal(user, phase, culprit.touches[0]);
}

/**
 * Cloudflare numbers a rule set's versions one after another, and a write
 * makes the next one. If the saved version is further on than the one just
 * checked plus one, another write landed between the check and this write,
 * and this write may have replaced it. Cloudflare's rule set update takes no
 * condition, so this is caught afterwards and the owner is told. A phase with
 * no rule set yet counts as version 0: the first write makes version 1
 * (Cloudflare's create examples), so a saved version past 1 means two first
 * writes raced. Answers the note for the owner, or null (also when a version
 * is not a number).
 */
export function concurrentWriteNote(current, saved) {
  const [was, now] = [current ? versionOf(current) : '0', versionOf(saved)];
  if (was === null || now === null || !/^\d+$/.test(was) || !/^\d+$/.test(now)) return null;
  const [before, after] = [Number(was), Number(now)];
  if (after <= before + 1) return null;
  return 'Another change to this phase was saved between the check and this write, so this write may have replaced it. Check the phase on the Cloudflare page.';
}
