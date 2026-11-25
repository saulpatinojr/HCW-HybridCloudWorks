/** Each service's baseline (the commit it was last deployed from) and how old the oldest change since then is (check-deploy-drift.mjs). */
import { MAX_RUN_PAGES, RUNS_PER_PAGE } from './deploy-drift-settings.mjs';
import { indexIncluded, ingressCommitFor } from './tfc-run-select.mjs';
import { ORGANIZATION, WORKSPACE } from '../tfc-workspace-busy.mjs';

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
