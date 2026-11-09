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
 * - The job names its own environment, `lab-host-arc` (its required
 *   reviewers approve each run and its branch policy admits main only), and
 *   signs in as github_arc_run (ARC_RUN_CLIENT_ID). The environment is the
 *   control: github_arc_run trusts that environment's subject, so
 *   oidc-subjects.test.mjs fails if any other workflow names it.
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

  it('names its own lab-host-arc environment, never production, and signs in as the Run Command identity', () => {
    expect(job.lines.some((line) => /^ {4}environment: lab-host-arc$/.test(line))).toBe(true);
    expect(source).not.toMatch(/^\s*environment:\s*production\b/m);
    expect(job.lines.some((line) => /client-id: \$\{\{ vars\.ARC_RUN_CLIENT_ID \}\}/.test(line))).toBe(true);
    expect(job.lines.some((line) => /vars\.(CLIENT_ID|READER_CLIENT_ID|MANIFEST_WINDOW_CLIENT_ID)\b/.test(line))).toBe(false);
    expect(job.steps.find((step) => step.name === 'Refuse a run from a ref that is not main')?.if).toBe("github.ref != 'refs/heads/main'");
  });

  it('signs in without selecting a subscription, and names it on every az connectedmachine call', () => {
    // The identity's only grant is at resource-group scope, so a pinned
    // subscription could fail the login (as verify-alert-state.yml says).
    expect(job.lines.some((line) => /^\s+allow-no-subscriptions: true$/.test(line))).toBe(true);
    expect(job.lines.some((line) => /^\s+subscription-id:/.test(line))).toBe(false);
    expect(job.lines.some((line) => /^ {6}SUBSCRIPTION_ID: \$\{\{ vars\.SUBSCRIPTION_ID \}\}$/.test(line))).toBe(true);
    // Each call is written one option per line; its first option is the subscription.
    const calls = job.steps.flatMap((step) =>
      [...(step.run ?? '').matchAll(/az connectedmachine run-command (\w+) \\\n([^\n]*)\n/g)].map((m) => ({ verb: m[1], first: m[2] }))
    );
    expect(calls.map((c) => c.verb).sort()).toEqual(['create', 'delete', 'show']);
    for (const { verb, first } of calls) expect(first, verb).toMatch(/^\s*--subscription "\$\{SUBSCRIPTION_ID\}" \\$/);
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
      `{ printf '%s' "$*" | tr '\\n' ' '; echo; } >> '${dir}/az-calls.txt'`,
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
        SUBSCRIPTION_ID: '00000000-0000-0000-0000-000000000001',
      },
      timeout: 60000,
    });
    const calls = readFileSync(`${dir}/az-calls.txt`, 'utf8').trim().split('\n');
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls, summary: readFileSync(summary, "utf8") };
  }

  const view = (state, exitCode, output = 'hello', error = '') => ({
    instanceView: { executionState: state, exitCode, executionMessage: '', output, error },
  });

  it('passes a run the host reports as Succeeded with exit 0, and puts the output in the summary', () => {
    const result = runStep({ view: view('Succeeded', 0, 'free -m says 7900') });
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.summary).toContain('execution state **Succeeded**, exit code **0**');
    expect(result.summary).toContain('free -m says 7900');
    // The login selects no subscription, so each call names it.
    expect(result.calls.map((call) => call.split(' ')[2])).toEqual(['create', 'show']);
    for (const call of result.calls) expect(call, call).toContain('--subscription 00000000-0000-0000-0000-000000000001');
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

  it('keeps a host line that would close the summary fence inside it', () => {
    const result = runStep({ view: view('Succeeded', 0, 'before\n ~~~~\n~~~ also\nafter') });
    expect(result.status).toBe(0);
    const fenced = result.summary.split('~~~~text\n')[1].split('\n~~~~\n')[0];
    expect(fenced).toBe('before\n     ~~~~\n    ~~~ also\nafter');
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

describe.skipIf(!TOOLS.ready)(`the delete step under bash, against a stand-in az${SKIPPED}`, () => {
  const dirs = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  /** Runs the delete step with an `az` that fails its first `failures` deletes, and a `sleep` that returns at once. */
  function runDelete(failures) {
    const step = job.steps.find((s) => s.name === 'Delete the run command from the machine');
    const dir = forward(mkdtempSync(join(tmpdir(), 'arc-delete-')));
    dirs.push(dir);
    const bin = `${dir}/bin`;
    mkdirSync(bin);
    writeFileSync(
      `${bin}/az`,
      [
        '#!/usr/bin/env bash',
        `printf '%s\\n' "$*" >> '${dir}/calls.txt'`,
        `n=$(wc -l < '${dir}/calls.txt')`,
        `if [ "$n" -le ${failures} ]; then echo "ERROR: transient" >&2; exit 1; fi`,
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
    writeFileSync(`${bin}/sleep`, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', step.run], {
      cwd: REPO,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        RUN_NAME: 'hcw-status-1-1',
        ARC_RESOURCE_GROUP: 'rg-lab-hybrid-prod-cus',
        ARC_MACHINE: 'arcs-lab-hybrid-prod-cus-01',
        SUBSCRIPTION_ID: '00000000-0000-0000-0000-000000000001',
      },
      timeout: 60000,
    });
    const calls = readFileSync(`${dir}/calls.txt`, 'utf8').trim().split('\n');
    return { status: result.status, stdout: result.stdout, calls };
  }

  it('deletes on the first try, naming the subscription', () => {
    const result = runDelete(0);
    expect(result.status).toBe(0);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toContain('connectedmachine run-command delete --subscription 00000000-0000-0000-0000-000000000001');
    expect(result.stdout).toContain('Deleted run command hcw-status-1-1.');
  });

  it('retries a passing failure and succeeds on the third try', () => {
    const result = runDelete(2);
    expect(result.status).toBe(0);
    expect(result.calls).toHaveLength(3);
    expect(result.stdout).toContain('Delete try 2 of 3 exited 1.');
  });

  it('after three failures, fails with a warning that names the run command and the line to delete it by hand', () => {
    const result = runDelete(3);
    expect(result.status).toBe(1);
    expect(result.calls).toHaveLength(3);
    expect(result.stdout).toContain(
      '::warning::Run command hcw-status-1-1 could NOT be deleted from arcs-lab-hybrid-prod-cus-01 after three tries'
    );
    expect(result.stdout).toContain(
      'az connectedmachine run-command delete --subscription sub-app-site-prod-cus --resource-group rg-lab-hybrid-prod-cus --machine-name arcs-lab-hybrid-prod-cus-01 --name hcw-status-1-1 --yes'
    );
  });
});

describe.skipIf(!TOOLS.ready)(`memory-check.sh with a stand-in node${SKIPPED}`, () => {
  const dirs = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  /** Runs memory-check.sh under sh with a checkout, `node` exiting `codes[n]` on run n, and quiet `free`/`dmesg`. */
  function runCheck(codes) {
    const dir = forward(mkdtempSync(join(tmpdir(), 'arc-memcheck-')));
    dirs.push(dir);
    const bin = `${dir}/bin`;
    const src = `${dir}/src`;
    mkdirSync(bin);
    mkdirSync(`${src}/vps-agent/lib`, { recursive: true });
    writeFileSync(
      `${src}/vps-agent/lib/capabilities.js`,
      `'docker.io/hybridcloudworks/hcw-lab-runner:${'a'.repeat(40)}@sha256:${'b'.repeat(64)}',\n`
    );
    writeFileSync(
      `${bin}/node`,
      [
        '#!/bin/sh',
        `echo x >> '${dir}/runs'`,
        `n=$(wc -l < '${dir}/runs')`,
        'echo "limits: memory 768m"',
        'echo "noise line"',
        'echo "sandbox-check: ok"',
        `case "$n" in ${codes.map((code, i) => `${i + 1}) exit ${code} ;;`).join(' ')} esac`,
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
    writeFileSync(`${bin}/free`, '#!/bin/sh\necho "Mem: 7900"\n', { mode: 0o755 });
    writeFileSync(`${bin}/dmesg`, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const result = spawnSync('sh', [join(REPO, 'lab-host', 'arc-run', 'memory-check.sh')], {
      encoding: 'utf8',
      env: { ...process.env, HCW_ARC_RUN_PATH: `${bin}:${process.env.PATH}`, HCW_ARC_RUN_SRC: src },
      timeout: 60000,
    });
    return { status: result.status, stdout: result.stdout };
  }

  it('exits 0 when all five runs succeed, printing only the matching lines', () => {
    const result = runCheck([0, 0, 0, 0, 0]);
    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout.match(/^sandbox-check: ok$/gm)).toHaveLength(5);
    expect(result.stdout.match(/^limits: memory 768m$/gm)).toHaveLength(5);
    expect(result.stdout).not.toContain('noise line');
  });

  it('runs all five and exits 1 when a run crashes, saying which', () => {
    const result = runCheck([0, 0, 3, 0, 0]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('run 3: sandbox-check.mjs exited 3');
    expect(result.stdout).toContain('== run 5');
    expect(result.stdout).toContain('1 of 5 runs failed');
  });
});
