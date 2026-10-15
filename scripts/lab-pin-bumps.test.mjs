import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  CADDY_TEST_PATH,
  CAPABILITIES_PATH,
  CODER_TEMPLATE_PATH,
  DOCKERFILE_PATH,
  DOCKER_GUIDE_PAGE_PATH,
  GROUP_VARS_PATH,
  HOST_BUMPERS,
  PYPI,
  SANDBOX_DOCKERFILE_PATH,
  VERSIONS_ENV_PATH,
  aptIndex,
  aptPick,
  compareDebian,
  dockerCliDeb,
  exactPin,
  goSumHash,
  inReleaseSha256,
  makeHttp,
  normalizePyName,
  parseImageRef,
  planHost,
  planImageBase,
  planImageDigests,
  readAnsibleCoreDeps,
  readEnv,
  readManifest,
  registryOf,
  requirementsOf,
  renderEvidence,
  renderNotes,
  renderPlan,
  replaceEvery,
  replaceFrom,
  resolveTag,
  setCheckedOn,
  setEnvValue,
  setYamlScalar,
  sumsLine,
  wheelTags,
} from './lib/lab-pin-bumps.mjs';
import { LABELS } from './lab-pins-upstream.mjs';

/** A value matched literally inside a RegExp: every metacharacter escaped, not only the dots of a version. */
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const real = (path) => readFileSync(join(REPO, path), 'utf8');
const sha = (s) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const hex = (c) => c.repeat(64);

/** A fetch that serves a fixed map of URL → body (string or object) with optional headers; anything else 404s. */
function fakeFetch(routes) {
  return async (url) => {
    const route = routes[url];
    if (route === undefined) return new Response('not found', { status: 404 });
    const { body, headers = {} } = typeof route === 'object' && 'body' in route ? route : { body: route };
    const bytes = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(bytes, { status: 200, headers });
  };
}

describe('editing one line', () => {
  // A slice shaped as group_vars is, rather than the live file: a pin bump
  // moves the live values, and a test that named them broke on #1122.
  const groupVars = [
    '# docker_release_pins: the same upstream version for both releases.',
    'docker_release_pins:',
    '  resolute:',
    '    engine: "5:29.8.1-1~ubuntu.26.04~resolute"',
    '    containerd: "2.3.6-1"',
    '  noble:',
    '    engine: "5:29.8.1-1~ubuntu.24.04~noble"',
    '    containerd: "2.3.6-1"',
    '',
    'coder_image: ghcr.io/coder/coder',
    'coder_image_tag: v2.38.0',
    'coder_postgres_image_tag: "18.6"',
    '',
  ].join('\n');

  it('moves one codename entry of docker_release_pins and keeps the quotes', () => {
    const { text, from, line } = setYamlScalar(groupVars, ['docker_release_pins', 'noble', 'engine'], '5:29.9.0-1~ubuntu.24.04~noble');
    expect(from).toBe('5:29.8.1-1~ubuntu.24.04~noble');
    expect(text.split('\n')[line - 1]).toBe('    engine: "5:29.9.0-1~ubuntu.24.04~noble"');
    const changed = text.split('\n').filter((l, i) => l !== groupVars.split('\n')[i]);
    expect(changed).toHaveLength(1);
    expect(text).toContain('    engine: "5:29.8.1-1~ubuntu.26.04~resolute"');
  });

  it('the live group_vars has the shape the slice above assumes', () => {
    const live = real(GROUP_VARS_PATH);
    for (const codename of ['resolute', 'noble']) {
      expect(setYamlScalar(live, ['docker_release_pins', codename, 'engine'], 'x').from).toMatch(/^5:\d+\.\d+\.\d+-1~ubuntu\./);
    }
    expect(setYamlScalar(live, ['coder_image'], 'x').from).toBe('ghcr.io/coder/coder');
  });

  it('replaces every occurrence of a literal and refuses none', () => {
    expect(replaceEvery('a python:1 b python:1', 'python:1', 'python:2', 'tag')).toEqual({ text: 'a python:2 b python:2', from: 'python:1', count: 2 });
    expect(() => replaceEvery('nothing here', 'python:1', 'python:2', 'tag')).toThrow(/tag: no occurrence/);
  });

  it('edits an unquoted top-level scalar and does not confuse a key with its prefix', () => {
    const { text, from } = setYamlScalar(groupVars, ['coder_image'], 'ghcr.io/coder/coder2');
    expect(from).toBe('ghcr.io/coder/coder');
    expect(text).toContain('coder_image: ghcr.io/coder/coder2\n');
    expect(text).toContain('coder_image_tag: v2.38.0\n');
    expect(setYamlScalar(groupVars, ['coder_postgres_image_tag'], '18.7').text).toContain('coder_postgres_image_tag: "18.7"\n');
  });

  it('refuses a key that is absent, and a value that is not a scalar on its line', () => {
    expect(() => setYamlScalar(groupVars, ['no_such_pin'], 'x')).toThrow(/found 0/);
    expect(() => setYamlScalar(groupVars, ['docker_release_pins'], 'x')).toThrow(/not a scalar/);
    expect(() => setYamlScalar(groupVars, ['docker_release_pins', 'jammy', 'engine'], 'x')).toThrow(/found 0/);
  });

  it('sets one versions.env line and refuses a missing one', () => {
    const env = real(VERSIONS_ENV_PATH);
    const { text, from } = setEnvValue(env, 'BASE_DIGEST', `sha256:${hex('a')}`);
    expect(from).toBe(readEnv(env).BASE_DIGEST);
    expect(readEnv(text).BASE_DIGEST).toBe(`sha256:${hex('a')}`);
    expect(() => setEnvValue(env, 'NOPE', 'x')).toThrow(/found 0/);
  });

  it('replaces every external FROM in the Dockerfile and none of its stages', () => {
    const env = readEnv(real(VERSIONS_ENV_PATH));
    const dockerfile = real(DOCKERFILE_PATH);
    const oldRef = `${env.BASE_IMAGE}@${env.BASE_DIGEST}`;
    const { text, count } = replaceFrom(dockerfile, oldRef, `python:9.9.9-slim-trixie@sha256:${hex('b')}`);
    expect(count).toBeGreaterThanOrEqual(2);
    expect(text).not.toContain(`FROM ${oldRef}`);
    expect(text).toContain('FROM fetch AS vendor');
    expect(() => replaceFrom(dockerfile, 'python:0@sha256:0', 'x')).toThrow(/no FROM/);
    const sandbox = real(SANDBOX_DOCKERFILE_PATH);
    expect(replaceFrom(sandbox, `${env.SANDBOX_BASE_IMAGE}@${env.SANDBOX_BASE_DIGEST}`, 'x').count).toBe(1);
  });
});

describe('reading publisher indexes', () => {
  const packages = [
    'Package: docker-ce\nVersion: 5:29.8.2-1~ubuntu.26.04~resolute\nFilename: pool/docker-ce_29.8.2.deb\nSHA256: ' + hex('1'),
    'Package: docker-ce-cli\nVersion: 5:29.8.2-1~ubuntu.26.04~resolute\nSHA256: ' + hex('2'),
    'Package: docker-ce\nVersion: 5:29.8.1-1~ubuntu.26.04~resolute\nSHA256: ' + hex('3'),
    'Package: containerd.io\nVersion: 2.3.7-1~ubuntu.26.04~resolute',
  ].join('\n\n');

  it('picks the newest Debian revision of one upstream version', () => {
    const rebuilt = [
      `Package: docker-buildx-plugin\nVersion: 0.37.1-1~ubuntu.26.04~resolute\nSHA256: ${hex('1')}`,
      `Package: docker-buildx-plugin\nVersion: 0.37.1-2~ubuntu.26.04~resolute\nSHA256: ${hex('2')}`,
    ].join('\n\n');
    expect(aptPick(rebuilt, 'docker-buildx-plugin', '0.37.1').version).toBe('0.37.1-2~ubuntu.26.04~resolute');
    expect(compareDebian('5:29.8.2-1~ubuntu.26.04~resolute', '5:29.8.10-1~ubuntu.26.04~resolute')).toBe(-1);
    expect(compareDebian('26.10.0-1nodesource1', '26.10.0-1nodesource1')).toBe(0);
  });

  it('picks the one stanza for an upstream version, with its SHA256', () => {
    expect(aptPick(packages, 'docker-ce', '29.8.2')).toEqual({
      version: '5:29.8.2-1~ubuntu.26.04~resolute',
      sha256: hex('1'),
      filename: 'pool/docker-ce_29.8.2.deb',
    });
    expect(() => aptPick(packages, 'docker-ce', '30.0.0')).toThrow(/not in the index/);
    expect(() => aptPick(packages, 'containerd.io', '2.3.7')).toThrow(/no SHA256/);
  });

  it('reads the SHA256 InRelease lists for an index, and nothing from the MD5 section', () => {
    const inRelease = [
      '-----BEGIN PGP SIGNED MESSAGE-----',
      'Suite: resolute',
      'MD5Sum:',
      ` ${'f'.repeat(32)}  154747 stable/binary-amd64/Packages`,
      'SHA256:',
      ` ${hex('c')}  154747 stable/binary-amd64/Packages`,
      ` ${hex('d')}  27784 stable/binary-amd64/Packages.bz2`,
      '-----BEGIN PGP SIGNATURE-----',
    ].join('\n');
    expect(inReleaseSha256(inRelease, 'stable/binary-amd64/Packages')).toBe(hex('c'));
    expect(inReleaseSha256(inRelease, 'stable/binary-arm64/Packages')).toBeNull();
  });

  it('reads a sha512sum line when asked for 128 hex digits', () => {
    const sums = `${'c'.repeat(128)}  caddy_9.9.9_linux_amd64.tar.gz\n${'d'.repeat(128)}  caddy_9.9.9_linux_arm64.tar.gz\n`;
    expect(sumsLine(sums, 'caddy_9.9.9_linux_amd64.tar.gz', 128)).toBe('c'.repeat(128));
    expect(sumsLine(sums, 'caddy_9.9.9_linux_amd64.tar.gz')).toBeNull();
  });

  it('aptIndex awaits the InRelease verifier before trusting the list, and a refusal is the read refused', async () => {
    const base = 'https://download.docker.com/linux/ubuntu/dists/resolute';
    const packages = 'Package: docker-ce-cli\nVersion: 5:29.9.0-1~ubuntu.26.04~resolute\nSHA256: ' + hex('1') + '\n';
    const inRelease = `SHA256:\n ${sha(packages).slice(7)} 1 stable/binary-amd64/Packages\n`;
    const routes = { [`${base}/stable/binary-amd64/Packages`]: packages, [`${base}/InRelease`]: inRelease };
    const seen = vi.fn();
    const index = await aptIndex(makeHttp(fakeFetch(routes)), 'https://download.docker.com/linux/ubuntu', 'dists/resolute', 'stable', {
      verifyInRelease: seen,
    });
    expect(seen).toHaveBeenCalledWith(inRelease, `${base}/InRelease`);
    expect(index.text).toBe(packages);
    const refusing = () => {
      throw new Error('BAD signature');
    };
    await expect(
      aptIndex(makeHttp(fakeFetch(routes)), 'https://download.docker.com/linux/ubuntu', 'dists/resolute', 'stable', { verifyInRelease: refusing })
    ).rejects.toThrow(/BAD signature/);
  });

  it('names the docker-ce-cli .deb for a pinned version string with the SHA256 the index lists', () => {
    const index = [
      'Package: docker-ce-cli',
      'Version: 5:29.9.0-1~ubuntu.26.04~resolute',
      'Filename: dists/resolute/pool/stable/amd64/docker-ce-cli_29.9.0-1~ubuntu.26.04~resolute_amd64.deb',
      `SHA256: ${hex('7')}`,
      '',
      'Package: docker-ce-cli',
      'Version: 5:29.8.1-1~ubuntu.26.04~resolute',
      'Filename: dists/resolute/pool/stable/amd64/docker-ce-cli_29.8.1-1~ubuntu.26.04~resolute_amd64.deb',
      `SHA256: ${hex('8')}`,
      '',
    ].join('\n');
    expect(dockerCliDeb(index, '5:29.9.0-1~ubuntu.26.04~resolute')).toEqual({
      url: 'https://download.docker.com/linux/ubuntu/dists/resolute/pool/stable/amd64/docker-ce-cli_29.9.0-1~ubuntu.26.04~resolute_amd64.deb',
      sha256: hex('7'),
      version: '5:29.9.0-1~ubuntu.26.04~resolute',
    });
    expect(() => dockerCliDeb(index, '5:30.0.0-1~ubuntu.26.04~resolute')).toThrow(/not in the index/);
  });

  it('reads a sha256sum line and a Go checksum database line', () => {
    expect(sumsLine(`${hex('e')}  vault_2.1.2_linux_amd64.zip\n${hex('f')}  vault_2.1.2_darwin_arm64.zip\n`, 'vault_2.1.2_linux_amd64.zip')).toBe(hex('e'));
    expect(sumsLine('', 'x')).toBeNull();
    const lookup = '51560342\ngithub.com/caddy-dns/cloudflare v0.2.5 h1:abc+/=\ngithub.com/caddy-dns/cloudflare v0.2.5/go.mod h1:zzz=\n';
    expect(goSumHash(lookup, 'github.com/caddy-dns/cloudflare', 'v0.2.5')).toBe('h1:abc+/=');
  });

  it('names the registry an image lives in', () => {
    expect(registryOf('caddy').repository).toBe('library/caddy');
    expect(registryOf('portainer/portainer-ee').hubTags).toBe('https://hub.docker.com/v2/repositories/portainer/portainer-ee/tags/');
    expect(registryOf('ghcr.io/coder/coder')).toMatchObject({ host: 'ghcr.io', repository: 'coder/coder', hubTags: null });
    // The lab images' own form since 2026-10-08: the host is not part of the
    // repository name Docker Hub's API takes.
    expect(registryOf('docker.io/hybridcloudworks/hcw-lab')).toMatchObject({
      host: 'registry-1.docker.io',
      repository: 'hybridcloudworks/hcw-lab',
      tokenUrl: 'https://auth.docker.io/token?service=registry.docker.io&scope=repository:hybridcloudworks/hcw-lab:pull',
    });
    expect(registryOf('docker.io/alpine').repository).toBe('library/alpine');
    expect(parseImageRef(`docker.io/hybridcloudworks/hcw-lab:abc@sha256:${hex('0')}`)).toEqual({
      name: 'docker.io/hybridcloudworks/hcw-lab',
      tag: 'abc',
      digest: `sha256:${hex('0')}`,
    });
    expect(parseImageRef('Not An Image')).toBeNull();
  });
});

describe('registry reads', () => {
  const manifest = JSON.stringify({ schemaVersion: 2, manifests: [] });
  const token = 'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/caddy:pull';
  const url = 'https://registry-1.docker.io/v2/library/caddy/manifests/2.11.7-builder';
  const hub = 'https://hub.docker.com/v2/repositories/library/caddy/tags/2.11.7-builder';

  it('hashes the bytes it was served and refuses a Docker-Content-Digest that disagrees', async () => {
    const good = makeHttp(fakeFetch({ [token]: { token: 't' }, [url]: { body: manifest, headers: { 'docker-content-digest': sha(manifest) } } }));
    expect((await readManifest(good, 'caddy', '2.11.7-builder')).digest).toBe(sha(manifest));
    const bad = makeHttp(fakeFetch({ [token]: { token: 't' }, [url]: { body: manifest, headers: { 'docker-content-digest': `sha256:${hex('0')}` } } }));
    await expect(readManifest(bad, 'caddy', '2.11.7-builder')).rejects.toThrow(/hash to/);
  });

  it('requires Docker Hub\'s API to report the same digest as the registry', async () => {
    const agree = makeHttp(fakeFetch({ [token]: { token: 't' }, [url]: manifest, [hub]: { digest: sha(manifest) } }));
    const resolved = await resolveTag(agree, 'caddy', '2.11.7-builder');
    expect(resolved.digest).toBe(sha(manifest));
    expect(resolved.reads).toHaveLength(2);
    const disagree = makeHttp(fakeFetch({ [token]: { token: 't' }, [url]: manifest, [hub]: { digest: `sha256:${hex('9')}` } }));
    await expect(resolveTag(disagree, 'caddy', '2.11.7-builder')).rejects.toThrow(/Docker Hub's API reports/);
  });
});

describe('the host plan', () => {
  const text = real(GROUP_VARS_PATH);
  const row = (key, pinned, latest, status = 'BEHIND') => ({ key, label: LABELS[key], pinned, latest, status });
  // The live pins, so these tests survive the bumps they describe (#1122
  // moved Docker Engine, Caddy and Vault under a version of this file that
  // named them).
  const pinned = (key) => text.match(new RegExp(`^${key}: "?([^"\\n]+?)"?$`, 'm'))[1];
  const pinnedVault = pinned('vault_version');
  const pinnedCaddy = pinned('caddy_version').replace(/^v/, '');
  const coderTagLine = text.match(/^coder_image_tag: .*$/m)[0];
  const pinnedEngine = text.match(/^ {2}resolute:\n(?: {4}.*\n)*? {4}engine: "5:([0-9.]+)-/m)[1];
  const nextEngine = pinnedEngine.replace(/^(\d+)\.\d+\.\d+$/, '$1.99.0');

  it('has a bump procedure for every pin the check watches', () => {
    expect(Object.keys(HOST_BUMPERS).sort()).toEqual(Object.keys(LABELS).sort());
  });

  it('edits only BEHIND rows, and turns a bump without evidence into a note that edits nothing', async () => {
    const bumpers = {
      vault: async () => ({
        edits: [
          { file: GROUP_VARS_PATH, where: 'vault_version', to: '9.9.9', apply: (t) => setYamlScalar(t, ['vault_version'], '9.9.9') },
          { file: GROUP_VARS_PATH, where: 'vault_checksum', to: `sha256:${hex('e')}`, apply: (t) => setYamlScalar(t, ['vault_checksum'], `sha256:${hex('e')}`) },
        ],
        evidence: [{ item: 'vault_9.9.9_linux_amd64.zip (SHA256)', value: hex('e'), source: 'https://releases.hashicorp.com/vault/9.9.9/vault_9.9.9_SHA256SUMS' }],
      }),
      coder: async () => {
        throw new Error('ghcr.io/coder/coder:v2.39.0: HTTP 404');
      },
      caddy: async () => {
        throw new Error('must not be called for a current row');
      },
    };
    const plan = await planHost({
      text,
      rows: [row('vault', pinnedVault, '9.9.9'), row('coder', '2.38.0', '2.39.0'), row('caddy', pinnedCaddy, pinnedCaddy, 'current')],
      http: null,
      bumpers,
    });
    expect(plan.applied.map((b) => b.key)).toEqual(['vault']);
    const out = plan.files[GROUP_VARS_PATH];
    expect(out).toContain('vault_version: "9.9.9"\n');
    expect(out).toContain(`vault_checksum: sha256:${hex('e')}\n`);
    expect(out).toContain(`${coderTagLine}\n`);
    expect(plan.notes).toEqual([{ label: LABELS.coder, from: '2.38.0', to: '2.39.0', reason: 'ghcr.io/coder/coder:v2.39.0: HTTP 404' }]);
    expect(renderPlan(plan.applied)).toContain('lab-host/ansible/group_vars/all.yml: vault_checksum: sha256:');
    const evidence = renderEvidence(plan.applied, { set: 'host', date: '2026-10-13' });
    expect(evidence).toContain('`node scripts/lab-pins-upstream.mjs --bump host`');
    expect(evidence).toContain(hex('e'));
    expect(evidence).toContain('https://releases.hashicorp.com/vault/9.9.9/vault_9.9.9_SHA256SUMS');
    expect(renderNotes(plan.notes)).toContain('**Coder** 2.38.0 → 2.39.0: ghcr.io/coder/coder:v2.39.0: HTTP 404');
  });

  it('re-reads a current image pin and moves its digest when the publisher re-pushed the same tag', async () => {
    const pinned = setYamlScalar(text, ['coder_postgres_image_digest'], 'x').from;
    const rebuilt = JSON.stringify({ rebuilt: true });
    const routes = (manifest) => ({
      'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/postgres:pull': { token: 't' },
      'https://registry-1.docker.io/v2/library/postgres/manifests/18.6': manifest,
      'https://hub.docker.com/v2/repositories/library/postgres/tags/18.6': { digest: sha(manifest) },
    });
    const plan = await planHost({ text, rows: [row('postgres', '18.6', '18.6', 'current')], http: makeHttp(fakeFetch(routes(rebuilt))) });
    expect(plan.applied).toHaveLength(1);
    expect(plan.applied[0].to).toBe('18.6 (same release, newer build)');
    expect(plan.files[GROUP_VARS_PATH]).toContain(`coder_postgres_image_digest: ${sha(rebuilt)}\n`);
    expect(plan.files[GROUP_VARS_PATH]).not.toContain(pinned);
    expect(plan.files[GROUP_VARS_PATH]).toContain('coder_postgres_image_tag: "18.6"\n');
  });

  it('proposes nothing for a current pin whose re-read matches, and never re-reads a released checksum file', async () => {
    let vaultCalls = 0;
    const same = async () => ({
      edits: [{ file: GROUP_VARS_PATH, where: 'coder_image_tag', to: 'v2.38.0', apply: (t) => setYamlScalar(t, ['coder_image_tag'], 'v2.38.0') }],
      evidence: [],
    });
    const plan = await planHost({
      text,
      rows: [row('coder', '2.38.0', '2.38.0', 'current'), row('vault', '2.1.1', '2.1.1', 'current')],
      http: null,
      bumpers: {
        coder: Object.assign(same, { refresh: true }),
        vault: async () => {
          vaultCalls += 1;
          return { edits: [], evidence: [] };
        },
      },
    });
    expect(plan.applied).toEqual([]);
    expect(plan.notes).toEqual([]);
    expect(plan.files[GROUP_VARS_PATH]).toBe(text);
    expect(vaultCalls).toBe(0);
    expect(HOST_BUMPERS.vault.refresh).toBeUndefined();
    expect(HOST_BUMPERS.postgres.refresh).toBe(true);
    expect(HOST_BUMPERS.containerd.refresh).toBe(true);
  });

  it('moves both codenames of a Docker pin from the signed index chain, with the CLI and the rootless extras riding the engine', async () => {
    const base = 'https://download.docker.com/linux/ubuntu/dists';
    const routes = {};
    for (const [codename, release] of [
      ['resolute', '26.04'],
      ['noble', '24.04'],
    ]) {
      const v = `5:${nextEngine}-1~ubuntu.${release}~${codename}`;
      const packages = `Package: docker-ce\nVersion: ${v}\nSHA256: ${hex('1')}\n\nPackage: docker-ce-cli\nVersion: ${v}\nSHA256: ${hex('2')}\n\nPackage: docker-ce-rootless-extras\nVersion: ${v}\nSHA256: ${hex('3')}\n`;
      routes[`${base}/${codename}/stable/binary-amd64/Packages`] = packages;
      routes[`${base}/${codename}/InRelease`] = `SHA256:\n ${sha(packages).slice(7)} 1 stable/binary-amd64/Packages\n`;
    }
    const plan = await planHost({ text, rows: [row('dockerEngine', pinnedEngine, nextEngine)], http: makeHttp(fakeFetch(routes)) });
    expect(plan.notes).toEqual([]);
    expect(plan.files[GROUP_VARS_PATH]).toContain(`    engine: "5:${nextEngine}-1~ubuntu.26.04~resolute"`);
    expect(plan.files[GROUP_VARS_PATH]).toContain(`    engine: "5:${nextEngine}-1~ubuntu.24.04~noble"`);
    expect(plan.applied[0].evidence.map((e) => e.item)).toContain(`docker-ce-cli 5:${nextEngine}-1~ubuntu.24.04~noble (.deb SHA256)`);
    expect(plan.applied[0].evidence.map((e) => e.item)).toContain(`docker-ce-rootless-extras 5:${nextEngine}-1~ubuntu.26.04~resolute (.deb SHA256)`);
  });

  it('moves Caddy with the SHA512 the caddy test verifies its release against, or nothing when that file was not read', async () => {
    const manifest = JSON.stringify({ schemaVersion: 2, manifests: [] });
    const sums = `${'c'.repeat(128)}  caddy_9.9.9_linux_amd64.tar.gz\n${'d'.repeat(128)}  caddy_9.9.9_linux_arm64.tar.gz\n`;
    const routes = {
      'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/caddy:pull': { token: 't' },
      'https://registry-1.docker.io/v2/library/caddy/manifests/9.9.9-builder': manifest,
      'https://hub.docker.com/v2/repositories/library/caddy/tags/9.9.9-builder': { digest: sha(manifest) },
      'https://github.com/caddyserver/caddy/releases/download/v9.9.9/caddy_9.9.9_checksums.txt': sums,
    };
    const caddyTest = `#!/usr/bin/env bash\nCADDY_SHA512='${'a'.repeat(128)}'\necho "$CADDY_SHA512"\n`;
    const plan = await planHost({
      text,
      files: { [CADDY_TEST_PATH]: caddyTest },
      rows: [row('caddy', pinnedCaddy, '9.9.9')],
      http: makeHttp(fakeFetch(routes)),
    });
    expect(plan.notes).toEqual([]);
    expect(plan.files[GROUP_VARS_PATH]).toContain('caddy_version: v9.9.9\n');
    expect(plan.files[GROUP_VARS_PATH]).toContain('caddy_builder_image_tag: 9.9.9-builder\n');
    expect(plan.files[GROUP_VARS_PATH]).toContain(`caddy_builder_image_digest: ${sha(manifest)}\n`);
    expect(plan.files[CADDY_TEST_PATH]).toBe(caddyTest.replace('a'.repeat(128), 'c'.repeat(128)));
    expect(plan.applied[0].evidence.map((e) => e.item)).toContain(
      'caddy_9.9.9_linux_amd64.tar.gz (SHA512; caddy-adapt.test.sh verifies the release it runs against it)'
    );
    expect(plan.applied[0].evidence.map((e) => e.value)).toContain('c'.repeat(128));

    const without = await planHost({ text, rows: [row('caddy', pinnedCaddy, '9.9.9')], http: makeHttp(fakeFetch(routes)) });
    expect(without.applied).toEqual([]);
    expect(without.files[GROUP_VARS_PATH]).toBe(text);
    expect(without.notes[0].reason).toMatch(/caddy-adapt\.test\.sh was not read/);
  });

  it('the live caddy test holds one CADDY_SHA512 line in the shape the bump edits', () => {
    expect(real(CADDY_TEST_PATH).match(/^CADDY_SHA512='[0-9a-f]{128}'$/gm)).toHaveLength(1);
  });

  it('refuses an index whose hash InRelease does not list', async () => {
    const base = 'https://download.docker.com/linux/ubuntu/dists/resolute';
    const routes = {
      [`${base}/stable/binary-amd64/Packages`]: `Package: containerd.io\nVersion: 2.3.7-1~ubuntu.26.04~resolute\nSHA256: ${hex('1')}\n`,
      [`${base}/InRelease`]: `SHA256:\n ${hex('0')} 1 stable/binary-amd64/Packages\n`,
    };
    const plan = await planHost({ text, rows: [row('containerd', '2.3.6', '2.3.7')], http: makeHttp(fakeFetch(routes)) });
    expect(plan.applied).toEqual([]);
    expect(plan.notes[0].reason).toMatch(/InRelease lists/);
    expect(plan.files[GROUP_VARS_PATH]).toBe(text);
  });
});

describe('the image base plan', () => {
  const files = Object.fromEntries(
    [VERSIONS_ENV_PATH, DOCKERFILE_PATH, SANDBOX_DOCKERFILE_PATH, DOCKER_GUIDE_PAGE_PATH].map((p) => [p, real(p)])
  );
  const env = readEnv(files[VERSIONS_ENV_PATH]);
  const [, major, minor] = env.BASE_PYTHON_VERSION.match(/^(\d+)\.(\d+)\.(\d+)$/);
  const variant = env.BASE_IMAGE.replace(/^python:\d+\.\d+\.\d+/, '');
  const lineTag = `${major}.${minor}${variant}`;
  const next = `${major}.${minor}.99`;

  function registry({ pythonVersion = next, patchAgrees = true } = {}) {
    const config = JSON.stringify({ config: { Env: ['PATH=/usr/local/bin', `PYTHON_VERSION=${pythonVersion}`] } });
    const amd64 = JSON.stringify({ schemaVersion: 2, config: { digest: sha(config) } });
    const index = JSON.stringify({ schemaVersion: 2, manifests: [{ digest: sha(amd64), platform: { os: 'linux', architecture: 'amd64' } }] });
    const other = JSON.stringify({ schemaVersion: 2, manifests: [] });
    const reg = 'https://registry-1.docker.io/v2';
    const hub = 'https://hub.docker.com/v2/repositories';
    const sandboxManifest = JSON.stringify({ sandbox: true });
    const sandbox = parseImageRef(env.SANDBOX_BASE_IMAGE);
    return {
      'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/python:pull': { token: 't' },
      [`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${sandbox.name}:pull`]: { token: 't' },
      [`${reg}/library/python/manifests/${lineTag}`]: index,
      [`${hub}/library/python/tags/${lineTag}`]: { digest: sha(index) },
      [`${reg}/library/python/manifests/${pythonVersion}${variant}`]: patchAgrees ? index : other,
      [`${hub}/library/python/tags/${pythonVersion}${variant}`]: { digest: sha(patchAgrees ? index : other) },
      [`${reg}/library/python/manifests/${sha(amd64)}`]: amd64,
      [`${reg}/library/python/blobs/${sha(config)}`]: config,
      [`${reg}/${sandbox.name}/manifests/${sandbox.tag}`]: sandboxManifest,
      [`${hub}/${sandbox.name}/tags/${sandbox.tag}`]: { digest: sha(sandboxManifest) },
      _index: index,
    };
  }

  it('moves BASE_IMAGE, BASE_DIGEST, BASE_PYTHON_VERSION and every external FROM together', async () => {
    const routes = registry();
    const plan = await planImageBase({ files, http: makeHttp(fakeFetch(routes)), today: new Date('2026-10-14T12:00:00Z') });
    const base = plan.applied.find((b) => b.key === 'base');
    expect(base).toBeTruthy();
    const newEnv = readEnv(plan.files[VERSIONS_ENV_PATH]);
    expect(newEnv.BASE_IMAGE).toBe(`python:${next}${variant}`);
    expect(newEnv.BASE_DIGEST).toBe(sha(routes._index));
    expect(newEnv.BASE_PYTHON_VERSION).toBe(next);
    expect(plan.files[DOCKERFILE_PATH]).toContain(`FROM python:${next}${variant}@${sha(routes._index)} AS runner`);
    expect(plan.files[DOCKERFILE_PATH]).not.toContain(env.BASE_DIGEST);
    expect(base.evidence.map((e) => e.value)).toContain(next);
    // The guide page names the tag and the CPython release; both move (#1123 failed `frontend` without this).
    const page = plan.files[DOCKER_GUIDE_PAGE_PATH];
    expect(page).toContain(`python:${next}${variant}`);
    expect(page).toContain(`CPython ${next}`);
    expect(page).not.toContain(env.BASE_IMAGE);
    expect(page).not.toContain(`CPython ${env.BASE_PYTHON_VERSION}`);
    // And the day the page was last read against the files is the bump's day (CodeRabbit on #1123).
    expect(page).toContain("export const CHECKED_ON = Object.freeze({ iso: '2026-10-14', label: '14 October 2026' });");
    expect(base.changes.find((c) => c.where.startsWith('CHECKED_ON'))).toMatchObject({ to: '2026-10-14' });
  });

  it('setCheckedOn writes the ISO day and its en-GB label, and refuses a page without exactly one such line', () => {
    const page = "x\nexport const CHECKED_ON = Object.freeze({ iso: '2026-10-08', label: '8 October 2026' });\ny\n";
    expect(setCheckedOn(page, new Date('2026-03-01T23:59:00Z'))).toEqual({
      text: "x\nexport const CHECKED_ON = Object.freeze({ iso: '2026-03-01', label: '1 March 2026' });\ny\n",
      from: '2026-10-08',
      to: '2026-03-01',
    });
    expect(() => setCheckedOn('nothing', new Date())).toThrow(/CHECKED_ON: expected one line, found 0/);
    expect(() => setCheckedOn(`${page}${page}`, new Date())).toThrow(/found 2/);
  });

  it('is a note that edits nothing when the guide page was not read', async () => {
    const { [DOCKER_GUIDE_PAGE_PATH]: _page, ...withoutPage } = files;
    const plan = await planImageBase({ files: withoutPage, http: makeHttp(fakeFetch(registry())) });
    expect(plan.applied.filter((b) => b.key === 'base')).toEqual([]);
    // The sandbox base still moves on its own; the python base's three lines do not.
    const after = readEnv(plan.files[VERSIONS_ENV_PATH]);
    expect([after.BASE_IMAGE, after.BASE_DIGEST, after.BASE_PYTHON_VERSION]).toEqual([env.BASE_IMAGE, env.BASE_DIGEST, env.BASE_PYTHON_VERSION]);
    expect(plan.files[DOCKERFILE_PATH]).toBe(files[DOCKERFILE_PATH]);
    expect(plan.notes.map((n) => n.reason).join(' ')).toMatch(/BuildingImagesPage\.jsx was not read/);
  });

  it('moves nothing when the patch tag and the line tag have not settled on one digest', async () => {
    const plan = await planImageBase({ files, http: makeHttp(fakeFetch(registry({ patchAgrees: false }))) });
    expect(plan.applied.filter((b) => b.key === 'base')).toEqual([]);
    expect(plan.files[VERSIONS_ENV_PATH]).toContain(`BASE_DIGEST=${env.BASE_DIGEST}`);
    expect(plan.notes.map((n) => n.reason).join(' ')).toMatch(/have not settled/);
  });

  it('moves the sandbox template base and its one FROM, independently of the python base', async () => {
    const plan = await planImageBase({ files, http: makeHttp(fakeFetch(registry({ patchAgrees: false }))) });
    expect(plan.applied.map((b) => b.key)).toEqual(['sandbox']);
    const sandbox = plan.applied.find((b) => b.key === 'sandbox');
    expect(sandbox).toBeTruthy();
    expect(plan.files[SANDBOX_DOCKERFILE_PATH]).not.toContain(env.SANDBOX_BASE_DIGEST);
    expect(readEnv(plan.files[VERSIONS_ENV_PATH]).SANDBOX_BASE_DIGEST).toBe(sha(JSON.stringify({ sandbox: true })));
  });
});

describe('the ansible-core plan (image-base, LAB-13)', () => {
  // The live pins, so these tests survive the bumps they describe.
  const files = Object.fromEntries(
    [VERSIONS_ENV_PATH, DOCKERFILE_PATH, SANDBOX_DOCKERFILE_PATH, DOCKER_GUIDE_PAGE_PATH].map((p) => [p, real(p)])
  );
  const envText = files[VERSIONS_ENV_PATH];
  const env = readEnv(envText);
  const deps = readAnsibleCoreDeps(envText);
  const pinned = env.ANSIBLE_CORE_VERSION;
  const [major, minor] = pinned.split('.');
  const nextPatch = `${major}.${minor}.99`;
  const nextLine = `${major}.${Number(minor) + 1}.0`;
  const nextSha = hex('a');
  // ansible-core 2.21's Requires-Dist, as PyPI's JSON spells it.
  const REQUIRES = ['jinja2>=3.1.0', 'PyYAML>=5.1', 'cryptography', 'packaging', 'resolvelib<2.0.0,>=0.8.0'];
  const LINUX = 'cp314-cp314-manylinux_2_17_x86_64';
  const coreFile = (version, digest, extra = {}) => ({
    packagetype: 'bdist_wheel',
    filename: `ansible_core-${version}-py3-none-any.whl`,
    digests: { sha256: digest },
    yanked: false,
    ...extra,
  });
  const sdist = (name, version) => ({ packagetype: 'sdist', filename: `${name}-${version}.tar.gz`, digests: { sha256: hex('e') }, yanked: false });
  const depWheel = (dep, version, digest, tags = LINUX) => ({
    packagetype: 'bdist_wheel',
    filename: `${dep.name.replace(/-/g, '_')}-${version}-${tags}.whl`,
    digests: { sha256: digest },
    yanked: false,
  });
  const depNamed = (name) => deps.find((d) => normalizePyName(d.name) === name);
  const ansibleNotes = (plan) => plan.notes.filter((n) => n.label.startsWith('ansible-core'));

  /** PyPI's JSON API for the pinned release, one newer patch in its line, and every pinned dependency. */
  function pypi({ latest = nextPatch, releases, next = {}, current = {} } = {}) {
    const routes = {
      [`${PYPI}/ansible-core/json`]: {
        info: { version: latest },
        releases: releases ?? { [pinned]: [coreFile(pinned, env.ANSIBLE_CORE_SHA256)], [nextPatch]: [coreFile(nextPatch, nextSha)] },
      },
      [`${PYPI}/ansible-core/${pinned}/json`]: {
        info: { requires_python: '>=3.12', requires_dist: REQUIRES, ...current.info },
        urls: current.urls ?? [coreFile(pinned, env.ANSIBLE_CORE_SHA256), sdist('ansible_core', pinned)],
      },
      [`${PYPI}/ansible-core/${nextPatch}/json`]: {
        info: { requires_python: '>=3.12', requires_dist: REQUIRES, ...next.info },
        urls: next.urls ?? [coreFile(nextPatch, nextSha), sdist('ansible_core', nextPatch)],
      },
    };
    for (const dep of deps) {
      // The pinned wheel among the others PyPI lists for the release.
      routes[`${PYPI}/${dep.name}/${dep.version}/json`] = {
        info: { requires_dist: [] },
        urls: [depWheel(dep, dep.version, hex('b'), 'cp314-cp314-win_amd64'), depWheel(dep, dep.version, dep.sha256), sdist(dep.name, dep.version)],
      };
    }
    return routes;
  }

  /** A fake fetch that also records every URL it was asked for. */
  function counting(routes) {
    const urls = [];
    const serve = fakeFetch(routes);
    return { urls, fetchImpl: async (url, init) => (urls.push(url), serve(url, init)) };
  }

  it('reads the live ANSIBLE_CORE_DEPS block, and refuses a line in any other shape', () => {
    expect(deps.length).toBeGreaterThan(0);
    expect(new Set(deps.map((d) => normalizePyName(d.name))).size).toBe(deps.length);
    for (const name of ['jinja2', 'pyyaml', 'cryptography', 'packaging', 'resolvelib']) expect(depNamed(name), name).toBeTruthy();
    const broken = envText.replace(deps[0].line, `${deps[0].name}>=${deps[0].version}`);
    expect(() => readAnsibleCoreDeps(broken)).toThrow(/not name==version --hash=sha256/);
    expect(() => readAnsibleCoreDeps('BASE_IMAGE=x\n')).toThrow(/no ANSIBLE_CORE_DEPS block/);
  });

  it('reads Requires-Dist as PyPI writes it: markers kept, extras dropped, names normalised, only == as an exact pin', () => {
    const reqs = requirementsOf(['PyYAML>=5.1', 'resolvelib<2.0.0,>=0.8.0', 'cryptography', 'foo (==1.0)', 'bar[x] >= 2 ; python_version < "3.13"', 'pytest; extra == "test"']);
    expect([...reqs.keys()]).toEqual(['pyyaml', 'resolvelib', 'cryptography', 'foo', 'bar']);
    expect(reqs.get('pyyaml')).toEqual({ name: 'PyYAML', specifier: '>=5.1', marker: '' });
    expect(reqs.get('foo').specifier).toBe('==1.0');
    expect(reqs.get('bar')).toEqual({ name: 'bar', specifier: '>=2', marker: 'python_version < "3.13"' });
    expect(exactPin('==1.0')).toBe('1.0');
    expect(exactPin('===1.0')).toBe('1.0');
    for (const range of ['', '>=1.0', '==1.*', '==1.0,<2', '~=1.0', '!=1.0']) expect(exactPin(range), range).toBeNull();
    expect(wheelTags('markupsafe-3.0.3-cp314-cp314-manylinux2014_x86_64.manylinux_2_17_x86_64.whl')).toBe(
      'cp314-cp314-manylinux2014_x86_64.manylinux_2_17_x86_64'
    );
    expect(wheelTags('pkg-1.0-1-py3-none-any.whl')).toBe('py3-none-any');
    expect(normalizePyName('Ruamel.YAML__clib')).toBe('ruamel-yaml-clib');
  });

  it('moves ANSIBLE_CORE_VERSION and ANSIBLE_CORE_SHA256 to the newest release in the line, every pinned wheel read back once', async () => {
    const { urls, fetchImpl } = counting(pypi());
    const plan = await planImageBase({ files, http: makeHttp(fetchImpl) });
    const bump = plan.applied.find((b) => b.key === 'ansible-core');
    expect(bump).toMatchObject({ from: pinned, to: nextPatch });
    expect(bump.changes.map((c) => c.where)).toEqual(['ANSIBLE_CORE_VERSION', 'ANSIBLE_CORE_SHA256']);
    // Those two lines move and nothing else in the file (the base reads 404 here, so they are notes).
    const before = envText.split('\n');
    expect(plan.files[VERSIONS_ENV_PATH].split('\n').filter((l, i) => l !== before[i])).toEqual([
      `ANSIBLE_CORE_VERSION=${nextPatch}`,
      `ANSIBLE_CORE_SHA256=${nextSha}`,
    ]);
    expect(readAnsibleCoreDeps(plan.files[VERSIONS_ENV_PATH])).toEqual(deps);
    expect(bump.evidence[0]).toMatchObject({ item: `ansible_core-${nextPatch}-py3-none-any.whl (SHA256)`, value: nextSha });
    expect(bump.evidence[0].source).toContain(`${PYPI}/ansible-core/${nextPatch}/json`);
    // Every pinned dependency's wheel, by the hash versions.env pins, read from its release's own JSON: one request each.
    for (const dep of deps) {
      const url = `${PYPI}/${dep.name}/${dep.version}/json`;
      expect(bump.evidence).toContainEqual(expect.objectContaining({ value: dep.sha256, source: url }));
      expect(urls.filter((u) => u === url)).toHaveLength(1);
    }
    expect(ansibleNotes(plan)).toEqual([]);
    expect(renderEvidence(plan.applied, { set: 'image-base', date: '2026-10-15' })).toContain(`### ansible-core (lab image and lab host): ${pinned} → ${nextPatch}`);
  });

  it('reads only the project JSON, and moves and notes nothing, when the pinned release is the newest', async () => {
    const { urls, fetchImpl } = counting(pypi({ latest: pinned, releases: { [pinned]: [coreFile(pinned, env.ANSIBLE_CORE_SHA256)] } }));
    const plan = await planImageBase({ files, http: makeHttp(fetchImpl) });
    expect(plan.applied.filter((b) => b.key === 'ansible-core')).toEqual([]);
    expect(ansibleNotes(plan)).toEqual([]);
    expect(urls.filter((u) => u.startsWith(PYPI))).toEqual([`${PYPI}/ansible-core/json`]);
    expect(plan.files[VERSIONS_ENV_PATH]).toBe(envText);
  });

  it('takes the newest stable patch of the pinned line, past pre-releases and yanked files, and notes a new line rather than taking it', async () => {
    const routes = pypi({
      latest: nextLine,
      releases: {
        [pinned]: [coreFile(pinned, env.ANSIBLE_CORE_SHA256)],
        [nextPatch]: [coreFile(nextPatch, nextSha)],
        [`${major}.${minor}.100rc1`]: [coreFile(`${major}.${minor}.100rc1`, hex('c'))],
        [`${major}.${minor}.101`]: [coreFile(`${major}.${minor}.101`, hex('d'), { yanked: true })],
        [nextLine]: [coreFile(nextLine, hex('f'))],
      },
    });
    const plan = await planImageBase({ files, http: makeHttp(fakeFetch(routes)) });
    expect(plan.applied.find((b) => b.key === 'ansible-core')).toMatchObject({ from: pinned, to: nextPatch });
    const line = plan.notes.find((n) => n.label === 'ansible-core release line');
    expect(line).toMatchObject({ from: pinned, to: nextLine });
    expect(line.reason).toMatch(/moved by hand/);
    expect(line.reason).toContain('.github/workflows/ci.yml');
  });

  it('takes nothing when PyPI names a pre-release as the newest', async () => {
    const plan = await planImageBase({ files, http: makeHttp(fakeFetch(pypi({ latest: `${nextLine}rc1` }))) });
    expect(plan.applied.filter((b) => b.key === 'ansible-core')).toEqual([]);
    expect(ansibleNotes(plan).map((n) => n.reason).join(' ')).toMatch(/not a stable release/);
    expect(plan.files[VERSIONS_ENV_PATH]).toBe(envText);
  });

  it('holds PyPI\'s newest release to the same wheel and yank filter, so an unusable newest patch never hides an older valid one', async () => {
    const newestPatch = `${major}.${minor}.100`;
    // Its only wheel yanked, then an sdist and no wheel at all.
    for (const newestFiles of [[coreFile(newestPatch, hex('d'), { yanked: true })], [sdist('ansible_core', newestPatch)]]) {
      const { urls, fetchImpl } = counting(
        pypi({
          latest: newestPatch,
          releases: { [pinned]: [coreFile(pinned, env.ANSIBLE_CORE_SHA256)], [nextPatch]: [coreFile(nextPatch, nextSha)], [newestPatch]: newestFiles },
        })
      );
      const plan = await planImageBase({ files, http: makeHttp(fetchImpl) });
      expect(plan.applied.find((b) => b.key === 'ansible-core')).toMatchObject({ from: pinned, to: nextPatch });
      expect(ansibleNotes(plan)).toEqual([]);
      expect(urls).not.toContain(`${PYPI}/ansible-core/${newestPatch}/json`);
    }
  });

  it('is a note, and moves nothing, when the project JSON no longer carries the releases map PyPI lists as deprecated', async () => {
    const routes = pypi();
    delete routes[`${PYPI}/ansible-core/json`].releases;
    const plan = await planImageBase({ files, http: makeHttp(fakeFetch(routes)) });
    expect(plan.applied.filter((b) => b.key === 'ansible-core')).toEqual([]);
    expect(ansibleNotes(plan)).toEqual([
      expect.objectContaining({ from: pinned, reason: `${PYPI}/ansible-core/json carries no releases map to choose a release in the ${major}.${minor} line from` }),
    ]);
    expect(plan.files[VERSIONS_ENV_PATH]).toBe(envText);
  });

  it('is a note when PyPI cannot be read, and the base plans go on without it', async () => {
    const plan = await planImageBase({ files, http: makeHttp(fakeFetch({})) });
    expect(ansibleNotes(plan)).toEqual([expect.objectContaining({ from: pinned, reason: `${PYPI}/ansible-core/json: HTTP 404` })]);
    expect(plan.files[VERSIONS_ENV_PATH]).toBe(envText);
  });

  // Each of these is something the plan cannot verify, so the release is a note and versions.env is left as it was.
  const unverifiable = [
    [
      'a pinned dependency\'s hash is not one PyPI serves for that version',
      (routes) => {
        const dep = deps[0];
        routes[`${PYPI}/${dep.name}/${dep.version}/json`] = { info: {}, urls: [depWheel(dep, dep.version, hex('9'))] };
      },
      new RegExp(`lists no wheel of ${deps[0].name} ${escapeRegExp(deps[0].version)} with the SHA256 ANSIBLE_CORE_DEPS pins`),
    ],
    [
      'ANSIBLE_CORE_SHA256 is not PyPI\'s digest for the pinned release',
      (routes) => {
        routes[`${PYPI}/ansible-core/${pinned}/json`].urls = [coreFile(pinned, hex('7'))];
      },
      /ANSIBLE_CORE_SHA256 is not the SHA256 .* so the pin being moved from is itself unverified/,
    ],
    [
      'the new release has more than its one wheel',
      (routes) => {
        routes[`${PYPI}/ansible-core/${nextPatch}/json`].urls.push(coreFile(nextPatch, hex('8'), { filename: `ansible_core-${nextPatch}-py2-none-any.whl` }));
      },
      /not the one wheel ansible_core-/,
    ],
    [
      'the new release moves Requires-Python',
      (routes) => {
        routes[`${PYPI}/ansible-core/${nextPatch}/json`].info.requires_python = '>=3.13';
      },
      /declares Requires-Python >=3\.13, where .* declared >=3\.12/,
    ],
    [
      'the new release changes a requirement other than to an exact pin',
      (routes) => {
        routes[`${PYPI}/ansible-core/${nextPatch}/json`].info.requires_dist = REQUIRES.map((r) => (r.startsWith('jinja2') ? 'jinja2>=3.2.0' : r));
      },
      new RegExp(`requires jinja2>=3\\.2\\.0, where .* required jinja2>=3\\.1\\.0; whether ${depNamed('jinja2').name}==\\S+ still satisfies that is not evaluated here`),
    ],
    [
      'the new release adds a dependency ANSIBLE_CORE_DEPS does not list',
      (routes) => {
        routes[`${PYPI}/ansible-core/${nextPatch}/json`].info.requires_dist = [...REQUIRES, 'rich>=13'];
      },
      /requires rich>=13, which ANSIBLE_CORE_DEPS does not list/,
    ],
    [
      'the new release drops a dependency ANSIBLE_CORE_DEPS still lists',
      (routes) => {
        routes[`${PYPI}/ansible-core/${nextPatch}/json`].info.requires_dist = REQUIRES.filter((r) => r !== 'packaging');
      },
      /no longer requires packaging/,
    ],
  ];
  it.each(unverifiable)('is a note that edits nothing when %s', async (_what, change, reason) => {
    const routes = pypi();
    change(routes);
    const plan = await planImageBase({ files, http: makeHttp(fakeFetch(routes)) });
    expect(plan.applied.filter((b) => b.key === 'ansible-core')).toEqual([]);
    const notes = ansibleNotes(plan);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ label: 'ansible-core (lab image and lab host)', from: pinned, to: nextPatch });
    expect(notes[0].reason).toMatch(reason);
    expect(plan.files[VERSIONS_ENV_PATH]).toBe(envText);
    expect(renderNotes(plan.notes)).toContain(`**ansible-core (lab image and lab host)** ${pinned} → ${nextPatch}`);
  });

  describe('a dependency the new release pins exactly', () => {
    const dep = depNamed('resolvelib');
    const to = '9.9.9';
    const pinnedTags = 'py3-none-any';
    function routesPinning({ movedRequires = [], wheels } = {}) {
      const routes = pypi();
      routes[`${PYPI}/ansible-core/${nextPatch}/json`].info.requires_dist = REQUIRES.map((r) => (r.startsWith('resolvelib') ? `resolvelib==${to}` : r));
      // The pinned resolvelib wheel is pure Python; PyPI lists its other builds beside it.
      routes[`${PYPI}/${dep.name}/${dep.version}/json`] = {
        info: { requires_dist: [] },
        urls: [depWheel(dep, dep.version, hex('3'), 'py2-none-any'), depWheel(dep, dep.version, dep.sha256, pinnedTags)],
      };
      routes[`${PYPI}/${dep.name}/${to}/json`] = {
        info: { requires_dist: movedRequires },
        urls: wheels ?? [depWheel(dep, to, hex('5'), 'py2-none-any'), depWheel(dep, to, hex('6'), pinnedTags), sdist(dep.name, to)],
      };
      return routes;
    }

    it('moves its line to that version, the wheel built for the same tags, and leaves every other line', async () => {
      const plan = await planImageBase({ files, http: makeHttp(fakeFetch(routesPinning())) });
      const bump = plan.applied.find((b) => b.key === 'ansible-core');
      expect(bump).toMatchObject({ from: pinned, to: nextPatch });
      const after = readAnsibleCoreDeps(plan.files[VERSIONS_ENV_PATH]);
      expect(after.find((d) => d.name === dep.name)).toMatchObject({ version: to, sha256: hex('6') });
      expect(after.filter((d) => d.name !== dep.name)).toEqual(deps.filter((d) => d.name !== dep.name));
      expect(bump.changes.map((c) => c.where)).toEqual(['ANSIBLE_CORE_VERSION', 'ANSIBLE_CORE_SHA256', `ANSIBLE_CORE_DEPS ${dep.name}`]);
      expect(bump.changes[2]).toMatchObject({ from: dep.line, to: `${dep.name}==${to} --hash=sha256:${hex('6')}` });
      expect(bump.evidence).toContainEqual(
        expect.objectContaining({ value: hex('6'), source: expect.stringContaining(`${PYPI}/${dep.name}/${to}/json`) })
      );
    });

    it('is a note when that version has no wheel for the same tags', async () => {
      const routes = routesPinning({ wheels: [depWheel(dep, to, hex('5'), 'py2-none-any')] });
      const plan = await planImageBase({ files, http: makeHttp(fakeFetch(routes)) });
      expect(plan.applied.filter((b) => b.key === 'ansible-core')).toEqual([]);
      expect(ansibleNotes(plan)[0].reason).toMatch(new RegExp(`pins resolvelib==${escapeRegExp(to)}, and .* lists 0 wheels with a SHA256 for py3-none-any`));
      expect(plan.files[VERSIONS_ENV_PATH]).toBe(envText);
    });

    it('is a note when that version changes its own requirements', async () => {
      const plan = await planImageBase({ files, http: makeHttp(fakeFetch(routesPinning({ movedRequires: ['newdep>=1'] }))) });
      expect(plan.applied.filter((b) => b.key === 'ansible-core')).toEqual([]);
      expect(ansibleNotes(plan)[0].reason).toMatch(/whose own requirements differ/);
      expect(plan.files[VERSIONS_ENV_PATH]).toBe(envText);
    });
  });
});

describe('the consumers\' digest plan', () => {
  const files = Object.fromEntries([CAPABILITIES_PATH, CODER_TEMPLATE_PATH].map((p) => [p, real(p)]));
  const runnerManifest = JSON.stringify({ runner: 1 });
  const fullManifest = JSON.stringify({ full: 1 });
  const tag = 'f'.repeat(40);
  const routes = (fullServed = fullManifest) => ({
    'https://auth.docker.io/token?service=registry.docker.io&scope=repository:hybridcloudworks/hcw-lab-runner:pull': { token: 't' },
    'https://auth.docker.io/token?service=registry.docker.io&scope=repository:hybridcloudworks/hcw-lab:pull': { token: 't' },
    [`https://registry-1.docker.io/v2/hybridcloudworks/hcw-lab-runner/manifests/${tag}`]: runnerManifest,
    [`https://registry-1.docker.io/v2/hybridcloudworks/hcw-lab/manifests/${tag}`]: fullServed,
  });
  const runner = `docker.io/hybridcloudworks/hcw-lab-runner:${tag}@${sha(runnerManifest)}`;
  const full = `docker.io/hybridcloudworks/hcw-lab:${tag}@${sha(fullManifest)}`;

  it('pins both consumers to the digests Docker Hub serves for the published tag', async () => {
    const plan = await planImageDigests({ files, http: makeHttp(fakeFetch(routes())), runner, full });
    expect(plan.notes).toEqual([]);
    expect(plan.files[CAPABILITIES_PATH]).toContain(`'${runner}'`);
    expect(plan.files[CODER_TEMPLATE_PATH]).toMatch(new RegExp(`image_tag\\s*=\\s*"${tag}"`));
    expect(plan.files[CODER_TEMPLATE_PATH]).toMatch(new RegExp(`image_digest\\s*=\\s*"${sha(fullManifest)}"`));
    const before = files[CODER_TEMPLATE_PATH].split('\n');
    expect(plan.files[CODER_TEMPLATE_PATH].split('\n').filter((l, i) => l !== before[i])).toHaveLength(2);
  });

  it('pins neither image whose registry digest disagrees with the publish job, and says so', async () => {
    const plan = await planImageDigests({ files, http: makeHttp(fakeFetch(routes('{"other":1}'))), runner, full });
    expect(plan.files[CODER_TEMPLATE_PATH]).toBe(files[CODER_TEMPLATE_PATH]);
    expect(plan.notes[0].reason).toMatch(/not the .* the publish job reported/);
  });

  it('refuses references that are not the two lab images', async () => {
    await expect(planImageDigests({ files, http: null, runner: 'alpine:3', full })).rejects.toThrow(/--runner must be/);
  });
});
