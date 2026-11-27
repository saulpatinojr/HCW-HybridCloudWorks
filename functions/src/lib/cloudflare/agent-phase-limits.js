/**
 * cloudflare/agent-phase-limits.js — what an agent key may not do in a
 * particular rule phase (#1903, #1933), on top of the limits it has in
 * every phase (rules-guards.js: no removing a rule, no owner-only setting
 * in a rule). A super_admin person has none of these limits.
 *
 * One list, AGENT_PHASE_LIMITS, says which limits each phase has:
 *
 *   noSwitchOff   no switching a rule off, and no new rule that starts off
 *                 (a rule switched off is removed in effect)
 *   noResponse    no custom response (action_parameters.response)
 *   httpsTargets  a new or changed redirect sends visitors only to an
 *                 https:// address
 *   keepAsIs      no adding, changing, switching or moving a rule at all
 *
 * Why the redirect and URL rewrite phases have theirs (#1933):
 *
 *   - A redirect to an http:// address sends that visitor to a page without
 *     encryption, which is what the owner-only setting always_use_https
 *     exists to stop. Cloudflare's redirect fields are documented at
 *     https://developers.cloudflare.com/rules/url-forwarding/single-redirects/settings/
 *     (read 2026-11-27): action_parameters.from_value holds target_url
 *     (`value` for a fixed address, `expression` for one worked out per
 *     request), status_code and preserve_query_string. A fixed address
 *     without a scheme is sent as it is, and a browser reads it as a path
 *     on the address it is on, which may be http://.
 *   - A URL rewrite runs before the configuration rules, the custom
 *     security rules, the rate limit, the cache rules and Cloudflare's own
 *     managed rules (https://developers.cloudflare.com/ruleset-engine/reference/phases-list/,
 *     read 2026-11-27), and every one of them then sees the rewritten path
 *     and query. So a rewrite can make an owner's rule that matches on the
 *     path stop matching, or start matching. This page cannot work out
 *     which rewrites would do that without running Cloudflare's rules
 *     language, so the rewrite phase is the owner's: an agent key must send
 *     its rules back exactly as they are.
 */
import { Refusal } from './input.js';
import { isAgentUser } from '../agent-content/agent-keys.js';
import { actorOf } from './record.js';
import { behaviourOf, isPlainObject, rulesById, unchangedFrom } from './rule-shape.js';

const REDIRECT = 'http_request_dynamic_redirect';
const URL_REWRITE = 'http_request_transform';

/** Each phase with limits of its own, what its rules are called in a refusal, and its limits. */
export const AGENT_PHASE_LIMITS = Object.freeze({
  http_request_firewall_custom: Object.freeze({ rule: 'custom security rule', limits: Object.freeze(['noSwitchOff', 'noResponse']) }),
  http_ratelimit: Object.freeze({ rule: 'rate limiting rule', limits: Object.freeze(['noSwitchOff', 'noResponse']) }),
  [REDIRECT]: Object.freeze({ rule: 'redirect', limits: Object.freeze(['noSwitchOff', 'httpsTargets']) }),
  [URL_REWRITE]: Object.freeze({ rule: 'URL rewrite rule', limits: Object.freeze(['keepAsIs']) }),
});

/** Whether a phase has a limit. Own entries only, so `constructor` has none. */
export const hasLimit = (phase, limit) => Object.hasOwn(AGENT_PHASE_LIMITS, phase) && AGENT_PHASE_LIMITS[phase].limits.includes(limit);

/** The phases with a limit, in the list's order. */
export const phasesWith = (limit) => Object.keys(AGENT_PHASE_LIMITS).filter((phase) => hasLimit(phase, limit));

/** What a phase's rules are called in a refusal. */
export const ruleNameOf = (phase) => (Object.hasOwn(AGENT_PHASE_LIMITS, phase) ? AGENT_PHASE_LIMITS[phase].rule : 'rule');

const OWNER_STEP = 'Change it on the Cloudflare page yourself, signed in as the owner.';

/** Why an agent key's redirect must go to an https:// address: the reason the page shows. */
export const HTTPS_REDIRECT_REASON = `A redirect to an http:// address sends visitors to a page without encryption, which the zone setting always_use_https keeps for the owner. ${OWNER_STEP}`;

/** Why the URL rewrite phase stays as it is for an agent key: the reason the page shows. */
export const KEEP_REWRITES_REASON = `A URL rewrite changes the path and query that every later rule sees, the owner's rules that match on them included, so URL rewrites are the owner's. ${OWNER_STEP}`;

/** A fixed redirect address that starts with https:// (any letter case, as browsers read a scheme). */
const HTTPS_VALUE = /^https:\/\//i;

/**
 * A redirect address worked out per request whose result starts with
 * https://: a string that starts with it, or concat( whose first part is
 * such a string. The string may be plain ("...") or raw (r"..." or
 * r#"..."#). The result of concat starts with its first part, so the scheme
 * is fixed by text this check reads. Any other start (wildcard_replace, a
 * field, another function) is refused, because its result can be the
 * request's own http:// address.
 */
const HTTPS_EXPRESSION = /^\s*(?:concat\(\s*)?(?:r#*)?"https:\/\//;

const FROM_VALUE_FIELDS = Object.freeze(['target_url', 'status_code', 'preserve_query_string']);
const TARGET_FIELDS = Object.freeze(['value', 'expression']);

/** Whether every key of an object is one of `allowed`. */
const onlyFields = (object, allowed) => Object.keys(object).every((key) => allowed.includes(key));

/** What is wrong with a redirect's target, as the end of a sentence, or '' when nothing is. */
function targetProblem(target) {
  const sent = TARGET_FIELDS.filter((field) => Object.hasOwn(target, field));
  if (sent.length !== 1 || !onlyFields(target, TARGET_FIELDS)) return 'its target_url must hold exactly one of value or expression';
  if (sent[0] === 'value') return typeof target.value === 'string' && HTTPS_VALUE.test(target.value) ? '' : 'a fixed target (target_url.value) must start with https://';
  const fixedStart = typeof target.expression === 'string' && HTTPS_EXPRESSION.test(target.expression);
  return fixedStart ? '' : 'a target worked out per request (target_url.expression) must be a string starting with "https://", or concat( whose first part is such a string';
}

/** What is wrong with a redirect rule from an agent key, as the end of a sentence, or '' when nothing is. */
function redirectProblem(rule) {
  if (rule.action !== 'redirect') return 'its action must be redirect';
  const parameters = rule.action_parameters;
  const shaped = [isPlainObject(parameters), isPlainObject(parameters?.from_value)].every(Boolean);
  if (!shaped || !onlyFields(parameters, ['from_value'])) return 'its action_parameters must hold only from_value';
  const from = parameters.from_value;
  if (!onlyFields(from, FROM_VALUE_FIELDS) || !isPlainObject(from.target_url)) return 'its from_value must hold target_url, and only status_code and preserve_query_string besides';
  return targetProblem(from.target_url);
}

/**
 * Refuses (403, nothing written) an agent key's redirect that is new or
 * changed and does not send visitors to an https:// address. A redirect
 * that comes back doing exactly what it does now is left alone, so an
 * owner's redirect elsewhere can stay while the agent key changes others.
 */
function refuseHttpRedirects(user, phase, current, rules) {
  const held = rulesById(current);
  rules.forEach((rule, index) => {
    if (unchangedFrom(held, rule)) return;
    const problem = redirectProblem(rule);
    if (!problem) return;
    const message = `${actorOf(user)} (an agent key) may not add or change a redirect (rule ${index + 1}) whose target is not an https:// address: ${problem}. It stands in for the zone setting always_use_https. ${HTTPS_REDIRECT_REASON}`;
    throw new Refusal(message, { status: 403, code: 'CLOUDFLARE_OWNER_ONLY', reason: HTTPS_REDIRECT_REASON });
  });
}

/** Refuses (403) an agent key's list that does not hand back the phase's rules exactly as they are, in the same order. */
function refuseChangedPhase(user, phase, current, rules) {
  const now = (Array.isArray(current?.rules) ? current.rules : []).map((rule) => `${rule?.id}:${behaviourOf(rule)}`);
  const sent = rules.map((rule) => `${rule?.id}:${behaviourOf(rule)}`);
  if (now.length === sent.length && now.every((entry, index) => entry === sent[index])) return;
  const message = `${actorOf(user)} (an agent key) may not add, change, switch on or off, or move a ${ruleNameOf(phase)} (${phase}): it must send the phase's rules back as they are. ${KEEP_REWRITES_REASON}`;
  throw new Refusal(message, { status: 403, code: 'CLOUDFLARE_OWNER_ONLY', reason: KEEP_REWRITES_REASON });
}

/** The check for each limit that reads the phase as it is now. */
const CHECKS = Object.freeze({ httpsTargets: refuseHttpRedirects, keepAsIs: refuseChangedPhase });

/**
 * Refuses (403, nothing written) what an agent key's list may not do in its
 * phase, for the limits that compare it with the phase as it is now
 * (httpsTargets, keepAsIs). noSwitchOff and noResponse are rules-guards.js.
 */
export function refuseAgentPhaseLimits(user, phase, current, rules) {
  if (!isAgentUser(user)) return;
  for (const [limit, check] of Object.entries(CHECKS)) {
    if (hasLimit(phase, limit)) check(user, phase, current, rules);
  }
}
