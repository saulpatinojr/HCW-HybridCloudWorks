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
import {
  ACCEPTED_STATUS,
  callCycleYear,
  isCycleOver,
  isStripDue,
  latestFinishedCycle,
  stripProposal,
} from '../developer-api/proposal-cycle.js';
import { CFS_CONTAINER } from '../developer-api/cfs.js';
import { errorFacts } from '../http/error-response.js';
import { writeSystemAudit } from './workflow-records.js';

/** The app setting that arms the job. Anything but the exact text `true` is a dry run. */
export const STRIP_SETTING = 'PROPOSAL_STRIP_ENABLED';
/** The most proposals one run strips (or, in a dry run, counts). */
export const MAX_STRIPS_PER_RUN = 500;
/** Calls read per page, and the most pages one run reads. */
export const CALL_PAGE_SIZE = 200;
export const MAX_CALL_PAGES = 25;
/** How many times one proposal is read and written before it is left for the next run. */
const WRITE_ATTEMPTS = 2;

export const AUDIT_ACTION = 'cron_stripped_unaccepted_proposals';
const SOURCE = 'stripUnacceptedProposals';

const CALLS_QUERY =
  "SELECT c.eventId, c.docType, c.status, c.closedAt, c.closesAt FROM c WHERE c.docType = 'cfs-call'";

/** The proposals of one event that are not accepted and not yet stripped; with `sentBefore`, only those sent before it. */
export function dueProposalsQuery({ limit, sentBefore = null }) {
  const clauses = [
    "c.docType = 'cfs-submission'",
    'c.eventId = @eventId',
    `(NOT IS_DEFINED(c.status) OR c.status != '${ACCEPTED_STATUS}')`,
    '(NOT IS_DEFINED(c.strippedAt) OR IS_NULL(c.strippedAt))',
  ];
  if (sentBefore) clauses.push('c.submittedAt < @sentBefore');
  return `SELECT TOP ${limit} c.id, c.eventId, c.docType, c.status, c.submittedAt, c.strippedAt FROM c WHERE ${clauses.join(' AND ')}`;
}

/** The due proposals of one call, at most `limit`, judged again in memory on what came back. */
async function findDue({ store, nowMs }, call, limit) {
  // A call that closed decides the year for all its proposals: none are due
  // until that year is over. One that never closed decides nothing, so only
  // proposals sent in a finished year can be due.
  const callYear = callCycleYear(call, nowMs);
  if (callYear !== null && !isCycleOver(callYear, nowMs)) return [];
  const sentBefore = callYear === null ? new Date(Date.UTC(latestFinishedCycle(nowMs) + 1, 0, 1)).toISOString() : null;
  const parameters = [{ name: '@eventId', value: call.eventId }];
  if (sentBefore) parameters.push({ name: '@sentBefore', value: sentBefore });
  const rows = await store.queryDocs(CFS_CONTAINER, dueProposalsQuery({ limit, sentBefore }), parameters, {
    partitionKey: call.eventId,
  });
  return (rows || []).filter((row) => isStripDue(row, call, nowMs)).slice(0, limit);
}

/**
 * Strip one proposal, from a fresh read, under its ETag.
 * @returns {Promise<'stripped' | 'skipped' | 'raced'>} `skipped`: it is gone, or no longer due (accepted meanwhile, or already stripped)
 */
async function stripOne({ store, nowMs, nowIso }, call, row) {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const fresh = await store.readDoc(CFS_CONTAINER, row.id, call.eventId);
    if (!fresh || fresh.eventId !== call.eventId || !isStripDue(fresh, call, nowMs)) return 'skipped';
    try {
      await store.replaceDocIfMatch(CFS_CONTAINER, stripProposal(fresh, nowIso), { partitionKey: call.eventId });
      return 'stripped';
    } catch (error) {
      if (error?.code === 404) return 'skipped';
      if (error?.code !== 412) throw error;
    }
  }
  return 'raced';
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
  async function run() {
    const armed = env[STRIP_SETTING] === 'true';
    const at = now();
    const ctx = { store, nowMs: at.getTime(), nowIso: at.toISOString() };
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

    let continuationToken;
    for (let page = 0; page < MAX_CALL_PAGES; page += 1) {
      const calls = await store.queryDocsPage(CFS_CONTAINER, CALLS_QUERY, [], {
        maxItemCount: CALL_PAGE_SIZE,
        continuationToken,
      });
      for (const call of calls?.resources || []) {
        if (call?.docType !== 'cfs-call' || typeof call.eventId !== 'string' || !call.eventId) continue;
        summary.callsExamined += 1;
        const room = MAX_STRIPS_PER_RUN - summary.eligibleCount;
        if (room <= 0) {
          summary.hasMore = true;
          break;
        }
        const due = await findDue(ctx, call, room);
        summary.eligibleCount += due.length;
        if (due.length === room) summary.hasMore = true;
        if (!armed) continue;
        for (const row of due) {
          try {
            const outcome = await stripOne(ctx, call, row);
            summary[`${outcome}Count`] += 1;
          } catch (error) {
            summary.failedCount += 1;
            log.warn?.(`[${SOURCE}] one proposal could not be stripped: ${errorFacts(error)}`);
          }
        }
      }
      continuationToken = calls?.continuationToken || undefined;
      if (!continuationToken || summary.eligibleCount >= MAX_STRIPS_PER_RUN) {
        if (continuationToken) summary.hasMore = true;
        break;
      }
      if (page === MAX_CALL_PAGES - 1) summary.hasMore = true;
    }
    // A lost race or a failed write leaves a proposal for the next run.
    if (summary.racedCount || summary.failedCount) summary.hasMore = true;

    // Counts only: the row says what a run did, never whose proposals they were.
    await writeSystemAudit(store, { action: AUDIT_ACTION, source: SOURCE, details: { ...summary } }, { now, ...(uuid && { uuid }) });
    log.log?.(
      armed
        ? `[${SOURCE}] stripped=${summary.strippedCount} of eligible=${summary.eligibleCount} skipped=${summary.skippedCount} raced=${summary.racedCount} failed=${summary.failedCount} calls=${summary.callsExamined} cycle=${summary.cycleYear} more=${summary.hasMore}`
        : `[${SOURCE}] dry-run: would strip ${summary.eligibleCount} proposal(s) calls=${summary.callsExamined} cycle=${summary.cycleYear} more=${summary.hasMore}`,
    );
    return summary;
  }

  return { run };
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
