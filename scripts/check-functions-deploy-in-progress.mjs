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
 * ## How it finds a live run (changed after 2026-11-05)
 *
 * Until 2026-11-05 this asked the Actions API for the workflow's runs with
 * `status=in_progress` and believed an empty answer. That evening it
 * collided again. Deploy run 42096627372 (#213) was in progress from
 * 19:43:48Z to 19:47:42Z and held the window from its step 8 to its step 13;
 * monitor run 42096833406 started at 19:44:57Z, asked this at 19:45:51Z and
 * again a minute later, was told `none` both times, and failed the run on a
 * window that closed on time. In the same monitor run the access-windows
 * check, which reads each run by id, saw the same run as live.
 *
 * GitHub's reference for "List workflow runs for a workflow" says the
 * `status` parameter "Returns workflow runs with the check run status or
 * conclusion that you specify" and that the endpoint "will return up to
 * 1,000 results for each search": the filtered listing is a search over the
 * check-run status, not a read of the run, and it answers from a different
 * place than the run itself. Read on 2026-11-05 at 19:54Z, with every run in
 * the repository completed, the repository-wide `status=in_progress` listing
 * still reported `total_count: 1` with an empty page, and `status=completed`
 * counted 2,500 runs against 28,926 unfiltered. A listing that can say both
 * of those cannot be trusted to name a live run. Watched again at 20:04:42Z
 * against a CI run that had started five seconds earlier: the workflow's
 * `status=in_progress` listing said `total_count: 0`, the unfiltered listing
 * and the run by id said `in_progress`; at 20:06:18Z the filtered listing
 * said `total_count: 1` with an empty page, and the unfiltered listing showed
 * the same run as `queued` while its record said `in_progress`.
 *
 * So the filter is no longer used. This lists the workflow's newest runs
 * with no status filter (the listing the drift and health checks also read),
 * takes every run that listing does not show as `completed`, and reads each
 * of those by id (`GET /actions/runs/:id`, the read the access-windows check
 * trusts). A run is in progress only when its own record says so. The
 * listing's statuses are checked, not believed: a run it shows as `queued`
 * or `waiting` is still read by id, because the listing can lag the run.
 * A run it shows as `completed` is not, because a status only moves forward.
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

import { LIVE_STATUSES } from './check-ci-access-windows.mjs';
import { DEPLOY_WORKFLOW } from './check-registered-functions.mjs';

const API = 'https://api.github.com';

/**
 * How many of the workflow's newest runs are listed. `deploy-functions.yml`
 * runs in one concurrency group, so at most one is live at a time, and its
 * runs are hours apart, so a live one is always among the newest few; the
 * margin is for a re-run attempt racing its predecessor's teardown and for a
 * run or two waiting on the `production` approval ahead of it.
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

/** The JSON of one Actions API read, after at most one retry, or an error naming why not. */
async function getJson({ url, token, fetchImpl, retryDelayMs }) {
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
 * The workflow's newest runs are listed with no status filter (the header
 * says why the `status=in_progress` filter is not asked), every run that
 * listing does not show as `completed` is read by id, and a run counts only
 * when its own record says `in_progress`. A listing that ignored
 * `per_page`, or that mixed finished runs in, cannot make a finished run
 * look live: the run's record decides.
 */
export async function findDeploysInProgress({ token, owner, repo, fetchImpl = fetch, retryDelayMs = RETRY_DELAY_MS }) {
  const url = `${API}/repos/${owner}/${repo}/actions/workflows/${DEPLOY_WORKFLOW}/runs?per_page=${MAX_RUNS}`;
  const body = await getJson({ url, token, fetchImpl, retryDelayMs });
  if (!Array.isArray(body?.workflow_runs)) {
    throw new Error(
      'GitHub returned a workflow-runs payload without a `workflow_runs` array. Expected the ' +
        `response of GET /repos/:owner/:repo/actions/workflows/${DEPLOY_WORKFLOW}/runs.`
    );
  }
  const live = [];
  for (const listed of body.workflow_runs) {
    const id = Number(listed?.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    if (!LIVE_STATUSES.includes(listed?.status)) continue;
    const run = await getJson({ url: `${API}/repos/${owner}/${repo}/actions/runs/${id}`, token, fetchImpl, retryDelayMs });
    if (run?.status === 'in_progress') live.push(run);
  }
  return live;
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
