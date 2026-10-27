/**
 * The change-detection steps of `codeql.yml` and `iac-validate.yml`, run for
 * real, and a rule for every workflow: no `if grep` (#1429).
 *
 * This is the second half of #1428, which fixed `ci.yml` (see
 * `ci-workflow-steps.test.mjs`). These two workflows had the same weakness.
 *
 * ## The weakness
 *
 * A job decides whether a pull request needs it by running `grep -E` with a
 * pattern for file paths (a "filter") over the files the pull request changes.
 * `grep` answers 0 (a changed file matches), 1 (none does) or 2 (it could not
 * read the pattern, for example because a parenthesis is never closed). Written
 * as `if grep -qE ...; then`, the 2 counts as "no", the job is skipped as "no
 * relevant change", and the pull request looks green. Here that would have
 * switched off a CodeQL analysis or a Terraform or Trivy check, which are
 * required checks, without anything turning red.
 *
 * The steps now keep the answer and fail the step on anything but 0 or 1. The
 * names of the jobs and of the checks do not change: a step that fails fails
 * the same check, and a step that answers 0 or 1 behaves exactly as before.
 *
 * ## What is here
 *
 * 1. What the steps are made of, read as text: each takes its filter from a
 *    setting in its `env:` block, the lines that decide are the same as in
 *    `ci.yml`, and nothing lets the step fail without failing the check.
 * 2. The same steps run with bash against a small git repository made in the
 *    temporary folder: with the real filters (a match, no match), with
 *    deliberately broken filters (the step must fail, write no answer for the
 *    broken filter and name the filter), with the workflow's own file changed,
 *    with a base commit that cannot be fetched, and on a push to `main`.
 * 3. A scan of every file in `.github/workflows/` for `if grep` (also `elif`,
 *    `while` and `until`). A few remain on purpose, each listed below with the
 *    reason; a new one, or a listed one that disappears, fails the test.
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
import { findBashTools, GIT_TEST_CONFIG, isIfGrepLine, parseJobs, parseMatrixRows } from './lib/workflow-text.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = join(REPO, '.github', 'workflows');
const read = (name) => readFileSync(join(WORKFLOWS, name), 'utf8').replace(/\r\n/g, '\n');

const CODEQL = parseJobs(read('codeql.yml'));
const IAC = parseJobs(read('iac-validate.yml'));
const CI = parseJobs(read('ci.yml'));

const CODEQL_JOB = CODEQL.find((job) => job.key === 'analyze');
const CODEQL_ROWS = parseMatrixRows(CODEQL_JOB.lines);
const CODEQL_STEP = 'Detect language changes';
const IAC_STEP = 'Detect infra changes';

/**
 * A path that each CodeQL row's real filter matches. A language this table does
 * not know fails the test that needs it, so a new row is noticed.
 */
const CODEQL_MATCHING_PATH = {
  'javascript-typescript': 'frontend/src/zz-probe.js',
  actions: '.github/workflows/zz-probe.yml',
  python: 'hooks/zz-probe.py',
};

/** The two things iac-validate.yml decides: each has the setting that holds its filter, the output it writes and a path it matches. */
const IAC_DECISIONS = [
  { output: 'infra', filterVar: 'INFRA_FILTER', path: 'infra/zz-probe.tf' },
  { output: 'lab', filterVar: 'LAB_FILTER', path: 'infra-lab/zz-probe.tf' },
];

/** Files that always count as a change for their workflow, whatever the filter says. */
const OWN_PATHS = {
  'codeql.yml': ['.github/workflows/codeql.yml', '.github/codeql/codeql-config.yml'],
  'iac-validate.yml': ['.github/workflows/iac-validate.yml'],
};

/** What the script adds after the filter, besides this workflow's own file. */
const EXTRA_ALTERNATIVES = { 'codeql.yml': '|^\\.github/codeql/', 'iac-validate.yml': '', 'ci.yml': '' };

const stepOf = (jobs, jobKey, name) => jobs.find((job) => job.key === jobKey)?.steps.find((step) => step.name === name);

/** One entry per time a change-detection step of these two workflows runs: the CodeQL step once per matrix row. */
const ENTRIES = [
  ...CODEQL_ROWS.map((row) => ({
    file: 'codeql.yml',
    job: 'analyze',
    step: stepOf(CODEQL, 'analyze', CODEQL_STEP),
    label: `codeql.yml / ${row.language}`,
    settings: { LANGUAGE: row.language },
    decisions: [{ output: 'relevant', filterVar: 'FILTER', filter: row.filter, path: CODEQL_MATCHING_PATH[row.language] }],
  })),
  ...['terraform', 'trivy'].map((job) => {
    const step = stepOf(IAC, job, IAC_STEP);
    return {
      file: 'iac-validate.yml',
      job,
      step,
      label: `iac-validate.yml / ${job}`,
      settings: {},
      decisions: IAC_DECISIONS.map((decision) => ({ ...decision, filter: step?.env[decision.filterVar] })),
    };
  }),
];
/** The CodeQL step once, for what does not depend on the row's filter. */
const DISTINCT = ENTRIES.filter((entry, i) => ENTRIES.findIndex((other) => other.step === entry.step) === i);
const byLabel = (entries) => entries.map((entry) => [entry.label, entry]);

// ---------------------------------------------------------------------------
// 1. What the change-detection steps are made of, read as text.
// ---------------------------------------------------------------------------

/**
 * The twelve lines of one decision, as every change-detection step writes them,
 * with the lines that only tell the reader what happened (the two plain `echo`
 * messages) left as a placeholder because they differ from step to step.
 */
function expectedDecision({ file, filterVar, output }) {
  return [
    'status=0',
    `grep -qE "(\${${filterVar}})"'|^\\.github/workflows/${file.replace(/\./g, '\\.')}$${EXTRA_ALTERNATIVES[file]}' <<<"$changed" || status=$?`,
    'if [ "${status}" -eq 0 ]; then',
    `echo "${output}=true" >> "$GITHUB_OUTPUT"`,
    '<message>',
    'elif [ "${status}" -eq 1 ]; then',
    `echo "${output}=false" >> "$GITHUB_OUTPUT"`,
    '<message>',
    'else',
    `echo "::error file=.github/workflows/${file},title=Path filter could not be read::grep -E could not read the path filter of job \${GITHUB_JOB} (exit status \${status}), so the job cannot tell whether it is needed. The filter: \${${filterVar}}"`,
    'exit 1',
    'fi',
  ];
}

/** The decisions in a step's shell: each `status=0` and the eleven lines after it, with comments and blank lines left out and the plain messages hidden. */
function decisionsIn(run) {
  const lines = run
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  return lines
    .map((line, i) => (line === 'status=0' ? lines.slice(i, i + 12) : null))
    .filter(Boolean)
    .map((block) => block.map((line) => (/^echo "[^"]*"$/.test(line) && !line.includes('GITHUB_OUTPUT') && !line.includes('::error') ? '<message>' : line)));
}

/** Every change-detection step this test knows about, in the three workflows, with the decisions it should hold. */
const ALL_DETECT_STEPS = [
  ...CI.flatMap((job) =>
    job.steps
      .filter((step) => step.run?.includes('git diff --name-only'))
      .map((step) => ({ file: 'ci.yml', job: job.key, step, decisions: [{ filterVar: 'FILTER', output: 'relevant' }] }))
  ),
  { file: 'codeql.yml', job: 'analyze', step: stepOf(CODEQL, 'analyze', CODEQL_STEP), decisions: [{ filterVar: 'FILTER', output: 'relevant' }] },
  { file: 'iac-validate.yml', job: 'terraform', step: stepOf(IAC, 'terraform', IAC_STEP), decisions: IAC_DECISIONS },
  { file: 'iac-validate.yml', job: 'trivy', step: stepOf(IAC, 'trivy', IAC_STEP), decisions: IAC_DECISIONS },
];

describe('codeql.yml and iac-validate.yml change-detection steps: what they are made of (#1429)', () => {
  it('finds the CodeQL rows and the two IaC steps (a quiet parse would make every test below pass for nothing)', () => {
    expect(CODEQL_ROWS.map((row) => row.language)).toEqual(['javascript-typescript', 'actions', 'python']);
    for (const row of CODEQL_ROWS) expect(CODEQL_MATCHING_PATH[row.language], `no matching path is named for the ${row.language} row`).toBeTruthy();
    expect(ENTRIES.every((entry) => entry.step), 'a detection step was not found').toBe(true);
    expect(ENTRIES.map((entry) => entry.label)).toEqual([
      'codeql.yml / javascript-typescript',
      'codeql.yml / actions',
      'codeql.yml / python',
      'iac-validate.yml / terraform',
      'iac-validate.yml / trivy',
    ]);
    // ci.yml has its four, so the "one shape" test below really compares seven steps.
    expect(ALL_DETECT_STEPS.map(({ file, job }) => `${file}: ${job}`)).toEqual([
      'ci.yml: verify',
      'ci.yml: ansible-lint',
      'ci.yml: coder-template',
      'ci.yml: harness',
      'codeql.yml: analyze',
      'iac-validate.yml: terraform',
      'iac-validate.yml: trivy',
    ]);
  });

  it('the CodeQL step reads the matrix row\'s filter, and the IaC steps hold theirs in their own env: block', () => {
    expect(stepOf(CODEQL, 'analyze', CODEQL_STEP).env.FILTER).toBe('${{ matrix.filter }}');
    for (const job of ['terraform', 'trivy']) {
      const { env } = stepOf(IAC, job, IAC_STEP);
      expect(env.INFRA_FILTER, `${job}: INFRA_FILTER`).toBe('^infra/');
      expect(env.LAB_FILTER, `${job}: LAB_FILTER`).toBe('^infra-lab/');
    }
  });

  it.each(ALL_DETECT_STEPS.map((entry) => [`${entry.file}: ${entry.job}`, entry]))(
    '%s: the lines that decide are the same in every change-detection step of the three workflows (one shape to learn)',
    (_label, { file, step, decisions }) => {
      const found = decisionsIn(step.run);
      const wanted = decisions.map((decision) => expectedDecision({ file, ...decision }));
      expect(found).toEqual(wanted);
    }
  );

  it.each(ALL_DETECT_STEPS.map((entry) => [`${entry.file}: ${entry.job}`, entry]))(
    '%s: grep appears only in those decisions, so nothing else in the step can read an answer wrongly',
    (_label, { step, decisions }) => {
      const uses = step.run.split('\n').filter((line) => !/^\s*#/.test(line) && /\bgrep\b/.test(line) && !line.includes('::error'));
      expect(uses).toHaveLength(decisions.length);
      for (const line of uses) expect(line.trim()).toMatch(/^grep -qE "\(\$\{[A-Z_]+\}\)"'.*' <<<"\$changed" \|\| status=\$\?$/);
    }
  );

  it('keeps the steps and the jobs as they were: no `if` on the detection step, no `continue-on-error`, no `shell:`', () => {
    for (const { file, jobs, keys } of [
      { file: 'codeql.yml', jobs: CODEQL, keys: ['analyze'] },
      { file: 'iac-validate.yml', jobs: IAC, keys: ['terraform', 'trivy'] },
    ]) {
      for (const key of keys) {
        const job = jobs.find((candidate) => candidate.key === key);
        const step = job.steps.find((candidate) => candidate.name === (file === 'codeql.yml' ? CODEQL_STEP : IAC_STEP));
        // A condition on the step would let a job skip the very step that decides; continue-on-error would turn its failure green.
        expect(step.if, `${file} ${key}: the detection step must run every time`).toBeUndefined();
        expect(step['continue-on-error'], `${file} ${key}: the detection step must not continue on error`).toBeUndefined();
        expect(job.lines.filter((line) => /^ {4}(continue-on-error|if):/.test(line)), `${file} ${key}: the job must not continue on error or have an if`).toEqual([]);
      }
      // The tests below run each step's text with `bash -e`, which is what a step with no `shell:` gets on the runner.
      expect(read(file).split('\n').filter((line) => /^\s*(- )?shell:/.test(line)), `${file} sets a shell`).toEqual([]);
    }
  });

  it('keeps the check names the ruleset requires: the job ids and names, and the CodeQL matrix, are untouched', () => {
    // scripts/ruleset-contexts.test.mjs holds the full list; this is the part this change is near.
    expect(CODEQL_JOB.lines.find((line) => /^ {4}name:/.test(line))).toBe('    name: Analyze ${{ matrix.language }}');
    expect(IAC.map((job) => job.key)).toEqual(['terraform', 'trivy']);
    expect(IAC.find((job) => job.key === 'terraform').lines.find((line) => /^ {4}name:/.test(line))).toBe('    name: fmt, validate, tflint');
    expect(IAC.find((job) => job.key === 'trivy').lines.find((line) => /^ {4}name:/.test(line))).toBe('    name: Trivy IaC misconfiguration scan');
  });
});

// ---------------------------------------------------------------------------
// 2. The same steps, run with bash.
// ---------------------------------------------------------------------------
const TOOLS = findBashTools();
const SKIPPED = TOOLS.ready ? '' : ` (SKIPPED here: ${TOOLS.why}; they run on GitHub Actions)`;
const forward = (path) => path.replace(/\\/g, '/');

describe('codeql.yml and iac-validate.yml change-detection steps: bash is there', () => {
  it.skipIf(process.env.GITHUB_ACTIONS !== 'true')('on GitHub Actions bash, git and grep are present, so the shell tests below run', () => {
    expect(TOOLS.ready, TOOLS.why).toBe(true);
  });
});

describe.skipIf(!TOOLS.ready)(`codeql.yml and iac-validate.yml change-detection steps: run with bash${SKIPPED}`, () => {
  let work;
  let repo;
  let outputs;
  let baseSha;
  let counter = 0;

  /** The environment of a child process: ours, without git's own variables (a git hook sets some) and the ones the steps read. */
  function cleanEnv(extra) {
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
      if (name.startsWith('GIT_') || ['FILTER', 'INFRA_FILTER', 'LAB_FILTER', 'LANGUAGE', 'BASE_SHA'].includes(name)) delete env[name];
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

  /** The tag of the commit that changes only `path` (a git tag cannot hold every character a path can, so they are numbered). */
  const tags = new Map();
  const tagFor = (path) => {
    if (!tags.has(path)) tags.set(path, `only-${tags.size}`);
    return tags.get(path);
  };

  beforeAll(() => {
    work = forward(mkdtempSync(join(tmpdir(), 'codeql-iac-steps-')));
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
    const paths = new Set(['notes/zz-unrelated.txt', ...Object.values(OWN_PATHS).flat()]);
    for (const entry of ENTRIES) for (const decision of entry.decisions) paths.add(decision.path);
    for (const path of paths) commit(tagFor(path), [path]);
  }, 60_000);

  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  /**
   * Run the step's shell the way a runner does (`bash -e`), on the commit that
   * changes only `path`, as a pull request whose base is `base`. `filters`
   * replaces the filter settings it names; the others keep the workflow's own.
   */
  function run(entry, { path, filters = {}, base = baseSha, event = 'pull_request' }) {
    git('checkout', '-q', '--detach', tagFor(path));
    const output = `${outputs}/out-${(counter += 1)}.txt`;
    const real = Object.fromEntries(entry.decisions.map((decision) => [decision.filterVar, decision.filter]));
    // A filter the workflow does not have (the step still has its pattern inline) is simply not passed; the tests that need it say so.
    for (const name of Object.keys(real)) if (real[name] === undefined) delete real[name];
    const result = spawnSync('bash', ['-e', '-c', entry.step.run], {
      cwd: repo,
      encoding: 'utf8',
      env: cleanEnv({ GITHUB_EVENT_NAME: event, GITHUB_JOB: entry.job, GITHUB_OUTPUT: output, BASE_SHA: base, ...entry.settings, ...real, ...filters }),
    });
    return { status: result.status, log: `${result.stdout}${result.stderr}`, written: existsSync(output) ? readFileSync(output, 'utf8') : '' };
  }

  /** What the step writes when exactly the outputs in `trueOutputs` are true. */
  const answers = (entry, trueOutputs) => entry.decisions.map((decision) => `${decision.output}=${trueOutputs.includes(decision.output)}\n`).join('');
  const everyOutput = (entry) => entry.decisions.map((decision) => decision.output);
  const hasAnswerFor = (written, output) => written.split('\n').some((line) => line.startsWith(`${output}=`));

  describe('with the real filters', () => {
    it.each(byLabel(ENTRIES))('%s: a changed file a filter matches turns on that answer only', (_label, entry) => {
      for (const decision of entry.decisions) {
        expect(decision.path, `no path that matches the "${decision.output}" filter of ${entry.label} is named in this test`).toBeTruthy();
        const result = run(entry, { path: decision.path });
        expect(result.status, result.log).toBe(0);
        expect(result.written, `changing ${decision.path} must turn on ${decision.output} and nothing else`).toBe(answers(entry, [decision.output]));
      }
    });

    it.each(byLabel(ENTRIES))('%s: a changed file no filter matches turns every answer off', (_label, entry) => {
      const result = run(entry, { path: 'notes/zz-unrelated.txt' });
      expect(result.status, result.log).toBe(0);
      expect(result.written).toBe(answers(entry, []));
    });
  });

  describe('a filter grep cannot read stops the job and says which one', () => {
    // Each of these makes grep -E exit 2 (GNU grep and the BSD grep on a Mac alike). The last one ends in a
    // backslash, which would join onto the `|` added after the filter if the filter were not put in brackets.
    const BROKEN = ['^(unclosed', '[a-', 'a\\'];

    it.each(byLabel(ENTRIES))('%s', (_label, entry) => {
      entry.decisions.forEach((decision, index) => {
        for (const filter of BROKEN) {
          // On a commit no filter matches, the old `if grep` answered "no" and wrote relevant=false (or infra=false, lab=false).
          const result = run(entry, { path: 'notes/zz-unrelated.txt', filters: { [decision.filterVar]: filter } });
          const where = `${decision.filterVar}=${filter}`;
          expect(result.status, `${where}: the step must fail\n${result.log}`).not.toBe(0);
          expect(hasAnswerFor(result.written, decision.output), `${where}: the step must not write ${decision.output}=...`).toBe(false);
          // Whatever it wrote before it reached the broken filter can only be an earlier decision's answer.
          if (index === 0) expect(result.written, `${where}: the first decision failed, so nothing is written`).toBe('');
          expect(result.log, `${where}: the message must name the filter`).toContain(`The filter: ${filter}`);
          expect(result.log, `${where}: the message must name the job`).toContain(`job ${entry.job}`);
          expect(result.log, `${where}: the message must point at the workflow file`).toContain(`::error file=.github/workflows/${entry.file},title=Path filter could not be read::`);
          expect(result.log).toMatch(/could not read the path filter/);
        }
      });
    });
  });

  describe('everything else the steps did before is unchanged', () => {
    it.each(byLabel(DISTINCT))('%s: the workflow\'s own files are always relevant, whatever the filters say', (_label, entry) => {
      const nothing = Object.fromEntries(entry.decisions.map((decision) => [decision.filterVar, '^zz-nothing-matches-this$']));
      for (const path of OWN_PATHS[entry.file]) {
        const result = run(entry, { path, filters: nothing });
        expect(result.status, `${path}\n${result.log}`).toBe(0);
        expect(result.written, path).toBe(answers(entry, everyOutput(entry)));
      }
    });

    it.each(byLabel(DISTINCT))('%s: a base commit that cannot be fetched means run everything', (_label, entry) => {
      const result = run(entry, { path: 'notes/zz-unrelated.txt', base: '0'.repeat(40) });
      expect(result.status, result.log).toBe(0);
      expect(result.written).toBe(answers(entry, everyOutput(entry)));
      expect(result.log).toContain('could not compute the diff');
    });

    it.each(byLabel(DISTINCT))('%s: a push to main runs everything', (_label, entry) => {
      const result = run(entry, { path: 'notes/zz-unrelated.txt', event: 'push' });
      expect(result.status, result.log).toBe(0);
      expect(result.written).toBe(answers(entry, everyOutput(entry)));
      expect(result.log).toContain('non-pull_request event');
    });

    it.each(byLabel(DISTINCT))('%s: a broken filter does not matter on a push or when the diff cannot be computed (those paths never read it)', (_label, entry) => {
      const broken = Object.fromEntries(entry.decisions.map((decision) => [decision.filterVar, '^(unclosed']));
      const push = run(entry, { path: 'notes/zz-unrelated.txt', event: 'push', filters: broken });
      expect(push.status, push.log).toBe(0);
      expect(push.written).toBe(answers(entry, everyOutput(entry)));
      const noDiff = run(entry, { path: 'notes/zz-unrelated.txt', base: '0'.repeat(40), filters: broken });
      expect(noDiff.status, noDiff.log).toBe(0);
      expect(noDiff.written).toBe(answers(entry, everyOutput(entry)));
    });
  });
});

// ---------------------------------------------------------------------------
// 3. No `if grep` in any workflow, except the ones listed here with a reason.
// ---------------------------------------------------------------------------

/**
 * Lines of the form `if grep ...`, `elif`, `while` or `until` (also `if ! grep`
 * and `if ! printf ... | grep`), read from the shell of every file in
 * `.github/workflows/`. A line that ends in a backslash is joined to the next.
 *
 * Why this is a problem when `grep` is not negated: `grep` answers 2 when it
 * cannot read its pattern or its input, and `if` takes every answer other than
 * 0 as "no". For a path filter that means "no relevant change" and the job
 * is switched off; for a guard that refuses a bad patch it means "nothing
 * wrong found" and the patch goes on. A negated `if ! grep` takes the 2 as "no
 * match" and stops, which is the safe way round for a check that insists on a match.
 */
function ifGrepLines(file) {
  const joined = read(file).replace(/\\\n\s*/g, ' ').split('\n');
  return joined
    .map((line) => line.trim())
    .filter((line) => !line.startsWith('#'))
    .filter(isIfGrepLine);
}

/**
 * The `if grep` lines that remain, by workflow file. Each is a fixed pattern
 * judged against a file or a value, none is a path filter that decides whether
 * a job runs (those are the steps tested above), and each says why it is safe
 * to leave. Add a line here only with a reason a reviewer can check.
 */
const NEGATED = 'Negated (`if ! grep`), so grep answering 2 counts as "no match" and the step refuses and fails: the safe way round for a check that insists on a match.';
const GUARD = 'A guard that refuses a bad patch, not a path filter that decides whether a job runs. The pattern is fixed and valid, so grep can answer 2 only if it cannot read the file, and ';
// The step writes patched.txt itself, a few lines above, and `comm` reads it (in an assignment, under set -euo pipefail) before this grep does.
const PATCHED_LIST = `${GUARD}the step wrote that list itself a few lines earlier and its \`comm\` line reads it before this line, failing the step if it cannot.`;
// The first reader of the patch file is the grep itself; `git apply --numstat` reads it next, in a pipeline under pipefail, before anything is accepted or applied.
const PATCH_FILE = `${GUARD}the next lines of the step feed the same file to \`git apply --numstat\` under pipefail, which fails the step before anything is accepted or applied.`;
const REMAINING_IF_GREP = {
  'addon-guide-check.yml': [
    { line: `if ! printf '%s' "\${ADDON_ID}" | grep -Eq '^[a-z0-9]+(-[a-z0-9]+)*$'; then`, why: NEGATED },
    { line: `if ! printf '%s' "\${WORKFLOW_SHA}" | grep -Eq '^[0-9a-f]{40}$'; then`, why: NEGATED },
  ],
  'cloudflare-ranges.yml': [{ line: `if grep -E '^(\\.github/|scripts/)' "\${RUNNER_TEMP}/cloudflare-ranges/patched.txt"; then`, why: PATCHED_LIST }],
  'deploy-azure-frontend.yml': [{ line: `if ! grep -qiE "<(!DOCTYPE html|html|div id=\\"root\\")" "\${body_file}"; then`, why: NEGATED }],
  'lab-supply-chain.yml': [
    { line: `if grep -E '^(\\.github/|scripts/)' "\${RUNNER_TEMP}/lab-pins/patched.txt" | grep -vE '^scripts/fixtures/'; then`, why: PATCHED_LIST },
    { line: `if grep -qx 'lab-host/bootstrap.sh' "\${RUNNER_TEMP}/lab-pins/patched.txt"; then`, why: PATCHED_LIST },
  ],
  'update-version-floors.yml': [
    { line: `if grep -qE '^(GIT binary patch|Binary files )' "\${patch}"; then`, why: PATCH_FILE },
    { line: `if grep -qE '^((rename|copy) (from|to) |(old|new|deleted file|new file) mode |(dis)?similarity index )' "\${patch}"; then`, why: PATCH_FILE },
    { line: `if ! grep -qx 'scripts/version-floors.json' "\${dir}/patched.txt"; then`, why: NEGATED },
  ],
};

describe('no workflow decides with `if grep` (#1429)', () => {
  const FILES = readdirSync(WORKFLOWS)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();

  it('finds the workflow files (a quiet read would make the scan below pass for nothing)', () => {
    expect(FILES.length).toBeGreaterThan(20);
    for (const name of ['ci.yml', 'codeql.yml', 'iac-validate.yml']) expect(FILES).toContain(name);
  });

  it('finds the `if grep` shapes it is meant to find', () => {
    // The scan is only worth anything if it sees the old shape. These two lines are the ones this change replaced.
    const sample = isIfGrepLine;
    expect(sample(`if grep -qE "\${FILTER}"'|^\\.github/workflows/codeql\\.yml$' <<<"$changed"; then`)).toBe(true);
    expect(sample(`if grep -qE '^(infra/|\\.github/workflows/iac-validate\\.yml$)' <<<"$changed"; then`)).toBe(true);
    expect(sample('elif ! grep -q x file; then')).toBe(true);
    expect(sample('while grep -q x file; do')).toBe(true);
    expect(sample('if ! printf x | egrep -q y; then')).toBe(true);
    // And not these: grep kept as a status, a comment, a YAML key, a value that merely has "grep" in its name.
    expect(sample('grep -qE "(${FILTER})" <<<"$changed" || status=$?')).toBe(false);
    expect(sample('if [ "${status}" -eq 0 ]; then')).toBe(false);
    expect(sample('if: steps.changes.outputs.relevant == \'true\'')).toBe(false);
    expect(sample('if [ -n "$pregrepped" ]; then')).toBe(false);
  });

  it.each(FILES.map((name) => [name]))('%s has no `if grep` that is not listed with a reason', (name) => {
    const allowed = (REMAINING_IF_GREP[name] ?? []).map((entry) => entry.line);
    const offenders = ifGrepLines(name).filter((line) => !allowed.includes(line));
    expect(
      offenders,
      `${name} tests grep inside an \`if\`. grep exits 2 when it cannot read its pattern, and \`if\` takes that as "no match", so a broken filter ` +
        'would skip a job (or let a bad patch through). Keep the exit status instead (status=0; grep ... || status=$?) and fail the step on anything ' +
        'but 0 or 1, as the change-detection steps in ci.yml, codeql.yml and iac-validate.yml do. Only a line with a reason in REMAINING_IF_GREP may stay:\n  ' +
        offenders.join('\n  ')
    ).toEqual([]);
  });

  it('every listed exception is still there and still has a reason (a stale entry would hide a gap)', () => {
    for (const [name, entries] of Object.entries(REMAINING_IF_GREP)) {
      expect(FILES, `${name} is listed but is not a workflow file`).toContain(name);
      const present = ifGrepLines(name);
      for (const { line, why } of entries) {
        expect(present, `${name}: this listed line is no longer in the file, so remove it from REMAINING_IF_GREP:\n  ${line}`).toContain(line);
        expect(why.length, `${name}: ${line} needs a reason`).toBeGreaterThan(40);
      }
    }
  });

  it('lists nothing in the three workflows whose change-detection steps are tested above', () => {
    for (const name of ['ci.yml', 'codeql.yml', 'iac-validate.yml']) expect(REMAINING_IF_GREP[name], `${name} must have no \`if grep\` at all`).toBeUndefined();
  });
});
