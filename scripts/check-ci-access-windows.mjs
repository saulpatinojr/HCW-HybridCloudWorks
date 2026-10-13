/**
 * Is a per-run `ci-*` access window on the Function App left open by a run
 * that died? (#1050)
 *
 * ## Why
 *
 * Two workflows open a one-host Allow rule on `func-site-prod-cus-01` for
 * their runner and close it in an `always()` step:
 *
 *   - `deploy-functions.yml`: `ci-deploy-scm-<run id>` on the SCM site, for
 *     the package upload, and `ci-smoke-<run id>` on the site, for the smoke
 *     requests;
 *   - `publish-content-manifest.yml`: `ci-manifest-<run id>` on the site.
 *
 * An `always()` step does not run on runner loss, an infrastructure failure
 * or a force-cancel, so a window can outlive its run.
 * `scripts/assert-origin-lock.mjs` accepts any single-host `ci-*` rule,
 * because a concurrent run may legitimately hold one. That means it cannot
 * tell a live window from an orphan. CodeRabbit raised it on #1049 (PLAT-2).
 *
 * ## What it reads
 *
 * The JSON of `az functionapp config access-restriction show` on stdin, both
 * lists: `ipSecurityRestrictions` (the site) and `scmIpSecurityRestrictions`
 * (the SCM site). Azure returns both on every read, the SCM list holding at
 * least its deny-all (read 2026-10-12), so a document without either is
 * unreadable, never "no windows": an absent SCM list must not pass as a
 * checked SCM site (CodeRabbit, #1097). The run id of a `ci-*` rule is the
 * digits its name ends in, or failing that, a run id in its description, and
 * each run is read from the Actions API of `GITHUB_REPOSITORY`. A window is
 * live while its run has not completed (queued, waiting, pending, requested
 * or in progress). It is orphaned once the run has completed or no longer
 * exists, and so is a `ci-*` rule that names no run, which no run could ever
 * close on purpose.
 *
 * This only reads. Removing an orphan stays a person's decision, made after
 * reading the rule and the run again: a re-run of a run keeps its id and
 * opens the same window. The monitor's Azure identity (`github_reader`) held a
 * write on the site's config until #1098, because `publish-content-manifest.yml`
 * used it to open its own window (`infra/oidc.tf`, T-718). That window has an
 * identity of its own now, and the reader writes nothing. The monitor reads twice, a minute
 * apart, before it names an orphan, so a run that closes its window while the
 * check runs is not reported.
 *
 * ## Usage
 *
 *     az functionapp config access-restriction show -n APP -g RG -o json \
 *       | GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo \
 *         node scripts/check-ci-access-windows.mjs
 *
 * Prints the table cell on the first line, then one line per orphan. Exit 0
 * when none is orphaned, 1 when any is (each named), 2 when the check could
 * not run.
 */
import { pathToFileURL } from 'node:url';

const API = 'https://api.github.com';

/** The prefix every workflow's per-run window is named with. */
export const CI_PREFIX = 'ci-';

/** Run statuses under which the run can still close its own window. */
export const LIVE_STATUSES = Object.freeze(['queued', 'in_progress', 'waiting', 'pending', 'requested']);

/** The two lists `access-restriction show` returns, and which site each guards. */
const LISTS = Object.freeze([
  ['ipSecurityRestrictions', 'site'],
  ['scmIpSecurityRestrictions', 'SCM site'],
]);

/**
 * The run a `ci-*` rule belongs to: the digits its name ends in, or failing
 * that, a run id its description carries (`run 123…`, or a run URL). Null when
 * it names none.
 */
export function runIdOf(rule) {
  const fromName = /-(\d+)$/.exec(String(rule?.name ?? ''))?.[1];
  if (fromName) return fromName;
  const description = String(rule?.description ?? '');
  return /(?:actions\/runs\/|\brun[ #:-]*)(\d+)/i.exec(description)?.[1] ?? null;
}

/**
 * The `ci-*` rules in an `access-restriction show` document, with the site
 * each guards and the run it belongs to (null when it names none).
 *
 * @param {string} text the JSON on stdin
 * @returns {Array<{ name: string, site: string, runId: string|null }>}
 * @throws {Error} when the text is not that document, including one without
 *   both lists
 */
export function parseWindows(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('the input is not JSON. Expected `az functionapp config access-restriction show -o json`.');
  }
  if (!doc || typeof doc !== 'object') {
    throw new Error('the input is not an object. Expected `az functionapp config access-restriction show -o json`.');
  }
  for (const [list] of LISTS) {
    if (!Array.isArray(doc[list])) {
      throw new Error(
        `the input has no \`${list}\` list, so that site's rules were not read. ` +
          'Expected `az functionapp config access-restriction show -o json`, which returns both lists.'
      );
    }
  }
  const windows = [];
  for (const [list, site] of LISTS) {
    for (const rule of doc[list]) {
      const name = String(rule?.name ?? '');
      if (!name.startsWith(CI_PREFIX)) continue;
      windows.push({ name, site, runId: runIdOf(rule) });
    }
  }
  return windows;
}

/**
 * The run behind a window, as the Actions API reports it: its status and
 * conclusion, or `missing` when GitHub has no such run.
 *
 * @returns {Promise<{ status: string, conclusion: string|null, url: string|null }>}
 * @throws {Error} on any answer but 200 or 404
 */
export async function readRun({ runId, token, owner, repo, fetchImpl = fetch }) {
  const url = `${API}/repos/${owner}/${repo}/actions/runs/${runId}`;
  const res = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (res.status === 404) return { status: 'missing', conclusion: null, url: null };
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${url}`);
  const run = await res.json();
  return { status: String(run?.status ?? ''), conclusion: run?.conclusion ?? null, url: run?.html_url ?? null };
}

/** Why a window is orphaned, in one clause, or null while its run is live. */
export function orphanReason(window, run) {
  if (window.runId === null) return 'it names no run, in its name or its description, so no run can close it';
  if (run.status === 'missing') return `run ${window.runId} does not exist in this repository`;
  if (LIVE_STATUSES.includes(run.status)) return null;
  const outcome = run.conclusion ? `, ${run.conclusion}` : '';
  return `run ${window.runId} has ended (${run.status}${outcome})`;
}

/**
 * One shell word: bare when it holds only characters no shell treats
 * specially, single-quoted otherwise. A rule name is Azure's to constrain, not
 * this script's, so the command it prints does not rely on that (CodeRabbit,
 * #1097).
 */
export function shellWord(value) {
  const text = String(value);
  return /^[A-Za-z0-9._/-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * Markdown inline code that no backtick run in the text can end early: the
 * delimiter is one backtick longer than the longest run inside, padded with a
 * space when the text holds any (CommonMark, code spans).
 */
export function codeSpan(value) {
  const text = String(value);
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  if (longest === 0) return `\`${text}\``;
  const fence = '`'.repeat(longest + 1);
  return `${fence} ${text} ${fence}`;
}

/** A rule name for a table cell: no pipe to split the row, no backtick to open code. */
const cellText = (value) => String(value).replaceAll('|', '\\|').replaceAll('`', "'");

/**
 * The command that removes an orphan, ready to paste, when the app and its
 * resource group are known (`APP` and `RG`, as the monitor step sets them).
 */
export function removeCommand(orphan, { app, resourceGroup } = {}) {
  if (!app || !resourceGroup) return null;
  const scm = orphan.site === 'SCM site' ? ' --scm-site true' : '';
  return (
    `az functionapp config access-restriction remove -n ${shellWord(app)} -g ${shellWord(resourceGroup)}` +
    ` --rule-name ${shellWord(orphan.name)}${scm}`
  );
}

/** The verdict when the check itself could not run. */
export function formatUnreadable(reason) {
  return {
    code: 2,
    lines: ['unreadable', `This check could not run, which says nothing about the access windows: ${reason}`],
  };
}

/**
 * Everything but the process: stdin text, environment and fetch in, exit
 * code and stdout lines out.
 */
export async function run({ input = '', env = {}, fetchImpl = fetch }) {
  let windows;
  try {
    windows = parseWindows(input);
  } catch (error) {
    return formatUnreadable(error.message);
  }
  if (windows.length === 0) return { code: 0, lines: ['none open'] };

  const token = env.GITHUB_TOKEN;
  const [owner, repo] = String(env.GITHUB_REPOSITORY ?? '').split('/');
  if (!token || !owner || !repo) {
    return formatUnreadable('it needs GITHUB_TOKEN and GITHUB_REPOSITORY (owner/repo) to read the runs.');
  }

  const orphans = [];
  for (const window of windows) {
    let runInfo = { status: 'unknown', conclusion: null, url: null };
    if (window.runId !== null) {
      try {
        runInfo = await readRun({ runId: window.runId, token, owner, repo, fetchImpl });
      } catch (error) {
        return formatUnreadable(`the run behind \`${window.name}\` could not be read: ${error.message}`);
      }
    }
    const reason = orphanReason(window, runInfo);
    if (reason) orphans.push({ ...window, reason, url: runInfo.url });
  }

  if (orphans.length === 0) {
    return { code: 0, lines: [`none orphaned (${windows.length} open, each held by a run in progress)`] };
  }
  const target = { app: env.APP, resourceGroup: env.RG };
  return {
    code: 1,
    lines: [
      `${orphans.length} orphaned: ${orphans.map((o) => cellText(o.name)).join(', ')}`,
      ...orphans.map((o) => {
        const command = removeCommand(o, target);
        // A re-run keeps its run id and reopens the same window, so this is a
        // report, not a standing licence to delete (CodeRabbit, #1097).
        const remove = command
          ? ` If the rule is still there and its run has not been re-run, remove it: ${codeSpan(command)}`
          : '';
        return `- ${codeSpan(o.name)} on the ${o.site}: ${o.reason}${o.url ? ` (${o.url})` : ''}.${remove}`;
      }),
    ],
  };
}

/** All of stdin, as text. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  readStdin()
    .then((input) => run({ input, env: process.env }))
    .then(({ code, lines }) => {
      process.stdout.write(`${lines.join('\n')}\n`);
      process.exitCode = code;
    })
    .catch((error) => {
      process.stdout.write(`${formatUnreadable(error?.message || String(error)).lines.join('\n')}\n`);
      process.exitCode = 2;
    });
}
