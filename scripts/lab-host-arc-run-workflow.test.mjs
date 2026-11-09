/**
 * The shape of lab-host-arc-run.yml (#1590; ADR 0032, amendment of
 * 2026-11-09).
 *
 * The job can run a script as root on the lab host through Azure Arc Run
 * Command, so the lines that keep that to three fixed scripts, approved by a
 * person, are held here:
 *
 * - The manual trigger's one input is a choice of three fixed actions, each
 *   action maps to one file under lab-host/arc-run/, and no `${{ }}`
 *   expression is written into a shell line (script injection).
 * - The job names the `production` environment (its required reviewers
 *   approve each run) and signs in as github_arc_run (ARC_RUN_CLIENT_ID),
 *   which trusts only that environment's subject (oidc-subjects.test.mjs
 *   holds the credential side).
 * - `id-token: write` is on the job, not the workflow; every action is pinned
 *   by commit; the job and each step have a time limit; two runs never
 *   overlap and a queued one never cancels a run in flight.
 * - The run command is deleted in an always() step once signed in.
 * - The Arc machine it names is the one the arc role onboards.
 *
 * The last block runs the main step's shell under `bash -e`, as a runner
 * does, against a stand-in `az`, so the exit code, the summary and the
 * stop-commands guard are checked as they behave, not as they read.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { findBashTools, parseJobs } from './lib/workflow-text.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = join(REPO, '.github', 'workflows', 'lab-host-arc-run.yml');

const source = readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');
const commandLines = source.split('\n').filter((line) => !/^\s*#/.test(line));
const jobs = parseJobs(source);
const job = jobs[0];
const ACTIONS = { status: 'status.sh', 'memory-check': 'memory-check.sh', bootstrap: 'bootstrap.sh' };

/** A top-level `key: value` from a YAML file. */
function yamlScalar(text, key) {
  return text.match(new RegExp(`^${key}:\\s*"?([^"\\n#]*?)"?\\s*(?:#.*)?$`, 'm'))?.[1];
}

describe('lab-host-arc-run.yml', () => {
  it('has one job', () => {
    expect(jobs.map((j) => j.key)).toEqual(['run']);
  });

  it('runs only by hand, with one input: a choice of three fixed actions', () => {
    const on = source.slice(source.indexOf('\non:\n'), source.indexOf('\npermissions:'));
    expect(on).toMatch(/^ {2}workflow_dispatch:$/m);
    expect(on).not.toMatch(/^ {2}(push|pull_request|pull_request_target|schedule|workflow_run|repository_dispatch|workflow_call):/m);
    const inputs = [...on.matchAll(/^ {6}([a-z_-]+):$/gm)].map((m) => m[1]);
    expect(inputs).toEqual(['action']);
    expect(on).toMatch(/^ {8}type: choice$/m);
    const options = [...on.matchAll(/^ {10}- ([a-z-]+)$/gm)].map((m) => m[1]);
    expect(options).toEqual(Object.keys(ACTIONS));
  });

  it('maps each action to its own script file, and stops on anything else', () => {
    const choose = job.steps.find((step) => step.name === 'Choose the script');
    for (const [action, file] of Object.entries(ACTIONS)) {
      expect(choose.run).toContain(`${action}) script=lab-host/arc-run/${file};`);
      const path = join(REPO, 'lab-host', 'arc-run', file);
      expect(existsSync(path), path).toBe(true);
      expect(statSync(path).mode & 0o111, `${file} is not executable`).not.toBe(0);
    }
    expect(choose.run).toMatch(/\*\) echo "::error::Unknown action[^"]*"; exit 1 ;;/);
  });

  it('writes no ${{ }} expression into any shell line', () => {
    for (const step of job.steps) {
      expect(step.run ?? '', step.name).not.toMatch(/\$\{\{/);
    }
    // The input reaches the shell through env only.
    expect(job.lines.some((line) => /^ {6}ACTION: \$\{\{ inputs\.action \}\}$/.test(line))).toBe(true);
  });

  it('names the production environment and signs in as the Run Command identity', () => {
    expect(job.lines.some((line) => /^ {4}environment: production$/.test(line))).toBe(true);
    expect(job.lines.some((line) => /client-id: \$\{\{ vars\.ARC_RUN_CLIENT_ID \}\}/.test(line))).toBe(true);
    expect(job.lines.some((line) => /vars\.(CLIENT_ID|READER_CLIENT_ID|MANIFEST_WINDOW_CLIENT_ID)\b/.test(line))).toBe(false);
    expect(job.steps.find((step) => step.name === 'Refuse a run from a ref that is not main')?.if).toBe("github.ref != 'refs/heads/main'");
  });

  it('holds contents read and, on the job only, id-token write', () => {
    const grants = commandLines.filter((line) => /^\s+(contents|actions|id-token|pull-requests|issues|packages|deployments|statuses|checks):\s/.test(line));
    expect(grants.map((line) => line.replace(/\s+#.*$/, '').trim()).sort()).toEqual(['contents: read', 'contents: read', 'id-token: write']);
    expect(commandLines.some((line) => /^ {6}id-token: write/.test(line))).toBe(true);
    expect(commandLines.some((line) => /^ {2}id-token:/.test(line))).toBe(false);
  });

  it('pins every action by a full commit SHA and never persists the checkout credential', () => {
    const uses = commandLines.filter((line) => /^\s+uses:/.test(line));
    expect(uses.length).toBe(2);
    for (const line of uses) expect(line, line).toMatch(/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d/);
    expect(commandLines.some((line) => /persist-credentials: false/.test(line))).toBe(true);
  });

  it('has a time limit on the job and on every step', () => {
    expect(job.lines.some((line) => /^\s{4}timeout-minutes: \d+/.test(line))).toBe(true);
    for (const step of job.steps) expect(step['timeout-minutes'], `${step.name} has no timeout-minutes`).toMatch(/^\d+/);
  });

  it('runs one at a time and never cancels a run in flight', () => {
    expect(source).toMatch(/^concurrency:\n {2}group: lab-host-arc-run\n {2}cancel-in-progress: false$/m);
  });

  it('installs the connectedmachine extension from a pinned wheel whose digest it checks', () => {
    expect(job.lines.some((line) => /^ {6}CONNECTEDMACHINE_SHA256: [0-9a-f]{64}$/.test(line))).toBe(true);
    const install = job.steps.find((step) => step.name.startsWith('Install the Azure CLI connectedmachine extension'));
    expect(install.run).toContain('sha256sum -c -');
    expect(install.run.indexOf('sha256sum -c -')).toBeLessThan(install.run.indexOf('az extension add'));
  });

  it('deletes the run command in an always() step once signed in', () => {
    const del = job.steps.find((step) => step.name === 'Delete the run command from the machine');
    expect(del.if).toBe("always() && steps.login.outcome == 'success' && env.RUN_NAME != ''");
    expect(del.run).toContain('az connectedmachine run-command delete');
    expect(job.steps.at(-1)).toBe(del);
  });

  it('names the Arc machine the arc role onboards', () => {
    const groupVars = readFileSync(join(REPO, 'lab-host', 'ansible', 'group_vars', 'all.yml'), 'utf8');
    const env = (key) => job.lines.find((line) => line.startsWith(`      ${key}: `))?.split(': ')[1];
    expect(env('ARC_RESOURCE_GROUP')).toBe(yamlScalar(groupVars, 'arc_resource_group'));
    expect(env('ARC_MACHINE')).toBe(yamlScalar(groupVars, 'arc_resource_name'));
    expect(env('ARC_LOCATION')).toBe(yamlScalar(groupVars, 'arc_location'));
  });
});

describe('the scripts it runs on the host', () => {
  const read = (file) => readFileSync(join(REPO, 'lab-host', 'arc-run', file), 'utf8');

  it('are POSIX sh, and status is read-only', () => {
    for (const file of Object.values(ACTIONS)) expect(read(file).startsWith('#!/bin/sh\n'), file).toBe(true);
    const status = read('status.sh');
    expect(status).not.toMatch(/\b(rm|mv|cp|tee|install|systemctl (start|stop|restart|enable|disable)|apt|docker (run|rm|stop|kill))\b/);
  });

  it('bootstrap keeps the full log on the host, root-only, and prints only the recap and failed task names', () => {
    const bootstrap = read('bootstrap.sh');
    expect(bootstrap).toContain('umask 077');
    expect(bootstrap).toContain('/opt/hcw-src/lab-host/bootstrap.sh </dev/null >"$log" 2>&1');
    expect(bootstrap).toContain('exit "$rc"');
    expect(bootstrap).not.toMatch(/^cat "\$log"/m);
  });
});

const TOOLS = findBashTools();
const SKIPPED = TOOLS.ready ? '' : ` (SKIPPED here: ${TOOLS.why}; they run on GitHub Actions)`;
const forward = (path) => path.replace(/\\/g, '/');

describe('the run step: bash is there', () => {
  it.skipIf(process.env.GITHUB_ACTIONS !== 'true')('on GitHub Actions bash is present, so the shell tests below run', () => {
    expect(TOOLS.ready, TOOLS.why).toBe(true);
  });
});

describe.skipIf(!TOOLS.ready)(`the run step under bash -e, against a stand-in az${SKIPPED}`, () => {
  const dirs = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Runs the step the way a runner does (`bash -e`), with an `az` whose
   * `create` exits `createExit` and whose `show` prints `view` (or exits 3
   * when `view` is null).
   */
  function runStep({ createExit = 0, view }) {
    const step = job.steps.find((s) => s.name === 'Run the script on the host and report what it printed');
    const dir = forward(mkdtempSync(join(tmpdir(), 'arc-run-')));
    dirs.push(dir);
    const bin = `${dir}/bin`;
    mkdirSync(bin);
    writeFileSync(`${dir}/view.json`, view === null ? '' : JSON.stringify(view));
    const fake = [
      '#!/usr/bin/env bash',
      'case "$3" in',
      `  create) exit ${createExit} ;;`,
      `  show) ${view === null ? 'echo "ResourceNotFound" >&2; exit 3' : `cat '${dir}/view.json'; exit 0`} ;;`,
      'esac',
      'exit 9',
    ].join('\n');
    writeFileSync(`${bin}/az`, `${fake}\n`, { mode: 0o755 });
    const summary = `${dir}/summary.md`;
    writeFileSync(summary, '');
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', step.run], {
      cwd: REPO,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_STEP_SUMMARY: summary,
        RUNNER_TEMP: dir,
        ACTION: 'status',
        SCRIPT_FILE: 'lab-host/arc-run/status.sh',
        RUN_TIMEOUT: '30',
        RUN_NAME: 'hcw-status-1-1',
        ARC_RESOURCE_GROUP: 'rg-lab-hybrid-prod-cus',
        ARC_MACHINE: 'arcs-lab-hybrid-prod-cus-01',
        ARC_LOCATION: 'centralus',
      },
      timeout: 60000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, summary: readFileSync(summary, "utf8") };
  }

  const view = (state, exitCode, output = 'hello', error = '') => ({
    instanceView: { executionState: state, exitCode, executionMessage: '', output, error },
  });

  it('passes a run the host reports as Succeeded with exit 0, and puts the output in the summary', () => {
    const result = runStep({ view: view('Succeeded', 0, 'free -m says 7900') });
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.summary).toContain('execution state **Succeeded**, exit code **0**');
    expect(result.summary).toContain('free -m says 7900');
  });

  it('fails a run the host reports as failed, after writing the summary', () => {
    const result = runStep({ createExit: 1, view: view('Failed', 2, 'PLAY RECAP\nhost: ok=10 failed=1') });
    expect(result.status).toBe(1);
    expect(result.summary).toContain('exit code **2**');
    expect(result.stdout).toContain('::error::The script did not succeed on the host');
  });

  it('fails a run that timed out with no exit code', () => {
    const result = runStep({ createExit: 1, view: view('TimedOut', null) });
    expect(result.status).toBe(1);
    expect(result.summary).toContain('execution state **TimedOut**, exit code **none**');
  });

  it('says so when there is no run command to read back', () => {
    const result = runStep({ createExit: 1, view: null });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::error::Could not read run command hcw-status-1-1 back (create exited 1, show exited 3)');
  });

  it("prints the host's output with workflow commands stopped, so a `::` line in it is only text", () => {
    const result = runStep({ view: view('Succeeded', 0, '::error::injected\n::set-output name=x::y') });
    expect(result.status).toBe(0);
    const lines = result.stdout.split('\n');
    const stop = lines.findIndex((line) => /^::stop-commands::[0-9a-f]{32}$/.test(line));
    const injected = lines.indexOf('::error::injected');
    const resume = lines.findIndex((line) => /^::[0-9a-f]{32}::$/.test(line));
    expect(stop).toBeGreaterThan(-1);
    expect(injected).toBeGreaterThan(stop);
    expect(resume).toBeGreaterThan(injected);
    expect(lines[resume]).toBe(`::${lines[stop].split('::')[2]}::`);
  });
});
