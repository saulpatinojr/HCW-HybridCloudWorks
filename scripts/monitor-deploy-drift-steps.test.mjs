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
 *
 * SINCE #1661 THE HEALTH STEP HANDS ITS EXIT CODE ON instead of exiting with
 * it. It writes `exit=<code>` to its outputs and the report to a file, and
 * passes; the step after it opens, comments on or closes the one
 * workflow-health issue, and the last step fails the job on a non-zero code.
 * So the health step's runs below expect the step to pass and the code to be
 * in its outputs, and the issue and fail steps are run too, against a
 * stand-in `gh` that records what it was asked to do.
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

// [job key, step name, the script the step runs, whether stderr is part of the
// report, whether the step hands the exit code on as an output (#1661)]
const STEPS = [
  ['check', 'Measure the drift', 'scripts/check-deploy-drift.mjs', false, false],
  ['workflows', 'Read the run history', 'scripts/check-workflow-health.mjs', true, true],
];
const ISSUE_STEP = 'Open, update or close the workflow-health issue';
const FAIL_STEP = 'Fail the job while a workflow is broken or failing, or unread';
const ISSUE_TITLE = 'Workflow health: a workflow is broken or keeps failing its scheduled runs';
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

describe('monitor-deploy-drift.yml workflow-health issue (#1661): its shape', () => {
  const job = JOBS.find((j) => j.key === 'workflows');
  const names = job.steps.map((s) => s.name);

  it('reads the history, then handles the issue, then fails the job, in that order and last', () => {
    expect(names.slice(-3)).toEqual(['Read the run history', ISSUE_STEP, FAIL_STEP]);
    expect(stepOf('workflows', 'Read the run history').id).toBe('health');
  });

  it('touches the issue only on a verdict (0 or 1), never when the history could not be read (2)', () => {
    expect(stepOf('workflows', ISSUE_STEP).if).toBe("steps.health.outputs.exit == '0' || steps.health.outputs.exit == '1'");
  });

  it('fails the job on any non-zero code, after the issue step, even if that step failed', () => {
    expect(stepOf('workflows', FAIL_STEP).if).toBe(
      "${{ !cancelled() && steps.health.outcome == 'success' && steps.health.outputs.exit != '0' }}"
    );
  });

  it.each([ISSUE_STEP, FAIL_STEP])('%s takes every value through env:, never an expression in the shell', (name) => {
    const step = stepOf('workflows', name);
    expect(step.run.includes('${{'), `${name}: an expression inside run: is the template-injection shape`).toBe(false);
    expect(step.shell).toBeUndefined();
  });

  it('spells the Actions token one way throughout the file', () => {
    const code = readFileSync(WORKFLOW, 'utf8')
      .split(/\r?\n/)
      .filter((l) => !/^\s*#/.test(l));
    expect(code.some((l) => l.includes('github.token'))).toBe(false);
    expect(stepOf('workflows', ISSUE_STEP).env.GH_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}');
  });

  it('keys the issue on one fixed title', () => {
    expect(stepOf('workflows', ISSUE_STEP).run).toContain(`title="${ISSUE_TITLE}"`);
  });

  it('grants issues: write to the workflows job only, and nothing at the top of the file', () => {
    const text = readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');
    expect(text).toMatch(/\npermissions: \{\}\n/);
    const grants = (lines) => lines.filter((l) => /^\s+\w+:\s*write\b/.test(l)).map((l) => l.trim());
    expect(grants(job.lines)).toEqual([
      'issues: write # open, comment on or close the one workflow-health issue (#1661)',
    ]);
    expect(grants(JOBS.find((j) => j.key === 'check').lines)).toEqual([]);
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
    const dir = `${work}/run-${++runs}`;
    mkdirSync(dir);
    const summary = `${dir}/summary.md`;
    writeFileSync(summary, '');
    writeFileSync(`${dir}/output.txt`, '');
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', step.run], {
      cwd: REPO,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_EXIT: String(code),
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_OUTPUT: `${dir}/output.txt`,
        RUNNER_TEMP: dir,
      },
      encoding: 'utf8',
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      summary: readFileSync(summary, 'utf8'),
      output: readFileSync(`${dir}/output.txt`, 'utf8'),
      dir,
    };
  }

  const CASES = STEPS.flatMap(([jobKey, name, script, withStderr, handsOn]) =>
    [0, 1, 2].map((code) => [jobKey, name, code, script, withStderr, handsOn])
  );

  it.each(CASES)('%s / %s, script exits %i: the report reaches the log and the summary, and the code is not lost', (jobKey, name, code, script, withStderr, handsOn) => {
    const result = run(jobKey, name, code);
    const report = `## Report from ${script}`;
    if (handsOn) {
      // The health step passes and hands the code to the two steps after it,
      // with the report in a file for the issue (#1661).
      expect(result.status, result.stderr).toBe(0);
      expect(result.output).toBe(`exit=${code}\n`);
      expect(readFileSync(`${result.dir}/health.md`, 'utf8')).toContain(report);
    } else {
      expect(result.status, result.stderr).toBe(code);
    }
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

/** The issue step pipes `gh issue list` through jq, which GitHub's runners have. */
const JQ_READY = spawnSync('jq', ['--version'], { encoding: 'utf8' }).status === 0;
const ISSUE_READY = TOOLS.ready && JQ_READY;
const ISSUE_SKIPPED = ISSUE_READY ? '' : ` (SKIPPED here: ${TOOLS.ready ? 'jq is not on the path' : TOOLS.why}; they run on GitHub Actions)`;

describe('monitor-deploy-drift.yml workflow-health issue: jq is there', () => {
  it.skipIf(process.env.GITHUB_ACTIONS !== 'true')('on GitHub Actions jq is present, so the issue tests below run', () => {
    expect(JQ_READY).toBe(true);
  });
});

describe.skipIf(!ISSUE_READY)(`monitor-deploy-drift.yml workflow-health issue (#1661): run with bash -e${ISSUE_SKIPPED}`, () => {
  const RUN_URL = 'https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/runs/1';
  const KEY = '<!-- workflow-health findings: .github/workflows/update-avm-versions.yml:failing -->';
  const REPORT = `## Workflow health\n\n- \`.github/workflows/update-avm-versions.yml\` — last 2 scheduled runs failed\n\n${KEY}\n`;
  const OPEN = JSON.stringify([{ number: 12, title: ISSUE_TITLE }]);
  let work;
  let bin;
  let runs = 0;

  beforeAll(() => {
    work = forward(mkdtempSync(join(tmpdir(), 'health-issue-')));
    bin = `${work}/bin`;
    mkdirSync(bin);
    // A stand-in for gh: it records each call, one line of arguments joined by
    // `|`, and answers `issue list` and the REST reads of the issue with what the test set.
    // When asked with --jq, it applies that expression with the real jq, so
    // the step's own filter is what is tested (gh uses gojq, which reads
    // these expressions the same way).
    writeFileSync(
      `${bin}/gh`,
      [
        '#!/usr/bin/env bash',
        '(IFS="|"; printf "%s\\n" "$*") >> "$GH_LOG"',
        'expr=""',
        'args=("$@")',
        'for i in "${!args[@]}"; do [ "${args[$i]}" = "--jq" ] && expr="${args[$((i + 1))]}"; done',
        'case "$1 $2" in',
        '  "issue list") answer="$FAKE_LIST" ;;',
        '  "api "*/comments*) [ -n "$FAKE_VIEW_FAILS" ] && exit 1; answer=$(jq -c ".comments" <<< "$FAKE_VIEW") ;;',
        '  "api "*/issues/*) answer="$FAKE_VIEW" ;;',
        '  *) exit 0 ;;',
        'esac',
        'if [ -n "$expr" ]; then jq -r "$expr" <<< "$answer"; else printf "%s\\n" "$answer"; fi',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  // What the REST API answers for the open issue (#1688): the issue, with its
  // body and who wrote it, and its comments, oldest first. A string is text
  // the workflow posted (`github-actions[bot]`); `{ body, by }` is someone else's.
  const post = (c) => (c !== null && typeof c === 'object' ? { body: c.body, user: { login: c.by } } : { body: c, user: { login: 'github-actions[bot]' } });
  const view = (body, ...comments) => JSON.stringify({ ...post(body), comments: comments.map(post) });

  /** Runs the issue step with the health step's exit code and what `gh` should answer. */
  function runIssue(healthExit, { list = '[]', viewed = view(''), report = REPORT, viewFails = false } = {}) {
    const dir = `${work}/run-${++runs}`;
    mkdirSync(dir);
    writeFileSync(`${dir}/health.md`, report);
    writeFileSync(`${dir}/gh.log`, '');
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', stepOf('workflows', ISSUE_STEP).run], {
      cwd: REPO,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: dir,
        GH_LOG: `${dir}/gh.log`,
        FAKE_LIST: list,
        FAKE_VIEW: viewed,
        FAKE_VIEW_FAILS: viewFails ? '1' : '',
        GH_TOKEN: 'not-a-real-token',
        REPO: 'saulpatinojr/HCW-HybridCloudWorks',
        RUN_URL,
        HEALTH_EXIT: String(healthExit),
      },
      encoding: 'utf8',
    });
    const calls = readFileSync(`${dir}/gh.log`, 'utf8').split('\n').filter(Boolean);
    const writes = calls.filter((c) => !/^issue\|list\|/.test(c) && !/^api\|repos\//.test(c));
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls, writes, dir };
  }

  it('a finding and no open issue: creates it, with the report and the run in the body', () => {
    const got = runIssue(1);
    expect(got.status, got.stderr).toBe(0);
    expect(got.writes).toEqual([
      `issue|create|--repo|saulpatinojr/HCW-HybridCloudWorks|--title|${ISSUE_TITLE}|--label|Platform|--body-file|${got.dir}/health-issue.md`,
    ]);
    const body = readFileSync(`${got.dir}/health-issue.md`, 'utf8');
    expect(body).toContain(RUN_URL);
    expect(body).toContain('update-avm-versions.yml');
    expect(body).toContain(KEY);
  });

  it('looks the issue up by its label in the issue list, not through search, whose index lags', () => {
    const got = runIssue(1);
    expect(got.calls[0]).toBe(
      'issue|list|--repo|saulpatinojr/HCW-HybridCloudWorks|--state|open|--label|Platform|--limit|200|--json|number,title'
    );
  });

  it('exit 1 with no findings line is an uncaught crash, not a report: no issue is opened or touched', () => {
    const got = runIssue(1, { list: OPEN, report: 'TypeError: something nobody foresaw\n    at main\n' });
    expect(got.status, got.stderr).toBe(0);
    expect(got.calls).toEqual([]);
    expect(got.stdout).toContain('::warning::');
  });

  it('a comment from a person after the last report does not make the same findings look new', () => {
    const got = runIssue(1, {
      list: OPEN,
      viewed: view(`first report\n${KEY}`, 'I am looking at this, give me a day.'),
    });
    expect(got.status, got.stderr).toBe(0);
    expect(got.writes).toEqual([]);
  });

  it('compares with the newest report, not an older one that happens to match', () => {
    const got = runIssue(1, {
      list: OPEN,
      viewed: view(`first report\n${KEY}`, 'later report\n<!-- workflow-health findings: .github/workflows/other.yml:broken -->'),
    });
    expect(got.writes).toHaveLength(1);
    expect(got.writes[0]).toMatch(/^issue\|comment\|12\|/);
  });

  it('an issue opened by hand with no body (null) is read as no report yet, not a failed step', () => {
    const got = runIssue(1, { list: OPEN, viewed: view(null, 'I opened this by hand.') });
    expect(got.status, got.stderr).toBe(0);
    expect(got.writes).toHaveLength(1);
    expect(got.writes[0]).toMatch(/^issue\|comment\|12\|/);
  });

  it('an open issue with a similar but different title is left alone, and a new one created', () => {
    const got = runIssue(1, { list: JSON.stringify([{ number: 7, title: `${ISSUE_TITLE} (old)` }]) });
    expect(got.status, got.stderr).toBe(0);
    expect(got.writes).toHaveLength(1);
    expect(got.writes[0]).toMatch(/^issue\|create\|/);
  });

  it('a findings line copied into someone else\'s comment does not make the findings look reported (#1688)', () => {
    const got = runIssue(1, { list: OPEN, viewed: view({ body: 'opened by hand', by: 'someone-else' }, { body: `copied\n${KEY}`, by: 'someone-else' }) });
    expect(got.status, got.stderr).toBe(0);
    expect(got.writes).toHaveLength(1);
    expect(got.writes[0]).toMatch(/^issue\|comment\|12\|/);
  });

  it('a key quoted inside a line of an earlier report, not on a line of its own, does not count (#1688)', () => {
    const got = runIssue(1, { list: OPEN, viewed: view(`see ${KEY} above`) });
    expect(got.writes[0]).toMatch(/^issue\|comment\|12\|/);
  });

  it('reads the earlier reports through REST, every page of comments (#1688)', () => {
    const got = runIssue(1, { list: OPEN });
    const reads = got.calls.filter((c) => c.startsWith('api|'));
    expect(reads[0]).toMatch(/^api\|repos\/saulpatinojr\/HCW-HybridCloudWorks\/issues\/12\|--jq\|/);
    expect(reads[1]).toMatch(/^api\|repos\/saulpatinojr\/HCW-HybridCloudWorks\/issues\/12\/comments\?per_page=100\|--paginate\|--jq\|/);
  });

  it('earlier reports that cannot be read: comments anyway, and says so (#1688)', () => {
    const got = runIssue(1, { list: OPEN, viewed: view(`first\n${KEY}`), viewFails: true });
    expect(got.status, got.stderr).toBe(0);
    expect(got.writes[0]).toMatch(/^issue\|comment\|12\|/);
    expect(got.stdout).toContain('could not be read, so this one is posted');
  });

  it('a finding the open issue does not carry yet: comments on it', () => {
    const got = runIssue(1, {
      list: OPEN,
      viewed: view('an earlier report\n<!-- workflow-health findings: .github/workflows/other.yml:failing -->'),
    });
    expect(got.status, got.stderr).toBe(0);
    expect(got.writes).toEqual([
      `issue|comment|12|--repo|saulpatinojr/HCW-HybridCloudWorks|--body-file|${got.dir}/health-issue.md`,
    ]);
  });

  it('the same findings as the issue already reports: no new comment, so a four-hourly check does not repeat itself', () => {
    const got = runIssue(1, { list: OPEN, viewed: view('body', `earlier\n${KEY}\n`) });
    expect(got.status, got.stderr).toBe(0);
    expect(got.writes).toEqual([]);
    expect(got.stdout).toContain('#12 already reports these findings');
  });

  it('clean, with the issue open: closes it with a comment naming the run', () => {
    const got = runIssue(0, { list: JSON.stringify([{ number: 12, title: ISSUE_TITLE }]) });
    expect(got.status, got.stderr).toBe(0);
    expect(got.writes).toEqual([
      `issue|close|12|--repo|saulpatinojr/HCW-HybridCloudWorks|--reason|completed|--comment|Clean again: run ${RUN_URL} found no broken or failing workflow.`,
    ]);
  });

  it('clean, with no issue open: writes nothing', () => {
    const got = runIssue(0);
    expect(got.status, got.stderr).toBe(0);
    expect(got.writes).toEqual([]);
  });

  /** Runs the last step, which fails the job on a non-zero code. */
  function runFail(healthExit) {
    return spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', stepOf('workflows', FAIL_STEP).run], {
      cwd: REPO,
      env: { ...process.env, HEALTH_EXIT: healthExit },
      encoding: 'utf8',
    });
  }

  it('the last step keeps the job red with the code the check gave, and says which case it was', () => {
    const one = runFail('1');
    expect(one.status).toBe(1);
    expect(one.stdout).toContain('broken or keeps failing');
    const two = runFail('2');
    expect(two.status).toBe(2);
    expect(two.stdout).toContain('could not be read');
    // An empty output (the step wrote none) is still a failure, not a pass.
    expect(runFail('').status).toBe(1);
  });
});
