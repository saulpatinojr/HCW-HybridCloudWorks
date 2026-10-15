/**
 * The lab pin-bump pull requests (#949): what the opener may stage, how it
 * keeps one pull request per set, and what the two workflows that run it may
 * hold. The same tripwires as version-floors-workflow.test.mjs, for the same
 * reason: a job that pushes a branch with an App token must be held to the
 * paths it means to push.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOT, SETS, changedPaths, decide, foreignIdentities, prBody } from './open-lab-pin-pr.mjs';
import {
  CADDY_TEST_PATH,
  CAPABILITIES_PATH,
  CODER_TEMPLATE_PATH,
  DOCKERFILE_PATH,
  DOCKER_CLI_FIXTURE_PATH,
  DOCKER_GUIDE_PAGE_PATH,
  GROUP_VARS_PATH,
  SANDBOX_DOCKERFILE_PATH,
  VERSIONS_ENV_PATH,
} from './lib/lab-pin-bumps.mjs';
import { BUMP_SETS } from './lab-pins-upstream.mjs';
import { SET as CLOUDFLARE_SET, VARIABLES_PATH } from './cloudflare-ranges.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = (name) => readFileSync(join(REPO, '.github', 'workflows', name), 'utf8');
const commandLines = (source) => source.split(/\r?\n/).filter((line) => !/^\s*#/.test(line));
/**
 * One job's text, from its key to the next job's. Both keys must exist: a
 * missing one makes indexOf return -1, and the slice then runs to the end of
 * the file, so assertions about one job would read the jobs after it (the
 * removal of publish-dockerhub on 2026-10-08 did exactly that until review
 * caught it).
 */
const job = (source, name, next) => {
  const at = (key) => {
    const index = source.indexOf(`\n  ${key}:\n`);
    if (index === -1) throw new Error(`no job \`${key}\` in the workflow`);
    return index;
  };
  return source.slice(at(name), next ? at(next) : undefined);
};

describe('the pin sets', () => {
  it('are the sets lab-pins-upstream.mjs can bump plus the Cloudflare ranges set, each on its own branch', () => {
    expect(Object.keys(SETS).sort()).toEqual([...BUMP_SETS, CLOUDFLARE_SET].sort());
    const branches = Object.values(SETS).map((s) => s.branch);
    expect(new Set(branches).size).toBe(branches.length);
    for (const [name, s] of Object.entries(SETS)) {
      expect(s.branch).toMatch(name === CLOUDFLARE_SET ? /^chore\/cloudflare-ranges$/ : /^chore\/lab-pins-/);
    }
  });

  it('may touch exactly the files their planners edit, and each exists', () => {
    // The dependents ride their set: the caddy test's SHA512 and the Docker CLI
    // fixture with the host pins, the guide page with the image base.
    expect(SETS.host.paths).toEqual([GROUP_VARS_PATH, CADDY_TEST_PATH, DOCKER_CLI_FIXTURE_PATH]);
    expect(SETS['image-base'].paths).toEqual([VERSIONS_ENV_PATH, DOCKERFILE_PATH, SANDBOX_DOCKERFILE_PATH, DOCKER_GUIDE_PAGE_PATH]);
    expect(SETS['image-digests'].paths).toEqual([CAPABILITIES_PATH, CODER_TEMPLATE_PATH]);
    expect(SETS[CLOUDFLARE_SET].paths).toEqual([VARIABLES_PATH]);
    for (const s of Object.values(SETS)) for (const p of s.paths) expect(existsSync(join(REPO, p)), p).toBe(true);
  });

  it('keeps one pull request per set: open, refresh, push, or comment when someone else committed', () => {
    const pull = { number: 7 };
    expect(decide({ pull: null, remote: null, localTree: 'a' })).toBe('push-and-open');
    expect(decide({ pull: null, remote: { tree: 'a', foreignAuthors: [] }, localTree: 'a' })).toBe('open');
    expect(decide({ pull, remote: { tree: 'a', foreignAuthors: [] }, localTree: 'a' })).toBe('refresh');
    expect(decide({ pull, remote: { tree: 'b', foreignAuthors: [] }, localTree: 'a' })).toBe('push-and-refresh');
    expect(decide({ pull, remote: { tree: 'b', foreignAuthors: ['owner@example.com'] }, localTree: 'a' })).toBe('comment');
    // An abandoned branch with no open pull request is the bot's to reuse.
    expect(decide({ pull: null, remote: { tree: 'b', foreignAuthors: ['owner@example.com'] }, localTree: 'a' })).toBe('push-and-open');
  });

  it('counts a person as the committer of an amended bot commit, not only as an author', () => {
    const bot = { email: BOT.email };
    expect(foreignIdentities([{ commit: { author: bot, committer: bot } }])).toEqual([]);
    expect(foreignIdentities([{ commit: { author: bot, committer: { email: 'owner@example.com' } } }])).toEqual(['owner@example.com']);
    expect(
      foreignIdentities([
        { commit: { author: { email: 'owner@example.com' }, committer: { email: 'owner@example.com' } } },
        { commit: { author: bot, committer: { email: 'owner@example.com' } } },
      ])
    ).toEqual(['owner@example.com']);
    expect(foreignIdentities(undefined)).toEqual([]);
  });

  it('reads changed paths from git status --porcelain', () => {
    expect(changedPaths(' M lab-image/versions.env\n?? x.txt\n')).toEqual(['lab-image/versions.env', 'x.txt']);
    // git() trims its output, so the first line arrives without its leading
    // space; the path must survive that (the 2026-10-07 digest PR refusal).
    expect(changedPaths('M lab-host/coder/templates/hcw-lab/main.tf\n M vps-agent/lib/capabilities.js')).toEqual([
      'lab-host/coder/templates/hcw-lab/main.tf',
      'vps-agent/lib/capabilities.js',
    ]);
    expect(changedPaths('R  old.txt -> new.txt\n?? "with space.txt"')).toEqual(['new.txt', 'with space.txt']);
  });

  it('writes a body with the evidence, the notes, the owner\'s next step and the issue', () => {
    const body = prBody({ set: 'host', evidence: '### Caddy: 2.11.4 → 2.11.7\n', notes: '- **Coder** 2.38.0 → 2.39.0: HTTP 404\n', runUrl: 'https://example/run/1' });
    expect(body).toContain('## Evidence\n\n### Caddy');
    expect(body).toContain('## Not bumped\n\n- **Coder**');
    expect(body).toContain('ssh -t hcw-lab "sudo /opt/hcw-src/lab-host/bootstrap.sh"');
    expect(body).toContain('Refs #949');
    expect(body).not.toMatch(/Closes #|THE_|<your/);
    // The template's sections, in its order, with only true boxes ticked
    // (CodeRabbit's Description check warned on #1122 without them).
    const headings = [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual([
      'Summary',
      'Evidence',
      'Not bumped',
      'Related issue or decision',
      'Type of change',
      'Scope and impact',
      'Verification',
      'Infrastructure changes only',
      'Security and data review',
      'Documentation and operations',
      'Author checklist',
    ]);
    expect(body).toContain('- [x] Dependency update');
    expect(body).toContain('- [x] Infrastructure or deployment change');
    expect(body).toContain('- [ ] Breaking change');
    expect(body).toContain('coder-postgres-backup');
    // Nothing is claimed that has not happened when the body is written: the
    // checks have not run, no plan was previewed, and the workflow does file
    // the pull request (CodeRabbit on #1131).
    expect(body).toContain('- Evidence level: [ ] Static [ ] Local [ ] CI [ ] Staging [ ] Production — none ticked at opening');
    expect(body).toContain('- [ ] Plan or preview was reviewed; no unexpected destroy/recreate operations exist. *(Not ticked: no plan or preview exists for an Ansible pin move.');
    // Each set says why in its own terms: the digest set updates two consumers, not Ansible pins.
    const digestsBody = prBody({ set: 'image-digests', evidence: 'x', notes: '', runUrl: 'u' });
    expect(digestsBody).toContain('*(Not ticked: this digest-only update of the two consumers creates no Terraform or Coder plan or preview.');
    expect(digestsBody).not.toContain('Ansible pin move');
    expect(body).toContain('- [ ] No automated path can activate, approve, sign, file, or make an authoritative write unless explicitly approved. *(Not ticked:');
    expect(body).not.toMatch(/\[x\] Plan or preview|\[x\] No automated path|\[x\] CI/);
    // The image base is a build input, not infrastructure: no infrastructure section, box unticked.
    const base = prBody({ set: 'image-base', evidence: 'x', notes: '', runUrl: 'u' });
    expect(base).not.toContain('## Infrastructure changes only');
    expect(base).toContain('- [ ] Infrastructure or deployment change');
    expect(base).toContain('CHECKED_ON');
    const digests = prBody({ set: 'image-digests', evidence: 'x', notes: '', runUrl: 'u' });
    // The host publishes the templates itself with its rotation credential
    // (seeded 2026-10-10): the body asks for no token and no manual push.
    const task = 'Publish the Coder templates with the rotation credential when they changed';
    expect(digests).toContain(task);
    expect(digests).not.toMatch(/hcw-setup|Read-Host|hcw-coder-template-push/);
    // The task the body names is the coder role's own, so a rename fails here, not in the owner's run.
    const tasks = readFileSync(join(REPO, 'lab-host/ansible/roles/coder/tasks/main.yml'), 'utf8');
    expect(tasks).toContain(`- name: ${task}`);
    expect(digests).not.toContain('## Not bumped');
  });

  it('commits as the same App identity the other scheduled pull requests use', () => {
    expect(BOT.email).toBe('hcw-manifest[bot]@users.noreply.github.com');
  });
});

describe('open-lab-pin-pr.mjs', () => {
  const source = readFileSync(join(REPO, 'scripts', 'open-lab-pin-pr.mjs'), 'utf8');

  it('stages the set\'s paths by name, never everything', () => {
    expect(source).toContain("git('add', '--', ...s.paths)");
    expect(source).not.toMatch(/'add',\s*'(-A|--all|\.)'/);
    expect(source).not.toMatch(/'commit',\s*'-a/);
  });

  it('refuses to run when a path outside the set changed', () => {
    expect(source).toContain('paths outside the');
  });

  it('opens ready for review, never as a draft, and force-pushes only with a lease', () => {
    expect(source).toContain('draft: false');
    expect(source).not.toContain('draft: true');
    expect(source).toMatch(/--force-with-lease=refs\/heads\//);
    expect(source).not.toMatch(/'--force'[,)]/);
  });
});

describe('lab-supply-chain.yml', () => {
  const source = workflow('lab-supply-chain.yml');

  it('scans once to JSON, renders the full table for the run summary and a compact table for the issue, and cuts an oversize body', () => {
    const check = source.slice(source.indexOf('  check:'));
    const scan = check.slice(check.indexOf('- name: Scan the published lab images the host runs'), check.indexOf('- name: Open or update the issue'));
    expect(scan).toContain('--format json -o "$report"');
    expect(scan).toContain('trivy convert --quiet --format table "$report" >> "$table"');
    expect(scan).toContain('cat "$table" >> "$GITHUB_STEP_SUMMARY"');
    expect(scan).toContain('| Found in | Package | Installed | Fixed in | Severity | Vulnerabilities |');
    // One row per installation, never one per package name (CodeRabbit on #1132).
    expect(scan).toContain('group_by([.target, .pkg, .inst])');
    expect(scan).toContain('head -40');
    const issue = check.slice(check.indexOf('- name: Open or update the issue'), check.indexOf('- name: Fail the run when the pin check could not evaluate'));
    expect(issue).toContain('cat "${RUNNER_TEMP}/scan-summary.md"');
    expect(issue).not.toContain('cat "${RUNNER_TEMP}/scan.md"');
    expect(issue).toContain('-gt 60000');
    expect(issue).toContain('head -c 60000');
  });

  it('records the sets\' paths before the downloaded CLI runs, refuses any change outside them, and judges the patch before the token job applies it', () => {
    const propose = source.slice(source.indexOf('  propose:'), source.indexOf('  pull-request:'));
    const order = [
      'Record each set\'s paths before anything downloaded runs',
      'Plan and make the bumps',
      'Re-record the Docker CLI fixture when the engine pin moved',
      'Nothing outside the sets\' paths changed',
      'One patch per set',
    ].map((name) => propose.indexOf(`- name: ${name}`));
    expect(order.every((at) => at !== -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The patch step reads the recorded lists, never the script again.
    const patchStep = propose.slice(propose.indexOf('- name: One patch per set'));
    expect(patchStep).toContain('mapfile -t paths < "${RUNNER_TEMP}/lab-pins/paths-${set}.txt"');
    expect(patchStep).not.toContain('open-lab-pin-pr.mjs --paths');
    expect(propose).toContain('record-docker-cli-fixture.mjs | tee');
    expect(propose).toMatch(/set -euo pipefail\n\s+node scripts\/lab\/record-docker-cli-fixture\.mjs/);

    const pr = source.slice(source.indexOf('  pull-request:'), source.indexOf('  check:'));
    const judge = pr.indexOf("- name: The patch touches only this set's recorded paths, and no code this job runs");
    const apply = pr.indexOf("- name: Apply this set's patch");
    const mint = pr.indexOf('- name: Mint an App installation token');
    expect(judge).toBeGreaterThan(-1);
    expect(judge).toBeLessThan(apply);
    expect(apply).toBeLessThan(mint);
    expect(pr).toContain('git apply --numstat "${patch}"');
    expect(pr).toContain(`grep -E '^(\\.github/|scripts/)' "\${RUNNER_TEMP}/lab-pins/patched.txt" | grep -vE '^scripts/fixtures/'`);
  });
  const lines = commandLines(source);
  const propose = job(source, 'propose', 'pull-request');
  const pullRequest = job(source, 'pull-request', 'check');
  const check = job(source, 'check');

  it('runs on Tuesdays at 06:45 UTC and by hand, once', () => {
    expect(lines.filter((l) => /cron:/.test(l))).toEqual(["    - cron: '45 6 * * 2'"]);
    expect(lines.some((l) => /^\s*workflow_dispatch:/.test(l))).toBe(true);
  });

  it('plans both sets in a job that can read and nothing more', () => {
    expect(propose).toContain('contents: read');
    expect(propose).not.toMatch(/secrets\./);
    expect(propose).toContain('for set in host image-base; do');
    expect(propose).toContain('node scripts/lab-pins-upstream.mjs --bump "$set"');
  });

  it('opens the pull requests from the automation environment with the App token, masked first and revoked after', () => {
    expect(pullRequest).toContain('environment: automation');
    expect(pullRequest).toContain('contents: read');
    expect(pullRequest).toContain('node scripts/open-lab-pin-pr.mjs --set "$SET"');
    expect(pullRequest.indexOf('::add-mask::')).toBeGreaterThan(-1);
    expect(pullRequest.indexOf('::add-mask::')).toBeLessThan(pullRequest.indexOf('token=${token}'));
    expect(pullRequest).toContain('node scripts/github-app-token.mjs --revoke');
    expect(pullRequest).toContain("if: needs.propose.outputs.sets != '[]'");
  });

  it('puts the notes of pins it could not verify into the weekly issue', () => {
    expect(check).toContain('needs: propose');
    expect(check).toContain('if: always()');
    expect(check).toContain("steps.notes.outputs.present == 'true'");
    expect(check).toContain('Not bumped automatically');
  });

  it('holds no write grant on contents or pull requests, and pins every action by SHA', () => {
    expect(lines.some((l) => /contents:\s*write/.test(l))).toBe(false);
    expect(lines.some((l) => /pull-requests:\s*write/.test(l))).toBe(false);
    expect(lines.some((l) => /^permissions:\s*\{\}/.test(l))).toBe(true);
    const uses = lines.filter((l) => /^\s*(- )?uses:\s/.test(l));
    expect(uses.length).toBeGreaterThan(5);
    for (const line of uses) expect(line, line.trim()).toMatch(/@[0-9a-f]{40}\s+#\s*v\d/);
  });

  it('never stages with git add', () => {
    expect(lines.filter((l) => /\bgit add\b/.test(l))).toEqual([]);
  });
});

describe('publish-lab-image.yml', () => {
  const source = workflow('publish-lab-image.yml');
  const lines = commandLines(source);
  const build = job(source, 'build', 'publish');
  const publish = job(source, 'publish', 'propose-pins');
  const propose = job(source, 'propose-pins', 'pin-pull-request');
  const pullRequest = job(source, 'pin-pull-request');

  it('rebuilds weekly on Tuesdays at 05:20 UTC, ahead of the supply-chain run', () => {
    expect(lines.filter((l) => /cron:/.test(l))).toEqual(["    - cron: '20 5 * * 2'"]);
  });

  it('says in its header what a rebuild changes and what it cannot change on its own', () => {
    expect(source).toContain('What a rebuild changes on its own');
    expect(source).toContain('What it cannot change on its own');
  });

  it('publishes a scheduled rebuild only when the full image\'s packages moved, under a tag of its own', () => {
    expect(build).toContain("if: github.event_name == 'schedule'");
    expect(build).toContain('dpkg-query');
    // Every build skips the layer cache on the schedule, or the apt layer is last week's.
    const builds = source.split('uses: docker/build-push-action@').slice(1);
    expect(builds).toHaveLength(4);
    for (const b of builds) expect(b.slice(0, b.indexOf('\n      - name:'))).toContain("no-cache: ${{ github.event_name == 'schedule' }}");
    expect(build).toContain('rebuild: ${{ steps.rebuild.outputs.rebuild }}');
    expect(publish).toContain("(github.event_name == 'schedule' && needs.build.outputs.rebuild == 'true')");
    expect(publish).toContain('tag="${SHA}-rebuilt-$(date -u +%Y%m%d)"');
    expect(publish).not.toMatch(/docker push "\$\{(RUNNER|FULL)_IMAGE\}:\$\{SHA\}"/);
  });

  it('does not republish on the merge of its own digest pull request', () => {
    const push = source.slice(source.indexOf('\n  push:\n'), source.indexOf('\npermissions:'));
    expect(push).not.toContain("'vps-agent/lib/capabilities.js'");
    expect(push).not.toContain('lab-host/coder/');
  });

  it('pins the consumers after every publish, by pull request from the automation environment', () => {
    expect(propose).toContain('needs: publish');
    expect(propose).toContain('contents: read');
    expect(propose).toContain('--bump image-digests');
    expect(pullRequest).toContain('environment: automation');
    expect(pullRequest).toContain('node scripts/open-lab-pin-pr.mjs --set image-digests');
    expect(pullRequest.indexOf('::add-mask::')).toBeLessThan(pullRequest.indexOf('token=${token}'));
    expect(lines.some((l) => /contents:\s*write/.test(l))).toBe(false);
    expect(lines.some((l) => /pull-requests:\s*write/.test(l))).toBe(false);
  });
});
