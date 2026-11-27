/**
 * The issue step of check-swa-certificates.yml, run for real (#1929).
 *
 * The step's shell is taken out of the workflow and run with `bash -e`, as a
 * runner does, against a stand-in `gh` that records each call, answers `issue
 * list` and the two `api` reads with what the test set, and applies the
 * step's own `--jq` with the real jq. The shape is check-drill-age.yml's
 * (label plus exact title, close on a clean run of `main` only), with one
 * addition: on an open issue it comments only when the report's state line
 * differs from the last one the workflow itself posted.
 *
 * Needs bash and jq. Where either is missing the shell tests are skipped and
 * say so in their name; on GitHub Actions a test fails instead, so they
 * cannot be skipped there by accident.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findBashTools, parseJobs } from './lib/workflow-text.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = join(REPO, '.github', 'workflows', 'check-swa-certificates.yml');
const TEXT = readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');
const JOB = parseJobs(TEXT).find((job) => job.key === 'check');
const READ_STEP = 'Read the two certificates';
const ISSUE_STEP = 'Open, update or close the certificate issue';
const FAIL_STEP = 'Fail the run while a certificate needs action or could not be read';
const TITLE = 'Static Web App certificate needs attention: hybridcloudworks.com or www';
const step = JOB?.steps.find((s) => s.name === ISSUE_STEP);
const readStep = JOB?.steps.find((s) => s.name === READ_STEP);

describe('check-swa-certificates.yml: its shape', () => {
  it('reads, then reports, then fails the run, in that order', () => {
    expect(JOB, 'no job named check').toBeDefined();
    expect(JOB.steps.map((s) => s.name).slice(-3)).toEqual([READ_STEP, ISSUE_STEP, FAIL_STEP]);
  });

  it('runs daily and by hand, with a timeout', () => {
    expect(TEXT).toMatch(/\n {4}- cron: '35 5 \* \* \*'\n/);
    expect(TEXT).toContain('\n  workflow_dispatch:\n');
    expect(JOB.lines.join('\n')).toMatch(/\n {4}timeout-minutes: 5\n/);
  });

  it('grants issues: write to its one job, nothing at the top, and uses no secret or environment', () => {
    expect(TEXT).toMatch(/\npermissions: \{\}\n/);
    const grants = JOB.lines.filter((l) => /^\s+\w+:\s*write\b/.test(l)).map((l) => l.trim());
    expect(grants).toEqual(['issues: write # open, comment on or close the one certificate issue']);
    expect(TEXT).not.toContain('secrets.');
    expect(JOB.lines.some((l) => /^ {4}environment:/.test(l))).toBe(false);
  });

  it('pins every action by full commit and keeps the checkout token out of the workspace', () => {
    const uses = TEXT.split('\n').filter((l) => /^\s+uses:/.test(l));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) expect(line).toMatch(/uses: [\w-]+\/[\w-]+@[0-9a-f]{40} # v\d/);
    expect(TEXT).toContain('persist-credentials: false');
  });

  it('reads the host from the same variable as the frontend deploy, passed through env', () => {
    expect(readStep.env.ORIGIN_HOST).toBe('${{ vars.STATIC_WEB_APP_DEFAULT_HOSTNAME }}');
    expect(readStep.run).toContain('node scripts/check-swa-certificates.mjs "${args[@]}" --summary "${RUNNER_TEMP}/swa-certs.md" || code=$?');
  });

  it('runs the issue step on every exit, so a clean run can close the issue', () => {
    expect(step.if).toBeUndefined();
    expect(step.env.CERTS_EXIT).toBe('${{ steps.certs.outputs.exit }}');
  });

  it('takes every value through env:, never an expression in the shell', () => {
    for (const s of JOB.steps.filter((x) => x.run)) {
      expect(s.run.includes('${{'), `${s.name}: an expression inside run: is the template-injection shape`).toBe(false);
    }
  });

  it('keys the issue on one fixed title and the Platform label, never on search', () => {
    expect(step.run).toContain(`title="${TITLE}"`);
    expect(step.run).toContain('label="Platform"');
    expect(step.run).not.toContain('--search');
  });
});

const TOOLS = findBashTools();
const JQ_READY = spawnSync('jq', ['--version'], { encoding: 'utf8' }).status === 0;
const READY = TOOLS.ready && JQ_READY;
const SKIPPED = READY ? '' : ` (SKIPPED here: ${TOOLS.ready ? 'jq is not on the path' : TOOLS.why}; they run on GitHub Actions)`;
const forward = (path) => path.replace(/\\/g, '/');

describe('check-swa-certificates.yml: bash and jq are there', () => {
  it.skipIf(process.env.GITHUB_ACTIONS !== 'true')('on GitHub Actions bash and jq are present, so the tests below run', () => {
    expect(TOOLS.ready, TOOLS.why).toBe(true);
    expect(JQ_READY).toBe(true);
  });
});

describe.skipIf(!READY)(`check-swa-certificates.yml certificate issue: run with bash -e${SKIPPED}`, () => {
  const RUN_URL = 'https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/runs/1';
  const OPEN = JSON.stringify([{ number: 12, title: TITLE }]);
  const STATE_WARN = '<!-- swa-cert-check state: hybridcloudworks.com=warn:2027-02-23 www.hybridcloudworks.com=ok:2027-05-01 -->';
  const STATE_ACT = '<!-- swa-cert-check state: hybridcloudworks.com=act:2027-02-23 www.hybridcloudworks.com=ok:2027-05-01 -->';
  const report = (state) => `## Static Web App certificates\n\n| x | y |\n\n${state}\n`;
  const bot = (body) => ({ user: { login: 'github-actions[bot]' }, body });
  let work;
  let bin;
  let runs = 0;

  beforeAll(() => {
    work = forward(mkdtempSync(join(tmpdir(), 'swa-cert-check-issue-')));
    bin = `${work}/bin`;
    mkdirSync(bin);
    // A stand-in for gh: it records each call, one line of arguments joined by
    // `|`, and answers `issue list`, the issue read and the comments read with
    // what the test set. With --jq it applies that expression with the real
    // jq; the comments answer is a JSON array, as REST returns.
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
        '  api\\ *comments*) [ -n "$FAKE_API_FAILS" ] && exit 1; answer="$FAKE_COMMENTS" ;;',
        '  api\\ *) [ -n "$FAKE_API_FAILS" ] && exit 1; answer="$FAKE_ISSUE" ;;',
        '  *) exit 0 ;;',
        'esac',
        'if [ -n "$expr" ]; then jq -r "$expr" <<< "$answer"; else printf "%s\\n" "$answer"; fi',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  function runIssue(exit, { list = '[]', ref = 'refs/heads/main', listFails = false, apiFails = false, summary = report(STATE_WARN), issue = bot('old'), comments = [] } = {}) {
    const dir = `${work}/run-${++runs}`;
    mkdirSync(dir);
    writeFileSync(`${dir}/swa-certs.md`, summary);
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
        FAKE_API_FAILS: apiFails ? '1' : '',
        FAKE_ISSUE: JSON.stringify(issue),
        FAKE_COMMENTS: JSON.stringify(comments),
        GH_TOKEN: 'not-a-real-token',
        REPO: 'saulpatinojr/HCW-HybridCloudWorks',
        RUN_URL,
        CERTS_EXIT: String(exit),
        GITHUB_REF: ref,
      },
      encoding: 'utf8',
    });
    const calls = readFileSync(`${dir}/gh.log`, 'utf8').split('\n').filter(Boolean);
    const writes = calls.filter((c) => /^issue\|(create|comment|close)\|/.test(c));
    const body = existsSync(`${dir}/issue.md`) ? readFileSync(`${dir}/issue.md`, 'utf8') : '';
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls, writes, body, dir };
  }

  it('looks the issue up by its label in the issue list, not through search', () => {
    const got = runIssue(1);
    expect(got.status, got.stderr).toBe(0);
    expect(got.calls[0]).toBe('issue|list|--repo|saulpatinojr/HCW-HybridCloudWorks|--state|open|--label|Platform|--limit|200|--json|number,title');
  });

  it('needs action with none open: creates it, labelled Platform and owner-gated, with the report and the run', () => {
    const got = runIssue(1);
    expect(got.status, got.stderr).toBe(0);
    expect(got.writes).toEqual([
      `issue|create|--repo|saulpatinojr/HCW-HybridCloudWorks|--title|${TITLE}|--label|Platform|--label|owner-gated|--body-file|${got.dir}/issue.md`,
    ]);
    expect(got.body).toContain(RUN_URL);
    expect(got.body).toContain(STATE_WARN);
  });

  it('an unreadable certificate (exit 2) opens the issue too', () => {
    const got = runIssue(2);
    expect(got.writes[0]).toMatch(/^issue\|create\|/);
  });

  it('with the issue open and the same state already posted by the workflow: no new comment', () => {
    const got = runIssue(1, { list: OPEN, comments: [bot(`Daily check\n\n${report(STATE_WARN)}`)] });
    expect(got.status, got.stderr).toBe(0);
    expect(got.writes).toEqual([]);
    expect(got.stdout).toContain('Same state as the last report on #12; no new comment.');
  });

  it('the same state in the issue body the workflow opened with also counts', () => {
    const got = runIssue(1, { list: OPEN, issue: bot(report(STATE_WARN)) });
    expect(got.writes).toEqual([]);
  });

  it('a new stage (30 days to 14) is posted, judged against the LAST state posted', () => {
    const got = runIssue(1, { list: OPEN, summary: report(STATE_ACT), comments: [bot(report(STATE_ACT)), bot(report(STATE_WARN))] });
    expect(got.writes).toEqual([`issue|comment|12|--repo|saulpatinojr/HCW-HybridCloudWorks|--body-file|${got.dir}/issue.md`]);
  });

  it('a state line copied into someone else\'s comment does not silence the report', () => {
    const got = runIssue(1, { list: OPEN, issue: { user: { login: 'someone' }, body: report(STATE_WARN) }, comments: [{ user: { login: 'someone' }, body: report(STATE_WARN) }] });
    expect(got.writes).toHaveLength(1);
    expect(got.writes[0]).toMatch(/^issue\|comment\|12\|/);
  });

  it('a report with no state line (a crash summary) is always posted', () => {
    const got = runIssue(2, { list: OPEN, summary: '## Static Web App certificates\n\nThe check ended with exit 9 and wrote no summary.\n', comments: [bot(report(STATE_WARN))] });
    expect(got.writes[0]).toMatch(/^issue\|comment\|12\|/);
  });

  it('posts anyway when the earlier reports cannot be read', () => {
    const got = runIssue(1, { list: OPEN, apiFails: true });
    expect(got.status, got.stderr).toBe(0);
    expect(got.writes[0]).toMatch(/^issue\|comment\|12\|/);
    expect(got.stdout).toContain('could not be read, so this one is posted');
  });

  it('a missing exit output is reported, never taken as good', () => {
    const got = runIssue('', { list: OPEN });
    expect(got.writes.some((w) => w.startsWith('issue|close|'))).toBe(false);
  });

  it('good again closes the open issue on main, with a comment naming the run', () => {
    const got = runIssue(0, { list: OPEN });
    expect(got.status, got.stderr).toBe(0);
    expect(got.writes).toEqual([
      `issue|close|12|--repo|saulpatinojr/HCW-HybridCloudWorks|--reason|completed|--comment|Both certificates are good for more than 30 days again: run ${RUN_URL}.`,
    ]);
  });

  it('good with none open writes nothing; good on another branch closes nothing', () => {
    expect(runIssue(0).writes).toEqual([]);
    const other = runIssue(0, { list: OPEN, ref: 'refs/heads/feature' });
    expect(other.writes).toEqual([]);
    expect(other.stdout).toContain('not main, so #12 is left open');
  });

  it('needs action on another branch: writes nothing, open issue or not, and says the report is in the summary', () => {
    const none = runIssue(1, { ref: 'refs/heads/feature' });
    expect(none.status, none.stderr).toBe(0);
    expect(none.writes).toEqual([]);
    expect(none.stdout).toContain('not main, so no issue is opened or commented on');
    const open = runIssue(2, { list: OPEN, ref: 'refs/heads/feature' });
    expect(open.status, open.stderr).toBe(0);
    expect(open.writes).toEqual([]);
  });

  it('never touches an issue with a similar title', () => {
    const similar = JSON.stringify([{ number: 7, title: `${TITLE} (old)` }]);
    expect(runIssue(0, { list: similar }).writes).toEqual([]);
    expect(runIssue(1, { list: similar }).writes[0]).toMatch(/^issue\|create\|/);
  });

  it('fails the step, writing nothing, when the issue list cannot be read', () => {
    const got = runIssue(1, { list: OPEN, listFails: true });
    expect(got.status).not.toBe(0);
    expect(got.writes).toEqual([]);
  });
});
