/**
 * No workflow step reads an exit code in a way `bash -e` can cut short, and
 * the two steps that did now keep going on a failing script.
 *
 * THE DEFECT THIS EXISTS FOR. A step with no `shell:` runs as `bash -e {0}`
 * (the job log prints `shell: /usr/bin/bash -e {0}`), and `set -uo pipefail`
 * does not turn `-e` off. Under `-e` the first failing command ends the step,
 * so the pattern
 *
 *     node scripts/check-something.mjs
 *     code=$?
 *
 * never reaches `code=$?` when the script fails, which is the one case the
 * line is there for. #1488 fixed it in monitor-deploy-drift.yml, where red
 * runs printed no report. The same shape was in two more steps:
 *
 * - check-drill-age.yml, "Read the Drills table". On an overdue drill (exit 1)
 *   or an unreadable table (exit 2) the step failed before writing `exit=` to
 *   its outputs, so the two steps that open the drill-overdue issue and fail
 *   the run with the reason were both skipped. Seen on run 38279975200
 *   (2026-10-12): the drill was overdue and no issue was opened.
 * - monitor-unresolved-secrets.yml, "Are the Key Vault references resolving?".
 *   On exit 2 (an ARM payload it does not understand) the step ended with 2
 *   before printing the lines that say the check could not tell.
 *
 * The fix in each is `code=0`, then `command || code=$?`: a command on the
 * left of `||` is exempt from `-e`. The first describe block scans every
 * workflow for the old shape, so a new step cannot bring it back. The rest
 * run the two fixed steps with `bash -e`, as a runner does, against stand-ins
 * for `node` and `az`, because reading the text alone did not catch this.
 *
 * Needs bash on the path. Where it is missing (Windows without Git Bash) the
 * shell tests are skipped and say so in their name; on GitHub Actions a test
 * fails instead, so they cannot be skipped there by accident.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findBashTools, parseJobs } from './lib/workflow-text.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = join(REPO, '.github', 'workflows');

const jobsOf = (file) => parseJobs(readFileSync(join(WORKFLOWS, file), 'utf8').replace(/\r\n/g, '\n'));
const stepOf = (file, jobKey, name) =>
  jobsOf(file)
    .find((job) => job.key === jobKey)
    ?.steps.find((step) => step.name === name);

/** The shell without blank and comment lines, so prose cannot satisfy or trip an assertion. */
const codeLines = (run) =>
  run
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

/** `|| name=$?` ending the line, optionally closing a `case` branch (`;;`) or followed by a comment. */
const GUARDED = /\|\|\s*[A-Za-z_][A-Za-z0-9_]*=\$\?\s*(?:;;?)?\s*(?:#.*)?$/;
/** `set +e` or `set +o errexit`: -e is off from this line on. */
const E_OFF = /^set\s+(?:\+[a-z]*e[a-z]*|\+o\s+errexit)\b/;
/** `set -e`, `set -euo pipefail` or `set -o errexit`: -e is back on. */
const E_ON = /^set\s+(?:-[a-z]*e[a-z]*|-o\s+errexit)\b/;

/**
 * The lines of one step that read an exit code (`$?` or `PIPESTATUS`) where
 * `-e` can stop the step first: any such read except `|| name=$?` at the end
 * of the command's own line (as monitor-functions-registered.yml writes inside
 * a `case`). Lines after a `set +e`, until `-e` is turned back on, are not
 * judged, and neither is a step whose `shell:` is not bash or sh: GitHub runs
 * `shell: bash` as `bash -eo pipefail` and `shell: sh` as `sh -e`, so those
 * stop at the first failure too.
 */
export function unguardedExitReads(step) {
  if (!step.run || (step.shell !== undefined && !/^(?:bash|sh)\b/.test(step.shell))) return [];
  const found = [];
  let errexit = true;
  for (const line of codeLines(step.run)) {
    if (E_OFF.test(line)) errexit = false;
    else if (E_ON.test(line)) errexit = true;
    else if (errexit && /\$\?|PIPESTATUS/.test(line) && !GUARDED.test(line)) found.push(line);
  }
  return found;
}

/** A `run:` whose block the parser did not read: `|-`, `>` and the like leave only the marker. */
const unreadBlock = (step) => typeof step.run === 'string' && /^[|>][-+0-9]*$/.test(step.run.trim());

describe('every workflow: no exit code read where bash -e cuts it short', () => {
  const files = readdirSync(WORKFLOWS).filter((file) => /\.ya?ml$/.test(file));

  it('reads the workflows', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files)('%s', (file) => {
    const steps = jobsOf(file).flatMap((job) => job.steps.map((step) => ({ job: job.key, step })));
    const unread = steps.filter(({ step }) => unreadBlock(step)).map(({ job, step }) => `${job} / ${step.name}: run: ${step.run}`);
    expect(unread, 'this check reads only `run: |` blocks; write the step that way or teach scripts/lib/workflow-text.mjs the form').toEqual([]);
    const found = steps.flatMap(({ job, step }) => unguardedExitReads(step).map((line) => `${job} / ${step.name}: ${line}`));
    expect(found, 'set the variable to 0 first, then read it as `command || name=$?` on the same line').toEqual([]);
  });

  it('sees the shape it is looking for, and lets the fixed shape and set +e through', () => {
    const step = (run, extra = {}) => ({ run, ...extra });
    expect(unguardedExitReads(step('node a.mjs\ncode=$?'))).toEqual(['code=$?']);
    expect(unguardedExitReads(step('report=$(node a.mjs)\nstatus=$?'))).toEqual(['status=$?']);
    expect(unguardedExitReads(step('node a.mjs\nif [ $? -ne 0 ]; then exit 1; fi'))).toEqual(['if [ $? -ne 0 ]; then exit 1; fi']);
    expect(unguardedExitReads(step('a | b\nrc=${PIPESTATUS[0]}'))).toEqual(['rc=${PIPESTATUS[0]}']);
    expect(unguardedExitReads(step('code=0\nnode a.mjs || code=$?'))).toEqual([]);
    expect(unguardedExitReads(step('code=0\nnode a.mjs || code=$?  # why'))).toEqual([]);
    expect(unguardedExitReads(step('case "$x" in\n  a) out=$(node a.mjs) || st=$? ;;\nesac'))).toEqual([]);
    expect(unguardedExitReads(step('node a.mjs || code=$?\necho "$?"'))).toEqual(['echo "$?"']);
    expect(unguardedExitReads(step('# code=$? in a comment\necho ok'))).toEqual([]);
    // -e is off from `set +e` on, and on again from `set -e`.
    expect(unguardedExitReads(step('set +e\nnode a.mjs\ncode=$?'))).toEqual([]);
    expect(unguardedExitReads(step('a | b\nset +e\nb | c\nrc=${PIPESTATUS[0]}'))).toEqual([]);
    expect(unguardedExitReads(step('node a.mjs\ncode=$?\nset +e'))).toEqual(['code=$?']);
    expect(unguardedExitReads(step('set +e\nset -euo pipefail\nnode a.mjs\ncode=$?'))).toEqual(['code=$?']);
    // `set -uo pipefail` leaves -e as it was, which for a runner is on.
    expect(unguardedExitReads(step('set -uo pipefail\nnode a.mjs\ncode=$?'))).toEqual(['code=$?']);
    // bash and sh steps stop at the first failure too; pwsh is another shell.
    expect(unguardedExitReads(step('node a.mjs\ncode=$?', { shell: 'bash' }))).toEqual(['code=$?']);
    expect(unguardedExitReads(step('node a.mjs\ncode=$?', { shell: 'sh' }))).toEqual(['code=$?']);
    expect(unguardedExitReads(step('node a.mjs\ncode=$?', { shell: 'pwsh' }))).toEqual([]);
  });

  it('notices a run block it could not read', () => {
    expect(unreadBlock({ run: '|-' })).toBe(true);
    expect(unreadBlock({ run: '>' })).toBe(true);
    expect(unreadBlock({ run: 'echo ok' })).toBe(false);
    expect(unreadBlock({})).toBe(false);
  });
});

// [file, job key, step name, the script it runs]
const STEPS = [
  ['check-drill-age.yml', 'check', 'Read the Drills table', 'scripts/check-drill-age.mjs'],
  ['monitor-unresolved-secrets.yml', 'check', 'Are the Key Vault references resolving?', 'scripts/check-unresolved-secrets.mjs'],
];

describe('the two fixed steps: their shape', () => {
  it.each(STEPS)('%s / %s exists, runs its script, and sets no shell of its own', (file, jobKey, name, script) => {
    const step = stepOf(file, jobKey, name);
    expect(step?.run, `no step named "${name}" in ${file}`).toBeDefined();
    expect(step.run).toContain(`node ${script}`);
    // With no `shell:` GitHub uses `bash -e {0}`, which is what the runs below
    // reproduce. A `shell:` added later changes that and should bring this
    // test with it.
    expect(step.shell).toBeUndefined();
    expect(step.run.includes('${{'), `${name}: an expression in the shell text would not be expanded by this test`).toBe(false);
  });

  it.each(STEPS)('%s / %s starts the code at 0 and reads it through `||`', (file, jobKey, name, script) => {
    const lines = codeLines(stepOf(file, jobKey, name).run);
    const call = lines.findIndex((line) => line.includes(`node ${script}`));
    expect(lines[call]).toMatch(/ \|\| code=\$\?$/);
    expect(lines[call - 1], 'code must start at 0, so a passing script reads as 0').toBe('code=0');
  });

  it('check-drill-age.yml: the issue and the red run still key on the exit the step writes', () => {
    const steps = jobsOf('check-drill-age.yml').find((job) => job.key === 'check').steps;
    const drill = steps.find((step) => step.name === 'Read the Drills table');
    expect(drill.id).toBe('drill');
    const after = steps.slice(steps.indexOf(drill) + 1);
    // Since #1681 the issue step runs on every exit, so a current drill (0)
    // can close the issue; it reads the exit from env, and its own runs are in
    // check-drill-age-steps.test.mjs. The red run still keys on the output.
    expect(after.map((step) => step.name)).toEqual(['Open, update or close the drill issue', 'Fail the run while the drill is overdue or unreadable']);
    expect(after[0].if).toBeUndefined();
    expect(after[0].env.DRILL_EXIT).toBe('${{ steps.drill.outputs.exit }}');
    expect(after[1].if).toBe("steps.drill.outputs.exit != '0'");
  });
});

const TOOLS = findBashTools();
const SKIPPED = TOOLS.ready ? '' : ` (SKIPPED here: ${TOOLS.why}; they run on GitHub Actions)`;
const forward = (path) => path.replace(/\\/g, '/');

describe('the two fixed steps: bash is there', () => {
  it.skipIf(process.env.GITHUB_ACTIONS !== 'true')('on GitHub Actions bash is present, so the shell tests below run', () => {
    expect(TOOLS.ready, TOOLS.why).toBe(true);
  });
});

describe.skipIf(!TOOLS.ready)(`the two fixed steps: run with bash -e${SKIPPED}`, () => {
  let work;
  let bin;
  let runs = 0;

  beforeAll(() => {
    work = forward(mkdtempSync(join(tmpdir(), 'exit-code-steps-')));
    bin = `${work}/bin`;
    mkdirSync(bin);
    // A stand-in for node. For the drill script it writes the summary file it
    // is handed after --summary, as the real one does on every exit; for the
    // secrets script it drains stdin, as the real one reads the payload. Then
    // it exits with the code it is told.
    writeFileSync(
      `${bin}/node`,
      [
        '#!/usr/bin/env bash',
        // FAKE_NO_SUMMARY plays a crash before the summary is written.
        'if [ "${2:-}" = "--summary" ]; then [ -n "${FAKE_NO_SUMMARY:-}" ] || printf "## Drill summary from the stand-in\\n" > "$3"; else cat > /dev/null; fi',
        'printf "stand-in node, exiting %s\\n" "$FAKE_EXIT" >&2',
        'exit "$FAKE_EXIT"',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
    // A stand-in for az: `az rest` answers with an empty payload, so the step
    // gets as far as the script.
    writeFileSync(`${bin}/az`, '#!/usr/bin/env bash\nprintf \'{"value":[]}\'\n', { mode: 0o755 });
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  /** Runs one step's shell the way a runner does (`bash -e`), with the stand-in node exiting `code`. */
  function run(file, jobKey, name, code, extraEnv = {}) {
    const dir = `${work}/run-${++runs}`;
    mkdirSync(dir);
    for (const file of ['summary.md', 'output.txt']) writeFileSync(`${dir}/${file}`, '');
    const step = stepOf(file, jobKey, name);
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', step.run], {
      cwd: REPO,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_EXIT: String(code),
        ...extraEnv,
        RUNNER_TEMP: dir,
        GITHUB_STEP_SUMMARY: `${dir}/summary.md`,
        GITHUB_OUTPUT: `${dir}/output.txt`,
        // The secrets step's own env, set by the workflow from inputs and vars.
        APP: 'func-site-prod-cus-01',
        RG: 'rg-web-site-prod-cus',
        SUB: '00000000-0000-0000-0000-000000000001',
      },
      encoding: 'utf8',
      timeout: 60000,
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      summary: readFileSync(`${dir}/summary.md`, 'utf8'),
      output: readFileSync(`${dir}/output.txt`, 'utf8'),
    };
  }

  const DRILL = STEPS[0].slice(0, 3);
  const SECRETS = STEPS[1].slice(0, 3);

  it.each([0, 1, 2])('Read the Drills table, script exits %i: the step passes, records the exit and copies the summary', (code) => {
    const result = run(...DRILL, code);
    // The step itself always passes: the steps after it act on `exit=`, and
    // the last of them fails the run with the reason.
    expect(result.status, result.stderr).toBe(0);
    expect(result.output, 'exit= was not written: the issue steps would be skipped').toContain(`exit=${code}`);
    expect(result.summary).toContain('## Drill summary from the stand-in');
  });

  it('Read the Drills table, script crashes before its summary: the step still records the exit and leaves a summary', () => {
    // Without the fallback, `cat` of the missing file fails under -e and the
    // issue steps are skipped, the same failure as the bug this file is for.
    const result = run(...DRILL, 1, { FAKE_NO_SUMMARY: '1' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain('exit=1');
    expect(result.summary).toContain('The check ended with exit 1 and wrote no summary');
  });

  it('Are the Key Vault references resolving?, script exits 0: the step passes', () => {
    expect(run(...SECRETS, 0).status).toBe(0);
  });

  it('Are the Key Vault references resolving?, script exits 1: the step fails with 1', () => {
    expect(run(...SECRETS, 1).status).toBe(1);
  });

  it('Are the Key Vault references resolving?, script exits 2: the step says it could not tell, then fails with 1', () => {
    const result = run(...SECRETS, 2);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout, 'the "could not tell" lines were never printed: -e cut the step short').toContain(
      '::error::The ARM payload was not in a shape this check understands'
    );
  });

  it('the old drill shape really did stop before writing exit=, so the test above can tell the two apart', () => {
    const old = 'set -uo pipefail\nnode scripts/check-drill-age.mjs --summary "${RUNNER_TEMP}/drill.md"\ncode=$?\necho "exit=${code}" >> "$GITHUB_OUTPUT"\nexit 0';
    const dir = `${work}/old`;
    mkdirSync(dir);
    writeFileSync(`${dir}/output.txt`, '');
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', old], {
      cwd: REPO,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_EXIT: '1', RUNNER_TEMP: dir, GITHUB_OUTPUT: `${dir}/output.txt` },
      encoding: 'utf8',
      timeout: 60000,
    });
    expect(result.status).toBe(1);
    expect(readFileSync(`${dir}/output.txt`, 'utf8')).toBe('');
  });
});
