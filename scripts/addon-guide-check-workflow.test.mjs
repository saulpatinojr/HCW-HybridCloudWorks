/**
 * addon-guide-check.yml (#1356): the tripwires for a reusable workflow that four other repositories call. It holds no
 * secret and writes nothing, and these tests keep it that way: no permission beyond reading, no event that lets a
 * fork borrow a token, every action pinned to a full commit, the script fetched at the workflow's own commit, and
 * the caller's inputs reaching the shell only through environment variables. Comments are not searched, so a
 * header that explains `pull_request_target` does not trip the test that forbids it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(REPO, '.github', 'workflows', 'addon-guide-check.yml'), 'utf8');
const code = source.split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join('\n');

/** The text of each `run: |` block, so a rule about shell text is not satisfied by a `with:` value. */
const runBlocks = [...code.matchAll(/^( +)run: \|\n((?:\1 +.*\n|\n)+)/gm)].map((m) => m[2]);

describe('addon-guide-check.yml', () => {
  it('is a reusable workflow with the two documented inputs and nothing else triggering it', () => {
    expect(code).toMatch(/^on:\n {2}workflow_call:\n {4}inputs:\n/m);
    expect(code).toMatch(/^ {6}addon-id:\n(?: {8}.*\n)*? {8}required: true\n/m);
    expect(code).toMatch(/^ {6}guide-path:\n(?: {8}.*\n)*? {8}default: docs\/website-integration\/integration-guide\.md\n/m);
    expect(code).not.toMatch(/^ {2}(push|pull_request|schedule|workflow_dispatch):/m);
  });

  it('holds no permission beyond reading the repository, at the top and in the job', () => {
    expect(code).toMatch(/^permissions: \{\}$/m);
    const blocks = [...code.matchAll(/^\s*permissions:\n((?:\s+[a-z-]+: (?:read|write|none)\n)+)/gm)].map((m) => m[1]);
    expect(blocks.length).toBe(1);
    const grants = [...blocks[0].matchAll(/([a-z-]+): (read|write|none)/g)].map((m) => `${m[1]}: ${m[2]}`);
    expect(grants).toEqual(['contents: read']);
    expect(code).not.toMatch(/id-token|pull-requests: write|issues: write|packages: write|contents: write/);
  });

  it('never runs on pull_request_target and never mentions a secret or the job token', () => {
    expect(code).not.toContain('pull_request_target');
    expect(code).not.toContain('secrets.');
    expect(code).not.toMatch(/\bsecrets:|secrets: inherit/);
    expect(code).not.toMatch(/GITHUB_TOKEN|github\.token|token:/);
  });

  it('pins every action to a full commit and says which release it is', () => {
    const uses = [...code.matchAll(/uses: (\S+)@([0-9a-f]+) # (\S+)/g)];
    expect(uses.length).toBe(4);
    for (const [, , sha] of uses) expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(code).not.toMatch(/uses: [^@\s]+@(?![0-9a-f]{40}\b)\S+/);
    expect(code).not.toMatch(/uses: \.\//);
    expect(code).toContain('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7');
    expect(code).toContain('actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7');
  });

  it('never writes a credential to disk: every checkout sets persist-credentials false', () => {
    const checkouts = code.split('uses: actions/checkout@').slice(1);
    expect(checkouts.length).toBe(3);
    for (const step of checkouts) {
      expect(step.split(/\n {6}- /)[0]).toContain('persist-credentials: false');
    }
  });

  it('fetches the script at the workflow\'s own commit and the data from main, each from the website only', () => {
    const tools = code.slice(code.indexOf('path: .hcw-site-tools') - 400, code.indexOf('path: .hcw-site-tools') + 200);
    expect(tools).toContain('repository: saulpatinojr/HCW-HybridCloudWorks');
    expect(tools).toContain('ref: ${{ job.workflow_sha }}');
    expect(code).toContain('sparse-checkout: scripts/addons/check-guide-drift.mjs');
    const data = code.slice(code.indexOf('path: .hcw-site-data') - 400, code.indexOf('path: .hcw-site-data') + 300);
    expect(data).toContain('repository: saulpatinojr/HCW-HybridCloudWorks');
    expect(data).toContain('ref: main');
    expect(data).toContain('frontend/src/data/addons/catalogue.js');
    expect(data).toContain('lab-host/ansible/group_vars/all.yml');
    expect(code).not.toContain('github.job_workflow_sha');
  });

  it('refuses a workflow commit that is not 40 hex characters before it is used as a ref', () => {
    const guard = runBlocks.find((block) => block.includes('WORKFLOW_SHA'));
    expect(guard).toContain("grep -Eq '^[0-9a-f]{40}$'");
    expect(code.indexOf('WORKFLOW_SHA: ${{ job.workflow_sha }}')).toBeLessThan(code.indexOf('path: .hcw-site-tools'));
  });

  it('lets an input reach the shell only through an environment variable', () => {
    expect(runBlocks.length).toBe(2);
    for (const block of runBlocks) {
      expect(block).not.toContain('${{');
    }
    expect(code).toContain('ADDON_ID: ${{ inputs.addon-id }}');
    expect(code).toContain('GUIDE_PATH: ${{ inputs.guide-path }}');
    // Anywhere else an input is read, it is a value for an env var and not part of a command.
    const reads = [...code.matchAll(/\$\{\{\s*inputs\.[a-z-]+\s*\}\}/g)];
    expect(reads.length).toBe(4);
    for (const line of code.split('\n').filter((l) => /inputs\./.test(l))) {
      expect(line).toMatch(/^\s+(ADDON_ID|GUIDE_PATH): \$\{\{ inputs\.[a-z-]+ \}\}$/);
    }
  });

  it('runs the script on the checked-out copies and quotes what it was given', () => {
    const compare = runBlocks.find((block) => block.includes('check-guide-drift.mjs'));
    expect(compare).toContain('node .hcw-site-tools/scripts/addons/check-guide-drift.mjs');
    expect(compare).toContain('--catalogue .hcw-site-data/frontend/src/data/addons/catalogue.js');
    expect(compare).toContain('--group-vars .hcw-site-data/lab-host/ansible/group_vars/all.yml');
    expect(compare).toContain('--guide "${GUIDE_PATH}"');
    expect(compare).toContain('--id "${ADDON_ID}"');
  });

  it('writes the result to the job summary and fails the job with the script\'s own exit code', () => {
    const compare = runBlocks.find((block) => block.includes('check-guide-drift.mjs'));
    expect(compare).toContain('>> "${GITHUB_STEP_SUMMARY}"');
    expect(compare).toContain('exit "${status}"');
  });

  it('sets up a Node that the script runs on, with no install step', () => {
    expect(code).toContain("node-version: '26'");
    expect(code).not.toMatch(/npm (ci|install)/);
  });
});
