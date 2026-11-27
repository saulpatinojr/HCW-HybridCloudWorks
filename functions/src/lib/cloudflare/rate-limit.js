/**
 * cloudflare/rate-limit.js — is the API rate limit rule on? (#1909, #1918)
 *
 * The rule that stops one address flooding the API lives only in Cloudflare
 * (the `http_ratelimit` rule phase), not in Terraform (#1903), so nothing else
 * would notice if it were deleted or switched off. Two places ask, and both
 * get their answer from this file, so there is one rule and no copy:
 *
 *   - the Cloudflare page's phase route (rules-routes.js getPhase), which
 *     adds this verdict as `rateLimit` to its answer for this phase; the
 *     Health page's `cloudflare-rate-limit` probe and the Cloudflare page's
 *     Overview show it as it is
 *     (frontend/src/components/admin/cloudflare/rateLimitCheck.js);
 *   - the daily `checkCloudflareRateLimit` timer
 *     (lib/timers/cloudflare-rate-limit.js).
 *
 *   on      at least one rule is switched on and limits     healthy
 *   off     no rule set, or every rule off or only logging  degraded (amber)
 *
 * It imports nothing, so it can be read by any test without the app's setup.
 */

export const RATE_LIMIT_PHASE = 'http_ratelimit';

/** The Health probe's id (health/probe-catalogue.js), which the timer records under. */
export const RATE_LIMIT_PROBE_ID = 'cloudflare-rate-limit';

export const NO_RULE_ON = 'No API rate limit rule is on.';

/** The start of the sentence for a read that failed, in the browser and on the server. */
export const READ_FAILED = 'The rate limiting rules could not be read:';

const rulesWord = (n) => `${n} API rate limit rule${n === 1 ? '' : 's'}`;
const isVerb = (n) => (n === 1 ? 'is' : 'are');

/**
 * A rule that limits. On means what the agent guard means (rules-guards.js):
 * no `enabled` flag (Cloudflare's default) or `true`; any other value (false,
 * null, 0, the text 'false') counts as off, so an odd answer fails safe. A
 * rule whose action is `log` (paid plans only) records requests without
 * limiting any, so it does not count either.
 */
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isSwitchedOn = (rule) => rule.enabled === undefined || rule.enabled === true;
const isNotLogOnly = (rule) => String(rule.action ?? '').toLowerCase() !== 'log';

export const isLimitingRule = (rule) => isPlainObject(rule) && [isSwitchedOn, isNotLogOnly].every((check) => check(rule));

function onSentence(on, total) {
  if (on === total) return `${rulesWord(on)} ${isVerb(on)} on.`;
  return `${on} of ${rulesWord(total)} ${isVerb(on)} on.`;
}

function offSentence(total) {
  const why =
    total === 0
      ? `The rate limiting phase (${RATE_LIMIT_PHASE}) has no rules`
      : `The rate limiting phase (${RATE_LIMIT_PHASE}) holds ${total === 1 ? 'one rule' : `${total} rules`}, switched off or only logging`;
  return `${NO_RULE_ON} ${why}, so one address can send the API as many requests as it likes.`;
}

/** The verdict on a phase read that answered: `{ ruleset }`, the ruleset or null when the phase has none. */
export function rateLimitVerdict(answer) {
  const rules = Array.isArray(answer?.ruleset?.rules) ? answer.ruleset.rules : [];
  const on = rules.filter(isLimitingRule).length;
  if (on > 0) {
    return { state: 'on', status: 'healthy', count: on, sentence: onSentence(on, rules.length) };
  }
  return { state: 'off', status: 'degraded', count: 0, sentence: offSentence(rules.length) };
}

/** Not set up yet (no token or zone id): not checked, which is not a failure. */
export const notCheckedVerdict = (message) => ({
  state: 'not-configured',
  status: 'unknown',
  count: 0,
  sentence: `Not checked. ${message}`,
});

/**
 * The verdict on a read that failed. `status` is the caller's classification
 * of the failure (offline when Cloudflare could not be reached, critical
 * otherwise), the same words the browser's probe uses.
 */
export const failedVerdict = (message, status) => ({
  state: 'failed',
  status,
  count: 0,
  sentence: `${READ_FAILED} ${message}`,
});
