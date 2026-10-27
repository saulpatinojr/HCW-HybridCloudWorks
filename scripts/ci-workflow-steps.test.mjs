/**
 * The shell and the step order in `.github/workflows/ci.yml`, run and read for
 * real (#1428).
 *
 * `ci-filters.test.mjs` checks that every job's `filter` (a pattern for file
 * paths: the job runs on a pull request only when the pull request changes a
 * file the pattern matches) lists the files its tests read. Two things it
 * cannot see are checked here instead.
 *
 * ## 1. A filter that `grep` cannot read must stop the job, not switch it off
 *
 * Each job decides whether it is needed in a "change detection" step that runs
 * `grep -E` with the filter over the list of changed files. `grep` answers 0
 * (a changed file matches), 1 (none does) or 2 (it could not read the pattern,
 * for example because a parenthesis is never closed). Written as
 * `if grep -qE ...; then`, the 2 counts as "no", the job is skipped as "no
 * relevant change", and the pull request looks green. The steps now keep the
 * answer and fail the step on anything but 0 or 1.
 *
 * This file takes each such step's shell out of ci.yml, runs it with bash
 * against a small git repository it makes in the temporary folder, and looks
 * at the exit code, the `relevant=` line the step writes for the later steps,
 * and what it says. It does this with the job's real filter (a match, no
 * match) and with deliberately broken ones.
 *
 * ## 2. The path-filter guard must run on every pull request
 *
 * The guard lives in the scripts package. Its row only runs the tests when
 * the pull request changes something that row's filter matches, so a pull
 * request that changed only a frontend or functions test did not run the
 * guard until after the merge. The step "CI path filters list every file the
 * tests read" runs the guard on every pull request, outside the filter, as the
 * two checks next to it already do (see oidc-subjects.test.mjs). The tests
 * below read ci.yml to make sure nothing can put a filter in front of that
 * step: not the workflow trigger, not the job, not the step's own condition.
 * They also work out, for a pull request that changes only one frontend test
 * file, which steps of each row would run.
 *
 * Needs bash, git and grep on the path. Where one is missing the tests that
 * run the shell are skipped, and their names say so; on GitHub Actions a test
 * fails if they are missing, so the shell tests cannot go quiet in CI.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMPONENTS } from './lib/ci-filters.mjs';
// Jobs, steps and matrix rows are cut out of the workflow text by their indentation (shared with codeql-iac-workflow-steps.test.mjs).
import { findBashTools, parseJobs, parseMatrixRows } from './lib/workflow-text.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CI = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r\n/g, '\n');

const GUARD_STEP = 'CI path filters list every file the tests read';
const SCRIPTS_ROW = 'scripts (operations)';

const JOBS = parseJobs(CI);
const VERIFY = JOBS.find((job) => job.key === 'verify');
const ROWS = parseMatrixRows(VERIFY.lines);
const scriptsRow = ROWS.find((row) => row.name === SCRIPTS_ROW);

/** The change-detection steps: every step that diffs against the base. */
const DETECT_STEPS = JOBS.flatMap((job) => job.steps.filter((step) => step.run?.includes('git diff --name-only')).map((step) => ({ job: job.key, step })));

/**
 * Where a path that matches each non-matrix step's real filter lives. The
 * matrix step takes one from the row's folder. A step this table does not
 * know fails the test that needs it, so a new one is noticed.
 */
const MATCHING_PATH = {
  'ansible-lint': 'lab-host/ansible/site.yml',
  'coder-template': 'lab-host/coder/compose.yaml',
  harness: 'hooks/claude_event.py',
};

/** One entry per time a detection step runs: the matrix step once per row. */
const ENTRIES = DETECT_STEPS.flatMap(({ job, step }) => {
  if (step.env.FILTER === '${{ matrix.filter }}') {
    return ROWS.map((row) => ({ job, step, row, label: `${job} / ${row.name}`, filter: row.filter, path: `${row.dir}/zz-probe.txt` }));
  }
  return [{ job, step, label: `${job} / ${step.name}`, filter: step.env.FILTER, path: MATCHING_PATH[job] }];
});
/** The same, with the matrix step once: for what does not depend on the row's filter. */
const DISTINCT = ENTRIES.filter((entry, i) => ENTRIES.findIndex((other) => other.step === entry.step) === i);
const byLabel = (entries) => entries.map((entry) => [`${entry.job}: ${entry.step.name}`, entry]);

/**
 * Evaluates the conditions ci.yml writes in `if:`: `==` and `!=` between a
 * context value (matrix.name, steps.changes.outputs.relevant) and a quoted
 * string, joined with `&&` and `||`. Anything else throws, so a condition
 * this cannot read is noticed rather than guessed.
 */
function evaluate(condition, context) {
  const value = (token) => {
    const text = token.trim();
    const literal = text.match(/^'([^']*)'$/);
    if (literal) return literal[1];
    if (/^[A-Za-z]+(\.[A-Za-z-]+)*$/.test(text)) return text.split('.').reduce((object, key) => object?.[key], context) ?? '';
    throw new Error(`cannot evaluate "${text}" in "${condition}"`);
  };
  const comparison = (part) => {
    const found = part.match(/^(.+?)\s*(==|!=)\s*(.+)$/);
    if (!found) throw new Error(`cannot evaluate "${part}" in "${condition}"`);
    const same = value(found[1]) === value(found[3]);
    return found[2] === '==' ? same : !same;
  };
  return condition.split('||').some((alternative) => alternative.split('&&').every(comparison));
}

/**
 * The names of the steps of the `verify` job that run for `row` when the
 * change-detection step wrote `relevant=<relevant>`. Every step before them
 * is taken to have passed (GitHub adds `success() &&` to a condition that has
 * no status check of its own). Only the steps this file is about are worked
 * out; the others are left out of the answer.
 */
function stepsThatRun(row, relevant) {
  const context = { matrix: row, steps: { changes: { outputs: { relevant } } } };
  const wanted = new Set(['Install (lockfile-strict)', GUARD_STEP, 'Test']);
  return VERIFY.steps.filter((step) => wanted.has(step.name) && (step.if === undefined || evaluate(step.if.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), context))).map((step) => step.name);
}

// ---------------------------------------------------------------------------
// 1. What the change-detection steps are made of, read as text.
// ---------------------------------------------------------------------------
describe('ci.yml change-detection steps: what they are made of (#1428)', () => {
  it('finds the matrix rows and the four change-detection steps (a quiet parse would make every test below pass for nothing)', () => {
    expect(ROWS.map((row) => row.dir)).toEqual(COMPONENTS.map((component) => component.dir));
    expect(DETECT_STEPS.map(({ job, step }) => `${job}: ${step.name}`)).toEqual([
      'verify: Detect component changes',
      'ansible-lint: Detect lab-host changes',
      'coder-template: Detect lab-host/coder changes',
      'harness: Detect harness changes',
    ]);
    expect(ENTRIES).toHaveLength(ROWS.length + 3);
  });

  it('no step in ci.yml decides with `if grep`, because grep answering 2 would read as "no"', () => {
    const offenders = [];
    for (const job of JOBS) {
      for (const step of job.steps) {
        for (const line of (step.run ?? '').split('\n')) {
          if (/^\s*(if|elif|while|until)\s+!?\s*grep\b/.test(line)) offenders.push(`${job.key} / ${step.name}: ${line.trim()}`);
        }
      }
    }
    expect(
      offenders,
      'These steps test grep inside an `if`. grep exits 2 when it cannot read its pattern, and `if` takes that as "no match", so a broken filter ' +
        'would skip the job. Keep the exit status instead (status=0; grep ... || status=$?) and fail the step on anything but 0 or 1, as the ' +
        'change-detection steps do:\n  ' +
        offenders.join('\n  ')
    ).toEqual([]);
  });

  it.each(DETECT_STEPS.map(({ job, step }) => [`${job}: ${step.name}`, step]))('%s takes its filter from FILTER', (_label, step) => {
    expect(step.env.FILTER, 'the step has no FILTER in its env: block').toBeTruthy();
    expect(step.run).toContain('"(${FILTER})"');
  });

  it('the lines that decide are the same in every step, so a reader meets them once', () => {
    const decisive = (step) =>
      step.run
        .split('\n')
        .filter((line) => !/^\s*#/.test(line) && /\bstatus\b|grep -qE|::error /.test(line))
        .map((line) => line.trim());
    const [first, ...others] = DETECT_STEPS.map(({ step }) => decisive(step));
    expect(first.length, 'no deciding lines found in the first step').toBeGreaterThanOrEqual(5);
    for (const other of others) expect(other).toEqual(first);
  });

  it('says in the failure message which job and which filter could not be read', () => {
    for (const { step } of DETECT_STEPS) {
      const error = step.run.split('\n').find((line) => line.includes('::error '));
      expect(error, `no ::error line in ${step.name}`).toBeDefined();
      // The annotation points at ci.yml and has a title, so the failed check shows where to look.
      expect(error).toContain('file=.github/workflows/ci.yml,title=Path filter could not be read::');
      expect(error).toContain('${GITHUB_JOB}');
      expect(error).toContain('${FILTER}');
    }
  });
});

// ---------------------------------------------------------------------------
// 1 (continued). The same steps, run with bash.
// ---------------------------------------------------------------------------
const TOOLS = findBashTools();
const SKIPPED = TOOLS.ready ? '' : ` (SKIPPED here: ${TOOLS.why}; they run on GitHub Actions)`;
const forward = (path) => path.replace(/\\/g, '/');

describe('ci.yml change-detection steps: bash is there', () => {
  it.skipIf(process.env.GITHUB_ACTIONS !== 'true')('on GitHub Actions bash, git and grep are present, so the shell tests below run', () => {
    expect(TOOLS.ready, TOOLS.why).toBe(true);
  });
});

describe.skipIf(!TOOLS.ready)(`ci.yml change-detection steps: run with bash${SKIPPED}`, () => {
  let work;
  let repo;
  let outputs;
  let baseSha;
  let counter = 0;

  /** The environment of a child process: ours, without git's own variables (a git hook sets some) and the ones the steps read. */
  function cleanEnv(extra) {
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
      if (name.startsWith('GIT_') || name === 'FILTER' || name === 'BASE_SHA') delete env[name];
    }
    return { ...env, ...extra };
  }

  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'user.email=test@example.invalid', '-c', 'user.name=test', ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: cleanEnv({}),
    });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };

  /** A commit on top of `base` that adds `files`, tagged `tag`: the head of a pull request that changes only them. */
  const commit = (tag, files) => {
    git('checkout', '-q', '--detach', 'base');
    for (const file of files) {
      mkdirSync(dirname(join(repo, file)), { recursive: true });
      writeFileSync(join(repo, file), `${tag}\n`);
    }
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', tag);
    git('tag', tag);
  };

  beforeAll(() => {
    work = forward(mkdtempSync(join(tmpdir(), 'ci-steps-')));
    repo = `${work}/repo`;
    outputs = `${work}/outputs`;
    mkdirSync(repo);
    mkdirSync(outputs);
    git('init', '-q');
    writeFileSync(join(repo, 'README.md'), 'base\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'base');
    git('tag', 'base');
    baseSha = git('rev-parse', 'base');
    // One commit per path, so a test learns whether the step's OWN filter matched its OWN path.
    ENTRIES.forEach((entry, i) => {
      if (entry.path) commit(`probe-${i}`, [entry.path]);
    });
    commit('unrelated', ['notes/zz-unrelated.txt']);
    commit('workflow', ['.github/workflows/ci.yml']);
    commit('frontend-test-only', ['frontend/src/x.test.jsx']);
  }, 60_000);

  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  /** Run the step's shell the way a runner does (`bash -e`), on the commit `tag`, as a pull request whose base is `base`. */
  function run(entry, { tag, filter = entry.filter, base = baseSha, event = 'pull_request' }) {
    git('checkout', '-q', '--detach', tag);
    const output = `${outputs}/out-${(counter += 1)}.txt`;
    const result = spawnSync('bash', ['-e', '-c', entry.step.run], {
      cwd: repo,
      encoding: 'utf8',
      env: cleanEnv({ GITHUB_EVENT_NAME: event, GITHUB_JOB: entry.job, GITHUB_OUTPUT: output, BASE_SHA: base, FILTER: filter }),
    });
    return { status: result.status, log: `${result.stdout}${result.stderr}`, written: existsSync(output) ? readFileSync(output, 'utf8') : '' };
  }
  const probeTag = (entry) => `probe-${ENTRIES.indexOf(entry)}`;

  describe('with the real filters', () => {
    it.each(ENTRIES.map((entry) => [entry.label, entry]))('%s: a changed file the filter matches means relevant=true', (_label, entry) => {
      expect(entry.path, `no path that matches the filter of "${entry.job}" is named in MATCHING_PATH`).toBeTruthy();
      expect(new RegExp(entry.filter).test(entry.path), `${entry.path} should match the filter ${entry.filter}`).toBe(true);
      const result = run(entry, { tag: probeTag(entry) });
      expect(result.status, result.log).toBe(0);
      expect(result.written).toBe('relevant=true\n');
    });

    it.each(ENTRIES.map((entry) => [entry.label, entry]))('%s: a changed file the filter does not match means relevant=false', (_label, entry) => {
      expect(new RegExp(entry.filter).test('notes/zz-unrelated.txt')).toBe(false);
      const result = run(entry, { tag: 'unrelated' });
      expect(result.status, result.log).toBe(0);
      expect(result.written).toBe('relevant=false\n');
    });
  });

  describe('a filter grep cannot read stops the job and says which one', () => {
    // Each of these makes grep -E exit 2 (GNU grep and the BSD grep on a Mac alike). The last one ends in a
    // backslash, which would join onto the `|` added after the filter if the filter were not put in brackets.
    const BROKEN = ['^(unclosed', '[a-', 'a\\'];

    it.each(byLabel(DISTINCT))('%s', (_label, entry) => {
      for (const filter of BROKEN) {
        // On a commit no filter matches, the old `if grep` answered "no" and wrote relevant=false.
        const result = run(entry, { tag: 'unrelated', filter });
        expect(result.status, `filter ${filter}: the step must fail\n${result.log}`).not.toBe(0);
        expect(result.written, `filter ${filter}: the step must not write relevant=...`).toBe('');
        expect(result.log, `filter ${filter}: the message must name the filter`).toContain(`The filter: ${filter}`);
        expect(result.log, `filter ${filter}: the message must name the job`).toContain(`job ${entry.job}`);
        expect(result.log).toMatch(/could not read the path filter/);
      }
    });
  });

  describe('everything else the steps did before is unchanged', () => {
    it.each(byLabel(DISTINCT))('%s: ci.yml itself is always relevant, whatever the filter says', (_label, entry) => {
      const result = run(entry, { tag: 'workflow', filter: '^zz-nothing-matches-this$' });
      expect(result.status, result.log).toBe(0);
      expect(result.written).toBe('relevant=true\n');
    });

    it.each(byLabel(DISTINCT))('%s: a base commit that cannot be fetched means run everything', (_label, entry) => {
      const result = run(entry, { tag: 'unrelated', base: '0'.repeat(40) });
      expect(result.status, result.log).toBe(0);
      expect(result.written).toBe('relevant=true\n');
      expect(result.log).toContain('could not compute the diff');
    });

    it.each(byLabel(DISTINCT))('%s: a push to main runs everything', (_label, entry) => {
      const result = run(entry, { tag: 'unrelated', event: 'push' });
      expect(result.status, result.log).toBe(0);
      expect(result.written).toBe('relevant=true\n');
      expect(result.log).toContain('non-pull_request event');
    });
  });

  // 2 (continued). The real change-detection step, then the conditions of the steps after it.
  describe('a pull request that changes only frontend/src/x.test.jsx', () => {
    const matrixEntries = ENTRIES.filter((entry) => entry.job === 'verify');

    it.each(matrixEntries.map((entry) => [entry.row.name, entry]))('%s: reaches the guard step if and only if it is the scripts row, whatever its filter says', (_name, entry) => {
      const detected = run(entry, { tag: 'frontend-test-only' });
      expect(detected.status, detected.log).toBe(0);
      const relevant = detected.written.trim().replace('relevant=', '');
      expect(['true', 'false']).toContain(relevant);
      const ran = stepsThatRun(entry.row, relevant);
      expect(ran.includes(GUARD_STEP)).toBe(entry.row.name === SCRIPTS_ROW);
      // The row's own tests run exactly when its filter matched the file.
      expect(ran.includes('Test')).toBe(relevant === 'true');
    });
  });
});

// ---------------------------------------------------------------------------
// 2. The guard runs on every pull request.
// ---------------------------------------------------------------------------
describe('the path-filter guard runs on every pull request (#1428)', () => {
  const guard = VERIFY.steps.find((step) => step.name === GUARD_STEP);

  it('has a step for it, once, running only the guard test, from the scripts folder', () => {
    expect(VERIFY.steps.filter((step) => step.name === GUARD_STEP)).toHaveLength(1);
    expect(guard.run).toBe('npx vitest run ci-filters.test.mjs');
    expect(existsSync(join(REPO, 'scripts', 'ci-filters.test.mjs'))).toBe(true);
    expect(guard['working-directory'], 'the step must use the job default, the matrix row folder').toBeUndefined();
    expect(scriptsRow.dir).toBe('scripts');
  });

  it('is outside the filter: its condition is the row alone and never reads what change detection wrote', () => {
    // The point of the step. Gated on the filter it would skip the pull request
    // that changed only a frontend test, which is the one that needs it.
    expect(guard.if).toBe(`matrix.name == '${SCRIPTS_ROW}'`);
    expect(guard.if).not.toMatch(/steps\.changes|relevant/);
  });

  it('has Node.js set up and the packages installed before it, on every pull request', () => {
    const node = VERIFY.steps.find((step) => step.name === 'Set up Node.js');
    const install = VERIFY.steps.find((step) => step.name === 'Install (lockfile-strict)');
    expect(install.run).toBe('npm ci');
    for (const step of [node, install]) {
      expect(step.if, `${step.name} must run for the scripts row whatever change detection says`).toContain(`matrix.name == '${SCRIPTS_ROW}'`);
      expect(VERIFY.steps.indexOf(step)).toBeLessThan(VERIFY.steps.indexOf(guard));
    }
  });

  it('cannot be switched off from outside: the job has no `if`, and the pull_request trigger has no path, branch or type filter', () => {
    expect(VERIFY.lines.filter((line) => /^ {4}if:/.test(line))).toEqual([]);
    // `pull_request:` stands alone on its line and nothing is nested under it (no `paths:`, `branches:` or
    // `types:`): the line after it is the next trigger. The `push:` trigger beside it may have its own `branches:`.
    const lines = CI.slice(CI.indexOf('\non:\n') + 1, CI.indexOf('\npermissions:')).split('\n');
    const at = lines.findIndex((line) => /^ {2}pull_request:\s*$/.test(line));
    expect(at, 'the workflow has no pull_request trigger written as a bare `pull_request:`').toBeGreaterThan(-1);
    expect(lines[at + 1], 'something is nested under pull_request:').toMatch(/^ {2}push:/);
  });

  it('is enforced: nothing lets the step, or the job, fail without failing the check, and no `shell:` changes how a step is run', () => {
    // `continue-on-error` would turn a failing guard into a green check.
    expect(guard['continue-on-error'], 'the guard step must not continue on error').toBeUndefined();
    expect(VERIFY.lines.filter((line) => /^ {4}continue-on-error:/.test(line)), 'the verify job must not continue on error').toEqual([]);
    // The shell tests above run each step's text with `bash -e`, which is what a step with no `shell:` gets on
    // the runner. A `shell:` key at any level (a step, a job's defaults, the workflow's defaults) could change that.
    expect(CI.split('\n').filter((line) => /^\s*(- )?shell:/.test(line)), 'ci.yml sets a shell').toEqual([]);
  });

  it('runs the guard for the scripts row whichever way change detection answered, and for no other row', () => {
    for (const row of ROWS) {
      for (const relevant of ['true', 'false']) {
        expect(stepsThatRun(row, relevant).includes(GUARD_STEP), `${row.name} with relevant=${relevant}`).toBe(row.name === SCRIPTS_ROW);
      }
    }
  });

  it('leaves the scripts row running its whole suite, which includes the guard again, when change detection says it is needed', () => {
    expect(scriptsRow.test).toBe('npm test');
    expect(stepsThatRun(scriptsRow, 'true')).toEqual(['Install (lockfile-strict)', GUARD_STEP, 'Test']);
    expect(stepsThatRun(scriptsRow, 'false')).toEqual(['Install (lockfile-strict)', GUARD_STEP]);
  });
});
