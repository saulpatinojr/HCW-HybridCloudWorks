/**
 * sync-inspect.js — step 4 of a Search Console run (sync.js): reserving page
 * inspections against the daily budget, and inspecting the pages a few at a
 * time. `ctx` is the run's shared state (sync-run.js createRunContext).
 */
import { SearchConsoleError, sleepUnlessAborted } from './client.js';
import { budgetSpentMessage, nextPacificMidnight } from './lease.js';
import { CONCURRENCY } from './sync-constants.js';
import { presentInspection } from './sync-present.js';
import { failureNote, isFatal, isNotSent, isQuota } from './sync-notes.js';

/** Whether the run cannot go on: a failure every later call would hit, or the cancel switch fired. */
export const stopped = (ctx) => ctx.fatal !== null || ctx.cancel.aborted;

const utcMinute = (date) => `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

// ── Running a set of tasks a few at a time ───────────────────────────────────

/**
 * Run `task(item)` over `items`, at most `limit` at once, with at least
 * `spacingMs` between starts. Stops starting new tasks once `stop()` is true.
 */
async function runPaced(items, { limit, spacingMs, sleep, now, stop, task }) {
  let next = 0;
  let nextStartAt = 0;
  async function lane() {
    while (next < items.length && !stop()) {
      const index = next;
      next += 1;
      const wait = nextStartAt - now();
      nextStartAt = Math.max(now(), nextStartAt) + spacingMs;
      if (wait > 0) await sleep(wait);
      if (stop()) return;
      await task(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

/** The note when the daily budget gave fewer inspections than pages. */
function noteAllowance(ctx, budget, allowed, wanted) {
  if (allowed === 0) {
    ctx.notes.push(`${budgetSpentMessage(ctx.startedAt, budget)} No page was inspected; each keeps its last result.`);
  } else if (allowed < wanted) {
    ctx.notes.push(
      `Only ${allowed} of ${wanted} pages fit in what is left of today's allowance of ${budget.toLocaleString('en-US')} Google page inspections; the rest keep their last result until it starts again at midnight Pacific time (${utcMinute(nextPacificMidnight(ctx.startedAt))}).`
    );
  }
}

/** 4. The daily budget: reserve one inspection per page before sending any. */
export async function reserveBudget(ctx, lease, counts, budget, wanted) {
  const allowed = stopped(ctx) ? 0 : await lease.reserve(wanted);
  counts.reserved = allowed;
  // A refusal that stops the run (the run's message says which), or the
  // time limit: nothing is inspected, and nothing more is noted here.
  if (!stopped(ctx)) noteAllowance(ctx, budget, allowed, wanted);
  return allowed;
}

/** One inspection taken from the reserve, or one more asked of the budget. */
async function takeOne(ctx, lease, counts) {
  if (counts.sent < counts.reserved) {
    counts.sent += 1;
    return true;
  }
  if (stopped(ctx)) return false;
  const more = await lease.reserve(1).catch(() => 0);
  if (more > 0) {
    counts.reserved += more;
    counts.sent += 1;
    return true;
  }
  ctx.budgetOut = true;
  return false;
}

/**
 * Every request sent to URL Inspection, client.js's retries included,
 * uses one inspection this run reserved (counts.sent against
 * counts.reserved). Once they are all used, one more is asked of the
 * budget before a request goes out, and the request is not sent when the
 * day has none left. The asks are made one at a time, so this run's own
 * four lanes do not race each other for the lease document.
 */
function createInspectionTaker(ctx, lease, counts) {
  let unitQueue = Promise.resolve(true);
  return () => {
    unitQueue = unitQueue.then(() => takeOne(ctx, lease, counts));
    return unitQueue;
  };
}

/** A page's inspection that failed: recorded on that page, and on the run when it stops it. */
function recordInspectFailure(ctx, result, { url, source }, failure) {
  // Held back before its first request: the page was not inspected
  // at all, and keeps its last result like the pages after it.
  if (isNotSent(failure)) {
    result.sent -= 1;
    return;
  }
  // Cut off because the run was stopped: not Google's failure, so it
  // is not recorded as one; the page keeps its last result.
  if (ctx.cancel.aborted) return;
  // A 403 on a page found in search can mean only that this one
  // address is not part of the property (Google answers "the
  // inspected URL is not part of this property"), so it fails that
  // page and not the run. On a sitemap page it still stops the run.
  const strayOutsideProperty = source === 'search' && failure instanceof SearchConsoleError && failure.status === 403;
  if (isFatal(failure) && !strayOutsideProperty) ctx.fatal ??= failure;
  if (isQuota(failure)) ctx.quotaHit = true;
  result.failures.set(
    url,
    strayOutsideProperty
      ? 'Google would not inspect this address (HTTP 403): it may not be part of the Search Console property.'
      : failureNote(failure, 'The inspection failed.')
  );
}

/**
 * Inspect each page in the allowance. Returns the fresh answers by address,
 * the failures' sentences by address, and how many were sent.
 */
export async function inspectPages(ctx, lease, counts, toInspect) {
  const result = { fresh: new Map(), failures: new Map(), sent: 0 };
  const beforeSend = createInspectionTaker(ctx, lease, counts);
  const inspectedAt = ctx.startedAt.toISOString();
  const { deps, cancel } = ctx;
  await runPaced(toInspect, {
    limit: CONCURRENCY,
    spacingMs: deps.spacingMs,
    sleep: (ms) => sleepUnlessAborted(deps.sleep, ms, cancel),
    now: () => deps.now().getTime(),
    stop: () => stopped(ctx) || ctx.quotaHit || ctx.budgetOut,
    task: async (target) => {
      try {
        result.sent += 1;
        result.fresh.set(target.url, presentInspection(target.url, await ctx.google.inspect(target.url, { beforeSend, signal: cancel }), inspectedAt));
      } catch (failure) {
        recordInspectFailure(ctx, result, target, failure);
      }
    },
  });
  return result;
}

/** Why the run stopped inspecting before the end of its allowance, when it did. */
export function noteInspectionStop(ctx, budget, sent, planned) {
  if (ctx.quotaHit) {
    ctx.notes.push(
      `Google still answered 429 (quota used up) after retries, so the run stopped inspecting after ${sent} of ${planned} pages; the rest keep their last result.`
    );
  } else if (ctx.budgetOut) {
    ctx.notes.push(
      `Retries used up what was left of today's allowance of ${budget.toLocaleString('en-US')} Google page inspections, so the run stopped inspecting after ${sent} of ${planned} pages; the rest keep their last result.`
    );
  }
}
