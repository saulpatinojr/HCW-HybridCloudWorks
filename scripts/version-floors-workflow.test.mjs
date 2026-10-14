/**
 * What the weekly version-floors branch is allowed to contain (#715).
 *
 * The same tripwire as avm-versions-workflow.test.mjs, for the same reason:
 * the `commit` job pushes a branch with a GitHub App installation token. Since
 * #1152 the branch carries the engines.node ranges the new floors leave
 * behind as well as the floors file, so the job judges the patch before it
 * applies it and stages only the paths that judgement listed. `-A` or `.`
 * would sweep in whatever the earlier job left in the workspace. The guard is
 * run here against real patches, not only read, because its rule is code.
 */
import { afterAll, describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOW = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '.github',
  'workflows',
  'update-version-floors.yml'
);
const FLOORS_PATH = 'scripts/version-floors.json';
const GUARD = 'The patch moves only the floors file and engines.node ranges';

/** Non-comment lines only, so prose about `git add -A` cannot trip it. */
function commandLines(source) {
  return String(source)
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line));
}

const indentOf = (line) => line.length - line.trimStart().length;

/** The `run: |` script of the step with this name, dedented. */
function stepScript(source, name) {
  const lines = String(source).split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  const runAt = lines.findIndex((l, i) => i > start && /^\s*run: \|\s*$/.test(l));
  const body = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() && indentOf(line) <= indentOf(lines[runAt])) break;
    body.push(line);
  }
  const indent = Math.min(...body.filter((l) => l.trim()).map(indentOf));
  return body.map((l) => l.slice(indent)).join('\n');
}

describe('the version floors workflow', () => {
  const source = readFileSync(WORKFLOW, 'utf8');
  const lines = commandLines(source);
  const updateJob = source.slice(source.indexOf('  update:'), source.indexOf('  commit:'));
  const commitJob = source.slice(source.indexOf('  commit:'));

  it('runs on Wednesdays at 06:30 UTC and by hand, not in an hour another updater uses', () => {
    expect(lines.some((l) => l.includes("cron: '30 6 * * 3'"))).toBe(true);
    expect(lines.some((l) => /^\s*workflow_dispatch:/.test(l))).toBe(true);
    expect(lines.filter((l) => /cron:/.test(l))).toHaveLength(1);
    expect(lines.some((l) => /^\s*pull_request:/.test(l))).toBe(false);
  });

  it('stages exactly the paths the guard listed, and nothing else', () => {
    const staged = lines.filter((l) => /\bgit add\b/.test(l)).map((l) => l.replace(/^.*\bgit add\s+/, '').trim());
    expect(staged).toEqual(['-- "${patched[@]}"']);
    expect(commitJob).toContain('mapfile -t patched < "${RUNNER_TEMP}/version-floors/patched.txt"');
    expect(stepScript(source, GUARD)).toContain('> "${dir}/patched.txt"');
  });

  it('never stages with a wildcard or commits with -a', () => {
    expect(lines.filter((l) => /\bgit add\s+(-A\b|--all\b|\.(\s|$)|:\/)/.test(l))).toEqual([]);
    expect(lines.filter((l) => /\bgit commit\b[^\n]*\s-(a|am|-all)\b/.test(l))).toEqual([]);
  });

  it('checks for a change with git status --porcelain on the floors file in both jobs', () => {
    const checks = lines.filter((l) => l.includes(FLOORS_PATH) && /\bgit (diff|status)\b/.test(l));
    expect(checks).toHaveLength(2);
    for (const check of checks) expect(check).toContain('git status --porcelain');
  });

  it('runs the updater without installing anything, and hands on a text patch', () => {
    expect(updateJob).toContain('node scripts/update-version-floors.mjs --summary');
    expect(lines.some((l) => /\bnpm (ci|install)\b/.test(l))).toBe(false);
    expect(updateJob).toContain('git diff > "${RUNNER_TEMP}/version-floors/floors.patch"');
    expect(lines.filter((l) => /git diff\b.*--binary/.test(l))).toEqual([]);
  });

  it('judges the patch before it applies it, and applies it before anything else runs', () => {
    const guardAt = commitJob.indexOf(`- name: ${GUARD}`);
    const applyAt = commitJob.indexOf('git apply "${RUNNER_TEMP}/version-floors/floors.patch"');
    const mintAt = commitJob.indexOf('node scripts/github-app-token.mjs');
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(applyAt);
    expect(applyAt).toBeLessThan(mintAt);
  });

  it('masks the App token before writing it anywhere', () => {
    const maskAt = source.indexOf('::add-mask::');
    const writeAt = source.indexOf('token=${token}');
    expect(maskAt).toBeGreaterThan(-1);
    expect(maskAt).toBeLessThan(writeAt);
  });

  it('makes the branch name unique per attempt, not just per run', () => {
    const branchLine = lines.find((l) => l.includes('branch="chore/version-floors-'));
    expect(branchLine).toContain('GITHUB_RUN_ID');
    expect(branchLine).toContain('GITHUB_RUN_ATTEMPT');
  });

  it('opens the pull request ready for review, with the same title as the commit', () => {
    const title = 'chore: move the version floors (checked ${AS_OF})';
    expect(lines.some((l) => l.includes(`git commit -m "${title}"`))).toBe(true);
    expect(lines.some((l) => l.includes(`--title "${title}"`))).toBe(true);
    expect(lines.filter((l) => /--draft\b/.test(l))).toEqual([]);
  });

  it("opens it with the body the updater wrote in the template's sections, not one written here", () => {
    expect(updateJob).toContain('--body "${RUNNER_TEMP}/version-floors/pr-body.md" --run-url');
    expect(commitJob).toContain('--body-file "${RUNNER_TEMP}/version-floors/pr-body.md"');
    expect(lines.filter((l) => /echo "## /.test(l))).toEqual([]);
  });

  it('gives neither job a write permission of its own', () => {
    expect(lines.some((l) => /contents:\s*write/.test(l))).toBe(false);
    expect(lines.some((l) => /id-token:\s*write/.test(l))).toBe(false);
    expect(updateJob).toContain('contents: read');
    expect(commitJob).toContain('contents: read');
    expect(lines.some((l) => /^permissions:\s*\{\}/.test(l))).toBe(true);
  });

  it('reuses the App the other scheduled pull requests use, from the automation environment', () => {
    expect(lines.some((l) => l.includes('vars.MANIFEST_APP_ID'))).toBe(true);
    expect(lines.some((l) => l.includes('secrets.MANIFEST_APP_PRIVATE_KEY'))).toBe(true);
    expect(commitJob).toContain('environment: automation');
    expect(lines.some((l) => l.includes('node scripts/github-app-token.mjs --revoke'))).toBe(true);
  });

  it('pins every action by full commit SHA with a version comment', () => {
    const uses = lines.filter((l) => /^\s*uses:\s/.test(l));
    expect(uses.length).toBeGreaterThan(3);
    for (const line of uses) expect(line, `not pinned by SHA: ${line.trim()}`).toMatch(/@[0-9a-f]{40}\s+#\s*v\d/);
  });

  it('runs the commit job only when the update job reported a change', () => {
    expect(updateJob).toContain('changed: ${{ steps.changed.outputs.changed }}');
    expect(commitJob).toContain("if: needs.update.outputs.changed == 'true'");
    const uploadAt = updateJob.indexOf('uses: actions/upload-artifact');
    const stepStart = updateJob.lastIndexOf('      - name:', uploadAt);
    const uploadStep = updateJob.slice(stepStart);
    expect(uploadStep).toContain("if: steps.changed.outputs.changed == 'true'");
    expect(uploadStep).toContain('path: ${{ runner.temp }}/version-floors/');
  });
});

const run = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', ...options });
// On Windows only a Git Bash (MSYSTEM set) is the bash this script is
// written for; System32's bash is WSL, which cannot see these paths.
const bashUsable =
  (process.platform !== 'win32' || Boolean(process.env.MSYSTEM)) && run('bash', ['-c', 'true']).status === 0;

/** One file's diff: `minus` lines replaced by `plus` lines at the top of the file. */
const diff = (file, minus, plus) =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${minus.length} +1,${plus.length} @@`,
    ...minus.map((l) => `-${l}`),
    ...plus.map((l) => `+${l}`),
  ].join('\n');

const FLOORS = diff(FLOORS_PATH, ['      "floor": "26.8.0",'], ['      "floor": "26.9.0",']);
const ENGINES = (file) => diff(file, ['    "node": ">=26.8.0"'], ['    "node": ">=26.9.0"']);

describe.skipIf(!bashUsable)('the guard, run against patches', () => {
  const script = stepScript(readFileSync(WORKFLOW, 'utf8'), GUARD);
  const dir = mkdtempSync(join(tmpdir(), 'version-floors-guard-'));
  mkdirSync(join(dir, 'version-floors'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const guard = (...diffs) => {
    writeFileSync(join(dir, 'version-floors', 'floors.patch'), `${diffs.join('\n')}\n`);
    const result = run('bash', ['-c', script], { cwd: dir, env: { ...process.env, RUNNER_TEMP: dir }, timeout: 20000 });
    return { status: result.status, out: `${result.stdout}${result.stderr}` };
  };

  it('passes the floors file with engines.node ranges in package files, and lists them for staging', () => {
    const result = guard(FLOORS, ENGINES('scripts/package.json'), diff('scripts/package-lock.json', ['        "node": ">=26.8.0"'], ['        "node": ">=26.9.0"']), ENGINES('package.json'));
    expect(result.out).toContain('Patched:');
    expect(result.status).toBe(0);
    // Compared as a set: `sort` orders by the runner's locale.
    expect(readFileSync(join(dir, 'version-floors', 'patched.txt'), 'utf8').trim().split('\n').sort()).toEqual(
      ['package.json', 'scripts/package-lock.json', 'scripts/package.json', FLOORS_PATH].sort()
    );
  });

  it('refuses a patch that touches a script, a workflow or any other file', () => {
    for (const file of ['scripts/update-version-floors.mjs', '.github/workflows/update-version-floors.yml', 'frontend/.nvmrc']) {
      const result = guard(FLOORS, diff(file, ['a'], ['b']));
      expect(result.status, file).toBe(1);
      expect(result.out, file).toContain('touches files other than the floors file and package manifests');
    }
  });

  it('refuses a package file line that is not an engines.node range, changed or added', () => {
    const type = guard(FLOORS, diff('scripts/package.json', ['  "type": "module",'], ['  "type": "commonjs",']));
    expect(type.status).toBe(1);
    expect(type.out).toContain('a package file line that is not an engines.node range');
    const added = guard(FLOORS, diff('scripts/package.json', ['  "dependencies": {'], ['  "dependencies": {', '    "left-pad": "1.3.0",']));
    expect(added.status).toBe(1);
    const script = guard(FLOORS, diff('scripts/package.json', ['    "node": ">=26.8.0"'], ['    "node": "$(curl x)"']));
    expect(script.status).toBe(1);
  });

  it('refuses a patch that does not move the floors file, or that carries a binary change', () => {
    const noFloors = guard(ENGINES('scripts/package.json'));
    expect(noFloors.status).toBe(1);
    expect(noFloors.out).toContain('does not move scripts/version-floors.json');
    const binary = guard(FLOORS, 'diff --git a/scripts/package.json b/scripts/package.json\nBinary files a/scripts/package.json and b/scripts/package.json differ');
    expect(binary.status).toBe(1);
    expect(binary.out).toContain('binary change');
  });
});
