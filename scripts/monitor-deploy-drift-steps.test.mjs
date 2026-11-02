/**
 * The two report steps of monitor-deploy-drift.yml print their report on a red
 * run, not only on a green one.
 *
 * THE DEFECT THIS EXISTS FOR. Both steps captured the script's report with
 * `report=$(node ...)`, read the exit code with `status=$?` on the next line,
 * then echoed the report to the log and the step summary. Neither step sets
 * `shell:`, so GitHub runs it as `bash -e {0}` (the job log prints
 * `shell: /usr/bin/bash -e {0}`), and `set -uo pipefail` does not turn `-e`
 * off. Under `-e` an assignment whose command substitution exits non-zero ends
 * the step on that line. So on exit 1 (drift found) or exit 2 (could not read)
 * the echo never ran, and the log and the summary were blank in exactly the
 * runs an operator opens. Seen on runs 41219040554, 41238281521, 41258066344,
 * 41272679445 and 41325654390 ("Is production behind main?"): each log goes
 * from the env block straight to `Process completed with exit code 1.`
 *
 * The fix is `status=0` then `report=$(...) || status=$?`: a command on the
 * left of `||` is exempt from `-e`. These tests take each step's shell out of
 * the workflow and run it with `bash -e`, the way a runner does, against a
 * stand-in `node` that prints a report and exits 0, 1 or 2. Reading the text
 * alone would not have caught this, because the old text looked correct.
 *
 * Needs bash on the path. Where it is missing (Windows without Git Bash) the
 * shell tests are skipped and say so in their name; on GitHub Actions a test
 * fails instead, so they cannot be skipped there by accident.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findBashTools, parseJobs } from './lib/workflow-text.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = join(REPO, '.github', 'workflows', 'monitor-deploy-drift.yml');
const JOBS = parseJobs(readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n'));

// [job key, step name, the script the step runs, whether stderr is part of the report]
const STEPS = [
  ['check', 'Measure the drift', 'scripts/check-deploy-drift.mjs', false],
  ['workflows', 'Read the run history', 'scripts/check-workflow-health.mjs', true],
];
const stepOf = (jobKey, name) =>
  JOBS.find((job) => job.key === jobKey)?.steps.find((step) => step.name === name);

/** The step's shell without its comment lines, so prose cannot satisfy an assertion. */
const codeLines = (run) =>
  run
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

describe('monitor-deploy-drift.yml report steps: their shape', () => {
  it.each(STEPS)('%s / %s exists, runs its script, and sets no shell of its own', (jobKey, name, script) => {
    const step = stepOf(jobKey, name);
    expect(step?.run, `no step named "${name}" in job ${jobKey}`).toBeDefined();
    expect(step.run).toContain(`node ${script}`);
    // With no `shell:` GitHub uses `bash -e {0}`, which is what the run below
    // reproduces. A `shell:` added later would change that and should bring
    // this test with it.
    expect(step.shell).toBeUndefined();
    expect(step.run.includes('${{'), `${name}: an expression in the shell text would not be expanded by this test`).toBe(false);
  });

  it.each(STEPS)('%s / %s reads the exit code through `||`, never from a bare `status=$?` after the capture', (jobKey, name, script) => {
    const lines = codeLines(stepOf(jobKey, name).run);
    const capture = lines.findIndex((line) => line.includes(`node ${script}`));
    expect(lines[capture]).toMatch(/^report=\$\(node [^)]*\) \|\| status=\$\?$/);
    expect(lines[capture - 1], 'status must start at 0, so a green run exits 0').toBe('status=0');
    expect(lines[capture + 1], 'a bare `status=$?` after the capture is the shape `-e` cuts short').not.toBe('status=$?');
    expect(lines.some((line) => /^set\s+-[a-z]*e/.test(line)), `${name} turns -e on explicitly`).toBe(false);
  });
});

const TOOLS = findBashTools();
const SKIPPED = TOOLS.ready ? '' : ` (SKIPPED here: ${TOOLS.why}; they run on GitHub Actions)`;
const forward = (path) => path.replace(/\\/g, '/');

describe('monitor-deploy-drift.yml report steps: bash is there', () => {
  it.skipIf(process.env.GITHUB_ACTIONS !== 'true')('on GitHub Actions bash is present, so the shell tests below run', () => {
    expect(TOOLS.ready, TOOLS.why).toBe(true);
  });
});

describe.skipIf(!TOOLS.ready)(`monitor-deploy-drift.yml report steps: run with bash -e${SKIPPED}`, () => {
  let work;
  let bin;
  let runs = 0;

  beforeAll(() => {
    work = forward(mkdtempSync(join(tmpdir(), 'drift-steps-')));
    bin = `${work}/bin`;
    mkdirSync(bin);
    // A stand-in for node: a report on stdout, a line on stderr, then the exit
    // code it is told. The real scripts write their exit-2 refusals to stderr.
    writeFileSync(
      `${bin}/node`,
      '#!/usr/bin/env bash\nprintf "## Report from %s\\n| row | cell |\\n" "$1"\nprintf "stderr line from %s\\n" "$1" >&2\nexit "$FAKE_EXIT"\n',
      { mode: 0o755 }
    );
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  /** Runs one step's shell the way a runner does (`bash -e`), with the stand-in node exiting `code`. */
  function run(jobKey, name, code) {
    const step = stepOf(jobKey, name);
    const summary = `${work}/summary-${++runs}.md`;
    writeFileSync(summary, '');
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', step.run], {
      cwd: REPO,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_EXIT: String(code), GITHUB_STEP_SUMMARY: summary },
      encoding: 'utf8',
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, summary: readFileSync(summary, 'utf8') };
  }

  const CASES = STEPS.flatMap(([jobKey, name, script, withStderr]) =>
    [0, 1, 2].map((code) => [jobKey, name, code, script, withStderr])
  );

  it.each(CASES)('%s / %s, script exits %i: the report reaches the log and the summary, and the step exits the same', (jobKey, name, code, script, withStderr) => {
    const result = run(jobKey, name, code);
    const report = `## Report from ${script}`;
    expect(result.status, result.stderr).toBe(code);
    expect(result.stdout, 'the log is blank: the capture was cut short').toContain(report);
    expect(result.summary, 'the step summary is blank: the capture was cut short').toContain(report);
    expect(result.summary).toContain('| row | cell |');
    // The health step redirects stderr into the report (its exit-2 refusals
    // are written there); the drift step does not, and its stderr stays in the
    // log on its own.
    if (withStderr) expect(result.summary).toContain(`stderr line from ${script}`);
    else expect(result.summary).not.toContain(`stderr line from ${script}`);
  });

  it('the old shape really did print nothing, so the test above can tell the two apart', () => {
    const old = 'set -uo pipefail\nreport=$(node scripts/check-deploy-drift.mjs)\nstatus=$?\necho "$report" | tee -a "$GITHUB_STEP_SUMMARY"\nexit $status';
    const summary = `${work}/summary-old.md`;
    writeFileSync(summary, '');
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', old], {
      cwd: REPO,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_EXIT: '1', GITHUB_STEP_SUMMARY: summary },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(readFileSync(summary, 'utf8')).toBe('');
  });
});
