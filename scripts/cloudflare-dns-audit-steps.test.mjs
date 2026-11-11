/**
 * The unexpected-change issue step of cloudflare-dns-audit.yml, run for real
 * (#1681).
 *
 * Until #1681 the step found its issue with `gh issue list --search
 * "\"<prefix>\" in:title"` and took the first result. Search is fuzzy and its
 * index can lag behind a just-created issue, so another open issue with
 * similar words could be picked and commented on, and every run with an
 * unexpected change commented, even when the two-hour overlap between daily
 * windows had read the same edit the day before. It now finds the issue by
 * the `Security` label and a title that is exactly the script's prefix and
 * ` (YYYY-MM-DD)`, and comments only when the report's hidden findings line
 * differs from the issue's last one.
 *
 * It never closes the issue. The audit reads events in a window, so a quiet
 * day says nothing about the edit already reported; a person closes it once
 * the edit is explained (docs/runbooks/edge-dns-verification.md). The tests
 * below hold that line too.
 *
 * The step's shell is taken out of the workflow and run with `bash -e`, as a
 * runner does, against a stand-in `gh` that records each call and answers
 * `issue list` and `issue view` with what the test set, applying any `--jq`
 * with the real jq (gh uses gojq, which reads these expressions the same
 * way). The report it reads is the real script's `renderReport`, so the
 * findings line the workflow looks for is the one the script writes.
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
import { FINDINGS_MARKER, ISSUE_TITLE_PREFIX, renderReport } from './cloudflare-dns-audit.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = join(REPO, '.github', 'workflows', 'cloudflare-dns-audit.yml');
const TEXT = readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');
const JOB = parseJobs(TEXT).find((job) => job.key === 'audit');
const ISSUE_STEP = 'Open or update the issue on an unexpected change';
const step = JOB?.steps.find((s) => s.name === ISSUE_STEP);

describe('cloudflare-dns-audit.yml unexpected-change issue (#1681): its shape', () => {
  it('has the step, between the audit and the read-failure step', () => {
    expect(step?.run, `no step named "${ISSUE_STEP}"`).toBeDefined();
    const names = JOB.steps.map((s) => s.name);
    expect(names.slice(-3)).toEqual(['Read the audit log and judge the DNS-record changes', ISSUE_STEP, 'Fail the run when the audit log could not be read']);
  });

  it('still runs only on an unexpected change, and a manual run can switch it off', () => {
    expect(step.if).toBe("steps.audit.outputs.exit == '2' && (github.event_name != 'workflow_dispatch' || inputs.open_issue)");
  });

  it('takes every value through env:, never an expression in the shell', () => {
    expect(step.run.includes('${{'), 'an expression inside run: is the template-injection shape').toBe(false);
    expect(step.shell).toBeUndefined();
  });

  it('uses the prefix the script exports, the Security label, and never search', () => {
    expect(step.run).toContain(`prefix="${ISSUE_TITLE_PREFIX}"`);
    expect(step.run).toContain('label="Security"');
    expect(step.run).not.toContain('--search');
  });

  it('looks for the findings line the script writes', () => {
    expect(step.run).toContain(`'/^${FINDINGS_MARKER}/{p;q;}'`);
    expect(step.run).toContain(`contains("${FINDINGS_MARKER}")`);
  });

  it('never closes the issue: a quiet day says nothing about the edit already reported', () => {
    expect(TEXT).not.toContain('gh issue close');
  });

  it('does not widen the job: issues: write is the one write it holds', () => {
    const grants = JOB.lines.filter((l) => /^\s+\w+:\s*write\b/.test(l)).map((l) => l.trim());
    expect(grants).toEqual(['issues: write # open or comment on the one unexpected-change issue']);
  });
});

const TOOLS = findBashTools();
const JQ_READY = spawnSync('jq', ['--version'], { encoding: 'utf8' }).status === 0;
const READY = TOOLS.ready && JQ_READY;
const SKIPPED = READY ? '' : ` (SKIPPED here: ${TOOLS.ready ? 'jq is not on the path' : TOOLS.why}; they run on GitHub Actions)`;
const forward = (path) => path.replace(/\\/g, '/');

describe('cloudflare-dns-audit.yml unexpected-change issue: bash and jq are there', () => {
  it.skipIf(process.env.GITHUB_ACTIONS !== 'true')('on GitHub Actions bash and jq are present, so the tests below run', () => {
    expect(TOOLS.ready, TOOLS.why).toBe(true);
    expect(JQ_READY).toBe(true);
  });
});

describe.skipIf(!READY)(`cloudflare-dns-audit.yml unexpected-change issue (#1681): run with bash -e${SKIPPED}`, () => {
  const RUN_URL = 'https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/runs/1';
  const TITLE = `${ISSUE_TITLE_PREFIX} (2026-11-10)`;
  const OPEN = JSON.stringify([{ number: 12, title: TITLE }]);
  let work;
  let bin;
  let runs = 0;

  /** One judged change, in the shape `renderReport` takes. */
  const change = (id, name = 'x.hybridcloudworks.com') => ({
    id,
    time: '2026-11-10T04:00:00Z',
    actionType: 'create',
    result: 'success',
    actorType: 'user',
    actorContext: 'api_token',
    actorEmail: '',
    actorId: '',
    actorIp: '192.0.2.99',
    tokenName: 'totally-legit',
    tokenId: '',
    actorFields: 'context,ip_address,token_name,type',
    userAgent: 'curl/8',
    method: 'POST',
    recordType: 'TXT',
    recordName: name,
    nameSource: 'entry',
    verdict: 'UNEXPECTED',
    rule: null,
  });
  /** The script's own report for these entries, over a window that differs per call as a real day's would. */
  const reportOf = (ids, since = '2026-11-09T03:50:00Z') =>
    renderReport({ window: { since, before: '2026-11-10T05:50:00Z', hours: 26 }, entries: ids.length, pages: 1, judged: ids.map((id) => change(id)), settings: {} });
  const keyOf = (text) => text.split('\n').find((l) => l.startsWith(FINDINGS_MARKER));

  beforeAll(() => {
    work = forward(mkdtempSync(join(tmpdir(), 'dns-issue-')));
    bin = `${work}/bin`;
    mkdirSync(bin);
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
        '  "issue view") answer="$FAKE_VIEW" ;;',
        '  "issue create") echo "https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/99"; exit 0 ;;',
        '  *) exit 0 ;;',
        'esac',
        'if [ -n "$expr" ]; then jq -r "$expr" <<< "$answer"; else printf "%s\\n" "$answer"; fi',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  /** An `issue view --json body,comments` answer: the body, then the comments, oldest first. */
  const view = (body, ...comments) => JSON.stringify({ body, comments: comments.map((c) => ({ body: c })) });

  function runIssue({ report = reportOf(['aaa']), list = '[]', viewed = view(''), listFails = false } = {}) {
    const dir = `${work}/run-${++runs}`;
    mkdirSync(dir);
    writeFileSync(`${dir}/dns-audit.md`, report);
    writeFileSync(`${dir}/gh.log`, '');
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', step.run], {
      cwd: REPO,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: dir,
        GH_LOG: `${dir}/gh.log`,
        FAKE_LIST: list,
        FAKE_VIEW: viewed,
        FAKE_LIST_FAILS: listFails ? '1' : '',
        GH_TOKEN: 'not-a-real-token',
        REPO: 'saulpatinojr/HCW-HybridCloudWorks',
        RUN_URL,
        // A run of main, as every scheduled run is: the step must not close
        // the issue even here.
        GITHUB_REF: 'refs/heads/main',
      },
      encoding: 'utf8',
    });
    const calls = readFileSync(`${dir}/gh.log`, 'utf8').split('\n').filter(Boolean);
    const writes = calls.filter((c) => !/^issue\|(list|view)\|/.test(c));
    const body = existsSync(`${dir}/issue.md`) ? readFileSync(`${dir}/issue.md`, 'utf8') : '';
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls, writes, body, dir };
  }

  it('looks the issue up by the Security label in the issue list, not through search', () => {
    const got = runIssue();
    expect(got.status, got.stderr).toBe(0);
    expect(got.calls[0]).toBe('issue|list|--repo|saulpatinojr/HCW-HybridCloudWorks|--state|open|--label|Security|--limit|200|--json|number,title');
    expect(got.calls.join('\n')).not.toContain('--search');
  });

  it('none open: creates it, dated, with both labels and the report ending in its findings line', () => {
    const got = runIssue();
    expect(got.status, got.stderr).toBe(0);
    expect(got.writes).toHaveLength(1);
    expect(got.writes[0]).toMatch(
      new RegExp(`^issue\\|create\\|--repo\\|saulpatinojr/HCW-HybridCloudWorks\\|--title\\|${ISSUE_TITLE_PREFIX} \\(\\d{4}-\\d{2}-\\d{2}\\)\\|--label\\|Security\\|--label\\|live-check\\|--body-file\\|`)
    );
    expect(got.body).toContain(RUN_URL);
    expect(keyOf(got.body)).toBe(keyOf(reportOf(['aaa'])));
    expect(got.stdout).toContain('::warning::Unexpected DNS-record change; opened https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/99.');
  });

  it('new entries the open issue does not carry yet: comments on it', () => {
    const got = runIssue({ report: reportOf(['bbb']), list: OPEN, viewed: view(`first\n${keyOf(reportOf(['aaa']))}`) });
    expect(got.status, got.stderr).toBe(0);
    expect(got.writes).toEqual([`issue|comment|12|--repo|saulpatinojr/HCW-HybridCloudWorks|--body-file|${got.dir}/issue.md`]);
  });

  it('the same entries read again by the next day\'s overlapping window: no new comment', () => {
    const key = keyOf(reportOf(['aaa']));
    const got = runIssue({ report: reportOf(['aaa'], '2026-11-10T03:50:00Z'), list: OPEN, viewed: view(`first\n${key}`) });
    expect(got.status, got.stderr).toBe(0);
    expect(got.writes).toEqual([]);
    expect(got.stdout).toContain('#12 already reports these entries');
  });

  it('compares with the newest report, and a person\'s comment after it does not count', () => {
    const a = keyOf(reportOf(['aaa']));
    const b = keyOf(reportOf(['bbb']));
    expect(runIssue({ list: OPEN, viewed: view(`first\n${a}`, 'Looking at it now.') }).writes).toEqual([]);
    expect(runIssue({ list: OPEN, viewed: view(`first\n${a}`, `later\n${b}`) }).writes[0]).toMatch(/^issue\|comment\|12\|/);
  });

  it('an issue opened by hand with no body (null) is read as no report yet', () => {
    const got = runIssue({ list: OPEN, viewed: view(null) });
    expect(got.status, got.stderr).toBe(0);
    expect(got.writes[0]).toMatch(/^issue\|comment\|12\|/);
  });

  it('a report without the findings line always comments, rather than matching anything', () => {
    const plain = reportOf(['aaa']).split('\n').filter((l) => !l.startsWith(FINDINGS_MARKER)).join('\n');
    const got = runIssue({ report: plain, list: OPEN, viewed: view(`first\n${keyOf(reportOf(['aaa']))}`) });
    expect(got.status, got.stderr).toBe(0);
    expect(got.writes[0]).toMatch(/^issue\|comment\|12\|/);
  });

  it.each([
    ['a title with words after the date', `${TITLE} follow-up`],
    ['a title with words before the prefix', `Re: ${TITLE}`],
    ['the prefix with no date', ISSUE_TITLE_PREFIX],
    ['the prefix with something other than a date', `${ISSUE_TITLE_PREFIX} (draft)`],
  ])('an open issue with %s is left alone, and a new one created', (_why, title) => {
    const got = runIssue({ list: JSON.stringify([{ number: 7, title }]) });
    expect(got.status, got.stderr).toBe(0);
    expect(got.writes).toHaveLength(1);
    expect(got.writes[0]).toMatch(/^issue\|create\|/);
  });

  it('two report issues open: comments on the newest, which the list gives first', () => {
    const got = runIssue({
      list: JSON.stringify([
        { number: 14, title: `${ISSUE_TITLE_PREFIX} (2026-11-10)` },
        { number: 9, title: `${ISSUE_TITLE_PREFIX} (2026-10-27)` },
      ]),
    });
    expect(got.writes[0]).toMatch(/^issue\|comment\|14\|/);
  });

  it('fails the step, writing nothing, when the issue list cannot be read', () => {
    const got = runIssue({ list: OPEN, listFails: true });
    expect(got.status).not.toBe(0);
    expect(got.writes).toEqual([]);
  });

  it('never closes the issue, whatever it is asked to report', () => {
    for (const opts of [{}, { list: OPEN }, { list: OPEN, viewed: view(`x\n${keyOf(reportOf(['aaa']))}`) }]) {
      expect(runIssue(opts).writes.some((w) => w.startsWith('issue|close|'))).toBe(false);
    }
  });
});
