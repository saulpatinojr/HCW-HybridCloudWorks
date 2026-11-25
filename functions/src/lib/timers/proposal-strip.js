/**
 * proposal-strip.js — the yearly clean-up of talk proposals that were not
 * accepted (#1777, owner decision 2026-11-24). It runs once a day as the
 * second step of the `cleanupRejectedContent` timer (04:00 UTC,
 * schedulers.js), so it needed no new timer, no new alert row and no new
 * timer flag.
 *
 * WHAT IT DOES. A talk proposal is what a speaker sends to an organizer's
 * call for speakers through the Developer API (ADR 0042). Once a proposal's
 * yearly cycle is over (the calendar year its call closed in, plus January
 * as a month of grace; ../developer-api/proposal-cycle.js has the rules) and
 * the proposal was not accepted, the speaker's name, email and bio and the
 * organizer's review note are removed from it for good. The talk's title,
 * abstract, format, level, status and dates stay. An accepted proposal is
 * never touched.
 *
 * IT SHIPS SWITCHED OFF. Stripping cannot be undone, so the job is a DRY RUN
 * (it counts what it would strip and changes nothing) until the app setting
 * `PROPOSAL_STRIP_ENABLED` is exactly `true`. That is the T-302 rule the
 * other clean-up timers follow: running the job and letting it remove
 * something are two decisions.
 *
 * HOW ONE RUN WORKS.
 *   1. Read the calls, a page at a time. A call that closed tells the cycle
 *      year of all its proposals; one that never closed leaves each proposal
 *      to the year it was sent in.
 *   2. For each call with something due, ask its own partition (one event's
 *      records, stored together) for proposals that are not accepted and not
 *      already stripped. The query returns only due rows, so a run always
 *      makes progress and nothing waits behind rows that are not due yet.
 *   3. Armed only: read each proposal again, decide again on that fresh
 *      copy, and replace it under its ETag (the version stamp the database
 *      gives each record). A proposal that changed in between (a review
 *      landing) answers 412; it is read and judged once more, and a second
 *      lost race leaves it for tomorrow.
 *
 * BOUNDS. One run strips at most MAX_STRIPS_PER_RUN proposals and reads at
 * most MAX_CALL_PAGES pages of calls; `hasMore` in the summary says a later
 * run has work left. Stripping is idempotent: a stripped proposal carries
 * `strippedAt` and is never selected again.
 *
 * WHAT IS RECORDED. One summary line and one audit row per run, in both
 * modes, with counts only. No proposal id, event id, name or address reaches
 * a log line or the audit row.
 *
 * NOT COVERED. A proposal whose call record is missing is never visited
 * (the API has no way to delete a call, so this takes a hand edit).
 */
import { latestFinishedCycle } from '../developer-api/proposal-cycle.js';
import { CFS_CONTAINER } from '../developer-api/cfs.js';
import { errorFacts } from '../http/error-response.js';
import { writeSystemAudit } from './workflow-records.js';
import { findDue, stripOne } from './proposal-strip-due.js';

// Finding and stripping the due proposals lives in proposal-strip-due.js;
// the query is exported again here so callers keep importing it from this file.
export { dueProposalsQuery } from './proposal-strip-due.js';

/** The app setting that arms the job. Anything but the exact text `true` is a dry run. */
export const STRIP_SETTING = 'PROPOSAL_STRIP_ENABLED';
/** The most proposals one run strips (or, in a dry run, counts). */
export const MAX_STRIPS_PER_RUN = 500;
/** Calls read per page, and the most pages one run reads. */
export const CALL_PAGE_SIZE = 200;
export const MAX_CALL_PAGES = 25;

export const AUDIT_ACTION = 'cron_stripped_unaccepted_proposals';
const SOURCE = 'stripUnacceptedProposals';

const CALLS_QUERY =
  "SELECT c.eventId, c.docType, c.status, c.closedAt, c.closesAt FROM c WHERE c.docType = 'cfs-call'";

/** A call record this run can visit: a call, with an event id to find its proposals by. */
const isVisitableCall = (call) => call?.docType === 'cfs-call' && typeof call.eventId === 'string' && Boolean(call.eventId);

/** Armed only: strip each due proposal of one call, counting each outcome. */
async function stripAll(ctx, summary, call, due) {
  for (const row of due) {
    try {
      const outcome = await stripOne(ctx, call, row);
      summary[`${outcome}Count`] += 1;
    } catch (error) {
      summary.failedCount += 1;
      ctx.log.warn?.(`[${SOURCE}] one proposal could not be stripped: ${errorFacts(error)}`);
    }
  }
}

/** The calls of one page, each asked for its due proposals until the run's room is used up. */
async function visitCalls(ctx, summary, calls) {
  for (const call of calls) {
    if (!isVisitableCall(call)) continue;
    summary.callsExamined += 1;
    const room = MAX_STRIPS_PER_RUN - summary.eligibleCount;
    if (room <= 0) {
      summary.hasMore = true;
      return;
    }
    const due = await findDue(ctx, call, room);
    summary.eligibleCount += due.length;
    if (due.length === room) summary.hasMore = true;
    if (ctx.armed) await stripAll(ctx, summary, call, due);
  }
}

/** Read the calls a page at a time, at most MAX_CALL_PAGES pages, noting when work is left. */
async function visitCallPages(ctx, summary) {
  let continuationToken;
  for (let page = 0; page < MAX_CALL_PAGES; page += 1) {
    const calls = await ctx.store.queryDocsPage(CFS_CONTAINER, CALLS_QUERY, [], {
      maxItemCount: CALL_PAGE_SIZE,
      continuationToken,
    });
    await visitCalls(ctx, summary, calls?.resources || []);
    continuationToken = calls?.continuationToken || undefined;
    if (!continuationToken || summary.eligibleCount >= MAX_STRIPS_PER_RUN) {
      if (continuationToken) summary.hasMore = true;
      return;
    }
    if (page === MAX_CALL_PAGES - 1) summary.hasMore = true;
  }
}

/** The run's one summary line: counts only. */
function summaryLine(armed, summary) {
  return armed
    ? `[${SOURCE}] stripped=${summary.strippedCount} of eligible=${summary.eligibleCount} skipped=${summary.skippedCount} raced=${summary.racedCount} failed=${summary.failedCount} calls=${summary.callsExamined} cycle=${summary.cycleYear} more=${summary.hasMore}`
    : `[${SOURCE}] dry-run: would strip ${summary.eligibleCount} proposal(s) calls=${summary.callsExamined} cycle=${summary.cycleYear} more=${summary.hasMore}`;
}

async function run({ store, now, uuid, log, env }) {
  const armed = env[STRIP_SETTING] === 'true';
  const at = now();
  const ctx = { store, nowMs: at.getTime(), nowIso: at.toISOString(), armed, log };
  const summary = {
    dryRun: !armed,
    cycleYear: latestFinishedCycle(ctx.nowMs),
    callsExamined: 0,
    eligibleCount: 0,
    strippedCount: 0,
    skippedCount: 0,
    racedCount: 0,
    failedCount: 0,
    hasMore: false,
  };

  await visitCallPages(ctx, summary);
  // A lost race or a failed write leaves a proposal for the next run.
  if (summary.racedCount || summary.failedCount) summary.hasMore = true;

  // Counts only: the row says what a run did, never whose proposals they were.
  await writeSystemAudit(store, { action: AUDIT_ACTION, source: SOURCE, details: { ...summary } }, { now, ...(uuid && { uuid }) });
  log.log?.(summaryLine(armed, summary));
  return summary;
}

/**
 * @param {object} deps
 * @param {{ queryDocs: Function, queryDocsPage: Function, readDoc: Function, replaceDocIfMatch: Function, upsertDoc: Function }} deps.store
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 * @param {object} [deps.log]
 * @param {Record<string, string | undefined>} [deps.env]
 */
export function createProposalStrip({ store, now = () => new Date(), uuid, log = {}, env = process.env }) {
  return { run: () => run({ store, now, uuid, log, env }) };
}

/**
 * The two steps of the daily `cleanupRejectedContent` timer, run one after
 * the other. Both always run: if the first throws, the second still does,
 * and the first error is thrown afterwards so the run is recorded as failed.
 *
 * @param {{ rejected: () => Promise<object>, proposals: () => Promise<object> }} steps
 * @returns {Promise<object>} the first step's summary, with the second's under `proposals`
 */
export async function runDailyRetirement({ rejected, proposals }) {
  let summary;
  let failure = null;
  try {
    summary = await rejected();
  } catch (error) {
    failure = error;
  }
  // The second step runs whatever the first did; its own failure is thrown as it is.
  const proposalSummary = await proposals().catch((error) => {
    if (failure) return null;
    throw error;
  });
  if (failure) throw failure;
  return { ...summary, proposals: proposalSummary };
}
