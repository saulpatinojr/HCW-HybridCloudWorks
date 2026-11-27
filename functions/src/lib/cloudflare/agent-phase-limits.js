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
 *   appendOnly    the rules the phase holds now come back first, exactly
 *                 as they are and in the same order; new rules go after them
 *   httpsTargets  a new redirect sends visitors only to an https:// address
 *                 on one of the managed zones
 *   keepAsIs      the rules come back exactly as they are, and none is added
 *
 * Why the redirect and URL rewrite phases have theirs (#1933):
 *
 *   - Redirects. The first redirect that matches a request is the one used:
 *     a redirect ends the request, so later redirects never run
 *     (https://developers.cloudflare.com/ruleset-engine/rules-language/actions/,
 *     read 2026-11-27). Changing a redirect the phase holds now, or putting
 *     a new one before it, can therefore turn off a redirect the owner
 *     relies on, such as one that sends visitors from http:// to https://.
 *     This page does not know who made a rule, so every redirect the phase
 *     holds now is treated as the owner's: an agent key may only add
 *     redirects after them.
 *   - A redirect to an http:// address sends that visitor to a page without
 *     encryption, which is what the owner-only setting always_use_https
 *     exists to stop. Cloudflare's redirect fields are documented at
 *     https://developers.cloudflare.com/rules/url-forwarding/single-redirects/settings/
 *     (read 2026-11-27): action_parameters.from_value holds target_url
 *     (`value` for a fixed address, `expression` for one worked out per
 *     request), status_code and preserve_query_string. A fixed address
 *     without a scheme is sent as it is, and a browser reads it as a path
 *     on the address it is on, which may be http://.
 *   - A redirect to another site lets anyone send a visitor there through
 *     the site's own address (an open redirect), so an agent key's new
 *     redirect also stays on the managed zones (MANAGED_ZONES): an apex or
 *     one of its subdomains, the rule the purge route already uses.
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
import { behaviourOf, isPlainObject } from './rule-shape.js';
import { MANAGED_ZONES, onManagedZone } from './protected.js';

const REDIRECT = 'http_request_dynamic_redirect';
const URL_REWRITE = 'http_request_transform';

/** Each phase with limits of its own, what its rules are called in a refusal, and its limits. */
export const AGENT_PHASE_LIMITS = Object.freeze({
  http_request_firewall_custom: Object.freeze({ rule: 'custom security rule', limits: Object.freeze(['noSwitchOff', 'noResponse']) }),
  http_ratelimit: Object.freeze({ rule: 'rate limiting rule', limits: Object.freeze(['noSwitchOff', 'noResponse']) }),
  [REDIRECT]: Object.freeze({ rule: 'redirect', limits: Object.freeze(['noSwitchOff', 'appendOnly', 'httpsTargets']) }),
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
export const HTTPS_REDIRECT_REASON = `A redirect to an http:// address sends visitors to a page without encryption, which the zone setting always_use_https keeps for the owner, and a redirect to another site lets anyone send visitors there through the site's own address. ${OWNER_STEP}`;

/** Why an agent key may only add redirects after the ones the phase holds now: the reason the page shows. */
export const KEEP_REDIRECTS_REASON = `The first redirect that matches a request is the one used, so changing a redirect, or putting a new one before it, can turn off one the owner relies on, such as one that sends visitors from http:// to https:// in place of always_use_https. ${OWNER_STEP}`;

/** Why the URL rewrite phase stays as it is for an agent key: the reason the page shows. */
export const KEEP_REWRITES_REASON = `A URL rewrite changes the path and query that every later rule sees, the owner's rules that match on them included, so URL rewrites are the owner's. ${OWNER_STEP}`;

/** The managed zones, as a refusal names them. */
const ZONE_NAMES = MANAGED_ZONES.map((zone) => zone.name).join(' or ');

/** A fixed address as written: printable characters only, no space and no backslash, which browsers read as a slash. */
const PLAIN_ADDRESS = /^[\x21-\x5b\x5d-\x7e]+$/;

/**
 * Whether a fixed redirect address goes to an https:// page on a managed
 * zone (#1933 review): https in any letter case, a host that is one of the
 * zones or a subdomain of one, no user name or password before the host
 * (`https://zone@elsewhere` goes to elsewhere) and no port. An address
 * Node cannot read is refused.
 */
function onOurHttps(value) {
  if (typeof value !== 'string' || !PLAIN_ADDRESS.test(value) || !/^https:\/\//i.test(value)) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const checks = [url.protocol === 'https:', url.username === '', url.password === '', url.port === '', onManagedZone(url.hostname.toLowerCase())];
  return checks.every(Boolean);
}

/**
 * The start of a redirect address worked out per request: an optional
 * concat(, then a string, plain ("...") or raw (r"..." or r#"..."#), then
 * what follows it. Letters may be in any case.
 */
const EXPRESSION_START = /^\s*(concat\(\s*)?(?:r(#*)"([\s\S]*?)"\2|"([^"\\]*)")([\s\S]*)$/i;

/** The start of a string that fixes the address's scheme and host: https://, a host, then a slash or the string's end. */
const HTTPS_HOST = /^https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*)(\/|$)/i;

/** The fields that always start with a slash, so a host written just before one is the whole host. */
const PATH_FIELDS = Object.freeze(['http.request.uri.path', 'http.request.uri', 'raw.http.request.uri.path', 'raw.http.request.uri']);

/** Whether what follows a string inside concat( starts with one of PATH_FIELDS as the next part. */
const nextPartIsPath = (rest) => PATH_FIELDS.some((field) => new RegExp(`^\\s*,\\s*${field.replace(/\./g, '\\.')}\\s*[,)]`).test(rest));

/**
 * Whether a redirect address worked out per request goes to an https://
 * page on a managed zone (#1933 review). Its first string, on its own or
 * as the first part of concat(, must start with https:// and a managed
 * host. The result of concat starts with its first part, so the scheme and
 * host are fixed by text this check reads. The host must end in a slash,
 * or at the end of a string that is the whole address, or (inside concat)
 * just before a field that always starts with a slash; otherwise the next
 * part could carry the host on (`.elsewhere`). A plain string may hold no
 * backslash. Anything else (wildcard_replace, a field first, another
 * function) is refused, because its result can be the request's own
 * http:// address or another site.
 */
function expressionOnOurHttps(expression) {
  const found = typeof expression === 'string' ? EXPRESSION_START.exec(expression) : null;
  if (!found) return false;
  const [, inConcat, , raw, plain, rest] = found;
  const head = HTTPS_HOST.exec(raw ?? plain);
  if (!head || !onManagedZone(head[1].toLowerCase())) return false;
  if (head[2] === '/') return true;
  return inConcat ? nextPartIsPath(rest) : rest.trim() === '';
}

const FROM_VALUE_FIELDS = Object.freeze(['target_url', 'status_code', 'preserve_query_string']);
const TARGET_FIELDS = Object.freeze(['value', 'expression']);

/** Whether every key of an object is one of `allowed`. */
const onlyFields = (object, allowed) => Object.keys(object).every((key) => allowed.includes(key));

/** What is wrong with a redirect's target, as the end of a sentence, or '' when nothing is. It never repeats the target. */
function targetProblem(target) {
  const sent = TARGET_FIELDS.filter((field) => Object.hasOwn(target, field));
  if (sent.length !== 1 || !onlyFields(target, TARGET_FIELDS)) return 'its target_url must hold exactly one of value or expression';
  if (sent[0] === 'value') {
    return onOurHttps(target.value) ? '' : `a fixed target (target_url.value) must be an https:// address on ${ZONE_NAMES} or one of their subdomains, with no user name or port`;
  }
  return expressionOnOurHttps(target.expression)
    ? ''
    : `a target worked out per request (target_url.expression) must start with a string holding https:// and a host on ${ZONE_NAMES} or one of their subdomains, followed by a slash, on its own or as the first part of concat(`;
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

/** A rule as the held-rules comparison reads it: its id and what it does. Its description does not count. */
const heldEntry = (rule) => `${typeof rule?.id === 'string' ? rule.id : ''}:${behaviourOf(rule)}`;

/**
 * How many rules at the start of the list sent are the phase's rules as
 * they are now, one for one and in the same order (same id, same
 * behaviour). The rules after them are new or changed.
 */
function heldPrefix(current, rules) {
  const now = (Array.isArray(current?.rules) ? current.rules : []).map(heldEntry);
  const sent = rules.map(heldEntry);
  const firstDifferent = now.findIndex((entry, index) => entry !== sent[index]);
  return { kept: firstDifferent === -1 ? now.length : firstDifferent, held: now.length };
}

/** The 403 refusal of a limit, naming the key, with the reason the page shows. */
const limitRefusal = (message, reason) => new Refusal(`${message} ${reason}`, { status: 403, code: 'CLOUDFLARE_OWNER_ONLY', reason });

/** Refuses (403) a list whose start is not the phase's rules exactly as they are now. */
function refuseChangedHeld(user, phase, current, rules) {
  const { kept, held } = heldPrefix(current, rules);
  if (kept === held) return;
  const message = `${actorOf(user)} (an agent key) may not change, switch on or off, or move a ${ruleNameOf(phase)} the ${phase} phase holds now, or put a new one before it: the ones it holds now must come first, as they are, and new ones after them.`;
  throw limitRefusal(message, KEEP_REDIRECTS_REASON);
}

/** Refuses (403) a new redirect, one after the rules the phase holds now, that does not send visitors to an https:// address. */
function refuseHttpRedirects(user, phase, current, rules) {
  const { kept } = heldPrefix(current, rules);
  rules.forEach((rule, index) => {
    if (index < kept) return;
    const problem = redirectProblem(rule);
    if (!problem) return;
    const message = `${actorOf(user)} (an agent key) may not add a redirect (rule ${index + 1}) whose target is not an https:// address on the site's own zones: ${problem}. It stands in for the zone setting always_use_https.`;
    throw limitRefusal(message, HTTPS_REDIRECT_REASON);
  });
}

/** Refuses (403) a list that does not hand back the phase's rules exactly as they are, in the same order, with nothing added. */
function refuseChangedPhase(user, phase, current, rules) {
  const { kept, held } = heldPrefix(current, rules);
  if (kept === held && rules.length === held) return;
  const message = `${actorOf(user)} (an agent key) may not add, change, switch on or off, or move a ${ruleNameOf(phase)} (${phase}): it must send the phase's rules back as they are.`;
  throw limitRefusal(message, KEEP_REWRITES_REASON);
}

/** The check for each limit that reads the phase as it is now, in the order they run. */
const CHECKS = Object.freeze({ appendOnly: refuseChangedHeld, httpsTargets: refuseHttpRedirects, keepAsIs: refuseChangedPhase });

/**
 * Refuses (403, nothing written) what an agent key's list may not do in its
 * phase, for the limits that compare it with the phase as it is now
 * (appendOnly, httpsTargets, keepAsIs). noSwitchOff and noResponse are
 * rules-guards.js.
 */
export function refuseAgentPhaseLimits(user, phase, current, rules) {
  if (!isAgentUser(user)) return;
  for (const [limit, check] of Object.entries(CHECKS)) {
    if (hasLimit(phase, limit)) check(user, phase, current, rules);
  }
}
