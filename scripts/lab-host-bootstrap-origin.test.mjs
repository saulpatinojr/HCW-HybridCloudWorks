/**
 * lab-host/bootstrap.sh repoints an existing checkout to HCW_REPO_URL (#1009).
 *
 * The repository moved from the HybridCloudWorks organisation to saulpatinojr
 * on 2026-10-07. The host's /opt/hcw-src was cloned from the old address, and
 * the script fetched `origin` as it found it, so changing HCW_REPO_URL alone
 * never repointed the checkout, while its log line printed the new URL as if
 * it had. The old address answered only through GitHub's redirect.
 *
 * Two layers: the block's shape, read from the script, which holds on every
 * platform; and the block itself, cut out of the script and run with bash and
 * git against two throwaway repositories, where both are available.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

const CHECKOUT_BLOCK = cut(SCRIPT, 'if [ -d "${HCW_SRC_DIR}/.git" ]; then', 'fi');
const NORMALISE = cut(SCRIPT, 'normalise_url() {', '}');

describe('the checkout block in bootstrap.sh', () => {
  it('defaults HCW_REPO_URL to the repository\'s current owner', () => {
    expect(SCRIPT).toMatch(
      /^HCW_REPO_URL="\$\{HCW_REPO_URL:-https:\/\/github\.com\/saulpatinojr\/HCW-HybridCloudWorks\.git\}"$/m
    );
  });

  it('sets origin to HCW_REPO_URL before it fetches, when the two differ', () => {
    const setUrl = CHECKOUT_BLOCK.indexOf('remote set-url origin "${HCW_REPO_URL}"');
    const fetch = CHECKOUT_BLOCK.indexOf('fetch --quiet origin');
    expect(setUrl).toBeGreaterThan(-1);
    expect(fetch).toBeGreaterThan(setUrl);
    expect(CHECKOUT_BLOCK).toMatch(/normalise_url "\$\{hcw_current_origin\}"\)" != "\$\(normalise_url "\$\{HCW_REPO_URL\}"\)"/);
  });

  it('logs the origin the fetch really uses, not the URL it was asked for', () => {
    expect(CHECKOUT_BLOCK).toContain('log "fetching $(git -C "${HCW_SRC_DIR}" remote get-url origin)"');
    expect(CHECKOUT_BLOCK).not.toContain('log "fetching ${HCW_REPO_URL}"');
  });
});

const run = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', ...options });
// On Windows only a Git Bash (MSYSTEM set) is the bash this script is written
// for; System32's bash is WSL, which cannot see these paths.
const shellReady =
  (process.platform !== 'win32' || Boolean(process.env.MSYSTEM)) &&
  run('bash', ['--version']).status === 0 &&
  run('git', ['--version']).status === 0;

// Each case spawns git (clone, remote, fetch) and bash several times. The
// 5 s default was exceeded once on a loaded Windows machine (2026-10-08),
// where every spawn is slow; 30 s still fails a real hang well within CI.
describe.skipIf(!shellReady)('the checkout block, run', { timeout: 30_000 }, () => {
  // Made in beforeAll, not in this body. Vitest runs a skipped suite's body to
  // collect its tests but never its hooks, so a directory and a repository made
  // here were left behind on every run that skips.
  let root, upstream;
  const slash = (path) => path.replace(/\\/g, '/');
  const git = (cwd, ...args) => {
    const result = run('git', ['-C', cwd, ...args]);
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const author = ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid'];

  // A repository at its new address, with one commit.
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'hcw-bootstrap-origin-'));
    upstream = join(root, 'upstream');
    run('git', ['init', '--quiet', '--initial-branch=main', upstream]);
    writeFileSync(join(upstream, 'README.md'), 'lab\n');
    git(upstream, 'add', 'README.md');
    git(upstream, ...author, 'commit', '--quiet', '-m', 'one');
  });
  afterAll(() => root && rmSync(root, { recursive: true, force: true }));

  /** A checkout cloned from the new address, then given `origin` as its remote. */
  function checkoutWithOrigin(name, origin) {
    const dir = join(root, name);
    run('git', ['clone', '--quiet', slash(upstream), dir]);
    git(dir, 'remote', 'set-url', 'origin', origin);
    return dir;
  }

  function runBlock(srcDir, repoUrl) {
    const script = [
      'set -euo pipefail',
      'log() { printf "[bootstrap] %s\\n" "$*"; }',
      NORMALISE,
      `HCW_SRC_DIR='${slash(srcDir)}'`,
      `HCW_REPO_URL='${repoUrl}'`,
      CHECKOUT_BLOCK,
    ].join('\n');
    const file = join(root, `${Math.random().toString(36).slice(2)}.sh`);
    writeFileSync(file, `${script}\n`);
    return run('bash', [slash(file)]);
  }

  it('repoints a checkout cloned from the old owner, says so, and fetches from the new one', () => {
    const newUrl = slash(upstream);
    const dir = checkoutWithOrigin('moved', 'https://github.invalid/old-owner/HCW-HybridCloudWorks.git');
    const result = runBlock(dir, newUrl);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      `[bootstrap] repointing origin of ${slash(dir)} from https://github.invalid/old-owner/HCW-HybridCloudWorks.git to ${newUrl}`
    );
    expect(result.stdout).toContain(`[bootstrap] fetching ${newUrl}`);
    expect(git(dir, 'remote', 'get-url', 'origin')).toBe(newUrl);
  });

  it('leaves an origin alone that is HCW_REPO_URL spelled with or without .git', () => {
    const dir = checkoutWithOrigin('current', `${slash(upstream)}.git`);
    const result = runBlock(dir, slash(upstream));
    // The fetch itself fails (no such path with .git), which is not this
    // test's subject: only that nothing was repointed and the log named it.
    expect(result.stdout).not.toContain('repointing origin');
    expect(result.stdout).toContain(`[bootstrap] fetching ${slash(upstream)}.git`);
    expect(git(dir, 'remote', 'get-url', 'origin')).toBe(`${slash(upstream)}.git`);
  });
});
