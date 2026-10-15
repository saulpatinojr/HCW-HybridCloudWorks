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
 * deploy run is in progress. If one is, the monitor waits, reading the
 * firewall again every thirty seconds, until the window closes or the run
 * ends. A window still open after its run has ended is the orphan the check
 * exists to find.
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
 * Exit 2: the run history could not be read, which says nothing either way.
 * Before a deploy has been seen, the monitor then treats an open window as it
 * does with none running: it reads again a minute later, and a window still
 * open is ❌. Once one has been seen, it keeps waiting through two such
 * answers, and a third in a row makes the rows ⚠️, naming the run.
 *
 * Node exits 1 by itself when it fails before the script runs, so the
 * monitor believes exit 1 only with a line 1 ending ` in progress`.
 *
 * A request that takes longer than `TIMEOUT_MS` is abandoned, and a 5xx, a
 * 429 or a dropped connection is asked once more before the answer is 2.
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
 * How long one request may take. The monitor polls every thirty seconds, and
 * an answer that has not come in fifteen is not coming; without this, a
 * stalled connection waits on undici's five-minute defaults.
 */
export const TIMEOUT_MS = 15000;

/** The pause before the one retry a 5xx, a 429 or a dropped connection gets. */
export const RETRY_DELAY_MS = 2000;

/** Worth asking once more: the server's error or its rate limit, not a refusal. */
const retryable = (status) => status >= 500 || status === 429;

/** The runs payload, after at most one retry, or an error naming why not. */
async function getRuns({ url, token, fetchImpl, retryDelayMs }) {
  for (let attempt = 1; ; attempt += 1) {
    const last = attempt === 2;
    let res;
    try {
      res = await fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      if (last) throw new Error(`GitHub did not answer ${url}: ${error?.message || String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      continue;
    }
    if (res.ok) return res.json();
    if (last || !retryable(res.status)) throw new Error(`GitHub answered ${res.status} for ${url}`);
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
}

/**
 * The runs of `DEPLOY_WORKFLOW` that are in progress, newest first.
 *
 * The API's `status=in_progress` filter is asked for and then checked again
 * on each run, so a payload that ignored the filter cannot make a finished
 * run look live, or hide a live one behind a finished one.
 */
export async function findDeploysInProgress({ token, owner, repo, fetchImpl = fetch, retryDelayMs = RETRY_DELAY_MS }) {
  const url = `${API}/repos/${owner}/${repo}/actions/workflows/${DEPLOY_WORKFLOW}/runs?status=in_progress&per_page=${MAX_RUNS}`;
  const body = await getRuns({ url, token, fetchImpl, retryDelayMs });
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
export async function run({ args = [], env = {}, fetchImpl = fetch, retryDelayMs = RETRY_DELAY_MS }) {
  if (args.length > 0) {
    return formatUnreadable(`unknown argument(s) ${args.join(' ')}; this script takes none.`);
  }
  const token = env.GITHUB_TOKEN;
  const [owner, repo] = String(env.GITHUB_REPOSITORY ?? '').split('/');
  if (!token || !owner || !repo) {
    return formatUnreadable('it needs GITHUB_TOKEN and GITHUB_REPOSITORY (owner/repo).');
  }
  try {
    return formatRuns(await findDeploysInProgress({ token, owner, repo, fetchImpl, retryDelayMs }));
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
