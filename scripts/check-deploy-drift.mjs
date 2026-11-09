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
 * The functions deploy is still started by hand. This check reads the last
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

import { indexIncluded, ingressCommitFor } from './check-tfc-plan.mjs';
import { ORGANIZATION, WORKSPACE, tfc } from './tfc-workspace-busy.mjs';

const API = 'https://api.github.com';

/**
 * What each deployable service is, and what it ships.
 *
 * A service names where its deployed baseline comes from: the `workflow`
 * whose last successful run deployed it, or the `terraform` workspace whose
 * last applied run did (see the header for why those are different reads).
 * `paths` are prefixes matched against the repository-relative paths the
 * GitHub commits API is filtered by. Adding a service here is the only change
 * a new deploy target needs.
 */
export const SERVICES = Object.freeze([
  Object.freeze({
    name: 'Function App',
    workflow: 'deploy-functions.yml',
    paths: Object.freeze(['functions']),
  }),
  Object.freeze({
    name: 'Static Web App',
    workflow: 'deploy-azure-frontend.yml',
    paths: Object.freeze(['frontend']),
  }),
  Object.freeze({
    name: 'Terraform Infrastructure',
    // No `workflow`: nothing in this repository applies, so the baseline is
    // the newest APPLIED run on the workspace, read from HCP Terraform. One
    // path: `infra/cosmos-containers.json` sits under `infra`. The first
    // version also listed `cosmos-containers.json` at the root, which does
    // not exist and matched nothing (F5, #963).
    terraform: Object.freeze({ organization: ORGANIZATION, workspace: WORKSPACE }),
    paths: Object.freeze(['infra']),
  }),
]);

/** Hours of drift tolerated before this is called stale. */
export const DEFAULT_THRESHOLD_HOURS = 8;

/** GitHub's maximum page size for the commits API. */
export const COMMITS_PER_PAGE = 100;

/**
 * A ceiling on pagination, so an unexpected answer cannot loop against the API
 * forever. Ten pages is 1,000 commits since the last deploy — far past any
 * drift worth measuring rather than simply deploying.
 */
export const MAX_COMMIT_PAGES = 10;

/**
 * How many of a deploy workflow's runs one listing page names, newest first,
 * and so how many are read by id per page (#1564). The same ten
 * `check-functions-deploy-in-progress.mjs` reads: a deploy succeeds far more
 * often than not, so the newest success is nearly always on the first page,
 * and ten reads a page keeps a monitor that runs every four hours well
 * inside the token's hourly allowance.
 */
export const RUNS_PER_PAGE = 10;

/**
 * How many listing pages are read before this stops looking for a success.
 * Ten pages is a hundred runs with no success among them; past that, "never
 * deployed" and "a long failure streak" cannot be told apart from here, and
 * `lastSuccessfulRun` says so rather than guessing either.
 */
export const MAX_RUN_PAGES = 10;

/**
 * How long one GitHub request may take, and the pause before the one retry a
 * 5xx, a 429 or a dropped connection gets. The two values
 * `check-functions-deploy-in-progress.mjs` uses, for the same reason: without
 * a bound a stalled connection waits on undici's five-minute defaults, and
 * the monitor's job has a ten-minute timeout.
 */
export const TIMEOUT_MS = 15000;
export const RETRY_DELAY_MS = 2000;

/**
 * The run ids one page of a workflow's run listing names, newest first.
 *
 * Only the ids are read from the listing (#1564). Its `status` and
 * `conclusion` are not: GitHub's reference for "List workflow runs for a
 * workflow" says the `status` filter answers from a search over the check-run
 * status, not from the run, and on 2026-11-05 that search answered empty for
 * a run that was in progress (`check-functions-deploy-in-progress.mjs`
 * records the readings). Until then this row asked that filter for the one
 * newest success, so a lagging search could have named the deploy before the
 * one that had just finished, and measured drift against it. A listing that
 * lags the run is still a complete list of the run ids, and each id is then
 * read for itself.
 *
 * Throws on a shape it cannot read rather than returning nothing, following
 * check-unresolved-secrets.mjs: "no runs" and "I could not read the answer"
 * are different facts, and reporting the second as the first would announce
 * drift against a baseline that does not exist.
 */
export function parseRunIds(body) {
  const runs = body?.workflow_runs;
  if (!Array.isArray(runs)) {
    throw new Error(
      'GitHub returned a workflow-runs payload without a `workflow_runs` array. Expected the ' +
        'response of GET /repos/:owner/:repo/actions/workflows/:file/runs.'
    );
  }
  const ids = [];
  for (const run of runs) {
    const id = Number(run?.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error('A listed workflow run came back with no numeric `id`, so it cannot be read.');
    }
    ids.push(id);
  }
  return ids;
}

/**
 * The deployed baseline a run's own record gives, or null when that run did
 * not deploy.
 *
 * A run deployed only when its record says `status: completed` and
 * `conclusion: success`, both read from `GET /actions/runs/:id`, the read the
 * other monitors trust. Both fields, not the conclusion alone: "Re-run jobs"
 * takes a completed run back to `in_progress` under the same id, and GitHub
 * documents `conclusion` as null until the run completes, so a run that is
 * running again is not a deploy that has happened. Anything else (a failure,
 * a cancellation, a run still going) is null, and the caller moves to the
 * next older run.
 *
 * A record this cannot read throws, and is not read as "did not deploy":
 * no `status` at all, or `completed` with no `conclusion`, is a payload
 * that is not a run record (GitHub documents `conclusion` as null only
 * while the run is not completed), and treating it as null would let a
 * broken read reach the ❌ "never deployed" row. A read error is the ⚠️
 * row, which is the other thing (raised in CodeRabbit's review of #1567).
 * A run that is not completed is allowed a null `conclusion`.
 *
 * A successful run with no `head_sha` throws: it IS the newest deploy, and
 * nothing on `main` can be compared with it, which is an answer this row
 * cannot give rather than zero drift.
 */
export function baselineOf(run) {
  const id = run?.id ?? '(unidentified run)';
  if (typeof run?.status !== 'string' || run.status === '') {
    throw new Error(
      `Run ${id} came back with no \`status\`, so it cannot be read as a run record. Expected the ` +
        'response of GET /repos/:owner/:repo/actions/runs/:id.'
    );
  }
  if (run.status !== 'completed') return null;
  if (typeof run.conclusion !== 'string' || run.conclusion === '') {
    throw new Error(
      `Run ${id} is \`completed\` with no \`conclusion\`, so whether it deployed cannot be read.`
    );
  }
  if (run.conclusion !== 'success') return null;
  if (typeof run.head_sha !== 'string' || !run.head_sha) {
    throw new Error(
      `Successful run ${run.id ?? '(unidentified run)'} came back with no \`head_sha\`, so nothing can be compared.`
    );
  }
  return { sha: run.head_sha, runNumber: run.run_number ?? null, at: run.created_at ?? null };
}

/**
 * The newest run of `workflow` whose own record says it succeeded, or null
 * when the workflow has never had one (#1564).
 *
 * Pages of `RUNS_PER_PAGE` ids are listed with no status filter (see
 * `parseRunIds` for why), each page's runs are read by id together, and the
 * first page with a success answers with its newest. A short page is the end
 * of the history, so reaching it with no success is "never deployed", a fact
 * reported as its own row. Running out of pages first is not that fact: a
 * hundred runs with no success could be a workflow that never worked or one
 * that has failed a hundred times since it last did, and this throws rather
 * than choosing, so the row renders ⚠️ with the reason.
 *
 * `read` takes a URL path under the API root and answers its JSON; it is a
 * parameter so the tests can replay a listing that lags the runs.
 */
export async function lastSuccessfulRun(workflow, read) {
  for (let page = 1; page <= MAX_RUN_PAGES; page += 1) {
    const ids = parseRunIds(
      await read(`/actions/workflows/${workflow}/runs?per_page=${RUNS_PER_PAGE}&page=${page}`)
    );
    const runs = await Promise.all(ids.map((id) => read(`/actions/runs/${id}`)));
    // Newest by when the run last started, not by its place in the listing:
    // "Re-run jobs" keeps a run's id, place and `created_at` and moves its
    // `run_started_at`, so a re-run of an older run can be the newest deploy.
    // Within this page only: a re-run of a run older than the page is not
    // seen, the bound `check-functions-deploy-in-progress.mjs` accepts for
    // its MAX_RUNS, and the deploys are hours apart, so an unseen one is of a
    // run days old.
    const started = (run) => String(run?.run_started_at ?? run?.created_at ?? '');
    const found = runs
      .filter((run) => baselineOf(run) !== null)
      .sort((a, b) => started(b).localeCompare(started(a)));
    if (found.length > 0) return baselineOf(found[0]);
    if (ids.length < RUNS_PER_PAGE) return null;
  }
  throw new Error(
    `None of the newest ${MAX_RUN_PAGES * RUNS_PER_PAGE} runs of ${workflow} succeeded, and older runs ` +
      'were not read, so whether it has ever deployed cannot be told from here.'
  );
}

/**
 * Why the Terraform row cannot be read without a token. The row, not the
 * whole run: the two deploy rows need nothing from HCP Terraform and still
 * answer, and a summary that says which row could not be read is worth more
 * than a job that skipped.
 */
export function missingTfcTokenMessage() {
  return (
    `TFC_TOKEN is not set, so the last applied run on ${ORGANIZATION}/${WORKSPACE} cannot be ` +
    'read and this row has no deployed baseline (PLAT-3, #963). Seed TFC_TOKEN as a repository ' +
    'secret (Settings -> Secrets and variables -> Actions); the check job reads it from the ' +
    'automation environment.'
  );
}

/**
 * The newest APPLIED run on the Terraform workspace, as a deployed baseline.
 *
 * Reads the JSON:API document of
 * `GET /workspaces/:id/runs?filter[status]=applied&page[size]=1` with
 * `include=configuration_version.ingress_attributes`, and answers the commit
 * the run was planned from plus when it applied. Same contract as
 * `lastSuccessfulRun`: null is "this workspace has never applied", a
 * fact reported as its own row, and every shape that cannot be read THROWS,
 * so `driftFor` renders ⚠️ rather than a baseline that does not exist.
 *
 * The status is checked against the filter rather than trusted to it. If
 * HCP Terraform ignored or renamed `filter[status]`, the newest run of any
 * kind would come back — a plan awaiting confirmation, say — and its commit
 * would read as applied. That is the exact false green this row was reopened
 * for (F4), arriving by a different door, so the door is shut here.
 *
 * A run with no VCS commit (uploaded through the API or CLI) is thrown on,
 * not skipped: it IS the newest apply, and nothing on `main` can be compared
 * with it, which is an answer this row cannot give rather than zero drift.
 */
export function parseLastAppliedRun(payload) {
  if (!payload || !Array.isArray(payload.data)) {
    throw new Error(
      'HCP Terraform returned a runs payload without a `data` array. Expected the JSON:API ' +
        'response of GET /workspaces/:id/runs?filter[status]=applied.'
    );
  }
  if (payload.data.length === 0) return null;
  if (!Array.isArray(payload.included)) {
    throw new Error(
      "HCP Terraform returned no `included` section, so the applied run's commit cannot be " +
        'resolved. The request must carry include=configuration_version.ingress_attributes.'
    );
  }

  const [run] = payload.data;
  const status = run?.attributes?.status;
  if (status !== 'applied') {
    throw new Error(
      `HCP Terraform listed run ${run?.id ?? '(unidentified run)'} in state "${status ?? 'unknown'}" ` +
        'under filter[status]=applied, so the listing cannot be read as the applied baseline.'
    );
  }

  const sha = ingressCommitFor(run, indexIncluded(payload.included));
  if (sha === null) {
    throw new Error(
      `Applied run ${run.id ?? '(unidentified run)'} carries no VCS commit — no configuration ` +
        'version, or one uploaded without ingress attributes — so it cannot be compared with main.'
    );
  }

  return {
    // Lower-cased once here: GitHub's shas are lower-case hex and the exclusion
    // in `driftFor` compares by string, so a differently-cased sha from HCP
    // Terraform would count the deployed commit as one commit of drift.
    sha: sha.toLowerCase(),
    runId: run.id ?? null,
    at: run.attributes?.['status-timestamps']?.['applied-at'] ?? null,
  };
}

/** The commit date of a single commit payload, as an ISO string. */
export function parseCommitDate(body) {
  const date = body?.commit?.committer?.date || body?.commit?.author?.date;
  if (typeof date !== 'string' || !date) {
    throw new Error(
      'GitHub returned a commit payload with no committer or author date. Expected the response ' +
        'of GET /repos/:owner/:repo/commits/:sha.'
    );
  }
  return date;
}

/**
 * The oldest commit in a list, BY DATE — not by position.
 *
 * The first version took the last element, because the GitHub commits API
 * returns newest first. That is true of a single page of a single path and of
 * nothing else. Review pointed out that `driftFor` concatenates one list per
 * declared path, so a merged array is newest-first only WITHIN each segment:
 * with two paths the last element is the second path's oldest commit, which can
 * be far newer than the first path's. The answer would read healthier than
 * reality — the same failure direction as taking the newest commit outright,
 * which this module's tests already treat as the thing most worth preventing.
 *
 * Ordering is now not assumed at all. A minimum over parsed dates cannot be
 * wrong about which commit is oldest, however the list was assembled, and that
 * removes a class of bug rather than the one instance of it.
 *
 * Commits with no readable date are skipped rather than treated as epoch zero,
 * which would report drift of half a century. `driftFor` turns "commits exist
 * but none are dated" into an error row, because that is a shape problem rather
 * than a healthy service.
 */
export function oldestCommit(commits) {
  if (!Array.isArray(commits) || commits.length === 0) return null;

  let best = null;
  let bestMs = Infinity;
  for (const c of commits) {
    const date = c?.commit?.committer?.date || c?.commit?.author?.date || null;
    const ms = date ? Date.parse(date) : Number.NaN;
    if (!Number.isFinite(ms) || ms >= bestMs) continue;
    bestMs = ms;
    best = {
      sha: c?.sha ?? null,
      date,
      message: String(c?.commit?.message ?? '').split('\n')[0],
    };
  }
  return best;
}

/** Whole hours between an ISO timestamp and now, floored, never negative. */
export function ageHours(isoDate, nowMs) {
  const then = Date.parse(isoDate);
  if (!Number.isFinite(then)) throw new Error(`Not a date: ${isoDate}`);
  return Math.max(0, Math.floor((nowMs - then) / 3_600_000));
}

/**
 * Whether a service's drift is stale.
 *
 * `>=` rather than `>`: a threshold of 8 should fire at 8 hours, not at 9.
 * Written out because an off-by-one here is a day of silence.
 */
export function isStale(hours, thresholdHours) {
  return hours >= thresholdHours;
}

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

/** The job-summary table, and whether anything in it is stale. */
export function formatReport(results, thresholdHours) {
  const rows = results.map((r) => {
    if (r.error) return `| ${cell(r.name)} | ⚠️ | ${cell(r.error)} |`;
    if (r.neverDeployed) return `| ${cell(r.name)} | ❌ | never deployed |`;
    // ❌ and not ⚠️: this WAS read. Production is running a commit `main`
    // does not contain, which is a stronger finding than drift, and the one
    // a drift count of zero would have hidden.
    if (r.notOnMain) {
      return (
        `| ${cell(r.name)} | ❌ | applied from ${cell(String(r.notOnMain.sha).slice(0, 8))}, ` +
        `which is not on main (${cell(r.notOnMain.status)}) |`
      );
    }
    if (!r.oldest) return `| ${cell(r.name)} | ✅ | up to date |`;
    const stale = isStale(r.hours, thresholdHours);
    return `| ${cell(r.name)} | ${stale ? '❌' : '✅'} | ${r.count} commit(s), oldest ${r.hours}h — ${cell(r.oldest.message)} |`;
  });

  const failed = results.some(
    (r) => r.error || r.neverDeployed || r.notOnMain || (r.oldest && isStale(r.hours, thresholdHours))
  );

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
          '(deploy-functions.yml). The Static Web App deploys by itself when a merge changes ' +
          'frontend/, so ❌ there means that run failed or did not finish: re-run it, or start ' +
          'deploy-azure-frontend.yml by hand. The Terraform Infrastructure apply is confirmed ' +
          'by hand in HCP Terraform. A ⚠️ means the check could not read the answer, which is ' +
          'not the same as drift.'
        : 'Every service is within the threshold.',
    ].join('\n'),
  };
}

/** Rejects with the signal's reason once it aborts; never resolves. */
function abortedBy(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/**
 * The JSON of one GitHub read, after at most one retry, or an error naming
 * why not. One attempt is the headers and the body under one deadline of
 * `timeoutMs`, and a 5xx, a 429, a dropped connection, a stalled body or a
 * body that cannot be read is asked once more after `retryDelayMs`; a 4xx
 * other than 429 is a refusal and is not. The same shape as
 * `check-functions-deploy-in-progress.mjs`'s reader (#1564).
 *
 * The body is raced against the same signal rather than left to the fetch:
 * `AbortSignal.timeout` on the request covers the headers, and a body that
 * GitHub starts and never finishes would otherwise wait on undici's own
 * defaults, past the deadline and outside the retry (raised in CodeRabbit's
 * review of #1567). The timeout is a parameter so a test can see it fire.
 */
async function ghJson(
  fetchImpl,
  url,
  token,
  { retryDelayMs = RETRY_DELAY_MS, timeoutMs = TIMEOUT_MS } = {}
) {
  const retryable = (status) => status >= 500 || status === 429;
  const pause = () => new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  for (let attempt = 1; ; attempt += 1) {
    const last = attempt === 2;
    const signal = AbortSignal.timeout(timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal,
      });
    } catch (error) {
      if (last) throw new Error(`GitHub did not answer ${url}: ${error?.message || String(error)}`);
      await pause();
      continue;
    }
    if (!res.ok) {
      if (last || !retryable(res.status)) throw new Error(`GitHub answered ${res.status} for ${url}`);
      await pause();
      continue;
    }
    try {
      return await Promise.race([res.json(), abortedBy(signal)]);
    } catch (error) {
      if (last) {
        throw new Error(
          `GitHub answered ${url} but its body could not be read: ${error?.message || String(error)}`
        );
      }
      await pause();
    }
  }
}

/**
 * The head of a workflow's last successful run, or null when it has none.
 * `lastSuccessfulRun` does the reading and says why the listing's
 * `status=success` filter is no longer asked (#1564).
 */
async function workflowBaseline(service, { token, owner, repo, fetchImpl, retryDelayMs, timeoutMs }) {
  return lastSuccessfulRun(service.workflow, (path) =>
    ghJson(fetchImpl, `${API}/repos/${owner}/${repo}${path}`, token, { retryDelayMs, timeoutMs })
  );
}

/**
 * The commit the workspace's newest applied run was planned from, or null
 * when nothing has applied. Two calls, both reads: the workspace by name for
 * its id, as the other two HCP Terraform scripts resolve it, then one run.
 */
async function appliedBaseline(service, { tfcToken, fetchImpl }) {
  if (!tfcToken) throw new Error(missingTfcTokenMessage());
  const { organization, workspace } = service.terraform;
  const ws = await tfc(tfcToken, `/organizations/${organization}/workspaces/${workspace}`, {
    fetchImpl,
  });
  if (typeof ws?.id !== 'string' || !ws.id) {
    throw new Error(
      `HCP Terraform returned no id for workspace ${organization}/${workspace}. Expected the ` +
        'response of GET /organizations/:org/workspaces/:name.'
    );
  }
  const payload = await tfc(
    tfcToken,
    `/workspaces/${ws.id}/runs?filter%5Bstatus%5D=applied&page%5Bsize%5D=1` +
      '&include=configuration_version.ingress_attributes',
    { raw: true, fetchImpl }
  );
  return parseLastAppliedRun(payload);
}

/**
 * Is `sha` on `main`? Asked only of the Terraform baseline. A deploy
 * workflow's head is `main` by construction — both deploys refuse any other
 * ref — but HCP Terraform applies whatever commit the workspace was pointed
 * at, and a baseline off `main` would otherwise count as zero drift.
 *
 * `compare/:sha...main` describes main relative to the sha: `ahead` or
 * `identical` means the sha is an ancestor of main (or main itself);
 * `behind` or `diverged` means main does not contain it. A status this does
 * not recognise is thrown on, in the direction the rest of the file takes.
 */
async function compareWithMain(sha, { token, owner, repo, fetchImpl, retryDelayMs, timeoutMs }) {
  const body = await ghJson(fetchImpl, `${API}/repos/${owner}/${repo}/compare/${sha}...main`, token, {
    retryDelayMs,
    timeoutMs,
  });
  const status = body?.status;
  if (status === 'ahead' || status === 'identical') return { onMain: true, status };
  if (status === 'behind' || status === 'diverged') return { onMain: false, status };
  throw new Error(
    `GitHub returned a compare payload with status ${JSON.stringify(status ?? null)} for ${sha}...main. ` +
      'Expected ahead, identical, behind or diverged from GET /repos/:owner/:repo/compare/:base...:head.'
  );
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

    for (const path of service.paths) {
      // PAGINATED. One page is 100 commits, and drift matters MOST when it is
      // large — the frontend was 35 behind, and a longer gap is exactly the case
      // a first-page-only read under-reports, returning a too-recent "oldest"
      // and therefore a healthier age than the truth.
      for (let page = 1; page <= MAX_COMMIT_PAGES; page += 1) {
        const batch = await ghJson(
          fetchImpl,
          `${API}/repos/${owner}/${repo}/commits?sha=main&path=${encodeURIComponent(path)}` +
            `&since=${encodeURIComponent(since)}&per_page=${COMMITS_PER_PAGE}&page=${page}`,
          token,
          { retryDelayMs, timeoutMs }
        );
        // THROWN, not defaulted to []. Silently treating an unreadable payload
        // as an empty page reports the service as up to date — the same
        // healthier-than-reality direction as every other defect found in this
        // file, and the one the whole check exists to avoid. driftFor's catch
        // turns this into a ⚠️ row, which says "could not read" rather than
        // "nothing to deploy". parseRunIds and parseCommitDate above
        // already work this way; this line did not, which was the
        // inconsistency review caught.
        if (!Array.isArray(batch)) {
          throw new Error(
            `GitHub returned a non-array commits payload for ${path} (page ${page}). Expected ` +
              'the response of GET /repos/:owner/:repo/commits.'
          );
        }
        const rows = batch;
        for (const c of rows) {
          // `since` is inclusive of the boundary commit, which is the deployed
          // one when it touched this path. Excluding it by sha keeps a
          // just-deployed service from reporting itself one commit behind.
          if (c?.sha && c.sha !== last.sha) seen.set(c.sha, c);
        }
        if (rows.length < COMMITS_PER_PAGE) break;
      }
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

async function main() {
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
