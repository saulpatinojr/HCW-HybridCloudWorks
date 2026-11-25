#!/usr/bin/env node
/**
 * Which workflows in this repository have stopped being able to succeed?
 *
 * WHY THIS EXISTS. `validate-deployed.yml` was dispatched twice on 2026-08-18,
 * failed both times, and then sat in `.github/workflows/` for three weeks. Its
 * own header explained why it could not pass from a GitHub-hosted runner
 * (Cloudflare answers a datacenter IP with a 403, so its single assertion
 * `test "$code" = "200"` can never hold), so the knowledge was not missing —
 * nothing was reading it. Nothing in the repository looked at run history and
 * said "this one has never worked". This does.
 *
 * IT MEASURES, IT DOES NOT ASSERT. There is no list of workflows in this file
 * to keep in step with the directory, and no per-workflow expectation to
 * update. The verdict comes from run history — what actually happened — read
 * per workflow from `/actions/workflows/{id}/runs`, and deliberately NOT from
 * `/actions/runs?workflow_id=…`, which accepts the filter and ignores it. That
 * trap is recorded in full at the call site, and naming the wrong endpoint here
 * would undercut it. Measuring rather than asserting is what means a workflow
 * added tomorrow is covered tomorrow; a hand-maintained list would have needed
 * someone to notice the thing this file exists to notice.
 *
 * ONLY WORKFLOWS WHOSE FILE IS ON THE DEFAULT BRANCH ARE ASSESSED (#1564).
 * GitHub's workflow listing is a list of everything that has run history, not
 * of what is in the directory: a workflow file pushed on a branch and run once
 * stays listed (`state: active`) after the branch is gone, and so does a file
 * deleted from `main`. Until 2026-11-05 this file claimed a deleted workflow
 * stopped being checked the day it was deleted, and every run since
 * 2026-10-25 disproved it by naming `zz-probe-guide-drift.yml` as broken: that
 * file lived only on `probe/guide-drift-1356`, for one deliberate-failure run
 * that is cited as evidence on #1356, and was never on `main`. Deleting the
 * run would erase that evidence, and disabling the workflow changes nothing
 * in the listing. So `main()` reads the default branch's `.github/workflows`
 * tree once, assesses only the listed workflows whose `path` is in it, and
 * names the rest on a separate line that never fails the run, so a reader
 * knows why they are left out. A workflow deleted from the default branch
 * therefore stops being assessed with the deletion, and its run history is
 * named, not judged, until GitHub stops listing it. `state` is read into the
 * record as before and does not decide anything, for the reason above.
 *
 * THE FOUR VERDICTS ARE KEPT APART, because collapsing them is the mistake
 * this repository keeps paying for (T-514; `05-verify-timer.ps1` 2026-08-30;
 * the exit-code split in `tfc-plan-check.yml`):
 *
 *   healthy    a success in the sampled window.
 *   unproven   this tool is making no claim, reached three ways: nothing
 *              finished to read (never ran, or still running); everything
 *              that finished stopped short of a verdict (cancelled, neutral,
 *              action_required, skipped, stale); or a real failure that is
 *              still inside the staleness window, which is somebody mid-debug
 *              rather than an abandonment. NOT a pass and NOT a fail in any
 *              of the three. A workflow dispatched once and cancelled says
 *              nothing about whether it works; one that failed an hour ago
 *              says nothing about whether anybody is coming back. Widened
 *              from "the instrument had nothing to measure" in review, which
 *              described the first two ways in and not the third.
 *   broken     nothing in the sample succeeded, at least one run failed, AND
 *              the newest run of any kind is older than the staleness
 *              threshold. All three are required. A workflow that failed twice
 *              in the last hour is somebody mid-debug and is not this tool's
 *              business; a workflow that has never succeeded and last ran
 *              three weeks ago is.
 *   failing    the last `FAILING_SCHEDULED_RUNS` (two) runs started by the
 *              workflow's own schedule both failed, whatever happened before
 *              them and however recent they are (#1661). Runs that stopped
 *              short of a verdict (cancelled, skipped and the rest) are
 *              stepped over, not counted either way, and a run started by hand
 *              or by a push never counts as one of the failures. But a success
 *              on the default branch newer than the newest failure, however it
 *              was started, clears the finding: that is how a fix is usually
 *              proven, a week before the next scheduled run would prove it.
 *              A workflow that is `broken` is
 *              reported as `broken` and not also as `failing`: `broken` is
 *              the stronger claim (it has never worked in the sample), and
 *              one line per workflow is easier to act on than two that say
 *              overlapping things.
 *
 * WHY `failing` EXISTS, AND WHY IT DOES NOT WAIT FOR STALENESS (#1661).
 * `update-avm-versions.yml` (a weekly job) succeeded on 2026-10-27 and then
 * failed its scheduled runs on 2026-11-03 and 2026-11-10 (#1658). Nobody
 * noticed for two weeks, and this file could not have told them: there was a
 * success in the sample, so it read `healthy`, and even without that success
 * a weekly job's newest run is never more than seven days old, so it could
 * never pass the ten-day staleness test that `broken` needs. A scheduled
 * workflow is the one kind that is certain to run again without anybody
 * touching it, so its own schedule is the clock: two red runs in a row, each
 * at its own pace, is the "nobody is coming back to this" signal that age is
 * for a workflow started by hand. Two and not one, because one red week can
 * be a publisher's outage or a flaky runner and clears itself; two in a row
 * is a pattern nobody is fixing.
 *
 * WHERE THE SCHEDULED RUNS COME FROM. A second request per workflow,
 * `/actions/workflows/{id}/runs?event=schedule`, filtered by GitHub to runs the
 * schedule started. The mixed sample above is not enough on its own: ten runs
 * of a weekly workflow that is also started by pushes or pull requests can
 * hold no scheduled run at all. The filter is checked on every row the same
 * way the workflow filter is (`runsRefusal`), so a response that ignored it
 * stops the check instead of being judged.
 *
 * THE WORKFLOW RUNNING THIS CHECK IS NOT JUDGED AS `failing`. This script runs
 * inside `monitor-deploy-drift.yml`, and a `failing` finding turns that run
 * red. Two red runs of it would then make it `failing` itself, which turns the
 * next run red after the first finding is fixed, and so on for ever. Its own
 * red runs are this check's findings (or the drift job's, which alerts on its
 * own), so it is named on a note line instead. Read from `GITHUB_WORKFLOW_REF`,
 * which GitHub sets on every run; outside Actions it is absent and every
 * workflow is judged. Two more are set aside the same way, because no
 * scheduled run can ever come to clear them: a workflow GitHub lists as
 * disabled (`state` not `active`), and one whose file on the default branch
 * no longer has a `schedule:` trigger (read only for a workflow that would be
 * `failing`, so it costs nothing on a clean run).
 *
 * AN ERROR NOBODY FORESAW EXITS 2, NOT 1 (`runGuarded`). An uncaught throw
 * exits 1, which the monitor reads as a finding.
 *
 * WHY `broken` IS "NOTHING SUCCEEDED" AND NOT "EVERY RUN FAILED". Those differ
 * only for a mixed sample — say one failure and one cancellation, both a month
 * old — and there the second reading is the wrong one twice over. It is false
 * on its face: that workflow failed, was never made to work, and has been
 * left. And the bucket it would fall into says so out loud, because the
 * `unproven` line reads "N run(s), none of which reached a verdict" about a
 * run that reached a verdict of failure. It would also make a single stray
 * cancellation enough to hide the case this file was written for:
 * `validate-deployed.yml`'s real history is two failures, and a third run
 * cancelled by whoever gave up on it would have moved it out of the finding
 * and into a collapsed block. A detector that misses is worse than one that
 * over-reports, because nobody audits the quiet answer. What keeps the
 * over-reporting honest is that the verdict states its own arithmetic — "N of
 * M sampled run(s) failed, none succeeded" — so a mixed sample reports itself
 * as mixed and a reader can disagree with it from the line alone. Raised in
 * review on PR #426.
 *
 * WHY STALENESS IS PART OF THE FAILURE CONDITION rather than a separate
 * finding. The subject is "nobody is coming back to this", and freshness is
 * the only available evidence for it. Failing on a fresh red would page on
 * every ordinary broken-then-fixed afternoon, and a detector that fires on
 * ordinary work stops being read — which is the failure mode that let the
 * three weeks happen in the first place.
 *
 * WHAT IT CANNOT SEE. A workflow that succeeds while asserting nothing. A
 * workflow whose jobs are individually red inside a green run. Neither is
 * visible from run conclusions, and pretending otherwise would make this the
 * kind of green check that means nothing.
 *
 * Run it:
 *
 *   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/check-workflow-health.mjs
 *
 * Exit 0 when nothing is broken or failing, 1 when something is, 2 when the
 * run history could not be read at all — "I could not look" and "I looked and
 * it is fine" are opposite conclusions and a single exit code would merge them.
 */
import { pathToFileURL } from 'node:url';
import { assessAll, assessWorkflow, hasFinding, MAX_PER_PAGE, selfWorkflowPath } from './lib/workflow-health-assess.mjs';
import { renderReport } from './lib/workflow-health-report.mjs';
import { listingRefusal, partitionByPresence, readDefaultBranchTree, readFailingDetails, readOrStop, readTuning, readWorkflowRuns, stop } from './lib/workflow-health-github.mjs';
// The parts below now live in their own files; they are exported from here too, so callers keep their imports.
export { DEFAULT_STALE_DAYS, MAX_PER_PAGE, DEFAULT_SAMPLE, FAILING_CONCLUSIONS, PASSING_CONCLUSIONS, FAILING_SCHEDULED_RUNS, FINDING_VERDICTS, hasFinding, consecutiveScheduledFailures, selfWorkflowPath, assessWorkflow, hasScheduleTrigger, assessAll } from './lib/workflow-health-assess.mjs';
export { renderReport, findingsKey } from './lib/workflow-health-report.mjs';
export { positiveIntOr, listingRefusal, runsRefusal, treeRefusal, partitionByPresence, readTuning } from './lib/workflow-health-github.mjs';

export async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const { staleDays, sample } = readTuning(process.env);

  if (!token || !repo) {
    stop('Usage: node check-workflow-health.mjs', 'GITHUB_TOKEN and GITHUB_REPOSITORY are both required.');
  }

  const listing = await readOrStop(
    `/repos/${repo}/actions/workflows?per_page=${MAX_PER_PAGE}`,
    token,
    (err) => `Could not read the workflow listing: ${err.message}`,
    'Nothing was asserted either way.'
  );

  const refusal = listingRefusal(listing);
  if (refusal) stop(refusal);

  // `dynamic/...` entries are GitHub's own (Dependabot, Copilot) and have no
  // file in this repository to fix or delete, so they are not this tool's
  // business.
  const files = listing.workflows.filter((w) => w.path.startsWith('.github/workflows/'));

  const { defaultBranch, tree } = await readDefaultBranchTree(repo, token);
  const { present, absent } = partitionByPresence(files, tree);

  const workflows = [];
  for (const w of present) workflows.push(await readWorkflowRuns(w, { repo, token, sample }));

  const selfPath = selfWorkflowPath(process.env);
  const options = { now: new Date(), staleDays, selfPath, defaultBranch };
  let results = assessAll(workflows, options);

  // For each workflow that would be `failing`, the two reads of
  // readFailingDetails, only for those (usually none), so they cost requests
  // only when there is a finding; then it is judged again.
  for (const [i, r] of results.entries()) {
    if (r.verdict !== 'failing') continue;
    await readFailingDetails(workflows[i], r.path, { repo, token, defaultBranch });
    results[i] = assessWorkflow(workflows[i], options);
  }

  const report = renderReport(results, { staleDays, absent, defaultBranch });
  console.log(report);
  // exitCode, not exit(): on Linux a write to a pipe is asynchronous, and
  // exit() would drop whatever of a long report had not reached the pipe yet,
  // findings marker included, so the issue step would see no findings line
  // (Copilot review of #1668; https://nodejs.org/api/process.html#a-note-on-process-io).
  process.exitCode = hasFinding(results) ? 1 : 0;
}

/**
 * Runs `main`, and turns an error nobody caught into exit 2 (#1661).
 *
 * An uncaught throw from an awaited top-level call exits **1**, and 1 here
 * means "a workflow is broken or failing": the monitor would open the
 * workflow-health issue with a stack trace in it. The refusals above exist to
 * stop exactly that; this is the backstop for the throw nobody foresaw.
 * `exit` is a parameter so a test can see the code without ending its process.
 */
export async function runGuarded(fn, exit = process.exit) {
  try {
    await fn();
  } catch (err) {
    console.error(`The check stopped on an error it did not expect: ${err?.stack ?? err}`);
    console.error('Nothing was asserted either way.');
    exit(2);
  }
}

// pathToFileURL, not a `file://` template: on Windows argv[1] is `C:\...` and
// the template form never matches, so the script would exit 0 having run
// nothing. That exact bug shipped in smoke-deployed.mjs; scripts/entrypoint-
// guards.test.mjs spawns this file to prove the guard still fires.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runGuarded(main);
}
/* c8 ignore stop */
