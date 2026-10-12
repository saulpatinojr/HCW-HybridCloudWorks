/**
 * lab-host/bootstrap.sh runs one at a time (#1069).
 *
 * The firewall rebuild installs its reject before it removes the old rules,
 * so one interrupted run stays restrictive, but two runs interleaved across
 * that sequence are not. The script takes a lock on fd 9 straight after its
 * root check. Every pass proves it holds the lock, so no environment marker
 * can let one skip it (CodeRabbit, #1099). A pass handed over by exec keeps
 * the open file description that holds it, and the play inherits it too, so
 * the lock lasts until every mutator has ended.
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

/** The text from `start` up to, not including, the line that begins with `next`. */
function between(text, start, next) {
  const from = text.indexOf(start);
  if (from < 0) throw new Error(`bootstrap.sh no longer contains ${JSON.stringify(start)}`);
  const to = text.indexOf(`\n${next}`, from);
  if (to < 0) throw new Error(`no line starting ${JSON.stringify(next)} after ${JSON.stringify(start)}`);
  return text.slice(from, to + 1);
}

const LOCK_BLOCK = between(SCRIPT, 'HCW_BOOTSTRAP_LOCK=/run/hcw-bootstrap.lock', '# 26.04 LTS is the target');
const PLAY_LINE = SCRIPT.split('\n').find((line) => line.startsWith('"${UV_TOOL_BIN_DIR}/ansible-playbook" -i '));

describe('the lock in bootstrap.sh', () => {
  it('is taken after the root check and before anything is fetched or installed', () => {
    const rootCheck = SCRIPT.indexOf('bootstrap.sh must run as root');
    const lock = SCRIPT.indexOf('if ! flock -n 9; then');
    expect(rootCheck).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(rootCheck);
    for (const later of ['log "installing prerequisites"', 'git clone --quiet', 'fetch --quiet origin']) {
      expect(SCRIPT.indexOf(later), later).toBeGreaterThan(lock);
    }
  });

  it('is taken by every pass, with no marker that lets one skip it (#1099)', () => {
    expect(LOCK_BLOCK).not.toContain('HCW_BOOTSTRAP_HANDED_OVER');
    // An inherited fd 9 is reused only when it is the lock file itself.
    expect(LOCK_BLOCK).toContain('stat -c \'%d:%i\' "${HCW_BOOTSTRAP_LOCK}"');
    expect(LOCK_BLOCK).toContain('stat -L -c \'%d:%i\' "/proc/$$/fd/9"');
    // flock runs outside that test, so a reused descriptor is still checked.
    expect(LOCK_BLOCK).toMatch(/^fi\nif ! flock -n 9; then$/m);
    expect(SCRIPT).toMatch(/HCW_BOOTSTRAP_HANDED_OVER=1 HCW_REPO_REF="\$\{hcw_repo_sha\}" exec bash /);
  });

  it('waits a bounded time, then refuses having changed nothing, naming how to find the holder', () => {
    expect(LOCK_BLOCK).toContain('flock -w "${HCW_BOOTSTRAP_LOCK_WAIT_SECONDS}" 9');
    expect(LOCK_BLOCK).toContain('nothing has been changed');
    expect(LOCK_BLOCK).toContain('sudo fuser -v ${HCW_BOOTSTRAP_LOCK}');
    expect(SCRIPT).toMatch(/^HCW_BOOTSTRAP_LOCK_WAIT_SECONDS="\$\{HCW_BOOTSTRAP_LOCK_WAIT_SECONDS:-1800\}"$/m);
  });

  it('keeps the lock where only root can create it, opens it without truncating, and refuses a symlink (#1099)', () => {
    expect(SCRIPT).toMatch(/^HCW_BOOTSTRAP_LOCK=\/run\/hcw-bootstrap\.lock$/m);
    expect(LOCK_BLOCK).toContain('exec 9<>"${HCW_BOOTSTRAP_LOCK}"');
    expect(LOCK_BLOCK).not.toMatch(/exec 9>"/);
    expect(LOCK_BLOCK).toContain('[ -L "${HCW_BOOTSTRAP_LOCK}" ]');
    expect(LOCK_BLOCK).toContain('is not a regular file; nothing has been changed');
  });

  it('takes the wait as a whole number of seconds and refuses anything else', () => {
    expect(LOCK_BLOCK).toContain('[[ "${HCW_BOOTSTRAP_LOCK_WAIT_SECONDS}" =~ ^[0-9]+$ ]]');
  });

  it('lets the play inherit the lock, so it holds until every mutator has ended (#1099)', () => {
    expect(PLAY_LINE).toBeDefined();
    expect(PLAY_LINE).not.toMatch(/9>&-/);
  });
});

const run = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', ...options });
// On Windows only a Git Bash (MSYSTEM set) is the bash this script is written
// for; System32's bash is WSL, which cannot see these paths. /proc and flock
// are Linux, so the run layer is CI's.
const bashUsable =
  (process.platform !== 'win32' || Boolean(process.env.MSYSTEM)) && run('bash', ['-c', 'true']).status === 0;
const lockUsable = bashUsable && run('bash', ['-c', 'command -v flock && test -d /proc/self/fd']).status === 0;

describe.skipIf(!lockUsable)('the lock block, run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hcw-bootstrap-lock-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // The block, pointed at a throwaway lock file, after the script's own log().
  const lockPath = join(dir, 'bootstrap.lock');
  const block = LOCK_BLOCK.replaceAll('/run/hcw-bootstrap.lock', lockPath);
  const prelude = `set -euo pipefail\nlog() { printf '[bootstrap] %s\\n' "$*"; }\n`;
  const pass = (name, body) => {
    const path = join(dir, `${name}.sh`);
    writeFileSync(path, `${prelude}${block}${body}\n`);
    return path;
  };
  const holder = pass('holder', 'echo held; sleep 3; echo released');
  const contender = pass('contender', 'echo contender-ran');
  // A first pass that takes the lock, then hands over by exec, as bootstrap.sh does.
  const second = pass('second', 'echo second-pass-ran; sleep 3; echo second-pass-done');
  const first = pass('first', `echo first-locked; HCW_BOOTSTRAP_HANDED_OVER=1 exec bash '${second}'`);

  /** Start `lead` in the background, give it a moment to lock, then run the contender with this environment. */
  const race = (env, lead = holder) => {
    const harness = join(dir, 'race.sh');
    writeFileSync(
      harness,
      [`bash '${lead}' &`, 'sleep 0.5', `env ${env} bash '${contender}'; echo "contender exit=$?"`, 'wait'].join(
        '\n'
      )
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
    expect(stderr).toContain('sudo fuser -v');
    expect(stdout).not.toContain('contender-ran');
    expect(stdout).toContain('contender exit=1');
  });

  it('does not let a hand-set HCW_BOOTSTRAP_HANDED_OVER skip the lock (#1099)', () => {
    const { stdout } = race('HCW_BOOTSTRAP_HANDED_OVER=1 HCW_BOOTSTRAP_LOCK_WAIT_SECONDS=1');
    expect(stdout).not.toContain('contender-ran');
    expect(stdout).toContain('contender exit=1');
  });

  it('holds the lock in the play when the script itself is killed mid-run (#1099)', () => {
    // The script dies outright while a child it started (the play) still runs
    // with fd 9. A competing run must wait for the child, not for the script.
    const dying = pass(
      'dying',
      ['( sleep 3; echo child-done ) &', 'echo parent-dying', 'kill -KILL $$'].join('\n')
    );
    const { stdout } = race('HCW_BOOTSTRAP_LOCK_WAIT_SECONDS=10', dying);
    expect(stdout).toContain('parent-dying');
    expect(stdout).toContain('waiting up to 10 s for it to finish');
    expect(stdout.indexOf('contender-ran')).toBeGreaterThan(stdout.indexOf('child-done'));
  });

  it('refuses a lock path that is a symlink, and a wait that is not whole seconds, before doing anything', () => {
    const target = join(dir, 'elsewhere');
    writeFileSync(target, 'keep me\n');
    const symlinked = run('bash', ['-c', `rm -f '${lockPath}' && ln -s '${target}' '${lockPath}' && bash '${contender}'`]);
    expect(symlinked.status).toBe(1);
    expect(symlinked.stderr).toContain('is not a regular file');
    expect(readFileSync(target, 'utf8')).toBe('keep me\n');
    run('bash', ['-c', `rm -f '${lockPath}'`]);

    for (const wait of ['1.5', '10s', '-1', '']) {
      const bad = run('bash', ['-c', `HCW_BOOTSTRAP_LOCK_WAIT_SECONDS='${wait}' bash '${contender}'`]);
      if (wait === '') {
        // Empty is unset in effect: the default applies and the run proceeds.
        expect(bad.stdout, 'empty').toContain('contender-ran');
      } else {
        expect(bad.status, wait).toBe(1);
        expect(bad.stderr, wait).toContain('must be a whole number of seconds');
      }
    }
  });

  it('lets a pass handed over by exec run at once, still holding the lock against everyone else', () => {
    const { stdout } = race('HCW_BOOTSTRAP_LOCK_WAIT_SECONDS=10', first);
    // The handed-over pass did not wait for itself...
    expect(stdout.indexOf('second-pass-ran')).toBeGreaterThan(stdout.indexOf('first-locked'));
    expect(stdout.match(/waiting up to/g)).toHaveLength(1);
    // ...and the outsider, which did wait, ran only after the handed-over pass ended.
    expect(stdout.indexOf('contender-ran')).toBeGreaterThan(stdout.indexOf('second-pass-done'));
    expect(stdout).toContain('contender exit=0');
  });
});
