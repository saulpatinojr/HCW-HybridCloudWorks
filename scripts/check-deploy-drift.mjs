/**
 * How long production has been behind `main`, per deployed service.
 *
 * ## The gap this closes
 *
 * `deploy-functions.yml` and `deploy-azure-frontend.yml` were both
 * workflow_dispatch only, by a recorded decision: enabling a workflow and
 * enabling auto-deploy-on-merge are separate choices, and only the first was
 * made. Merging therefore deployed nothing, and NOTHING SAID SO.
 *
 * Since 2026-11-09 (owner decision on #1613) a merge that changes `frontend/`
 * starts a frontend deploy by itself, with no approval step (the owner
 * removed the `production` environment's required reviewers the same day).
 * The functions deploy is still started by hand, and since #1617 it waits for
 * a reviewer in the `production-backend` environment. This check reads the last
 * SUCCESSFUL run of each workflow, whatever started it, so a frontend run that
 * failed still shows here as drift. What it does not see is a change outside
 * `frontend/` that the site still needs (a repository variable, the deploy
 * workflow itself): that starts no deploy, and this check counts only commits
 * under `frontend/`, so such a change needs a frontend deploy started by hand.
 *
 * That single gap produced both of 2026-08-31's incidents, hours apart and both
 * found by accident:
 *
 *   - The manifest route merged at 2026-08-30 02:45 UTC against a Function App
 *     last deployed at 01:21. `publish-content-manifest.yml` then failed with a
 *     404 for two nights, and the failure message blamed the app.
 *   - The frontend was 35 commits behind, discovered only because someone
 *     deployed it for an unrelated reason.
 *
 * ## WHY AGE AND NOT COMMIT COUNT
 *
 * The obvious check is "how many commits behind". It cannot separate these two:
 * the 404 was **one** commit behind, the frontend **thirty-five**. Any threshold
 * that catches the first fires on every ordinary merge, and any threshold that
 * tolerates ordinary merges misses the outage.
 *
 * What the two share is TIME. Both sat undeployed for days. Drift measured in
 * hours tolerates the normal gap between a merge and its deploy (minutes for
 * the automatic frontend deploy, longer for a deploy started by hand) and still
 * catches a change that was merged and forgotten. So this reports the age of the OLDEST undeployed commit touching a
 * service's own paths, and fails past a threshold.
 *
 * ## Paths, not commits
 *
 * A service is only "behind" when something it ships has changed. Thirty commits
 * touching only `docs/` leave the Function App exactly as correct as it was.
 * Each service therefore declares the paths it deploys, and drift is measured
 * over commits touching those.
 *
 * ## The Terraform row reads the APPLY, not a workflow run (PLAT-3, #963)
 *
 * `infra/` ships through HCP Terraform: a merge to `main` queues a plan, and
 * the owner confirms the apply in the HCP Terraform UI. No workflow in this
 * repository performs that apply, so no workflow run can stand in for it. The
 * first version of this row (#1178) keyed it on the last successful
 * `tfc-plan-check.yml` run, and that run succeeds in three cases that apply
 * nothing: `TFC_TOKEN` unset (it skips, green), a plan nobody confirms (exit 0
 * on a run that is not awaiting a decision), and a plan the owner never
 * applies. So `infra/` could keep merging while the row printed ✅ — found by
 * a read-only review on 2026-10-15. The inverse held too: an apply from the
 * UI with no dispatch in 24 h read ❌ forever.
 *
 * The row now asks HCP Terraform directly: the workspace's newest run in state
 * `applied` (`filter[status]=applied`, `page[size]=1`), requested with
 * `include=configuration_version.ingress_attributes`, and the `commit-sha` of
 * that run's ingress attributes is the deployed baseline — the VCS commit the
 * applied configuration was planned from — with `status-timestamps.applied-at`
 * as the date. Drift is then the `infra/` commits on `main` after that commit,
 * measured as the other rows are. The walk through `included` is
 * `check-tfc-plan.mjs`'s, imported rather than copied.
 *
 * Two readings are refused rather than rendered healthy. A baseline commit
 * that is not on `main` (the compare API answers `behind` or `diverged`) is
 * reported as such and fails the report: production is running
 * infrastructure `main` does not contain, which is worse than drift and would
 * otherwise have counted as zero of it. And no token, or a read that fails,
 * renders ⚠️ with the reason — the row is self-arming in the same direction
 * as the rest of this file, never ✅ on an answer it did not get.
 *
 * ## On running this from a schedule GitHub delivers unreliably
 *
 * `monitor-functions-registered.yml` is documented as hourly and is delivered
 * about 22% of the time, a median 36 minutes late, with a 12.7-hour worst-case
 * gap (measured 2026-08-31). That is a real problem for an outage detector and
 * is NOT one here: this watches a condition measured in days, against a
 * threshold measured in hours. A check that lands every 4.6 hours on average
 * leaves under two checks of margin against the 8-hour threshold (24 until
 * 2026-10-23), and the worst-case gap can still delay one alert past it: a
 * late alert, never a missed one. Saying so is better than pretending the cron
 * is honoured.
 */
import { pathToFileURL } from 'node:url';

import { API, DEFAULT_THRESHOLD_HOURS, RETRY_DELAY_MS, SERVICES, TIMEOUT_MS } from './lib/deploy-drift-settings.mjs';
import { ageHours, isStale, oldestCommit, parseCommitDate } from './lib/deploy-drift-baselines.mjs';
import { appliedBaseline, collectPathCommits, compareWithMain, ghJson, workflowBaseline } from './lib/deploy-drift-github.mjs';
// The parts below now live in their own files; they are exported from here too, so callers keep their imports.
export { SERVICES, DEFAULT_THRESHOLD_HOURS, COMMITS_PER_PAGE, MAX_COMMIT_PAGES, RUNS_PER_PAGE, MAX_RUN_PAGES, TIMEOUT_MS, RETRY_DELAY_MS } from './lib/deploy-drift-settings.mjs';
export { parseRunIds, baselineOf, lastSuccessfulRun, missingTfcTokenMessage, parseLastAppliedRun, parseCommitDate, oldestCommit, ageHours, isStale } from './lib/deploy-drift-baselines.mjs';

/**
 * A value safe to drop into a Markdown table cell.
 *
 * Commit subjects and error text are not ours to constrain, and a `|` in either
 * ends the cell early: the row grows a column, everything after it shifts, and
 * the table stops rendering as a table. That matters more here than it sounds,
 * because this table IS the report — it is what an operator reads to decide
 * whether to deploy, at the hour a monitor tends to fire.
 *
 * Newlines are folded too. `oldestCommit` already takes only the first line of
 * a commit message, but error text comes from anywhere, and a newline inside a
 * row breaks the table exactly as thoroughly as a pipe.
 *
 * Backslashes are escaped FIRST, and that order is the whole correctness
 * argument. Escaping only `|` turns the subject `a \| b` into `a \\| b` — a
 * literal backslash, then a pipe Markdown still reads as a column break. The
 * escape meant to protect the table is what broke it. Escaping `\` first makes
 * that subject `a \\\| b`: one rendered backslash, one escaped pipe.
 */
export function cell(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

/** One service's mark and the text of its "Behind by" cell. */
function rowState(r, thresholdHours) {
  if (r.error) return { mark: '⚠️', text: cell(r.error) };
  if (r.neverDeployed) return { mark: '❌', text: 'never deployed' };
  // ❌ and not ⚠️: this WAS read. Production is running a commit `main`
  // does not contain, which is a stronger finding than drift, and the one
  // a drift count of zero would have hidden.
  if (r.notOnMain) {
    return {
      mark: '❌',
      text: `applied from ${cell(String(r.notOnMain.sha).slice(0, 8))}, which is not on main (${cell(r.notOnMain.status)})`,
    };
  }
  if (!r.oldest) return { mark: '✅', text: 'up to date' };
  const stale = isStale(r.hours, thresholdHours);
  return { mark: stale ? '❌' : '✅', text: `${r.count} commit(s), oldest ${r.hours}h — ${cell(r.oldest.message)}` };
}

/** The job-summary table, and whether anything in it is stale. */
export function formatReport(results, thresholdHours) {
  const states = results.map((r) => rowState(r, thresholdHours));
  const rows = results.map((r, i) => `| ${cell(r.name)} | ${states[i].mark} | ${states[i].text} |`);
  // Anything but ✅ fails: an unread service (⚠️) as much as a stale one (❌).
  const failed = states.some((state) => state.mark !== '✅');

  return {
    failed,
    text: [
      '## Deployment drift',
      '',
      `Threshold: **${thresholdHours}h**. Measured against \`main\`.`,
      '',
      '| Service | | Behind by |',
      '| --- | :---: | --- |',
      ...rows,
      '',
      failed
        ? '**Deploy the service(s) marked ❌.** The Function App deploy is started by hand ' +
          '(deploy-functions.yml) and waits for a reviewer to approve it (the ' +
          'production-backend environment). The Static Web App deploys by itself when a merge changes ' +
          'frontend/, so ❌ there means that run failed or did not finish: re-run it, or start ' +
          'deploy-azure-frontend.yml by hand. The Terraform Infrastructure apply is confirmed ' +
          'by hand in HCP Terraform. A ⚠️ means the check could not read the answer, which is ' +
          'not the same as drift.'
        : 'Every service is within the threshold.',
    ].join('\n'),
  };
}

/** Drift for one service. Never throws: a failure is reported as its own row. */
export async function driftFor(
  service,
  {
    token,
    tfcToken,
    owner,
    repo,
    nowMs,
    fetchImpl = fetch,
    retryDelayMs = RETRY_DELAY_MS,
    timeoutMs = TIMEOUT_MS,
  }
) {
  try {
    const last = service.terraform
      ? await appliedBaseline(service, { tfcToken, fetchImpl })
      : await workflowBaseline(service, { token, owner, repo, fetchImpl, retryDelayMs, timeoutMs });
    if (!last) return { name: service.name, neverDeployed: true };

    if (service.terraform) {
      const { onMain, status } = await compareWithMain(last.sha, {
        token,
        owner,
        repo,
        fetchImpl,
        retryDelayMs,
        timeoutMs,
      });
      if (!onMain) {
        return { name: service.name, notOnMain: { sha: last.sha, status, runId: last.runId } };
      }
    }

    const deployed = await ghJson(
      fetchImpl,
      `${API}/repos/${owner}/${repo}/commits/${last.sha}`,
      token,
      { retryDelayMs, timeoutMs }
    );
    const since = parseCommitDate(deployed);

    // Keyed by sha, for the two reasons review named: a commit touching two of a
    // service's declared paths comes back once per path and would be counted
    // twice, and pagination can repeat a boundary commit between pages.
    const seen = new Map();
    const gh = (url) => ghJson(fetchImpl, url, token, { retryDelayMs, timeoutMs });
    for (const path of service.paths) {
      await collectPathCommits({ path, since, deployedSha: last.sha, owner, repo, gh, seen });
    }

    const commits = [...seen.values()];
    const oldest = oldestCommit(commits);

    // Commits exist but none carries a readable date. An error row rather than
    // zero drift: answering "0 hours" would call an unanswerable service
    // healthy, which is the failure direction this whole file avoids.
    if (commits.length > 0 && !oldest) {
      return {
        name: service.name,
        error: `${commits.length} undeployed commit(s), none with a readable date`,
      };
    }
    return {
      name: service.name,
      deployedSha: last.sha,
      count: commits.length,
      oldest,
      hours: oldest?.date ? ageHours(oldest.date, nowMs) : 0,
    };
  } catch (error) {
    return { name: service.name, error: error?.message || String(error) };
  }
}

export async function main() {
  const token = process.env.GITHUB_TOKEN;
  // Not refused here when absent: the Terraform row renders ⚠️ with the
  // reason and the report fails, while the two deploy rows still answer.
  const tfcToken = process.env.TFC_TOKEN;
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '').split('/');
  const thresholdHours = Number(process.env.DRIFT_THRESHOLD_HOURS || DEFAULT_THRESHOLD_HOURS);

  if (!token) {
    console.error('GITHUB_TOKEN must be set.');
    return 2;
  }
  if (!owner || !repo) {
    console.error('GITHUB_REPOSITORY must be set to owner/repo.');
    return 2;
  }
  if (!Number.isFinite(thresholdHours) || thresholdHours <= 0) {
    console.error(`DRIFT_THRESHOLD_HOURS must be a positive number, got ${thresholdHours}.`);
    return 2;
  }

  const nowMs = Date.now();
  const results = [];
  for (const service of SERVICES) {
    results.push(await driftFor(service, { token, tfcToken, owner, repo, nowMs }));
  }

  const { failed, text } = formatReport(results, thresholdHours);
  console.log(text);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`\n${error.message}`);
      process.exit(2);
    });
}
