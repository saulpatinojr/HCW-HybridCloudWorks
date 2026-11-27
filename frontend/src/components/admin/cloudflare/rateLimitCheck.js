/**
 * Is the API rate limit rule on? (#1909, #1918)
 *
 * The rule that stops one address flooding the API lives only in Cloudflare
 * (the `http_ratelimit` rule phase), not in Terraform, so nothing else would
 * notice if it were deleted or switched off. The Health page's
 * `cloudflare-rate-limit` probe and the Cloudflare page's Overview both ask
 * this module, so the two always give the same answer.
 *
 * The browser does not judge the rules. The server does, with the one rule
 * the daily checkCloudflareRateLimit timer also uses
 * (functions/src/lib/cloudflare/rate-limit.js), and the phase route adds its
 * verdict to the answer as `rateLimit`. This module shows that verdict, after
 * checking that its words are ones the page knows. An answer without it comes
 * from a back end older than this page (the functions are deployed by hand,
 * after the site), so the probe says so and stays grey: it never works the
 * answer out itself, or there would be two rules again.
 *
 *   on              at least one rule is switched on          healthy
 *   off             no rule set, or every rule switched off   degraded (amber)
 *   not-updated     the server's answer has no verdict yet    unknown (not checked)
 *   not-configured  the token or zone id is not set yet       unknown (not checked)
 *   not-allowed     a viewer: reading the rules needs editor  unknown (not checked)
 *   failed          the read itself failed                    critical or offline
 */
import { NOT_CONFIGURED, readCloudflarePhase } from '@/lib/cloudflare';
import { classifyFailure } from '@/lib/status';

export const RATE_LIMIT_PHASE = 'http_ratelimit';

/** Part 4 of the runbook: the rule's values and how to make it. */
export const RATE_LIMIT_RUNBOOK_URL =
  'https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/docs/runbooks/cloudflare-admin.md#part-4-making-the-api-rate-limit-rule';

export const NOT_UPDATED = 'Not checked: the server has not been updated yet.';

/** The states the server may answer, each with the one status it goes with. */
const KNOWN = Object.freeze({ on: 'healthy', off: 'degraded' });

const MAX_SENTENCE = 500;

/** Not checked, grey: the answer has no verdict this page can show. */
const notUpdated = () => ({
  state: 'not-updated',
  status: 'unknown',
  count: 0,
  sentence: NOT_UPDATED,
});

/** A verdict the page can show as it is: a known state with its status, a count and a sentence. */
const SHOWABLE_CHECKS = [
  (verdict) => Object.hasOwn(KNOWN, verdict.state) && KNOWN[verdict.state] === verdict.status,
  (verdict) => Number.isSafeInteger(verdict.count) && verdict.count >= 0,
  (verdict) => typeof verdict.sentence === 'string' && verdict.sentence.trim() !== '',
];
const isShowable = (verdict) =>
  Boolean(verdict) &&
  typeof verdict === 'object' &&
  SHOWABLE_CHECKS.every((check) => check(verdict));

/** The verdict on a phase read that answered: the server's `rateLimit`, field by field, or "not updated". */
export function rateLimitVerdict(answer) {
  const verdict = answer?.rateLimit;
  if (!isShowable(verdict)) return notUpdated();
  return {
    state: verdict.state,
    status: verdict.status,
    count: verdict.count,
    sentence: verdict.sentence.slice(0, MAX_SENTENCE),
  };
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
