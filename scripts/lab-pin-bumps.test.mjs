import { describe, it, expect } from 'vitest';
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
  SANDBOX_DOCKERFILE_PATH,
  VERSIONS_ENV_PATH,
  aptPick,
  compareDebian,
  dockerCliDeb,
  goSumHash,
  inReleaseSha256,
  makeHttp,
  parseImageRef,
  planHost,
  planImageBase,
  planImageDigests,
  readEnv,
  readManifest,
  registryOf,
  renderEvidence,
  renderNotes,
  renderPlan,
  replaceEvery,
  replaceFrom,
  resolveTag,
  setEnvValue,
  setYamlScalar,
  sumsLine,
} from './lib/lab-pin-bumps.mjs';
import { LABELS } from './lab-pins-upstream.mjs';

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
    const plan = await planImageBase({ files, http: makeHttp(fakeFetch(routes)) });
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
