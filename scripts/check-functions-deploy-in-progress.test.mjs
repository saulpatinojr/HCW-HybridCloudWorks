/**
 * The monitor believes an open host storage window only once no functions
 * deploy holds it (#1205).
 *
 * Two halves. The script is held to its contract: a run in progress is
 * named, none is none, and a history it could not read is neither. Then the
 * monitor's own step is run, in bash, against a stubbed `az`, `node` and
 * `sleep`, through the 2026-10-15 collision and the cases around it, because
 * the waiting rule is shell code and the defect was in the order of reads.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import {
  findDeploysInProgress,
  formatRuns,
  MAX_RUNS,
  run,
} from './check-functions-deploy-in-progress.mjs';
import { DEPLOY_WORKFLOW } from './check-registered-functions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SCRIPT = join(HERE, 'check-functions-deploy-in-progress.mjs');
const MONITOR = 'monitor-functions-registered.yml';
const STEP = 'Are the functions registered?';
/** A workflow file's text, by file name. */
const workflow = (name) => readFileSync(join(ROOT, '.github', 'workflows', name), 'utf8');

const ENV = { GITHUB_TOKEN: 't0ken', GITHUB_REPOSITORY: 'saulpatinojr/HCW-HybridCloudWorks' };
const LIVE = {
  id: 38819173840,
  run_number: 312,
  status: 'in_progress',
  run_started_at: '2026-10-15T22:44:44Z',
  html_url: 'https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/runs/38819173840',
};

/** A fake GitHub API answering the runs listing with `runs`, or `status`. */
function github({ runs = [], status = 200, body } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body ?? { workflow_runs: runs } };
  };
  return { fetchImpl, calls };
}

describe('findDeploysInProgress', () => {
  it('asks for the in-progress runs of the deploy workflow, with the token', async () => {
    const { fetchImpl, calls } = github({ runs: [LIVE] });
    await findDeploysInProgress({ token: 't0ken', owner: 'o', repo: 'r', fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `https://api.github.com/repos/o/r/actions/workflows/${DEPLOY_WORKFLOW}/runs?status=in_progress&per_page=${MAX_RUNS}`
    );
    expect(calls[0].init.headers.Authorization).toBe('Bearer t0ken');
  });

  it('keeps only runs that are in progress, whatever the filter returned', async () => {
    const { fetchImpl } = github({ runs: [{ ...LIVE, id: 1, status: 'completed' }, LIVE, { ...LIVE, id: 2, status: 'waiting' }] });
    const found = await findDeploysInProgress({ token: 't0ken', owner: 'o', repo: 'r', fetchImpl });
    expect(found.map((r) => r.id)).toEqual([LIVE.id]);
  });

  it('refuses a payload without a workflow_runs array rather than reading it as none', async () => {
    const { fetchImpl } = github({ body: { message: 'Not Found' } });
    await expect(findDeploysInProgress({ token: 't0ken', owner: 'o', repo: 'r', fetchImpl })).rejects.toThrow(/workflow_runs/);
  });
});

describe('formatRuns', () => {
  it('reads no run as none, exit 0', () => {
    expect(formatRuns([])).toEqual({ code: 0, lines: ['none'] });
  });

  it('names one run, with its URL, exit 1', () => {
    const got = formatRuns([LIVE]);
    expect(got.code).toBe(1);
    expect(got.lines[0]).toBe('deploy run #312 in progress');
    expect(got.lines[1]).toContain(LIVE.html_url);
    expect(got.lines[1]).toContain('started 2026-10-15T22:44:44Z');
  });

  it('counts several', () => {
    expect(formatRuns([LIVE, { ...LIVE, id: 9, run_number: 313 }]).lines[0]).toBe('2 deploy runs in progress');
  });
});

describe('run', () => {
  it('exits 1 naming a deploy in progress', async () => {
    const got = await run({ env: ENV, fetchImpl: github({ runs: [LIVE] }).fetchImpl });
    expect(got.code).toBe(1);
  });

  it('exits 0 when none is', async () => {
    expect((await run({ env: ENV, fetchImpl: github().fetchImpl })).code).toBe(0);
  });

  it('exits 2, not 0, when GitHub refuses', async () => {
    const got = await run({ env: ENV, fetchImpl: github({ status: 403 }).fetchImpl });
    expect(got.code).toBe(2);
    expect(got.lines[0]).toBe('unreadable');
    expect(got.lines[1]).toContain('403');
  });

  it('exits 2 without a token or a repository', async () => {
    expect((await run({ env: {} })).code).toBe(2);
    expect((await run({ env: { GITHUB_TOKEN: 't0ken', GITHUB_REPOSITORY: 'no-slash' } })).code).toBe(2);
  });

  it('exits 2 on any argument', async () => {
    expect((await run({ args: ['--bogus'], env: ENV })).code).toBe(2);
  });
});

describe('the CLI actually executes', () => {
  it('exits 2 and says why when it has no token', () => {
    const got = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', cwd: ROOT, env: { PATH: process.env.PATH } });
    expect(got.status).toBe(2);
    expect(got.stdout.split('\n')[0]).toBe('unreadable');
  });
});

describe('the workflows hold the premise this script relies on', () => {
  it(`${DEPLOY_WORKFLOW} opens and closes the storage window inside its one job`, () => {
    // The window is bounded by the run only while it lives in the run's one
    // job, and closes in an always() step there.
    const text = workflow(DEPLOY_WORKFLOW);
    const jobs = text.slice(text.indexOf('\njobs:')).match(/^ {2}[a-z][a-z-]*:$/gm);
    expect(jobs).toEqual(['  deploy:']);
    expect(text).toMatch(/^ {6}- name: Open storage firewall window for this runner$/m);
    const close = text.slice(text.search(/^ {6}- name: Close storage firewall window$/m));
    expect(close.split('\n')[1]).toMatch(/if: \$\{\{ always\(\)/);
  });

  it('the monitor asks before it believes an open window, and does not share the deploy concurrency group', () => {
    const text = workflow(MONITOR);
    expect(text).toMatch(/deployout=\$\(node scripts\/check-functions-deploy-in-progress\.mjs\)/);
    expect(text).not.toMatch(/group: function-app-host/);
    expect(text).toMatch(/^ {6}actions: read\b/m);
  });
});

/** Leading whitespace, in characters. */
const indentOf = (line) => line.length - line.trimStart().length;

/** The `run: |` script of the step with this name, dedented. */
function stepScript(source, name) {
  const lines = String(source).split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  const runAt = lines.findIndex((l, i) => i > start && /^\s*run: \|\s*$/.test(l));
  const body = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() && indentOf(line) <= indentOf(lines[runAt])) break;
    body.push(line);
  }
  const indent = Math.min(...body.filter((l) => l.trim()).map(indentOf));
  return body.map((l) => l.slice(indent)).join('\n');
}

// On Windows only a Git Bash (MSYSTEM set) is the bash this step is written
// for; System32's bash is WSL, which cannot see these paths.
const bashUsable =
  (process.platform !== 'win32' || Boolean(process.env.MSYSTEM)) &&
  spawnSync('bash', ['-c', 'true'], { encoding: 'utf8' }).status === 0;

/**
 * Stubs for every command the step runs that would leave the machine. Each
 * answer comes from a sequence file in $STATE, one line per call, the last
 * line repeating; every call is logged, and `sleep` only records its length.
 */
const STUBS = {
  az: `#!/usr/bin/env bash
pop() { f="$STATE/$1.seq"; first=$(head -n 1 "$f"); if [ "$(wc -l < "$f")" -gt 1 ]; then tail -n +2 "$f" > "$f.tmp"; mv "$f.tmp" "$f"; fi; printf '%s\\n' "$first"; }
echo "az $*" >> "$STATE/calls"
case "$*" in
  *"function list"*) printf 'func-site-prod-cus-01/healthCheck\\n' ;;
  *"access-restriction show"*) echo '{}' ;;
  *AzureWebJobsStorage*) echo 0 ;;
  *RUNTIME_CONFIG_WRITER*) echo azapi-strip ;;
  *"storage account show"*) pop netaction ;;
  *"network-rule list"*) pop cirules ;;
  *) echo "unexpected az $*" >&2; exit 9 ;;
esac
`,
  node: `#!/usr/bin/env bash
pop() { f="$STATE/$1.seq"; first=$(head -n 1 "$f"); if [ "$(wc -l < "$f")" -gt 1 ]; then tail -n +2 "$f" > "$f.tmp"; mv "$f.tmp" "$f"; fi; printf '%s' "$first"; }
echo "node $*" >> "$STATE/calls"
case "$1" in
  *check-registered-functions.mjs) cat > /dev/null; echo "1 of 1" ;;
  *check-ci-access-windows.mjs) cat > /dev/null; echo "none" ;;
  *check-functions-deploy-in-progress.mjs)
    case "$(pop deploys)" in
      0) echo none ;;
      1) echo "deploy run #312 in progress"; echo "- deploy run #312 of \\\`deploy-functions.yml\\\`: https://example.invalid/runs/38819173840"; exit 1 ;;
      *) echo unreadable; echo "Whether a functions deploy is in progress could not be read: GitHub answered 502"; exit 2 ;;
    esac ;;
  *) echo "unexpected node $*" >&2; exit 9 ;;
esac
`,
  sleep: `#!/usr/bin/env bash
echo "$1" >> "$STATE/sleeps"
`,
};

// A minute per case: the hung deploy is forty polls, each a process, and
// process start is slow on Windows and on a loaded runner.
describe.skipIf(!bashUsable)('the monitor step, run against a stubbed estate', { timeout: 60000 }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'monitor-deploy-wait-'));
  // Run from a file, not `bash -c`: Windows re-quotes a three-hundred-line
  // argument on its way into Git Bash and the step arrives cut short.
  // Forward slashes, which Git Bash and Linux both read as the same path.
  const script = join(scratch, 'step.sh').replace(/\\/g, '/');
  writeFileSync(script, `${stepScript(workflow(MONITOR), STEP)}\n`);
  const bin = join(scratch, 'bin');
  mkdirSync(bin);
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  /** The step's exit status, report, sleeps and calls for these answer sequences. */
  const monitor = ({ netaction, cirules, deploys = ['0'] }) => {
    const state = mkdtempSync(join(scratch, 'state-'));
    writeFileSync(join(state, 'netaction.seq'), `${netaction.join('\n')}\n`);
    writeFileSync(join(state, 'cirules.seq'), `${cirules.join('\n')}\n`);
    writeFileSync(join(state, 'deploys.seq'), `${deploys.join('\n')}\n`);
    const summary = join(state, 'summary.md');
    const result = spawnSync('bash', [script], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60000,
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        STATE: state,
        APP: 'func-site-prod-cus-01',
        RG: 'rg-web-site-prod-cus',
        STOR: 'stsitefuncprodcus01',
        GITHUB_STEP_SUMMARY: summary,
        ...ENV,
      },
    });
    const read = (name) => (existsSync(join(state, name)) ? readFileSync(join(state, name), 'utf8') : '');
    return {
      status: result.status,
      report: read('summary.md'),
      out: `${result.stdout}${result.stderr}`,
      sleeps: read('sleeps').split('\n').filter(Boolean),
      storageReads: read('calls').split('\n').filter((l) => l.includes('storage account show')).length,
      deployReads: read('calls').split('\n').filter((l) => l.includes('check-functions-deploy-in-progress')).length,
    };
  };

  it('2026-10-15: open mid-deploy, it waits for the deploy and passes on the window it closed', () => {
    const got = monitor({ netaction: ['Allow', 'Deny'], cirules: ['1', '0'], deploys: ['1', '1', '0'] });
    expect(got.out).toContain('waiting for it to close its own window');
    expect(got.sleeps).toEqual(['30', '30']);
    expect(got.storageReads).toBe(2);
    expect(got.report).toContain('| Host storage default action | Deny | ✅ |');
    expect(got.report).toContain('| IP rules on host storage | 0 | ✅ |');
    expect(got.status).toBe(0);
  });

  it('an orphan: open with no deploy running, still open a minute later, is ❌', () => {
    const got = monitor({ netaction: ['Allow'], cirules: ['1'], deploys: ['0'] });
    expect(got.sleeps).toEqual(['60']);
    expect(got.storageReads).toBe(2);
    expect(got.report).toContain('| Host storage default action | **Allow** | ❌ |');
    expect(got.report).toContain('| IP rules on host storage | **1** | ❌ |');
    expect(got.status).toBe(1);
  });

  it('a run closing its window as it was read passes on the read a minute later', () => {
    // Deny already set and the rule not yet removed: the order the close
    // step runs in, with the run ended before the history was asked.
    const got = monitor({ netaction: ['Deny', 'Deny'], cirules: ['1', '0'], deploys: ['0'] });
    expect(got.sleeps).toEqual(['60']);
    expect(got.report).toContain('| IP rules on host storage | 0 | ✅ |');
    expect(got.status).toBe(0);
  });

  it('a deploy still holding the window after twenty minutes is ⚠️, named, not ❌', () => {
    const got = monitor({ netaction: ['Allow'], cirules: ['1'], deploys: ['1'] });
    expect(got.sleeps).toHaveLength(40);
    expect(got.sleeps.every((s) => s === '30')).toBe(true);
    expect(got.report).toContain('| Host storage default action | **Allow**, a deploy is still in progress | ⚠️ |');
    expect(got.report).toContain('| IP rules on host storage | **1**, a deploy is still in progress | ⚠️ |');
    expect(got.report).toContain('https://example.invalid/runs/38819173840');
    // No row is ❌; the guidance under the table mentions the mark in prose.
    expect(got.report).not.toMatch(/\| ❌ \|$/m);
    expect(got.status).toBe(1);
  });

  it('a run history it cannot read does not excuse an open window', () => {
    const got = monitor({ netaction: ['Allow'], cirules: ['1'], deploys: ['2'] });
    expect(got.sleeps).toEqual(['60']);
    expect(got.report).toContain('| Host storage default action | **Allow** | ❌ |');
    expect(got.report).toContain('could not be read: GitHub answered 502');
    expect(got.status).toBe(1);
  });

  it('a closed window costs no wait and no question about deploys', () => {
    const got = monitor({ netaction: ['Deny'], cirules: ['0'] });
    expect(got.sleeps).toEqual([]);
    expect(got.storageReads).toBe(1);
    expect(got.deployReads).toBe(0);
    expect(got.status).toBe(0);
  });
});
