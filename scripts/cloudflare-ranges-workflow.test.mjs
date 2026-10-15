/**
 * cloudflare-ranges.yml (PLAT-10, #970): the same tripwires as
 * lab-pin-pr-workflows.test.mjs, for the same reason. A job that pushes a
 * branch with an App token must be held to the one path it means to push,
 * and the job that reads the network must hold no secret.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SETS } from './open-lab-pin-pr.mjs';
import { SET, VARIABLES_PATH } from './cloudflare-ranges.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(REPO, SETS[SET].workflow), 'utf8');
const commandLines = (text) => text.split(/\r?\n/).filter((line) => !/^\s*#/.test(line));
const lines = commandLines(source);

/** One job's text, from its key to the next job's; both keys must exist. */
const job = (name, next) => {
  const at = (key) => {
    const index = source.indexOf(`\n  ${key}:\n`);
    if (index === -1) throw new Error(`no job \`${key}\` in the workflow`);
    return index;
  };
  return next ? source.slice(at(name), at(next)) : source.slice(at(name));
};
const propose = job('propose', 'pull-request');
const pullRequest = job('pull-request');

describe('cloudflare-ranges.yml', () => {
  it('is the workflow the opener names for the set, over exactly the variables file', () => {
    expect(SETS[SET].workflow).toBe('.github/workflows/cloudflare-ranges.yml');
    expect(SETS[SET].paths).toEqual([VARIABLES_PATH]);
    expect(SETS[SET].branch).toBe('chore/cloudflare-ranges');
  });

  it('runs on Tuesdays at 07:05 UTC, after the lab supply-chain run, and by hand without inputs', () => {
    expect(lines.filter((l) => /cron:/.test(l))).toEqual(["    - cron: '5 7 * * 2'"]);
    expect(lines.some((l) => /^\s*workflow_dispatch:/.test(l))).toBe(true);
    expect(lines.some((l) => /^\s*inputs:/.test(l))).toBe(false);
  });

  it('compares in a job that can read and nothing more, recording the paths before the fetch', () => {
    expect(propose).toContain('contents: read');
    expect(propose).not.toMatch(/secrets\./);
    const order = [
      "Record the set's paths before anything fetched runs",
      "Read Cloudflare's list and rewrite the default when it moved",
      "Nothing outside the set's paths changed",
      "One patch, over the set's paths only",
    ].map((name) => propose.indexOf(`- name: ${name}`));
    expect(order.every((at) => at !== -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(propose).toContain('node scripts/open-lab-pin-pr.mjs --paths cloudflare-ranges');
    expect(propose).toContain('node scripts/cloudflare-ranges.mjs --bump --evidence');
    expect(propose).toContain('mapfile -t paths < "${RUNNER_TEMP}/cloudflare-ranges/paths.txt"');
  });

  it('opens the pull request from the automation environment, judging the patch before applying it, with the token masked first and revoked after', () => {
    expect(pullRequest).toContain('environment: automation');
    expect(pullRequest).toContain('contents: read');
    expect(pullRequest).toContain("if: needs.propose.outputs.changed == 'true'");
    const judge = pullRequest.indexOf("- name: The patch touches only the set's recorded paths, and no code this job runs");
    const apply = pullRequest.indexOf('- name: Apply the patch');
    const mint = pullRequest.indexOf('- name: Mint an App installation token');
    expect(judge).toBeGreaterThan(-1);
    expect(judge).toBeLessThan(apply);
    expect(apply).toBeLessThan(mint);
    expect(pullRequest).toContain('git apply --numstat "${patch}"');
    expect(pullRequest).toContain(`grep -E '^(\\.github/|scripts/)' "\${RUNNER_TEMP}/cloudflare-ranges/patched.txt"`);
    expect(pullRequest).toContain('node scripts/open-lab-pin-pr.mjs --set cloudflare-ranges');
    expect(pullRequest.indexOf('::add-mask::')).toBeGreaterThan(-1);
    expect(pullRequest.indexOf('::add-mask::')).toBeLessThan(pullRequest.indexOf('token=${token}'));
    expect(pullRequest).toContain('node scripts/github-app-token.mjs --revoke');
  });

  it('holds no write grant on contents or pull requests, and pins every action by SHA', () => {
    expect(lines.some((l) => /contents:\s*write/.test(l))).toBe(false);
    expect(lines.some((l) => /pull-requests:\s*write/.test(l))).toBe(false);
    expect(lines.some((l) => /^permissions:\s*\{\}/.test(l))).toBe(true);
    const uses = lines.filter((l) => /^\s*(- )?uses:\s/.test(l));
    expect(uses.length).toBeGreaterThan(4);
    for (const line of uses) expect(line, line.trim()).toMatch(/@[0-9a-f]{40}\s+#\s*v\d/);
  });

  it('never stages with git add', () => {
    expect(lines.filter((l) => /\bgit add\b/.test(l))).toEqual([]);
  });
});
