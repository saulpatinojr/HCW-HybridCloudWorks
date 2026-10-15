/**
 * Is a functions deploy in progress right now? (#1205)
 *
 * ## Why the monitor asks
 *
 * `deploy-functions.yml` opens the host storage account to its runner for the
 * package upload (one IP rule, and the default action set to Allow) and
 * closes it a couple of minutes later. `monitor-functions-registered.yml`
 * reads that account's firewall to catch a window a run never closed (T-713).
 * The two cannot tell each other apart from the firewall alone: an open
 * window during a deploy and an orphaned one after it read the same.
 *
 * On 2026-10-15 they collided. Deploy run 38819173840 held the window from
 * 22:45:18Z to 22:47:35Z; the monitor run that started at 22:44:55Z read the
 * account at 22:45:38Z, reported `Allow` and one IP rule as ❌, and failed.
 * The window closed on time, as it was built to.
 *
 * So before the monitor believes an open window, it asks this whether a
 * deploy run is in progress. If one is, the monitor waits for it to finish
 * and reads again. A window still open after its run has ended is the orphan
 * the check exists to find.
 *
 * ## Why a run, not a step
 *
 * The window exists only while a run of `deploy-functions.yml` is
 * `in_progress`. A run waiting on the `production` approval is `waiting` and
 * has opened nothing, and a queued run has not started. Reading the run's
 * status is one call; reading which step it is on would add a jobs call and
 * a dependency on step names, and the run is the bound that matters: once it
 * has ended, every always() step it was going to run has run.
 *
 * ## Output contract
 *
 * stdout line 1 is a short value for a log line or a table cell: `none`,
 * `deploy run #312 in progress`, or `unreadable`. Every following line is
 * Markdown detail naming each run and its URL. Nothing goes to stderr on a
 * verdict.
 *
 * Exit 0: no deploy run is in progress. Exit 1: at least one is, named.
 * Exit 2: the run history could not be read, which says nothing either way;
 * the monitor then judges the firewall without waiting, as it did before.
 *
 * ## Usage
 *
 *     GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo \
 *       node scripts/check-functions-deploy-in-progress.mjs
 *
 * The token needs `actions: read`, which the monitor's job already holds to
 * find the deployed commit.
 */
import { pathToFileURL } from 'node:url';

import { DEPLOY_WORKFLOW } from './check-registered-functions.mjs';

const API = 'https://api.github.com';

/**
 * How many in-progress runs are asked for. `deploy-functions.yml` runs in
 * one concurrency group, so there is never more than one; the margin is for
 * a re-run attempt racing its predecessor's teardown.
 */
export const MAX_RUNS = 5;

/** The verdict when the run history could not be read. */
export function formatUnreadable(reason) {
  return {
    code: 2,
    lines: ['unreadable', `Whether a functions deploy is in progress could not be read: ${reason}`],
  };
}

/** The verdict for the runs found in progress, which may be none. */
export function formatRuns(runs) {
  if (runs.length === 0) return { code: 0, lines: ['none'] };
  const label = (run) => (run.run_number ? `deploy run #${run.run_number}` : `deploy run ${run.id}`);
  const head = runs.length === 1 ? `${label(runs[0])} in progress` : `${runs.length} deploy runs in progress`;
  return {
    code: 1,
    lines: [
      head,
      ...runs.map((run) => {
        const started = run.run_started_at ? `, started ${run.run_started_at}` : '';
        return `- ${label(run)} of \`${DEPLOY_WORKFLOW}\`${started}: ${run.html_url ?? 'no URL returned'}`;
      }),
    ],
  };
}

/**
 * The runs of `DEPLOY_WORKFLOW` that are in progress, newest first.
 *
 * The API's `status=in_progress` filter is asked for and then checked again
 * on each run, so a payload that ignored the filter cannot make a finished
 * run look live, or hide a live one behind a finished one.
 */
export async function findDeploysInProgress({ token, owner, repo, fetchImpl = fetch }) {
  const url = `${API}/repos/${owner}/${repo}/actions/workflows/${DEPLOY_WORKFLOW}/runs?status=in_progress&per_page=${MAX_RUNS}`;
  const res = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${url}`);
  const body = await res.json();
  if (!Array.isArray(body?.workflow_runs)) {
    throw new Error(
      'GitHub returned a workflow-runs payload without a `workflow_runs` array. Expected the ' +
        `response of GET /repos/:owner/:repo/actions/workflows/${DEPLOY_WORKFLOW}/runs.`
    );
  }
  return body.workflow_runs.filter((run) => run?.status === 'in_progress');
}

/**
 * Everything but the process: environment in, exit code and stdout lines out.
 */
export async function run({ args = [], env = {}, fetchImpl = fetch }) {
  if (args.length > 0) {
    return formatUnreadable(`unknown argument(s) ${args.join(' ')}; this script takes none.`);
  }
  const token = env.GITHUB_TOKEN;
  const [owner, repo] = String(env.GITHUB_REPOSITORY ?? '').split('/');
  if (!token || !owner || !repo) {
    return formatUnreadable('it needs GITHUB_TOKEN and GITHUB_REPOSITORY (owner/repo).');
  }
  try {
    return formatRuns(await findDeploysInProgress({ token, owner, repo, fetchImpl }));
  } catch (error) {
    return formatUnreadable(error.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run({ args: process.argv.slice(2), env: process.env })
    .then(({ code, lines }) => {
      process.stdout.write(`${lines.join('\n')}\n`);
      process.exitCode = code;
    })
    .catch((error) => {
      process.stdout.write(`${formatUnreadable(error?.message || String(error)).lines.join('\n')}\n`);
      process.exitCode = 2;
    });
}
