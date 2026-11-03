/**
 * publish-pyyaml-wheel.yml (#1505): the tripwires for the workflow that builds
 * PyYAML's wheel out of the lab image, attests it and attaches it to a release.
 *
 * What is held here, and why:
 *   - what each job may hold. The pull request path runs `plan` alone with a
 *     read token; `build` reads too; only `publish` holds the Sigstore and
 *     attestations grants, and the release is written with the App token, not
 *     with a `contents: write` grant (workflow-write-permissions.test.mjs keeps
 *     that list empty, and this file says the same from the other side).
 *   - the no-replace rule: an asset on a release is never overwritten, the
 *     tag is never reused for different source, and the run says so loudly.
 *   - the pins the step reads, the tag and the wheel name it derives, run for
 *     real under bash against a fixture, so a change to the naming is noticed
 *     here and not in a run on main.
 *   - every action pinned to a full commit, at the same pin as
 *     publish-lab-image.yml where both use the action, so a bump moves both.
 *
 * Comments are not searched for the tripwires: the header explains
 * `contents: write` and `--clobber`, and must not trip the tests that forbid
 * them. The whole file is searched where a comment is the subject.
 *
 * The workflow goes away with the PYYAML_* lines in lab-image/versions.env the
 * day PyYAML publishes a wheel for the base's Python; delete this file with it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBashTools, parseJobs } from './lib/workflow-text.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = join(REPO, '.github', 'workflows');
const FILE = 'publish-pyyaml-wheel.yml';
const source = readFileSync(join(WORKFLOWS, FILE), 'utf8').replace(/\r\n/g, '\n');
const labImage = readFileSync(join(WORKFLOWS, 'publish-lab-image.yml'), 'utf8').replace(/\r\n/g, '\n');
const code = source.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

/** One job's text, from its key to the next job's (or the end); the key must exist. */
const job = (name, next) => {
  const at = (key) => {
    const index = code.indexOf(`\n  ${key}:\n`);
    if (index === -1) throw new Error(`no job \`${key}\` in the workflow`);
    return index;
  };
  return next ? code.slice(at(name), at(next)) : code.slice(at(name));
};
const plan = job('plan', 'build');
const build = job('build', 'publish');
const publish = job('publish');

const jobs = parseJobs(source);
const stepOf = (jobKey, name) => {
  const found = jobs.find((j) => j.key === jobKey)?.steps.find((s) => s.name === name);
  if (!found) throw new Error(`no step "${name}" in job ${jobKey}`);
  return found;
};

/** The `uses:` pins of a workflow's code lines, by action name. */
const pinsOf = (text) =>
  new Map(
    [...text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n').matchAll(/uses: ([^@\s]+)@([0-9a-f]{40}) # (\S+)/g)].map((m) => [
      m[1],
      `${m[2]} # ${m[3]}`,
    ])
  );

describe('publish-pyyaml-wheel.yml: triggers', () => {
  it('runs by hand, on a push to main and on a pull request, each filtered to the three files that change the wheel', () => {
    expect(code).toMatch(/^on:\n  workflow_dispatch:\n/m);
    const paths = "    paths:\n      - 'lab-image/versions.env'\n      - 'lab-image/Dockerfile'\n      - '.github/workflows/publish-pyyaml-wheel.yml'\n";
    expect(code).toContain(`  pull_request:\n${paths}`);
    expect(code).toContain(`  push:\n    branches: [main]\n${paths}`);
    // No schedule: a wheel is published when its pins change, not weekly.
    expect(code).not.toMatch(/^\s*schedule:/m);
  });

  it('never runs on pull_request_target, so a fork cannot borrow a token', () => {
    expect(code).not.toContain('pull_request_target');
  });

  it('cancels a superseded pull request run and never a run from main', () => {
    expect(code).toContain('group: publish-pyyaml-wheel-${{ github.ref }}');
    expect(code).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
  });
});

describe('publish-pyyaml-wheel.yml: what each job holds', () => {
  it('has the three jobs, in order, each with a plain timeout-minutes', () => {
    expect(jobs.map((j) => j.key)).toEqual(['plan', 'build', 'publish']);
    for (const j of jobs) {
      const line = j.lines.find((text) => /^ {4}timeout-minutes:/.test(text));
      expect(line, `${j.key} has no timeout-minutes`).toBeDefined();
      expect(line.replace(/^ {4}timeout-minutes:\s*/, '').replace(/\s+#.*$/, '')).toMatch(/^\d+$/);
    }
  });

  it('reads at the top, and grants exactly what each job needs and nothing more', () => {
    expect(code).toMatch(/^permissions:\n  contents: read\n/m);
    const grantsOf = (text) => {
      const blocks = [...text.matchAll(/^\s*permissions:\n((?:\s+[a-z-]+: (?:read|write|none)(?: #.*)?\n)+)/gm)].map((m) => m[1]);
      expect(blocks.length).toBe(1);
      return [...blocks[0].matchAll(/([a-z-]+): (read|write|none)/g)].map((m) => `${m[1]}: ${m[2]}`).sort();
    };
    expect(grantsOf(plan)).toEqual(['contents: read']);
    expect(grantsOf(build)).toEqual(['contents: read']);
    expect(grantsOf(publish)).toEqual(['artifact-metadata: write', 'attestations: write', 'contents: read', 'id-token: write']);
  });

  it('never holds contents: write (the release is written with the App token; workflow-write-permissions.test.mjs keeps its list empty)', () => {
    expect(code).not.toMatch(/contents\s*:\s*['"]?write['"]?/);
    expect(code).not.toMatch(/pull-requests: write|packages: write|issues: write/);
  });

  it('runs build and publish never on a pull request, skips build on the repair path, and publishes only from main after plan found no complete release', () => {
    expect(build).toContain("if: github.event_name != 'pull_request' && needs.plan.outputs.state != 'published' && needs.plan.outputs.repair != 'true'");
    expect(publish).toContain('needs: [plan, build]');
    // `!cancelled()` so a build skipped on purpose (repair) does not skip publish; every other build outcome still does.
    expect(publish).toMatch(
      /if: >-\n\s+!cancelled\(\) && needs\.plan\.result == 'success' &&\n\s+\(needs\.build\.result == 'success' \|\| \(needs\.build\.result == 'skipped' && needs\.plan\.outputs\.repair == 'true'\)\) &&\n\s+needs\.plan\.outputs\.state != 'published' && \(\n\s+github\.event_name == 'push' \|\|\n\s+\(github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'\)\)/
    );
    expect(publish).not.toMatch(/always\(\)[^\n]*needs\./);
  });

  it('on the repair path leaves the new-wheel steps out and runs the two repair steps, and never both', () => {
    const steps = jobs.find((j) => j.key === 'publish').steps;
    const newWheel = ['Take the wheel from the build job', 'The wheel is the one the build job hashed', "Attest the wheel's build provenance", 'Keep the attestation bundle beside the wheel', 'Create the release or upload into it, never replacing an asset'];
    for (const name of newWheel) expect(stepOf('publish', name).if, name).toBe("needs.plan.outputs.repair != 'true'");
    for (const name of ['Repair, part one, the wheel that is on the release', 'Repair, part two, its attestation becomes the bundle']) {
      expect(stepOf('publish', name).if, name).toBe("needs.plan.outputs.repair == 'true'");
    }
    // The notes, the read-back and the summary run on both paths and read the hash from whichever path ran.
    for (const name of ['Write the release notes', 'The published pair verifies the way the host will read it', 'Published']) {
      const step = stepOf('publish', name);
      expect(step.if, name).toBeUndefined();
      expect(step.env.WHEEL_SHA256, name).toBe('${{ needs.build.outputs.sha256 || steps.existing-wheel.outputs.sha256 }}');
    }
    expect(stepOf('publish', 'Published').env.OUTCOME).toBe('${{ steps.release.outputs.outcome || steps.repair.outputs.outcome }}');
    expect(steps.map((s) => s.name).indexOf('Write the release notes')).toBeLessThan(steps.map((s) => s.name).indexOf('Repair, part two, its attestation becomes the bundle'));
  });

  it('reads the App secret in the publish job only, under the automation environment, scoped to contents, masked, and revoked whatever happens', () => {
    expect(plan).not.toContain('secrets.');
    expect(build).not.toContain('secrets.');
    expect(plan).not.toContain('vars.');
    expect(build).not.toContain('vars.');
    const reads = [...code.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    expect(new Set(reads)).toEqual(new Set(['MANIFEST_APP_PRIVATE_KEY']));
    expect(publish).toContain('environment: automation');
    const mint = stepOf('publish', 'Mint an App installation token');
    expect(mint.env.GITHUB_APP_PERMISSIONS).toBe('{"contents":"write"}');
    expect(mint.run).toContain('token=$(node scripts/github-app-token.mjs)');
    expect(mint.run).toMatch(/echo "::add-mask::\$\{token\}"\n\s*echo "token=\$\{token\}" >> "\$GITHUB_OUTPUT"/);
    const revoke = stepOf('publish', 'Revoke the installation token');
    expect(revoke.if).toBe("always() && steps.token.outputs.token != ''");
    expect(revoke.run).toBe('node scripts/github-app-token.mjs --revoke');
    // The App token reaches gh in the two steps that write the release and nowhere else; the reads use the ordinary token.
    const appTokenSteps = jobs.find((j) => j.key === 'publish').steps.filter((s) => s.env.GH_TOKEN === '${{ steps.token.outputs.token }}').map((s) => s.name);
    expect(appTokenSteps).toEqual(['Repair, part two, its attestation becomes the bundle', 'Create the release or upload into it, never replacing an asset']);
    for (const name of ['Repair, part one, the wheel that is on the release', 'The published pair verifies the way the host will read it']) {
      expect(stepOf('publish', name).env.GH_TOKEN, name).toBe('${{ github.token }}');
    }
  });

  it('fails, naming the variable and the secret, when the App is not configured, rather than warning and passing', () => {
    const step = stepOf('publish', 'The App is configured');
    expect(step.run).toContain('MANIFEST_APP_ID variable');
    expect(step.run).toContain('MANIFEST_APP_PRIVATE_KEY secret');
    expect(step.run).toMatch(/::error::[^\n]*\n\s*exit 1/);
    expect(step.run).not.toContain('::warning');
  });

  it('checks out without keeping credentials, every time', () => {
    const checkouts = code.match(/uses: actions\/checkout@/g) ?? [];
    expect(checkouts.length).toBe(3);
    expect((code.match(/persist-credentials: false/g) ?? []).length).toBe(3);
  });
});

describe('publish-pyyaml-wheel.yml: pins', () => {
  it('pins every action to a full commit and says which release it is', () => {
    const uses = [...code.matchAll(/uses: (\S+)@(\S+)( # \S+)?/g)];
    expect(uses.length).toBeGreaterThanOrEqual(8);
    for (const [line, , sha, comment] of uses) {
      expect(sha, line).toMatch(/^[0-9a-f]{40}$/);
      expect(comment, line).toBeDefined();
    }
  });

  it('attests with actions/attest-build-provenance v4.2.2, the pin the repository uses', () => {
    expect(code).toContain('uses: actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8 # v4.2.2');
  });

  it('uses the same pin as publish-lab-image.yml for every action both use, so a bump moves both', () => {
    const mine = pinsOf(source);
    const theirs = pinsOf(labImage);
    const shared = [...mine.keys()].filter((action) => theirs.has(action));
    expect(shared.sort()).toEqual(
      [
        'actions/attest-build-provenance',
        'actions/checkout',
        'actions/download-artifact',
        'actions/setup-node',
        'actions/upload-artifact',
        'docker/build-push-action',
        'docker/setup-buildx-action',
      ].sort()
    );
    for (const action of shared) expect(mine.get(action), action).toBe(theirs.get(action));
  });
});

describe('publish-pyyaml-wheel.yml: the build and the attestation', () => {
  it('builds the pyyaml-wheel stage of the lab image to a directory, reads the lab image cache and writes none, pushes nothing', () => {
    const step = stepOf('build', 'Build the pyyaml-wheel stage to a directory');
    expect(step.lines.join('\n')).toContain('context: lab-image');
    expect(step.lines.join('\n')).toContain('target: pyyaml-wheel');
    expect(step.lines.join('\n')).toContain('push: false');
    expect(step.lines.join('\n')).toContain('provenance: false');
    expect(step.lines.join('\n')).toContain('outputs: type=local,dest=${{ runner.temp }}/wheel');
    expect(step.lines.join('\n')).toContain('cache-from: type=gha,scope=hcw-lab');
    expect(build).not.toContain('cache-to:');
  });

  it('refuses a stage output that is not exactly the one expected file, and hashes it', () => {
    const step = stepOf('build', 'Exactly the expected wheel came out');
    expect(step.run).toContain('if [ "$count" != "1" ] || [ ! -f "${dir}/${WHEEL}" ]; then');
    expect(step.run).toMatch(/::error[^\n]*\n\s*exit 1/);
    expect(step.run).toContain('echo "sha256=${sha256}" >> "$GITHUB_OUTPUT"');
    expect(build).toContain('if-no-files-found: error');
  });

  it('publish checks the downloaded wheel against the hash build wrote before attesting it', () => {
    const steps = jobs.find((j) => j.key === 'publish').steps.map((s) => s.name);
    expect(steps.indexOf('The wheel is the one the build job hashed')).toBeLessThan(steps.indexOf("Attest the wheel's build provenance"));
    expect(stepOf('publish', 'The wheel is the one the build job hashed').run).toContain('if [ "$sha256" != "$BUILT_SHA256" ]; then');
  });

  it('attests the file by path and puts the bundle on the release beside the wheel as <wheel>.sigstore.json', () => {
    const attest = stepOf('publish', "Attest the wheel's build provenance");
    expect(attest.lines.join('\n')).toContain('subject-path: ${{ runner.temp }}/wheel/${{ needs.plan.outputs.wheel }}');
    expect(attest.lines.join('\n')).not.toContain('push-to-registry');
    const keep = stepOf('publish', 'Keep the attestation bundle beside the wheel');
    expect(keep.env.BUNDLE_PATH).toBe('${{ steps.attest.outputs.bundle-path }}');
    expect(keep.run).toContain('cp "$BUNDLE_PATH" "${RUNNER_TEMP}/wheel/${WHEEL}.sigstore.json"');
    expect(publish).toContain('bundle="${WHEEL}.sigstore.json"');
  });

  // CodeRabbit on #1506 (comment 4449208082): `gh attestation verify --repo` alone reads the API's copy, not the file the host downloads.
  it('reads both files back with the ordinary token and verifies the wheel with the downloaded bundle and the exact signer identity, the way the host will', () => {
    const step = stepOf('publish', 'The published pair verifies the way the host will read it');
    expect(step.run).toContain('gh release download "$TAG" --repo "$REPO" --pattern "$WHEEL" --dir "$readback"');
    expect(step.run).toContain('gh release download "$TAG" --repo "$REPO" --pattern "$bundle" --dir "$readback"');
    expect(step.run).toContain('if [ "$sha256" != "$WHEEL_SHA256" ]; then');
    expect(step.run).toContain('test -s "${readback}/${bundle}"');
    expect(step.run).toContain('gh attestation verify "${readback}/${WHEEL}" --repo "$REPO" --bundle "${readback}/${bundle}" --cert-identity "$SIGNER_IDENTITY"');
  });

  it('pins one exact signer identity, this workflow on main, the same the host requires, and never the prefix-matched --signer-workflow', () => {
    expect(code).toContain('SIGNER_IDENTITY: https://github.com/${{ github.repository }}/.github/workflows/publish-pyyaml-wheel.yml@refs/heads/main');
    expect(code).not.toContain('--signer-workflow');
    expect(code).not.toContain('--cert-identity-regex');
    // Every verify in the file is the --bundle form with the identity: none reads the API's copy alone.
    // The commands, not the mention in the release notes text.
    const verifies = code.match(/^\s*(?:if ! )?gh attestation verify [^\n]*/gm) ?? [];
    expect(verifies.length).toBe(3);
    for (const line of verifies) expect(line).toMatch(/--repo "\$REPO" --bundle "[^"]+" --cert-identity "\$SIGNER_IDENTITY"(?:; then)?$/);
    // The host's anchored regexp names the same identity.
    const bootstrap = readFileSync(join(REPO, 'lab-host', 'bootstrap.sh'), 'utf8');
    expect(bootstrap).toContain("--certificate-identity-regexp '^https://github\\.com/saulpatinojr/HCW-HybridCloudWorks/\\.github/workflows/publish-pyyaml-wheel\\.yml@refs/heads/main$'");
  });

  it('writes the asset URL, the SHA256 and the attestation to the step summary', () => {
    const step = stepOf('publish', 'Published');
    expect(step.run).toContain('url="https://github.com/${REPO}/releases/download/${TAG}/${WHEEL}"');
    expect(step.run).toContain('echo "sha256:${WHEEL_SHA256}"');
    expect(step.run).toContain('${ATTESTATION_URL}');
    expect(step.run).toContain('tee -a "$GITHUB_STEP_SUMMARY"');
  });
});

describe('publish-pyyaml-wheel.yml: never a replacement', () => {
  it('never uploads with --clobber and never deletes a release or an asset', () => {
    expect(code).not.toContain('--clobber');
    expect(code).not.toMatch(/gh release delete|releases\/assets\/[^\n]*-X DELETE|--method DELETE/);
  });

  it('creates the release only when the tag is absent, never as the latest release, with the tag on the commit that built it', () => {
    const step = stepOf('publish', 'Create the release or upload into it, never replacing an asset');
    expect(step.run).toContain(
      'gh release create "$TAG" --repo "$REPO" --target "$SHA" --latest=false --title "PyYAML ${VERSION} wheel for CPython ${ABI}" --notes-file "$notes" "${dir}/${WHEEL}" "${dir}/${bundle}"'
    );
    // grep's status is kept and only a clean 404 creates (#1429); any other API failure is a failure, never "no release yet".
    expect(step.run).toMatch(
      /missing=0\n\s*grep -q 'HTTP 404' "\$\{RUNNER_TEMP\}\/release-now\.err" \|\| missing=\$\?\n\s*if \[ "\$missing" != 0 \]; then\n\s*echo "::error::could not read release \$\{TAG\}[^\n]*\n\s*exit 1\n\s*fi\n\s*gh release create/
    );
    expect(code).not.toMatch(/^\s*(?:el)?if\s[^\n]*\bgrep\b/m);
  });

  it('compares a wheel that appeared during the run by SHA256, and fails on a different file instead of replacing it', () => {
    const step = stepOf('publish', 'Create the release or upload into it, never replacing an asset');
    expect(step.run).toContain('if [ "$raced" != "$BUILT_SHA256" ]; then');
    expect(step.run).toContain('The published file stays; this run\'s file is not uploaded and not attached');
    expect(step.run).toMatch(/not uploaded and not attached[^\n]*\n\s*exit 1/);
    expect(step.run).toContain('echo "outcome=already-there" >> "$GITHUB_OUTPUT"');
    // A wheel that arrived without its bundle is the repair case, which this run did not prepare for: nothing is uploaded.
    expect(step.run).toMatch(/elif \[ "\$bundles" = "0" \]; then\n(?:\s*#[^\n]*\n)*\s*echo "::error::release \$\{TAG\} gained a \$\{WHEEL\} without its bundle[^\n]*\n\s*exit 1/);
  });

  // Review finding F3 (2026-11-02): a release with the wheel and no bundle was "published" for good, and the host 404ed on the bundle.
  it('counts both the wheel and the bundle, in plan and in publish, before calling a release published, and uploads both or neither on the new-wheel path', () => {
    const wheelFilter = `jq -r --arg name "$WHEEL" '[.assets[] | select(.name == $name)] | length'`;
    const existing = stepOf('plan', 'Is the wheel already published?');
    expect(existing.run).toContain(`wheels="$(${wheelFilter} "$release")"`);
    expect(existing.run).toContain(`bundles="$(jq -r --arg name "\${WHEEL}.sigstore.json" '[.assets[] | select(.name == $name)] | length' "$release")"`);
    expect(existing.run).toContain('if [ "$wheels" = "1" ] && [ "$bundles" = "1" ]; then\n    state=published');
    expect(code).not.toContain('release-without-wheel');
    const release = stepOf('publish', 'Create the release or upload into it, never replacing an asset');
    expect(release.run).toContain(`wheels="$(${wheelFilter} "$release")"`);
    expect(release.run).toContain(`bundles="$(jq -r --arg name "$bundle" '[.assets[] | select(.name == $name)] | length' "$release")"`);
    // Neither file there: both go up, then the notes; never over an existing one.
    expect(release.run).toContain('elif [ "$wheels" = "0" ]; then\n    gh release upload "$TAG" --repo "$REPO" "${dir}/${WHEEL}"\n    gh release upload "$TAG" --repo "$REPO" "${dir}/${bundle}"\n    gh release edit "$TAG" --repo "$REPO" --notes-file "$notes"\n    echo "outcome=uploaded" >> "$GITHUB_OUTPUT"');
    expect((release.run.match(/gh release upload /g) ?? []).length).toBe(2);
    expect((release.run.match(/gh release edit /g) ?? []).length).toBe(1);
    expect(code).not.toMatch(/gh release edit [^\n]*--(tag|target|draft|prerelease|latest)/);
  });

  // CodeRabbit on #1506 (comment 4449208095): a bundle whose wheel is gone must stop the run, in plan and again in publish.
  it('fails closed, in plan and in publish, when the release has the bundle but not the wheel, naming the by-hand step', () => {
    const existing = stepOf('plan', 'Is the wheel already published?');
    expect(existing.run).toMatch(/elif \[ "\$wheels" = "0" \] && \[ "\$bundles" != "0" \]; then\n(?:\s*#[^\n]*\n)*\s*echo "::error::release \$\{TAG\} has \$\{WHEEL\}\.sigstore\.json but no \$\{WHEEL\}[^\n]*Remove that bundle asset by hand[^\n]*\n\s*exit 1/);
    const release = stepOf('publish', 'Create the release or upload into it, never replacing an asset');
    expect(release.run).toMatch(/if \[ "\$wheels" = "0" \] && \[ "\$bundles" != "0" \]; then\n(?:\s*#[^\n]*\n)*\s*echo "::error::release \$\{TAG\} has \$\{bundle\} but no \$\{WHEEL\}[^\n]*Nothing is uploaded[^\n]*\n\s*exit 1/);
    // The fail-closed branch comes before any upload in both.
    expect(release.run.indexOf('&& [ "$bundles" != "0" ]')).toBeLessThan(release.run.indexOf('gh release upload'));
  });

  // CodeRabbit on #1506 (comment 4449208095): the wheel on the release is the wheel; a rebuild is a different file, so the bundle comes from its own attestation.
  it('repairs a release that has the wheel but not the bundle from the existing wheel\'s own attestation, verified with the bundle before it is uploaded, and rewrites the notes', () => {
    expect(stepOf('plan', 'Is the wheel already published?').run).toContain('elif [ "$wheels" = "1" ]; then\n    state=\'release-incomplete\'\n    repair=true');
    expect(plan).toContain('repair: ${{ steps.existing.outputs.repair }}');
    const one = stepOf('publish', 'Repair, part one, the wheel that is on the release');
    expect(one.id).toBe('existing-wheel');
    expect(one.run).toContain('gh release download "$TAG" --repo "$REPO" --pattern "$WHEEL" --dir "$repairdir"');
    expect(one.run).toContain('echo "sha256=${sha256}" >> "$GITHUB_OUTPUT"');
    const two = stepOf('publish', 'Repair, part two, its attestation becomes the bundle');
    expect(two.id).toBe('repair');
    expect(two.env.EXISTING_SHA256).toBe('${{ steps.existing-wheel.outputs.sha256 }}');
    expect(two.run).toContain('gh attestation download "${repairdir}/${WHEEL}" --repo "$REPO"');
    // One bundle per line of sha256-<digest>.jsonl; the first line is the bundle object the host reads.
    expect(two.run).toContain('jsonl="$(find "$repairdir" -maxdepth 1 -name "sha256*${EXISTING_SHA256}.jsonl" | head -n 1)"');
    expect(two.run).toMatch(/if \[ -z "\$jsonl" \] \|\| \[ ! -s "\$jsonl" \]; then\n\s*echo "::error::GitHub's API holds no attestation[^\n]*\n\s*exit 1/);
    expect(two.run).toContain('head -n 1 "$jsonl" > "${repairdir}/${bundle}"');
    const order = [
      'head -n 1 "$jsonl"',
      'gh attestation verify "${repairdir}/${WHEEL}" --repo "$REPO" --bundle "${repairdir}/${bundle}" --cert-identity "$SIGNER_IDENTITY"',
      'if [ "$bundles" != "0" ]; then',
      'gh release upload "$TAG" --repo "$REPO" "${repairdir}/${bundle}"',
      'gh release edit "$TAG" --repo "$REPO" --notes-file "${RUNNER_TEMP}/notes.md"',
      'echo "outcome=repaired" >> "$GITHUB_OUTPUT"',
    ].map((s) => two.run.indexOf(s));
    expect(order.every((at) => at !== -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect((two.run.match(/gh release upload /g) ?? []).length).toBe(1);
    expect(two.run).not.toContain('${dir}/');
    expect(two.run).not.toContain('BUILT_SHA256');
  });

  // Review finding F2 (2026-11-02): a wheel uploaded into an existing release under the earlier run's notes read as tampered at every later check.
  it('writes the notes for the wheel that will be on the release, and rewrites them after every upload into an existing release', () => {
    const notes = stepOf('publish', 'Write the release notes');
    expect(notes.run).toContain('test -n "$WHEEL_SHA256"');
    expect(notes.run).toContain('"source-sha256: ${SOURCE_SHA256}" "wheel-sha256: ${WHEEL_SHA256}"');
    expect(notes.run).toContain('> "${RUNNER_TEMP}/notes.md"');
    expect(notes.run).toContain('--bundle ${bundle} --cert-identity ${SIGNER_IDENTITY}');
    const edits = jobs.find((j) => j.key === 'publish').steps.filter((s) => (s.run ?? '').includes('gh release edit ')).map((s) => s.name);
    expect(edits).toEqual(['Repair, part two, its attestation becomes the bundle', 'Create the release or upload into it, never replacing an asset']);
    // The create path hands the same file to gh release create, so the notes are never written twice.
    expect(stepOf('publish', 'Create the release or upload into it, never replacing an asset').run).toContain('notes="${RUNNER_TEMP}/notes.md"');
    expect(code.match(/"wheel-sha256: \$\{WHEEL_SHA256\}"/g) ?? []).toHaveLength(1);
  });

  it('on the no-op path downloads the bundle too, refuses an empty or non-bundle file, and keeps the online check', () => {
    const verify = stepOf('plan', 'Already published, verify it and say so');
    expect(verify.run).toContain('gh release download "$TAG" --repo "$REPO" --pattern "$bundle" --dir "$dir"');
    expect(verify.run).toContain('if [ ! -s "${dir}/${bundle}" ]; then');
    expect(verify.run).toMatch(/has no usable \$\{bundle\}[^\n]*\n\s*exit 1/);
    expect(verify.run).toContain(`jq -es 'length > 0 and all(has("verificationMaterial") and has("dsseEnvelope"))' "\${dir}/\${bundle}"`);
    expect(verify.run).toMatch(/is not a Sigstore bundle[^\n]*\n\s*exit 1/);
    const order = ['gh release download "$TAG" --repo "$REPO" --pattern "$bundle"', 'if [ ! -s "${dir}/${bundle}" ]', 'jq -es', 'gh attestation verify'].map((s) => verify.run.indexOf(s));
    expect(order.every((at) => at !== -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('records the source archive and the wheel SHA256 in the release notes on lines the next run reads back', () => {
    const notes = stepOf('publish', 'Write the release notes');
    expect(notes.run).toContain('source-sha256: ${SOURCE_SHA256}');
    expect(notes.run).toContain('wheel-sha256: ${WHEEL_SHA256}');
    const check = stepOf('plan', 'The existing release was built from the source archive versions.env names');
    expect(check.if).toBe("steps.existing.outputs.state != 'absent'");
    expect(check.run).toContain("sed -n 's/^source-sha256: \\([0-9a-f]\\{64\\}\\)$/\\1/p'");
    expect(check.run).toContain('if [ "$recorded" != "$SOURCE_SHA256" ]; then');
    expect(check.run).toContain('A tag is never reused for different source');
    expect(check.run).toMatch(/never reused for different source[^\n]*\n\s*exit 1/);
    const verify = stepOf('plan', 'Already published, verify it and say so');
    expect(verify.if).toBe("steps.existing.outputs.state == 'published'");
    expect(verify.run).toContain("sed -n 's/^wheel-sha256: \\([0-9a-f]\\{64\\}\\)$/\\1/p'");
    expect(verify.run).toContain('gh attestation verify "${dir}/${WHEEL}" --repo "$REPO" --bundle "${dir}/${bundle}" --cert-identity "$SIGNER_IDENTITY"');
    expect(verify.run).toMatch(/does not verify \$\{WHEEL\} as built by \$\{SIGNER_IDENTITY\}[^\n]*\n\s*exit 1/);
    expect(verify.run).toContain('## Already published, nothing changed');
  });

  it('on a pull request says what a push would publish, and builds nothing', () => {
    const step = stepOf('plan', 'What a push to main would publish');
    expect(step.if).toBe("github.event_name == 'pull_request' && steps.existing.outputs.state != 'published'");
    expect(step.run).toContain('## Dry run: nothing built, nothing published');
    expect(plan).not.toMatch(/docker |build-push-action|attest-build-provenance/);
  });
});

const TOOLS = findBashTools();
const SKIPPED = TOOLS.ready ? '' : ` (skipped here: ${TOOLS.why})`;
const forward = (p) => p.replace(/\\/g, '/');

describe('publish-pyyaml-wheel.yml: the pins step, read as text', () => {
  it('reads the three lines with the env_value sed publish-lab-image.yml uses and derives the tag and the wheel name from them', () => {
    const step = stepOf('plan', 'Read the pins and name the wheel');
    expect(step.run).toContain('env_value() { sed -n "s/^$1=//p" lab-image/versions.env; }');
    expect(labImage).toContain('env_value() { sed -n "s/^$1=//p" versions.env; }');
    expect(step.run).toContain('version="$(env_value PYYAML_VERSION)"');
    expect(step.run).toContain('source_sha256="$(env_value PYYAML_SDIST_SHA256)"');
    expect(step.run).toContain('python="$(env_value BASE_PYTHON_VERSION)"');
    expect(step.run).toContain('tag="pyyaml-${version}-${abi}"');
    expect(step.run).toContain('wheel="pyyaml-${version}-${abi}-${abi}-linux_x86_64.whl"');
    expect(step.run).not.toMatch(/^\s*(source|\.)\s+lab-image\/versions\.env/m);
  });
});

describe.skipIf(!TOOLS.ready)(`publish-pyyaml-wheel.yml: the pins step, run with bash${SKIPPED}`, () => {
  let work;
  let counter = 0;
  const script = stepOf('plan', 'Read the pins and name the wheel').run;
  const STAGE = 'FROM python:3.14.10-slim-trixie@sha256:0000000000000000000000000000000000000000000000000000000000000000 AS fetch\nFROM scratch AS pyyaml-wheel\nCOPY --from=fetch /out/pyyaml/ /\n';
  const SHA = 'd76623373421df22fb4cf8817020cbb7ef15c725b9d5e45f17e189bfc384190f';
  const env = ({ version = '6.0.3', sha = SHA, python = '3.14.10' } = {}) =>
    `# the lab image's pins, cut down\nBASE_IMAGE=python:${python}-slim-trixie\nBASE_PYTHON_VERSION=${python}\nPYYAML_VERSION=${version}\nPYYAML_SDIST_SHA256=${sha}\nANSIBLE_CORE_VERSION=2.21.5\n`;

  /** Runs the step in a checkout holding only the two files it reads; returns the exit status, the output file's lines and the log. */
  const run = ({ versionsEnv, dockerfile = STAGE }) => {
    const dir = join(work, `case-${++counter}`);
    mkdirSync(join(dir, 'lab-image'), { recursive: true });
    writeFileSync(join(dir, 'lab-image', 'versions.env'), versionsEnv);
    writeFileSync(join(dir, 'lab-image', 'Dockerfile'), dockerfile);
    const output = join(dir, 'output.txt');
    writeFileSync(output, '');
    const result = spawnSync('bash', ['-c', script], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: forward(output) } });
    const outputs = Object.fromEntries(
      readFileSync(output, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => line.split(/=(.*)/s).slice(0, 2))
    );
    return { status: result.status, outputs, log: `${result.stdout}${result.stderr}` };
  };

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'pyyaml-wf-'));
  });
  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it('names the tag and the wheel for PyYAML 6.0.3 on CPython 3.14.10: pyyaml-6.0.3-cp314', () => {
    const { status, outputs } = run({ versionsEnv: env() });
    expect(status).toBe(0);
    expect(outputs).toEqual({
      version: '6.0.3',
      'source-sha256': SHA,
      abi: 'cp314',
      tag: 'pyyaml-6.0.3-cp314',
      wheel: 'pyyaml-6.0.3-cp314-cp314-linux_x86_64.whl',
    });
  });

  it('moves with the base: CPython 3.15.2 names pyyaml-6.0.3-cp315, a different tag beside the first (#1468)', () => {
    const { status, outputs } = run({ versionsEnv: env({ python: '3.15.2' }) });
    expect(status).toBe(0);
    expect(outputs.abi).toBe('cp315');
    expect(outputs.tag).toBe('pyyaml-6.0.3-cp315');
    expect(outputs.wheel).toBe('pyyaml-6.0.3-cp315-cp315-linux_x86_64.whl');
  });

  it('fails, naming the line, when PYYAML_VERSION is missing', () => {
    const { status, outputs, log } = run({ versionsEnv: env().replace(/^PYYAML_VERSION=.*\n/m, '') });
    expect(status).toBe(1);
    expect(log).toContain('::error file=lab-image/versions.env::PYYAML_VERSION is missing');
    expect(outputs).toEqual({});
  });

  it('fails when PYYAML_SDIST_SHA256 is not 64 hex characters', () => {
    const { status, log } = run({ versionsEnv: env({ sha: 'abc' }) });
    expect(status).toBe(1);
    expect(log).toContain('PYYAML_SDIST_SHA256 is missing or is not 64 hex characters');
  });

  it('fails when BASE_PYTHON_VERSION is not major.minor.patch', () => {
    const { status, log } = run({ versionsEnv: env({ python: '3.14' }) });
    expect(status).toBe(1);
    expect(log).toContain('BASE_PYTHON_VERSION is missing or is not major.minor.patch');
  });

  it('fails when the Dockerfile has no pyyaml-wheel stage, so the build job never runs against a Dockerfile that cannot produce the file', () => {
    const { status, log } = run({ versionsEnv: env(), dockerfile: 'FROM scratch AS something-else\n' });
    expect(status).toBe(1);
    expect(log).toContain("::error file=lab-image/Dockerfile::no stage 'FROM scratch AS pyyaml-wheel'");
  });
});
