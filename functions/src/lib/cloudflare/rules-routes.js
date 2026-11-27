/**
 * cloudflare/rules-routes.js — the Cloudflare page's rule routes (#1905):
 * list the zone's rulesets, read one phase's rules, replace one phase's
 * rules, in the zone the request names (#1911; the allow-list and every
 * guard below are the same in each zone). A phase is the point in handling a request where a group of rules
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
 *
 * THE GUARDED PHASES. In the custom security rules and the rate limiting
 * rules (GUARDED_PHASES), a rule protects the site, so an agent key is held
 * to two more limits, each 403 CLOUDFLARE_OWNER_ONLY before anything is
 * written: it may not switch a rule off (an existing rule sent back with
 * `enabled` anything but true, or a new rule that starts that way), because
 * a rule switched off is a rule removed in effect; and it may not set a
 * custom response (`action_parameters.response`), the body Cloudflare sends
 * a blocked caller, which only a paid plan offers and is closed ahead of
 * time.
 *
 * OWNER-ONLY SETTINGS IN A RULE (#1931). A rule can set some zone settings
 * for the requests it matches: a configuration rule's `ssl`, or a response
 * header rule's Strict-Transport-Security (HSTS). An agent key may not
 * change those settings on the settings route, so it may not add, change,
 * switch off or move a rule that sets one either (403
 * CLOUDFLARE_OWNER_ONLY, naming the key and the setting). The list of such
 * fields is protected.js RULE_SETTING_PARAMETERS.
 */
import { Refusal, bad, bodyOf, json, paramOf, protectedRefusal, refuseUnknownFields } from './input.js';
import { RATE_LIMIT_PHASE, rateLimitVerdict } from './rate-limit.js';
import { recordChange, requireOurZone } from './record.js';
import {
  AGENT_DISABLE_MESSAGE,
  AGENT_REMOVAL_MESSAGE,
  AGENT_RESPONSE_MESSAGE,
  GUARDED_PHASES,
  concurrentWriteNote,
  refuseAgentDisable,
  refuseAgentOwnerOnlyRules,
  refuseAgentRemoval,
  refuseAgentResponse,
  versionOf,
} from './rules-guards.js';

export { AGENT_DISABLE_MESSAGE, AGENT_REMOVAL_MESSAGE, AGENT_RESPONSE_MESSAGE, GUARDED_PHASES, concurrentWriteNote, versionOf };
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


export const STALE_MESSAGE = 'This phase changed since you opened it; reload it and make your change again.';

const pickRuleset = (ruleset, zoneName) => ({
  id: ruleset?.id ?? null,
  name: ruleset?.name ?? null,
  phase: ruleset?.phase ?? null,
  kind: ruleset?.kind ?? null,
  description: ruleset?.description ?? null,
  version: versionOf(ruleset),
  locked: phaseProtection(ruleset?.phase, zoneName) !== null,
  lockedReason: phaseProtection(ruleset?.phase, zoneName),
});

/** A ruleset with its rules, as the phase routes answer it. */
const rulesetView = (phase, ruleset, zoneName) => ({ ...pickRuleset(ruleset, zoneName), rules: rulesFor(phase, ruleset?.rules) });

/** GET cms/cloudflare/rulesets. Metadata only: no rules. */
export async function listRulesets({ client, zone }) {
  const rulesets = await client.listRulesets();
  return json(200, { ok: true, rulesets: (Array.isArray(rulesets) ? rulesets : []).map((ruleset) => pickRuleset(ruleset, zone.name)) });
}

/** The phase in the path, checked. */
function phaseOf(request) {
  const phase = paramOf(request, 'phase');
  if (!PHASE_PATTERN.test(phase)) throw bad('The phase must be 1 to 64 lower-case letters, digits or underscores.');
  return phase;
}

/** GET cms/cloudflare/rulesets/phases/{phase}. */
/**
 * For the rate limiting phase only, the verdict on it (#1918): whether a rule
 * is on, in the words the Health card and the Overview show. It is worked out
 * here, from the rules as Cloudflare answered them, by the same rule the daily
 * check uses (rate-limit.js), so the browser never judges the rules itself.
 */
const verdictOf = (phase, ruleset) =>
  phase === RATE_LIMIT_PHASE ? { rateLimit: rateLimitVerdict({ ruleset }) } : {};

export async function getPhase({ request, client, zone }) {
  const phase = phaseOf(request);
  const ruleset = await client.getPhase(phase);
  const lockedReason = phaseProtection(phase, zone.name);
  return json(200, {
    ok: true,
    ruleset: ruleset ? rulesetView(phase, ruleset, zone.name) : null,
    version: versionOf(ruleset),
    editable: isEditablePhase(phase),
    locked: lockedReason !== null,
    lockedReason,
    ...verdictOf(phase, ruleset),
  });
}

const isRule = (rule) => Boolean(rule) && typeof rule === 'object' && !Array.isArray(rule);
const withoutStamps = (rule) => Object.fromEntries(Object.entries(rule).filter(([key]) => !STAMPS.includes(key)));

/** A field name as Cloudflare writes it: lower-case letters, digits and underscores. */
const FIELD_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Whether a rule's own field names, and those directly under its
 * action_parameters, are all written as Cloudflare writes them (#1931
 * review). The guards read `action_parameters`, `headers` and `response`
 * by exact name; a name in other letters (`Action_Parameters`, `Headers`)
 * would pass them unread if Cloudflare took it anyway, so it is refused
 * here. Header names one level further down may be in any case.
 */
function fieldNamesAsCloudflareWrites(rule) {
  const parameters = rule.action_parameters;
  const parameterNames = parameters && typeof parameters === 'object' && !Array.isArray(parameters) ? Object.keys(parameters) : [];
  return [...Object.keys(rule), ...parameterNames].every((name) => FIELD_NAME.test(name));
}

/** Refuses what a phase's new rules may not hold. */
function refuseRuleContents(phase, rules) {
  if (!rules.every(fieldNamesAsCloudflareWrites)) {
    throw bad("A rule's field names, and those under action_parameters, must be lower-case letters, digits and underscores, as Cloudflare writes them.");
  }
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
  const { request, client, user, zone } = call;
  const phase = phaseOf(request);
  const reason = phaseProtection(phase, zone.name);
  if (reason) throw protectedRefusal('That rule phase may not be changed from here', reason);
  const body = await bodyOf(request);
  const sent = rulesBody(phase, body);
  refuseAgentResponse(user, phase, sent.rules);
  await requireOurZone(client, zone.name);
  const current = await refuseStale(client, phase, body.expectedVersion);
  refuseAgentRemoval(user, current, sent.rules);
  refuseAgentDisable(user, phase, current, sent.rules);
  refuseAgentOwnerOnlyRules(user, phase, current, sent.rules);
  const saved = await client.putPhase(phase, sent);
  const count = sent.rules.length;
  const note = concurrentWriteNote(current, saved);
  const details = { family: 'rules', phase, count, ...(note ? { concurrentWrite: true } : {}) };
  const audited = await recordChange(call, details, `replaced the Cloudflare rules in the ${phase} phase (${count} rule(s)).`, note ? [note] : []);
  return json(200, { ok: true, ruleset: rulesetView(phase, saved, zone.name), audited, concurrentWrite: Boolean(note) });
}
