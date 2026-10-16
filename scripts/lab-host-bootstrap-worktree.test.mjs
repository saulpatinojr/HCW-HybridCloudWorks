/**
 * lab-host/bootstrap.sh runs check mode from a temporary git worktree (LAB-4, #950).
 *
 * In check mode (`--check` / `-C`), bootstrap.sh must not move or detach the host's
 * applied checkout at HCW_SRC_DIR. Instead, it creates a temporary detached worktree
 * at HCW_REPO_REF, executes the playbook check from that worktree, cleans up the
 * worktree on exit, and leaves HCW_SRC_DIR untouched.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = readFileSync(join(REPO, 'lab-host', 'bootstrap.sh'), 'utf8');

describe('bootstrap.sh worktree check mode', () => {
  it('parses --check and -C early before fetching and checking out', () => {
    const parse = SCRIPT.indexOf('--check | -C) hcw_check_mode=1 ;;');
    const fetch = SCRIPT.indexOf('git -C "${HCW_SRC_DIR}" fetch --quiet origin');
    const checkout = SCRIPT.indexOf('git -C "${HCW_SRC_DIR}" checkout --quiet --detach "${hcw_repo_sha}"');
    expect(parse).toBeGreaterThan(-1);
    expect(fetch).toBeGreaterThan(parse);
    expect(checkout).toBeGreaterThan(parse);
  });

  it('creates a temporary worktree in check mode and preserves the applied checkout', () => {
    expect(SCRIPT).toContain('git -C "${HCW_SRC_DIR}" worktree add --quiet --detach "${hcw_worktree_dir}" "${hcw_repo_sha}"');
    expect(SCRIPT).toContain('hcw_effective_src="${hcw_worktree_dir}"');
    expect(SCRIPT).toContain('cd "${hcw_effective_src}/lab-host/ansible"');
  });

  it('cleans up the temporary worktree via EXIT trap', () => {
    expect(SCRIPT).toContain('git -C "${HCW_SRC_DIR}" worktree remove --force "${hcw_worktree_dir}"');
    expect(SCRIPT).toContain('trap hcw_cleanup EXIT');
  });

  it('skips handover in check mode', () => {
    expect(SCRIPT).toContain('log "check mode: skipping handover to checked-out bootstrap.sh"');
  });

  it('does not write the completed run marker in check mode', () => {
    expect(SCRIPT).toContain('if [ -z "${hcw_check_mode}" ] && [ -z "${hcw_partial}" ]; then');
  });
});

const run = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', ...options });
const gitAvailable = run('git', ['--version']).status === 0;

describe.skipIf(!gitAvailable)('the worktree execution logic', () => {
  let root, srcDir;
  const author = ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid'];

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'hcw-worktree-test-'));
    srcDir = join(root, 'repo');
    run('git', ['init', '--quiet', '--initial-branch=main', srcDir]);
    writeFileSync(join(srcDir, 'README.md'), 'commit 1\n');
    run('git', ['-C', srcDir, ...author, 'add', 'README.md']);
    run('git', ['-C', srcDir, ...author, 'commit', '--quiet', '-m', 'one']);

    writeFileSync(join(srcDir, 'README.md'), 'commit 2\n');
    run('git', ['-C', srcDir, ...author, 'add', 'README.md']);
    run('git', ['-C', srcDir, ...author, 'commit', '--quiet', '-m', 'two']);

    // Leave srcDir at commit 1
    run('git', ['-C', srcDir, 'checkout', '--quiet', 'HEAD~1']);
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('creates worktree at commit 2 without moving srcDir', () => {
    const headBefore = run('git', ['-C', srcDir, 'rev-parse', 'HEAD']).stdout.trim();
    const commit2 = run('git', ['-C', srcDir, 'rev-parse', 'main']).stdout.trim();
    expect(headBefore).not.toBe(commit2);

    const worktreeDir = join(root, 'wt');
    const addRes = run('git', ['-C', srcDir, 'worktree', 'add', '--quiet', '--detach', worktreeDir, commit2]);
    expect(addRes.status).toBe(0);

    const headAfter = run('git', ['-C', srcDir, 'rev-parse', 'HEAD']).stdout.trim();
    expect(headAfter).toBe(headBefore);

    const wtHead = run('git', ['-C', worktreeDir, 'rev-parse', 'HEAD']).stdout.trim();
    expect(wtHead).toBe(commit2);

    // Clean up
    run('git', ['-C', srcDir, 'worktree', 'remove', '--force', worktreeDir]);
  });
});
