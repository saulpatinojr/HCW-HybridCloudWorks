/**
 * check-swa-certificates.yml (#1929): its two jobs, and its issue step run
 * for real.
 *
 * The workflow is two jobs so that only a run of `main` ever holds a token
 * that can write: `check` (contents: read) reads the certificates and hands
 * the exit code and the report on; `issue` (issues: write) runs only for
 * `refs/heads/main` and opens, comments on or closes the one issue. The
 * shape tests hold that split.
 *
 * The issue step's shell is taken out of the workflow and run with `bash -e`,
 * as a runner does, against a stand-in `gh` that records each call, answers
 * `issue list` and the two `api` reads with what the test set, and applies
 * the step's own `--jq` with the real jq. The shape is check-drill-age.yml's
 * (label plus exact title, close on a clean run), with one addition: on an
 * open issue it comments only when the report's state line differs from the
 * last one the workflow itself posted.
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
const JOBS = parseJobs(TEXT);
const CHECK = JOBS.find((job) => job.key === 'check');
const ISSUE = JOBS.find((job) => job.key === 'issue');
const READ_STEP = 'Read the two certificates';
const FAIL_STEP = 'Fail the run while a certificate needs action or could not be read';
const DECODE_STEP = 'Write the report to a file';
const ISSUE_STEP = 'Open, update or close the certificate issue';
const TITLE = 'Static Web App certificate needs attention: hybridcloudworks.com or www';
const readStep = CHECK?.steps.find((s) => s.name === READ_STEP);
const decodeStep = ISSUE?.steps.find((s) => s.name === DECODE_STEP);
const step = ISSUE?.steps.find((s) => s.name === ISSUE_STEP);

/** A job's own top-level key (4 spaces in), e.g. `if` or `needs`, as written. */
const jobKey = (job, key) => job.lines.find((l) => l.startsWith(`    ${key}:`))?.slice(`    ${key}:`.length).trim();

/** The permission lines of a job, trimmed, comments kept. */
function grants(job) {
  const from = job.lines.indexOf('    permissions:');
  const lines = [];
  for (const line of job.lines.slice(from + 1)) {
    if (!line.startsWith('      ')) break;
    lines.push(line.trim());
  }
  return lines;
}

describe('check-swa-certificates.yml: its shape', () => {
  it('has exactly two jobs, check then issue', () => {
    expect(JOBS.map((j) => j.key)).toEqual(['check', 'issue']);
    expect(CHECK.steps.map((s) => s.name).slice(-2)).toEqual([READ_STEP, FAIL_STEP]);
    expect(ISSUE.steps.map((s) => s.name)).toEqual([DECODE_STEP, ISSUE_STEP]);
  });

  it('runs daily and by hand, with a timeout on each job', () => {
    expect(TEXT.split('\n')).toContain("    - cron: '35 5 * * *'");
    expect(TEXT).toContain('\n  workflow_dispatch:\n');
    expect(jobKey(CHECK, 'timeout-minutes')).toBe('5');
    expect(jobKey(ISSUE, 'timeout-minutes')).toBe('5');
  });

  it("the check job can only read; the write token is the issue job's alone", () => {
    expect(TEXT).toContain('\npermissions: {}\n');
    expect(grants(CHECK)).toEqual(['contents: read # checkout only']);
    expect(grants(ISSUE)).toEqual(['issues: write # open, comment on or close the one certificate issue']);
    expect(TEXT.includes('secrets.')).toBe(false);
    expect(JOBS.some((j) => j.lines.some((l) => l.startsWith('    environment:')))).toBe(false);
  });

  it('runs the issue job only for main, after check, even when check went red', () => {
    expect(jobKey(ISSUE, 'needs')).toBe('check');
    expect(jobKey(ISSUE, 'if')).toBe("${{ !cancelled() && github.ref == 'refs/heads/main' }}");
  });

  it('the issue job checks out nothing and runs no action, so no code from the branch runs with the token', () => {
    expect(ISSUE.steps.every((s) => s.uses === undefined)).toBe(true);
    expect(ISSUE.lines.join('\n').includes('node ')).toBe(false);
  });

  it('pins every action by full commit and keeps the checkout token out of the workspace', () => {
    const uses = TEXT.split('\n').filter((l) => l.trim().startsWith('uses:'));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) expect(line).toMatch(/^\s+uses: [\w-]+\/[\w-]+@[0-9a-f]{40} # v\d+$/);
    expect(TEXT).toContain('persist-credentials: false');
  });

  it('reads the host from the same variable as the frontend deploy, and hands the exit and the report on', () => {
    expect(readStep.env.ORIGIN_HOST).toBe('${{ vars.STATIC_WEB_APP_DEFAULT_HOSTNAME }}');
    expect(readStep.run).toContain('node scripts/check-swa-certificates.mjs "${args[@]}" --summary "${RUNNER_TEMP}/swa-certs.md" || code=$?');
    expect(readStep.run).toContain('echo "report=$(base64 -w0 "${RUNNER_TEMP}/swa-certs.md")" >> "$GITHUB_OUTPUT"');
    expect(CHECK.lines).toContain('      exit: ${{ steps.certs.outputs.exit }}');
    expect(CHECK.lines).toContain('      report: ${{ steps.certs.outputs.report }}');
    expect(decodeStep.env.REPORT_B64).toBe('${{ needs.check.outputs.report }}');
  });

  it('runs the issue step on every exit, so a clean run can close the issue', () => {
    expect(step.if).toBeUndefined();
    expect(step.env.CERTS_EXIT).toBe('${{ needs.check.outputs.exit }}');
  });

  it('the fail step names every failure condition', () => {
    const fail = CHECK.steps.find((s) => s.name === FAIL_STEP);
    for (const words of ['30 days or less', 'does not cover its name', 'untrusted chain', 'not valid yet', 'could not be read']) {
      expect(fail.run, words).toContain(words);
    }
  });

  it('takes every value through env:, never an expression in the shell', () => {
    for (const s of [...CHECK.steps, ...ISSUE.steps].filter((x) => x.run)) {
      expect(s.run.includes('${{'), `${s.name}: an expression inside run: is the template-injection shape`).toBe(false);
    }
  });

  it('keys the issue on one fixed title, the Platform label and the Actions bot as author, never on search', () => {
    expect(step.run).toContain(`title="${TITLE}"`);
    expect(step.run).toContain('label="Platform"');
    expect(step.run).toContain('--json number,title,author');
    expect(step.run).toContain('select(.title == $title and .author.login == "app/github-actions" and .author.is_bot == true)');
    // One lookup feeds both the close and the comment, so the author rule covers both.
    expect(step.run.split('gh issue list').length - 1).toBe(1);
    expect(step.run.includes('--search')).toBe(false);
  });
});

const TOOLS = findBashTools();
const JQ_READY = spawnSync('jq', ['--version'], { encoding: 'utf8' }).status === 0;
const READY = TOOLS.ready && JQ_READY;
const SKIPPED = READY ? '' : ` (SKIPPED here: ${TOOLS.ready ? 'jq is not on the path' : TOOLS.why}; they run on GitHub Actions)`;
const BASH_SKIPPED = TOOLS.ready ? '' : ` (SKIPPED here: ${TOOLS.why}; they run on GitHub Actions)`;
const forward = (path) => path.replace(/\\/g, '/');

describe.skipIf(!TOOLS.ready)(`check-swa-certificates.yml report hand-off: run with bash -e${BASH_SKIPPED}`, () => {
  function decode(b64) {
    const dir = forward(mkdtempSync(join(tmpdir(), 'swa-cert-check-decode-')));
    try {
      const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', decodeStep.run], {
        env: { ...process.env, RUNNER_TEMP: dir, REPORT_B64: b64, CHECK_RESULT: 'failure' },
        encoding: 'utf8',
      });
      return { status: result.status, text: readFileSync(`${dir}/swa-certs.md`, 'utf8') };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('writes the report the check job encoded, byte for byte', () => {
    const report = '## Static Web App certificates\n\n| a | b |\n\n<!-- swa-cert-check state: x=ok/none -->\n';
    expect(decode(Buffer.from(report).toString('base64'))).toEqual({ status: 0, text: report });
  });

  it('an empty or broken report becomes a short one saying so, and the step still succeeds', () => {
    for (const b64 of ['', '!!!not base64!!!']) {
      const got = decode(b64);
      expect(got.status, b64).toBe(0);
      expect(got.text).toBe('## Static Web App certificates\n\nThe check job (failure) passed on no report; see its log.\n');
    }
  });
});

describe('check-swa-certificates.yml: bash and jq are there', () => {
  it.skipIf(process.env.GITHUB_ACTIONS !== 'true')('on GitHub Actions bash and jq are present, so the tests below run', () => {
    expect(TOOLS.ready, TOOLS.why).toBe(true);
    expect(JQ_READY).toBe(true);
  });
});

describe.skipIf(!READY)(`check-swa-certificates.yml certificate issue: run with bash -e${SKIPPED}`, () => {
  const RUN_URL = 'https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/runs/1';
  // How `gh issue list --json author` gives the Actions bot (read 2026-11-27 on #1749), and a person.
  const BOT_AUTHOR = { is_bot: true, login: 'app/github-actions' };
  const HUMAN = { is_bot: false, login: 'someone' };
  const OPEN = JSON.stringify([{ number: 12, title: TITLE, author: BOT_AUTHOR }]);
  const STATE_WARN = '<!-- swa-cert-check state: hybridcloudworks.com=warn/expiring:2027-02-23 www.hybridcloudworks.com=ok/none:2027-05-01 -->';
  const STATE_ACT = '<!-- swa-cert-check state: hybridcloudworks.com=act/expiring:2027-02-23 www.hybridcloudworks.com=ok/none:2027-05-01 -->';
  const STATE_MISMATCH = '<!-- swa-cert-check state: hybridcloudworks.com=act/name-mismatch www.hybridcloudworks.com=ok/none:2027-05-01 -->';
  const STATE_UNTRUSTED = '<!-- swa-cert-check state: hybridcloudworks.com=act/untrusted www.hybridcloudworks.com=ok/none:2027-05-01 -->';
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

  function runIssue(exit, { list = '[]', listFails = false, apiFails = false, summary = report(STATE_WARN), issue = bot('old'), comments = [] } = {}) {
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
    expect(got.calls[0]).toBe('issue|list|--repo|saulpatinojr/HCW-HybridCloudWorks|--state|open|--label|Platform|--limit|200|--json|number,title,author');
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

  it('good with none open writes nothing', () => {
    const got = runIssue(0);
    expect(got.writes).toEqual([]);
    expect(got.stdout).toContain('no certificate issue is open');
  });

  it('a new reason at the same stage, with no end date to differ, is posted', () => {
    const got = runIssue(1, { list: OPEN, summary: report(STATE_UNTRUSTED), comments: [bot(report(STATE_MISMATCH))] });
    expect(got.writes).toEqual([`issue|comment|12|--repo|saulpatinojr/HCW-HybridCloudWorks|--body-file|${got.dir}/issue.md`]);
  });

  it('never touches an issue with a similar title', () => {
    const similar = JSON.stringify([{ number: 7, title: `${TITLE} (old)`, author: BOT_AUTHOR }]);
    expect(runIssue(0, { list: similar }).writes).toEqual([]);
    expect(runIssue(1, { list: similar }).writes[0]).toMatch(/^issue\|create\|/);
  });

  it('an open issue with the same title and label but a person as author is ignored: never closed or commented on, and the job opens its own', () => {
    const human = JSON.stringify([{ number: 9, title: TITLE, author: HUMAN }]);
    expect(runIssue(0, { list: human }).writes).toEqual([]);
    const got = runIssue(1, { list: human });
    expect(got.status, got.stderr).toBe(0);
    expect(got.writes).toEqual([
      `issue|create|--repo|saulpatinojr/HCW-HybridCloudWorks|--title|${TITLE}|--label|Platform|--label|owner-gated|--body-file|${got.dir}/issue.md`,
    ]);
  });

  it('a bot login that is not the Actions bot, or the right login not marked as a bot, does not count either', () => {
    for (const author of [{ is_bot: true, login: 'app/other-app' }, { is_bot: false, login: 'app/github-actions' }]) {
      const list = JSON.stringify([{ number: 9, title: TITLE, author }]);
      expect(runIssue(0, { list }).writes, author.login).toEqual([]);
      expect(runIssue(2, { list }).writes[0], author.login).toMatch(/^issue\|create\|/);
    }
  });

  it('with a person\'s look-alike and the workflow\'s own issue both open, only the workflow\'s is used', () => {
    const both = JSON.stringify([
      { number: 9, title: TITLE, author: HUMAN },
      { number: 12, title: TITLE, author: BOT_AUTHOR },
    ]);
    const got = runIssue(0, { list: both });
    expect(got.writes).toEqual([
      `issue|close|12|--repo|saulpatinojr/HCW-HybridCloudWorks|--reason|completed|--comment|Both certificates are good for more than 30 days again: run ${RUN_URL}.`,
    ]);
  });

  it('fails the step, writing nothing, when the issue list cannot be read', () => {
    const got = runIssue(1, { list: OPEN, listFails: true });
    expect(got.status).not.toBe(0);
    expect(got.writes).toEqual([]);
  });
});
