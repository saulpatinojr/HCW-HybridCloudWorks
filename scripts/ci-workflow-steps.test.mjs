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
 * ## 3. Every job that runs repository code has a time limit (#1441)
 *
 * A job with no `timeout-minutes` gets GitHub's default of six hours. A test
 * that loops forever (an import cycle the path-filter guard fails to notice,
 * say) never gives control back to vitest, so vitest's own timeout cannot
 * stop it, and the pull request sits on "pending" for hours instead of going
 * red. The last part of this file reads every workflow in
 * `.github/workflows/` and fails when a job that checks out this repository
 * and then runs a shell step has no limit of its own. A job that opens a
 * firewall window in Azure and closes it in an `always()` step also needs a
 * limit on each step up to the close, adding up to less than the job's limit,
 * so the job's limit can never cancel it while a window is open (3b).
 *
 * Needs bash, git and grep on the path. Where one is missing the tests that
 * run the shell are skipped, and their names say so; on GitHub Actions a test
 * fails if they are missing, so the shell tests cannot go quiet in CI.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMPONENTS } from './lib/ci-filters.mjs';
// Jobs, steps and matrix rows are cut out of the workflow text by their indentation (shared with codeql-iac-workflow-steps.test.mjs).
import { findBashTools, GIT_TEST_CONFIG, parseJobs, parseMatrixRows } from './lib/workflow-text.mjs';

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
    const result = spawnSync('git', [...GIT_TEST_CONFIG, ...args], {
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

// ---------------------------------------------------------------------------
// 3. Every job that runs repository code has a time limit (#1441).
// ---------------------------------------------------------------------------
const WORKFLOWS = join(REPO, '.github', 'workflows');

/**
 * The rule for "runs repository code": the job checks out a repository
 * (`actions/checkout`) and has a `run:` step after that. A shell step after a
 * checkout can run anything the checkout brought in, so it can hang. A job
 * made only of other actions, or one that never checks out, is left out, and
 * every job left out today is named in LEFT_OUT below with the reason.
 */
export function runsRepositoryCode(job) {
  const checkout = job.steps.findIndex((step) => /^actions\/checkout@/.test(step.uses ?? ''));
  return checkout !== -1 && job.steps.slice(checkout + 1).some((step) => step.run !== undefined);
}

/** The job's own `timeout-minutes` as a number, or undefined when it has none (or it is not a plain number). */
export function timeoutMinutes(job) {
  const line = job.lines.find((text) => /^ {4}timeout-minutes:/.test(text));
  if (!line) return undefined;
  const value = line.replace(/^ {4}timeout-minutes:\s*/, '').replace(/\s+#.*$/, '').trim();
  return /^\d+$/.test(value) ? Number(value) : Number.NaN;
}

/**
 * The jobs the rule above does not cover, by `file / job`, each with the
 * reason. The test fails if a job joins or leaves this set without the list
 * changing too, so a job that slips outside the rule is noticed and argued
 * for, not missed.
 */
const LEFT_OUT = new Map([
  ['addon-image-scout.yml / scout', 'Never checks out this repository: it only reads the published images. It has its own limit anyway (15 minutes).'],
  ['dependency-review.yml / dependency-review', 'Its only step after the checkout is the dependency-review action; there is no shell step that runs code from this repository.'],
  ['docs-pages.yml / deploy', 'Never checks out the repository: it hands the site the build job made to the Pages deploy action, with no shell step.'],
]);

/** GitHub-hosted runners stop a job after six hours whatever it asks for; Copilot's setup job allows at most 59 minutes. */
const MAX_MINUTES = 360;
const COPILOT_MAX_MINUTES = 59;

describe('every job that runs repository code has a time limit (#1441)', () => {
  const FILES = readdirSync(WORKFLOWS)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
  const JOBS_BY_FILE = FILES.map((name) => [name, parseJobs(readFileSync(join(WORKFLOWS, name), 'utf8').replace(/\r\n/g, '\n'))]);
  const ALL = JOBS_BY_FILE.flatMap(([name, jobs]) => jobs.map((job) => ({ label: `${name} / ${job.key}`, name, job })));

  it('finds the workflow files and their jobs (a quiet read would make the checks below pass for nothing)', () => {
    expect(FILES.length).toBeGreaterThan(20);
    for (const [name, jobs] of JOBS_BY_FILE) expect(jobs.length, `${name} has no jobs the parser can see`).toBeGreaterThan(0);
    expect(ALL.filter(({ job }) => runsRepositoryCode(job)).length).toBeGreaterThan(30);
  });

  it('reads the rule the way it is written', () => {
    const job = (steps, lines = []) => ({ steps, lines });
    const checkout = { uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1' };
    expect(runsRepositoryCode(job([checkout, { run: 'npm test' }]))).toBe(true);
    expect(runsRepositoryCode(job([checkout, { uses: 'actions/setup-node@x' }, { run: 'npm ci' }]))).toBe(true);
    expect(runsRepositoryCode(job([checkout, { uses: 'actions/dependency-review-action@x' }]))).toBe(false);
    expect(runsRepositoryCode(job([{ run: 'curl -fsS https://example.invalid' }]))).toBe(false);
    expect(runsRepositoryCode(job([{ run: 'echo before' }, checkout]))).toBe(false);
    expect(timeoutMinutes(job([], ['    runs-on: ubuntu-26.04', '    timeout-minutes: 20 # slowest 3 min']))).toBe(20);
    expect(timeoutMinutes(job([], ['    # timeout-minutes: 20', '        timeout-minutes: 5']))).toBeUndefined();
    expect(timeoutMinutes(job([], ['    timeout-minutes: ${{ matrix.limit }}']))).toBeNaN();
  });

  it.each(ALL.filter(({ job }) => runsRepositoryCode(job)).map(({ label, name, job }) => [label, name, job]))(
    '%s has a timeout-minutes of its own',
    (label, name, job) => {
      const minutes = timeoutMinutes(job);
      expect(
        minutes,
        `${label} checks out the repository and runs a shell step, but has no \`timeout-minutes:\` on the job. Without one a stuck step ` +
          'holds the runner for GitHub\'s default of six hours and the check shows "pending" instead of failing. Add `timeout-minutes:` under ' +
          '`runs-on:`, a few times the slowest normal run of the job (look it up in the Actions tab first), as a plain number.'
      ).toBeDefined();
      expect(Number.isInteger(minutes) && minutes > 0, `${label}: timeout-minutes must be a plain whole number of minutes`).toBe(true);
      const cap = name === 'copilot-setup-steps.yml' ? COPILOT_MAX_MINUTES : MAX_MINUTES;
      expect(minutes, `${label}: ${minutes} minutes is more than the ${cap} allowed, so it would not be the limit that applies`).toBeLessThanOrEqual(cap);
    }
  );

  it('leaves out exactly the jobs listed with a reason (a job slipping outside the rule is noticed)', () => {
    const outside = ALL.filter(({ job }) => !runsRepositoryCode(job)).map(({ label }) => label).sort();
    expect(outside).toEqual([...LEFT_OUT.keys()].sort());
    for (const [label, why] of LEFT_OUT) expect(why.length, `${label} needs a reason`).toBeGreaterThan(40);
  });
});

// ---------------------------------------------------------------------------
// 3b. A job that opens a firewall window reaches its close steps before its own limit (#1441).
// ---------------------------------------------------------------------------
/**
 * Some jobs add a temporary allow rule for the runner in Azure (a "window":
 * the storage firewall, the SCM site, the site itself) and remove it in a
 * later step that runs with `always()`. If the job's own `timeout-minutes`
 * ran out while a window was open, GitHub would cancel the job, and its
 * documentation does not promise the close step gets to finish then (see the
 * pull request for #1441). A step's own `timeout-minutes` is different: it
 * fails that one step and the job carries on, so the `always()` steps run as
 * after any failure.
 *
 * So in such a job, every step up to and including the last close step has a
 * limit of its own, and those limits add up to less than the job's limit with
 * WINDOW_MARGIN minutes to spare (for setting up the job and the steps GitHub
 * adds). Then a stuck step is stopped by its own limit, never by the job's,
 * and the windows are closed before the job's clock can run out.
 *
 * Each step that adds a rule also writes the output its close step needs
 * (the rule's name, or the runner's address) BEFORE the add, and each close
 * step checks the rule is there before removing it. Otherwise an add that
 * succeeded in Azure and then hung until the step's limit stopped it would
 * leave the rule with no close step to remove it.
 */
const WINDOW_MARGIN = 5;
const isWindowClose = (step) => /\bclose\b.*\bwindow\b/i.test(step.name ?? '') && /\balways\(\)/.test(step.if ?? '');
/** A shell line that adds an allow rule in Azure: the thing a window-close step must undo. */
const OPENS_A_RULE = /\baz\s+(?:functionapp\s+config\s+access-restriction|storage\s+account\s+network-rule)\s+add\b/;

const REMOVES_A_RULE = /\baz\s+(?:functionapp\s+config\s+access-restriction|storage\s+account\s+network-rule)\s+remove\b/;
const LOOKS_FOR_A_RULE = /\baz\s+(?:functionapp\s+config\s+access-restriction\s+show|storage\s+account\s+network-rule\s+list)\b/;

/** Whether a step's shell writes to $GITHUB_OUTPUT on a line before its first `az … add` line. */
export function firstOutputBeforeAdd(run) {
  const lines = String(run).split('\n');
  const add = lines.findIndex((line) => OPENS_A_RULE.test(line));
  const output = lines.findIndex((line) => !/^\s*#/.test(line) && /\$\{?GITHUB_OUTPUT\b/.test(line));
  return add !== -1 && output !== -1 && output < add;
}

/** A step's own `timeout-minutes` as a number, or undefined; NaN when it is not a plain whole number. */
export function stepTimeoutMinutes(step) {
  const raw = step['timeout-minutes'];
  if (raw === undefined) return undefined;
  const value = raw.replace(/\s+#.*$/, '').trim();
  return /^\d+$/.test(value) ? Number(value) : Number.NaN;
}

describe('a job that opens a firewall window closes it before its own limit can run out (#1441)', () => {
  const FILES = readdirSync(WORKFLOWS)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
  const ALL = FILES.flatMap((name) =>
    parseJobs(readFileSync(join(WORKFLOWS, name), 'utf8').replace(/\r\n/g, '\n')).map((job) => ({ label: `${name} / ${job.key}`, job }))
  );
  const WINDOWED = ALL.filter(({ job }) => job.steps.some(isWindowClose));

  it('finds the jobs that open windows (a quiet read would make the checks below pass for nothing)', () => {
    const labels = WINDOWED.map(({ label }) => label);
    expect(labels).toContain('deploy-functions.yml / deploy');
    expect(labels).toContain('publish-content-manifest.yml / build');
    expect(stepTimeoutMinutes({ 'timeout-minutes': '3 # slowest 48 s' })).toBe(3);
    expect(stepTimeoutMinutes({})).toBeUndefined();
    expect(stepTimeoutMinutes({ 'timeout-minutes': '${{ env.LIMIT }}' })).toBeNaN();
  });

  it('every step that adds an allow rule in Azure is in a job with an always() close step', () => {
    const openers = ALL.flatMap(({ label, job }) => job.steps.filter((step) => OPENS_A_RULE.test(step.run ?? '')).map((step) => ({ label, job, step })));
    expect(openers.length, 'no step that adds an allow rule was found, so this check would pass for nothing').toBeGreaterThan(3);
    for (const { label, job, step } of openers) {
      const after = job.steps.slice(job.steps.indexOf(step) + 1);
      expect(after.some(isWindowClose), `${label}: "${step.name}" adds an allow rule, but no later step named "Close … window" runs with always()`).toBe(true);
    }
  });

  // The close step runs only when the open step's output is set. If the step
  // wrote it after the add, an add that succeeded in Azure and then hung until
  // the step's limit stopped it would leave the rule with nothing to remove it.
  it('every step that adds an allow rule writes its output (what the close step needs) before the add', () => {
    for (const { label, job } of ALL) {
      for (const step of job.steps.filter((candidate) => OPENS_A_RULE.test(candidate.run ?? ''))) {
        expect(firstOutputBeforeAdd(step.run), `${label}: "${step.name}" must write to $GITHUB_OUTPUT before its \`az … add\` line`).toBe(true);
      }
    }
  });

  it('every close step checks that the rule is there before it removes it, so a rule that was never added is not an error', () => {
    const closes = WINDOWED.flatMap(({ label, job }) => job.steps.filter(isWindowClose).map((step) => ({ label, step })));
    expect(closes.length).toBeGreaterThan(3);
    for (const { label, step } of closes) {
      const lines = step.run.split('\n');
      const remove = lines.findIndex((line) => REMOVES_A_RULE.test(line));
      if (remove === -1) continue;
      const check = lines.findIndex((line) => LOOKS_FOR_A_RULE.test(line));
      expect(check !== -1 && check < remove, `${label}: "${step.name}" removes a rule without first checking it is there`).toBe(true);
    }
  });

  it('the order check fails on the old order, where the output was written after the add', () => {
    const old = ['RULE="ci-manifest-${GITHUB_RUN_ID}"', 'az functionapp config access-restriction add \\', '  --rule-name "$RULE" --output none', 'echo "rule_name=${RULE}" >> "$GITHUB_OUTPUT"'].join('\n');
    const fixed = ['RULE="ci-manifest-${GITHUB_RUN_ID}"', 'echo "rule_name=${RULE}" >> "$GITHUB_OUTPUT"', 'az functionapp config access-restriction add \\', '  --rule-name "$RULE" --output none'].join('\n');
    expect(firstOutputBeforeAdd(old)).toBe(false);
    expect(firstOutputBeforeAdd(fixed)).toBe(true);
    expect(firstOutputBeforeAdd('az storage account network-rule add --ip-address "$IP"')).toBe(false);
  });

  it.each(WINDOWED.map(({ label, job }) => [label, job]))('%s: every step up to the last close has a limit, and they fit inside the job limit', (label, job) => {
    const jobLimit = timeoutMinutes(job);
    expect(Number.isInteger(jobLimit), `${label} needs a plain job timeout-minutes`).toBe(true);
    const lastClose = job.steps.findLastIndex(isWindowClose);
    const bounded = job.steps.slice(0, lastClose + 1);
    const missing = bounded.filter((step) => !Number.isInteger(stepTimeoutMinutes(step)) || stepTimeoutMinutes(step) < 1).map((step) => step.name);
    expect(
      missing,
      `${label}: these steps run before the last window is closed but have no timeout-minutes of their own (a plain whole number). ` +
        'Without one, a stuck step runs until the job limit cancels the job, while a window may still be open.'
    ).toEqual([]);
    const sum = bounded.reduce((total, step) => total + stepTimeoutMinutes(step), 0);
    expect(
      sum,
      `${label}: the step limits up to the last window close add up to ${sum} minutes, which leaves less than ${WINDOW_MARGIN} of the job's ${jobLimit}. ` +
        'Lower a step limit or raise the job limit, so a stuck step is always stopped by its own limit before the job is cancelled.'
    ).toBeLessThanOrEqual(jobLimit - WINDOW_MARGIN);
  });
});

// ---------------------------------------------------------------------------
// 3c. A close step does not give up at the first error (#1441, PR #1462).
// ---------------------------------------------------------------------------
/**
 * GitHub runs a `run:` step with `bash -e`, which stops the step at the first
 * command that fails. In a close step that meant one failed read, or one
 * Deny that Azure refused with 409 Conflict because the open step's update was
 * still running when the step's time limit stopped it, skipped the removal
 * below it and left the window open.
 *
 * So each close step turns `-e` off, sources scripts/lib/window-retry.sh and
 * runs every Azure call through `window_retry`; removes the rule when it cannot
 * read whether it is there; and reads the result back at the end, failing with
 * an error when the window is not closed. The tests below hold that shape as
 * text, and then run each close step's own shell against a stand-in `az` (a
 * small script that keeps the rules in files and fails when told to), with
 * `sleep` replaced so the retries do not wait.
 */
const RETRY_HELPER = join(REPO, 'scripts', 'lib', 'window-retry.sh');
const CLOSE_STEPS = [
  ['deploy-functions.yml', 'deploy', 'Close SCM firewall window'],
  ['deploy-functions.yml', 'deploy', 'Close storage firewall window'],
  ['deploy-functions.yml', 'deploy', 'Close origin firewall window'],
  ['publish-content-manifest.yml', 'build', 'Close origin window'],
];
/** Every workflow's jobs, by file name, read once. */
const JOBS_OF = new Map(
  readdirSync(WORKFLOWS)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => [name, parseJobs(readFileSync(join(WORKFLOWS, name), 'utf8').replace(/\r\n/g, '\n'))])
);
const closeStep = (file, jobKey, name) =>
  JOBS_OF.get(file)
    ?.find((job) => job.key === jobKey)
    ?.steps.find((step) => step.name === name);

/** The shell functions a step defines (`name() {` on its own line), and every line inside them. */
export function shellFunctions(run) {
  const names = [];
  const inside = new Set();
  let open = -1;
  run.split('\n').forEach((line, i) => {
    const start = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\(\)\s*\{\s*$/);
    if (start && open === -1) {
      names.push(start[1]);
      open = i;
    } else if (open !== -1 && /^\s*\}\s*$/.test(line)) {
      for (let j = open; j <= i; j++) inside.add(j);
      open = -1;
    }
  });
  return { names, inside };
}

/** The pauses of every `window_retry "<pauses>"` call in a step, added up: the longest the step can spend waiting between tries. */
export function retryPauseSeconds(run) {
  return [...run.matchAll(/\bwindow_retry\s+"([\d\s]*)"/g)].reduce((total, [, pauses]) => total + pauses.trim().split(/\s+/).filter(Boolean).reduce((sum, n) => sum + Number(n), 0), 0);
}

describe('a close step does not give up at the first error (#1441): its shape', () => {
  it('finds the close steps, and every window-close step in the workflows is one of them (a new one is noticed)', () => {
    const found = [...JOBS_OF]
      .flatMap(([name, jobs]) => jobs.flatMap((job) => job.steps.filter(isWindowClose).map((step) => `${name} / ${job.key} / ${step.name}`)))
      .sort();
    expect(found).toEqual(CLOSE_STEPS.map((parts) => parts.join(' / ')).sort());
    expect(existsSync(RETRY_HELPER), 'scripts/lib/window-retry.sh is missing').toBe(true);
  });

  it.each(CLOSE_STEPS)('%s / %s / %s turns -e off, sources the retry helper, and calls Azure only through window_retry', (file, jobKey, name) => {
    const step = closeStep(file, jobKey, name);
    expect(step?.run, `${file}: no step named "${name}" in job ${jobKey}`).toBeDefined();
    const lines = step.run.split('\n');
    const code = lines.map((line, i) => ({ line, i })).filter(({ line }) => line.trim() !== '' && !/^\s*#/.test(line));
    expect(code[0]?.line, `${name}: the first line must be \`set +e\` (GitHub runs the step with bash -e)`).toBe('set +e');
    expect(code.some(({ line }) => /^set\s+-[a-z]*e/.test(line.trim())), `${name} turns -e back on`).toBe(false);
    expect(lines, `${name} must source the retry helper`).toContain('. scripts/lib/window-retry.sh');
    expect(step.run.includes('${{'), `${name}: an expression in the shell text would not be expanded by this test`).toBe(false);

    const { names, inside } = shellFunctions(step.run);
    expect(names.length, `${name} defines no Azure functions`).toBeGreaterThan(1);
    // Every `az` call is in a function, and every function is called only through window_retry.
    const bareAz = code.filter(({ line, i }) => !inside.has(i) && /(^|[\s($])az\s/.test(line)).map(({ line }) => line.trim());
    expect(bareAz, `${name}: these lines call az outside a function, so nothing retries them`).toEqual([]);
    for (const fn of names) {
      const uses = code.filter(({ line, i }) => !inside.has(i) && new RegExp(`(^|[\\s($])${fn}(\\s|\\)|$)`).test(line));
      expect(uses.length, `${name}: ${fn} is defined but never called`).toBeGreaterThan(0);
      for (const { line } of uses) expect(line, `${name}: ${fn} is called without window_retry`).toMatch(new RegExp(`window_retry\\s+"[\\d\\s]*"\\s+${fn}\\b`));
    }
  });

  it.each(CLOSE_STEPS)('%s / %s / %s can finish its retries well inside its own time limit', (file, jobKey, name) => {
    const step = closeStep(file, jobKey, name);
    const pauses = retryPauseSeconds(step.run);
    expect(pauses, `${name}: no window_retry pauses found`).toBeGreaterThan(0);
    // Two thirds for pauses leaves the rest for the Azure calls themselves (about 5 to 10 s each).
    expect(pauses, `${name}: ${pauses} s of pauses do not fit two thirds of its ${stepTimeoutMinutes(step)}-minute limit`).toBeLessThanOrEqual((stepTimeoutMinutes(step) * 60 * 2) / 3);
  });

  it('the storage close retries the Deny for longer than the other calls, as that is the one a running update refuses', () => {
    const run = closeStep('deploy-functions.yml', 'deploy', 'Close storage firewall window').run;
    const deny = run.match(/window_retry\s+"([\d\s]*)"\s+deny\b/);
    expect(deny, 'no window_retry … deny line').not.toBeNull();
    expect(retryPauseSeconds(deny[0])).toBeGreaterThanOrEqual(90);
    expect(run.indexOf('window_retry "5 10 20 30 30" deny')).toBeLessThan(run.indexOf('remove_rule && echo'));
  });

  it('reads the helper the way it is written', () => {
    expect(retryPauseSeconds('window_retry "5 10" a\nx=$(window_retry "5 10 20" b)')).toBe(50);
    const { names, inside } = shellFunctions(['f() {', '  az x', '}', 'window_retry "5" f'].join('\n'));
    expect(names).toEqual(['f']);
    expect([...inside]).toEqual([0, 1, 2]);
  });
});

/** The stand-in `az` (scripts/fixtures/fake-az.sh): rules kept in files under $AZ_STATE, every call logged, a kind of call failed while $AZ_STATE/fail-<kind> holds a number above zero. */
const FAKE_AZ = readFileSync(join(REPO, 'scripts', 'fixtures', 'fake-az.sh'), 'utf8');

describe('a close step does not give up at the first error (#1441): run with bash', () => {
  it.skipIf(process.env.GITHUB_ACTIONS !== 'true')('on GitHub Actions bash is present, so the tests below run', () => {
    expect(TOOLS.ready, TOOLS.why).toBe(true);
  });
});

describe.skipIf(!TOOLS.ready)(`a close step does not give up at the first error (#1441): run with bash${SKIPPED}`, () => {
  let work;
  let bin;
  let runs = 0;
  const IP = '203.0.113.7';

  beforeAll(() => {
    work = forward(mkdtempSync(join(tmpdir(), 'ci-close-')));
    bin = `${work}/bin`;
    mkdirSync(bin);
    writeFileSync(`${bin}/az`, FAKE_AZ, { mode: 0o755 });
    // No waiting between retries; each pause is written down instead.
    writeFileSync(`${bin}/sleep`, '#!/usr/bin/env bash\nprintf "%s\\n" "$1" >> "$AZ_STATE/sleeps"\n', { mode: 0o755 });
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  /**
   * Runs one close step with the window open as `state` says (rules on each list, default actions) and the
   * stand-in told to fail some calls first (`fail`: kind → how many times). Returns the exit code, the
   * output, the az calls in order and the rules left.
   */
  function close(name, { state = {}, fail = {} } = {}) {
    const [file, jobKey] = CLOSE_STEPS.find((parts) => parts[2] === name);
    const step = closeStep(file, jobKey, name);
    const dir = `${work}/run-${++runs}`;
    mkdirSync(dir);
    const files = { 'sa-default': 'Allow', 'sa-rules': '', 'scm-default': 'Deny', 'scm-rules': '', 'site-rules': '', calls: '', sleeps: '', ...state };
    for (const [key, value] of Object.entries(files)) writeFileSync(`${dir}/${key}`, value ? `${value}\n` : '');
    for (const [kind, times] of Object.entries(fail)) writeFileSync(`${dir}/fail-${kind}`, `${times}\n`);
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      AZ_STATE: dir,
      APP: 'func-hcw-sample',
      RG: 'rg-hcw-sample',
      SA: 'sthcwsample',
      RUNNER_IP: IP,
      RULE: step.env.RULE ? (file === 'deploy-functions.yml' ? 'ci-deploy-scm-4242' : 'ci-manifest-4242') : '',
      BASELINE: 'Deny',
      GITHUB_RUN_ID: '4242',
    };
    const result = spawnSync('bash', ['-e', '-c', step.run], { cwd: REPO, env, encoding: 'utf8' });
    const read = (key) => readFileSync(`${dir}/${key}`, 'utf8').split('\n').filter(Boolean);
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      calls: read('calls'),
      sleeps: read('sleeps').map(Number),
      left: { sa: read('sa-rules'), scm: read('scm-rules'), site: read('site-rules') },
      saDefault: read('sa-default')[0],
    };
  }

  const removes = (calls) => calls.filter((call) => / remove /.test(call)).length;

  // [step, the state of an open window, where its rule lives, how to read what is left]
  const WINDOWS = [
    ['Close SCM firewall window', { 'scm-rules': 'ci-deploy-scm-4242' }, (r) => r.left.scm],
    ['Close storage firewall window', { 'sa-rules': IP, 'sa-default': 'Allow' }, (r) => r.left.sa],
    ['Close origin firewall window', { 'site-rules': 'cloudflare-0\nci-smoke-4242' }, (r) => r.left.site.filter((n) => n.startsWith('ci-'))],
    ['Close origin window', { 'site-rules': 'cloudflare-0\nci-manifest-4242' }, (r) => r.left.site.filter((n) => n.startsWith('ci-'))],
  ];
  const READ_KIND = { 'Close storage firewall window': 'sa-list' };
  const REMOVE_KIND = { 'Close storage firewall window': 'sa-remove' };

  it.each(WINDOWS)('%s: an open window is closed, and the step says so', (name, state, leftOf) => {
    const result = close(name, { state });
    expect(result.status, result.output).toBe(0);
    expect(leftOf(result)).toEqual([]);
    expect(result.output).toMatch(/window closed/);
    expect(result.sleeps).toEqual([]);
  });

  it.each(WINDOWS)('%s: a rule that was never added is not an error, and nothing is removed', (name) => {
    const result = close(name, { state: name.includes('storage') ? { 'sa-default': 'Allow' } : {} });
    expect(result.status, result.output).toBe(0);
    expect(removes(result.calls)).toBe(0);
    expect(result.output).toMatch(/nothing to remove/);
  });

  // CodeRabbit's second finding on PR #1462: a failed read of whether the rule is there used to stop the step.
  it.each(WINDOWS)('%s: when every read of whether the rule is there fails, it removes the rule anyway', (name, state, leftOf) => {
    const kind = READ_KIND[name] ?? 'ar-show';
    const result = close(name, { state, fail: { [kind]: 3 } });
    expect(result.output).toMatch(/removing it anyway/);
    expect(removes(result.calls)).toBe(1);
    expect(leftOf(result)).toEqual([]);
    expect(result.status, result.output).toBe(0);
  });

  it.each(WINDOWS)('%s: a read that fails once is retried, and the step carries on', (name, state, leftOf) => {
    const kind = READ_KIND[name] ?? 'ar-show';
    const result = close(name, { state, fail: { [kind]: 1 } });
    expect(result.status, result.output).toBe(0);
    expect(result.sleeps[0]).toBe(5);
    expect(leftOf(result)).toEqual([]);
  });

  it.each(WINDOWS)('%s: a removal that keeps failing fails the step loudly, after its retries', (name, state, leftOf) => {
    const kind = REMOVE_KIND[name] ?? 'ar-remove';
    const result = close(name, { state, fail: { [kind]: 99 } });
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/::error::/);
    expect(removes(result.calls)).toBe(4);
    expect(leftOf(result).length).toBe(1);
  });

  // CodeRabbit's first finding on PR #1462: a Deny refused while the open step's update was still running.
  it('storage: a Deny refused with 409 while an update is still running is retried, then the rule is removed and both are checked', () => {
    const result = close('Close storage firewall window', { state: { 'sa-rules': IP, 'sa-default': 'Allow' }, fail: { 'sa-update': 3 } });
    expect(result.status, result.output).toBe(0);
    expect(result.saDefault).toBe('Deny');
    expect(result.left.sa).toEqual([]);
    expect(result.sleeps).toEqual([5, 10, 20]);
    expect(result.output).toMatch(/storage account provisioning state: Succeeded/);
    const updates = result.calls.map((call, i) => [call, i]).filter(([call]) => call.startsWith('storage account update'));
    expect(updates).toHaveLength(4);
    const firstRemove = result.calls.findIndex((call) => call.startsWith('storage account network-rule remove'));
    expect(updates.at(-1)[1], 'the Deny must come before the rule is removed').toBeLessThan(firstRemove);
  });

  it('storage: a Deny that never succeeds still removes the rule, and fails the step naming the default action', () => {
    const result = close('Close storage firewall window', { state: { 'sa-rules': IP, 'sa-default': 'Allow' }, fail: { 'sa-update': 99 } });
    expect(result.status).toBe(1);
    expect(result.left.sa).toEqual([]);
    expect(result.output).toMatch(/::error::default action is 'Allow' after the window closed, expected Deny/);
    expect(result.calls.filter((call) => call.startsWith('storage account update'))).toHaveLength(6);
  });

  it('storage: a default action that cannot be read at the end fails the step rather than passing it', () => {
    const result = close('Close storage firewall window', { state: { 'sa-rules': IP, 'sa-default': 'Allow' }, fail: { 'sa-read': 99 } });
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/default action is 'unreadable'/);
    expect(result.left.sa).toEqual([]);
  });

  it('SCM: a default action that differs from the one read before the window still fails the step', () => {
    const result = close('Close SCM firewall window', { state: { 'scm-rules': 'ci-deploy-scm-4242', 'scm-default': 'Allow' } });
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/::error::scm default action is 'Allow' after the window closed, expected 'Deny'/);
    expect(result.left.scm).toEqual([]);
  });

  it('SCM and manifest: a temporary rule from another run left behind still fails the step', () => {
    const scm = close('Close SCM firewall window', { state: { 'scm-rules': 'ci-deploy-scm-4242\nci-deploy-scm-1111' } });
    expect(scm.status).toBe(1);
    expect(scm.output).toMatch(/::error::1 ci-deploy-scm-\* rule\(s\) still present/);
    const manifest = close('Close origin window', { state: { 'site-rules': 'ci-manifest-4242\nci-manifest-1111' } });
    expect(manifest.status).toBe(1);
    expect(manifest.output).toMatch(/::error::1 ci-manifest-\* rule\(s\) still on the origin/);
  });

  it('window_retry: one try more than there are pauses, the command output untouched, the last exit code returned', () => {
    const script = [
      `. '${forward(RETRY_HELPER)}'`,
      'n=0; flaky() { n=$((n + 1)); [ "$n" -ge 3 ] && echo "ok after $n"; [ "$n" -ge 3 ]; }',
      'out=$(window_retry "1 2 3" flaky) && echo "got: $out"',
      'never() { return 7; }',
      'window_retry "1 1" never; echo "status $?"',
    ].join('\n');
    const dir = `${work}/helper`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/sleeps`, '');
    const result = spawnSync('bash', ['-c', script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, AZ_STATE: dir }, encoding: 'utf8' });
    expect(result.stdout).toBe('got: ok after 3\nstatus 7\n');
    expect(result.stderr).toMatch(/'flaky' failed \(exit code 1\) on try 1 of 4; trying again in 1 s/);
    expect(result.stderr).toMatch(/::warning::'never' failed 3 times \(last exit code 7\)/);
    expect(readFileSync(`${dir}/sleeps`, 'utf8')).toBe('1\n2\n1\n1\n');
  });
});
