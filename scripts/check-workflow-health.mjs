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
 *              or by a push never counts. A workflow that is `broken` is
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
 * workflow is judged.
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
 * @param {{path: string, state?: string, runs: Array<{event?: string, conclusion: string|null, created_at: string, html_url?: string}>, scheduledRuns?: Array}} workflow
 * @param {{now: Date, staleDays: number, selfPath?: string|null}} options
 */
export function assessWorkflow(workflow, { now, staleDays, selfPath = null }) {
  const base = assessSample(workflow, { now, staleDays });
  // `broken` first: it is the stronger claim, and a workflow gets one line.
  if (base.verdict === 'broken') return base;

  const runs = Array.isArray(workflow.runs) ? workflow.runs : [];
  const scheduled = Array.isArray(workflow.scheduledRuns) ? workflow.scheduledRuns : runs;
  const failed = consecutiveScheduledFailures(scheduled);
  if (!failed) return base;

  const newestFailure = failed[0];
  const successes = [...runs, ...scheduled].filter((r) => PASSING_CONCLUSIONS.has(r?.conclusion));
  const lastSuccess = successes.length
    ? successes.reduce((a, b) => (a.created_at > b.created_at ? a : b)).created_at.slice(0, 10)
    : null;
  const why =
    `last ${failed.length} scheduled runs failed (${failed.map((r) => r.created_at.slice(0, 10)).join(', ')}); ` +
    (lastSuccess ? `last success ${lastSuccess}` : 'no success in the runs read') +
    `; newest failed run ${newestFailure.html_url ?? '(the API gave no link)'}`;

  if (selfPath && workflow.path === selfPath) {
    // See the header: judging the workflow that runs this check would keep it
    // red after every other finding is fixed.
    return { ...base, selfFailing: why };
  }
  return { path: workflow.path, verdict: 'failing', why, newestFailedRun: newestFailure.html_url };
}

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
    const newest = passes.reduce((a, b) => (a.created_at > b.created_at ? a : b));
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
    const newest = finished.reduce((a, b) => (a.created_at > b.created_at ? a : b));
    const age = (now.getTime() - Date.parse(newest.created_at)) / 86_400_000;
    return {
      path: workflow.path,
      verdict: 'unproven',
      why: `${finished.length} run(s), none of which reached a verdict`,
      ageDays: Number.isFinite(age) ? age : undefined,
    };
  }

  // AGE COMES FROM THE NEWEST FINISHED RUN, NOT THE NEWEST FAILURE, and the
  // difference is the difference between "abandoned" and "someone is on it".
  // A workflow that failed 30 days ago and had a run cancelled yesterday has
  // been touched yesterday; dating it from the failure would call that
  // abandoned and say "nobody has been back" about a workflow somebody was
  // back at. The verdict's own words have to be true. Raised in review on
  // PR #426.
  const newestRun = finished.reduce((a, b) => (a.created_at > b.created_at ? a : b));
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

/**
 * Markdown for the job summary. Kept pure so the tests can read it.
 *
 * `absent` is the listed workflows whose file is not on the default branch
 * (#1564). They are not in `results`, so nothing below can call one broken;
 * they get one line of their own, after the verdicts, so a reader who
 * remembers the row knows why it is gone rather than wondering whether the
 * check stopped looking.
 *
 * @param {Array} results the verdicts, from `assessAll`
 * @param {{staleDays: number, absent?: Array<{path: string}>, defaultBranch?: string}} options
 */
export function renderReport(results, { staleDays, absent = [], defaultBranch = 'main' }) {
  const broken = results.filter((r) => r.verdict === 'broken');
  const failing = results.filter((r) => r.verdict === 'failing');
  const unproven = results.filter((r) => r.verdict === 'unproven');
  const lines = ['## Workflow health', ''];

  // The headline speaks only for the `broken` and `failing` sets, because
  // those are the only sets it counts. Claiming "every workflow succeeded
  // recently or is inside the window" contradicted the stalled section printed
  // below it the moment that section existed — a summary arguing with its own
  // body. Introduced by the stalled split and caught in review on PR #426. For
  // the same reason it is not printed above a `failing` section (#1661).
  if (broken.length === 0 && failing.length === 0) {
    lines.push('**No workflow is failing-and-abandoned.**');
  }
  if (broken.length > 0) {
    lines.push(
      `**${broken.length} workflow(s) have never succeeded in the sampled window and nobody has been back.**`,
      '',
      'A workflow that cannot succeed teaches everyone to ignore a red X. Fix it or delete it.',
      ''
    );
    for (const r of broken) lines.push(`- \`${r.path}\` — ${r.why}`);
  }
  if (failing.length > 0) {
    if (broken.length > 0) lines.push('');
    lines.push(
      `**${failing.length} scheduled workflow(s) failed their last ${FAILING_SCHEDULED_RUNS} scheduled runs in a row.**`,
      '',
      'A scheduled job that keeps failing at its own pace is one nobody is fixing. Open the newest failed run, fix the cause, and the next green scheduled run clears it.',
      ''
    );
    for (const r of failing) lines.push(`- \`${r.path}\` — ${r.why}`);
  }

  // The workflow running this check, when it would have been `failing`. Not
  // a finding (see the header), but not hidden either.
  for (const r of results.filter((x) => x.selfFailing)) {
    lines.push(
      '',
      `Not judged as failing because it is the workflow running this check: \`${r.path}\` — ${r.selfFailing}. Its own red runs are this check's findings, or the drift job's, which alerts on its own.`
    );
  }

  // An unproven verdict is not a failure and never exits non-zero — nothing was
  // measured, so nothing is claimed. But one that has been unproven for longer
  // than the staleness window is the case this audit existed to surface, and
  // burying it in a collapsed block is how it stays buried. Split, not
  // reclassified.
  const stalled = unproven.filter((r) => Number.isFinite(r.ageDays) && r.ageDays >= staleDays);
  const recent = unproven.filter((r) => !stalled.includes(r));

  if (stalled.length > 0) {
    lines.push(
      '',
      `**${stalled.length} workflow(s) have concluded nothing either way for over ${staleDays} days.**`,
      '',
      'Not a failure — but nothing here is evidence it still works. Confirm or delete.',
      ''
    );
    for (const r of stalled)
      lines.push(`- \`${r.path}\` — ${r.why}, newest ${r.ageDays.toFixed(1)}d ago`);
  }

  if (recent.length > 0) {
    lines.push('', '<details><summary>Not concluded either way</summary>', '');
    for (const r of recent) lines.push(`- \`${r.path}\` — ${r.why}`);
    lines.push('', '</details>');
  }

  if (absent.length > 0) {
    lines.push(
      '',
      `Not on \`${defaultBranch}\`, run history only, not assessed: ` +
        absent.map((w) => `\`${w.path}\``).join(', ') +
        '. GitHub lists a workflow while it has runs, even when its file was only ever on a branch or has since been deleted.'
    );
  }

  const key = findingsKey(results);
  if (key) lines.push('', key);

  return lines.join('\n');
}

/**
 * One hidden line that names the findings and nothing that changes between
 * checks, or '' when there are none.
 *
 * The monitor runs every four hours and keeps one issue open while a finding
 * stands. It compares this line with the issue's latest text and comments only
 * when it differs, so the issue gets a comment when something new is found or
 * a scheduled workflow fails again, and not six identical comments a day. A
 * `broken` workflow is keyed by its path alone, because its line carries an age
 * that grows every day; a `failing` one by its path and its newest failed run,
 * so a further failure is news. It is an HTML comment, so neither the job
 * summary nor the issue shows it.
 */
export function findingsKey(results) {
  const keys = results
    .filter((r) => FINDING_VERDICTS.has(r.verdict))
    .map((r) => (r.verdict === 'failing' ? `${r.path}@${r.newestFailedRun ?? 'no-link'}` : r.path))
    .sort();
  return keys.length ? `<!-- workflow-health findings: ${keys.join(' ')} -->` : '';
}

/* c8 ignore start — the network half, exercised by running it */
import { pathToFileURL } from 'node:url';

async function api(path, token) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      // Pinned, matching check-deploy-drift.mjs (the other job in the same
      // workflow file), github-app-token.mjs and open-manifest-pr.mjs. An
      // unpinned request follows GitHub's default, and this tool's verdicts
      // are read off two response fields; a silent shape change would be
      // indistinguishable from a repository where nothing runs. Raised in
      // review on PR #428.
      'X-GitHub-Api-Version': '2022-11-28',
      'user-agent': 'hcw-check-workflow-health',
    },
  });
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
  return res.json();
}

/**
 * A positive integer from an environment variable, or the default.
 *
 * `Number('soon')` is `NaN`, and NaN propagates instead of throwing: it would
 * have reached `per_page=NaN` in a request URL, and made every comparison
 * against a staleness window false — so a mistyped variable would have turned
 * this tool into one that reports on rows it did not fetch. Caught in review on
 * PR #426. A misconfiguration must not become a finding.
 *
 * Falls back rather than exiting because neither variable is required; both
 * exist to let an operator widen a window from a workflow file, and the default
 * is always a defensible answer.
 */
export function positiveIntOr(raw, fallback, max = Infinity) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.trunc(n) !== n || n < 1) {
    console.error(
      `Ignoring "${raw}" — expected a positive whole number. Using ${fallback} instead.`
    );
    return fallback;
  }
  if (n > max) {
    // GitHub does not reject an oversized `per_page`; it silently clamps to
    // 100 — verified against the live API, which returned 100 runs for
    // `per_page=500` with HTTP 200. So this is not an availability fix. It is
    // an honesty one: without it an operator who asked for 500 would be told
    // nothing and quietly get 100, and a tool whose whole claim is "I only
    // report what I measured" should not silently measure something else.
    // Raised in review on PR #426.
    console.error(`Clamping ${n} to ${max} — the API caps it there.`);
    return max;
  }
  return n;
}

/**
 * Why the workflow listing cannot be trusted, or null when it can.
 *
 * FAILS CLOSED ON A TRUNCATED LISTING. One page is `MAX_PER_PAGE` workflows
 * and GitHub paginates: past that, the rest would be dropped silently and
 * every one of them reported as nothing at all — a healthy answer to a
 * question that was never asked, which is the exact shape this file exists to
 * catch, one level up from the run-filter guard. Nineteen workflows today, so
 * it has never fired; it is here because the failure would be invisible when
 * it did.
 *
 * FAILS CLOSED ON AN ENTRY IT CANNOT READ, for the same reason one level down.
 * `main` filters on `w.path` and asks for runs by `w.id`; an entry missing
 * either used to reach `w.path.startsWith(...)` and throw a TypeError, and an
 * uncaught throw exits **1** — which in this tool means "a workflow is
 * broken". So an unreadable listing would have reported a broken workflow: the
 * exact collapse of `broken` into `unproven` that the three-way exit split
 * exists to prevent, arriving through the error path instead of the verdict.
 * Raised in review on PR #428.
 *
 * THE MESSAGE DOES NOT SAY "RAISE per_page". The request already asks for the
 * API's ceiling, so that would be an impossible instruction — and sending an
 * operator toward a fix that cannot work is worse than saying nothing, because
 * they try it and conclude the tool is broken rather than the situation.
 * Following pages is the only real remedy, and it is a change to the caller.
 * Both points raised in review on PR #426.
 *
 * Pure and exported so the wording is pinned by a test rather than by reading
 * it — the same reason the rest of this file's logic is.
 */
export function listingRefusal(listing) {
  if (!Array.isArray(listing?.workflows)) {
    return 'The workflow listing had no `workflows` array; nothing is asserted.';
  }
  if (Number.isFinite(listing.total_count) && listing.total_count > listing.workflows.length) {
    return `The workflow listing is paginated — ${listing.total_count} workflows, ${listing.workflows.length} read at the API's ${MAX_PER_PAGE} ceiling. Following pages is a change to the caller; nothing is asserted.`;
  }
  const bad = listing.workflows.findIndex(
    (w) => typeof w?.path !== 'string' || w.path === '' || typeof w?.id !== 'number'
  );
  if (bad !== -1) {
    return `Workflow listing entry ${bad} does not carry both a usable \`path\` and a numeric \`id\`; it cannot be filtered or asked for runs, so nothing is asserted.`;
  }
  return null;
}

/**
 * Why a run listing cannot be trusted, or null when it can. The same job as
 * `listingRefusal`, one level down.
 *
 * FAILS CLOSED ON A PAYLOAD WITH NO `workflow_runs` ARRAY. This read
 * `got.workflow_runs || []`, and both halves of that were wrong. A missing
 * array became "no runs", which is `unproven` — a silent mis-measurement,
 * reported as a workflow nobody has run rather than a response nobody could
 * read. And a truthy non-array reached `runs.filter(...)`, which throws, and an
 * uncaught throw exits **1**, which in this tool means "a workflow is broken".
 * One shape lied quietly and the other lied loudly. Raised in review on
 * PR #428, the second instance of it; the first was the listing above.
 *
 * FAILS CLOSED ON A ROW IT CANNOT IDENTIFY. The endpoint is trusted for the
 * filter; this proves the filter held. A silently unfiltered response is
 * otherwise indistinguishable from a healthy workflow, which is how the first
 * draft of this script passed with every workflow green.
 *
 * IT ASSERTS ON `workflow_id`. The first version read
 * `r.path && r.path !== w.path`, and that leading truthy check made it fail
 * OPEN: a run whose `path` was absent or empty was silently counted as
 * belonging here. A guard against a response that quietly carries the wrong
 * rows must not itself quietly accept a row it cannot identify. Caught in
 * review on PR #426. `workflow_id` rather than `path` because it is the exact
 * value the request filtered on — a numeric identity comparison, not a string
 * one — and because a workflow that is renamed keeps its id.
 *
 * Pure and exported for the reason the rest of this file is: a guard whose
 * only exercise is a live API call is a guard nobody can change safely.
 *
 * FAILS CLOSED ON A ROW FROM THE WRONG EVENT, when the listing was asked for
 * one (`event=schedule`, #1661). The same reasoning one filter over: a listing
 * that ignored the event filter would carry runs started by hand, and a failed
 * one of those would be judged as a failed scheduled run.
 *
 * @param {unknown} payload the parsed response body
 * @param {{path: string, id: number}} workflow the workflow it was asked for
 * @param {{event?: string}} [filter] the event the listing was asked for, if any
 */
export function runsRefusal(payload, workflow, { event } = {}) {
  if (!Array.isArray(payload?.workflow_runs)) {
    return `Run listing for ${workflow.path} carried no \`workflow_runs\` array; nothing is asserted.`;
  }
  const foreign = payload.workflow_runs.filter((r) => r?.workflow_id !== workflow.id);
  if (foreign.length > 0) {
    const seen = foreign[0]?.workflow_id ?? '(no workflow_id on the run)';
    return `Run listing for ${workflow.path} contained ${foreign.length} run(s) that are not workflow ${workflow.id} (first: ${seen}). The filter did not hold; nothing is asserted.`;
  }
  if (event !== undefined) {
    const other = payload.workflow_runs.filter((r) => r?.event !== event);
    if (other.length > 0) {
      const seen = other[0]?.event ?? '(no event on the run)';
      return `Run listing for ${workflow.path}, asked for event ${event}, contained ${other.length} run(s) from another event (first: ${seen}). The filter did not hold; nothing is asserted.`;
    }
  }
  return null;
}

/**
 * Why the default branch's `.github/workflows` tree cannot be trusted, or
 * null when it can. The same job as `listingRefusal`, for the second listing
 * `main` reads (#1564).
 *
 * FAILS CLOSED, for the reason the two refusals above do. The tree decides
 * which listed workflows are assessed at all; an unreadable tree treated as
 * empty would name every workflow "not on the default branch" and assess
 * nothing, a green answer to a question that was never asked. The contents
 * API answers an array of entries for a directory and a single object for a
 * file, so an object here means the path was not a directory.
 *
 * @param {unknown} contents the parsed response body
 * @param {string} branch the branch it was asked for, for the message
 */
export function treeRefusal(contents, branch) {
  if (!Array.isArray(contents)) {
    return `The \`.github/workflows\` listing on ${branch} was not an array of entries; nothing is asserted.`;
  }
  const bad = contents.findIndex((entry) => typeof entry?.path !== 'string' || entry.path === '');
  if (bad !== -1) {
    return `Entry ${bad} of the \`.github/workflows\` listing on ${branch} carries no usable \`path\`; nothing is asserted.`;
  }
  return null;
}

/**
 * The listed workflows split by whether their file is on the default branch
 * (#1564). `present` is assessed; `absent` is named and not judged.
 *
 * Matched on `path`, the repository-relative file path both listings carry
 * (`.github/workflows/ci.yml`), and not on name or id: the workflow listing
 * is keyed by run history, the tree by what is in the directory, and the
 * path is the only field they share.
 *
 * @param {Array<{path: string}>} workflows the listing, already past `listingRefusal`
 * @param {Array<{path: string}>} tree the directory listing, already past `treeRefusal`
 */
export function partitionByPresence(workflows, tree) {
  const onBranch = new Set(tree.map((entry) => entry.path));
  const present = [];
  const absent = [];
  for (const w of workflows) (onBranch.has(w.path) ? present : absent).push(w);
  return { present, absent };
}

/**
 * The two tunables, read from an environment.
 *
 * A FUNCTION AND NOT TWO LINES INSIDE main(), so the WIRING is testable and
 * not just the helper underneath it. The first version of the ceiling test
 * passed with the ceiling removed from the call site, because it exercised
 * `positiveIntOr(..., MAX_PER_PAGE)` directly and nothing asserted that
 * `main` actually passed the ceiling. A test that cannot see the wiring is a
 * test of the wrong thing.
 *
 * `sample` takes the API ceiling; `staleDays` deliberately does not — it is
 * not a request parameter and a long window is a legitimate thing to ask for.
 */
export function readTuning(env = {}) {
  return {
    staleDays: positiveIntOr(env.WORKFLOW_STALE_DAYS, DEFAULT_STALE_DAYS),
    sample: positiveIntOr(env.WORKFLOW_SAMPLE, DEFAULT_SAMPLE, MAX_PER_PAGE),
  };
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const { staleDays, sample } = readTuning(process.env);

  if (!token || !repo) {
    console.error('Usage: node check-workflow-health.mjs');
    console.error('GITHUB_TOKEN and GITHUB_REPOSITORY are both required.');
    process.exit(2);
  }

  let listing;
  try {
    listing = await api(`/repos/${repo}/actions/workflows?per_page=${MAX_PER_PAGE}`, token);
  } catch (err) {
    console.error(`Could not read the workflow listing: ${err.message}`);
    console.error('Nothing was asserted either way.');
    process.exit(2);
  }

  const refusal = listingRefusal(listing);
  if (refusal) {
    console.error(refusal);
    process.exit(2);
  }

  // `dynamic/...` entries are GitHub's own (Dependabot, Copilot) and have no
  // file in this repository to fix or delete, so they are not this tool's
  // business.
  const files = listing.workflows.filter((w) => w.path.startsWith('.github/workflows/'));

  // Which of those files are on the default branch today (#1564). One read of
  // the repository for the branch's name, one of the directory on it; the
  // header says why the workflow listing alone cannot answer this. Both fail
  // closed, like the listing above: an unreadable tree is not an empty one.
  let defaultBranch;
  let tree;
  try {
    const repository = await api(`/repos/${repo}`, token);
    defaultBranch = repository?.default_branch;
    if (typeof defaultBranch !== 'string' || defaultBranch === '') {
      throw new Error('the repository payload carried no `default_branch`');
    }
    tree = await api(
      `/repos/${repo}/contents/.github/workflows?ref=${encodeURIComponent(defaultBranch)}`,
      token
    );
  } catch (err) {
    console.error(`Could not read the workflow files on the default branch: ${err.message}`);
    console.error('Nothing was asserted either way.');
    process.exit(2);
  }
  const treeWrong = treeRefusal(tree, defaultBranch);
  if (treeWrong) {
    console.error(treeWrong);
    process.exit(2);
  }
  const { present, absent } = partitionByPresence(files, tree);

  const workflows = [];
  for (const w of present) {
    let got;
    try {
      // `/actions/workflows/{id}/runs`, NOT `/actions/runs?workflow_id={id}`.
      // The second form is accepted, returns HTTP 200, and IGNORES the filter:
      // it hands back the repository's newest runs across every workflow. The
      // first draft of this script used it, and every workflow inherited the
      // newest repo-wide run — so all nineteen came back "healthy", including
      // the one whose entire history is two failures. A green answer to a
      // question that was never asked, which is the exact shape this file
      // exists to catch. Verified 2026-09-08: the query-param form returned
      // `monitor-unresolved-secrets.yml` runs when asked for
      // `validate-deployed.yml`.
      got = await api(`/repos/${repo}/actions/workflows/${w.id}/runs?per_page=${sample}`, token);
    } catch (err) {
      console.error(`Could not read runs for ${w.path}: ${err.message}`);
      process.exit(2);
    }

    // Shape and filter, both fail-closed, both testable. See runsRefusal.
    const runsWrong = runsRefusal(got, w);
    if (runsWrong) {
      console.error(runsWrong);
      process.exit(2);
    }

    // The runs the workflow's own schedule started, for the `failing` verdict
    // (#1661). A second request because the mixed sample above can hold none
    // of them (see the header); `event=schedule` is a documented filter of this
    // endpoint (https://docs.github.com/rest/actions/workflow-runs), and the
    // refusal below checks it held on every row. A workflow with no schedule
    // answers an empty list, which is never `failing`.
    let scheduled;
    try {
      scheduled = await api(
        `/repos/${repo}/actions/workflows/${w.id}/runs?event=schedule&per_page=${sample}`,
        token
      );
    } catch (err) {
      console.error(`Could not read scheduled runs for ${w.path}: ${err.message}`);
      process.exit(2);
    }
    const scheduledWrong = runsRefusal(scheduled, w, { event: 'schedule' });
    if (scheduledWrong) {
      console.error(scheduledWrong);
      process.exit(2);
    }

    workflows.push({
      path: w.path,
      state: w.state,
      runs: got.workflow_runs,
      scheduledRuns: scheduled.workflow_runs,
    });
  }

  const selfPath = selfWorkflowPath(process.env);
  const results = assessAll(workflows, { now: new Date(), staleDays, selfPath });
  const report = renderReport(results, { staleDays, absent, defaultBranch });
  console.log(report);
  process.exit(hasFinding(results) ? 1 : 0);
}

// pathToFileURL, not a `file://` template: on Windows argv[1] is `C:\...` and
// the template form never matches, so the script would exit 0 having run
// nothing. That exact bug shipped in smoke-deployed.mjs; scripts/entrypoint-
// guards.test.mjs spawns this file to prove the guard still fires.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
/* c8 ignore stop */
