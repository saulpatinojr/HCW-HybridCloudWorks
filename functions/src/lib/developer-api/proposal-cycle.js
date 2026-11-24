/**
 * developer-api/proposal-cycle.js — the yearly cycle a talk proposal belongs
 * to, and what is left of a proposal that was not accepted once that cycle is
 * over (#1777, owner decision 2026-11-24). Pure; the daily job that uses it
 * is ../timers/proposal-strip.js.
 *
 * THE CYCLE IS THE CALENDAR YEAR, 1 January to 31 December. After a year
 * ends there is one month of grace, January, "to complete applications", so
 * a year's clean-up is due on 1 February of the next year.
 *
 * WHICH YEAR A PROPOSAL BELONGS TO. The year of the day its call (the
 * organizer's request for talks) closed: the day the organizer closed it
 * (`closedAt`), or else the call's deadline (`closesAt`) once that has
 * passed. A call that never closed has no such day, so each of its proposals
 * goes by the year it was sent in (`submittedAt`).
 *
 * EVERY DATE HERE IS READ IN UTC, like every other time in the app (#416).
 * A call closed at 23:59 UTC on 31 December belongs to that year, and one
 * closed a minute later belongs to the next.
 *
 * WHAT STRIPPING DOES. A proposal that was not accepted (any status other
 * than `accepted`, a proposal nobody reviewed included) loses the four
 * fields that say who sent it and what was said about them: the speaker's
 * name, email and bio, and the organizer's review note. The talk's title,
 * abstract, format, level, status and dates stay. An accepted proposal is
 * never stripped by this rule.
 */

/** How many months after 31 December a finished year is still left alone. One: January. */
export const CYCLE_GRACE_MONTHS = 1;

/** The status the rule spares. Every other status, and a missing one, counts as not accepted. */
export const ACCEPTED_STATUS = 'accepted';

/** The fields removed from a proposal that was not accepted. Removed for good, not blanked. */
export const STRIPPED_FIELDS = Object.freeze(['speakerName', 'speakerEmail', 'speakerBio', 'reviewNote']);

/** Written to `strippedReason`, so a reader of the record can tell why the fields are gone. */
export const STRIP_REASON = 'cycle_ended';

const instantMs = (value) => {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

const yearOf = (ms) => new Date(ms).getUTCFullYear();

/**
 * When this call stopped taking proposals, in milliseconds, or null while it
 * has not: the day the organizer closed it, else its deadline once passed.
 */
export function callClosedMs(call, nowMs) {
  const closedAt = instantMs(call?.closedAt);
  if (closedAt !== null && closedAt <= nowMs) return closedAt;
  const closesAt = instantMs(call?.closesAt);
  if (closesAt !== null && closesAt <= nowMs) return closesAt;
  return null;
}

/** The cycle year of a call that has closed, or null for one that has not. */
export function callCycleYear(call, nowMs) {
  const closed = callClosedMs(call, nowMs);
  return closed === null ? null : yearOf(closed);
}

/**
 * The cycle year of one proposal: its call's, or the year it was sent in when
 * the call never closed. Null when neither date can be read, and a proposal
 * with no readable date is never stripped.
 */
export function proposalCycleYear(proposal, call, nowMs) {
  const fromCall = callCycleYear(call, nowMs);
  if (fromCall !== null) return fromCall;
  const submitted = instantMs(proposal?.submittedAt);
  return submitted === null ? null : yearOf(submitted);
}

/** The first moment a year's clean-up is due: 1 February of the next year, 00:00 UTC. */
export const cycleCleanupDueMs = (year) => Date.UTC(year + 1, CYCLE_GRACE_MONTHS, 1);

/** Is this year over, grace month included? */
export const isCycleOver = (year, nowMs) => Number.isInteger(year) && nowMs >= cycleCleanupDueMs(year);

/**
 * The newest year whose clean-up is due at this moment. From 1 February 2027
 * that is 2026; through January 2027 it is still 2025.
 */
export function latestFinishedCycle(nowMs) {
  const year = yearOf(nowMs);
  return isCycleOver(year - 1, nowMs) ? year - 1 : year - 2;
}

export const isAccepted = (proposal) => proposal?.status === ACCEPTED_STATUS;
export const isStripped = (proposal) => Boolean(proposal?.strippedAt);

/** Should this proposal be stripped now? The one decision the job trusts, made on the record it is about to write. */
export function isStripDue(proposal, call, nowMs) {
  if (!proposal || proposal.docType !== 'cfs-submission') return false;
  if (isAccepted(proposal) || isStripped(proposal)) return false;
  return isCycleOver(proposalCycleYear(proposal, call, nowMs), nowMs);
}

/**
 * The proposal as it is stored after stripping: the four fields are absent
 * (not null, not empty), and `strippedAt` marks it so it is never processed
 * again. Everything else, `_etag` included, is carried over unchanged.
 */
export function stripProposal(proposal, nowIso) {
  const kept = Object.fromEntries(Object.entries(proposal).filter(([field]) => !STRIPPED_FIELDS.includes(field)));
  return { ...kept, strippedAt: nowIso, strippedReason: STRIP_REASON };
}
