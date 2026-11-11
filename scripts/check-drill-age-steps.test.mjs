/**
 * The drill-overdue issue step of check-drill-age.yml, run for real (#1681).
 *
 * Until #1681 the step found its issue with `gh issue list --search
 * "\"<title>\" in:title"` and took the first result. Search is fuzzy and its
 * index can lag behind a just-created issue, so another open issue with
 * similar words could be picked and commented on. And it ran only on an
 * overdue or unreadable drill, so a drill that was current again left the old
 * issue open. It now works like lab-supply-chain.yml's report issue (#1673):
 * the `Platform` label plus the exact title, read from the issue list, and a
 * close with a comment naming the run when the drill is current, on `main`
 * only.
 *
 * The step's shell is taken out of the workflow and run with `bash -e`, as a
 * runner does, against a stand-in `gh` that records each call and answers
 * `issue list` with what the test set, applying the step's own `--jq` with the
 * real jq (gh uses gojq, which reads these expressions the same way). The
 * step pipes `gh issue list` through jq itself, so jq must be on the path.
 *
 * Needs bash and jq. Where either is missing the tests are skipped and say so
 * in their name; on GitHub Actions a test fails instead, so they cannot be
 * skipped there by accident.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findBashTools, parseJobs } from './lib/workflow-text.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = join(REPO, '.github', 'workflows', 'check-drill-age.yml');
const TEXT = readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');
const JOB = parseJobs(TEXT).find((job) => job.key === 'check');
const ISSUE_STEP = 'Open, update or close the drill issue';
const TITLE = 'Cosmos restore drill overdue: no drill recorded in the last 100 days';
const step = JOB?.steps.find((s) => s.name === ISSUE_STEP);

describe('check-drill-age.yml drill issue (#1681): its shape', () => {
  it('has the step, after the drill is read and before the run is failed', () => {
    expect(step?.run, `no step named "${ISSUE_STEP}"`).toBeDefined();
    const names = JOB.steps.map((s) => s.name);
    expect(names.slice(-3)).toEqual(['Read the Drills table', ISSUE_STEP, 'Fail the run while the drill is overdue or unreadable']);
  });

  it('runs on every exit, so a current drill can close the issue', () => {
    expect(step.if).toBeUndefined();
    expect(step.env.DRILL_EXIT).toBe('${{ steps.drill.outputs.exit }}');
  });

  it('takes every value through env:, never an expression in the shell', () => {
    expect(step.run.includes('${{'), 'an expression inside run: is the template-injection shape').toBe(false);
    expect(step.shell).toBeUndefined();
  });

  it('keys the issue on one fixed title and the Platform label, never on search', () => {
    expect(step.run).toContain(`title="${TITLE}"`);
    expect(step.run).toContain('label="Platform"');
    expect(step.run).not.toContain('--search');
  });

  it('grants issues: write to its one job, and nothing at the top of the file', () => {
    expect(TEXT).toMatch(/\npermissions: \{\}\n/);
    const grants = JOB.lines.filter((l) => /^\s+\w+:\s*write\b/.test(l)).map((l) => l.trim());
    expect(grants).toEqual(['issues: write # open, comment on or close the one drill-overdue issue (#1681)']);
  });
});

const TOOLS = findBashTools();
const JQ_READY = spawnSync('jq', ['--version'], { encoding: 'utf8' }).status === 0;
const READY = TOOLS.ready && JQ_READY;
const SKIPPED = READY ? '' : ` (SKIPPED here: ${TOOLS.ready ? 'jq is not on the path' : TOOLS.why}; they run on GitHub Actions)`;
const forward = (path) => path.replace(/\\/g, '/');

describe('check-drill-age.yml drill issue: bash and jq are there', () => {
  it.skipIf(process.env.GITHUB_ACTIONS !== 'true')('on GitHub Actions bash and jq are present, so the tests below run', () => {
    expect(TOOLS.ready, TOOLS.why).toBe(true);
    expect(JQ_READY).toBe(true);
  });
});

describe.skipIf(!READY)(`check-drill-age.yml drill issue (#1681): run with bash -e${SKIPPED}`, () => {
  const RUN_URL = 'https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/runs/1';
  const OPEN = JSON.stringify([{ number: 12, title: TITLE }]);
  const SUMMARY = '## Cosmos restore drill age\n\nLast drill: 2026-07-01, 133 day(s) ago, more than the 100 allowed. The next one is overdue.\n';
  let work;
  let bin;
  let runs = 0;

  beforeAll(() => {
    work = forward(mkdtempSync(join(tmpdir(), 'drill-issue-')));
    bin = `${work}/bin`;
    mkdirSync(bin);
    // A stand-in for gh: it records each call, one line of arguments joined
    // by `|`, and answers `issue list` with what the test set (or fails, when
    // told to). When asked with --jq, it applies that expression with the
    // real jq, so the step's own filter is what is tested.
    writeFileSync(
      `${bin}/gh`,
      [
        '#!/usr/bin/env bash',
        '(IFS="|"; printf "%s\\n" "$*") >> "$GH_LOG"',
        'expr=""',
        'args=("$@")',
        'for i in "${!args[@]}"; do [ "${args[$i]}" = "--jq" ] && expr="${args[$((i + 1))]}"; done',
        'case "$1 $2" in',
        '  "issue list") [ -n "$FAKE_LIST_FAILS" ] && exit 1; answer="$FAKE_LIST" ;;',
        '  *) exit 0 ;;',
        'esac',
        'if [ -n "$expr" ]; then jq -r "$expr" <<< "$answer"; else printf "%s\\n" "$answer"; fi',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  /** Runs the step with the drill step's exit code and what `gh issue list` answers. */
  function runIssue(drillExit, { list = '[]', ref = 'refs/heads/main', listFails = false } = {}) {
    const dir = `${work}/run-${++runs}`;
    mkdirSync(dir);
    writeFileSync(`${dir}/drill.md`, SUMMARY);
    writeFileSync(`${dir}/gh.log`, '');
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', step.run], {
      cwd: REPO,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: dir,
        GH_LOG: `${dir}/gh.log`,
        FAKE_LIST: list,
        FAKE_LIST_FAILS: listFails ? '1' : '',
        GH_TOKEN: 'not-a-real-token',
        REPO: 'saulpatinojr/HCW-HybridCloudWorks',
        RUN_URL,
        DRILL_EXIT: String(drillExit),
        GITHUB_REF: ref,
      },
      encoding: 'utf8',
    });
    const calls = readFileSync(`${dir}/gh.log`, 'utf8').split('\n').filter(Boolean);
    const writes = calls.filter((c) => /^issue\|(create|comment|close)\|/.test(c));
    const body = existsSync(`${dir}/issue.md`) ? readFileSync(`${dir}/issue.md`, 'utf8') : '';
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls, writes, body, dir };
  }

  it('looks the issue up by its label in the issue list, not through search, whose index lags', () => {
    const got = runIssue(1);
    expect(got.status, got.stderr).toBe(0);
    expect(got.calls[0]).toBe('issue|list|--repo|saulpatinojr/HCW-HybridCloudWorks|--state|open|--label|Platform|--limit|200|--json|number,title');
    expect(got.calls.join('\n')).not.toContain('--search');
  });

  it('overdue with none open: creates it with the label, the summary and the run in the body', () => {
    const got = runIssue(1);
    expect(got.status, got.stderr).toBe(0);
    expect(got.writes).toEqual([
      `issue|create|--repo|saulpatinojr/HCW-HybridCloudWorks|--title|${TITLE}|--label|Platform|--body-file|${got.dir}/issue.md`,
    ]);
    expect(got.body).toContain(RUN_URL);
    expect(got.body).toContain('133 day(s) ago');
    expect(got.body).toContain('**Owner step:**');
  });

  it('overdue with the issue open: comments on it', () => {
    const got = runIssue(1, { list: OPEN });
    expect(got.status, got.stderr).toBe(0);
    expect(got.writes).toEqual([`issue|comment|12|--repo|saulpatinojr/HCW-HybridCloudWorks|--body-file|${got.dir}/issue.md`]);
  });

  it('an open issue with a similar but different title is left alone, and a new one created', () => {
    const got = runIssue(1, {
      list: JSON.stringify([
        { number: 7, title: `${TITLE} (old)` },
        { number: 8, title: 'Cosmos restore drill: write down the RTO' },
      ]),
    });
    expect(got.status, got.stderr).toBe(0);
    expect(got.writes).toHaveLength(1);
    expect(got.writes[0]).toMatch(/^issue\|create\|/);
  });

  it('an unreadable table (exit 2) reports on the open issue and never closes it', () => {
    const got = runIssue(2, { list: OPEN });
    expect(got.status, got.stderr).toBe(0);
    expect(got.writes).toHaveLength(1);
    expect(got.writes[0]).toMatch(/^issue\|comment\|12\|/);
    expect(got.body).toContain('**The table could not be read**');
  });

  it('a missing exit output is reported, not taken as a current drill', () => {
    const got = runIssue('', { list: OPEN });
    expect(got.status, got.stderr).toBe(0);
    expect(got.writes.some((w) => w.startsWith('issue|close|'))).toBe(false);
    expect(got.writes[0]).toMatch(/^issue\|comment\|12\|/);
  });

  it('a current drill closes the open issue on main, with a comment naming the run', () => {
    const got = runIssue(0, { list: OPEN });
    expect(got.status, got.stderr).toBe(0);
    expect(got.writes).toEqual([
      `issue|close|12|--repo|saulpatinojr/HCW-HybridCloudWorks|--reason|completed|--comment|Drill current again: run ${RUN_URL} found a restore drill in the Drills table of docs/runbooks/cosmos-restore.md within the last 100 days.`,
    ]);
    expect(got.stdout).toContain('Closed #12.');
  });

  it('a current drill with none open writes nothing', () => {
    const got = runIssue(0);
    expect(got.status, got.stderr).toBe(0);
    expect(got.writes).toEqual([]);
    expect(got.stdout).toContain('no drill issue is open');
  });

  it('a current drill on another branch never closes the issue', () => {
    const got = runIssue(0, { list: OPEN, ref: 'refs/heads/feature' });
    expect(got.status, got.stderr).toBe(0);
    expect(got.writes).toEqual([]);
    expect(got.stdout).toContain('not main, so #12 is left open');
  });

  it('a current drill never closes an issue with a similar title', () => {
    const got = runIssue(0, { list: JSON.stringify([{ number: 7, title: `${TITLE} (old)` }]) });
    expect(got.status, got.stderr).toBe(0);
    expect(got.writes).toEqual([]);
  });

  it('fails the step, closing nothing, when the issue list cannot be read', () => {
    const got = runIssue(0, { list: OPEN, listFails: true });
    expect(got.status).not.toBe(0);
    expect(got.writes).toEqual([]);
  });
});
