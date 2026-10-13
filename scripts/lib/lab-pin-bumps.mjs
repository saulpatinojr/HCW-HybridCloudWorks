/**
 * lab-pin-bumps.mjs — the edits behind `lab-pins-upstream.mjs --bump`, each
 * with the checksum or digest it rests on (estate review 2026-10-06, LAB-3).
 *
 * The rule this module exists to keep: a pin moves only together with a
 * checksum or digest read from its publisher, and the pull request that moves
 * it says where each value was read. A version with no verifiable checksum is
 * not a bump; it becomes a note for the weekly issue instead, and nothing is
 * edited for it. So every planner below either returns edits AND evidence, or
 * a note, never edits alone.
 *
 * Three pin sets, one pull request each (.github/workflows/lab-supply-chain.yml
 * and publish-lab-image.yml open them, scripts/open-lab-pin-pr.mjs keeps one
 * per set):
 *
 *   host           lab-host/ansible/group_vars/all.yml, for every row
 *                  lab-pins-upstream.mjs reports BEHIND.
 *   image-base     lab-image/versions.env and the FROM lines it governs: the
 *                  newest digest of the base image's release line.
 *   image-digests  vps-agent/lib/capabilities.js and the Coder template: the
 *                  two digests a publish from main just pushed.
 *
 * What each value is read from, by kind:
 *
 *   apt package    the publisher's Packages index (the .deb's SHA256), and the
 *                  index's own SHA256 as InRelease lists it. apt on the host
 *                  verifies InRelease's signature against the pinned key; this
 *                  checks the chain below it.
 *   image tag      the registry's manifest for the tag, whose bytes are hashed
 *                  here and must equal its Docker-Content-Digest, and for
 *                  Docker Hub images the Hub API's digest for the same tag,
 *                  which must agree. Two disagreeing reads are a note.
 *   release file   the publisher's checksum file (HashiCorp SHA256SUMS,
 *                  node_exporter sha256sums.txt).
 *   Go module      the Go checksum database's h1: hash (sum.golang.org), the
 *                  one xcaddy's own build verifies against.
 *
 * Prose beside a pin ("read 2026-09-26 ...") is not rewritten: it records the
 * last hand read. The pull request body carries this run's evidence, and the
 * squash commit keeps it.
 */
import { createHash } from 'node:crypto';
import { coreVersion, compareVersions } from '../lab-pins-upstream.mjs';

export const USER_AGENT =
  'HCW-HybridCloudWorks lab-pins-upstream (+https://github.com/saulpatinojr/HCW-HybridCloudWorks)';

export const GROUP_VARS_PATH = 'lab-host/ansible/group_vars/all.yml';
export const VERSIONS_ENV_PATH = 'lab-image/versions.env';
export const DOCKERFILE_PATH = 'lab-image/Dockerfile';
export const SANDBOX_DOCKERFILE_PATH = 'lab-image/sandbox-template/Dockerfile';
export const CAPABILITIES_PATH = 'vps-agent/lib/capabilities.js';
export const CODER_TEMPLATE_PATH = 'lab-host/coder/templates/hcw-lab/main.tf';
/**
 * Files held to a pin that a bump must move with it, or the bump's own pull
 * request fails its checks (#1122 and #1123 did, on 2026-10-13): the caddy
 * test verifies the release it downloads against CADDY_SHA512; the Docker CLI
 * request fixture records the CLI the host pins (scripts/lab/
 * record-docker-cli-fixture.mjs re-records it); the Docker guide page names
 * the lab image's base tag and CPython release in its prose and commands.
 */
export const CADDY_TEST_PATH = 'lab-host/ansible/roles/caddy/tests/caddy-adapt.test.sh';
export const DOCKER_CLI_FIXTURE_PATH = 'scripts/fixtures/docker-cli-agent-requests.json';
export const DOCKER_GUIDE_PAGE_PATH = 'frontend/src/pages/docker/BuildingImagesPage.jsx';

// Docker Hub only since 2026-10-08. GHCR was the first stop until the
// repository left the HybridCloudWorks organisation, whose package namespace
// its token can no longer write.
export const RUNNER_IMAGE = 'docker.io/hybridcloudworks/hcw-lab-runner';
export const FULL_IMAGE = 'docker.io/hybridcloudworks/hcw-lab';

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── HTTP, memoised per run ─────────────────────────────────────────────────

/**
 * One fetcher per run. Each URL is read once even when two bumps need it (the
 * Docker Packages index serves four), so every bump in one pull request rests
 * on the same reading.
 */
export function makeHttp(fetchImpl = fetch, { githubToken } = {}) {
  const cache = new Map();
  function raw(url, headers = {}) {
    const auth = githubToken && url.startsWith('https://api.github.com/') ? { Authorization: `Bearer ${githubToken}` } : {};
    const all = { 'User-Agent': USER_AGENT, ...auth, ...headers };
    const key = `${url} ${JSON.stringify(all)}`;
    if (!cache.has(key)) {
      cache.set(
        key,
        (async () => {
          const response = await fetchImpl(url, { headers: all });
          if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
          return { body: Buffer.from(await response.arrayBuffer()), headers: response.headers };
        })()
      );
    }
    return cache.get(key);
  }
  return {
    raw,
    text: async (url, headers) => (await raw(url, headers)).body.toString('utf8'),
    json: async (url, headers) => JSON.parse((await raw(url, { Accept: 'application/json', ...headers })).body.toString('utf8')),
  };
}

// ── Container registries ───────────────────────────────────────────────────

export const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/**
 * Where an image lives: GHCR for ghcr.io/…, Docker Hub otherwise (`library/` for
 * an official image). An explicit `docker.io/` is Docker Hub too, and is not
 * part of the repository name the registry API takes.
 */
export function registryOf(image) {
  if (image.startsWith('ghcr.io/')) {
    const repository = image.slice('ghcr.io/'.length);
    return {
      host: 'ghcr.io',
      repository,
      tokenUrl: `https://ghcr.io/token?scope=repository:${repository}:pull`,
      hubTags: null,
    };
  }
  const name = image.startsWith('docker.io/') ? image.slice('docker.io/'.length) : image;
  const repository = name.includes('/') ? name : `library/${name}`;
  return {
    host: 'registry-1.docker.io',
    repository,
    tokenUrl: `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`,
    hubTags: `https://hub.docker.com/v2/repositories/${repository}/tags/`,
  };
}

/** `name[:tag][@sha256:…]` → its parts; null when it is not one. */
export function parseImageRef(ref) {
  const m = String(ref ?? '').match(/^([a-z0-9][a-z0-9._/-]*?)(?::([A-Za-z0-9._-]+))?(?:@(sha256:[0-9a-f]{64}))?$/);
  return m ? { name: m[1], tag: m[2] ?? null, digest: m[3] ?? null } : null;
}

/**
 * A manifest by tag or digest, its bytes hashed here. The hash IS the digest
 * (content addressing), so a Docker-Content-Digest header that disagrees with
 * the bytes is refused rather than believed.
 */
export async function readManifest(http, image, reference) {
  const registry = registryOf(image);
  const { token } = await http.json(registry.tokenUrl);
  const url = `https://${registry.host}/v2/${registry.repository}/manifests/${reference}`;
  const { body, headers } = await http.raw(url, { Authorization: `Bearer ${token}`, Accept: MANIFEST_TYPES });
  const digest = `sha256:${sha256Hex(body)}`;
  const header = headers.get('docker-content-digest');
  if (header && header !== digest) {
    throw new Error(`${url}: Docker-Content-Digest says ${header}, but the bytes served hash to ${digest}`);
  }
  return { digest, manifest: JSON.parse(body.toString('utf8')), url, token };
}

/**
 * A tag's digest, read twice where the publisher offers two readings: the
 * registry (above) and, for Docker Hub, the Hub API's record of the same tag.
 * They must agree; a tag re-pushed between the two reads fails here and is
 * tried again next week rather than half-believed.
 */
export async function resolveTag(http, image, tag) {
  const primary = await readManifest(http, image, tag);
  const reads = [`${primary.url} (manifest bytes hashed; Docker-Content-Digest agreed)`];
  const registry = registryOf(image);
  if (registry.hubTags) {
    const hubUrl = `${registry.hubTags}${encodeURIComponent(tag)}`;
    const hub = await http.json(hubUrl);
    if (hub.digest !== primary.digest) {
      throw new Error(`${image}:${tag}: the registry serves ${primary.digest}, but Docker Hub's API reports ${hub.digest}`);
    }
    reads.push(`${hubUrl} (Docker Hub API, same digest)`);
  }
  return { digest: primary.digest, manifest: primary.manifest, token: primary.token, reads };
}

/** The linux/amd64 image config's Env, from an index; every hop hashed against the digest that named it. */
export async function imageEnv(http, image, index) {
  const registry = registryOf(image);
  const entry = (index.manifests ?? []).find((m) => m.platform?.os === 'linux' && m.platform?.architecture === 'amd64');
  if (!entry) throw new Error(`${image}: the index has no linux/amd64 manifest`);
  const manifest = await readManifest(http, image, entry.digest);
  if (manifest.digest !== entry.digest) throw new Error(`${image}: manifest ${entry.digest} hashed to ${manifest.digest}`);
  const configDigest = manifest.manifest.config?.digest;
  if (!configDigest) throw new Error(`${image}: the linux/amd64 manifest names no config`);
  const blob = await http.raw(`https://${registry.host}/v2/${registry.repository}/blobs/${configDigest}`, {
    Authorization: `Bearer ${manifest.token}`,
  });
  if (`sha256:${sha256Hex(blob.body)}` !== configDigest) throw new Error(`${image}: config blob does not hash to ${configDigest}`);
  return JSON.parse(blob.body.toString('utf8')).config?.Env ?? [];
}

// ── Package indexes and checksum files ─────────────────────────────────────

/** Every stanza for one package in a Debian Packages index. */
export function aptStanzas(packagesText, name) {
  return String(packagesText)
    .split(/\n\n+/)
    .filter((stanza) => new RegExp(`^Package: ${escapeRe(name)}$`, 'm').test(stanza))
    .map((stanza) => ({
      version: stanza.match(/^Version: (.+)$/m)?.[1]?.trim() ?? null,
      sha256: stanza.match(/^SHA256: ([0-9a-f]{64})$/m)?.[1] ?? null,
      filename: stanza.match(/^Filename: (.+)$/m)?.[1]?.trim() ?? null,
    }));
}

/**
 * Order two Debian version strings of one package in one suite by their
 * numeric runs (epoch, upstream, revision): `0.37.1-2~ubuntu…` is newer than
 * `0.37.1-1~ubuntu…`. Not dpkg's full algorithm, which these indexes never
 * need: within one suite of one publisher the strings differ only in numbers.
 */
export function compareDebian(a, b) {
  const pa = String(a).match(/\d+/g)?.map(Number) ?? [];
  const pb = String(b).match(/\d+/g)?.map(Number) ?? [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if ((pa[i] ?? -1) !== (pb[i] ?? -1)) return (pa[i] ?? -1) < (pb[i] ?? -1) ? -1 : 1;
  }
  return 0;
}

/**
 * The newest build of upstream version `core`: a publisher can rebuild a
 * release under a new Debian revision (0.37.1-1 → 0.37.1-2), and that is a
 * pin to move too. Throws on none, or on a pick without a SHA256.
 */
export function aptPick(packagesText, name, core) {
  const hits = aptStanzas(packagesText, name).filter((s) => coreVersion(s.version) === core);
  if (hits.length === 0) throw new Error(`${name} ${core} is not in the index`);
  const pick = hits.reduce((best, s) => (compareDebian(s.version, best.version) > 0 ? s : best));
  if (!pick.sha256) throw new Error(`${name} ${pick.version} carries no SHA256 in the index`);
  return pick;
}

/** The SHA256 an InRelease file lists for one index path (`stable/binary-amd64/Packages`). */
export function inReleaseSha256(inReleaseText, path) {
  const section = String(inReleaseText).split(/^SHA256:[ \t]*\r?$/m)[1] ?? '';
  for (const line of section.split('\n').slice(1)) {
    if (!/^\s/.test(line)) break;
    const [hash, , name] = line.trim().split(/\s+/);
    if (name === path) return hash;
  }
  return null;
}

/** The hex beside a file name in a `sha256sum`-format checksum file (`hexLength` 128 for a sha512sum one). */
export function sumsLine(sumsText, filename, hexLength = 64) {
  const re = new RegExp(`^([0-9a-f]{${hexLength}})\\s+\\*?(\\S+)$`);
  for (const line of String(sumsText).split('\n')) {
    const m = line.trim().match(re);
    if (m && m[2] === filename) return m[1];
  }
  return null;
}

/** The module zip's h1: hash from a sum.golang.org lookup. */
export function goSumHash(lookupText, module, version) {
  const m = String(lookupText).match(new RegExp(`^${escapeRe(module)} ${escapeRe(version)} (h1:[A-Za-z0-9+/=]+)$`, 'm'));
  return m ? m[1] : null;
}

/**
 * A Packages index read with its InRelease, the index's own hash checked
 * against the list. `verifyInRelease(text, url)`, when given, is awaited on
 * the InRelease text before anything is trusted from it, and throws to refuse
 * it: the bumps read these indexes for evidence over TLS alone, but a caller
 * that goes on to run what it downloads (record-docker-cli-fixture.mjs)
 * verifies the publisher's signature with it.
 */
export async function aptIndex(http, base, suitePath, component, { verifyInRelease } = {}) {
  const indexPath = `${component}/binary-amd64/Packages`;
  const packagesUrl = `${base}/${suitePath}/${indexPath}`;
  const inReleaseUrl = `${base}/${suitePath}/InRelease`;
  const [{ body }, inRelease] = await Promise.all([http.raw(packagesUrl), http.text(inReleaseUrl)]);
  if (verifyInRelease) await verifyInRelease(inRelease, inReleaseUrl);
  const listed = inReleaseSha256(inRelease, indexPath);
  const computed = sha256Hex(body);
  if (listed !== computed) {
    throw new Error(`${packagesUrl} hashes to ${computed}, but ${inReleaseUrl} lists ${listed ?? 'nothing'} for it`);
  }
  return { text: body.toString('utf8'), packagesUrl, inReleaseUrl, indexSha256: computed };
}

// ── Text edits (exactly one match, or refuse) ──────────────────────────────

const blank = (line) => /^\s*(#.*)?$/.test(line);
const indentOf = (line) => line.match(/^ */)[0].length;

/**
 * Set the scalar at a key path in a YAML file by editing its one line, so the
 * comments and layout around it survive. Each key must occur exactly once at
 * its level; the value keeps the quoting it had.
 */
/** The one line in [start, end) that holds `key:` at the shallowest indentation there. */
function findKey(lines, [start, end], key, where) {
  const levels = lines.slice(start, end).filter((l) => !blank(l)).map(indentOf);
  if (levels.length === 0) throw new Error(`${where}: nothing under the parent of \`${key}\``);
  const level = Math.min(...levels);
  const re = new RegExp(`^ {${level}}${escapeRe(key)}:(\\s|$)`);
  const hits = [];
  for (let i = start; i < end; i += 1) if (re.test(lines[i])) hits.push(i);
  if (hits.length !== 1) throw new Error(`${where}: expected one \`${key}:\` at its level, found ${hits.length}`);
  return { at: hits[0], level };
}

/** The lines nested under the key on line `at`, as a [start, end) range. */
function childrenOf(lines, at, level) {
  let end = at + 1;
  for (let i = at + 1; i < lines.length; i += 1) {
    if (blank(lines[i])) continue;
    if (indentOf(lines[i]) <= level) break;
    end = i + 1;
  }
  return [at + 1, end];
}

export function setYamlScalar(text, path, value) {
  const lines = String(text).split('\n');
  const where = path.join('.');
  let range = [0, lines.length];
  let at = -1;
  for (const key of path) {
    const found = findKey(lines, range, key, where);
    at = found.at;
    range = childrenOf(lines, at, found.level);
  }
  const m = lines[at].match(/^( *[^:#]+:[ \t]*)("?)([^"#\n]*?)("?)([ \t]+#.*)?$/);
  if (!m || !m[3]) throw new Error(`${path.join('.')}: line ${at + 1} is not a scalar on one line`);
  const from = m[3].trim();
  lines[at] = `${m[1]}${m[2]}${value}${m[4]}${m[5] ?? ''}`;
  return { text: lines.join('\n'), from, line: at + 1 };
}

/** Set `KEY=value` in a shell-assignment file (versions.env); exactly one line. */
export function setEnvValue(text, key, value) {
  const re = new RegExp(`^${escapeRe(key)}=(.*)$`, 'gm');
  const hits = [...String(text).matchAll(re)];
  if (hits.length !== 1) throw new Error(`${key}: expected one \`${key}=\` line, found ${hits.length}`);
  const from = hits[0][1];
  return { text: String(text).replace(re, `${key}=${value}`), from };
}

/** The values of a shell-assignment file, single-line ones only. */
export function readEnv(text) {
  const out = {};
  for (const m of String(text).matchAll(/^([A-Z][A-Z0-9_]*)=([^'\n]*)$/gm)) out[m[1]] = m[2];
  return out;
}

/** Replace every `FROM <old>` (the image@digest, not a stage) with `FROM <new>`; at least one, or refuse. */
export function replaceFrom(text, oldRef, newRef) {
  const re = new RegExp(`^(\\s*FROM\\s+)${escapeRe(oldRef)}(?=\\s|$)`, 'gim');
  const count = [...String(text).matchAll(re)].length;
  if (count === 0) throw new Error(`no FROM ${oldRef} line`);
  return { text: String(text).replace(re, `$1${newRef}`), from: oldRef, count };
}

/** Replace every occurrence of a literal; at least one, or refuse. */
export function replaceEvery(text, from, to, what) {
  const count = String(text).split(from).length - 1;
  if (count === 0) throw new Error(`${what}: no occurrence of ${from}`);
  return { text: String(text).split(from).join(to), from, count };
}

/** Replace the one match of a pattern's first group; refuse zero or two. */
export function replaceOne(text, pattern, value, what) {
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  const hits = [...String(text).matchAll(re)];
  if (hits.length !== 1) throw new Error(`${what}: expected one match, found ${hits.length}`);
  const [whole, group] = hits[0];
  const at = hits[0].index + whole.lastIndexOf(group);
  const next = String(text).slice(0, at) + value + String(text).slice(at + group.length);
  return { text: next, from: group };
}

// ── Applying a plan ────────────────────────────────────────────────────────

/**
 * Apply each bump's edits to a copy of the files; a bump whose edit cannot be
 * made exactly (the file is not shaped as expected) becomes a note and
 * changes nothing, so a half-applied bump cannot reach a pull request.
 */
export function applyBumps(files, bumps) {
  let current = { ...files };
  const applied = [];
  const notes = [];
  for (const bump of bumps) {
    const next = { ...current };
    const changes = [];
    try {
      for (const edit of bump.edits) {
        if (!(edit.file in next)) throw new Error(`${edit.file} was not read`);
        const result = edit.apply(next[edit.file]);
        changes.push({ file: edit.file, where: edit.where, from: result.from, to: edit.to });
        next[edit.file] = result.text;
      }
      current = next;
      applied.push({ ...bump, changes });
    } catch (error) {
      notes.push({ label: bump.label, from: bump.from, to: bump.to, reason: `the edit could not be made: ${error.message}` });
    }
  }
  return { files: current, applied, notes };
}

const yamlEdit = (path, to) => ({
  file: GROUP_VARS_PATH,
  where: path.join('.'),
  to,
  apply: (text) => setYamlScalar(text, path, to),
});

// ── Host pins (group_vars) ─────────────────────────────────────────────────

export const DOCKER_APT = 'https://download.docker.com/linux/ubuntu';
const DOCKER_CODENAMES = ['resolute', 'noble'];
const NODESOURCE = 'https://deb.nodesource.com/node_26.x';

/**
 * Marks a bumper that is also run for a row the check calls current, with the
 * pinned release: a publisher can rebuild a release without renaming it (a
 * re-pushed image tag on a patched base, a new Debian revision), and the
 * semantic version alone cannot see that. A checksum file for a released
 * version (Vault, node_exporter, the Go module) must never change, so those
 * are not refreshed.
 */
const refreshable = (bumper) => Object.assign(bumper, { refresh: true });

/**
 * A Docker apt pin, moved in every codename's entry together: the comment in
 * group_vars says the upstream versions are the same for both releases, and a
 * bump that could not keep that is a note. `alsoAt` names packages pinned to
 * the same version string (docker-ce-cli rides docker_version, and so, since
 * LAB-5 on 2026-10-07, does docker-ce-rootless-extras, which the coder_sandbox
 * role runs Coder's workspaces under), so a bump the host could not install
 * fails here instead.
 */
function dockerAptBumper(field, packageName, alsoAt = []) {
  return refreshable(async ({ http, latest }) => {
    const edits = [];
    const evidence = [];
    for (const codename of DOCKER_CODENAMES) {
      const index = await aptIndex(http, DOCKER_APT, `dists/${codename}`, 'stable');
      const stanza = aptPick(index.text, packageName, latest);
      evidence.push({
        item: `${packageName} ${stanza.version} (.deb SHA256)`,
        value: stanza.sha256,
        source: `${index.packagesUrl}, whose SHA256 ${index.indexSha256} is the one ${index.inReleaseUrl} lists`,
      });
      for (const other of alsoAt) {
        const twin = aptStanzas(index.text, other).find((s) => s.version === stanza.version);
        if (!twin?.sha256) throw new Error(`${other} ${stanza.version} is not in the ${codename} index, and it is installed at the same version`);
        evidence.push({ item: `${other} ${twin.version} (.deb SHA256)`, value: twin.sha256, source: index.packagesUrl });
      }
      edits.push(yamlEdit(['docker_release_pins', codename, field], stanza.version));
    }
    return { edits, evidence };
  });
}

/**
 * The docker-ce-cli package for one pinned engine version string, from a
 * codename's Packages index: its URL under DOCKER_APT and the SHA256 the
 * signed index lists, so the CLI the request fixture is recorded with is
 * verified the way the host's own install is (record-docker-cli-fixture.mjs).
 */
export function dockerCliDeb(indexText, pinnedVersion) {
  const stanza = aptStanzas(indexText, 'docker-ce-cli').find((s) => s.version === pinnedVersion);
  if (!stanza?.sha256 || !stanza.filename) {
    throw new Error(`docker-ce-cli ${pinnedVersion} is not in the index with a SHA256 and a Filename`);
  }
  return { url: `${DOCKER_APT}/${stanza.filename}`, sha256: stanza.sha256, version: stanza.version };
}

/** A Docker Hub or GHCR image pin: the tag and its index digest, together. */
function imageBumper({ image, tagKey, digestKey, tagFor, extra = () => [] }) {
  return refreshable(async ({ http, latest }) => {
    const tag = tagFor(latest);
    const resolved = await resolveTag(http, image, tag);
    return {
      edits: [yamlEdit([tagKey], tag), yamlEdit([digestKey], resolved.digest), ...extra(latest)],
      evidence: [{ item: `${image}:${tag} (index digest)`, value: resolved.digest, source: resolved.reads.join('; ') }],
    };
  });
}

/** How each BEHIND row of the check becomes edits and evidence. Keys match LABELS in lab-pins-upstream.mjs. */
export const HOST_BUMPERS = {
  dockerEngine: dockerAptBumper('engine', 'docker-ce', ['docker-ce-cli', 'docker-ce-rootless-extras']),
  containerd: dockerAptBumper('containerd', 'containerd.io'),
  dockerBuildx: dockerAptBumper('buildx', 'docker-buildx-plugin'),
  dockerCompose: dockerAptBumper('compose', 'docker-compose-plugin'),
  /**
   * Caddy: the builder image's tag and digest, caddy_version, and the SHA512
   * of the release tarball in the caddy test (CADDY_TEST_PATH), which that
   * test verifies before running the release it downloads. A bump that moved
   * the version alone failed `ansible-lint (lab-host)` on #1122.
   */
  caddy: refreshable(async ({ http, latest }) => {
    const tag = `${latest}-builder`;
    const resolved = await resolveTag(http, 'caddy', tag);
    const sumsUrl = `https://github.com/caddyserver/caddy/releases/download/v${latest}/caddy_${latest}_checksums.txt`;
    const tarball = `caddy_${latest}_linux_amd64.tar.gz`;
    const sha512 = sumsLine(await http.text(sumsUrl), tarball, 128);
    if (!sha512) throw new Error(`${sumsUrl} has no line for ${tarball}`);
    return {
      edits: [
        yamlEdit(['caddy_builder_image_tag'], tag),
        yamlEdit(['caddy_builder_image_digest'], resolved.digest),
        yamlEdit(['caddy_version'], `v${latest}`),
        {
          file: CADDY_TEST_PATH,
          where: 'CADDY_SHA512',
          to: sha512,
          apply: (t) => replaceOne(t, /^CADDY_SHA512='([0-9a-f]{128})'$/m, sha512, 'CADDY_SHA512'),
        },
      ],
      evidence: [
        { item: `caddy:${tag} (index digest)`, value: resolved.digest, source: resolved.reads.join('; ') },
        { item: `${tarball} (SHA512; caddy-adapt.test.sh verifies the release it runs against it)`, value: sha512, source: sumsUrl },
      ],
    };
  }),
  caddyCloudflare: async ({ http, latest }) => {
    const module = 'github.com/caddy-dns/cloudflare';
    const url = `https://sum.golang.org/lookup/${module}@v${latest}`;
    const hash = goSumHash(await http.text(url), module, `v${latest}`);
    if (!hash) throw new Error(`${url} lists no h1: hash for the module`);
    return {
      edits: [yamlEdit(['caddy_cloudflare_module_version'], `v${latest}`)],
      evidence: [{ item: `${module}@v${latest} (module h1: hash; xcaddy's build verifies against it)`, value: hash, source: url }],
    };
  },
  coder: imageBumper({ image: 'ghcr.io/coder/coder', tagKey: 'coder_image_tag', digestKey: 'coder_image_digest', tagFor: (v) => `v${v}` }),
  postgres: imageBumper({ image: 'postgres', tagKey: 'coder_postgres_image_tag', digestKey: 'coder_postgres_image_digest', tagFor: (v) => v }),
  portainer: imageBumper({ image: 'portainer/portainer-ee', tagKey: 'portainer_image_tag', digestKey: 'portainer_image_digest', tagFor: (v) => v }),
  vault: async ({ http, latest }) => {
    const url = `https://releases.hashicorp.com/vault/${latest}/vault_${latest}_SHA256SUMS`;
    const file = `vault_${latest}_linux_amd64.zip`;
    const hex = sumsLine(await http.text(url), file);
    if (!hex) throw new Error(`${url} has no line for ${file}`);
    return {
      edits: [yamlEdit(['vault_version'], latest), yamlEdit(['vault_checksum'], `sha256:${hex}`)],
      evidence: [
        {
          item: `${file} (SHA256)`,
          value: hex,
          source: `${url}; the vault role verifies that file's signature on the host against vault_pgp_key_checksum's key before trusting it`,
        },
      ],
    };
  },
  nodeExporter: async ({ http, latest }) => {
    const url = `https://github.com/prometheus/node_exporter/releases/download/v${latest}/sha256sums.txt`;
    const file = `node_exporter-${latest}.linux-amd64.tar.gz`;
    const hex = sumsLine(await http.text(url), file);
    if (!hex) throw new Error(`${url} has no line for ${file}`);
    return {
      edits: [yamlEdit(['node_exporter_version'], latest), yamlEdit(['node_exporter_checksum'], `sha256:${hex}`)],
      evidence: [{ item: `${file} (SHA256)`, value: hex, source: url }],
    };
  },
  node: refreshable(async ({ http, latest }) => {
    const index = await aptIndex(http, NODESOURCE, 'dists/nodistro', 'main');
    const stanza = aptPick(index.text, 'nodejs', latest);
    return {
      edits: [yamlEdit(['labs_agent_node_version'], stanza.version)],
      evidence: [
        {
          item: `nodejs ${stanza.version} (.deb SHA256)`,
          value: stanza.sha256,
          source: `${index.packagesUrl}, whose SHA256 ${index.indexSha256} is the one ${index.inReleaseUrl} lists`,
        },
      ],
    };
  }),
};

/** What a check row asks of its bumper: a new release, the same release rebuilt, or nothing. */
function hostTarget(row, bumper) {
  if (row.status === 'BEHIND') return { release: row.latest, to: row.latest };
  if (row.status === 'current' && bumper?.refresh) return { release: row.pinned, to: `${row.pinned} (same release, newer build)` };
  return null;
}

/**
 * Plan the host bumps for the rows lab-pins-upstream.mjs's check marked
 * BEHIND, and re-read the rows it marked current whose publisher can rebuild
 * a release under the same name (see `refreshable`); a re-read that matches
 * the pin is no bump. Unreadable rows are not touched here: the check already
 * reports them, and the weekly issue carries it. `files` carries the other
 * files a bumper edits (CADDY_TEST_PATH); a bumper whose file was not read
 * becomes a note, as applyBumps says.
 */
export async function planHost({ text, files = {}, rows, http, bumpers = HOST_BUMPERS }) {
  const bumps = [];
  const notes = [];
  for (const row of rows) {
    const bumper = bumpers[row.key];
    if (row.status === 'BEHIND' && !bumper) {
      notes.push({ label: row.label, from: row.pinned, to: row.latest, reason: 'no bump procedure is automated for this pin' });
      continue;
    }
    const target = hostTarget(row, bumper);
    if (!target) continue;
    try {
      const { edits, evidence } = await bumper({ http, latest: target.release, pinned: row.pinned });
      bumps.push({ key: row.key, label: row.label, from: row.pinned, to: target.to, edits, evidence });
    } catch (error) {
      notes.push({ label: row.label, from: row.pinned, to: target.to, reason: error?.message || String(error) });
    }
  }
  const result = applyBumps({ ...files, [GROUP_VARS_PATH]: text }, bumps);
  const moved = result.applied.filter((bump) => bump.changes.some((c) => c.from !== c.to));
  return { files: result.files, applied: moved, notes: [...notes, ...result.notes] };
}

// ── Lab image base (versions.env and its FROM lines) ───────────────────────

/**
 * The base images' newest digests. BASE_IMAGE is a patch tag
 * (python:3.14.7-slim-trixie), which stops moving once the next patch ships,
 * so the line tag (python:3.14-slim-trixie) is what is read; the CPython it
 * carries comes from the image config's PYTHON_VERSION, and the patch tag for
 * that release must resolve to the same digest before the pin moves to it.
 * A new minor line is a floors decision (scripts/version-floors.json), not a
 * rebuild, so the line stays put. lab-image/README.md, "Updating a version",
 * is this procedure by hand.
 */
/** The python base: the line tag's newest digest, its CPython, and the patch tag that must agree. */
async function planPythonBase(env, http) {
  const base = parseImageRef(env.BASE_IMAGE);
  const tagParts = base?.tag?.match(/^(\d+)\.(\d+)\.(\d+)(-[a-z0-9.-]+)$/);
  if (!base || !tagParts) throw new Error('BASE_IMAGE is not a python:<x.y.z>-<variant> tag');
  const [, major, minor, , variant] = tagParts;
  const lineTag = `${major}.${minor}${variant}`;
  const line = await resolveTag(http, base.name, lineTag);
  if (line.digest === env.BASE_DIGEST) return null;
  const pythonVersion = (await imageEnv(http, base.name, line.manifest))
    .find((e) => e.startsWith('PYTHON_VERSION='))
    ?.slice('PYTHON_VERSION='.length);
  if (!pythonVersion || !/^\d+\.\d+\.\d+$/.test(pythonVersion)) throw new Error(`${base.name}:${lineTag} sets no PYTHON_VERSION`);
  if (compareVersions(pythonVersion, env.BASE_PYTHON_VERSION) < 0) {
    throw new Error(`${base.name}:${lineTag} carries CPython ${pythonVersion}, older than the pinned ${env.BASE_PYTHON_VERSION}`);
  }
  const patchTag = `${pythonVersion}${variant}`;
  const patch = await resolveTag(http, base.name, patchTag);
  if (patch.digest !== line.digest) {
    throw new Error(`${base.name}:${patchTag} is ${patch.digest} but ${base.name}:${lineTag} is ${line.digest}; the two have not settled`);
  }
  const oldRef = `${env.BASE_IMAGE}@${env.BASE_DIGEST}`;
  const newImage = `${base.name}:${patchTag}`;
  const newRef = `${newImage}@${line.digest}`;
  const envEdit = (key, to) => ({ file: VERSIONS_ENV_PATH, where: key, to, apply: (t) => setEnvValue(t, key, to) });
  return {
    key: 'base',
    label: `Lab image base (${base.name}:${lineTag})`,
    from: `${env.BASE_IMAGE}@${env.BASE_DIGEST.slice(0, 19)}`,
    to: `${newImage}@${line.digest.slice(0, 19)}`,
    edits: [
      envEdit('BASE_IMAGE', newImage),
      envEdit('BASE_DIGEST', line.digest),
      envEdit('BASE_PYTHON_VERSION', pythonVersion),
      { file: DOCKERFILE_PATH, where: 'every external FROM', to: newRef, apply: (t) => replaceFrom(t, oldRef, newRef) },
      // The guide page names the tag in its prose and its inspect command,
      // and the CPython release beside it; DockerGuides.test.jsx holds the
      // page to versions.env, so a bump without these failed `frontend` (#1123).
      {
        file: DOCKER_GUIDE_PAGE_PATH,
        where: 'the base tag, wherever the page names it',
        to: newImage,
        apply: (t) => replaceEvery(t, env.BASE_IMAGE, newImage, 'BuildingImagesPage base tag'),
      },
      {
        file: DOCKER_GUIDE_PAGE_PATH,
        where: 'the CPython release the page names',
        to: `CPython ${pythonVersion}`,
        apply: (t) => replaceEvery(t, `CPython ${env.BASE_PYTHON_VERSION}`, `CPython ${pythonVersion}`, 'BuildingImagesPage CPython'),
      },
    ],
    evidence: [
      { item: `${base.name}:${lineTag} (index digest)`, value: line.digest, source: line.reads.join('; ') },
      { item: `${newImage} (index digest, the same)`, value: patch.digest, source: patch.reads.join('; ') },
      {
        item: 'CPython in that image',
        value: pythonVersion,
        source:
          'PYTHON_VERSION in the linux/amd64 image config, each manifest and the config blob hashed against the digest that named it; smoke.sh checks it against BASE_PYTHON_VERSION',
      },
    ],
  };
}

/** The sandbox template's base: its tag's newest digest. */
async function planSandboxBase(env, http) {
  const sandbox = parseImageRef(env.SANDBOX_BASE_IMAGE);
  if (!sandbox?.tag) throw new Error('SANDBOX_BASE_IMAGE names no tag');
  const resolved = await resolveTag(http, sandbox.name, sandbox.tag);
  if (resolved.digest === env.SANDBOX_BASE_DIGEST) return null;
  const oldRef = `${env.SANDBOX_BASE_IMAGE}@${env.SANDBOX_BASE_DIGEST}`;
  const newRef = `${env.SANDBOX_BASE_IMAGE}@${resolved.digest}`;
  return {
    key: 'sandbox',
    label: `Sandbox template base (${env.SANDBOX_BASE_IMAGE})`,
    from: env.SANDBOX_BASE_DIGEST.slice(0, 19),
    to: resolved.digest.slice(0, 19),
    edits: [
      {
        file: VERSIONS_ENV_PATH,
        where: 'SANDBOX_BASE_DIGEST',
        to: resolved.digest,
        apply: (t) => setEnvValue(t, 'SANDBOX_BASE_DIGEST', resolved.digest),
      },
      { file: SANDBOX_DOCKERFILE_PATH, where: 'FROM', to: newRef, apply: (t) => replaceFrom(t, oldRef, newRef) },
    ],
    evidence: [{ item: `${env.SANDBOX_BASE_IMAGE} (index digest)`, value: resolved.digest, source: resolved.reads.join('; ') }],
  };
}

export async function planImageBase({ files, http }) {
  const env = readEnv(files[VERSIONS_ENV_PATH]);
  const bumps = [];
  const notes = [];
  for (const [label, from, plan] of [
    [`Lab image base (${env.BASE_IMAGE})`, env.BASE_IMAGE, planPythonBase],
    [`Sandbox template base (${env.SANDBOX_BASE_IMAGE})`, env.SANDBOX_BASE_DIGEST, planSandboxBase],
  ]) {
    try {
      const bump = await plan(env, http);
      if (bump) bumps.push(bump);
    } catch (error) {
      notes.push({ label, from, to: '—', reason: error?.message || String(error) });
    }
  }
  const result = applyBumps(files, bumps);
  return { files: result.files, applied: result.applied, notes: [...notes, ...result.notes] };
}

// ── The consumers' digests (capabilities.js, the Coder template) ───────────

const RUNNER_PIN = /'(docker\.io\/hybridcloudworks\/hcw-lab-runner:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64})'/;
const TEMPLATE_TAG = /^[ \t]*image_tag[ \t]*=[ \t]*"([^"]+)"/m;
const TEMPLATE_DIGEST = /^[ \t]*image_digest[ \t]*=[ \t]*"(sha256:[0-9a-f]{64})"/m;

/**
 * Pin the two images a publish from main just pushed. The digests arrive from
 * the publish job (read back from Docker Hub there with imagetools); they are read
 * again here from the registry, by tag, and must agree, so a digest that was
 * mistyped or replaced in between never reaches a consumer.
 */
export async function planImageDigests({ files, http, runner, full }) {
  const bumps = [];
  const notes = [];
  const runnerRef = parseImageRef(runner);
  const fullRef = parseImageRef(full);
  if (runnerRef?.name !== RUNNER_IMAGE || !runnerRef.tag || !runnerRef.digest) {
    throw new Error(`--runner must be ${RUNNER_IMAGE}:<tag>@sha256:<digest>, got ${runner}`);
  }
  if (fullRef?.name !== FULL_IMAGE || !fullRef.tag || !fullRef.digest) {
    throw new Error(`--full must be ${FULL_IMAGE}:<tag>@sha256:<digest>, got ${full}`);
  }

  const currentRunner = files[CAPABILITIES_PATH].match(RUNNER_PIN)?.[1];
  const currentFullDigest = files[CODER_TEMPLATE_PATH].match(TEMPLATE_DIGEST)?.[1];

  for (const [ref, label, current] of [
    [runnerRef, 'hcw-lab-runner (vps-agent job image)', parseImageRef(currentRunner)?.digest],
    [fullRef, 'hcw-lab (Coder workspace image)', currentFullDigest],
  ]) {
    if (current === ref.digest) continue;
    try {
      const read = await readManifest(http, ref.name, ref.tag);
      if (read.digest !== ref.digest) throw new Error(`${ref.name}:${ref.tag} is ${read.digest} on Docker Hub, not the ${ref.digest} the publish job reported`);
      const pinned = `${ref.name}:${ref.tag}@${ref.digest}`;
      const edits =
        ref === runnerRef
          ? [{ file: CAPABILITIES_PATH, where: 'IMAGES.hcwLabRunner', to: pinned, apply: (t) => replaceOne(t, RUNNER_PIN, pinned, 'IMAGES.hcwLabRunner') }]
          : [
              { file: CODER_TEMPLATE_PATH, where: 'local.image_tag', to: ref.tag, apply: (t) => replaceOne(t, TEMPLATE_TAG, ref.tag, 'image_tag') },
              { file: CODER_TEMPLATE_PATH, where: 'local.image_digest', to: ref.digest, apply: (t) => replaceOne(t, TEMPLATE_DIGEST, ref.digest, 'image_digest') },
            ];
      bumps.push({
        key: ref === runnerRef ? 'runner' : 'full',
        label,
        from: (current ?? '—').slice(0, 19),
        to: ref.digest.slice(0, 19),
        edits,
        evidence: [
          {
            item: `${ref.name}:${ref.tag} (manifest digest)`,
            value: ref.digest,
            source: `the publish job's \`docker buildx imagetools inspect\` of the pushed tag, and ${read.url} read again here (bytes hashed, Docker-Content-Digest agreed); provenance attested to GHCR by that job`,
          },
        ],
      });
    } catch (error) {
      notes.push({ label, from: current ?? '—', to: ref.digest, reason: error?.message || String(error) });
    }
  }

  const result = applyBumps(files, bumps);
  return { files: result.files, applied: result.applied, notes: [...notes, ...result.notes] };
}

// ── Reporting ──────────────────────────────────────────────────────────────

/** The planned edits, one line each, for the console and --dry-run. */
export function renderPlan(applied) {
  if (applied.length === 0) return 'No pin to move.\n';
  const lines = [];
  for (const bump of applied) {
    lines.push(`${bump.label}: ${bump.from} -> ${bump.to}`);
    for (const c of bump.changes) lines.push(`  ${c.file}: ${c.where}: ${c.from} -> ${c.to}`);
  }
  return `${lines.join('\n')}\n`;
}

const code = (s) => `\`${String(s).replace(/`/g, "'")}\``;

/** The evidence section of the pull request body. */
export function renderEvidence(applied, { set, date }) {
  if (applied.length === 0) return '';
  const out = [
    `Every value below was read from its publisher on ${date} by \`node scripts/lab-pins-upstream.mjs --bump ${set}\`. A pin moves here only with the checksum or digest beside it; one the publisher did not serve is listed under "Not bumped" instead.`,
    '',
  ];
  for (const bump of applied) {
    out.push(`### ${bump.label}: ${bump.from} → ${bump.to}`, '');
    out.push('| File | Pin | Was | Now |', '| --- | --- | --- | --- |');
    for (const c of bump.changes) out.push(`| ${code(c.file)} | ${code(c.where)} | ${code(c.from)} | ${code(c.to)} |`);
    out.push('', '| Checksum or digest of | Value | Read from |', '| --- | --- | --- |');
    for (const e of bump.evidence) out.push(`| ${e.item} | ${code(e.value)} | ${e.source} |`);
    out.push('');
  }
  return out.join('\n');
}

/** The pins that are behind but were not moved, and why. */
export function renderNotes(notes) {
  if (notes.length === 0) return '';
  const out = ['Not bumped: no checksum or digest could be verified for these, so each is a note rather than an edit.', ''];
  for (const n of notes) out.push(`- **${n.label}** ${n.from ?? '—'} → ${n.to ?? '—'}: ${n.reason}`);
  return `${out.join('\n')}\n`;
}
