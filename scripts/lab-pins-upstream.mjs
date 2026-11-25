/**
 * lab-pins-upstream.mjs — are the lab host's pinned versions behind upstream?
 *
 * Everything on the lab host is pinned and held: Docker Engine and containerd
 * (which carries runc), Caddy and its Cloudflare module, Coder, PostgreSQL,
 * Portainer, Vault, node_exporter, Node.js. That is right for a host that runs
 * untrusted code — nothing moves without a reviewed change — and it has a
 * cost the 2026-10-06 estate review named (finding LAB-3): no mechanism
 * noticed when a pin fell behind, so a runc or containerd advisory after the
 * pin date stayed unpatched until a human happened to look. Dependabot cannot
 * read Ansible group_vars.
 *
 * This script is that mechanism's eyes. It reads the pins from
 * lab-host/ansible/group_vars/all.yml (by regex over the lines the pins are
 * on, not a YAML parser: the file is one document and every pin is a scalar
 * on its own line), asks each publisher for its newest stable version, and
 * prints a table. Exit 0 when every pin is current, 1 when one is behind, 2
 * when a source could not be read — the last is "cannot evaluate", not
 * "fine", for the reason .claude/CLAUDE.md gives: a check that cannot run has
 * not run.
 *
 * Run plainly, it bumps nothing: .github/workflows/lab-supply-chain.yml turns
 * a non-zero exit into an issue that names what moved.
 *
 * With --bump it also makes the edits, for one pin set at a time (#949):
 *
 *   --bump host           group_vars/all.yml, for every row reported BEHIND,
 *                         and for a current image tag or apt package the
 *                         publisher rebuilt under the same name
 *   --bump image-base     lab-image/versions.env and its FROM lines, to the
 *                         newest digest of the base image's release line
 *                         (and the base tag and CPython release the Docker
 *                         guide page and lab-image/README.md name), and its
 *                         ANSIBLE_CORE_* lines to ansible-core's newest
 *                         release in its line (PyPI's wheel hashes)
 *   --bump image-tools    lab-image/versions.env and lab-image/README.md, to
 *                         the newest release of each tool (Terraform,
 *                         kubeconform, Helm, kubectl, Azure CLI) and of each
 *                         Terraform provider in the mirror, with the sum the
 *                         publisher serves where it serves one
 *   --bump image-digests  vps-agent/lib/capabilities.js and every Coder
 *                         template that runs hcw-lab, to the two digests
 *                         named by --runner and --full (publish-lab-image.yml
 *                         passes what it pushed)
 *
 * Each edit carries the checksum or digest read from the publisher beside the
 * version (scripts/lib/lab-pin-bumps.mjs says what is read from where); a pin
 * whose checksum cannot be verified is not edited and becomes a note, and so
 * does a product whose publisher could not be read, with the address and the
 * status it got. Every read that fails with a server error, a 406 or no
 * answer (each try is limited to 30 seconds) is tried again after a short
 * pause first (fetchRetrying, #1447).
 * --evidence and --notes write the two Markdown sections the pull request
 * body and the weekly issue are made of. --dry-run prints the planned edits
 * and writes no repository file. Exit 0 when the plan was made (with or
 * without edits), 2 when it could not be.
 *
 * Usage: node scripts/lab-pins-upstream.mjs [--summary <file>]
 *        node scripts/lab-pins-upstream.mjs --bump <set> [--dry-run]
 *             [--evidence <file>] [--notes <file>] [--runner <ref> --full <ref>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { compareVersions, readPins } from './lib/lab-pins-versions.mjs';
import { githubHeaders, makeFetchers, newestAptVersion, newestDockerHubTag, newestGitHubRelease, newestGitHubTag, newestHashicorp, newestNodeLine } from './lib/lab-pins-fetch.mjs';
// The parts below now live in their own files; they are exported from here too, so callers keep their imports.
export { coreVersion, compareVersions, newest, scalar, readPins } from './lib/lab-pins-versions.mjs';
export { RETRY_DELAYS_MS, retryableStatus, JSON_ACCEPT, TRY_TIMEOUT_MS, READ_BUDGET_MS, fetchRetrying, parseJsonFrom, newestAptVersion, newestGitHubRelease, newestGitHubTag, newestHashicorp, newestDockerHubTag, newestNodeLine } from './lib/lab-pins-fetch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const GROUP_VARS = join(REPO, 'lab-host', 'ansible', 'group_vars', 'all.yml');

/**
 * Every source, each returning the newest stable version or throwing. `http`
 * is for the tests: a fake `fetchImpl` and a `retry` that does not sleep.
 */
export function sources(env = process.env, http = {}) {
  const { fetchText, fetchJson } = makeFetchers(http);
  // One reader per product: read `url`, pick the newest stable version from
  // it, and name the address when there is none, so a note can say where.
  const reader = (url, pick, { json = true, headers } = {}) => async () => {
    const body = await (json ? fetchJson : fetchText)(url, headers);
    let version;
    try {
      version = pick(body);
    } catch (error) {
      throw new Error(`${url}: ${error?.message || String(error)}`);
    }
    if (!version) throw new Error(`${url}: no stable version found`);
    return version;
  };
  const gh = (repo) => reader(`https://api.github.com/repos/${repo}/releases?per_page=30`, newestGitHubRelease, { headers: githubHeaders(env) });
  // caddy-dns/cloudflare tags its versions and publishes no releases.
  const ghTags = (repo) => reader(`https://api.github.com/repos/${repo}/tags?per_page=30`, newestGitHubTag, { headers: githubHeaders(env) });
  const dockerApt = 'https://download.docker.com/linux/ubuntu/dists/resolute/stable/binary-amd64/Packages';
  const apt = (name) => reader(dockerApt, (text) => newestAptVersion(text, name), { json: false });
  return {
    dockerEngine: apt('docker-ce'),
    containerd: apt('containerd.io'),
    dockerBuildx: apt('docker-buildx-plugin'),
    dockerCompose: apt('docker-compose-plugin'),
    caddy: gh('caddyserver/caddy'),
    caddyCloudflare: ghTags('caddy-dns/cloudflare'),
    coder: gh('coder/coder'),
    postgres: reader('https://hub.docker.com/v2/repositories/library/postgres/tags?page_size=100&name=18.', (page) =>
      newestDockerHubTag(page.results, '18')
    ),
    portainer: gh('portainer/portainer'),
    vault: reader('https://releases.hashicorp.com/vault/index.json', newestHashicorp),
    nodeExporter: gh('prometheus/node_exporter'),
    node: reader('https://nodejs.org/dist/index.json', (index) => newestNodeLine(index, 26)),
    cosign: gh('sigstore/cosign'),
  };
}

export const LABELS = {
  dockerEngine: 'Docker Engine (docker-ce, Ubuntu 26.04 apt)',
  containerd: 'containerd.io (carries runc)',
  dockerBuildx: 'docker-buildx-plugin',
  dockerCompose: 'docker-compose-plugin',
  caddy: 'Caddy',
  caddyCloudflare: 'caddy-dns/cloudflare',
  coder: 'Coder',
  postgres: 'PostgreSQL image (18 line)',
  portainer: 'Portainer',
  vault: 'HashiCorp Vault',
  nodeExporter: 'node_exporter',
  node: 'Node.js (26 line)',
  cosign: 'Sigstore cosign',
};

// ── Run ────────────────────────────────────────────────────────────────────

/** Compare pins to upstream; returns rows and a verdict. Injectable for tests. */
export async function check({ pins, readers }) {
  const rows = [];
  for (const key of Object.keys(LABELS)) {
    const pinned = pins[key];
    let latest = null;
    let error = null;
    try {
      latest = await readers[key]();
      if (!latest) throw new Error('no stable version found');
    } catch (e) {
      error = e?.message || String(e);
    }
    let status;
    if (!pinned) status = 'pin not found';
    else if (error) status = `unreadable: ${error}`;
    else status = compareVersions(pinned, latest) < 0 ? 'BEHIND' : 'current';
    rows.push({ key, label: LABELS[key], pinned, latest, status });
  }
  const unreadable = rows.some((r) => r.status.startsWith('unreadable') || r.status === 'pin not found');
  const behind = rows.some((r) => r.status === 'BEHIND');
  return { rows, exitCode: unreadable ? 2 : behind ? 1 : 0 };
}

export function renderMarkdown(rows) {
  const lines = ['| Component | Pinned | Newest stable | Status |', '| --- | --- | --- | --- |'];
  for (const r of rows) lines.push(`| ${r.label} | ${r.pinned ?? '—'} | ${r.latest ?? '—'} | ${r.status} |`);
  return lines.join('\n');
}

/** The value after a flag, or null. */
export function flag(argv, name) {
  const at = argv.indexOf(name);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : null;
}

export const BUMP_SETS = ['host', 'image-base', 'image-tools', 'image-digests'];

/**
 * --bump <set>: plan the set's edits from publisher reads, print them, and
 * (without --dry-run) write them. The pull request is not opened here:
 * scripts/open-lab-pin-pr.mjs does that, in a job that holds the App token
 * and no network input of its own.
 */
async function bumpMain(argv) {
  const set = flag(argv, '--bump');
  if (!BUMP_SETS.includes(set)) {
    console.error(`--bump takes one of ${BUMP_SETS.join(', ')}`);
    return 2;
  }
  const dryRun = argv.includes('--dry-run');
  const bump = await import('./lib/lab-pin-bumps.mjs');
  const http = bump.makeHttp(fetch, { githubToken: process.env.GITHUB_TOKEN });
  const read = (path) => readFileSync(join(REPO, path), 'utf8');

  let plan;
  if (set === 'host') {
    const text = read(bump.GROUP_VARS_PATH);
    const files = {
      [bump.CADDY_TEST_PATH]: read(bump.CADDY_TEST_PATH),
      [bump.BOOTSTRAP_PATH]: read(bump.BOOTSTRAP_PATH),
    };
    const { rows } = await check({ pins: readPins(text), readers: sources() });
    plan = await bump.planHost({ text, files, rows, http });
  } else if (set === 'image-base') {
    const files = Object.fromEntries(
      [bump.VERSIONS_ENV_PATH, bump.DOCKERFILE_PATH, bump.SANDBOX_DOCKERFILE_PATH, bump.DOCKER_GUIDE_PAGE_PATH, bump.README_PATH].map((p) => [
        p,
        read(p),
      ])
    );
    plan = await bump.planImageBase({ files, http });
  } else if (set === 'image-tools') {
    const files = Object.fromEntries([bump.VERSIONS_ENV_PATH, bump.README_PATH].map((p) => [p, read(p)]));
    plan = await bump.planImageTools({ files, http });
  } else {
    const files = Object.fromEntries([bump.CAPABILITIES_PATH, ...bump.CODER_TEMPLATE_PATHS].map((p) => [p, read(p)]));
    plan = await bump.planImageDigests({ files, http, runner: flag(argv, '--runner'), full: flag(argv, '--full') });
  }

  const date = new Date().toISOString().slice(0, 10);
  process.stdout.write(`## Pin set: ${set}${dryRun ? ' (dry run: nothing written)' : ''}\n\n`);
  process.stdout.write(bump.renderPlan(plan.applied));
  const notes = bump.renderNotes(plan.notes);
  if (notes) process.stdout.write(`\n${notes}`);

  if (!dryRun) {
    for (const [path, text] of Object.entries(plan.files)) {
      if (text !== read(path)) writeFileSync(join(REPO, path), text);
    }
  }
  const evidenceAt = flag(argv, '--evidence');
  const notesAt = flag(argv, '--notes');
  if (evidenceAt) writeFileSync(evidenceAt, bump.renderEvidence(plan.applied, { set, date }));
  if (notesAt) writeFileSync(notesAt, notes);
  return 0;
}

async function main(argv) {
  if (argv.includes('--bump')) {
    process.exitCode = await bumpMain(argv);
    return;
  }
  const summaryAt = flag(argv, '--summary');
  const pins = readPins(readFileSync(GROUP_VARS, 'utf8'));
  const { rows, exitCode } = await check({ pins, readers: sources() });
  const table = renderMarkdown(rows);
  const heading =
    exitCode === 0
      ? 'Every lab host pin is current.'
      : exitCode === 1
        ? 'At least one lab host pin is behind upstream.'
        : 'At least one source could not be read; the check did not evaluate.';
  const out = `## Lab host pins against upstream\n\n${heading}\n\n${table}\n`;
  process.stdout.write(out);
  if (summaryAt) writeFileSync(summaryAt, out);
  process.exitCode = exitCode;
}

if (process.argv[1] && process.argv[1].endsWith('lab-pins-upstream.mjs')) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 2;
  });
}
