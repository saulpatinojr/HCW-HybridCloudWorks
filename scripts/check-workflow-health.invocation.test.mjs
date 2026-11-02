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
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
