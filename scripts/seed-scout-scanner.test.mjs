/**
 * The add-on image scan survives a refused scanner download, and a scan that did not run still fails the job.
 *
 * `docker/scout-action` downloads its scanner (`docker-scout-action_linux_amd64`, 187 MB) when it starts, and it
 * asks GitHub's API for the file without signing in. GitHub allows 60 such requests an hour per network address,
 * the runners share their addresses, and a spent allowance answers `Unexpected HTTP response: 403` before any image
 * is scanned (https://github.com/docker/scout-action/issues/116). So `addon-image-scout.yml` runs
 * `scripts/lab/seed-scout-scanner.sh` before the Scout step: it fetches the same file with the job's own token,
 * checks it against the sha256 (the file's fingerprint) in `scripts/lab/scout-scanner-pins.txt` and puts it in the
 * action's `dist/` folder, where the action looks before it downloads. The step and this test were first written
 * for the NetworkEyes App (https://github.com/saulpatinojr/HCW-NetworkEyes_App/pull/428).
 *
 * Two things are held here.
 *
 * - The workflow: the job checks out, then fetches the scanner, then scans; the fetch runs under the same
 *   condition as the scan; nothing may continue after an error; and the pinned commit of the action has a row in
 *   the pins file.
 * - The script, run for real with stand-ins for `gh` and `curl`: a good file is installed; a file that cannot be
 *   fetched is a warning and nothing is installed, so the action downloads as before; a file with the wrong sha256
 *   stops the job and is never installed.
 *
 * The stand-ins do not prove that GitHub accepts the job's token for another repository's release, or that the
 * runner keeps its actions where the script looks; only a real run of the workflow shows those, and when either is
 * not so the script warns and the Scout step behaves as it did before.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = join(REPO, '.github', 'workflows');
const WORKFLOW = join(WORKFLOWS, 'addon-image-scout.yml');
const SCRIPT = join(REPO, 'scripts', 'lab', 'seed-scout-scanner.sh');
const PINS = join(REPO, 'scripts', 'lab', 'scout-scanner-pins.txt');

const SCOUT_ACTION = 'docker/scout-action@';
const SEED_RUN = 'bash scripts/lab/seed-scout-scanner.sh';
const ASSET = 'docker-scout-action_linux_amd64';
const PIN_ROW = /^([0-9a-f]{40}) (v\d+\.\d+\.\d+) ([0-9a-f]{64})$/;

const source = readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');
const workflow = parse(source);
const steps = workflow.jobs.scout.steps;
const isScout = (step) => String(step.uses ?? '').startsWith(SCOUT_ACTION);
const isSeed = (step) => String(step.run ?? '').includes('seed-scout-scanner');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The rows of the pins file, as commit -> [release, sha256]; a malformed or repeated row fails here. */
function pinRows() {
  const rows = new Map();
  for (const line of readFileSync(PINS, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const match = PIN_ROW.exec(line);
    expect(match, `not '<commit> v<N.N.N> <sha256>': ${line}`).not.toBeNull();
    expect(rows.has(match[1]), `two rows for ${match[1]}`).toBe(false);
    rows.set(match[1], [match[2], match[3]]);
  }
  return rows;
}

// --- the workflow -----------------------------------------------------------------------------------------------

describe('addon-image-scout.yml fetches the scanner before it scans', () => {
  it('is the only workflow that runs Scout (one added elsewhere would have no fetch in front of it; bring it under this test)', () => {
    const others = readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name) && name !== 'addon-image-scout.yml');
    expect(others.length).toBeGreaterThan(20);
    for (const name of others) {
      const code = readFileSync(join(WORKFLOWS, name), 'utf8').split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join('\n');
      expect(code.includes(SCOUT_ACTION), `${name} runs docker/scout-action`).toBe(false);
    }
    const jobsWithScout = Object.entries(workflow.jobs).filter(([, job]) => job.steps.some(isScout)).map(([name]) => name);
    expect(jobsWithScout).toEqual(['scout']);
  });

  it('checks out, then fetches once, then scans', () => {
    const seeds = steps.flatMap((step, index) => (isSeed(step) ? [index] : []));
    const scouts = steps.flatMap((step, index) => (isScout(step) ? [index] : []));
    const checkout = steps.findIndex((step) => String(step.uses ?? '').startsWith('actions/checkout@'));
    expect(scouts.length).toBe(1);
    expect(seeds.length, 'one fetch in the job').toBe(1);
    expect(checkout, 'the script is a file of the repository, so the job checks out').not.toBe(-1);
    expect(checkout).toBeLessThan(seeds[0]);
    expect(seeds[0] + 1, 'the fetch is the step right before the scan').toBe(scouts[0]);
    expect(steps[checkout].with).toEqual({ 'persist-credentials': false });
  });

  it('runs the fetch under the same condition as the scan, with the job\'s own token and nothing else', () => {
    const seed = steps.find(isSeed);
    const scan = steps.find(isScout);
    expect(scan.if).toBe("steps.credential.outputs.set == 'true'");
    expect(seed.if).toBe(scan.if);
    // No argument: the pins file is the one in the repository, never one a step could point elsewhere.
    expect(seed.run).toBe(SEED_RUN);
    expect(seed.env).toEqual({ GH_TOKEN: '${{ github.token }}' });
    expect(Object.keys(seed).sort(), 'no continue-on-error, no other shell, no Docker token').toEqual(['env', 'if', 'name', 'run']);
    // `contents: read` is all the job holds; a public repository's release files need no more than a signed-in request.
    expect(workflow.jobs.scout.permissions).toEqual({ contents: 'read' });
  });

  it('lets nothing continue after an error, and keeps the scan a gate', () => {
    const code = source.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
    expect(code).not.toContain('continue-on-error');
    const scan = steps.find(isScout);
    expect(Object.keys(scan).sort()).toEqual(['if', 'name', 'uses', 'with']);
    expect(scan.with.command).toBe('quickview,cves');
    expect(scan.with['only-fixed']).toBe(true);
    expect(scan.with['only-severities']).toBe('critical,high');
    expect(scan.with['exit-code']).toBe(true);
    expect(scan.with.image).toBe('registry://${{ matrix.image }}');
  });

  it('starts a real scan on a pull request that changes the script or the pins', () => {
    const paths = workflow.on.pull_request.paths;
    expect(paths).toContain('scripts/lab/seed-scout-scanner.sh');
    expect(paths).toContain('scripts/lab/scout-scanner-pins.txt');
  });
});

describe('scout-scanner-pins.txt', () => {
  it('has a row for the commit of the action the workflow pins, with the release written beside it', () => {
    const used = [...source.matchAll(/uses:\s*docker\/scout-action@([0-9a-f]{40})\s+#\s*(v\d+\.\d+\.\d+)\s*$/gm)];
    expect(used.length, 'the Scout step is `uses: docker/scout-action@<40 hex> # v<N.N.N>`').toBe(1);
    const [, commit, version] = used[0];
    const rows = pinRows();
    expect(
      rows.has(commit),
      `docker/scout-action@${commit} (${version}) has no row in scripts/lab/scout-scanner-pins.txt. Add ` +
        `'<commit> <release> <sha256 of ${ASSET}>', with the sha256 GitHub shows beside the file at ` +
        `https://github.com/docker/scout-action/releases/tag/${version}; until then the scanner is not fetched ahead ` +
        'and a refused download fails the scan again (https://github.com/docker/scout-action/issues/116).'
    ).toBe(true);
    expect(rows.get(commit)[0]).toBe(version);
  });

  it('is read by the script from the folder the script is in', () => {
    const text = readFileSync(SCRIPT, 'utf8');
    expect(text).toContain('PINS="${1:-$HERE/scout-scanner-pins.txt}"');
    expect(text.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(text).toContain('set -euo pipefail');
    expect(text).not.toContain('\r');
  });
});

// --- the script, run for real -------------------------------------------------------------------------------------

const COMMIT = 'a'.repeat(40);
const VERSION = 'v9.8.7';
const GOOD = Buffer.from('the published scanner\n');
const BAD = Buffer.from('something else\n');

const GH_STUB = `#!/usr/bin/env bash
echo "gh $*" >> "$CALLS"
[ "\${GH_BEHAVIOUR}" = fail ] && { echo "HTTP 403: rate limit" >&2; exit 1; }
[ -n "\${GH_TOKEN:-}" ] || { echo "gh ran without a token" >&2; exit 4; }
out=""
while [ $# -gt 0 ]; do [ "$1" = --output ] && out="$2"; shift; done
cp "$GH_PAYLOAD" "$out"
`;

const CURL_STUB = `#!/usr/bin/env bash
echo "curl $*" >> "$CALLS"
[ "\${CURL_BEHAVIOUR}" = fail ] && { echo "curl: (22) The requested URL returned error: 403" >&2; exit 22; }
out=""
while [ $# -gt 0 ]; do [ "$1" = --output ] && out="$2"; shift; done
cp "$CURL_PAYLOAD" "$out"
`;

// The script fetches only on Linux x86_64 (the one file the pins record); elsewhere it warns and stops, by design.
const onLinuxAmd64 = process.platform === 'linux' && process.arch === 'x64';

describe.skipIf(!onLinuxAmd64)('seed-scout-scanner.sh installs only the published file', () => {
  /** A stand-in for the runner's folders: work/<repository> and work/_actions/docker/scout-action/<commit>. */
  let runner;

  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'seed-scout-'));
    const workspace = join(tmp, 'work', 'repository');
    const action = join(tmp, 'work', '_actions', 'docker', 'scout-action', COMMIT);
    const temp = join(tmp, 'runner-temp');
    const stubs = join(tmp, 'stubs');
    for (const dir of [workspace, action, temp, stubs]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(action, 'index.js'), `async function main() {\n\t    const version = "${VERSION}";\n}\n`);
    const pins = join(tmp, 'pins.txt');
    writeFileSync(pins, `# a comment\n${COMMIT} ${VERSION} ${sha256(GOOD)}\n`);
    const good = join(tmp, 'good');
    const bad = join(tmp, 'bad');
    writeFileSync(good, GOOD);
    writeFileSync(bad, BAD);
    const calls = join(tmp, 'calls');
    writeFileSync(calls, '');
    for (const [name, body] of [['gh', GH_STUB], ['curl', CURL_STUB]]) {
      writeFileSync(join(stubs, name), body);
      chmodSync(join(stubs, name), 0o755);
    }
    const env = {
      PATH: `${stubs}${delimiter}${process.env.PATH}`,
      RUNNER_WORKSPACE: workspace,
      RUNNER_TEMP: temp,
      SCOUT_SEED_PAUSE_SECONDS: '0',
      GH_TOKEN: 'stub',
      CALLS: calls,
      GH_BEHAVIOUR: 'ok',
      CURL_BEHAVIOUR: 'ok',
      GH_PAYLOAD: good,
      CURL_PAYLOAD: good,
    };
    runner = {
      tmp,
      action,
      pins,
      bad,
      calls,
      installed: join(action, 'dist', ASSET),
      /** Run the script; an override of `undefined` removes that variable. */
      run(overrides = {}) {
        const merged = { ...env, ...overrides };
        for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
        const result = spawnSync('bash', [SCRIPT, pins], { env: merged, encoding: 'utf8', timeout: 60_000 });
        return { status: result.status, out: `${result.stdout}`, all: `${result.stdout}${result.stderr}` };
      },
      called: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean).map((line) => line.split(' ')[0]),
      nothingLeftBehind: () => readdirSync(temp).length === 0,
    };
  });

  afterEach(() => rmSync(runner.tmp, { recursive: true, force: true }));

  it('installs the file fetched with the token where the action looks', () => {
    const result = runner.run();
    expect(result.status, result.all).toBe(0);
    expect(readFileSync(runner.installed).equals(GOOD)).toBe(true);
    expect(statSync(runner.installed).mode & 0o100).toBeTruthy();
    expect(runner.called(), 'the public link is not needed when the token worked').toEqual(['gh']);
    expect(readFileSync(runner.calls, 'utf8')).toContain(`release download ${VERSION} --repo docker/scout-action --pattern ${ASSET}`);
    expect(result.out).not.toContain('::warning');
    expect(result.out).not.toContain('::error');
    expect(result.out).toContain("with this job's token (attempt 1)");
    expect(result.out).toContain("'Using bundled binary'");
    expect(runner.nothingLeftBehind()).toBe(true);
  });

  it('uses the public link when the token route is refused', () => {
    const result = runner.run({ GH_BEHAVIOUR: 'fail' });
    expect(result.status, result.all).toBe(0);
    expect(readFileSync(runner.installed).equals(GOOD)).toBe(true);
    expect(runner.called()).toEqual(['gh', 'curl']);
    expect(readFileSync(runner.calls, 'utf8')).toContain(`https://github.com/docker/scout-action/releases/download/${VERSION}/${ASSET}`);
  });

  it('tries only the public link without a token', () => {
    const result = runner.run({ GH_TOKEN: undefined });
    expect(result.status, result.all).toBe(0);
    expect(readFileSync(runner.installed).equals(GOOD)).toBe(true);
    expect(runner.called()).toEqual(['curl']);
  });

  it('only warns when the file cannot be fetched, and leaves the action to download', () => {
    const result = runner.run({ GH_BEHAVIOUR: 'fail', CURL_BEHAVIOUR: 'fail' });
    expect(result.status, 'the Scout step decides: it downloads itself, and fails the job if it cannot').toBe(0);
    expect(result.out).toContain('::warning');
    expect(result.out).toContain('the job fails without scanning');
    expect(existsSync(runner.installed)).toBe(false);
    expect(existsSync(join(runner.action, 'dist'))).toBe(false);
    expect(runner.called(), 'three attempts, both routes each').toEqual(['gh', 'curl', 'gh', 'curl', 'gh', 'curl']);
    expect(runner.nothingLeftBehind()).toBe(true);
  });

  it.each(['gh', 'curl'])('stops the job on a file with the wrong sha256 from %s, and never installs it', (route) => {
    const overrides = route === 'gh' ? { GH_PAYLOAD: runner.bad } : { GH_BEHAVIOUR: 'fail', CURL_PAYLOAD: runner.bad };
    const result = runner.run(overrides);
    expect(result.status).toBe(1);
    expect(result.out).toContain('::error::');
    expect(result.out).toContain(sha256(BAD));
    expect(existsSync(runner.installed)).toBe(false);
    expect(runner.nothingLeftBehind()).toBe(true);
  });

  it('checks a file already in place and does not fetch it again', () => {
    expect(runner.run().status).toBe(0);
    writeFileSync(runner.calls, '');
    const result = runner.run();
    expect(result.status).toBe(0);
    expect(result.out).toContain('already in place');
    expect(runner.called()).toEqual([]);
  });

  it('stops the job on a wrong file already in place, and leaves it as found', () => {
    mkdirSync(dirname(runner.installed));
    writeFileSync(runner.installed, BAD);
    const result = runner.run();
    expect(result.status).toBe(1);
    expect(result.out).toContain('::error::');
    expect(runner.called()).toEqual([]);
    expect(readFileSync(runner.installed).equals(BAD)).toBe(true);
  });

  it('warns and installs nothing for a commit without a row', () => {
    writeFileSync(runner.pins, `${'b'.repeat(40)} ${VERSION} ${sha256(GOOD)}\n`);
    const result = runner.run();
    expect(result.status).toBe(0);
    expect(result.out).toContain('::warning');
    expect(result.out).toContain('has no row');
    expect(existsSync(runner.installed)).toBe(false);
    expect(runner.called()).toEqual([]);
  });

  it('warns and installs nothing when the action asks for another release than the row says', () => {
    // The action downloads the release its own code names; a file of any other release must not stand in.
    writeFileSync(join(runner.action, 'index.js'), '    const version = "v9.8.6";\n');
    const result = runner.run();
    expect(result.status).toBe(0);
    expect(result.out).toContain('::warning');
    expect(result.out).toContain('does not ask for release');
    expect(existsSync(runner.installed)).toBe(false);
    expect(runner.called()).toEqual([]);
  });

  it('stops on a malformed row', () => {
    writeFileSync(runner.pins, `${COMMIT} ${VERSION} not-a-sha256\n`);
    const result = runner.run();
    expect(result.status).toBe(1);
    expect(existsSync(runner.installed)).toBe(false);
  });

  it('only warns on a runner without the actions folder', () => {
    const result = runner.run({ RUNNER_WORKSPACE: join(runner.tmp, 'elsewhere', 'repository') });
    expect(result.status).toBe(0);
    expect(result.out).toContain('::warning');
    expect(runner.called()).toEqual([]);
  });

  it('stops when the pins file is missing', () => {
    rmSync(runner.pins);
    const result = runner.run();
    expect(result.status).toBe(1);
    expect(result.out).toContain('::error::');
  });
});
