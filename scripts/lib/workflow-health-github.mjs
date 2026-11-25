/** Reading workflows and their runs from the GitHub API, and saying why a read was refused (check-workflow-health.mjs). */
import { DEFAULT_SAMPLE, DEFAULT_STALE_DAYS, hasScheduleTrigger, MAX_PER_PAGE } from './workflow-health-assess.mjs';

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

/** Print why the check cannot answer, and end with exit 2: nothing was asserted. */
export function stop(...lines) {
  for (const line of lines) console.error(line);
  process.exit(2);
}

/** `api(path)`, or stop with `why(err)` and the lines after it when it throws. */
export async function readOrStop(path, token, why, ...after) {
  try {
    return await api(path, token);
  } catch (err) {
    return stop(why(err), ...after);
  }
}

/**
 * Which of those files are on the default branch today (#1564). One read of
 * the repository for the branch's name, one of the directory on it; the
 * header says why the workflow listing alone cannot answer this. Both fail
 * closed, like the listing: an unreadable tree is not an empty one.
 */
export async function readDefaultBranchTree(repo, token) {
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
    stop(`Could not read the workflow files on the default branch: ${err.message}`, 'Nothing was asserted either way.');
  }
  const treeWrong = treeRefusal(tree, defaultBranch);
  if (treeWrong) stop(treeWrong);
  return { defaultBranch, tree };
}

/** One workflow's mixed sample of runs and its scheduled runs, each checked by `runsRefusal`. */
export async function readWorkflowRuns(w, { repo, token, sample }) {
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
  const got = await readOrStop(
    `/repos/${repo}/actions/workflows/${w.id}/runs?per_page=${sample}`,
    token,
    (err) => `Could not read runs for ${w.path}: ${err.message}`
  );

  // Shape and filter, both fail-closed, both testable. See runsRefusal.
  const runsWrong = runsRefusal(got, w);
  if (runsWrong) stop(runsWrong);

  // The runs the workflow's own schedule started, for the `failing` verdict
  // (#1661). A second request because the mixed sample above can hold none
  // of them (see the header); `event=schedule` is a documented filter of this
  // endpoint (https://docs.github.com/rest/actions/workflow-runs), and the
  // refusal below checks it held on every row. A workflow with no schedule
  // answers an empty list, which is never `failing`.
  const scheduled = await readOrStop(
    `/repos/${repo}/actions/workflows/${w.id}/runs?event=schedule&per_page=${sample}`,
    token,
    (err) => `Could not read scheduled runs for ${w.path}: ${err.message}`
  );
  const scheduledWrong = runsRefusal(scheduled, w, { event: 'schedule' });
  if (scheduledWrong) stop(scheduledWrong);

  return {
    id: w.id,
    path: w.path,
    state: w.state,
    runs: got.workflow_runs,
    scheduledRuns: scheduled.workflow_runs,
  };
}

/**
 * For a workflow that would be `failing`, two more reads, onto `workflow`:
 *   1. Its newest success on the default branch, wherever it sits in time.
 *      The mixed sample holds only the newest few runs, so a run started by
 *      hand that fixed the workflow can fall out of it behind later runs and
 *      the finding would never clear (Copilot review of #1668).
 *   2. Whether its file on the default branch still has a schedule.
 * Both fail closed like every read before them.
 */
export async function readFailingDetails(workflow, path, { repo, token, defaultBranch }) {
  try {
    const passed = await api(
      `/repos/${repo}/actions/workflows/${workflow.id}/runs?branch=${encodeURIComponent(defaultBranch)}&status=success&per_page=1`,
      token
    );
    const passedWrong = runsRefusal(passed, workflow);
    if (passedWrong) throw new Error(passedWrong);
    workflow.defaultBranchSuccesses = passed.workflow_runs;
    const file = await api(
      `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(defaultBranch)}`,
      token
    );
    if (typeof file?.content !== 'string') throw new Error('the file payload carried no `content`');
    workflow.hasSchedule = hasScheduleTrigger(Buffer.from(file.content, 'base64').toString('utf8'));
  } catch (err) {
    stop(`Could not read ${path} on ${defaultBranch}: ${err.message}`, 'Nothing was asserted either way.');
  }
}
