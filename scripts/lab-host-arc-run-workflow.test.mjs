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
    // The id comes from the repository secret, step by step, so the log
    // shows *** (#1610); a job-level env would print it on every step.
    expect(job.lines.some((line) => /^ {6}SUBSCRIPTION_ID:/.test(line))).toBe(false);
    for (const step of job.steps.filter((s) => /az connectedmachine run-command/.test(s.run ?? ''))) {
      expect(step.lines.some((line) => /^ {10}SUBSCRIPTION_ID: \$\{\{ secrets\.SUBSCRIPTION_ID \}\}$/.test(line)), step.name).toBe(true);
    }
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

  it('creates the run command without waiting and polls it every 20 seconds, inside the step time limit', () => {
    const run = job.steps.find((step) => step.name === 'Run the script on the host and report what it printed');
    expect(run.run).toMatch(/--async-execution false \\\n\s+--no-wait \\\n/);
    expect(run.lines.some((line) => /^ {10}POLL_SECONDS: 20$/.test(line))).toBe(true);
    expect(run.run).toContain('deadline="$((step_start + RUN_TIMEOUT + 240))"');
    // The longest script (bootstrap, 2400 s) + 240 s, one poll that overruns
    // the deadline (a 20 s sleep and a read capped at 60 s) and the read-back
    // (capped at 60 s) must fit inside the step's limit.
    expect(Number(run['timeout-minutes']) * 60).toBeGreaterThanOrEqual(2400 + 240 + 20 + 60 + 60);
    expect(job.steps.find((step) => step.name === 'Choose the script').run).toContain('bootstrap) script=lab-host/arc-run/bootstrap.sh; timeout=2400 ;;');
    const jobLimit = Number(job.lines.find((line) => /^ {4}timeout-minutes: /.test(line)).split(': ')[1]);
    const stepSum = job.steps.reduce((sum, step) => sum + Number(step['timeout-minutes']), 0);
    expect(jobLimit).toBeGreaterThanOrEqual(stepSum - 1);
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
  const realDate = TOOLS.ready ? spawnSync('bash', ['-c', 'command -v date'], { encoding: 'utf8' }).stdout.trim() : '';

  /**
   * Runs the step the way a runner does (`bash -e`), with an `az` whose
   * `create` exits `createExit` and whose n-th `show` prints `views[n-1]`
   * (the last one again once they run out), or exits 3 when `views` is null.
   * `date +%s` reads a clock that only the stand-in `sleep` moves, so the
   * poll interval and the deadline are exercised without waiting for them.
   */
  function runStep({ createExit = 0, views, runTimeout = 30 }) {
    const step = job.steps.find((s) => s.name === 'Run the script on the host and report what it printed');
    const dir = forward(mkdtempSync(join(tmpdir(), 'arc-run-')));
    dirs.push(dir);
    const bin = `${dir}/bin`;
    mkdirSync(bin);
    writeFileSync(`${dir}/clock`, '1000\n');
    writeFileSync(`${dir}/shows`, '');
    (views ?? []).forEach((v, i) => writeFileSync(`${dir}/view-${i + 1}.json`, JSON.stringify(v)));
    const fake = [
      '#!/usr/bin/env bash',
      `{ printf '%s' "$*" | tr '\\n' ' '; echo; } >> '${dir}/az-calls.txt'`,
      // As the pinned connectedmachine 1.1.0 does: its show takes no
      // --expand (Hybrid Compute returns the instance view without one), and
      // az refuses an option a command does not know.
      'for arg in "$@"; do case "$arg" in --expand) echo "az: error: unrecognized arguments: --expand" >&2; exit 2 ;; esac; done',
      'case "$3" in',
      `  create) exit ${createExit} ;;`,
      views === null
        ? '  show) echo "ResourceNotFound" >&2; exit 3 ;;'
        : [
            `  show) echo x >> '${dir}/shows'; n=$(wc -l < '${dir}/shows')`,
            `    if [ "$n" -gt ${views.length} ]; then n=${views.length}; fi`,
            `    cat "${dir}/view-$n.json"; exit 0 ;;`,
          ].join('\n'),
      'esac',
      'exit 9',
    ].join('\n');
    writeFileSync(`${bin}/az`, `${fake}\n`, { mode: 0o755 });
    writeFileSync(
      `${bin}/date`,
      `#!/usr/bin/env bash\nif [ "$1" = "+%s" ]; then cat '${dir}/clock'; else exec '${realDate}' "$@"; fi\n`,
      { mode: 0o755 }
    );
    writeFileSync(
      `${bin}/sleep`,
      `#!/usr/bin/env bash\necho "$1" >> '${dir}/sleeps'\necho $(( $(cat '${dir}/clock') + $1 )) > '${dir}/clock'\n`,
      { mode: 0o755 }
    );
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
        RUN_TIMEOUT: String(runTimeout),
        RUN_NAME: 'hcw-status-1-1',
        ARC_RESOURCE_GROUP: 'rg-lab-hybrid-prod-cus',
        ARC_MACHINE: 'arcs-lab-hybrid-prod-cus-01',
        ARC_LOCATION: 'centralus',
        SUBSCRIPTION_ID: '00000000-0000-0000-0000-000000000001',
        POLL_SECONDS: '20',
      },
      timeout: 60000,
    });
    const calls = readFileSync(`${dir}/az-calls.txt`, 'utf8').trim().split('\n');
    const sleeps = existsSync(`${dir}/sleeps`) ? readFileSync(`${dir}/sleeps`, 'utf8').trim().split('\n') : [];
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls, sleeps, summary: readFileSync(summary, 'utf8') };
  }

  const view = (state, exitCode, output = 'hello', error = '', provisioningState = 'Succeeded') => ({
    provisioningState,
    instanceView: { executionState: state, exitCode, executionMessage: '', output, error },
  });
  const running = (output = '') => view('Running', null, output, '', 'Creating');

  /**
   * Every line between a `::stop-commands::<token>` and its `::<token>::`, and
   * a check that no line outside such a pair is host output.
   */
  function guarded(stdout) {
    const inside = [];
    const outside = [];
    let token = null;
    for (const line of stdout.split('\n')) {
      const stop = line.match(/^::stop-commands::([0-9a-f]{32})$/);
      if (token === null && stop) token = stop[1];
      else if (token !== null && line === `::${token}::`) token = null;
      else (token === null ? outside : inside).push(line);
    }
    expect(token, 'a stop-commands block was never closed').toBe(null);
    return { inside, outside };
  }

  it('passes a run the host reports as Succeeded with exit 0, and puts the output in the summary', () => {
    const result = runStep({ views: [view('Succeeded', 0, 'free -m says 7900')] });
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.summary).toContain('execution state **Succeeded**, exit code **0**');
    expect(result.summary).toContain('free -m says 7900');
    // Created without waiting, polled once, read back once; the login
    // selects no subscription, so each call names it.
    expect(result.calls.map((call) => call.split(' ')[2])).toEqual(['create', 'show', 'show']);
    expect(result.calls[0]).toContain('--no-wait');
    expect(result.calls[0]).toContain('--async-execution false');
    for (const call of result.calls.slice(1)) expect(call).not.toContain('--expand');
    for (const call of result.calls) expect(call, call).toContain('--subscription 00000000-0000-0000-0000-000000000001');
  });

  it('polls every 20 seconds while the script runs, printing each state and only the output that is new', () => {
    const result = runStep({
      views: [
        view('Pending', null, '', '', 'Creating'),
        running('step one\nstep tw'),
        running('step one\nstep two\nstep three\n'),
        view('Succeeded', 0, 'step one\nstep two\nstep three\ndone\n'),
      ],
    });
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.sleeps).toEqual(['20', '20', '20', '20']);
    const out = result.stdout;
    for (const phase of [
      '== Uploading lab-host/arc-run/status.sh to arcs-lab-hybrid-prod-cus-01 as run command hcw-status-1-1 (timeout 30 s) ==',
      '== Waiting for the host to start the script (a line every 20 s) ==',
      '== Running on the host ==',
      '== Reading the result ==',
    ]) {
      expect(out).toContain(phase);
    }
    expect(out).toContain('[+0m20s] provisioningState=Creating executionState=Pending');
    expect(out).toContain('[+0m40s] provisioningState=Creating executionState=Running');
    expect(out).toContain('[+1m00s] provisioningState=Creating executionState=Running');
    expect(out).toContain('[+1m20s] provisioningState=Succeeded executionState=Succeeded');
    expect(out.indexOf('== Running on the host ==')).toBeLessThan(out.indexOf('[+0m40s]'));
    // Each host line is printed once, in order, inside a stop-commands
    // block; the half line "step tw" waits until it is whole.
    const { inside } = guarded(out);
    expect(inside.filter((line) => line.trim() !== '')).toEqual(['step one', 'step two', 'step three', 'done']);
    expect(out).not.toContain('step tw\n');
    expect(out.indexOf('step one')).toBeLessThan(out.indexOf('[+1m00s]'));
    expect(out.indexOf('step three')).toBeLessThan(out.indexOf('[+1m20s]'));
    expect(result.summary).toContain('step one\nstep two\nstep three\ndone');
  });

  it('says so when early output scrolls out of the 4 KB window between two polls', () => {
    const result = runStep({ views: [running('a\nb\n'), running('c\nd\n'), view('Succeeded', 0, 'd\ne\n')] });
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    const { inside } = guarded(result.stdout);
    expect(inside.filter((line) => line.trim() !== '')).toEqual(['a', 'b', '(earlier output scrolled out of the 4 KB the host keeps)', 'c', 'd', 'e']);
  });

  it('stops polling at Failed and fails the step, after writing the summary', () => {
    const result = runStep({ views: [running('PLAY RECAP\n'), view('Failed', 2, 'PLAY RECAP\nhost: ok=10 failed=1\n', '', 'Failed')] });
    expect(result.status).toBe(1);
    expect(result.sleeps).toHaveLength(2);
    expect(result.stdout).toContain('provisioningState=Failed executionState=Failed');
    expect(result.summary).toContain('exit code **2**');
    expect(result.stdout).toContain('::error::The script did not succeed on the host: execution state Failed, exit code 2.');
  });

  it('stops polling when the run command itself fails before the script reports', () => {
    const result = runStep({ views: [view('Unknown', null, '', 'handler not allowed', 'Failed')] });
    expect(result.status).toBe(1);
    expect(result.sleeps).toHaveLength(1);
    expect(result.stdout).toContain('::error::The script did not succeed on the host: execution state Unknown, exit code none.');
    expect(guarded(result.stdout).inside).toContain('handler not allowed');
  });

  it('fails a run that timed out on the host with no exit code', () => {
    const result = runStep({ views: [view('TimedOut', null)] });
    expect(result.status).toBe(1);
    expect(result.summary).toContain('execution state **TimedOut**, exit code **none**');
  });

  it('gives up at RUN_TIMEOUT + 240 seconds when the script never finishes, and fails saying so', () => {
    const result = runStep({ runTimeout: 60, views: [running('still going\n')] });
    expect(result.status).toBe(1);
    // 60 + 240 = 300 s from the start of the step: fifteen polls 20 s apart.
    expect(result.sleeps).toHaveLength(15);
    expect(result.stdout).toContain('[+5m00s] provisioningState=Creating executionState=Running');
    expect(result.stdout).toContain(
      '::error::Run command hcw-status-1-1 had not finished 60 s + 240 s after this step started (execution state Running).'
    );
    expect(guarded(result.stdout).inside.filter((line) => line === 'still going')).toHaveLength(1);
    expect(result.summary).toContain('execution state **Running**');
  });

  it('keeps polling while a read carries no state yet', () => {
    const result = runStep({ views: [{ error: 'not json for jq' }, view('Succeeded', 0, 'ok\n')] });
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.stdout).toContain('[+0m20s] provisioningState=unknown executionState=unknown');
  });

  it('reads an instance view left under properties too, should a later extension stop flattening', () => {
    const result = runStep({
      views: [{ properties: { provisioningState: 'Succeeded', instanceView: { executionState: 'Succeeded', exitCode: 0, executionMessage: '', output: 'nested ok', error: '' } } }],
    });
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.summary).toContain('execution state **Succeeded**, exit code **0**');
    expect(result.summary).toContain('nested ok');
    expect(result.stdout).toContain('provisioningState=Succeeded executionState=Succeeded');
  });

  it('fails, saying so, when the run command comes back with no instance view', () => {
    const result = runStep({ runTimeout: 0, views: [{ name: 'hcw-status-1-1', provisioningState: 'Creating' }] });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::error::Run command hcw-status-1-1 came back without an instance view');
  });

  it('does not wait, and says why, when the create is refused', () => {
    const result = runStep({ createExit: 1, views: null });
    expect(result.status).toBe(1);
    expect(result.sleeps).toHaveLength(0);
    expect(result.stdout).toContain('create exited 1, so there is nothing to wait for.');
    expect(result.stdout).toContain('::error::Could not read run command hcw-status-1-1 back (create exited 1, show exited 3)');
  });

  it('prints each line once when the 4 KB window is cut mid-line, with no false scroll note', () => {
    // 300 distinct lines, about 12 KB; each poll sees 3000 bytes more, and
    // Azure keeps the last 4096 bytes, cut wherever that falls.
    const text = Array.from({ length: 300 }, (_, i) => `line ${String(i).padStart(3, '0')} ${'x'.repeat(30)}`).join('\n') + '\n';
    const windows = [];
    for (let upto = 3000; ; upto += 3000) {
      const end = Math.min(upto, text.length);
      windows.push(text.slice(Math.max(0, end - 4096), end));
      if (end === text.length) break;
    }
    expect(windows.length).toBeGreaterThan(3);
    expect(windows.slice(1).some((w) => !w.startsWith('line '))).toBe(true);
    const views = windows.map((w, i) => (i === windows.length - 1 ? view('Succeeded', 0, w) : running(w)));
    const result = runStep({ views });
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    const printed = guarded(result.stdout).inside.filter((line) => line.trim() !== '');
    expect(printed).not.toContain('(earlier output scrolled out of the 4 KB the host keeps)');
    expect(printed).toEqual(text.trimEnd().split('\n'));
  });

  it('shows a state or exit code that is not a plain word or number as unexpected, so it cannot forge a command', () => {
    const forged = {
      provisioningState: 'Creating\n::warning::FORGED-PROV',
      instanceView: { executionState: 'Failed\n::warning::FORGED-STATE', exitCode: '0\n::error::FORGED-CODE', executionMessage: '', output: '', error: '' },
    };
    const result = runStep({ runTimeout: 0, views: [forged] });
    expect(result.status).toBe(1);
    expect(result.stdout).not.toMatch(/^::(warning|error)::FORGED/m);
    expect(result.stdout).toContain('provisioningState=unexpected executionState=unexpected');
    expect(result.stdout).toContain('executionState=unexpected exitCode=unexpected');
    expect(result.summary).toContain('execution state **unexpected**, exit code **unexpected**');
    expect(result.stdout).toContain('::error::Run command hcw-status-1-1 had not finished 0 s + 240 s');
  });

  it('keeps a carriage return from closing the summary fence', () => {
    const result = runStep({ views: [view('Succeeded', 0, 'a\r~~~~\r# INJECTED HEADING', 'b\r~~~~\r# ERROR HEADING')] });
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.summary).not.toContain('\r');
    const blocks = result.summary.split('~~~~text\n').slice(1).map((part) => part.split('\n~~~~\n')[0]);
    expect(blocks).toEqual(['a\n    ~~~~\n# INJECTED HEADING', 'b\n    ~~~~\n# ERROR HEADING']);
  });

  it('stops polling when provisioning has succeeded, and lets the read-back decide', () => {
    const result = runStep({ views: [{ provisioningState: 'Succeeded', instanceView: { exitCode: 0, executionMessage: '', output: 'ok\n', error: '' } }] });
    expect(result.sleeps).toHaveLength(1);
    expect(result.stdout).toContain('[+0m20s] provisioningState=Succeeded executionState=unknown');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::error::The script did not succeed on the host: execution state unknown, exit code 0.');
  });

  it('keeps a host line that would close the summary fence inside it', () => {
    const result = runStep({ views: [view('Succeeded', 0, 'before\n ~~~~\n~~~ also\nafter')] });
    expect(result.status).toBe(0);
    const fenced = result.summary.split('~~~~text\n')[1].split('\n~~~~\n')[0];
    expect(fenced).toBe('before\n     ~~~~\n    ~~~ also\nafter');
  });

  it("prints the host's output with workflow commands stopped, mid-run and at the end, so a `::` line in it is only text", () => {
    const result = runStep({
      views: [
        running('starting\n::error::injected mid-run\n'),
        running('starting\n::error::injected mid-run\n::add-mask::x\n'),
        view('Succeeded', 0, 'starting\n::error::injected mid-run\n::add-mask::x\n::set-output name=x::y', '::warning::from stderr'),
      ],
    });
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    const { inside, outside } = guarded(result.stdout);
    expect(inside).toEqual(expect.arrayContaining(['::error::injected mid-run', '::add-mask::x', '::set-output name=x::y', '::warning::from stderr']));
    // Nothing the host printed reaches the log outside a guarded block.
    expect(outside.filter((line) => /^::(?!stop-commands)/.test(line))).toEqual([]);
    expect(inside.filter((line) => line === '::error::injected mid-run')).toHaveLength(1);
    // Each block has its own token.
    const tokens = [...result.stdout.matchAll(/^::stop-commands::([0-9a-f]{32})$/gm)].map((m) => m[1]);
    expect(tokens.length).toBeGreaterThan(2);
    expect(new Set(tokens).size).toBe(tokens.length);
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
