/**
 * The root MEMORY.md handoff note is allowed, scanned and kept off the site (#1450).
 *
 * The owner asked for one dated note at the repository root to continue work while
 * travelling. The repository is public and its root is policed, so three things have
 * to hold or the note either fails CI or leaks something:
 *
 *  1. The structure check lists MEMORY.md among the files allowed at the root (and
 *     guards its upper-case spelling, like TODO.md and CHANGELOG.md).
 *  2. The redaction gate (scripts/docs/check_redaction.py) scans it when it is there:
 *     a tenant, subscription or application id, a local file path or a link back to
 *     the retired wiki in it fails the docs workflow. It is scanned when present and
 *     never required, so replacing or deleting the note cannot stop the site building.
 *  3. The docs workflow runs when the note changes (so the gate in 2 actually runs),
 *     and the site hook does not pull the note into the published site.
 *
 * The gate itself is run on small fixture folders made in the temporary directory.
 * Needs Python on the path; where it is missing the gate tests are skipped locally,
 * and on GitHub Actions a missing Python fails the first test instead.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(join(REPO, relative), 'utf8').replace(/\r\n/g, '\n');
const GATE = join(REPO, 'scripts', 'docs', 'check_redaction.py');

function findPython() {
  for (const name of ['python3', 'python']) {
    const probe = spawnSync(name, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0 && probe.stdout.trim() === '3') return name;
  }
  return null;
}
const PYTHON = findPython();

describe('the structure check allows the handoff note at the root', () => {
  const script = read('scripts/validate-repository-structure.ps1');

  it('lists MEMORY.md among the allowed root files', () => {
    const block = script.match(/\$allowedRootFiles = @\(([\s\S]*?)\n\)/);
    expect(block, 'could not find the $allowedRootFiles list').not.toBeNull();
    expect(block[1]).toContain("'MEMORY.md'");
  });

  it('keeps the three files that are maintained and does not bring back the ones it rejects', () => {
    const block = script.match(/\$allowedRootFiles = @\(([\s\S]*?)\n\)/)[1];
    for (const kept of ["'README.md'", "'CHANGELOG.md'", "'TODO.md'"]) expect(block).toContain(kept);
    for (const rejected of ["'REVIEW.md'", "'CHECKLIST.md'", "'Variables.md'", "'Architecture_Plan.md'", "'Migration_Plan.md'"]) {
      expect(block).not.toContain(rejected);
    }
  });

  it('guards the upper-case spelling of MEMORY.md', () => {
    const line = script.split('\n').find((l) => l.startsWith('$casingSensitiveNames'));
    expect(line, 'could not find $casingSensitiveNames').toBeDefined();
    expect(line).toContain("'MEMORY.md'");
  });
});

describe('the docs workflow runs for the note and the site does not publish it', () => {
  const workflow = read('.github/workflows/docs-pages.yml');

  it.each(['pull_request', 'push'])('runs on %s when MEMORY.md changes', (event) => {
    const start = workflow.indexOf(`\n  ${event}:`);
    expect(start, `no ${event} trigger found`).toBeGreaterThan(-1);
    const next = workflow.slice(start + 1).search(/\n {2}[a-z_]+:/);
    const section = workflow.slice(start, next === -1 ? undefined : start + 1 + next);
    expect(section).toContain("- 'MEMORY.md'");
  });

  it('runs the redaction gate before the site is built', () => {
    const gate = workflow.indexOf('run: python scripts/docs/check_redaction.py');
    const build = workflow.indexOf('run: mkdocs build');
    expect(gate, 'the redaction gate step was not found').toBeGreaterThan(-1);
    expect(build, 'the mkdocs build step was not found').toBeGreaterThan(-1);
    expect(gate).toBeLessThan(build);
  });

  it('does not pull MEMORY.md into the published site', () => {
    expect(read('scripts/docs/hooks.py')).not.toContain('MEMORY.md');
  });
});

describe('the redaction gate scans the note when it is there', () => {
  const made = [];
  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
  });

  /** A small repository: the files the gate requires, clean, plus whatever the test adds. */
  function fixture(extra = {}) {
    const root = mkdtempSync(join(tmpdir(), 'memory-gate-'));
    made.push(root);
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'index.md'), '# Docs\n');
    for (const name of ['README.md', 'CHANGELOG.md', 'TODO.md']) writeFileSync(join(root, name), `# ${name}\n`);
    for (const [name, text] of Object.entries(extra)) writeFileSync(join(root, name), text);
    return root;
  }
  const run = (root) => spawnSync(PYTHON, [GATE, root], { encoding: 'utf8' });

  it.skipIf(process.env.GITHUB_ACTIONS !== 'true')('on GitHub Actions Python 3 is present, so the gate tests below run', () => {
    expect(PYTHON, 'python3 or python was not found on the path').not.toBeNull();
  });

  it.skipIf(!PYTHON)('passes a clean note', () => {
    const result = run(fixture({ 'MEMORY.md': '# Memory\n\nSee https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1450\n' }));
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it.skipIf(!PYTHON)('passes a placeholder identifier', () => {
    const result = run(fixture({ 'MEMORY.md': '# Memory\n\nTenant 00000000-0000-0000-0000-000000000001\n' }));
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it.skipIf(!PYTHON)('fails a real-looking identifier, naming MEMORY.md and the line', () => {
    const result = run(fixture({ 'MEMORY.md': '# Memory\n\nTenant 12345678-1234-1234-1234-123456789abc\n' }));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('MEMORY.md:3: non-placeholder GUID 12345678-1234-1234-1234-123456789abc');
  });

  it.skipIf(!PYTHON)('fails a local file path, naming MEMORY.md and the line', () => {
    const result = run(fixture({ 'MEMORY.md': '# Memory\n\nOpen C:\\Users\\someone\\Workspace\\repo\n' }));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('MEMORY.md:3: contributor-local filesystem path');
  });

  it.skipIf(!PYTHON)('fails a link back to the retired GitHub Wiki', () => {
    // Built from parts so that this file is not itself a live pointer for scripts/no-wiki-pointers.test.mjs.
    const retired = ['wi', 'ki'].join('');
    const result = run(fixture({ 'MEMORY.md': `# Memory\n\nhttps://github.com/saulpatinojr/HCW-HybridCloudWorks/${retired}/Home\n` }));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('MEMORY.md:3: link to the retired GitHub Wiki');
  });

  it.skipIf(!PYTHON)('does not need the note: with no MEMORY.md the gate still passes', () => {
    const result = run(fixture());
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it.skipIf(!PYTHON)('still requires README, CHANGELOG and TODO (exit 2, cannot evaluate)', () => {
    const root = fixture({ 'MEMORY.md': '# Memory\n' });
    rmSync(join(root, 'TODO.md'));
    const result = run(root);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('missing');
  });
});
