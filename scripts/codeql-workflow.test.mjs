/**
 * What `codeql.yml` (code scanning) must hold, read as text.
 *
 * Owner decision 2026-11-24 (#1545): CodeQL runs on pull requests again, and
 * skips a language the pull request did not touch. It is NOT a required
 * check. This file holds the parts of that arrangement that are easy to undo
 * by accident:
 *
 * 1. The three triggers: pull requests to `main`, pushes to `main`, and the
 *    weekly schedule. No trigger-level `paths:` filter (the skip is inside
 *    the job, so the job always reports).
 * 2. A run that is not a pull request never skips: the detect step answers
 *    "analyse" before it looks at any file.
 * 3. The skip is per language and skips only the two CodeQL steps, so a
 *    skipped language uploads nothing (an empty upload would close alerts).
 * 4. One run at a time per pull request or branch, so a pull request cannot
 *    cancel a run on `main` or on another pull request.
 * 5. Nothing lets a failure pass as green (`continue-on-error`).
 * 6. The folders the detect step leaves out are the ones the CodeQL settings
 *    file tells CodeQL not to read.
 * 7. The three `Analyze …` names are not on the list the ruleset requires.
 *
 * The detect step itself is run with bash, against a real git repository, in
 * `iac-workflow-steps.test.mjs`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseJobs, parseMatrixRows } from './lib/workflow-text.mjs';
import { RULESET_REQUIRED_CONTEXTS } from './ruleset-contexts.test.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEXT = readFileSync(join(REPO, '.github', 'workflows', 'codeql.yml'), 'utf8').replace(/\r\n/g, '\n');
const CONFIG = readFileSync(join(REPO, '.github', 'codeql', 'codeql-config.yml'), 'utf8').replace(/\r\n/g, '\n');
const JOBS = parseJobs(TEXT);
const ANALYZE = JOBS.find((job) => job.key === 'analyze');
const ROWS = parseMatrixRows(ANALYZE.lines);
const step = (name) => ANALYZE.steps.find((candidate) => candidate.name === name);
/** The lines of the file that are not comments. */
const CODE = TEXT.split('\n').filter((line) => !/^\s*#/.test(line));

describe('codeql.yml: when it runs (owner decision 2026-11-24, #1545)', () => {
  const triggers = TEXT.slice(TEXT.indexOf('\non:\n') + 1, TEXT.indexOf('\npermissions:'));

  it('runs on pull requests to main, on pushes to main and on a weekly schedule, and on nothing else', () => {
    expect(triggers).toContain('  pull_request:\n    branches: [main]\n');
    expect(triggers).toContain('  push:\n    branches: [main]\n');
    expect(triggers).toMatch(/\n {2}schedule:\n {4}(?:#.*\n {4})*- cron: '\d+ \d+ \* \* [0-6]'\n/);
    expect(triggers.split('\n').filter((line) => /^ {2}[a-z_]+:/.test(line))).toEqual(['  pull_request:', '  push:', '  schedule:']);
  });

  it('never uses pull_request_target, and filters no trigger by path', () => {
    // pull_request_target would run a fork's code with a token that can write. A `paths:` filter on the trigger
    // would make the job vanish from a pull request that matches nothing, not report a skip.
    expect(CODE.join('\n')).not.toContain('pull_request_target');
    expect(triggers.split('\n').filter((line) => /^\s*paths(-ignore)?:/.test(line))).toEqual([]);
  });
});

describe('codeql.yml: the job and its steps', () => {
  it('has one job, with the three languages and the names the checks have always had', () => {
    expect(JOBS.map((job) => job.key)).toEqual(['analyze']);
    expect(ANALYZE.lines.find((line) => /^ {4}name:/.test(line))).toBe('    name: Analyze ${{ matrix.language }}');
    expect(ROWS.map((row) => row.language)).toEqual(['javascript-typescript', 'actions', 'python']);
    for (const row of ROWS) expect(() => new RegExp(row.filter), `${row.language}: the filter must be a pattern`).not.toThrow();
    expect(ANALYZE.lines).toContain('      fail-fast: false');
  });

  it('runs four steps in order: checkout with full history, detect, init, analyze', () => {
    expect(ANALYZE.steps.map((candidate) => candidate.name)).toEqual(['Checkout repository', 'Detect language changes', 'Initialize CodeQL', 'Perform CodeQL analysis']);
    // The detect step compares the pull request with its base commit; a shallow checkout does not have that commit.
    const checkout = TEXT.slice(TEXT.indexOf('- name: Checkout repository'), TEXT.indexOf('- name: Detect language changes'));
    expect(checkout).toMatch(/\n {10}persist-credentials: false\n/);
    expect(checkout).toMatch(/\n {10}fetch-depth: 0\n/);
  });

  it('a run that is not a pull request never skips: the detect step answers "analyse" before it reads any file', () => {
    const lines = step('Detect language changes')
      .run.split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
    expect(lines.slice(0, 6)).toEqual([
      'set -euo pipefail',
      'if [ "${GITHUB_EVENT_NAME}" != "pull_request" ]; then',
      'echo "relevant=true" >> "$GITHUB_OUTPUT"',
      'echo "non-pull_request event — analysing everything"',
      'exit 0',
      'fi',
    ]);
    // The only way to write relevant=false is the one branch that follows a grep answer of 1.
    expect(lines.filter((line) => line.includes('relevant=false'))).toHaveLength(1);
    expect(lines[lines.findIndex((line) => line.includes('relevant=false')) - 1]).toBe('elif [ "${status}" -eq 1 ]; then');
  });

  it('the skip covers the two CodeQL steps and nothing else, so a skipped language uploads nothing', () => {
    const condition = "steps.changes.outputs.relevant == 'true'";
    expect(step('Checkout repository').if).toBeUndefined();
    expect(step('Detect language changes').if).toBeUndefined();
    expect(step('Detect language changes').id).toBe('changes');
    expect(step('Initialize CodeQL').if).toBe(condition);
    expect(step('Perform CodeQL analysis').if).toBe(condition);
    // No job-level `if:` either: the job reports on every pull request.
    expect(ANALYZE.lines.filter((line) => /^ {4}if:/.test(line))).toEqual([]);
    // And the analysis is not told to upload an empty or partial result some other way.
    expect(CODE.filter((line) => /^\s*(upload|skip-queries|upload-database):/.test(line))).toEqual([]);
  });

  it('nothing lets a failure pass as green, and every action is pinned to a full commit', () => {
    expect(CODE.filter((line) => line.includes('continue-on-error'))).toEqual([]);
    const uses = CODE.filter((line) => /^\s*(- )?uses:/.test(line));
    expect(uses).toHaveLength(3);
    for (const line of uses) expect(line).toMatch(/uses: (actions\/checkout|github\/codeql-action\/(init|analyze))@[0-9a-f]{40} # v\d+$/);
    const sha = (name) => uses.find((line) => line.includes(name)).match(/@([0-9a-f]{40})/)[1];
    expect(sha('codeql-action/init'), 'init and analyze must be the same release of the CodeQL action').toBe(sha('codeql-action/analyze'));
  });

  it('the only permission that writes is the one that uploads results, and it is on the job', () => {
    expect(TEXT).toContain('\npermissions:\n  contents: read\n\n');
    const perms = ANALYZE.lines.slice(ANALYZE.lines.findIndex((line) => line === '    permissions:') + 1);
    const granted = perms
      .slice(0, perms.findIndex((line) => /^ {4}\S/.test(line)))
      .filter((line) => !/^\s*#/.test(line))
      .map((line) => line.trim().replace(/\s+#.*$/, ''));
    expect(granted).toEqual(['security-events: write', 'contents: read', 'actions: read']);
  });
});

describe('codeql.yml: one run at a time per pull request or branch', () => {
  it('groups runs by the ref, so a pull request cannot cancel a run on main or on another pull request', () => {
    const block = TEXT.slice(TEXT.indexOf('\nconcurrency:\n') + 1, TEXT.indexOf('\njobs:'));
    expect(block).toBe('concurrency:\n  group: codeql-${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: true\n');
    // github.ref is refs/pull/<number>/merge on a pull request and refs/heads/main on a push or the schedule,
    // so the group differs between any two pull requests and between a pull request and main.
    const group = (ref) => `codeql-CodeQL-${ref}`;
    const refs = ['refs/pull/1/merge', 'refs/pull/2/merge', 'refs/heads/main'];
    expect(new Set(refs.map(group)).size).toBe(refs.length);
  });
});

describe('codeql.yml: the folders the detect step leaves out are the ones CodeQL is told not to read', () => {
  it('IGNORED names exactly the paths-ignore entries of .github/codeql/codeql-config.yml', () => {
    const lines = CONFIG.split('\n');
    const start = lines.indexOf('paths-ignore:');
    expect(start, 'paths-ignore: was not found in the CodeQL settings file').toBeGreaterThan(-1);
    const ignored = [];
    for (const line of lines.slice(start + 1)) {
      const entry = line.match(/^ {2}- '([^']+)'$/);
      if (!entry) break;
      ignored.push(entry[1]);
    }
    expect(ignored.length).toBeGreaterThan(0);
    // The settings file has no `paths:` list, so everything outside paths-ignore is read.
    expect(lines.filter((line) => /^paths:/.test(line))).toEqual([]);
    for (const folder of ignored) expect(folder, 'this test reads folders that start with a dot; widen it for another shape').toMatch(/^\.[a-z]+$/);
    expect(step('Detect language changes').env.IGNORED).toBe(`^\\.(${ignored.map((folder) => folder.slice(1)).join('|')})/`);
  });
});

describe('codeql.yml: not a required check (owner decision 2026-11-24)', () => {
  it('none of its check names is on the list the ruleset requires', () => {
    for (const row of ROWS) expect(RULESET_REQUIRED_CONTEXTS).not.toContain(`Analyze ${row.language}`);
    expect(RULESET_REQUIRED_CONTEXTS.filter((context) => /codeql|analyze/i.test(context))).toEqual([]);
  });
});
