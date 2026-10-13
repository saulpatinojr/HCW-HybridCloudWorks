/**
 * open-lab-pin-pr.mjs — one pull request per lab pin set, kept current
 * (estate review 2026-10-06, LAB-3; #949).
 *
 * `lab-pins-upstream.mjs --bump <set>` makes a set's edits and writes the
 * evidence; this commits them to the set's own branch and keeps exactly one
 * open pull request for that branch:
 *
 *   no branch, or no open pull request   push the branch, open the pull request
 *   open, branch holds only bot commits  force-push the new reading (with a
 *                                        lease on the sha read a moment ago) and
 *                                        rewrite the body, unless the tree is
 *                                        already the same, when only the body moves
 *   open, someone else wrote or amended  push nothing; comment the new reading
 *                                        instead, so a person's fix is never lost
 *
 * It stages the set's paths by name and refuses to run when anything outside
 * them has changed: the branch the App pushes is the one thing its write
 * permission reaches. Ready for review, never a draft (.claude/CLAUDE.md), and
 * no auto-merge: each bump is read by a person.
 *
 * The token is a GitHub App installation token (MANIFEST_APP_*), not
 * GITHUB_TOKEN: GitHub does not run workflows for events its own token
 * creates, so a pull request opened with it would never get its required
 * checks (publish-content-manifest.yml has the history).
 *
 * Usage: node scripts/open-lab-pin-pr.mjs --paths <set>
 *        node scripts/open-lab-pin-pr.mjs --set <set> --evidence <file> [--notes <file>]
 *   env: GH_TOKEN (the App token), GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_RUN_ID
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const BOT = { name: 'hcw-manifest[bot]', email: 'hcw-manifest[bot]@users.noreply.github.com' };

const BOOTSTRAP = 'ssh -t hcw-lab "sudo /opt/hcw-src/lab-host/bootstrap.sh"';
const BOOTSTRAP_OK =
  'A good run ends with a `PLAY RECAP` line for `localhost` showing `failed=0` and `unreachable=0`; `changed=` above zero names the tasks the new pins moved.';

/** The three pin sets: their branch, the only paths they may touch, and what a reviewer needs to know. */
export const SETS = {
  host: {
    branch: 'chore/lab-pins-host',
    workflow: '.github/workflows/lab-supply-chain.yml',
    paths: ['lab-host/ansible/group_vars/all.yml'],
    title: 'Lab host: move the pins that are behind upstream, each with its publisher checksum',
    intro:
      'The weekly lab supply-chain run found lab host pins behind their publishers and moved each one whose checksum or digest the publisher served. It edits `lab-host/ansible/group_vars/all.yml` and nothing else.',
    after: [
      '**Read the release notes** of every component above before merging; a Coder, PostgreSQL or Vault move can carry a breaking change the version number does not show.',
      '**containerd carries runc.** A containerd.io or Docker Engine move is the runtime the learners\' containers run under; docs/runbooks/labs-host.md, "Runtime advisories", has the response times.',
      `**Nothing changes on the host until bootstrap.sh runs.** After the merge, PowerShell: \`${BOOTSTRAP}\`. ${BOOTSTRAP_OK} A Docker Engine or containerd move restarts the Docker daemon as the package upgrades, which stops running workspaces and jobs, so run it outside lab hours.`,
    ],
  },
  'image-base': {
    branch: 'chore/lab-pins-image-base',
    workflow: '.github/workflows/lab-supply-chain.yml',
    paths: ['lab-image/versions.env', 'lab-image/Dockerfile', 'lab-image/sandbox-template/Dockerfile'],
    title: 'Lab image: rebuild on the newest base image digest',
    intro:
      "The weekly lab supply-chain run found a newer digest for the lab image's base. The base is pinned by digest on every FROM, so its operating system packages never move on their own; this pull request is how the image is rebuilt on the newest one. It edits `lab-image/versions.env` and the FROM lines that file governs, and nothing else.",
    after: [
      "**This pull request's `Build and smoke` check is the test of the new base:** both targets are built on it and run smoke.sh (which compares the image's Python with `BASE_PYTHON_VERSION`) and the sandbox check. Merge only on green.",
      "**Merging publishes, it does not deploy.** The push to `main` runs publish-lab-image.yml, which builds, smoke-tests, attests and pushes both images, then opens the `chore/lab-pins-image-digests` pull request that pins the new digests where they are consumed. Nothing a learner runs changes until that one merges.",
    ],
  },
  'image-digests': {
    branch: 'chore/lab-pins-image-digests',
    workflow: '.github/workflows/publish-lab-image.yml',
    paths: ['vps-agent/lib/capabilities.js', 'lab-host/coder/templates/hcw-lab/main.tf'],
    title: 'Lab images: pin the digests main just published',
    intro:
      'A publish from `main` pushed and attested new hcw-lab images. They are consumed by digest, never by tag, so this pull request moves the two pins: the job image in `vps-agent/lib/capabilities.js` and the Coder workspace image in `lab-host/coder/templates/hcw-lab/main.tf`. It edits those two files and nothing else.',
    after: [
      `**The host pulls both on its next bootstrap.sh run** (the lab_images role pulls the job image and removes the one it replaced). After the merge, PowerShell: \`${BOOTSTRAP}\`. ${BOOTSTRAP_OK}`,
      "**The same run publishes the Coder templates; there is nothing to paste after it.** The coder role's **Publish the Coder templates with the rotation credential when they changed** publishes every template whose files changed with the host's own credential, before lab_images removes the image the old versions name. Good is that task `changed`, with a line `hcw-coder-automation: published <template> with the rotation credential; active version …` for each template this pin moved. A line saying there is no rotation credential, or that Coder refused it, means it must be seeded again (docs/runbooks/labs-host.md, \"Automatic renewal\"); that happens only after a host rebuild or a leak.",
    ],
  },
};

/**
 * What to do, given the open pull request (if any), the remote branch (if
 * any) and the tree just committed. Pure, so every branch of it is tested.
 */
export function decide({ pull, remote, localTree }) {
  if (pull && remote?.foreignAuthors?.length) return 'comment';
  if (remote && remote.tree === localTree) return pull ? 'refresh' : 'open';
  return pull ? 'push-and-refresh' : 'push-and-open';
}

/** The pull request body: what moved, read from where, and what happens after the merge. */
export function prBody({ set, evidence, notes, runUrl }) {
  const s = SETS[set];
  const out = [
    '## Summary',
    '',
    s.intro,
    '',
    `Opened by \`${s.workflow}\` (run ${runUrl}). One pull request per pin set: while this one is open, each new reading replaces its commit on \`${s.branch}\` and its body, rather than opening another.`,
    '',
    '## Evidence',
    '',
    evidence.trim() || '_No edit; see the notes below._',
    '',
  ];
  if (notes.trim()) out.push('## Not bumped', '', notes.trim(), '');
  out.push('## Before and after merging', '');
  s.after.forEach((line, i) => out.push(`${i + 1}. ${line}`));
  out.push(
    '',
    '## Related issue or decision',
    '',
    'Refs #949 (estate review 2026-10-06, LAB-3).',
    '',
    '## Verification',
    '',
    `- Checks run: \`node scripts/lab-pins-upstream.mjs --bump ${set}\` against each publisher (run ${runUrl}); this pull request's required checks run on the edit.`,
    '- Evidence level: [x] CI'
  );
  return `${out.join('\n')}\n`;
}

// ── git and the GitHub API ─────────────────────────────────────────────────

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function api(token, repo) {
  return async (method, path, body) => {
    const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'HCW-HybridCloudWorks open-lab-pin-pr',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 404 && method === 'GET') return null;
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${await response.text()}`);
    return response.status === 204 ? null : response.json();
  };
}

/**
 * Changed paths in the working tree, from `git status --porcelain`.
 *
 * Each line is a two-character status, one space, then the path; a rename
 * is `R  old -> new`. The status is parsed, not sliced by width: `git()`
 * trims its output, which drops the leading space of the first line (` M
 * lab-host/x` becomes `M lab-host/x`), and a fixed slice then ate the
 * path's first letter. On 2026-10-07 the first digest pull request after
 * #986 refused its own template file as `ab-host/coder/templates/...`.
 */
export function changedPaths(porcelain) {
  return String(porcelain)
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const match = /^\s?[ MADRCUT?!]{1,2}\s(.*)$/.exec(line);
      const path = (match ? match[1] : line).replace(/^"|"$/g, '');
      const arrow = path.indexOf(' -> ');
      return arrow === -1 ? path : path.slice(arrow + 4).replace(/^"|"$/g, '');
    });
}

/**
 * Everyone other than the bot who wrote OR committed a commit on the branch.
 * The committer counts as well as the author: `git commit --amend` of the
 * bot's commit keeps the bot as author and records the person as committer,
 * and that amendment is a person's work this job must not overwrite.
 */
export function foreignIdentities(commits) {
  const emails = (commits ?? []).flatMap((c) => [c.commit?.author?.email, c.commit?.committer?.email]);
  return [...new Set(emails.filter((email) => email && email !== BOT.email))];
}

/** The remote branch, if it exists: its head, its tree, and anyone else's hand in it. */
async function readRemote(call, branchName) {
  const branch = await call('GET', `/branches/${encodeURIComponent(branchName)}`);
  if (!branch) return null;
  const compare = await call('GET', `/compare/main...${encodeURIComponent(branchName)}`);
  return { sha: branch.commit.sha, tree: branch.commit.commit.tree.sha, foreignAuthors: foreignIdentities(compare?.commits) };
}

/** The set's edits, staged by name and committed on its branch; refuses anything else in the checkout. */
function commitSet(set, s, runUrl) {
  const changed = changedPaths(git('status', '--porcelain', '--untracked-files=all'));
  const outside = changed.filter((p) => !s.paths.includes(p));
  if (outside.length) throw new Error(`Refusing: paths outside the ${set} set changed: ${outside.join(', ')}`);
  if (changed.length === 0) return null;
  git('config', 'user.name', BOT.name);
  git('config', 'user.email', BOT.email);
  git('checkout', '-B', s.branch);
  git('add', '--', ...s.paths);
  git('commit', '-m', s.title, '-m', `Read from each publisher by node scripts/lab-pins-upstream.mjs --bump ${set} (${runUrl}). Refs #949.`);
  return git('rev-parse', 'HEAD^{tree}');
}

/** Carry out decide()'s answer: comment, or push (with a lease) and open or refresh the pull request. */
async function act({ action, call, s, pull, remote, body, token, repo }) {
  if (action === 'comment') {
    await call('POST', `/issues/${pull.number}/comments`, {
      body: `A newer reading, not pushed: \`${s.branch}\` holds commits from ${remote.foreignAuthors.join(', ')}, and this job never overwrites them. Apply it by hand, or close this pull request so next week's run opens a fresh one.\n\n${body}`,
    });
    return `commented the new reading on #${pull.number}; the branch has someone else's commits`;
  }
  if (action.startsWith('push')) {
    git('remote', 'set-url', 'origin', `https://x-access-token:${token}@github.com/${repo}.git`);
    git('push', `--force-with-lease=refs/heads/${s.branch}:${remote?.sha ?? ''}`, 'origin', `HEAD:refs/heads/${s.branch}`);
  }
  if (action.endsWith('refresh')) {
    await call('PATCH', `/pulls/${pull.number}`, { title: s.title, body });
    return `updated #${pull.number} (${action})`;
  }
  const created = await call('POST', '/pulls', { title: s.title, head: s.branch, base: 'main', body, draft: false });
  return `opened #${created.number}`;
}

async function propose(flag) {
  const set = flag('--set');
  const s = SETS[set];
  if (!s) throw new Error(`--set takes one of ${Object.keys(SETS).join(', ')}`);
  const token = process.env.GH_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) throw new Error('GH_TOKEN (the App installation token) and GITHUB_REPOSITORY must be set.');
  const runUrl = `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const read = (path) => (path && existsSync(path) ? readFileSync(path, 'utf8') : '');

  const localTree = commitSet(set, s, runUrl);
  if (!localTree) {
    console.log(`No ${set} pin moved; nothing to propose.`);
    return;
  }
  const call = api(token, repo);
  const pulls = await call('GET', `/pulls?state=open&head=${encodeURIComponent(`${repo.split('/')[0]}:${s.branch}`)}`);
  const pull = pulls?.[0] ?? null;
  const remote = await readRemote(call, s.branch);
  const action = decide({ pull, remote, localTree });
  const body = prBody({ set, evidence: read(flag('--evidence')), notes: read(flag('--notes')), runUrl });
  console.log(`${set}: ${await act({ action, call, s, pull, remote, body, token, repo })}.`);
}

async function main(argv) {
  const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  const listSet = flag('--paths');
  if (listSet) {
    if (!SETS[listSet]) throw new Error(`--paths takes one of ${Object.keys(SETS).join(', ')}`);
    process.stdout.write(`${SETS[listSet].paths.join('\n')}\n`);
    return;
  }
  await propose(flag);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 2;
  });
}
