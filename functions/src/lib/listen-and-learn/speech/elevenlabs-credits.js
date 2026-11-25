/**
 * elevenlabs-credits.js — the credit arithmetic of an ElevenLabs render: what
 * a job will be charged, whether the account can pay for it, the sentence
 * that says it cannot, and whether the plan is the free one. elevenlabs-account.js reads the account and
 * exports all of this again.
 */

/** Eleven v3's rate, and the ceiling for every other model (see the header). */
export const CREDITS_PER_CHARACTER = 1;

const numberFormat = new Intl.NumberFormat('en-US');


/** Credits a job of `characters` code points will be charged, rounded up. */
export function creditsNeeded(characters) {
  return Math.ceil(Math.max(0, Number(characters) || 0) * CREDITS_PER_CHARACTER);
}

/**
 * Null when the account can pay for `needed` credits, else what it is short.
 *
 * Usage-based billing counts as headroom, but only when the account is
 * entitled to it AND an admin has set an extension above 0. That is an opt-in
 * made in ElevenLabs's own settings. The free plan has neither, so on it this
 * compares the allowance left with the job.
 *
 * @param {ReturnType<typeof normalizeSubscription>} subscription
 * @param {number} needed credits
 */
export function creditShortfall(subscription, needed) {
  const overage =
    subscription.overageCredits === 'unlimited'
      ? Number.POSITIVE_INFINITY
      : Number(subscription.overageCredits) || 0;
  const available = subscription.creditLimit - subscription.creditsUsed + overage;
  if (needed <= available) return null;
  return {
    needed,
    left: subscription.creditsLeft,
    limit: subscription.creditLimit,
    overage,
    resetAt: subscription.resetAt,
    tier: subscription.tier,
  };
}

/**
 * "ElevenLabs has 1,000 credits left of 10,000, this episode needs 9,000; the
 * allowance resets on 2026-10-26 (UTC). Nothing was sent, …"
 */
export function describeShortfall({ needed, left, limit, overage, resetAt }) {
  const extra = overage > 0 ? ` (plus ${numberFormat.format(overage)} of usage-based billing)` : '';
  const reset = resetAt
    ? `the allowance resets on ${resetAt.slice(0, 10)} (UTC)`
    : 'ElevenLabs did not say when the allowance resets';
  return (
    `ElevenLabs has ${numberFormat.format(left)} credits left of ${numberFormat.format(limit)}${extra}, ` +
    `this episode needs ${numberFormat.format(needed)}; ${reset}. ` +
    `Nothing was sent, so no credits were spent.`
  );
}

const FREE_TIER = 'free';
const FREE_STATUSES = new Set(['free', 'free_disabled']);

/** Whether a plan is the free one, from what the subscription says. */
export function isFreePlan({ tier, status } = {}) {
  return (
    String(tier || '').toLowerCase() === FREE_TIER ||
    FREE_STATUSES.has(String(status || '').toLowerCase())
  );
}
