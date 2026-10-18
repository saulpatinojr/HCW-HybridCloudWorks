/**
 * The lab host pulls every pinned job image before a job needs it, and
 * removes the digests a pin no longer names (lab-host/ansible/roles/
 * lab_images). The list comes from the pins themselves, read on the host by
 * lab-images.mjs, never from a copy: a bump to IMAGES in
 * vps-agent/lib/capabilities.js, or to the workspace image in any Coder
 * template, must reach the host with no second edit.
 *
 * So this test holds the helper to the files as they are in this repository
 * (the CLI Ansible runs, against this checkout, prints exactly IMAGES and
 * every template's image; #1268 found it reading hcw-lab's alone while the
 * guided labs pinned another digest), and holds the plan to what the role
 * promises: pulls by repository@digest, removals only inside the lab's own
 * repositories, never a pinned digest, never an image a container uses.
 *
 * In the CI matrix this runs in the `scripts (operations)` row, whose filter
 * already covers lab-host/ and vps-agent/lib/capabilities.js.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CAPABILITIES_FILE,
  LAB_REPOSITORY_PATTERN,
  WORKSPACE_TEMPLATES_DIR,
  WORKSPACE_TEMPLATE_FILE,
  parseReference,
  planImages,
  readPins,
  workspaceImageFromTemplate,
  workspaceTemplateFiles,
} from '../lab-host/ansible/roles/lab_images/files/lab-images.mjs';
import { IMAGES } from '../vps-agent/lib/capabilities.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const helper = path.join(repoRoot, 'lab-host', 'ansible', 'roles', 'lab_images', 'files', 'lab-images.mjs');

// Every template this repository publishes, read here without the helper, so
// the test and the helper cannot share a blind spot (#1268).
const templateNames = readdirSync(path.join(repoRoot, WORKSPACE_TEMPLATES_DIR), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const templateFile = (name) => path.join(WORKSPACE_TEMPLATES_DIR, name, WORKSPACE_TEMPLATE_FILE);
/** A template's pinned image, from the one `image_digest` line and the one local that uses it. */
function pinnedInTemplate(name) {
  const lines = readFileSync(path.join(repoRoot, templateFile(name)), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line));
  const digests = lines.map((line) => line.match(/^\s*image_digest\s*=\s*"(sha256:[0-9a-f]{64})"\s*$/)).filter(Boolean);
  const repositories = lines
    .map((line) => line.match(/^\s*(?:default_)?image\s*=\s*"([^"@$]+)@\$\{local\.image_digest\}"\s*$/))
    .filter(Boolean);
  expect(digests, `${templateFile(name)} pins one image_digest`).toHaveLength(1);
  expect(repositories, `${templateFile(name)} builds one image from local.image_digest`).toHaveLength(1);
  return `${parseReference(repositories[0][1]).repository}@${digests[0][1]}`;
}
/** What the sandbox daemon must hold: each template's image, once. */
const workspacePulls = [...new Set(templateNames.map(pinnedInTemplate))];

const hex = (c) => c.repeat(64);
// The familiar form, as Docker lists Docker Hub images in RepoTags and
// RepoDigests; the pins name docker.io/… and compare equal to these.
const RUNNER = 'hybridcloudworks/hcw-lab-runner';
const WORKSPACE = 'hybridcloudworks/hcw-lab';
// Where both images lived until 2026-10-08.
const FORMER = 'ghcr.io/hybridcloudworks/hcw-lab';

const scratch = mkdtempSync(path.join(os.tmpdir(), 'lab-images-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let fixtureCount = 0;
/**
 * A checkout holding only the files the helper reads: capabilities.js and
 * one main.tf per template, `template` as hcw-lab's alone or `templates` by
 * name. An empty `templates` makes a checkout with no template at all.
 */
function fixtureCheckout({ images, template, templates = { 'hcw-lab': template } }) {
  const root = path.join(scratch, `checkout-${(fixtureCount += 1)}`);
  mkdirSync(path.join(root, path.dirname(CAPABILITIES_FILE)), { recursive: true });
  mkdirSync(path.join(root, WORKSPACE_TEMPLATES_DIR), { recursive: true });
  writeFileSync(path.join(root, CAPABILITIES_FILE), `export const IMAGES = ${JSON.stringify(images)};\n`);
  for (const [name, text] of Object.entries(templates)) {
    mkdirSync(path.join(root, WORKSPACE_TEMPLATES_DIR, name), { recursive: true });
    if (text !== null) writeFileSync(path.join(root, templateFile(name)), text);
  }
  return root;
}

/** hcw-lab's shape: `image = "<repository>@${local.image_digest}"`. */
function templateWith(digest, repository = WORKSPACE) {
  return [
    'locals {',
    '  # image_digest = "sha256:' + hex('0') + '" (a comment is not a pin)',
    `  image_tag    = "7c0a95b2ac8d48f77d8c01f71a187b02e2cd284b"`,
    `  image_digest = "${digest}"`,
    `  image        = "${repository}@\${local.image_digest}"`,
    '}',
    'resource "docker_container" "workspace" {',
    '  image = docker_image.hcw_lab.image_id',
    '}',
    '',
  ].join('\n');
}

/** The guided labs' shape (amo-guided-lab, na-guided-lab): the same local named `default_image`. */
function guidedTemplateWith(digest, repository = WORKSPACE) {
  return [
    'locals {',
    `  image_tag      = "e3d24c3eab7ca2d4eb314cef190197f9700733da"`,
    `  image_digest   = "${digest}"`,
    `  default_image  = "${repository}@\${local.image_digest}"`,
    '  home           = "/tmp/home"',
    '}',
    'resource "docker_image" "workspace" {',
    '  name         = local.default_image',
    '}',
    '',
  ].join('\n');
}

const image = (id, refs) => ({
  Id: `sha256:${id}`,
  RepoTags: refs.filter((r) => !r.includes('@')),
  RepoDigests: refs.filter((r) => r.includes('@')),
});

describe('the pins, read from this repository', () => {
  it('are exactly the values of IMAGES in capabilities.js, in order', async () => {
    const pins = await readPins(repoRoot);
    expect(pins.capabilities.map((p) => p.reference)).toEqual(Object.values(IMAGES));
    expect(pins.capabilities.length).toBeGreaterThan(0);
  });

  it('pull each capability image as repository@digest, the tag dropped', async () => {
    const pins = await readPins(repoRoot);
    for (const pin of pins.capabilities) {
      const [name, digest] = pin.reference.split('@');
      expect(pin.pull).toBe(`${parseReference(name).repository}@${digest}`);
      expect(pin.pull).not.toMatch(/:[^/@]*@/);
    }
  });

  it('include the workspace image of every Coder template, from its image_digest and image or default_image locals', async () => {
    const pins = await readPins(repoRoot);
    expect(await workspaceTemplateFiles(repoRoot)).toEqual(templateNames.map((name) => path.join(repoRoot, templateFile(name))));
    expect(pins.workspaces.map((w) => w.source)).toEqual(templateNames.map((name) => path.join(repoRoot, templateFile(name))));
    for (const [i, name] of templateNames.entries()) {
      const pin = pins.workspaces[i];
      expect(pin.repository, name).toMatch(LAB_REPOSITORY_PATTERN);
      expect(pin.pull, name).toBe(`${pin.repository}@${pin.digest}`);
      expect(pin.pull, name).toBe(pinnedInTemplate(name));
    }
  });

  it('cover the templates #1268 found missing, which pin their image as default_image', () => {
    expect(templateNames).toEqual(expect.arrayContaining(['hcw-lab', 'amo-guided-lab', 'na-guided-lab']));
    for (const name of ['amo-guided-lab', 'na-guided-lab']) {
      expect(readFileSync(path.join(repoRoot, templateFile(name)), 'utf8')).toMatch(/^\s*default_image\s*=/m);
    }
  });

  it('are what the CLI prints for this checkout, the command the role runs', () => {
    const out = execFileSync(process.execPath, [helper, repoRoot], {
      input: JSON.stringify({ images: [], containers: [] }),
      encoding: 'utf8',
    });
    const plan = JSON.parse(out);
    const capabilityPulls = Object.values(IMAGES).map((ref) => {
      const [name, digest] = ref.split('@');
      return `${parseReference(name).repository}@${digest}`;
    });
    expect(plan.pull).toEqual(capabilityPulls);
    expect(plan.pinned).toEqual([...capabilityPulls, ...workspacePulls]);
    expect(plan.remove).toEqual([]);
  });

  it('adds every template\'s workspace image to the pulls only with --pull-workspace', () => {
    const run = (args) =>
      JSON.parse(execFileSync(process.execPath, [helper, ...args], { input: '', encoding: 'utf8' }));
    const off = run([repoRoot]);
    const on = run(['--pull-workspace', repoRoot]);
    expect(on.pull).toEqual([...off.pull, ...workspacePulls]);
    for (const pull of workspacePulls) expect(pull).toMatch(new RegExp(`^${WORKSPACE}@sha256:[0-9a-f]{64}$`));
    expect(off.pinned).toEqual(on.pinned);
  });
});

describe('every template\'s image is in the sandbox plan (#1268)', () => {
  // The role's promise is that no lab image is first downloaded while a
  // visitor waits. Until #1268 the sandbox plan held hcw-lab's image alone,
  // and the guided labs' first workspace pulled 2.75 GB on start.
  const alpine = `alpine:3.24.2@sha256:${hex('a')}`;
  const runner = `${RUNNER}:new@sha256:${hex('b')}`;

  it('is what the CLI prints for this checkout, the command the role runs against the sandbox daemon', () => {
    const plan = JSON.parse(
      execFileSync(process.execPath, [helper, '--scope', 'workspaces', repoRoot], { input: '', encoding: 'utf8' })
    );
    for (const name of templateNames) {
      expect(plan.pull, `${name}'s image is pulled onto the sandbox daemon`).toContain(pinnedInTemplate(name));
    }
    expect(plan.pull).toEqual(workspacePulls);
    expect(plan.pinned).toEqual(workspacePulls);
  });

  it('reads both shapes, image and default_image, and pulls each distinct digest once', async () => {
    const pins = await readPins(
      fixtureCheckout({
        images: { alpine, hcwLabRunner: runner },
        templates: {
          'hcw-lab': templateWith(`sha256:${hex('c')}`),
          'na-guided-lab': guidedTemplateWith(`sha256:${hex('d')}`),
          'amo-guided-lab': guidedTemplateWith(`sha256:${hex('d')}`),
        },
      })
    );
    expect(pins.workspaces.map((w) => path.basename(path.dirname(w.source)))).toEqual(['amo-guided-lab', 'hcw-lab', 'na-guided-lab']);
    const plan = planImages({
      checkouts: [pins],
      scope: 'workspaces',
      images: [image(hex('c'), [`${WORKSPACE}@sha256:${hex('c')}`]), image(hex('8'), [`${WORKSPACE}@sha256:${hex('8')}`])],
    });
    expect(plan.pull).toEqual([`${WORKSPACE}@sha256:${hex('d')}`, `${WORKSPACE}@sha256:${hex('c')}`]);
    expect(plan.pinned).toEqual(plan.pull);
    expect(plan.remove).toEqual([`${WORKSPACE}@sha256:${hex('8')}`]);
  });

  it('fails when one template\'s image cannot be read, rather than planning without it', async () => {
    const broken = fixtureCheckout({
      images: { alpine, hcwLabRunner: runner },
      templates: { 'hcw-lab': templateWith(`sha256:${hex('c')}`), 'x-guided-lab': 'locals {\n  image = "x"\n}\n' },
    });
    await expect(readPins(broken)).rejects.toThrow(/x-guided-lab[\\/]main\.tf: expected exactly one `image_digest = "sha256:<64 hex>"` local, found 0/);
    let failure;
    try {
      execFileSync(process.execPath, [helper, '--scope', 'workspaces', broken], { input: '', encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      failure = error;
    }
    expect(failure?.status).toBe(1);
    expect(failure.stderr).toMatch(/^lab-images: .*x-guided-lab[\\/]main\.tf: expected exactly one/);
  });

  it('fails when a template directory has no main.tf, or a checkout has no template at all', async () => {
    const noFile = fixtureCheckout({
      images: { alpine, hcwLabRunner: runner },
      templates: { 'hcw-lab': templateWith(`sha256:${hex('c')}`), 'y-guided-lab': null },
    });
    await expect(readPins(noFile)).rejects.toThrow(/y-guided-lab[\\/]main\.tf/);
    const none = fixtureCheckout({ images: { alpine, hcwLabRunner: runner }, templates: {} });
    await expect(readPins(none)).rejects.toThrow(/holds no template directory/);
  });
});

describe('a pin that is not a digest reference', () => {
  it('fails, naming the IMAGES entry', async () => {
    const root = fixtureCheckout({
      images: { alpine: 'alpine:3.24.2', runner: `${RUNNER}:abc@sha256:${hex('1')}` },
      template: templateWith(`sha256:${hex('2')}`),
    });
    await expect(readPins(root)).rejects.toThrow(/IMAGES\.alpine .* is "alpine:3\.24\.2", which is not an image pinned by digest/);
  });

  it('fails the CLI with exit code 1 and the reason on stderr', () => {
    const root = fixtureCheckout({
      images: { alpine: 'alpine@sha256:short' },
      template: templateWith(`sha256:${hex('2')}`),
    });
    let failure;
    try {
      execFileSync(process.execPath, [helper, root], { input: '', encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      failure = error;
    }
    expect(failure?.status).toBe(1);
    expect(failure.stderr).toMatch(/^lab-images: IMAGES\.alpine /);
  });

  it('fails when the template no longer has the image locals the plan reads', () => {
    expect(() => workspaceImageFromTemplate('locals {\n  image = "x"\n}\n', 'main.tf')).toThrow(
      /main\.tf: expected exactly one `image_digest = "sha256:<64 hex>"` local, found 0/
    );
    const twice = templateWith(`sha256:${hex('2')}`) + `locals {\n  image_digest = "sha256:${hex('3')}"\n}\n`;
    expect(() => workspaceImageFromTemplate(twice, 'main.tf')).toThrow(/found 2/);
    const noImage = `locals {\n  image_digest = "sha256:${hex('2')}"\n}\n`;
    expect(() => workspaceImageFromTemplate(noImage, 'main.tf')).toThrow(/`default_image = "<repository>@\$\{local\.image_digest\}"` local, found 0/);
    const both = templateWith(`sha256:${hex('2')}`) + `locals {\n  default_image = "${WORKSPACE}@\${local.image_digest}"\n}\n`;
    expect(() => workspaceImageFromTemplate(both, 'main.tf')).toThrow(/found 2/);
  });

  it('reads the guided labs\' default_image local as it reads hcw-lab\'s image local', () => {
    const guided = workspaceImageFromTemplate(guidedTemplateWith(`sha256:${hex('d')}`, `docker.io/${WORKSPACE}`), 'main.tf');
    expect(guided.pull).toBe(`${WORKSPACE}@sha256:${hex('d')}`);
    expect(guided.repository).toBe(WORKSPACE);
  });

  it('fails when capabilities.js is missing from a checkout', async () => {
    await expect(readPins(path.join(scratch, 'no-such-checkout'))).rejects.toThrow();
  });
});

describe('references', () => {
  it('compare in Docker\'s familiar form, as /images/json lists them', () => {
    expect(parseReference(`docker.io/library/alpine:3.24.2@sha256:${hex('a')}`)).toEqual({
      repository: 'alpine',
      tag: '3.24.2',
      digest: `sha256:${hex('a')}`,
    });
    expect(parseReference(`alpine@sha256:${hex('a')}`).repository).toBe('alpine');
    expect(parseReference('docker.io/alpine/ansible:2.17.0').repository).toBe('alpine/ansible');
    expect(parseReference('localhost:5000/team/app:1').repository).toBe('localhost:5000/team/app');
  });

  it('are not parsed out of Docker\'s placeholders', () => {
    expect(parseReference('<none>:<none>')).toBeNull();
    expect(parseReference('<none>@<none>')).toBeNull();
  });
});

describe('the plan', () => {
  const alpine = `alpine:3.24.2@sha256:${hex('a')}`;
  const runnerNew = `${RUNNER}:new@sha256:${hex('b')}`;
  const workspaceDigest = `sha256:${hex('c')}`;
  const current = () => fixtureCheckout({ images: { alpine, hcwLabRunner: runnerNew }, template: templateWith(workspaceDigest) });

  it('pulls a bumped digest and removes the one it replaced', async () => {
    const pins = await readPins(current());
    const plan = planImages({
      checkouts: [pins],
      images: [
        image(hex('a'), [`alpine@sha256:${hex('a')}`]),
        image(hex('9'), [`${RUNNER}@sha256:${hex('9')}`]),
      ],
    });
    expect(plan.pull).toEqual([`alpine@sha256:${hex('a')}`, `${RUNNER}@sha256:${hex('b')}`]);
    expect(plan.remove).toEqual([`${RUNNER}@sha256:${hex('9')}`]);
    expect(plan.in_use).toEqual([]);
  });

  it('never lists a pinned digest, whatever else the image carries', async () => {
    const pins = await readPins(current());
    const plan = planImages({
      checkouts: [pins],
      images: [
        // The containerd image store lists a digest pull under RepoTags too.
        { Id: `sha256:${hex('b')}`, RepoTags: [`${RUNNER}@sha256:${hex('b')}`], RepoDigests: [`${RUNNER}@sha256:${hex('b')}`] },
        image(hex('a'), [`alpine:3.24.2`, `alpine@sha256:${hex('a')}`]),
      ],
    });
    expect(plan.remove).toEqual([]);
  });

  it('keeps the pinned workspace image while Coder is off, and does not pull it', async () => {
    const pins = await readPins(current());
    const plan = planImages({
      checkouts: [pins],
      pullWorkspace: false,
      images: [image(hex('c'), [`${WORKSPACE}@${workspaceDigest}`]), image(hex('8'), [`${WORKSPACE}@sha256:${hex('8')}`])],
    });
    expect(plan.pull).not.toContain(`${WORKSPACE}@${workspaceDigest}`);
    expect(plan.pinned).toContain(`${WORKSPACE}@${workspaceDigest}`);
    expect(plan.remove).toEqual([`${WORKSPACE}@sha256:${hex('8')}`]);
  });

  it('removes a stale tag under hybridcloudworks/hcw-lab* before its digest', async () => {
    const pins = await readPins(current());
    const plan = planImages({
      checkouts: [pins],
      images: [image(hex('7'), [`${WORKSPACE}:latest`, `${WORKSPACE}@sha256:${hex('7')}`])],
    });
    expect(plan.remove).toEqual([`${WORKSPACE}:latest`, `${WORKSPACE}@sha256:${hex('7')}`]);
  });

  it('removes an image pulled from the former GHCR repositories once no pin names it', async () => {
    const pins = await readPins(current());
    const plan = planImages({
      checkouts: [pins],
      images: [image(hex('b'), [`${FORMER}-runner@sha256:${hex('b')}`, `${FORMER}@sha256:${hex('c')}`])],
    });
    expect(plan.remove).toEqual([`${FORMER}-runner@sha256:${hex('b')}`, `${FORMER}@sha256:${hex('c')}`]);
  });

  it('keeps an image whose Docker Hub reference is the pin, GHCR reference and all', async () => {
    // The same bytes under both names, as on the host after the first pull
    // from Docker Hub: one reference is a pin, so the image stays whole.
    const pins = await readPins(current());
    const [pinned] = pins.workspaces;
    expect(pinned.repository).toBe(WORKSPACE);
    const plan = planImages({
      checkouts: [pins],
      images: [image(pinned.digest.slice('sha256:'.length), [`${FORMER}@${pinned.digest}`, `${WORKSPACE}@${pinned.digest}`])],
    });
    expect(plan.remove).toEqual([]);
  });

  it('leaves every repository outside the lab\'s own alone', async () => {
    const pins = await readPins(current());
    const plan = planImages({
      checkouts: [pins],
      images: [
        image(hex('1'), [`postgres@sha256:${hex('1')}`]),
        image(hex('2'), [`caddy@sha256:${hex('2')}`]),
        image(hex('3'), [`ghcr.io/coder/coder@sha256:${hex('3')}`]),
        image(hex('4'), ['hcw-lab-runner:dev']),
        image(hex('5'), [`ghcr.io/hybridcloudworks/other@sha256:${hex('5')}`]),
        image(hex('a'), [`hybridcloudworks/other@sha256:${hex('a')}`]),
        image(hex('6'), [`alpine/ansible@sha256:${hex('6')}`]),
      ],
    });
    expect(plan.remove).toEqual([]);
  });

  it('removes only the lab reference of an image that another repository also names', async () => {
    const pins = await readPins(current());
    const plan = planImages({
      checkouts: [pins],
      images: [image(hex('9'), [`${RUNNER}@sha256:${hex('9')}`, 'someone/else:kept', `someone/else@sha256:${hex('9')}`])],
    });
    expect(plan.remove).toEqual([`${RUNNER}@sha256:${hex('9')}`]);
  });

  it('keeps a stale image a container still uses, running or stopped, and reports it', async () => {
    const pins = await readPins(current());
    const plan = planImages({
      checkouts: [pins],
      images: [image(hex('9'), [`${RUNNER}@sha256:${hex('9')}`])],
      containers: [{ Id: 'c1', Names: ['/labjob-0a1b2c'], ImageID: `sha256:${hex('9')}`, State: 'exited' }],
    });
    expect(plan.remove).toEqual([]);
    expect(plan.in_use).toEqual([
      { image: `sha256:${hex('9')}`, references: [`${RUNNER}@sha256:${hex('9')}`], containers: ['labjob-0a1b2c'] },
    ]);
  });

  it('holds the pins of every checkout, so an agent held at an older commit keeps its images', async () => {
    const playbook = await readPins(current());
    const agent = await readPins(
      fixtureCheckout({ images: { alpine, hcwLabRunner: `${RUNNER}:old@sha256:${hex('9')}` }, template: templateWith(workspaceDigest) })
    );
    const plan = planImages({
      checkouts: [playbook, agent],
      images: [image(hex('9'), [`${RUNNER}@sha256:${hex('9')}`]), image(hex('8'), [`${RUNNER}@sha256:${hex('8')}`])],
    });
    expect(plan.pull).toEqual([
      `alpine@sha256:${hex('a')}`,
      `${RUNNER}@sha256:${hex('b')}`,
      `${RUNNER}@sha256:${hex('9')}`,
    ]);
    expect(plan.remove).toEqual([`${RUNNER}@sha256:${hex('8')}`]);
  });
});

describe('a plan scoped to one daemon (LAB-5)', () => {
  // Since 2026-10-07 the host daemon runs the jobs and the coder_sandbox
  // role's rootless daemon runs the workspaces, so the role plans each
  // daemon on its own: `--scope jobs` for the host, `--scope workspaces`
  // for the sandbox. Each daemon's pins are its own images and nothing else.
  const alpine = `alpine:3.24.2@sha256:${hex('a')}`;
  const runner = `${RUNNER}:new@sha256:${hex('b')}`;
  const workspaceDigest = `sha256:${hex('c')}`;
  const checkout = () => fixtureCheckout({ images: { alpine, hcwLabRunner: runner }, template: templateWith(workspaceDigest) });

  it('on the host daemon pins and pulls the capability images only, and removes a workspace image left there', async () => {
    const pins = await readPins(checkout());
    const plan = planImages({
      checkouts: [pins],
      scope: 'jobs',
      images: [image(hex('c'), [`${WORKSPACE}@${workspaceDigest}`]), image(hex('b'), [`${RUNNER}@sha256:${hex('b')}`])],
    });
    expect(plan.pull).toEqual([`alpine@sha256:${hex('a')}`, `${RUNNER}@sha256:${hex('b')}`]);
    expect(plan.pinned).not.toContain(`${WORKSPACE}@${workspaceDigest}`);
    expect(plan.remove).toEqual([`${WORKSPACE}@${workspaceDigest}`]);
  });

  it('on the sandbox daemon pins and pulls the workspace image only, and never touches alpine', async () => {
    const pins = await readPins(checkout());
    const plan = planImages({
      checkouts: [pins],
      scope: 'workspaces',
      images: [
        image(hex('8'), [`${WORKSPACE}@sha256:${hex('8')}`]),
        image(hex('a'), [`alpine@sha256:${hex('a')}`]),
        image(hex('9'), [`${RUNNER}@sha256:${hex('9')}`]),
      ],
    });
    expect(plan.pull).toEqual([`${WORKSPACE}@${workspaceDigest}`]);
    expect(plan.pinned).toEqual([`${WORKSPACE}@${workspaceDigest}`]);
    expect(plan.remove).toEqual([`${WORKSPACE}@sha256:${hex('8')}`, `${RUNNER}@sha256:${hex('9')}`]);
  });

  it('keeps a superseded workspace image while a workspace still runs on it', async () => {
    const pins = await readPins(checkout());
    const plan = planImages({
      checkouts: [pins],
      scope: 'workspaces',
      images: [image(hex('8'), [`${WORKSPACE}@sha256:${hex('8')}`])],
      containers: [{ Id: 'w1', Names: ['/coder-owner-lab'], ImageID: `sha256:${hex('8')}`, State: 'running' }],
    });
    expect(plan.remove).toEqual([]);
    expect(plan.in_use.map((u) => u.containers)).toEqual([['coder-owner-lab']]);
  });

  it('defers workspace image removal on the sandbox daemon when deferWorkspaceCleanup is true', async () => {
    const pins = await readPins(checkout());
    const plan = planImages({
      checkouts: [pins],
      scope: 'workspaces',
      deferWorkspaceCleanup: true,
      images: [
        image(hex('8'), [`${WORKSPACE}@sha256:${hex('8')}`]),
        image(hex('9'), [`${RUNNER}@sha256:${hex('9')}`]),
      ],
    });
    expect(plan.pull).toEqual([`${WORKSPACE}@${workspaceDigest}`]);
    expect(plan.remove).toEqual([`${RUNNER}@sha256:${hex('9')}`]);
    expect(plan.deferred).toEqual([`${WORKSPACE}@sha256:${hex('8')}`]);
  });

  it('defers workspace image removal via CLI when --defer-workspace-cleanup is passed', () => {
    const run = (args, stdin) =>
      JSON.parse(execFileSync(process.execPath, [helper, ...args], { input: stdin, encoding: 'utf8' }));
    const dockerState = JSON.stringify({
      images: [
        image(hex('8'), [`${WORKSPACE}@sha256:${hex('8')}`]),
      ],
      containers: [],
    });
    const deferredPlan = run(['--scope', 'workspaces', '--defer-workspace-cleanup', repoRoot], dockerState);
    expect(deferredPlan.remove).toEqual([]);
    expect(deferredPlan.deferred).toEqual([`${WORKSPACE}@sha256:${hex('8')}`]);

    const normalPlan = run(['--scope', 'workspaces', repoRoot], dockerState);
    expect(normalPlan.remove).toEqual([`${WORKSPACE}@sha256:${hex('8')}`]);
    expect(normalPlan.deferred).toEqual([]);
  });

  it('is what the CLI prints with --scope, the two commands the role runs', () => {
    const run = (args) =>
      JSON.parse(execFileSync(process.execPath, [helper, ...args], { input: '', encoding: 'utf8' }));
    const jobs = run(['--scope', 'jobs', repoRoot]);
    const workspaces = run(['--scope', 'workspaces', repoRoot]);
    const capabilityPulls = Object.values(IMAGES).map((ref) => {
      const [name, digest] = ref.split('@');
      return `${parseReference(name).repository}@${digest}`;
    });
    expect(jobs.pull).toEqual(capabilityPulls);
    expect(jobs.pinned).toEqual(capabilityPulls);
    expect(workspaces.pull).toEqual(workspacePulls);
    for (const pull of workspaces.pull) expect(pull).toMatch(new RegExp(`^${WORKSPACE}@sha256:[0-9a-f]{64}$`));
    expect(workspaces.pinned).toEqual(workspaces.pull);
  });

  it('refuses a scope it does not know, in the module and on the command line', async () => {
    const pins = await readPins(checkout());
    expect(() => planImages({ checkouts: [pins], scope: 'everything' })).toThrow(/scope is "everything"/);
    expect(() =>
      execFileSync(process.execPath, [helper, '--scope', 'everything', repoRoot], { input: '', encoding: 'utf8', stdio: 'pipe' })
    ).toThrow(/usage/);
  });

  it('is the scope the role passes for each daemon', () => {
    const vars = readFileSync(path.join(repoRoot, 'lab-host', 'ansible', 'roles', 'lab_images', 'vars', 'main.yml'), 'utf8');
    expect(vars).toMatch(/^lab_images_host_plan_argv: >-\n\s+\{\{ \[lab_images_node, lab_images_helper, '--scope', 'jobs'\] \+ lab_images_checkouts \}\}$/m);
    expect(vars).toMatch(/^lab_images_sandbox_plan_argv: >-\n\s+\{\{ \[lab_images_node, lab_images_helper, '--scope', 'workspaces'\] \+ lab_images_checkouts \}\}$/m);
  });
});
