#!/usr/bin/env node
/**
 * Run every capability exactly the way vps-agent does and expect the exit
 * codes the job would report: each runner-image capability against a locally
 * built image, and shell-echo on the alpine image capabilities.js pins.
 *
 *   node lab-image/sandbox-check.mjs hcw-lab-runner:dev
 *
 * smoke.sh runs inside a container that has a network switch and nothing
 * else; the job sandbox is a read-only root with `--cap-drop ALL`, a 64 MB
 * tmpfs, uid 65534 and a memory limit, and two of the three faults #675
 * found (the tmpfs mounted root-owned, providers dying on a read-only TMPDIR)
 * were invisible to smoke.sh and fatal here. So this script does not restate
 * the sandbox: it imports `prepareJobDir` and `buildDockerArgs` from
 * vps-agent/lib/docker-runner.js and the capability table from
 * vps-agent/lib/capabilities.js, swaps only the runner image for the one
 * under test, and spawns the argv the agent would spawn. If the agent's flags
 * change, this checks the new flags. A capability on another image runs on
 * the digest capabilities.js pins, pulled like the agent pulls it: every
 * capability then has a case, so an image that cannot serve its job under
 * the sandbox (alpine/ansible:2.17.0 never could, its HOME being `/` on the
 * read-only root) fails here rather than on the host.
 *
 * The same rule for the payload that matters most: the Landing Zone
 * Builder's full default build (every component, both landing zones) is not
 * a fixture here but `emitFiles(DEFAULT_STATE)` from
 * frontend/src/lib/landingZone, generated at run time, so a builder that
 * emits a module or a version the image does not vendor fails this check
 * (ADR 0032 decision 5). It runs at the agent's own limits like every other
 * case, which is what set those limits: at 256m of memory its `terraform
 * validate` was OOM-killed, and at 512m on the swapless lab host one run in
 * three was killed for running out of memory too (#1590), so the agent's
 * default is 768m (vps-agent/index.js
 * says why). The builder imports its siblings without a `.js` extension, as
 * Vite allows; the one resolve hook below adds it, and it applies to nothing
 * but those relative imports.
 *
 * No dependency beyond Node and Docker (the tar fixture is made with the
 * host's `tar --format=ustar`, present on the Ubuntu runners and on Windows).
 */

import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import * as nodeModule from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { prepareJobDir, buildDockerArgs } = await import(
  new URL('../vps-agent/lib/docker-runner.js', import.meta.url)
);
const { CAPABILITIES, IMAGES } = await import(new URL('../vps-agent/lib/capabilities.js', import.meta.url));

/**
 * `./format` -> `./format.js` for a relative import with no extension, and
 * nothing else. registerHooks (Node 22.15 and later) runs in this thread;
 * register is the older, off-thread form, kept for a runner whose default
 * Node predates it.
 */
const EXTENSIONLESS = /^\.\.?\/(?:.*\/)?[^./]+$/;
if (typeof nodeModule.registerHooks === 'function') {
  nodeModule.registerHooks({
    resolve: (specifier, context, next) =>
      next(EXTENSIONLESS.test(specifier) ? `${specifier}.js` : specifier, context),
  });
} else {
  nodeModule.register(
    `data:text/javascript,${encodeURIComponent(
      `export const resolve = (s, c, next) => next(${EXTENSIONLESS}.test(s) ? s + '.js' : s, c);`
    )}`
  );
}
const landingZone = (file) => new URL(`../frontend/src/lib/landingZone/${file}`, import.meta.url);
const { emitFiles } = await import(landingZone('hcl/index.js'));
const { DEFAULT_STATE } = await import(landingZone('state.js'));

const image = process.argv[2];
if (!image) {
  console.error('usage: node lab-image/sandbox-check.mjs <runner image tag>');
  process.exit(2);
}

/**
 * The agent's own defaults, read from vps-agent/index.js `config.limits`
 * rather than restated, so a change there is a change here. index.js cannot
 * be imported (it starts the agent and exits without its configuration), so
 * each `process.env.LABS_AGENT_JOB_* || <default>` is read from its source
 * text. scripts/lab-job-limits.test.mjs holds the host's labs_agent role and
 * vps-agent/.env.example to the same values. Every case runs at these; none
 * has an override.
 */
const agentSource = await fs.readFile(new URL('../vps-agent/index.js', import.meta.url), 'utf8');
const agentDefault = (name) => {
  const found = agentSource.match(new RegExp(`process\\.env\\.${name} \\|\\| '?([^')]+)'?\\)?,`));
  if (!found) throw new Error(`vps-agent/index.js has no \`process.env.${name} || <default>\``);
  return found[1];
};
const LIMITS = {
  memory: agentDefault('LABS_AGENT_JOB_MEMORY'),
  cpus: agentDefault('LABS_AGENT_JOB_CPUS'),
  pidsLimit: Number(agentDefault('LABS_AGENT_JOB_PIDS')),
};
console.log(`limits (vps-agent/index.js defaults): memory ${LIMITS.memory}, cpus ${LIMITS.cpus}, pids ${LIMITS.pidsLimit}`);

const fixture = (...p) => path.join(here, 'smoke', ...p);
const readText = (...p) => fs.readFile(fixture(...p), 'utf8');
const tarOf = (dir) =>
  execFileSync('tar', ['--format=ustar', '-cf', '-', '-C', dir, '.'], { maxBuffer: 16 * 1024 * 1024 }).toString(
    'base64'
  );

/** How many `module` blocks name a registry source (`Azure/<name>/<system>`) in some HCL text. */
const registryModuleBlocks = (text) =>
  [...String(text).matchAll(/^\s*source\s*=\s*"(?:registry\.terraform\.io\/)?[Aa]zure\/[^/"]+\/[^/"]+"/gm)].length;

/**
 * hcw-terraform-validate prints one `rewrote` line per registry module block
 * it pointed at a vendored copy and one `left` line per block it could not.
 * Every block must be rewritten: a `left` line is a module or version the
 * image does not vendor, and the init after it only passes with network.
 */
const everyBlockRewritten = (expected) => (output) => {
  const rewrote = (output.match(/^\s+rewrote /gm) ?? []).length;
  const left = output.match(/^\s+left .*$/gm) ?? [];
  if (left.length > 0) return `${left.length} registry module(s) not vendored:\n${left.join('\n')}`;
  if (rewrote !== expected) return `${rewrote} rewrote line(s), expected ${expected}`;
  return null;
};

/** The builder's full default build, written to a temporary root; returns the directory. */
async function builderDefaultBuild() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hcw-lz-default-'));
  for (const file of emitFiles(DEFAULT_STATE)) {
    await fs.writeFile(path.join(dir, file.path), file.content);
  }
  return dir;
}

const builderDir = await builderDefaultBuild();
const builderBlocks = emitFiles(DEFAULT_STATE)
  .filter((file) => file.path.endsWith('.tf'))
  .reduce((sum, file) => sum + registryModuleBlocks(file.content), 0);
const fixtureBlocks = registryModuleBlocks(await readText('terraform-validate-payload', 'main.tf'));

const cases = [
  {
    name: 'terraform-validate, text payload (builder-shaped main.tf)',
    type: 'terraform-validate',
    encoding: 'text',
    payload: () => readText('terraform-validate-payload', 'main.tf'),
    expectExit: 0,
    expectOutput: ['Success! The configuration is valid.', everyBlockRewritten(fixtureBlocks)],
    terraform: true,
  },
  {
    name: `terraform-validate, tar payload (the Landing Zone Builder's full default build: ${DEFAULT_STATE.selected.length} components, ${builderBlocks} registry module blocks)`,
    type: 'terraform-validate',
    encoding: 'tar',
    payload: () => tarOf(builderDir),
    expectExit: 0,
    expectOutput: ['Success! The configuration is valid.', everyBlockRewritten(builderBlocks)],
    terraform: true,
  },
  {
    name: 'terraform-validate, tar payload (the same root as an archive)',
    type: 'terraform-validate',
    encoding: 'tar',
    payload: () => tarOf(fixture('terraform-validate-payload')),
    expectExit: 0,
    expectOutput: ['Success! The configuration is valid.'],
  },
  {
    name: 'helm-template, tar payload (chart in a top-level directory)',
    type: 'helm-template',
    encoding: 'tar',
    payload: () => tarOf(fixture('helm-payload')),
    expectExit: 0,
    expectOutput: ['kind: Deployment', 'name: hcw-hcw-smoke'],
  },
  {
    name: 'kubeconform, text payload (valid manifests)',
    type: 'kubeconform',
    encoding: 'text',
    payload: () => readText('kubeconform-payload', 'valid', 'deployment.yaml'),
    expectExit: 0,
    expectOutput: ['Valid: 2, Invalid: 0, Errors: 0'],
  },
  {
    name: 'kubeconform, text payload (unknown field is rejected)',
    type: 'kubeconform',
    encoding: 'text',
    payload: () => readText('kubeconform-payload', 'invalid', 'deployment.yaml'),
    expectExit: 1,
    expectOutput: ["'replicaz' not allowed"],
  },
  {
    name: 'ansible-check, text payload (valid playbook, ansible.builtin only)',
    type: 'ansible-check',
    encoding: 'text',
    payload: () => readText('ansible-check-payload', 'valid', 'playbook.yml'),
    expectExit: 0,
    // The one line and nothing else (ansible-playbook prints a blank line
    // before it): a warning about a directory ansible-core could not create
    // on the read-only root would be in the job's output too.
    expectOutput: [exactly('playbook: /workspace/playbook.yml')],
  },
  {
    name: 'ansible-check, text payload (unknown play keyword is rejected)',
    type: 'ansible-check',
    encoding: 'text',
    payload: () => readText('ansible-check-payload', 'invalid', 'playbook.yml'),
    expectExit: 4,
    expectOutput: ["'taskz' is not a valid attribute for a Play"],
  },
  {
    name: 'ansible-check, text payload (a collection module does not resolve: ansible-core only)',
    type: 'ansible-check',
    encoding: 'text',
    payload: () => readText('ansible-check-payload', 'collection', 'playbook.yml'),
    expectExit: 4,
    expectOutput: ["couldn't resolve module/action 'community.general.ufw'"],
  },
  {
    name: 'shell-echo, text payload (the admin console smoke test)',
    type: 'shell-echo',
    encoding: 'text',
    payload: () => 'hello vps',
    expectExit: 0,
    expectOutput: [exactly('hello vps')],
  },
];

/** A check that the whole job output, surrounding whitespace aside, is `want` and nothing else. */
function exactly(want) {
  return (output) => (output.trim() === want ? null : `output is ${JSON.stringify(output)}, expected exactly ${JSON.stringify(want)}`);
}

/** A check that the job output contains `want`. */
const contains = (want) => (output) => (output.includes(want) ? null : `output lacks ${want}`);

/** Every capability has a case, so one added later cannot ship unchecked. */
const uncovered = Object.keys(CAPABILITIES).filter((type) => !cases.some((c) => c.type === type));
if (uncovered.length > 0) {
  console.log(`sandbox-check: FAILED (no case for ${uncovered.join(', ')})`);
  process.exit(1);
}

/**
 * The image a case runs on: the image under test for a runner-image
 * capability, the pinned digest for any other. Those are pulled first, as
 * the host pre-pulls them, so a pull's progress lines are not job output;
 * a failed pull prints Docker's own error above the FAILED line.
 */
const imageFor = (type) => (CAPABILITIES[type].image === IMAGES.hcwLabRunner ? image : CAPABILITIES[type].image);
for (const pinned of new Set(cases.map((c) => imageFor(c.type)).filter((ref) => ref !== image))) {
  const pull = spawnSync('docker', ['pull', '--quiet', pinned], { stdio: ['ignore', 'ignore', 'inherit'] });
  if (pull.status !== 0) {
    console.log(`sandbox-check: FAILED (docker pull ${pinned} exited ${pull.status})`);
    process.exit(1);
  }
  console.log(`pulled: ${pinned}`);
}

/** What is wrong with one finished job, one sentence each; empty when it did what its case expects. */
function problemsOf(c, run, output) {
  const checks = c.expectOutput.map((want) => (typeof want === 'function' ? want : contains(want)));
  return [
    run.error && `docker did not run: ${run.error.message}`,
    run.status !== c.expectExit && `exit ${run.status}, expected ${c.expectExit}`,
    ...checks.map((check) => check(output)),
  ].filter(Boolean);
}

/** Run one case exactly as the agent runs a job, and print the verdict. Resolves true when it passed. */
async function runCase(c) {
  const capability = { ...CAPABILITIES[c.type], image: imageFor(c.type) };
  const jobId = `check-${c.type}-${Date.now().toString(36)}`;
  const jobDir = await prepareJobDir(capability.payloadFileName, await c.payload(), c.encoding);
  try {
    const argv = buildDockerArgs(
      capability,
      { jobDir, containerName: `labjob-${jobId}`, jobId, encoding: c.encoding },
      LIMITS
    );
    const started = Date.now();
    const run = spawnSync('docker', argv, {
      encoding: 'utf8',
      timeout: (capability.timeoutSeconds + 15) * 1000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const problems = problemsOf(c, run, output);
    if (problems.length > 0) {
      console.log(`FAIL: ${c.name}: ${problems.join('; ')}`);
      console.log(`      docker ${argv.join(' ')}`);
      console.log(output.replace(/^/gm, '      '));
      return false;
    }
    const on = capability.image === image ? '' : `, on ${capability.image}`;
    console.log(`ok:   ${c.name} (exit ${run.status}, ${seconds}s${on})`);
    const evidence = c.terraform ? (output.match(/^\s+rewrote .*$|^Success! .*$/gm) ?? []) : [];
    for (const line of evidence) console.log(`      ${line.trim()}`);
    return true;
  } finally {
    await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
}

let failed = 0;
for (const c of cases) {
  if (!(await runCase(c))) failed += 1;
}

await fs.rm(builderDir, { recursive: true, force: true }).catch(() => {});

if (failed > 0) {
  console.log(`sandbox-check: FAILED (${failed} of ${cases.length})`);
  process.exit(1);
}
console.log(`sandbox-check: passed (${cases.length} jobs, the runner-image ones on ${image})`);
