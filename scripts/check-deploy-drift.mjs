/**
 * How long production has been behind `main`, per deployed service.
 *
 * ## The gap this closes
 *
 * `deploy-functions.yml` and `deploy-azure-frontend.yml` are both
 * workflow_dispatch only, by a recorded decision: enabling a workflow and
 * enabling auto-deploy-on-merge are separate choices, and only the first was
 * made. Merging therefore deploys nothing, and NOTHING SAID SO.
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
 * hours tolerates the normal merge-then-deploy gap — which is the whole point of
 * dispatch-only releases — and still catches a change that was merged and
 * forgotten. So this reports the age of the OLDEST undeployed commit touching a
 * service's own paths, and fails past a threshold.
 *
 * ## Paths, not commits
 *
 * A service is only "behind" when something it ships has changed. Thirty commits
 * touching only `docs/` leave the Function App exactly as correct as it was.
 * Each service therefore declares the paths it deploys, and drift is measured
 * over commits touching those.
 *
 * ## On running this from a schedule GitHub delivers unreliably
 *
 * `monitor-functions-registered.yml` is documented as hourly and is delivered
 * about 22% of the time, a median 36 minutes late, with a 12.7-hour worst-case
 * gap (measured 2026-08-31). That is a real problem for an outage detector and
 * is NOT one here: this watches a condition measured in days, against a
 * threshold measured in hours. A check that lands every 4.6 hours on average is
 * ample for a 24-hour threshold, and saying so is better than pretending the
 * cron is honoured.
 */
import { pathToFileURL } from 'node:url';

const API = 'https://api.github.com';

/**
 * What each deployable service is, and what it ships.
 *
 * `paths` are prefixes matched against the repository-relative paths the GitHub
 * commits API is filtered by. Adding a service here is the only change a new
 * deploy target needs.
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
    workflow: 'tfc-plan-check.yml',
    paths: Object.freeze(['infra', 'cosmos-containers.json']),
  }),
]);

/** Hours of drift tolerated before this is called stale. */
export const DEFAULT_THRESHOLD_HOURS = 24;

/** GitHub's maximum page size for the commits API. */
export const COMMITS_PER_PAGE = 100;

/**
 * A ceiling on pagination, so an unexpected answer cannot loop against the API
 * forever. Ten pages is 1,000 commits since the last deploy — far past any
 * drift worth measuring rather than simply deploying.
 */
export const MAX_COMMIT_PAGES = 10;

/**
 * The last run of a workflow that actually deployed.
 *
 * Throws on a shape it cannot read rather than returning null, following
 * check-unresolved-secrets.mjs: "this service has never deployed" and "I could
 * not read the answer" are different facts, and reporting the second as the
 * first would announce drift against a baseline that does not exist.
 *
 * A workflow with no successful run at all returns null, which IS the first
 * fact and is reported as its own case.
 */
export function parseLastSuccessfulRun(body) {
  const runs = body?.workflow_runs;
  if (!Array.isArray(runs)) {
    throw new Error(
      'GitHub returned a workflow-runs payload without a `workflow_runs` array. Expected the ' +
        'response of GET /repos/:owner/:repo/actions/workflows/:file/runs.'
    );
  }
  if (runs.length === 0) return null;

  const [run] = runs;
  if (typeof run.head_sha !== 'string' || !run.head_sha) {
    throw new Error('A workflow run came back with no `head_sha`, so nothing can be compared.');
  }
  return { sha: run.head_sha, runNumber: run.run_number ?? null, at: run.created_at ?? null };
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
 * `>=` rather than `>`: a threshold of 24 should fire at 24 hours, not at 25.
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
    if (!r.oldest) return `| ${cell(r.name)} | ✅ | up to date |`;
    const stale = isStale(r.hours, thresholdHours);
    return `| ${cell(r.name)} | ${stale ? '❌' : '✅'} | ${r.count} commit(s), oldest ${r.hours}h — ${cell(r.oldest.message)} |`;
  });

  const failed = results.some(
    (r) => r.error || r.neverDeployed || (r.oldest && isStale(r.hours, thresholdHours))
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
        ? '**Deploy the service(s) marked ❌.** Both deploys are dispatch-only by ' +
          'design, so merging does not ship them — this is the thing that says so. ' +
          'A ⚠️ means the check could not read the answer, which is not the same as drift.'
        : 'Every service is within the threshold.',
    ].join('\n'),
  };
}

async function ghJson(fetchImpl, url, token) {
  const res = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${url}`);
  return res.json();
}

/** Drift for one service. Never throws: a failure is reported as its own row. */
export async function driftFor(service, { token, owner, repo, nowMs, fetchImpl = fetch }) {
  try {
    const runs = await ghJson(
      fetchImpl,
      `${API}/repos/${owner}/${repo}/actions/workflows/${service.workflow}/runs?status=success&per_page=1`,
      token
    );
    const last = parseLastSuccessfulRun(runs);
    if (!last) return { name: service.name, neverDeployed: true };

    const deployed = await ghJson(
      fetchImpl,
      `${API}/repos/${owner}/${repo}/commits/${last.sha}`,
      token
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
          token
        );
        // THROWN, not defaulted to []. Silently treating an unreadable payload
        // as an empty page reports the service as up to date — the same
        // healthier-than-reality direction as every other defect found in this
        // file, and the one the whole check exists to avoid. driftFor's catch
        // turns this into a ⚠️ row, which says "could not read" rather than
        // "nothing to deploy". parseLastSuccessfulRun and parseCommitDate above
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
    results.push(await driftFor(service, { token, owner, repo, nowMs }));
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
