/**
 * lab-host/bootstrap.sh runs one at a time (#1069).
 *
 * The firewall rebuild installs its reject before it removes the old rules,
 * so one interrupted run stays restrictive, but two runs interleaved across
 * that sequence are not. The script takes a lock on fd 9 straight after its
 * root check, the handover to a newer bootstrap.sh inherits it, and the play
 * runs without the descriptor so nothing it leaves running can hold it.
 *
 * Two layers, as in lab-host-bootstrap-origin.test.mjs: the block's shape,
 * read from the script, on every platform; and the block itself, cut out and
 * run with bash and flock where both exist (CI's Linux runner, not Git Bash).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = readFileSync(join(REPO, 'lab-host', 'bootstrap.sh'), 'utf8');

/** From the line that starts `start` to the first line after it that is exactly `end`. */
function cut(text, start, end) {
  const from = text.indexOf(start);
  if (from < 0) throw new Error(`bootstrap.sh no longer contains ${JSON.stringify(start)}`);
  const lines = text.slice(from).split('\n');
  const last = lines.findIndex((line, i) => i > 0 && line === end);
  if (last < 0) throw new Error(`no ${JSON.stringify(end)} after ${JSON.stringify(start)}`);
  return lines.slice(0, last + 1).join('\n');
}

const LOCK_BLOCK = cut(SCRIPT, 'HCW_BOOTSTRAP_LOCK=/run/lock/hcw-bootstrap.lock', 'fi');

describe('the lock in bootstrap.sh', () => {
  it('is taken after the root check and before anything is fetched or installed', () => {
    const rootCheck = SCRIPT.indexOf('bootstrap.sh must run as root');
    const lock = SCRIPT.indexOf('exec 9>"${HCW_BOOTSTRAP_LOCK}"');
    expect(rootCheck).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(rootCheck);
    for (const later of ['log "installing prerequisites"', 'git clone --quiet', 'fetch --quiet origin']) {
      expect(SCRIPT.indexOf(later), later).toBeGreaterThan(lock);
    }
  });

  it('is not taken again by the handed-over pass, which inherits fd 9 through exec', () => {
    expect(LOCK_BLOCK).toMatch(/^if \[ -z "\$\{HCW_BOOTSTRAP_HANDED_OVER:-\}" \]; then$/m);
    expect(SCRIPT).toMatch(/HCW_BOOTSTRAP_HANDED_OVER=1 HCW_REPO_REF="\$\{hcw_repo_sha\}" exec bash /);
  });

  it('waits a bounded time, then refuses having changed nothing', () => {
    expect(LOCK_BLOCK).toContain('flock -n 9');
    expect(LOCK_BLOCK).toContain('flock -w "${HCW_BOOTSTRAP_LOCK_WAIT_SECONDS}" 9');
    expect(LOCK_BLOCK).toContain('nothing has been changed');
    expect(SCRIPT).toMatch(/^HCW_BOOTSTRAP_LOCK_WAIT_SECONDS="\$\{HCW_BOOTSTRAP_LOCK_WAIT_SECONDS:-1800\}"$/m);
  });

  it('keeps the lock’s descriptor out of the play', () => {
    expect(SCRIPT).toMatch(/ansible-playbook" -i inventory\/localhost\.yml site\.yml "\$\{extra_args\[@\]\}" "\$@" 9>&-$/m);
  });
});

const run = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', ...options });
// On Windows only a Git Bash (MSYSTEM set) is the bash this script is written
// for; System32's bash is WSL, which cannot see these paths.
const bashUsable =
  (process.platform !== 'win32' || Boolean(process.env.MSYSTEM)) && run('bash', ['-c', 'true']).status === 0;
const flockUsable = bashUsable && run('bash', ['-c', 'command -v flock']).status === 0;

describe.skipIf(!flockUsable)('the lock block, run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hcw-bootstrap-lock-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // The block, pointed at a throwaway lock file, after the script's own log().
  const block = LOCK_BLOCK.replace('/run/lock/hcw-bootstrap.lock', join(dir, 'bootstrap.lock').replaceAll('\\', '/'));
  const prelude = `set -euo pipefail\nlog() { printf '[bootstrap] %s\\n' "$*"; }\n`;
  const pass = (name, body) => {
    const path = join(dir, `${name}.sh`);
    writeFileSync(path, `${prelude}${block}\n${body}\n`);
    return path;
  };
  const holder = pass('holder', 'echo held; sleep 3; echo released');
  const contender = pass('contender', 'echo contender-ran');

  /** Start the holder, give it a moment to lock, then run the contender with this environment. */
  const race = (env) => {
    const harness = join(dir, 'race.sh');
    writeFileSync(
      harness,
      [
        `bash '${holder}' &`,
        'sleep 0.5',
        `env ${env} bash '${contender}'; echo "contender exit=$?"`,
        'wait',
      ].join('\n')
    );
    return run('bash', [harness], { timeout: 20000 });
  };

  it('makes a second run wait for the first, then proceed', () => {
    const { stdout } = race('HCW_BOOTSTRAP_LOCK_WAIT_SECONDS=10');
    expect(stdout).toContain('waiting up to 10 s for it to finish');
    expect(stdout.indexOf('contender-ran')).toBeGreaterThan(stdout.indexOf('released'));
    expect(stdout).toContain('contender exit=0');
  });

  it('refuses a second run that waited its limit out, before doing anything', () => {
    const { stdout, stderr } = race('HCW_BOOTSTRAP_LOCK_WAIT_SECONDS=1');
    expect(stderr).toContain('refusing to run: another bootstrap.sh run still holds');
    expect(stdout).not.toContain('contender-ran');
    expect(stdout).toContain('contender exit=1');
  });

  it('lets the handed-over pass through without taking the lock again', () => {
    const { stdout } = race('HCW_BOOTSTRAP_HANDED_OVER=1 HCW_BOOTSTRAP_LOCK_WAIT_SECONDS=1');
    expect(stdout.indexOf('contender-ran')).toBeLessThan(stdout.indexOf('released'));
    expect(stdout).toContain('contender exit=0');
  });
});
