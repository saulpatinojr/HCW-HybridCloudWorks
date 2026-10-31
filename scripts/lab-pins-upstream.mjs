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
 *                         newest digest of the base image's release line,
 *                         and its ANSIBLE_CORE_* lines to ansible-core's
 *                         newest release in its line (PyPI's wheel hashes)
 *   --bump image-tools    lab-image/versions.env and lab-image/README.md, to
 *                         the newest release of each tool (Terraform,
 *                         kubeconform, Helm, kubectl, Azure CLI) and of each
 *                         Terraform provider in the mirror, with the sum the
 *                         publisher serves where it serves one
 *   --bump image-digests  vps-agent/lib/capabilities.js and the Coder
 *                         template, to the two digests named by --runner and
 *                         --full (publish-lab-image.yml passes what it pushed)
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

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const GROUP_VARS = join(REPO, 'lab-host', 'ansible', 'group_vars', 'all.yml');
const USER_AGENT =
  'HCW-HybridCloudWorks lab-pins-upstream (+https://github.com/saulpatinojr/HCW-HybridCloudWorks)';

// ── Version arithmetic ─────────────────────────────────────────────────────

/** `5:29.8.1-1~ubuntu.26.04~resolute` → `29.8.1`; `v2.11.4` → `2.11.4`; `18.6` → `18.6`. */
export function coreVersion(value) {
  const s = String(value ?? '').trim();
  const m = s.match(/(\d+(?:\.\d+)+)/);
  return m ? m[1] : null;
}

/** Numeric, segment-wise comparison of dotted versions. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Newest of a list of version strings, by compareVersions; null when empty. */
export function newest(versions) {
  return versions.reduce((best, v) => (best === null || compareVersions(v, best) > 0 ? v : best), null);
}

const STABLE = /^\d+(\.\d+)+$/;
const isStable = (v) => STABLE.test(v);

// ── Reading the pins ───────────────────────────────────────────────────────

/** The scalar value of `key: value` on its own line, quotes stripped; null when absent. */
export function scalar(text, key) {
  const m = text.match(new RegExp(`^\\s*${key}:\\s*"?([^"\\n#]+?)"?\\s*(?:#.*)?$`, 'm'));
  return m ? m[1].trim() : null;
}

/** The pins this script watches, read from group_vars/all.yml. */
export function readPins(text) {
  // docker_release_pins is nested: take the resolute (26.04) block's values.
  const resolute = text.match(/^docker_release_pins:\s*\n\s+resolute:\s*\n([\s\S]*?)\n\s+noble:/m)?.[1] ?? '';
  return {
    dockerEngine: coreVersion(scalar(resolute, 'engine')),
    containerd: coreVersion(scalar(resolute, 'containerd')),
    dockerBuildx: coreVersion(scalar(resolute, 'buildx')),
    dockerCompose: coreVersion(scalar(resolute, 'compose')),
    caddy: coreVersion(scalar(text, 'caddy_version')),
    caddyCloudflare: coreVersion(scalar(text, 'caddy_cloudflare_module_version')),
    coder: coreVersion(scalar(text, 'coder_image_tag')),
    postgres: coreVersion(scalar(text, 'coder_postgres_image_tag')),
    portainer: coreVersion(scalar(text, 'portainer_image_tag')),
    vault: coreVersion(scalar(text, 'vault_version')),
    nodeExporter: coreVersion(scalar(text, 'node_exporter_version')),
    node: coreVersion(scalar(text, 'labs_agent_node_version')),
    cosign: coreVersion(scalar(text, 'cosign_version')),
  };
}

// ── Upstream readers ───────────────────────────────────────────────────────

/**
 * The pauses before each second and third try of a read that failed in a way
 * a moment's wait can cure (#1447). A publisher behind a CDN can answer one
 * request with a 5xx or a 406 and the next with the file: on 2026-10-27 a
 * local run read Vault's index as HTTP 406 while the same address answered
 * 200 to every later request, and the product dropped out of that run.
 */
export const RETRY_DELAYS_MS = [2000, 5000];

/** A status worth asking again for, unchanged: a server error, or a 406 a different edge may not give. */
export const retryableStatus = (status) => status >= 500 || status === 406;

/**
 * How long one try may take, the answer's body included, and how long one
 * read may take over all its tries and pauses. Node's own fetch has no limit
 * short of about five minutes, so a publisher that stops answering would
 * otherwise hold a try that long, and three of them would outlast the
 * `propose` job's 15 minutes on their own.
 */
export const TRY_TIMEOUT_MS = 30_000;
export const READ_BUDGET_MS = 60_000;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Why a try got no answer, in words: a timeout says so, a network error keeps its code (ECONNRESET). */
function noAnswer(error, timeoutMs) {
  if (error?.name === 'TimeoutError') return `no answer within ${Math.round(timeoutMs / 1000)} s`;
  const code = error?.cause?.code;
  return `${error?.message || String(error)}${code ? ` (${code})` : ''}`;
}

/** Let go of an answer whose body is not going to be read, so its connection is freed. */
const release = (response) => Promise.resolve(response?.body?.cancel?.()).catch(() => {});

/**
 * One read, tried again after each pause in `delays` when it fails with a
 * retryable status or gets no answer: a reset connection, a DNS failure, no
 * reply within TRY_TIMEOUT_MS, or a connection dropped while the body was
 * coming in. `read` takes the body (text, bytes) inside the try, so that last
 * case is tried again too. The request is the same every time, address and
 * headers alike: a retry that changed it would read something other than what
 * the pin rests on. Any other status fails at once, no try starts once
 * READ_BUDGET_MS is spent, and the last failure names the address, the status
 * or the reason, and how many tries it had. A caller's own `init.signal`
 * still cancels, and is not retried. `sleep`, `now` and `deadline` (the
 * timeout signal for one try) are injectable so the tests do not wait.
 */
export async function fetchRetrying(
  fetchImpl,
  url,
  init = {},
  {
    delays = RETRY_DELAYS_MS,
    sleep = pause,
    timeoutMs = TRY_TIMEOUT_MS,
    budgetMs = READ_BUDGET_MS,
    now = Date.now,
    deadline = (ms) => AbortSignal.timeout(ms),
    read = (response) => response,
  } = {}
) {
  const started = now();
  for (let attempt = 1; ; attempt += 1) {
    const limit = Math.min(timeoutMs, Math.max(budgetMs - (now() - started), 1));
    const timeout = deadline(limit);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let response = null;
    let status = null;
    let failure;
    try {
      response = await fetchImpl(url, { ...init, signal });
      if (response.ok) return await read(response);
      status = response.status;
      failure = `${url}: HTTP ${status}`;
    } catch (error) {
      if (init.signal?.aborted) throw error;
      failure = `${url}: ${noAnswer(error, limit)}`;
    }
    await release(response);
    if (status !== null && !retryableStatus(status)) throw new Error(failure);
    const wait = delays[attempt - 1];
    if (wait === undefined || now() - started + wait >= budgetMs) {
      throw new Error(attempt > 1 ? `${failure} (tried ${attempt} times)` : failure);
    }
    await sleep(wait);
  }
}

/** A JSON body, or an error that names where it came from. */
export function parseJsonFrom(url, text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${url}: the answer is not JSON (${error.message})`);
  }
}

/** The plain readers behind `sources`: text and JSON, each through fetchRetrying, the body read inside it. */
function makeFetchers({ fetchImpl = fetch, retry } = {}) {
  const fetchText = (url, headers = {}) =>
    fetchRetrying(fetchImpl, url, { headers: { 'User-Agent': USER_AGENT, ...headers } }, { ...retry, read: (r) => r.text() });
  const fetchJson = async (url, headers = {}) => parseJsonFrom(url, await fetchText(url, { Accept: 'application/json', ...headers }));
  return { fetchText, fetchJson };
}

/** A string as a regular-expression literal: every metacharacter escaped. */
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Newest stable version in a Debian Packages index for one package name. */
export function newestAptVersion(packagesText, packageName) {
  const versions = [];
  // The name is a literal (`containerd.io`), so its dot is escaped: unescaped
  // it would match any character, `containerdXio` included (CodeQL
  // js/regex/missing-regexp-anchor on #899).
  const header = new RegExp(`^Package: ${escapeRegExp(packageName)}$`, 'm');
  for (const stanza of packagesText.split(/\n\n+/)) {
    if (!header.test(stanza)) continue;
    const v = coreVersion(stanza.match(/^Version: (.+)$/m)?.[1]);
    if (v) versions.push(v);
  }
  return newest(versions);
}

/** Newest stable tag from a GitHub releases listing (prereleases and drafts skipped). */
export function newestGitHubRelease(releases) {
  const versions = releases
    .filter((r) => !r.prerelease && !r.draft)
    .map((r) => coreVersion(r.tag_name))
    .filter((v) => v && isStable(v));
  return newest(versions);
}

/** Newest stable tag from a GitHub tags listing (for a repository that tags but publishes no releases). */
export function newestGitHubTag(tags) {
  const versions = tags.map((t) => coreVersion(t.name)).filter((v) => v && isStable(v));
  return newest(versions);
}

/** Newest stable version from releases.hashicorp.com/<product>/index.json. */
export function newestHashicorp(index) {
  return newest(Object.keys(index.versions ?? {}).filter(isStable));
}

/** Newest tag in a Docker Hub tag listing that starts with `line.` (e.g. `18.` → 18.x). */
export function newestDockerHubTag(results, line) {
  const versions = results
    .map((t) => t.name)
    .filter((name) => new RegExp(`^${line.replace('.', '\\.')}\\.\\d+$`).test(name));
  return newest(versions);
}

/** Newest release in one major line from nodejs.org/dist/index.json. */
export function newestNodeLine(index, major) {
  const versions = index
    .map((e) => coreVersion(e.version))
    .filter((v) => v && v.startsWith(`${major}.`));
  return newest(versions);
}

function githubHeaders(env) {
  return env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {};
}

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
      [bump.VERSIONS_ENV_PATH, bump.DOCKERFILE_PATH, bump.SANDBOX_DOCKERFILE_PATH, bump.DOCKER_GUIDE_PAGE_PATH].map((p) => [
        p,
        read(p),
      ])
    );
    plan = await bump.planImageBase({ files, http });
  } else if (set === 'image-tools') {
    const files = Object.fromEntries([bump.VERSIONS_ENV_PATH, bump.README_PATH].map((p) => [p, read(p)]));
    plan = await bump.planImageTools({ files, http });
  } else {
    const files = Object.fromEntries([bump.CAPABILITIES_PATH, bump.CODER_TEMPLATE_PATH].map((p) => [p, read(p)]));
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
