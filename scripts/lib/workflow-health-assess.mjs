/** Judging each scheduled workflow from its recent runs: failing, stale, or fine (check-workflow-health.mjs). */

/** Runs older than this, with no success among them, are the finding. */
export const DEFAULT_STALE_DAYS = 10;

/** The GitHub REST API's ceiling for `per_page`; it clamps silently above this. */
export const MAX_PER_PAGE = 100;

/** How many recent runs to read per workflow. */
export const DEFAULT_SAMPLE = 10;

/**
 * Conclusions that count as evidence the workflow ran and did not work.
 *
 * `cancelled` is deliberately absent: a human stopping a run says nothing
 * about whether it could have succeeded, and counting it would have flagged
 * `deploy-azure-frontend.yml` — a workflow used successfully the same day —
 * on the strength of two cancellations.
 */
export const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);

/** Only this counts as the workflow having worked. */
export const PASSING_CONCLUSIONS = new Set(['success']);

/**
 * How many scheduled runs in a row must fail before a workflow is `failing`.
 *
 * Two, because one red week can be somebody else's outage (a publisher, a
 * registry, a runner) and the next run clears it on its own; two in a row at
 * the workflow's own pace is a pattern nobody is fixing (#1661, #1658).
 */
export const FAILING_SCHEDULED_RUNS = 2;

/** The verdicts that are findings: either one makes the script exit 1. */
export const FINDING_VERDICTS = new Set(['broken', 'failing']);

/** Whether any result is a finding, which is what decides exit 1. */
export function hasFinding(results) {
  return results.some((r) => FINDING_VERDICTS.has(r.verdict));
}

/**
 * The newest `FAILING_SCHEDULED_RUNS` scheduled runs that reached a verdict,
 * when every one of them failed; otherwise null.
 *
 * A run "reached a verdict" when its conclusion is a pass or a failure.
 * Cancelled, skipped, neutral, stale and action_required runs are stepped
 * over: they say nothing either way, the same reasoning as `cancelled` being
 * absent from `FAILING_CONCLUSIONS`. Only runs whose `event` is `schedule`
 * are read, so a failed run started by hand never counts.
 *
 * @param {Array<{event?: string, conclusion: string|null, created_at: string}>} scheduledRuns
 */
export function consecutiveScheduledFailures(scheduledRuns) {
  const decided = scheduledRuns
    .filter((r) => r?.event === 'schedule')
    .filter((r) => PASSING_CONCLUSIONS.has(r.conclusion) || FAILING_CONCLUSIONS.has(r.conclusion))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  const newest = decided.slice(0, FAILING_SCHEDULED_RUNS);
  if (newest.length < FAILING_SCHEDULED_RUNS) return null;
  return newest.every((r) => FAILING_CONCLUSIONS.has(r.conclusion)) ? newest : null;
}

/**
 * The repository path of the workflow this process is running in, from
 * `GITHUB_WORKFLOW_REF` (`owner/repo/.github/workflows/x.yml@refs/heads/main`,
 * https://docs.github.com/en/actions/reference/workflows-and-actions/variables),
 * or null outside GitHub Actions or when it cannot be read.
 */
export function selfWorkflowPath(env = {}) {
  const ref = env.GITHUB_WORKFLOW_REF;
  const repo = env.GITHUB_REPOSITORY;
  if (typeof ref !== 'string' || typeof repo !== 'string' || repo === '') return null;
  if (!ref.startsWith(`${repo}/`)) return null;
  const at = ref.lastIndexOf('@');
  const path = ref.slice(repo.length + 1, at === -1 ? undefined : at);
  return path === '' ? null : path;
}

/**
 * Verdict for one workflow, from its run history alone.
 *
 * `scheduledRuns` is the second listing, filtered to `event=schedule` (see the
 * header). When it is absent, the scheduled runs inside `runs` are used, so a
 * caller with only the mixed sample still gets a `failing` verdict when that
 * sample shows one.
 *
 * A NEWER SUCCESS ON THE DEFAULT BRANCH CLEARS IT, whatever started it. A run
 * started by hand never counts as one of the failures, but once the fault is
 * fixed the usual proof is a run started by hand on the default branch, and a
 * weekly workflow's next scheduled run can be a week away. Without this, a
 * fixed workflow would keep the monitor red, and the owner's Telegram alert
 * firing, for that week (seen on 2026-11-10: `update-avm-versions.yml` was
 * fixed by #1662 and dispatched green at 16:48 UTC, run 42858386218). A
 * success on another branch, a pull request's for example, says nothing about
 * what is on the default branch and does not clear it.
 *
 * `hasSchedule` is set by `main` for a workflow that would be `failing`:
 * false when its file on the default branch no longer has a `schedule:`
 * trigger. Such a workflow, or one GitHub lists as not `active` (disabled),
 * will never have a scheduled run to clear the finding, so it is set aside on
 * a note line rather than named for ever.
 *
 * @param {{path: string, state?: string, hasSchedule?: boolean, runs: Array<{event?: string, head_branch?: string, conclusion: string|null, created_at: string, html_url?: string}>, scheduledRuns?: Array, defaultBranchSuccesses?: Array}} workflow
 * @param {{now: Date, staleDays: number, selfPath?: string|null, defaultBranch?: string}} options
 */
export function assessWorkflow(workflow, { now, staleDays, selfPath = null, defaultBranch = 'main' }) {
  const base = assessSample(workflow, { now, staleDays });
  // `broken` first: it is the stronger claim, and a workflow gets one line.
  if (base.verdict === 'broken') return base;

  const failing = scheduledFailing(workflow, defaultBranch);
  if (!failing) return base;
  const { why, newestFailure } = failing;

  // Set aside, on a note line, when no later run can ever clear it.
  const reason = setAsideReason(workflow, { selfPath, defaultBranch });
  if (reason) return { ...base, setAside: { why, reason } };
  return { path: workflow.path, verdict: 'failing', why, newestFailedRun: newestFailure.html_url };
}

/**
 * The scheduled runs that failed in a row, newest first, with the sentence
 * that says so; null when they did not, or when a success on the default
 * branch has come since the newest of them.
 */
function scheduledFailing(workflow, defaultBranch) {
  const runs = Array.isArray(workflow.runs) ? workflow.runs : [];
  const scheduled = Array.isArray(workflow.scheduledRuns) ? workflow.scheduledRuns : runs;
  const failed = consecutiveScheduledFailures(scheduled);
  if (!failed) return null;

  const newestFailure = failed[0];
  // `defaultBranchSuccesses` is set by `main` for a workflow that would be
  // `failing`: its newest success on the default branch, read on its own
  // because the mixed sample may no longer hold it.
  const extra = Array.isArray(workflow.defaultBranchSuccesses) ? workflow.defaultBranchSuccesses : [];
  const successes = [...runs, ...scheduled, ...extra].filter((r) => PASSING_CONCLUSIONS.has(r?.conclusion));
  const clearedSince = successes.some((r) => r.head_branch === defaultBranch && r.created_at > newestFailure.created_at);
  if (clearedSince) return null;

  const lastSuccess = successes.length
    ? successes.reduce((a, b) => (a.created_at > b.created_at ? a : b)).created_at.slice(0, 10)
    : null;
  const why =
    `last ${failed.length} scheduled runs failed (${failed.map((r) => r.created_at.slice(0, 10)).join(', ')}); ` +
    (lastSuccess ? `last success ${lastSuccess}` : 'no success in the runs read') +
    `; newest failed run ${newestFailure.html_url ?? '(the API gave no link)'}`;
  return { why, newestFailure };
}

/**
 * Why a workflow that would be `failing` is set aside instead, or null when it
 * is not: no later run can ever clear it.
 */
function setAsideReason(workflow, { selfPath, defaultBranch }) {
  if (selfPath && workflow.path === selfPath) {
    // See the header: judging the workflow that runs this check would keep it
    // red after every other finding is fixed.
    return "it is the workflow running this check; its own red runs are this check's findings, or the drift job's, which alerts on its own";
  }
  if (workflow.state !== undefined && workflow.state !== 'active') {
    return `GitHub lists it as \`${workflow.state}\`, so no scheduled run will come to clear it`;
  }
  if (workflow.hasSchedule === false) {
    return `its file on \`${defaultBranch}\` has no \`schedule:\` trigger any more, so no scheduled run will come to clear it`;
  }
  return null;
}

/**
 * Whether a workflow file's text has a `schedule:` trigger. A text check, as
 * the rest of this repository reads workflows (scripts/lib/workflow-text.mjs):
 * comment lines are dropped, then a `schedule:` key at any indent, or
 * `schedule` inside a one-line `on:` list, counts. Over-matching is the safe
 * direction here: it keeps a workflow judged rather than setting it aside.
 */
export function hasScheduleTrigger(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line));
  return lines.some((line) => /^\s*schedule\s*:/.test(line) || /^on\s*:.*\bschedule\b/.test(line));
}

/** The newest of a list of runs by `created_at`. */
const newestOf = (runs) => runs.reduce((a, b) => (a.created_at > b.created_at ? a : b));

/**
 * `healthy`, `unproven` or `broken`, from the mixed sample alone. The verdicts
 * this file had before `failing`, unchanged (#1661 kept them as they were).
 */
function assessSample(workflow, { now, staleDays }) {
  const runs = Array.isArray(workflow.runs) ? workflow.runs : [];
  const finished = runs.filter((r) => r.conclusion !== null && r.conclusion !== undefined);

  if (finished.length === 0) {
    return { path: workflow.path, verdict: 'unproven', why: 'no finished run to read' };
  }

  const passes = finished.filter((r) => PASSING_CONCLUSIONS.has(r.conclusion));
  if (passes.length > 0) {
    const newest = newestOf(passes);
    return {
      path: workflow.path,
      verdict: 'healthy',
      why: `succeeded ${newest.created_at.slice(0, 10)}`,
      lastSuccess: newest.created_at,
    };
  }

  const failures = finished.filter((r) => FAILING_CONCLUSIONS.has(r.conclusion));
  if (failures.length === 0) {
    // Everything sampled was cancelled, neutral, skipped, stale or
    // action_required. Nothing was measured, so nothing is claimed — but HOW
    // LONG nothing has been measured for is itself worth reporting, which is
    // why the age rides along. A workflow nobody has concluded either way in
    // months is the thing this audit was run to find, and it would otherwise
    // sit in the collapsed section forever. Raised in review on PR #426.
    const newest = newestOf(finished);
    const age = (now.getTime() - Date.parse(newest.created_at)) / 86_400_000;
    return {
      path: workflow.path,
      verdict: 'unproven',
      why: `${finished.length} run(s), none of which reached a verdict`,
      ageDays: Number.isFinite(age) ? age : undefined,
    };
  }
  return failedSampleVerdict(workflow, { finished, failures, now, staleDays });
}

/** The verdict on a sample where something failed and nothing succeeded: `broken`, or `unproven` while recent. */
function failedSampleVerdict(workflow, { finished, failures, now, staleDays }) {
  // AGE COMES FROM THE NEWEST FINISHED RUN, NOT THE NEWEST FAILURE, and the
  // difference is the difference between "abandoned" and "someone is on it".
  // A workflow that failed 30 days ago and had a run cancelled yesterday has
  // been touched yesterday; dating it from the failure would call that
  // abandoned and say "nobody has been back" about a workflow somebody was
  // back at. The verdict's own words have to be true. Raised in review on
  // PR #426.
  const newestRun = newestOf(finished);
  const ageDays = (now.getTime() - Date.parse(newestRun.created_at)) / 86_400_000;

  if (!Number.isFinite(ageDays)) {
    return {
      path: workflow.path,
      verdict: 'unproven',
      why: `unreadable timestamp ${newestRun.created_at}`,
    };
  }

  if (ageDays < staleDays) {
    return {
      path: workflow.path,
      verdict: 'unproven',
      why: `failing, and the newest run of any kind is ${ageDays.toFixed(1)}d old — inside the ${staleDays}d window, so this is work in progress`,
      ageDays,
    };
  }

  return {
    path: workflow.path,
    verdict: 'broken',
    why: `${failures.length} of ${finished.length} sampled run(s) failed, none succeeded, and the newest attempt of any kind was ${ageDays.toFixed(0)}d ago (${newestRun.created_at.slice(0, 10)})`,
    ageDays,
  };
}

/** @param {Array} workflows @param {{now: Date, staleDays: number}} options */
export function assessAll(workflows, options) {
  return workflows.map((w) => assessWorkflow(w, options));
}
