/**
 * addon-image-scout.yml (#1367): the tripwires for a workflow that holds one Docker credential. The credential is
 * the only one this repository stores for Scout, so the file is held to where it may be read, who may trigger a
 * run that sees it, and what the job may do with the token's reach. Comments are not searched: a header that
 * explains `pull_request_target` must not trip the test that forbids it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(REPO, '.github', 'workflows', 'addon-image-scout.yml'), 'utf8');
const code = source.split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join('\n');

/** One job's text, from its key to the next job's (or the end); the key must exist. */
const job = (name, next) => {
  const at = (key) => {
    const index = code.indexOf(`\n  ${key}:\n`);
    if (index === -1) throw new Error(`no job \`${key}\` in the workflow`);
    return index;
  };
  return next ? code.slice(at(name), at(next)) : code.slice(at(name));
};
const pins = job('pins', 'scout');
const scout = job('scout');

describe('addon-image-scout.yml', () => {
  it('holds no permission beyond reading the repository, at the top and in every job', () => {
    expect(code).toMatch(/^permissions: \{\}$/m);
    // Only the lines inside a `permissions:` block count: a step called `id: read` is not a grant.
    const blocks = [...code.matchAll(/^\s*permissions:\n((?:\s+[a-z-]+: (?:read|write|none)\n)+)/gm)].map((m) => m[1]);
    expect(blocks.length).toBe(2);
    const grants = blocks.flatMap((block) => [...block.matchAll(/([a-z-]+): (read|write|none)/g)].map((m) => `${m[1]}: ${m[2]}`));
    expect(grants.length).toBeGreaterThan(0);
    expect(new Set(grants)).toEqual(new Set(['contents: read']));
    expect(code).not.toMatch(/pull-requests: write|id-token|packages: write|issues: write/);
  });

  it('never runs on pull_request_target, so a fork cannot borrow the token', () => {
    expect(code).not.toContain('pull_request_target');
    expect(code).toMatch(/^ {2}pull_request:$/m);
  });

  it('skips the scout job for a pull request from a fork instead of failing it', () => {
    expect(scout).toContain("github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository");
  });

  it('reads the token in exactly two places: the credential check and the action\'s password input, and nowhere in the pins job', () => {
    expect(pins).not.toContain('secrets.');
    expect(pins).not.toContain('vars.DOCKER_SCOUT');
    const reads = [...code.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    expect(reads).toEqual(['DOCKER_SCOUT_PAT', 'DOCKER_SCOUT_PAT']);
    expect(code).toContain('SCOUT_PAT: ${{ secrets.DOCKER_SCOUT_PAT }}');
    expect(code).toContain('dockerhub-password: ${{ secrets.DOCKER_SCOUT_PAT }}');
    expect(code).not.toMatch(/secrets\.GITHUB_TOKEN|github\.token/);
  });

  it('turns the pull request comment off, which is what lets the job stay read-only', () => {
    expect(scout).toContain('write-comment: false');
  });

  it('pins the action to a full commit and says which release it is', () => {
    const uses = [...code.matchAll(/uses: (\S+)@([0-9a-f]+) # (\S+)/g)];
    expect(uses.length).toBeGreaterThanOrEqual(3);
    for (const [, , sha] of uses) expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(code).not.toMatch(/uses: [^@\s]+@(?![0-9a-f]{40}\b)\S+/);
    expect(code).toContain('docker/scout-action@a4119c5a8c5076236a54e4ce99531f7e4dd2ef84 # v1.27.0');
  });

  it('makes a missing credential a warning on a pull request and an error everywhere else, never a quiet pass', () => {
    const step = scout.slice(scout.indexOf('A Docker credential for Scout is set'), scout.indexOf('Policies, then fixable'));
    expect(step).toContain('if [ "${GITHUB_EVENT_NAME}" = "pull_request" ]; then');
    expect(step).toContain('echo "::warning::${msg} Skipped on this pull request."');
    expect(step).toContain('echo "::error::${msg}"');
    expect(step).toMatch(/echo "::error::\$\{msg\}"\n\s+exit 1/);
    // The action runs only when the credential is there.
    expect(scout).toContain("if: steps.credential.outputs.set == 'true'");
  });

  it('fails the job on a fixable critical or high vulnerability, and only on that', () => {
    expect(scout).toContain('command: quickview,cves');
    expect(scout).toContain('only-fixed: true');
    expect(scout).toContain('only-severities: critical,high');
    expect(scout).toContain('exit-code: true');
  });

  it('checks the digests the host runs, read from the pins and not from a tag', () => {
    expect(pins).toContain('node scripts/lab/read-addon-pins.mjs');
    expect(scout).toContain('image: registry://${{ matrix.image }}');
  });
});
