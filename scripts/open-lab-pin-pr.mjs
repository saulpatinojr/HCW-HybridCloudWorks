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

/** The pin sets, and the Cloudflare ranges set (PLAT-10, #970): their branch, the only paths they may touch, and what a reviewer needs to know. */
export const SETS = {
  host: {
    branch: 'chore/lab-pins-host',
    workflow: '.github/workflows/lab-supply-chain.yml',
    paths: [
      'lab-host/ansible/group_vars/all.yml',
      'lab-host/bootstrap.sh',
      'lab-host/ansible/roles/caddy/tests/caddy-adapt.test.sh',
      'scripts/fixtures/docker-cli-agent-requests.json',
    ],
    title: 'Lab host: move the pins that are behind upstream, each with its publisher checksum',
    intro:
      'The weekly lab supply-chain run found lab host pins behind their publishers and moved each one whose checksum or digest the publisher served. It edits `lab-host/ansible/group_vars/all.yml`, and with it the files held to those pins when they moved: `COSIGN_VERSION` and `COSIGN_SHA256` in `lab-host/bootstrap.sh` (the checksum from cosign\'s own checksums file), `CADDY_SHA512` in the caddy test (the release tarball\'s SHA512 from the publisher\'s checksums file) and the Docker CLI request fixture, re-recorded with the pinned docker-ce-cli installed from Docker\'s signed apt index. Nothing else.',
    after: [
      '**Read the release notes** of every component above before merging; a Coder, PostgreSQL or Vault move can carry a breaking change the version number does not show.',
      '**containerd carries runc.** A containerd.io or Docker Engine move is the runtime the learners\' containers run under; docs/runbooks/labs-host.md, "Runtime advisories", has the response times.',
      `**Nothing changes on the host until bootstrap.sh runs.** After the merge, PowerShell: \`${BOOTSTRAP}\`. ${BOOTSTRAP_OK} A Docker Engine or containerd move restarts the Docker daemon as the package upgrades, which stops running workspaces and jobs, so run it outside lab hours.`,
    ],
    scope: [
      '**Components:** `lab-host/ansible/group_vars/all.yml`, the pins the Ansible roles install on the lab host; with a cosign move, `COSIGN_VERSION` and `COSIGN_SHA256` in `lab-host/bootstrap.sh`; with a Caddy move, `CADDY_SHA512` in `lab-host/ansible/roles/caddy/tests/caddy-adapt.test.sh`; with a Docker Engine move, `scripts/fixtures/docker-cli-agent-requests.json`, re-recorded with the pinned docker-ce-cli verified through Docker\'s signed apt index (`recordedFrom` names the .deb).',
      '**Data:** a Vault or PostgreSQL move within its release line keeps its storage format; read the release notes for anything else. `sudo /usr/local/sbin/coder-postgres-backup` before the host run is the restore point for the Coder database (docs/runbooks/labs-host.md).',
      '**Rollback:** revert this pull request and run `bootstrap.sh` again; the roles install the pinned versions and apt\'s held packages move back with them.',
    ],
    infrastructure: true,
    planNote:
      'no plan or preview exists for an Ansible pin move. The review is the evidence tables above, by a person, and the host run after the merge, which the owner watches; the roles install exactly the versions pinned here.',
  },
  'image-base': {
    branch: 'chore/lab-pins-image-base',
    workflow: '.github/workflows/lab-supply-chain.yml',
    paths: [
      'lab-image/versions.env',
      'lab-image/Dockerfile',
      'lab-image/sandbox-template/Dockerfile',
      'frontend/src/pages/docker/BuildingImagesPage.jsx',
    ],
    title: 'Lab image: rebuild on the newest base image digest and ansible-core patch release',
    intro:
      "The weekly lab supply-chain run found a newer digest for the lab image's base, or a newer ansible-core release in its line, or both. The base is pinned by digest on every FROM, so its operating system packages never move on their own; this pull request is how the image is rebuilt on the newest one. It edits `lab-image/versions.env`, the FROM lines that file governs and, when the tag moved, the base tag and CPython release the Docker guide page names (`frontend/src/pages/docker/BuildingImagesPage.jsx`, which `DockerGuides.test.jsx` holds to versions.env). An ansible-core move edits `ANSIBLE_CORE_VERSION` and `ANSIBLE_CORE_SHA256` (the wheel's SHA256 from PyPI's JSON API), and a line of `ANSIBLE_CORE_DEPS` only when the new release pins that dependency exactly; every `ANSIBLE_CORE_DEPS` hash is read back from PyPI either way. Nothing else.",
    after: [
      "**This pull request's `Build and smoke` check is the test of the new base and the new ansible-core:** both targets are built on them and run smoke.sh (which compares the image's Python with `BASE_PYTHON_VERSION` and its ansible-core with `ANSIBLE_CORE_VERSION`) and the sandbox check. Merge only on green.",
      "**Merging publishes, it does not deploy.** The push to `main` runs publish-lab-image.yml, which builds, smoke-tests, attests and pushes both images, then opens the `chore/lab-pins-image-digests` pull request that pins the new digests where they are consumed. Nothing a learner runs changes until that one merges.",
      `**An ansible-core move reaches the lab host too.** \`lab-host/bootstrap.sh\` installs the host's ansible-core from these same \`versions.env\` lines, hash-checked, so the host moves on the next run after the merge. PowerShell: \`${BOOTSTRAP}\`. ${BOOTSTRAP_OK} Before the play it prints \`ansible-playbook [core <the new release>]\`. The \`ansible-lint (lab-host)\` job in \`.github/workflows/ci.yml\` pins its own ansible-core, and this pull request does not move it.`,
    ],
    scope: [
      '**Components:** `lab-image/versions.env` (`BASE_IMAGE`, `BASE_DIGEST`, `BASE_PYTHON_VERSION`, the sandbox pair, or the `ANSIBLE_CORE_*` lines), the FROM lines of `lab-image/Dockerfile` and `lab-image/sandbox-template/Dockerfile` that file governs, and the base tag, CPython release and `CHECKED_ON` the Docker guide page names (`frontend/src/pages/docker/BuildingImagesPage.jsx`). The `ANSIBLE_CORE_*` lines are also what `lab-host/bootstrap.sh` installs on the lab host.',
      '**Rollback:** revert this pull request; the consumers keep the digests they pin until a later `chore/lab-pins-image-digests` pull request moves them, so nothing a learner runs changes on a revert. An ansible-core move that already reached the host goes back with the next `bootstrap.sh` run after the revert.',
    ],
    infrastructure: false,
  },
  'image-tools': {
    branch: 'chore/lab-pins-image-tools',
    workflow: '.github/workflows/lab-supply-chain.yml',
    paths: ['lab-image/versions.env', 'lab-image/README.md'],
    title: 'Lab image: move tools, providers and Azure CLI pins, each with its publisher checksum',
    intro:
      "The weekly lab supply-chain run found newer upstream versions for the lab image's tools, Terraform providers, or the Azure CLI. It edits `lab-image/versions.env` and `lab-image/README.md` (which documents the provider mirror and tools), each with its publisher checksum or apt index hash. Nothing else.",
    after: [
      "**This pull request's `Build and smoke` check tests the new tools and providers:** the image builds with them, validates the provider mirror, and runs the smoke tests. Merge only on green.",
      "**Merging publishes, it does not deploy.** The push to `main` runs publish-lab-image.yml, which builds, smoke-tests, attests and pushes both images, then opens the `chore/lab-pins-image-digests` pull request that pins the new digests where they are consumed.",
    ],
    scope: [
      "**Components:** `lab-image/versions.env` (tools: Terraform, kubeconform, Helm, kubectl, Azure CLI; providers: azurerm, azapi, alz, random, modtm, time) and `lab-image/README.md`.",
      "**Rollback:** revert this pull request; the consumers keep the digests they pin until a later `chore/lab-pins-image-digests` pull request moves them.",
    ],
    infrastructure: false,
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
    scope: [
      '**Components:** the job image pin in `vps-agent/lib/capabilities.js` and the Coder workspace image pin in `lab-host/coder/templates/hcw-lab/main.tf`, both by digest.',
      '**Rollback:** revert this pull request and run `bootstrap.sh` again; the host pulls the digests the revert names and removes the ones it replaced.',
    ],
    infrastructure: true,
    planNote:
      'this digest-only update of the two consumers creates no Terraform or Coder plan or preview. The review is the publisher evidence above and the exact two-line diff, by a person; the next `bootstrap.sh` run is the post-merge operational check.',
  },
  'cloudflare-ranges': {
    branch: 'chore/cloudflare-ranges',
    workflow: '.github/workflows/cloudflare-ranges.yml',
    paths: ['infra/variables.tf'],
    title: 'Origin lock: move cloudflare_ip_ranges to the list Cloudflare publishes',
    intro:
      "The weekly Cloudflare ranges run (scripts/cloudflare-ranges.mjs, PLAT-10 #970) found that the IPv4 ranges Cloudflare publishes at https://api.cloudflare.com/client/v4/ips differ from the default of `cloudflare_ip_ranges` in `infra/variables.tf`, the list the origin lock in `infra/functionapp.tf` admits. This pull request rewrites that default to the published list, in Cloudflare's order. The evidence below names every range that moved and what it means at the origin.",
    after: [
      "**Apply before the next deploy.** The change is one Allow rule added or removed per range on the Function App, applied by the owner's HCP Terraform run at https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs. `scripts/assert-origin-lock.mjs` holds every deploy to the list in the checkout it runs from, so a merged move that has not been applied fails the next deploy by design: merge, apply, then deploy.",
      '**A range Cloudflare added is a 403 until the apply.** Visitors routed through a new Cloudflare edge are refused at the origin until its rule exists, which is why this pull request exists and why it should not stay open.',
    ],
    scope: [
      '**Components:** the default of `cloudflare_ip_ranges` in `infra/variables.tf`, read by `infra/functionapp.tf` (one `ip_restriction` per range) and by `scripts/assert-origin-lock.mjs` after every deploy.',
      '**Rollback:** revert this pull request and apply again; the previous rules return. Nothing else reads the list.',
    ],
    infrastructure: true,
    planNote:
      'the HCP Terraform plan for the apply is the review of the infrastructure change: one `ip_restriction` added or removed per range named in the evidence, and nothing else. `tfc-plan-check.yml` reads it against the declared permanent diff.',
    body: (runUrl) => ({
      refs: 'Refs #970 (PLAT-10, estate review 2026-10-06); the set was added by #1179.',
      dependencyUpdate: false,
      checksRun: `\`node scripts/cloudflare-ranges.mjs --bump\` against https://api.cloudflare.com/client/v4/ips (run ${runUrl}); this pull request's required checks run on the edit, and \`fmt, validate, tflint\` reads the new default.`,
      evidenceNote: 'the table above: the published list, its etag and every range that moved, read from Cloudflare at the URL beside it.',
      notRun: "the HCP Terraform apply, which is the owner's run after the merge (above), and the deploy that follows it, whose `assert-origin-lock.mjs` step holds the live rules to this list.",
      rolloutDoc:
        'Scope and impact above; the apply at https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs, then `scripts/assert-origin-lock.mjs` on the next deploy, which holds the live rules to the new list.',
      authNote:
        'The origin lock is an allowlist; this moves its entries to the published ones and nothing else, and `assert-origin-lock.mjs` denies a deploy whose live rules differ from the list.',
      pinnedNote: 'No dependency moves; the values are IPv4 ranges, each validated as a CIDR and rebuilt from its parsed parts by `scripts/cloudflare-ranges.mjs` before the file is written.',
      approvalNote:
        "this pull request is filed by the scheduled workflow, as the lab pin sets' are (the arrangement the 2026-10-06 estate review approved for scheduled pin pull requests), extended to this set by #1179. It is never merged, approved or applied by automation; a person reads it and merges it, and the owner applies.",
      docsNote: "None needed; `infra/variables.tf`'s own comment describes the list and `cloudflare-ranges.yml`'s header the procedure.",
      changelogNote: "A range move is not a changelog entry by this repository's convention; the evidence is this body.",
      testsNote: '`scripts/cloudflare-ranges.test.mjs` covers the rewrite and its refusals; this pull request\'s required checks run on the edit.',
      ownersNote: 'The owner applies, then deploys.',
      commitTrailer: `Read from Cloudflare by node scripts/cloudflare-ranges.mjs --bump (${runUrl}). Refs #970.`,
    }),
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

/**
 * What each set's pull request body says in the template's own words. The
 * lab pin sets share these defaults (a pin read from a publisher, rolled out
 * by bootstrap.sh); a set whose change is something else overrides every
 * line that would otherwise claim a publisher checksum, a dependency update
 * or a host run it does not have (CodeRabbit on #1179, the Cloudflare set).
 */
export function bodyTexts(set, runUrl) {
  const s = SETS[set];
  const defaults = {
    refs: 'Refs #949 (estate review 2026-10-06, LAB-3).',
    dependencyUpdate: true,
    checksRun: `\`node scripts/lab-pins-upstream.mjs --bump ${set}\` against each publisher (run ${runUrl}); this pull request's required checks run on the edit.`,
    evidenceNote: 'the tables above, each value read from the publisher at the URL beside it.',
    notRun: 'the host or image run itself, which follows the merge (above).',
    rolloutDoc: 'Scope and impact above; docs/runbooks/labs-host.md, "Runtime advisories".',
    authNote: 'Not applicable to a pin move.',
    pinnedNote: "Every value carries the publisher's checksum or digest, read as the evidence tables say.",
    approvalNote:
      'this pull request is filed by the scheduled workflow, the arrangement #949 approved for these pin sets. It is never merged, approved or applied by automation; a person reads it and merges it, and the owner runs the step after the merge.',
    docsNote: 'None needed; the READMEs describe the bump procedure, not its values.',
    changelogNote: "Pin moves are not changelog entries by this repository's convention; the evidence is this body.",
    testsNote: "This pull request's required checks hold the repository to the moved pins.",
    ownersNote: 'The owner runs the step after the merge.',
    commitTrailer: `Read from each publisher by node scripts/lab-pins-upstream.mjs --bump ${set} (${runUrl}). Refs #949.`,
  };
  const override = typeof s.body === 'function' ? s.body(runUrl) : (s.body ?? {});
  return { ...defaults, ...override };
}

/** The pull request body: what moved, read from where, and what happens after the merge. */
export function prBody({ set, evidence, notes, runUrl }) {
  const s = SETS[set];
  const b = bodyTexts(set, runUrl);
  const out = [
    '## Summary',
    '',
    s.intro,
    '',
    `Opened by \`${s.workflow}\` (run ${runUrl}). One pull request per set: while this one is open, each new reading replaces its commit on \`${s.branch}\` and its body, rather than opening another.`,
    '',
    '## Evidence',
    '',
    evidence.trim() || '_No edit; see the notes below._',
    '',
  ];
  if (notes.trim()) out.push('## Not bumped', '', notes.trim(), '');
  // The rest is .github/pull_request_template.md's sections, in its order,
  // with only the boxes that are true ticked: CodeRabbit's Description check
  // warns on a body that skips them (owner instruction 2026-10-08; #1122).
  out.push(
    '## Related issue or decision',
    '',
    b.refs,
    '',
    '## Type of change',
    '',
    '- [ ] Feature or behavior change',
    '- [ ] Bug fix',
    '- [ ] Refactor or performance improvement',
    '- [ ] Documentation or process change',
    `- [${b.dependencyUpdate ? 'x' : ' '}] Dependency update`,
    '- [ ] CI/CD or repository policy change',
    `- [${s.infrastructure ? 'x' : ' '}] Infrastructure or deployment change`,
    '- [ ] Security or privacy change',
    '- [ ] Breaking change',
    '',
    '## Scope and impact',
    ''
  );
  s.scope.forEach((line) => out.push(`- ${line}`));
  out.push('', '**Before and after merging:**', '');
  s.after.forEach((line, i) => out.push(`${i + 1}. ${line}`));
  out.push(
    '',
    '## Verification',
    '',
    `- Checks run: ${b.checksRun}`,
    `- Important result or evidence: ${b.evidenceNote}`,
    `- Checks not run and why: ${b.notRun}`,
    "- Evidence level: [ ] Static [ ] Local [ ] CI [ ] Staging [ ] Production — none ticked at opening: this pull request's required checks are the evidence, and they had not run when this body was written. Read them on the Checks tab before merging.",
    ''
  );
  if (s.infrastructure) {
    out.push(
      '## Infrastructure changes only',
      '',
      `- [ ] Plan or preview was reviewed; no unexpected destroy/recreate operations exist. *(Not ticked: ${s.planNote})*`,
      '- [x] Resource addresses were not renamed without the required moved-state handling. *(None.)*',
      '- [x] Secrets, state files, saved plans, and real variable values are not included.',
      '- [x] Required tags, policies, networking, backup, identity, and security settings are preserved.',
      `- [x] Rollout, monitoring, rollback, and recovery steps are documented. *(${b.rolloutDoc})*`,
      ''
    );
  }
  out.push(
    '## Security and data review',
    '',
    '- [x] No credentials, private keys, tokens, connection strings, personal data, customer data, or sensitive content was added.',
    '- [x] Telemetry is content-free and uses correlation identifiers rather than paths, query strings, route values, document identifiers, or payloads.',
    `- [x] Authorization, tenant isolation, least privilege, and denial paths were tested where applicable. *(${b.authNote})*`,
    `- [x] New dependencies, base images, and GitHub Actions are pinned or controlled according to repository policy. *(${b.pinnedNote})*`,
    `- [ ] No automated path can activate, approve, sign, file, or make an authoritative write unless explicitly approved. *(Not ticked: ${b.approvalNote})*`,
    '',
    '## Documentation and operations',
    '',
    `- [x] User-facing or developer documentation updated when needed. *(${b.docsNote})*`,
    `- [x] Release notes, changelog, runbook, architecture record, migration notes, or security records updated when needed. *(${b.changelogNote})*`,
    "- [x] Remaining work is recorded in the repository's established tracker. *(The steps after the merge, above.)*",
    `- [x] Rollout and rollback owners are identified when the change affects a shared environment. *(${b.ownersNote})*`,
    '',
    '## Author checklist',
    '',
    "- [x] The pull request is focused and unrelated edits were removed. *(The set's paths and nothing else; the opener refuses anything outside them.)*",
    `- [x] Tests cover changed behavior and important failure, boundary, and denial paths. *(${b.testsNote})*`,
    '- [x] The final diff contains no local configuration, generated artifacts, or secrets that do not belong.',
    '- [x] Required reviewers, approvals, environments, and CI checks are complete or explicitly called out. *(Read by a person before merging; no auto-merge.)*'
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
  git('commit', '-m', s.title, '-m', bodyTexts(set, runUrl).commitTrailer);
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
