/**
 * Is the API rate limit rule on? (#1909)
 *
 * The rule that stops one address flooding the API lives only in Cloudflare
 * (the `http_ratelimit` rule phase), not in Terraform, so nothing else would
 * notice if it were deleted or switched off. The Health page's
 * `cloudflare-rate-limit` probe and the Cloudflare page's Overview both ask
 * this module, so the two always give the same answer.
 *
 * The rule itself (what counts as on, and the sentences) is the server's
 * functions/src/lib/cloudflare/rate-limit.js, which the daily
 * checkCloudflareRateLimit timer (#1918) uses; this file keeps a copy because
 * the browser bundle does not import server code, and rateLimitMirror.test.js
 * fails when the two give different answers.
 *
 * It reads the phase through the Cloudflare page's own route (editor role,
 * changes nothing) and turns the answer into one of four states, each with a
 * status from lib/status.js and a sentence:
 *
 *   on              at least one rule is switched on          healthy
 *   off             no rule set, or every rule switched off   degraded (amber)
 *   not-configured  the token or zone id is not set yet       unknown (not checked)
 *   failed          the read itself failed                    critical or offline
 */
import { NOT_CONFIGURED, readCloudflarePhase } from '@/lib/cloudflare';
import { classifyFailure } from '@/lib/status';

export const RATE_LIMIT_PHASE = 'http_ratelimit';

/** Part 4 of the runbook: the rule's values and how to make it. */
export const RATE_LIMIT_RUNBOOK_URL =
  'https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/docs/runbooks/cloudflare-admin.md#part-4-making-the-api-rate-limit-rule';

export const NO_RULE_ON = 'No API rate limit rule is on.';

const rulesWord = (n) => `${n} API rate limit rule${n === 1 ? '' : 's'}`;
const isVerb = (n) => (n === 1 ? 'is' : 'are');

/**
 * A rule that limits. On means what the server's agent guard means
 * (rules-guards.js): no `enabled` flag (Cloudflare's default) or `true`; any
 * other value (false, null, 0, the text 'false') counts as off, so an odd
 * answer fails safe. A rule whose action is `log` (paid plans only) records
 * requests without limiting any, so it does not count either.
 */
const isOn = (rule) =>
  Boolean(rule) &&
  typeof rule === 'object' &&
  (rule.enabled === undefined || rule.enabled === true) &&
  String(rule.action ?? '').toLowerCase() !== 'log';

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

/** The verdict on a phase read that answered: `{ ruleset }` from GET …/phases/http_ratelimit. */
export function rateLimitVerdict(answer) {
  const rules = Array.isArray(answer?.ruleset?.rules) ? answer.ruleset.rules : [];
  const on = rules.filter(isOn).length;
  if (on > 0) {
    return { state: 'on', status: 'healthy', count: on, sentence: onSentence(on, rules.length) };
  }
  return { state: 'off', status: 'degraded', count: 0, sentence: offSentence(rules.length) };
}

/** The verdict on a phase read that failed: not set up yet, or a real failure. */
export function rateLimitFailure(error) {
  const message = String(error?.message || error || 'Cloudflare did not answer.');
  // A viewer may open the Health page, but reading the rules needs the editor
  // role: that refusal (403) is not a Cloudflare failure, so it is not red. A
  // 401 is a missing or expired sign-in, which is a real failure and goes
  // through the usual classification below.
  if (error?.status === 403) {
    return {
      state: 'not-allowed',
      status: 'unknown',
      count: 0,
      sentence: 'Not checked: reading the rate limiting rules needs the editor role.',
    };
  }
  if (error?.code === NOT_CONFIGURED) {
    return {
      state: 'not-configured',
      status: 'unknown',
      count: 0,
      sentence: `Not checked. ${message}`,
    };
  }
  return {
    state: 'failed',
    status: classifyFailure(error),
    count: 0,
    sentence: `The rate limiting rules could not be read: ${message}`,
  };
}

/** Reads the phase and answers its verdict. Never throws: a failed read is a verdict too. */
export async function checkRateLimit() {
  try {
    return rateLimitVerdict(await readCloudflarePhase(RATE_LIMIT_PHASE));
  } catch (error) {
    return rateLimitFailure(error);
  }
}
