/**
 * The pins lab-images.mjs plans from, read from one checkout of this
 * repository: every value of IMAGES in vps-agent/lib/capabilities.js and the
 * workspace image of every Coder template under lab-host/coder/templates.
 * Split out of lab-images.mjs by job (#1845); it runs beside that file, from
 * the role's files/ folder in the same checkout, with Node built-ins only.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Where the pins live, relative to a checkout of this repository. */
export const CAPABILITIES_FILE = 'vps-agent/lib/capabilities.js';
/** Every directory here is a Coder template, and its WORKSPACE_TEMPLATE_FILE pins its image. */
export const WORKSPACE_TEMPLATES_DIR = 'lab-host/coder/templates';
export const WORKSPACE_TEMPLATE_FILE = 'main.tf';

/**
 * The lab's own repositories beyond the ones the pins name: the images
 * lab-image/ builds and publish-lab-image.yml pushes. A stale image here is
 * removed even when no current pin names its repository.
 *
 * Matched against the familiar form, so Docker Hub's appears without its
 * host. The GHCR alternative stays after the move to Docker Hub only
 * (2026-10-08): the host still holds images pulled from there, and this is
 * what lets the first run after the move remove them once no pin names them.
 */
export const LAB_REPOSITORY_PATTERN = /^(?:ghcr\.io\/)?hybridcloudworks\/hcw-lab[a-z0-9._-]*$/;

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PATH_COMPONENT = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
const REPOSITORY = new RegExp(`^(?:[a-zA-Z0-9.-]+(?::[0-9]+)?/)?${PATH_COMPONENT}(?:/${PATH_COMPONENT})*$`);
const TAG = /^[\w][\w.-]{0,127}$/;

/**
 * Docker's familiar form of a repository name, the form /images/json uses in
 * RepoTags and RepoDigests: Docker Hub's host and its `library/` namespace
 * are dropped, so `docker.io/library/alpine` and `alpine` compare equal.
 */
export function familiarRepository(repository) {
  let name = repository;
  for (const hub of ['docker.io/', 'index.docker.io/', 'registry-1.docker.io/']) {
    if (name.startsWith(hub)) {
      name = name.slice(hub.length);
      break;
    }
  }
  if (name.startsWith('library/') && name.split('/').length === 2) {
    name = name.slice('library/'.length);
  }
  return name;
}

/**
 * Split an image reference into repository (familiar form), tag and digest.
 * Returns null for anything that is not a reference, such as Docker's
 * `<none>:<none>` placeholder.
 */
export function parseReference(reference) {
  if (typeof reference !== 'string') return null;
  let name = reference;
  let digest = null;
  const at = name.indexOf('@');
  if (at !== -1) {
    digest = name.slice(at + 1);
    name = name.slice(0, at);
    if (!DIGEST.test(digest)) return null;
  }
  let tag = null;
  const colon = name.lastIndexOf(':');
  if (colon > name.lastIndexOf('/')) {
    tag = name.slice(colon + 1);
    name = name.slice(0, colon);
    if (!TAG.test(tag)) return null;
  }
  if (!REPOSITORY.test(name)) return null;
  return { repository: familiarRepository(name), tag, digest };
}

/** The reference Docker lists for a parsed reference, digest first. */
export function formatReference({ repository, tag, digest }) {
  return digest ? `${repository}@${digest}` : `${repository}:${tag}`;
}

/**
 * One pin, checked: it must carry a digest. `source` names where it came
 * from, so a refusal says which entry to fix.
 */
export function pinFrom(reference, source) {
  const parsed = parseReference(reference);
  if (!parsed || !parsed.digest) {
    throw new Error(
      `${source} is ${JSON.stringify(reference)}, which is not an image pinned by digest (name[:tag]@sha256:<64 hex>)`
    );
  }
  return {
    source,
    reference,
    repository: parsed.repository,
    digest: parsed.digest,
    pull: `${parsed.repository}@${parsed.digest}`,
  };
}

/** Terraform source with comment lines removed, so a commented-out local is not read. */
function codeLines(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*(#|\/\/)/.test(line))
    .join('\n');
}

function onlyMatch(text, pattern, what, source) {
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(
      `${source}: expected exactly one ${what}, found ${matches.length}; the lab_images plan reads the workspace image from it`
    );
  }
  return matches[0][1];
}

/**
 * The workspace image a Coder template runs: the local its main.tf builds as
 * "<repository>@${local.image_digest}", named `image` in hcw-lab and
 * `default_image` in the guided-lab templates (#1268). Either name, but
 * exactly one of them, so a template that pins two images is refused rather
 * than half planned.
 */
export function workspaceImageFromTemplate(text, source) {
  const code = codeLines(text);
  const digest = onlyMatch(
    code,
    /^\s*image_digest\s*=\s*"(sha256:[0-9a-f]{64})"\s*$/gm,
    '`image_digest = "sha256:<64 hex>"` local',
    source
  );
  const repository = onlyMatch(
    code,
    /^\s*(?:default_)?image\s*=\s*"([^"@$]+)@\$\{local\.image_digest\}"\s*$/gm,
    '`image = "<repository>@${local.image_digest}"` or `default_image = "<repository>@${local.image_digest}"` local',
    source
  );
  return pinFrom(`${repository}@${digest}`, source);
}

/**
 * The main.tf of every template under WORKSPACE_TEMPLATES_DIR in a checkout,
 * one per directory there, in name order so the plan does not follow the
 * filesystem's. A checkout with no template is refused: a plan with no
 * workspace image would leave every first start to pull one.
 */
export async function workspaceTemplateFiles(checkout) {
  const templatesDir = path.resolve(checkout, WORKSPACE_TEMPLATES_DIR);
  const entries = await readdir(templatesDir, { withFileTypes: true });
  const templates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (templates.length === 0) {
    throw new Error(`${templatesDir} holds no template directory; the lab_images plan reads the workspace image from each`);
  }
  return templates.map((name) => path.join(templatesDir, name, WORKSPACE_TEMPLATE_FILE));
}

/** The pins one checkout carries: the capability images and every template's workspace image. */
export async function readPins(checkout) {
  const capabilitiesPath = path.resolve(checkout, CAPABILITIES_FILE);
  const { IMAGES } = await import(pathToFileURL(capabilitiesPath).href);
  if (!IMAGES || typeof IMAGES !== 'object' || Object.keys(IMAGES).length === 0) {
    throw new Error(`${capabilitiesPath} exports no IMAGES entries`);
  }
  const capabilities = Object.entries(IMAGES).map(([key, reference]) =>
    pinFrom(reference, `IMAGES.${key} in ${capabilitiesPath}`)
  );
  const workspaces = [];
  for (const templatePath of await workspaceTemplateFiles(checkout)) {
    workspaces.push(workspaceImageFromTemplate(await readFile(templatePath, 'utf8'), templatePath));
  }
  return { checkout: path.resolve(checkout), capabilities, workspaces };
}
