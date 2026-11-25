/** Finding which commit is live on the function app, from the deploy workflow's runs, and reading the inventory at that commit (check-registered-functions.mjs). */

export const API = 'https://api.github.com';
/** Repository-relative, because the monitor reads it at other commits by this path. */
export const INVENTORY_PATH = 'functions/function-inventory.json';
export const DEPLOY_WORKFLOW = 'deploy-functions.yml';

/**
 * The step in `deploy-functions.yml` that replaces the live package. Renaming
 * that step without changing this would leave the monitor unable to find a
 * deploy and quietly disarmed; check-registered-functions.test.mjs reads the
 * workflow and fails first.
 */
export const DEPLOY_STEP = 'Deploy to Azure Functions';

/** How many deploy runs are listed per page while looking for the live package's commit. */
export const MAX_RUNS = 10;

/**
 * How many pages of runs are listed: fifty runs back. Listing is cheap; jobs
 * are read only for runs active after the newest upload found so far.
 */
export const MAX_PAGES = 5;
/** A GitHub REST request with the token and API version every call here sends. */
async function ghFetch(fetchImpl, url, token, accept = 'application/vnd.github+json') {
  return fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
}

/** A GitHub REST response body, or an error naming the status and URL. */
async function ghJson(fetchImpl, url, token) {
  const res = await ghFetch(fetchImpl, url, token);
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${url}`);
  return res.json();
}

/** The `workflow_runs` array of a runs payload, or an error saying it is not one. */
function runsOf(body) {
  const runs = body?.workflow_runs;
  if (!Array.isArray(runs)) {
    throw new Error(
      'GitHub returned a workflow-runs payload without a `workflow_runs` array. Expected the ' +
        `response of GET /repos/:owner/:repo/actions/workflows/${DEPLOY_WORKFLOW}/runs.`
    );
  }
  return runs;
}

/** When a run last changed: no step in it can have completed later. NaN when unknown. */
const lastActivity = (run) => Date.parse(run?.updated_at ?? run?.run_started_at ?? run?.created_at ?? '');

/**
 * The commit whose package is live: the newest successful `DEPLOY_STEP`
 * among the runs of `DEPLOY_WORKFLOW`, every attempt of each, whatever the
 * run's own conclusion.
 *
 * Up to `MAX_PAGES` pages of `MAX_RUNS` runs are listed, the newest run that
 * succeeded outright is asked for separately (`status=success`), and their
 * jobs are read in order of each run's last activity. A run whose last
 * activity is older than the upload already found is skipped, because no step
 * in it can have completed later. So a deploy that uploaded
 * and then failed a later check is found behind a string of later dispatches
 * that never reached the upload (refused on the ref, on a busy workspace, or
 * never approved), and the usual case, the newest run having uploaded, costs
 * one jobs call.
 *
 * @returns {Promise<{ sha: string, runNumber: number|null, completedAt: string } | null>}
 *   null when no run this can see has uploaded a package.
 */
export async function findDeployedCommit({ token, owner, repo, fetchImpl = fetch }) {
  const base = `${API}/repos/${owner}/${repo}/actions`;
  const ordered = await deployRunsByActivity(base, { token, fetchImpl });

  let best = null;
  for (const run of ordered) {
    // Nothing in a run last active before the upload already found can have
    // completed after it, so its jobs are not read.
    const activity = lastActivity(run);
    if (best && Number.isFinite(activity) && activity < best.at) continue;
    const jobsBody = await ghJson(fetchImpl, `${base}/runs/${run.id}/jobs?filter=all&per_page=100`, token);
    if (!Array.isArray(jobsBody?.jobs)) {
      throw new Error(`GitHub returned a jobs payload without a \`jobs\` array for run ${run.id}.`);
    }
    best = newestUpload(run, jobsBody.jobs, best);
  }
  if (!best) return null;
  return { sha: best.sha, runNumber: best.runNumber, completedAt: best.completedAt };
}

/**
 * The deploy runs to look in: up to MAX_PAGES pages of MAX_RUNS, and the
 * newest run that succeeded outright, once each, most recent activity first.
 */
async function deployRunsByActivity(base, { token, fetchImpl }) {
  const runsUrl = `${base}/workflows/${DEPLOY_WORKFLOW}/runs`;
  const succeeded = runsOf(await ghJson(fetchImpl, `${runsUrl}?status=success&per_page=1`, token));
  const listed = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = runsOf(await ghJson(fetchImpl, `${runsUrl}?per_page=${MAX_RUNS}&page=${page}`, token));
    listed.push(...batch.slice(0, MAX_RUNS));
    if (batch.length < MAX_RUNS) break;
  }

  const candidates = new Map();
  for (const run of [...listed, ...succeeded.slice(0, 1)]) {
    if (typeof run?.id !== 'number' || typeof run.head_sha !== 'string' || !run.head_sha) {
      throw new Error('A deploy run came back without an id or a head_sha, so nothing can be compared.');
    }
    candidates.set(run.id, run);
  }
  // Most recent activity first. A run with no readable time goes last and is
  // always read, since nothing bounds when its steps completed.
  return [...candidates.values()].sort(byActivityNewestFirst);
}

function byActivityNewestFirst(a, b) {
  const x = lastActivity(a);
  const y = lastActivity(b);
  if (!Number.isFinite(x)) return Number.isFinite(y) ? 1 : 0;
  if (!Number.isFinite(y)) return -1;
  return y - x;
}

/** The newest successful DEPLOY_STEP among a run's jobs and the one found so far (`best`, or null). */
function newestUpload(run, jobs, best) {
  let newest = best;
  for (const job of jobs) {
    for (const step of job?.steps ?? []) {
      const at = step?.name === DEPLOY_STEP && step.conclusion === 'success' ? Date.parse(step.completed_at) : NaN;
      if (Number.isFinite(at) && (!newest || at > newest.at)) {
        newest = { at, sha: run.head_sha, runNumber: run.run_number ?? null, completedAt: step.completed_at };
      }
    }
  }
  return newest;
}

/** The inventory's text at a commit, or null when the file did not exist there. */
export async function fetchInventoryAt({ token, owner, repo, sha, fetchImpl = fetch }) {
  const url = `${API}/repos/${owner}/${repo}/contents/${INVENTORY_PATH}?ref=${encodeURIComponent(sha)}`;
  const res = await ghFetch(fetchImpl, url, token, 'application/vnd.github.raw+json');
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${url}`);
  return res.text();
}
