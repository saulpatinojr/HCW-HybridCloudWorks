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
 * Four pin sets, one pull request each (.github/workflows/lab-supply-chain.yml
 * opens the first three and publish-lab-image.yml the fourth;
 * scripts/open-lab-pin-pr.mjs keeps one per set):
 *
 *   host           lab-host/ansible/group_vars/all.yml, for every row
 *                  lab-pins-upstream.mjs reports BEHIND.
 *   image-base     lab-image/versions.env and the FROM lines it governs: the
 *                  newest digest of the base image's release line, with the
 *                  base tag and CPython release the Docker guide page
 *                  (frontend/src/pages/docker/BuildingImagesPage.jsx) and
 *                  lab-image/README.md name; and ansible-core's newest
 *                  release in its line with every wheel's hash (the lines
 *                  lab-host/bootstrap.sh installs the lab host's
 *                  ansible-core from, too).
 *   image-tools    lab-image/versions.env and lab-image/README.md: the tools
 *                  baked into the lab images and the Terraform providers in
 *                  their mirror, each to its newest release with the
 *                  publisher's checksum.
 *   image-digests  vps-agent/lib/capabilities.js and every Coder template
 *                  that runs hcw-lab: the two digests a publish from main
 *                  just pushed.
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
 *   Python wheel   PyPI's JSON API (`digests.sha256` of the release's wheel),
 *                  the sum pip and uv check in --require-hashes mode.
 *
 * Prose beside a pin ("read 2026-09-26 ...") is not rewritten: it records the
 * last hand read. The pull request body carries this run's evidence, and the
 * squash commit keeps it. Because the prose is left alone, a comment beside a
 * pin that moves must not name its version or digest, or the bump would leave
 * it false (#1423): lab-pin-comments.mjs is that rule, and
 * lab-pins-upstream.test.mjs runs every bumper over the real files and fails
 * when a comment names one.
 */
import { BOOTSTRAP_PATH, CADDY_TEST_PATH, GROUP_VARS_PATH } from './lab-pin-constants.mjs';
import { resolveTag } from './lab-pin-registry.mjs';
import { aptIndex, aptPick, aptStanzas, goSumHash, sumsLine } from './lab-pin-indexes.mjs';
import { applyBumps, replaceOne, yamlEdit } from './lab-pin-edits.mjs';
export { USER_AGENT, GROUP_VARS_PATH, VERSIONS_ENV_PATH, DOCKERFILE_PATH, SANDBOX_DOCKERFILE_PATH, CAPABILITIES_PATH, CODER_TEMPLATE_PATH, CODER_TEMPLATE_PATHS, CADDY_TEST_PATH, BOOTSTRAP_PATH, DOCKER_CLI_FIXTURE_PATH, DOCKER_GUIDE_PAGE_PATH, README_PATH, RUNNER_IMAGE, FULL_IMAGE } from './lab-pin-constants.mjs';
export { makeHttp, MANIFEST_TYPES, registryOf, parseImageRef, readManifest, resolveTag, amd64EntryOf, imageEnv } from './lab-pin-registry.mjs';
export { aptStanzas, compareDebian, aptPick, inReleaseSha256, sumsLine, goSumHash, aptIndex } from './lab-pin-indexes.mjs';
export { setYamlScalar, setEnvValue, readEnv, replaceFrom, replaceEvery, setCheckedOn, replaceOne, applyBumps } from './lab-pin-edits.mjs';
export { README_BASE_RE, renderReadmeBaseProse, planImageBase } from './lab-pin-image-base.mjs';
export { PYPI, normalizePyName, readAnsibleCoreDeps, requirementsOf, exactPin, wheelTags } from './lab-pin-ansible-core.mjs';
export { PROVIDER_SPECS, README_MIRROR_RE, renderReadmeMirrorProse, planImageTools } from './lab-pin-image-tools.mjs';
export { planImageDigests } from './lab-pin-digests.mjs';
export { renderPlan, renderEvidence, renderNotes } from './lab-pin-report.mjs';

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
  cosign: async ({ http, latest }) => {
    const url = `https://github.com/sigstore/cosign/releases/download/v${latest}/cosign_checksums.txt`;
    const file = 'cosign-linux-amd64';
    const hex = sumsLine(await http.text(url), file);
    if (!hex) throw new Error(`${url} has no line for ${file}`);
    return {
      edits: [
        yamlEdit(['cosign_version'], latest),
        yamlEdit(['cosign_checksum'], `sha256:${hex}`),
        {
          file: BOOTSTRAP_PATH,
          where: 'COSIGN_VERSION',
          to: latest,
          apply: (text) => replaceOne(text, /^COSIGN_VERSION=([0-9.]+)$/m, latest, 'COSIGN_VERSION'),
        },
        {
          file: BOOTSTRAP_PATH,
          where: 'COSIGN_SHA256',
          to: hex,
          apply: (text) => replaceOne(text, /^COSIGN_SHA256=([0-9a-f]{64})$/m, hex, 'COSIGN_SHA256'),
        },
      ],
      evidence: [{ item: `${file} (SHA256)`, value: hex, source: url }],
    };
  },
};

/** The prefix lab-pins-upstream.mjs's check puts before the error of a row it could not read. */
const UNREADABLE = 'unreadable: ';

/** A note's reason for a row the check could not read; `error` names the address and the status. */
const unreadableReason = (error) =>
  `its publisher could not be read in this run, so whether a newer release exists is not known (${error}); nothing was edited for it, and next week's run reads it again`;

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
 * the pin is no bump. A row whose publisher could not be read is not edited
 * either, but it becomes a note naming the address and the status it got, so
 * the pull request and the weekly issue tell "no newer release" apart from
 * "could not read" (#1447; it used to be dropped without a word). When it is
 * the only thing the plan holds there is no edit, so no pull request, and the
 * weekly issue alone carries it. `files`
 * carries the other files a bumper edits (CADDY_TEST_PATH); a bumper whose
 * file was not read becomes a note, as applyBumps says.
 */
export async function planHost({ text, files = {}, rows, http, bumpers = HOST_BUMPERS }) {
  const bumps = [];
  const notes = [];
  for (const row of rows) {
    const bumper = bumpers[row.key];
    if (row.status.startsWith(UNREADABLE)) {
      notes.push({ label: row.label, from: row.pinned, to: 'unknown', reason: unreadableReason(row.status.slice(UNREADABLE.length)) });
      continue;
    }
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

