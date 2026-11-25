/**
 * The lab_images role's plan: which lab images this host holds, which it has
 * to pull, and which stale ones it removes (roles/lab_images/README.md).
 *
 * The pins are read from checkouts of this repository, never copied, so a
 * pin bump reaches the host with no second edit:
 *
 *   - every value of `IMAGES` in vps-agent/lib/capabilities.js, read by
 *     importing that module, so Node itself is the parser and whatever the
 *     module exports is what gets pulled;
 *   - the Coder workspace image of every template under
 *     lab-host/coder/templates (each directory's main.tf), rebuilt from the
 *     template's `image_digest` local and its `image` (hcw-lab) or
 *     `default_image` (the guided labs) local the way Terraform does. Two
 *     templates on one digest are one pull; a template whose image cannot
 *     be read fails the plan, rather than leaving that image to a visitor's
 *     first start (#1268).
 *
 * Every pin must be `name[:tag]@sha256:<64 hex>`. A tag alone is refused,
 * as capabilities.test.js refuses it, because a mutable tag is the thing the
 * digest pins exist to rule out.
 *
 * Pulls are named `repository@digest`, without the tag. Docker ignores the
 * tag of a reference that carries a digest, and community.docker's
 * docker_image_pull splits `name:tag@digest` at the `@` and then looks for a
 * repository literally named `name:tag`, which it never finds, so the tagged
 * form would pull on every run.
 *
 * Removals are every reference Docker lists for an image in one of the lab's
 * own repositories (the repositories the pins name, and anything under
 * hybridcloudworks/hcw-lab* on Docker Hub or the former
 * ghcr.io/hybridcloudworks/hcw-lab*) when none of the image's references is
 * a pin. An image that a container, running or stopped, still uses is kept
 * and reported instead, and a reference in any other repository is never
 * listed, so an image that also carries one keeps its data.
 *
 * Usage, with the Docker API's /images/json and /containers/json?all=1 on
 * stdin as {"images": [...], "containers": [...]} (what
 * community.docker.docker_host_info returns with verbose_output):
 *
 *   node lab-images.mjs [--pull-workspace] [--scope all|jobs|workspaces] <checkout> [<checkout> ...]
 *
 * --scope says which daemon the listing came from (LAB-5, 2026-10-07). The
 * host daemon runs the jobs and holds the capability images (`jobs`); the
 * coder_sandbox role's rootless daemon runs the workspaces and holds the
 * workspace image (`workspaces`). In either, only that scope's images are
 * pins, so the other scope's images left in a daemon are removed like any
 * stale one. `all`, the default, is every pin in one daemon, with the
 * workspace image pulled only under --pull-workspace.
 *
 * Prints the plan as one JSON object on stdout. Exits 1, with the reason on
 * stderr, when a checkout lacks capabilities.js or a template's main.tf, has
 * no template at all, a pin is not a digest reference, or a template's image
 * cannot be found.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LAB_REPOSITORY_PATTERN, formatReference, parseReference, readPins } from './lab-images-pins.mjs';

// Reading the pins (the capability images and each Coder template's image) is
// in lab-images-pins.mjs beside this file (#1845); what it exports is
// re-exported here, so callers keep one import path.
export {
  CAPABILITIES_FILE,
  WORKSPACE_TEMPLATES_DIR,
  WORKSPACE_TEMPLATE_FILE,
  LAB_REPOSITORY_PATTERN,
  familiarRepository,
  parseReference,
  pinFrom,
  workspaceImageFromTemplate,
  workspaceTemplateFiles,
  readPins,
} from './lab-images-pins.mjs';

function unique(values) {
  return [...new Set(values)];
}

function containerName(container) {
  const [name] = container.Names || [];
  return name ? name.replace(/^\//, '') : String(container.Id || '').slice(0, 12);
}

/** Which daemon a plan is for: the host's (jobs), the sandbox's (workspaces), or one holding both. */
export const SCOPES = Object.freeze(['all', 'jobs', 'workspaces']);

/** The pins a daemon in `scope` holds, from one checkout's readPins result. */
function pinsInScope(checkout, scope) {
  if (scope === 'jobs') return checkout.capabilities;
  if (scope === 'workspaces') return checkout.workspaces;
  return [...checkout.capabilities, ...checkout.workspaces];
}

/**
 * The plan. `checkouts` is readPins' result for each checkout; the pins of
 * all of them are held (the union), so an agent held at an older commit keeps
 * its images while the playbook's commit gets its own. `scope` limits the
 * pins to one daemon's (SCOPES above).
 *
 * @returns {{
 *   pinned: string[],        every pin, as repository@digest
 *   pull: string[],          what to pull (docker_image_pull, pull: not_present)
 *   remove: string[],        references to remove (docker image rm), tags before digests
 * @returns {{
 *   pinned: string[],        every pin, as repository@digest
 *   pull: string[],          what to pull (docker_image_pull, pull: not_present)
 *   remove: string[],        references to remove (docker image rm), tags before digests
 *   deferred: string[],      stale workspace references retained because cleanup was deferred
 *   in_use: {image: string, references: string[], containers: string[]}[],
 *   checkouts: string[],
 * }}
 */
export function planImages({
  checkouts,
  pullWorkspace = false,
  scope = 'all',
  deferWorkspaceCleanup = false,
  images = [],
  containers = [],
}) {
  if (!SCOPES.includes(scope)) {
    throw new Error(`scope is ${JSON.stringify(scope)}; expected one of ${SCOPES.join(', ')}`);
  }
  const pins = checkouts.flatMap((c) => pinsInScope(c, scope));
  const pinned = new Set(pins.map((p) => p.pull));
  const pinnedRepositories = new Set(pins.map((p) => p.repository));
  const isLabRepository = (repository) =>
    pinnedRepositories.has(repository) || LAB_REPOSITORY_PATTERN.test(repository);
  const isWorkspaceRepository = (repository) =>
    checkouts.some((c) => c.workspaces.some((w) => w.repository === repository)) ||
    repository.endsWith('/hcw-lab') ||
    repository === 'hybridcloudworks/hcw-lab';

  // unique: two templates on one digest are one pull.
  const pull = unique(
    checkouts
      .flatMap((c) =>
        scope === 'all' ? [...c.capabilities, ...(pullWorkspace ? c.workspaces : [])] : pinsInScope(c, scope)
      )
      .map((p) => p.pull)
  );

  const remove = [];
  const deferred = [];
  const inUse = [];
  for (const image of images) {
    const references = unique([...(image.RepoTags || []), ...(image.RepoDigests || [])])
      .map(parseReference)
      .filter(Boolean);
    const ours = references.filter((r) => isLabRepository(r.repository));
    if (ours.length === 0) continue;
    if (references.some((r) => r.digest && pinned.has(`${r.repository}@${r.digest}`))) continue;

    // Tags first: in the classic image store, removing a digest reference
    // leaves the image's tags in place.
    const stale = unique([
      ...ours.filter((r) => !r.digest).map(formatReference),
      ...ours.filter((r) => r.digest).map(formatReference),
    ]);
    const users = containers.filter((c) => c.ImageID && c.ImageID === image.Id).map(containerName);
    if (users.length > 0) {
      inUse.push({ image: image.Id, references: stale, containers: users });
    } else if (deferWorkspaceCleanup && ours.some((r) => isWorkspaceRepository(r.repository))) {
      deferred.push(...stale);
    } else {
      remove.push(...stale);
    }
  }

  return {
    pinned: [...pinned],
    pull,
    remove: unique(remove),
    deferred: unique(deferred),
    in_use: inUse,
    checkouts: checkouts.map((c) => c.checkout),
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export async function main(args) {
  const pullWorkspace = args.includes('--pull-workspace');
  const deferWorkspaceCleanup = args.includes('--defer-workspace-cleanup');
  let scope = 'all';
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--pull-workspace' || args[i] === '--defer-workspace-cleanup') continue;
    if (args[i] === '--scope') {
      scope = args[i + 1];
      i += 1;
      continue;
    }
    rest.push(args[i]);
  }
  const checkoutArgs = unique(rest);
  if (checkoutArgs.length === 0 || !SCOPES.includes(scope)) {
    throw new Error(
      'usage: node lab-images.mjs [--pull-workspace] [--defer-workspace-cleanup] [--scope all|jobs|workspaces] <checkout> [<checkout> ...] < docker-host.json'
    );
  }
  const input = (await readStdin()).trim();
  const host = input ? JSON.parse(input) : {};
  const checkouts = [];
  for (const checkout of checkoutArgs) checkouts.push(await readPins(checkout));
  return planImages({
    checkouts,
    pullWorkspace,
    scope,
    deferWorkspaceCleanup,
    images: host.images || [],
    containers: host.containers || [],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (plan) => process.stdout.write(`${JSON.stringify(plan)}\n`),
    (error) => {
      process.stderr.write(`lab-images: ${error.message}\n`);
      process.exit(1);
    }
  );
}
