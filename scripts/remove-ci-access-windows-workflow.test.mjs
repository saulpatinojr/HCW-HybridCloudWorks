/**
 * The shape of remove-ci-access-windows.yml (#1463).
 *
 * The job holds an Azure credential that can write two firewalls, so what it
 * runs as, with which permissions and on which subject are each held here:
 *
 * - It signs in as github_manifest_window (MANIFEST_WINDOW_CLIENT_ID) and
 *   names NO environment. The deploy identity trusts only the
 *   `environment:production-backend` subject (since #1617), and that
 *   environment has required reviewers, so a job on it would wait for a
 *   person every hour. Naming any
 *   environment here would also change the OIDC subject away from the ref
 *   form the manifest-window identity trusts (oidc-subjects.test.mjs holds
 *   the credential side).
 * - Its permissions are the three the job uses and nothing more, with
 *   `id-token: write` on the job, not the workflow.
 * - Every action is pinned by commit, the job and each step have a time
 *   limit, dependencies install with `--ignore-scripts`, and the manual
 *   trigger takes no inputs.
 *
 * The last block runs the step's shell under `bash -e`, as a runner does,
 * against a stand-in `node`, because the script's exit code has to survive
 * `-e` to reach the summary (workflow-exit-code-steps.test.mjs says why).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { findBashTools, parseJobs } from './lib/workflow-text.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = join(REPO, '.github', 'workflows', 'remove-ci-access-windows.yml');
const SCRIPT = 'scripts/remove-ci-access-windows.mjs';

const source = readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');
const commandLines = source.split('\n').filter((line) => !/^\s*#/.test(line));
const jobs = parseJobs(source);
const job = jobs.find((j) => j.key === 'remove');
const armed = jobs.find((j) => j.key === 'armed');

describe('remove-ci-access-windows.yml', () => {
  it('has the armed gate and one Azure job, which runs the remover script', () => {
    expect(jobs.map((j) => j.key)).toEqual(['armed', 'remove']);
    const runner = job.steps.find((step) => (step.run ?? '').includes(SCRIPT));
    expect(runner, `no step runs ${SCRIPT}`).toBeDefined();
    expect(runner.name).toBe('Remove the windows whose runs have ended');
  });

  it('runs every hour and by hand, with no inputs on the manual trigger', () => {
    expect(commandLines.some((line) => /^\s+- cron: '11 \* \* \* \*'$/.test(line))).toBe(true);
    const dispatchAt = commandLines.findIndex((line) => /^\s+workflow_dispatch:\s*$/.test(line));
    expect(dispatchAt).toBeGreaterThan(-1);
    expect(commandLines[dispatchAt + 1]).not.toMatch(/^\s+inputs:/);
  });

  it('signs in as the manifest-window identity and names no environment, so it presents the ref-form subject', () => {
    expect(job.lines.some((line) => /client-id: \$\{\{ secrets\.MANIFEST_WINDOW_CLIENT_ID \}\}/.test(line))).toBe(true);
    expect(job.lines.some((line) => /(vars|secrets)\.CLIENT_ID\b/.test(line))).toBe(false);
    expect(commandLines.some((line) => /^\s+environment:/.test(line))).toBe(false);
  });

  it('is gated on the client-id secret, so an unseeded repository skips rather than fails at login', () => {
    // A job's `if:` cannot read `secrets`, so the armed job reads it into env
    // and answers true or false, holding no permission at all (#1618).
    expect(job.lines).toContain('    needs: armed');
    expect(job.lines).toContain("    if: needs.armed.outputs.armed == 'true'");
    expect(armed.lines).toContain('    permissions: {}');
    expect(armed.lines).toContain('          MANIFEST_WINDOW_CLIENT_ID: ${{ secrets.MANIFEST_WINDOW_CLIENT_ID }}');
    expect(armed.steps).toHaveLength(1);
    expect(armed.steps[0].uses).toBeUndefined();
  });

  it('holds exactly the permissions it uses: contents and actions read, id-token write on the job', () => {
    const grants = commandLines.filter((line) => /^\s+(contents|actions|id-token|pull-requests|issues|packages|deployments|statuses|checks):\s/.test(line));
    const trimmed = grants.map((line) => line.replace(/\s+#.*$/, '').trim());
    expect(trimmed.sort()).toEqual(['actions: read', 'contents: read', 'contents: read', 'id-token: write']);
    // The write is on the job (6 spaces), never at the workflow level (2).
    expect(commandLines.some((line) => /^ {6}id-token: write/.test(line))).toBe(true);
    expect(commandLines.some((line) => /^ {2}id-token:/.test(line))).toBe(false);
  });

  it('pins every action by a full commit SHA', () => {
    const uses = commandLines.filter((line) => /^\s+uses:/.test(line));
    expect(uses.length).toBeGreaterThanOrEqual(3);
    for (const line of uses) expect(line, line).toMatch(/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d/);
  });

  it('has a time limit on the job and on every step', () => {
    expect(job.lines.some((line) => /^\s{4}timeout-minutes: \d+/.test(line))).toBe(true);
    for (const step of job.steps) expect(step['timeout-minutes'], `${step.name} has no timeout-minutes`).toMatch(/^\d+/);
  });

  it('installs with --ignore-scripts and never persists the checkout credential', () => {
    expect(commandLines.some((line) => /npm ci --ignore-scripts/.test(line))).toBe(true);
    expect(commandLines.some((line) => /persist-credentials: false/.test(line))).toBe(true);
  });

  it('gives the script the app, group, storage account, token and repository it reads', () => {
    const step = job.steps.find((s) => (s.run ?? '').includes(SCRIPT));
    expect(Object.keys(step.env).sort()).toEqual(['APP', 'GITHUB_REPOSITORY', 'GITHUB_TOKEN', 'RG', 'STOR']);
    expect(step.env.GITHUB_TOKEN).toBe('${{ github.token }}');
  });

  it('never cancels a run in flight: a cancelled run is a window left open an hour longer', () => {
    expect(commandLines.some((line) => /cancel-in-progress: false/.test(line))).toBe(true);
  });
});

/**
 * The remover restores only a storage window it can attribute to a run, and
 * the attribution is the `ciwindow` tag deploy-functions.yml writes. So the
 * deploy's open step must write the tag before it adds the rule (a run that
 * dies between the two leaves a tag and no rule, which the remover reads as
 * "nothing to remove"; the other order would leave a rule nothing names), and
 * its close step must clear it.
 */
describe('deploy-functions.yml names its storage window for the remover', () => {
  const deploy = parseJobs(readFileSync(join(REPO, '.github', 'workflows', 'deploy-functions.yml'), 'utf8').replace(/\r\n/g, '\n')).find((j) => j.key === 'deploy');
  const open = deploy.steps.find((step) => step.name === 'Open storage firewall window for this runner');
  const close = deploy.steps.find((step) => step.name === 'Close storage firewall window');

  it('writes the ciwindow tag (run id and runner address) before adding the rule, and clears it in the close step', () => {
    const lines = open.run.split('\n');
    const tagAt = lines.findIndex((line) => line.includes('--set "tags.ciwindow=${GITHUB_RUN_ID} ${RUNNER_IP}"'));
    const addAt = lines.findIndex((line) => /az storage account network-rule add/.test(line));
    expect(tagAt, 'the open step does not write the tag').toBeGreaterThan(-1);
    expect(addAt).toBeGreaterThan(tagAt);
    expect(close.run).toContain('--remove tags.ciwindow');
  });

  it('writes the same tag name the remover reads', async () => {
    const { WINDOW_TAG } = await import('./remove-ci-access-windows.mjs');
    expect(WINDOW_TAG).toBe('ciwindow');
    const storageTf = readFileSync(join(REPO, 'infra', 'storage.tf'), 'utf8');
    expect(storageTf, 'infra/storage.tf must ignore the tag, or every window in flight is drift').toContain('ignore_changes  = [tags["ciwindow"]]');
  });
});

const TOOLS = findBashTools();
const SKIPPED = TOOLS.ready ? '' : ` (SKIPPED here: ${TOOLS.why}; they run on GitHub Actions)`;
const forward = (path) => path.replace(/\\/g, '/');

describe('the remove step: bash is there', () => {
  it.skipIf(process.env.GITHUB_ACTIONS !== 'true')('on GitHub Actions bash is present, so the shell tests below run', () => {
    expect(TOOLS.ready, TOOLS.why).toBe(true);
  });
});

describe.skipIf(!TOOLS.ready)(`the remove step under bash -e, against a stand-in node${SKIPPED}`, () => {
  const dirs = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  /** Runs the step's shell the way a runner does (`bash -e`), with a `node` that prints `lines` and exits `code`. */
  function runStep({ lines, code }) {
    const step = job.steps.find((s) => (s.run ?? '').includes(SCRIPT));
    const dir = forward(mkdtempSync(join(tmpdir(), 'remove-windows-')));
    dirs.push(dir);
    const bin = `${dir}/bin`;
    mkdirSync(bin);
    const fake = `#!/usr/bin/env bash\nprintf '%s\\n' ${lines.map((l) => `'${l}'`).join(' ')}\nexit ${code}\n`;
    writeFileSync(`${bin}/node`, fake, { mode: 0o755 });
    const summary = `${dir}/summary.md`;
    writeFileSync(summary, '');
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', step.run], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_STEP_SUMMARY: summary },
      timeout: 60000,
    });
    return { status: result.status, stdout: result.stdout, summary: readFileSync(summary, 'utf8') };
  }

  it('passes a clean verdict through, summary and all', () => {
    const result = runStep({ lines: ['nothing left open', '- storage account `s`: default action Deny and no IP rules; nothing is open.'], code: 0 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('nothing left open');
    expect(result.summary).toContain('**nothing left open**');
    expect(result.summary).toContain('- storage account `s`: default action Deny');
    expect(result.summary).not.toContain('**nothing left open**\n\nnothing left open');
  });

  it("fails with the script's own exit code after writing the summary, on 1 and on 2", () => {
    const one = runStep({ lines: ['1 FAILED', '- `ci-smoke-6` on the site: NOT removed: ERROR'], code: 1 });
    expect(one.status).toBe(1);
    expect(one.summary).toContain('**1 FAILED**');
    expect(one.stdout).toContain('::error::a window could not be put back');
    const two = runStep({ lines: ['unreadable', 'This run could not judge the access windows'], code: 2 });
    expect(two.status).toBe(2);
    expect(two.summary).toContain('**unreadable**');
    expect(two.stdout).toContain('::error::the windows could not be judged');
  });

  it('keeps a one-line verdict to one line in the summary', () => {
    const result = runStep({ lines: ['nothing left open'], code: 0 });
    expect(result.status).toBe(0);
    expect(result.summary.match(/nothing left open/g)).toHaveLength(1);
  });
});
