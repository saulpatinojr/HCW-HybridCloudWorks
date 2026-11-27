/**
 * cloudflare/rate-limit.js — is the API rate limit rule in place? (#1909)
 *
 * The rule that stops one address from flooding the site's API lives in the
 * site zone's `http_ratelimit` rule phase. Since #1903 it is made and looked
 * after on the Cloudflare page and by Claude Network Guy, not by Terraform,
 * so no Terraform plan would show it missing any more. The Cloudflare
 * page's status answer reads the phase (zone-routes.js) and carries the
 * answer built here; the Health page's "API rate limit" probe and the
 * Overview tab both show it.
 *
 * The answer is a state, the number of rules switched on and the number in
 * the phase, and a sentence written here. It never holds a rule, an
 * expression or a limit: the count is enough to say whether the site is
 * covered, and the Rules tab shows the rule itself to whoever may read it.
 *
 * It imports nothing, so the browser's mirror test
 * (frontend/src/components/admin/cloudflare/cloudflareView.test.js) reads
 * RATE_LIMIT_STATES directly and fails when the page has no tone for a state.
 */

/** The rule phase the API rate limit lives in. */
export const RATE_LIMIT_PHASE = 'http_ratelimit';

/** Where the owner is sent when the rule is missing or off: the runbook part that makes it. */
const MAKE_IT = 'Make it, or switch it back on, as part 4 of the Cloudflare admin runbook says (the Rules tab of the Cloudflare page, or ask Claude Network Guy).';

const UNCOVERED = 'so one address can send the API as many requests as it likes';

const rules = (count) => `${count} rule${count === 1 ? '' : 's'}`;

/**
 * The sentence for each state. `on`, `empty` and `off` come from the phase
 * itself; `refused` and `unreachable` mean the phase could not be read, so
 * nothing is known about the rule. None of them quotes Cloudflare.
 */
const SENTENCES = Object.freeze({
  on: ({ enabled }) => `The API rate limit is on: ${rules(enabled)} switched on in the ${RATE_LIMIT_PHASE} phase.`,
  empty: () => `The API rate limit is missing: the ${RATE_LIMIT_PHASE} phase holds no rule, ${UNCOVERED}. ${MAKE_IT}`,
  off: ({ total }) => `The API rate limit is switched off: the ${RATE_LIMIT_PHASE} phase holds ${rules(total)} and none is switched on, ${UNCOVERED}. ${MAKE_IT}`,
  refused: () =>
    `Cloudflare refused the admin token when the site read the ${RATE_LIMIT_PHASE} phase, so it is not known whether the API rate limit is on. The token may be wrong or expired, or lack the Zone WAF permission (part 2 of the Cloudflare admin runbook).`,
  unreachable: () =>
    `Cloudflare did not answer when the site read the ${RATE_LIMIT_PHASE} phase, so it is not known whether the API rate limit is on. Try again in a minute.`,
});

/** Every state the answer can carry, in the order the runbook explains them. */
export const RATE_LIMIT_STATES = Object.freeze(Object.keys(SENTENCES));

/** Cloudflare's answers to a read that mean the token was refused, not that Cloudflare was down. */
const REFUSED = Object.freeze([401, 403]);

/** The answer for one state, with its counts (null when the phase was not read) and its sentence. */
function answer(state, enabled = null, total = null) {
  return { state, enabled, total, message: SENTENCES[state]({ enabled, total }) };
}

/**
 * The answer for the phase's entry point ruleset (null when the phase has
 * none yet). A rule counts as on only when Cloudflare says `enabled: true`.
 * Cloudflare's documentation states no default for a rule without the
 * field, so such a rule counts as not on: a missing field can turn the
 * line amber, which a person then checks, but never green while the rule
 * might be off.
 */
export function rateLimitFromRuleset(ruleset) {
  const list = Array.isArray(ruleset?.rules) ? ruleset.rules.filter(Boolean) : [];
  const enabled = list.filter((rule) => rule.enabled === true).length;
  if (list.length === 0) return answer('empty', 0, 0);
  return answer(enabled > 0 ? 'on' : 'off', enabled, list.length);
}

/** The answer when the phase could not be read: refused for a 401 or 403 from Cloudflare, unreachable otherwise. */
export function rateLimitUnread(upstreamStatus) {
  return answer(REFUSED.includes(upstreamStatus) ? 'refused' : 'unreachable');
}
