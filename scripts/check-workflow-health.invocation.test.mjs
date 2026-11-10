/**
 * How `monitor-deploy-drift.yml` invokes check-workflow-health.mjs is part of
 * the tool, not packaging around it.
 *
 * THE DEFECT THIS EXISTS FOR. Every exit-2 path in the script writes with
 * `console.error` and nothing to stdout — the usage banner, the
 * paginated-listing refusal, the run-filter refusal. The job captured the
 * report with `report=$(node ...)`, which takes stdout alone. Measured
 * 2026-09-08: exit 2, **0 bytes captured**. So the job went red with a blank
 * step summary, in precisely the case an operator most needs to read why —
 * "the instrument could not look" rendered as "the instrument said nothing".
 * That is the same shape as verify-alert-state.yml's first run, which wrote
 * only the summary and could not be diagnosed without a browser. Caught in
 * review on the PR that split this script out of #426.
 *
 * The fix is `2>&1` on the invocation. It is four characters, it looks like
 * noise, and removing it restores a silent failure — which is why it is pinned
 * here rather than left to a comment. Same reasoning as
 * manifest-workflow.test.mjs, which pins `git add <one path>` against the
 * one-character slide to `git add -A`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'check-workflow-health.mjs');
const WORKFLOW = join(here, '..', '.github', 'workflows', 'monitor-deploy-drift.yml');

/** Non-comment lines only, so prose about `2>&1` cannot satisfy the assertion. */
function commandLines(source) {
  return String(source)
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line));
}

function runWithoutCredentials() {
  const env = { ...process.env };
  delete env.GITHUB_TOKEN;
  delete env.GITHUB_REPOSITORY;
  try {
    const stdout = execFileSync(process.execPath, [script], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('where the refusal is written', () => {
  it('goes to stderr, and not to stdout', () => {
    // Both halves matter. stderr is the right stream for a diagnostic, and the
    // absence from stdout is the fact that makes the workflow's redirect
    // necessary rather than decorative. If a later change moves the report to
    // stdout for the exit-2 case, this test should be revisited deliberately —
    // the redirect would then be redundant, not wrong.
    const got = runWithoutCredentials();
    expect(got.code).toBe(2);
    expect(got.stderr).toContain('GITHUB_TOKEN and GITHUB_REPOSITORY are both required.');
    expect(got.stdout).not.toContain('GITHUB_TOKEN and GITHUB_REPOSITORY are both required.');
  });
});

/**
 * An error nobody foresaw exits 2, not 1 (#1661). Exit 1 now opens the
 * workflow-health issue, so a throw that exits 1 would file a stack trace as
 * a finding. The script is spawned for real, with a stand-in `fetch` loaded
 * before it (`--import`) that answers every read with a well-formed payload,
 * except one run with no `created_at`. Reading that run's date throws a
 * TypeError outside every refusal, which until #1661 ended the process with 1.
 */
describe('an error the script did not expect', () => {
  it('exits 2 and says nothing was asserted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'health-throw-'));
    try {
      const stand = join(dir, 'fake-fetch.mjs');
      writeFileSync(
        stand,
        [
          'const W = { id: 1, path: ".github/workflows/x.yml", state: "active" };',
          'globalThis.fetch = async (url) => {',
          '  const u = String(url);',
          '  let body;',
          '  if (u.includes("/actions/workflows?")) body = { total_count: 1, workflows: [W] };',
          '  else if (u.includes("/contents/")) body = [{ path: W.path }];',
          '  else if (u.includes("event=schedule")) body = { workflow_runs: [] };',
          '  else if (u.includes("/runs?")) body = { workflow_runs: [{ workflow_id: 1, conclusion: "success" }] };',
          '  else body = { default_branch: "main" };',
          '  return { ok: true, status: 200, json: async () => body };',
          '};',
          '',
        ].join('\n')
      );
      const env = { ...process.env, GITHUB_TOKEN: 'not-a-real-token', GITHUB_REPOSITORY: 'o/r' };
      delete env.GITHUB_WORKFLOW_REF;
      const got = spawnSync(process.execPath, ['--import', pathToFileURL(stand).href, script], {
        env,
        encoding: 'utf8',
      });
      expect(got.status, got.stderr).toBe(2);
      expect(got.stderr).toContain('The check stopped on an error it did not expect');
      expect(got.stderr).toContain('Nothing was asserted either way.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * A report longer than a pipe buffer arrives whole (Copilot review of #1668).
 * On Linux a write to a pipe is asynchronous, so `process.exit()` straight
 * after `console.log()` dropped the tail of a long report, findings marker
 * included, and the issue step then read "no findings line" and did nothing
 * (https://nodejs.org/api/process.html#a-note-on-process-io). A hundred
 * failing workflows with long run links make the report several pipe buffers
 * long; the last line must still be the marker.
 */
describe('a long report', () => {
  it('reaches the pipe whole, ending with the findings marker, and exits 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'health-long-'));
    try {
      const stand = join(dir, 'fake-fetch.mjs');
      writeFileSync(
        stand,
        [
          'const N = 100;',
          'const pad = "x".repeat(1500);',
          'const W = Array.from({ length: N }, (_, i) => ({ id: i + 1, path: `.github/workflows/w${i}.yml`, state: "active" }));',
          'const fail = (id, day) => ({ workflow_id: id, event: "schedule", head_branch: "main", conclusion: "failure",',
          '  created_at: `2026-11-${day}T06:00:00Z`, html_url: `https://github.com/o/r/actions/runs/${id}${day}?${pad}` });',
          'const yaml = Buffer.from("on:\\n  schedule:\\n    - cron: \\"0 6 * * 1\\"\\n").toString("base64");',
          'globalThis.fetch = async (url) => {',
          '  const u = String(url);',
          '  const id = Number((u.match(/workflows\\/(\\d+)\\/runs/) ?? [])[1]);',
          '  let body;',
          '  if (u.includes("/actions/workflows?")) body = { total_count: N, workflows: W };',
          '  else if (u.includes("/contents/.github/workflows?")) body = W.map((w) => ({ path: w.path }));',
          '  else if (u.includes("/contents/")) body = { content: yaml };',
          '  else if (u.includes("status=success")) body = { workflow_runs: [] };',
          '  else if (u.includes("/runs?")) body = { workflow_runs: [fail(id, "09"), fail(id, "08")] };',
          '  else body = { default_branch: "main" };',
          '  return { ok: true, status: 200, json: async () => body };',
          '};',
          '',
        ].join('\n')
      );
      const env = { ...process.env, GITHUB_TOKEN: 'not-a-real-token', GITHUB_REPOSITORY: 'o/r' };
      delete env.GITHUB_WORKFLOW_REF;
      const got = spawnSync(process.execPath, ['--import', pathToFileURL(stand).href, script], {
        env,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      expect(got.status, got.stderr).toBe(1);
      expect(got.stdout.length, `stderr: ${got.stderr.slice(0, 500)} error: ${got.error}`).toBeGreaterThan(2 * 65536);
      expect(got.stdout.trimEnd().split('\n').at(-1)).toMatch(/^<!-- workflow-health findings: .*:failing -->$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the job captures what the script actually writes', () => {
  const lines = commandLines(readFileSync(WORKFLOW, 'utf8'));
  const index = lines.findIndex((line) => line.includes('check-workflow-health.mjs'));

  it('invokes the script at all', () => {
    expect(index, 'no command line in monitor-deploy-drift.yml runs the script').toBeGreaterThan(
      -1
    );
  });

  it('redirects stderr into the captured report', () => {
    expect(lines[index]).toContain('2>&1');
  });

  it('reads the exit code from the assignment, not from a pipeline', () => {
    // `node ... | tee` would hand back tee's status, which is always 0 — a
    // monitor that can never fail. And through `||` on the same line, not a
    // `status=$?` on the next: GitHub runs the step as `bash -e {0}`, and
    // under `-e` a failing `report=$(...)` ends the step before the next line,
    // so every red run printed a blank report. A command on the left of `||`
    // is exempt from `-e`. monitor-deploy-drift-steps.test.mjs runs the step
    // with `bash -e` to prove it.
    expect(lines[index].trim()).toMatch(/\) \|\| status=\$\?$/);
    expect(lines[index - 1].trim()).toBe('status=0');
    expect(lines[index]).not.toContain('| tee');
  });
});
