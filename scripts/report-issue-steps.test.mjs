/**
 * The report issues of check-drill-age.yml and cloudflare-dns-audit.yml are
 * found by label, never by search (#1682).
 *
 * Search is fuzzy and its index can lag, so `gh issue list --search` could
 * pick another issue with similar words and comment on it. Both steps now
 * list open issues by label and keep only their own title, the way
 * lab-supply-chain.yml (#1673) and monitor-deploy-drift.yml (#1661) do.
 *
 * Each step runs for real under `bash -e` (as GitHub runs a step with no
 * `shell:`), against a stand-in `gh` that records every call and answers
 * `issue list` with what the test set, applying any `--jq` with the real jq.
 * Skipped where bash or jq is missing.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ISSUE_TITLE_PREFIX } from './cloudflare-dns-audit.mjs';
import { parseJobs } from './lib/workflow-text.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = join(REPO, '.github', 'workflows');
const stepOf = (file, jobKey, name) =>
  parseJobs(readFileSync(join(WORKFLOWS, file), 'utf8').replace(/\r\n/g, '\n'))
    .find((job) => job.key === jobKey)
    ?.steps.find((step) => step.name === name);

const DRILL = stepOf('check-drill-age.yml', 'check', 'Open, update or close the drill issue');
const DNS = stepOf('cloudflare-dns-audit.yml', 'audit', 'Open or update the issue on an unexpected change');
const DRILL_TITLE = 'Cosmos restore drill overdue: no drill recorded in the last 100 days';
const RUN_URL = 'https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/runs/1';

const ready = (cmd) => spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0;
const runnable = ready('bash') && ready('jq');

describe('the two steps exist and use no search', () => {
  it('finds both steps', () => {
    expect(DRILL?.run).toBeDefined();
    expect(DNS?.run).toBeDefined();
  });

  it('lists by label instead of searching', () => {
    for (const step of [DRILL, DNS]) {
      expect(step.run).not.toContain('--search');
      expect(step.run).toMatch(/gh issue list --repo "\$REPO" --state open --label /);
    }
  });

  it('runs the drill step on every recorded exit, so a current drill can close the issue', () => {
    expect(DRILL.if).toBe("steps.drill.outputs.exit != ''");
  });

  it('keys the DNS issue on the prefix the audit script exports', () => {
    expect(DNS.run).toContain(`prefix="${ISSUE_TITLE_PREFIX}"`);
  });

  it('never closes the DNS issue: a person reads an unexpected change and closes it', () => {
    expect(DNS.run).not.toMatch(/gh issue close/);
  });
});

describe.skipIf(!runnable)('the two steps, run with bash -e against a stand-in gh (#1682)', () => {
  let dir;
  let runs = 0;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'report-issue-'));
    mkdirSync(join(dir, 'bin'));
    writeFileSync(
      join(dir, 'bin', 'gh'),
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
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Runs one step's shell; returns its status, output and the gh calls that write. */
  function run(step, { list = '[]', env = {}, listFails = false } = {}) {
    const temp = join(dir, `run-${++runs}`);
    mkdirSync(temp);
    writeFileSync(join(temp, 'drill.md'), '## Cosmos restore drill age\n\nNewest drill: none.\n');
    writeFileSync(join(temp, 'dns-audit.md'), '## Cloudflare DNS audit\n\n| record | actor |\n| --- | --- |\n| a | b |\n');
    writeFileSync(join(temp, 'gh.log'), '');
    const r = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', step.run], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
        RUNNER_TEMP: temp,
        GH_LOG: join(temp, 'gh.log'),
        FAKE_LIST: list,
        FAKE_LIST_FAILS: listFails ? '1' : '',
        REPO: 'saulpatinojr/HCW-HybridCloudWorks',
        RUN_URL,
        GITHUB_REF: 'refs/heads/main',
        ...env,
      },
    });
    const calls = readFileSync(join(temp, 'gh.log'), 'utf8').split('\n').filter(Boolean);
    return { ...r, calls, writes: calls.filter((c) => /^issue\|(create|comment|close)\|/.test(c)) };
  }

  describe('check-drill-age.yml', () => {
    const OPEN = JSON.stringify([{ number: 9, title: DRILL_TITLE }]);
    const drill = (exit, opts = {}) => run(DRILL, { ...opts, env: { DRILL_EXIT: String(exit), ...opts.env } });

    it('lists only open issues labelled Platform', () => {
      const got = drill(1);
      expect(got.status, got.stderr).toBe(0);
      expect(got.calls[0]).toMatch(/^issue\|list\|--repo\|saulpatinojr\/HCW-HybridCloudWorks\|--state\|open\|--label\|Platform\|/);
    });

    it('overdue with none open: opens the issue with the Platform label', () => {
      const got = drill(1);
      expect(got.writes).toHaveLength(1);
      expect(got.writes[0]).toMatch(new RegExp(`^issue\\|create\\|--repo\\|[^|]+\\|--title\\|${DRILL_TITLE}\\|--label\\|Platform\\|--body-file\\|`));
    });

    it('overdue with it open: comments on it, every week', () => {
      const got = drill(1, { list: OPEN });
      expect(got.writes).toHaveLength(1);
      expect(got.writes[0]).toMatch(/^issue\|comment\|9\|/);
    });

    it('an open issue with a similar title is left alone, and a new one opened', () => {
      const got = drill(1, { list: JSON.stringify([{ number: 4, title: `Re: ${DRILL_TITLE}` }]) });
      expect(got.writes).toHaveLength(1);
      expect(got.writes[0]).toMatch(/^issue\|create\|/);
    });

    it('an unreadable table (exit 2) is reported, never taken as current', () => {
      const got = drill(2, { list: OPEN });
      expect(got.status, got.stderr).toBe(0);
      expect(got.writes).toHaveLength(1);
      expect(got.writes[0]).toMatch(/^issue\|comment\|9\|/);
    });

    it('a current drill closes the open issue on a run of main, with a comment naming the run', () => {
      const got = drill(0, { list: OPEN });
      expect(got.status, got.stderr).toBe(0);
      expect(got.writes).toHaveLength(1);
      expect(got.writes[0]).toMatch(/^issue\|close\|9\|--repo\|[^|]+\|--reason\|completed\|--comment\|Current again: run https:\/\/github\.com\/saulpatinojr\/HCW-HybridCloudWorks\/actions\/runs\/1 /);
    });

    it('a current drill on another branch leaves the issue open', () => {
      const got = drill(0, { list: OPEN, env: { GITHUB_REF: 'refs/heads/feature' } });
      expect(got.status, got.stderr).toBe(0);
      expect(got.writes).toEqual([]);
      expect(got.stdout).toContain('not main, so #9 is left open');
    });

    it('a current drill with none open does nothing', () => {
      const got = drill(0);
      expect(got.status, got.stderr).toBe(0);
      expect(got.writes).toEqual([]);
    });

    it('fails the step, closing nothing, when the issue list cannot be read', () => {
      const got = drill(0, { list: OPEN, listFails: true });
      expect(got.status).not.toBe(0);
      expect(got.writes).toEqual([]);
    });
  });

  describe('cloudflare-dns-audit.yml', () => {
    const OPEN = JSON.stringify([{ number: 21, title: `${ISSUE_TITLE_PREFIX} (2026-11-09)` }]);

    it('lists only open issues labelled Security', () => {
      const got = run(DNS);
      expect(got.status, got.stderr).toBe(0);
      expect(got.calls[0]).toMatch(/^issue\|list\|--repo\|saulpatinojr\/HCW-HybridCloudWorks\|--state\|open\|--label\|Security\|/);
    });

    it('with none open: opens a dated issue labelled Security and live-check', () => {
      const got = run(DNS);
      expect(got.writes).toHaveLength(1);
      expect(got.writes[0]).toMatch(new RegExp(`^issue\\|create\\|--repo\\|[^|]+\\|--title\\|${ISSUE_TITLE_PREFIX} \\(\\d{4}-\\d{2}-\\d{2}\\)\\|--label\\|Security\\|--label\\|live-check\\|`));
    });

    it('with one open from an earlier day: comments on it', () => {
      const got = run(DNS, { list: OPEN });
      expect(got.status, got.stderr).toBe(0);
      expect(got.writes).toHaveLength(1);
      expect(got.writes[0]).toMatch(/^issue\|comment\|21\|/);
    });

    it('an open Security issue whose title only mentions the prefix is left alone, and a new one opened', () => {
      const got = run(DNS, { list: JSON.stringify([{ number: 5, title: `Follow-up to ${ISSUE_TITLE_PREFIX} (2026-10-27)` }]) });
      expect(got.writes).toHaveLength(1);
      expect(got.writes[0]).toMatch(/^issue\|create\|/);
    });
  });
});
