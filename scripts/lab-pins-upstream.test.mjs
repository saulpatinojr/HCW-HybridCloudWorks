import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describePinCommentProblem, pinCommentProblems } from './lib/lab-pin-comments.mjs';
import {
  BOOTSTRAP_PATH,
  CADDY_TEST_PATH,
  DOCKER_CLI_FIXTURE_PATH,
  GROUP_VARS_PATH,
  makeHttp,
  planHost,
  setYamlScalar,
} from './lib/lab-pin-bumps.mjs';
import {
  LABELS,
  check,
  compareVersions,
  coreVersion,
  newest,
  newestAptVersion,
  newestDockerHubTag,
  newestGitHubRelease,
  newestGitHubTag,
  newestHashicorp,
  newestNodeLine,
  readPins,
  renderMarkdown,
  scalar,
  sources,
} from './lab-pins-upstream.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('version arithmetic', () => {
  it('extracts the dotted core from apt, tag and plain forms', () => {
    expect(coreVersion('5:29.8.1-1~ubuntu.26.04~resolute')).toBe('29.8.1');
    expect(coreVersion('v2.11.4')).toBe('2.11.4');
    expect(coreVersion('18.6')).toBe('18.6');
    expect(coreVersion('26.10.0-1nodesource1')).toBe('26.10.0');
    expect(coreVersion('latest')).toBeNull();
    expect(coreVersion(null)).toBeNull();
  });
  it('compares segment-wise, numerically', () => {
    expect(compareVersions('2.3.6', '2.3.10')).toBe(-1);
    expect(compareVersions('29.8.1', '29.8.1')).toBe(0);
    expect(compareVersions('18.6', '18.5.1')).toBe(1);
    expect(newest(['1.2.3', '1.10.0', '1.9.9'])).toBe('1.10.0');
    expect(newest([])).toBeNull();
  });
});

describe('reading the pins', () => {
  it('reads a scalar with or without quotes and ignores a trailing comment', () => {
    const text = 'a: "1.2.3"\nb: 4.5.6 # note\nc: v7\n';
    expect(scalar(text, 'a')).toBe('1.2.3');
    expect(scalar(text, 'b')).toBe('4.5.6');
    expect(scalar(text, 'c')).toBe('v7');
    expect(scalar(text, 'd')).toBeNull();
  });
  it('finds every watched pin in the real group_vars, so a renamed key cannot silently drop a component', () => {
    const pins = readPins(readFileSync(join(REPO, 'lab-host', 'ansible', 'group_vars', 'all.yml'), 'utf8'));
    for (const key of Object.keys(LABELS)) {
      expect(pins[key], key).toMatch(/^\d+(\.\d+)+$/);
    }
    expect(pins.dockerEngine).toMatch(/^29\./);
  });
});

describe('upstream readers', () => {
  it('reads the newest stable version of one package from a Debian Packages index', () => {
    const index = [
      'Package: docker-ce\nVersion: 5:29.8.1-1~ubuntu.26.04~resolute\nArchitecture: amd64',
      'Package: docker-ce\nVersion: 5:29.9.0-1~ubuntu.26.04~resolute\nArchitecture: amd64',
      'Package: containerd.io\nVersion: 2.3.7-1~ubuntu.26.04~resolute\nArchitecture: amd64',
      'Package: docker-ce-cli\nVersion: 5:30.0.0-1~ubuntu.26.04~resolute\nArchitecture: amd64',
    ].join('\n\n');
    expect(newestAptVersion(index, 'docker-ce')).toBe('29.9.0');
    expect(newestAptVersion(index, 'containerd.io')).toBe('2.3.7');
    expect(newestAptVersion(index, 'runc')).toBeNull();
    // The dot in a package name is a literal, not "any character".
    expect(newestAptVersion('Package: containerdXio\nVersion: 9.9.9\n', 'containerd.io')).toBeNull();
  });
  it('skips prereleases, drafts and non-numeric tags in a GitHub releases listing', () => {
    expect(
      newestGitHubRelease([
        { tag_name: 'v2.12.0-beta.1', prerelease: true, draft: false },
        { tag_name: 'v2.11.4', prerelease: false, draft: false },
        { tag_name: 'v2.11.5', prerelease: false, draft: true },
        { tag_name: 'nightly', prerelease: false, draft: false },
      ])
    ).toBe('2.11.4');
  });
  it('reads the newest stable tag from a GitHub tags listing', () => {
    expect(newestGitHubTag([{ name: 'v0.2.4' }, { name: 'v0.2.5-rc1' }, { name: 'v0.2.5' }, { name: 'tip' }])).toBe('0.2.5');
  });
  it('reads the newest stable version from a HashiCorp index and ignores rc/ent builds', () => {
    expect(newestHashicorp({ versions: { '2.1.1': {}, '2.2.0-rc1': {}, '2.1.1+ent': {}, '2.1.2': {} } })).toBe('2.1.2');
  });
  it('reads the newest tag in one line from a Docker Hub listing', () => {
    const results = [{ name: '18.6' }, { name: '18.7' }, { name: '18' }, { name: '18.7-alpine' }, { name: '17.12' }];
    expect(newestDockerHubTag(results, '18')).toBe('18.7');
  });
  it('reads the newest release in one Node.js line', () => {
    expect(newestNodeLine([{ version: 'v27.0.0' }, { version: 'v26.10.0' }, { version: 'v26.11.1' }], 26)).toBe('26.11.1');
  });
  it('has one source per watched pin', () => {
    expect(Object.keys(sources({})).sort()).toEqual(Object.keys(LABELS).sort());
  });
});

describe('the check', () => {
  const pins = Object.fromEntries(Object.keys(LABELS).map((k) => [k, '1.0.0']));
  const readers = (overrides) =>
    Object.fromEntries(Object.keys(LABELS).map((k) => [k, overrides[k] ?? (async () => '1.0.0')]));

  it('exits 0 when every pin is current', async () => {
    const { rows, exitCode } = await check({ pins, readers: readers({}) });
    expect(exitCode).toBe(0);
    expect(rows.every((r) => r.status === 'current')).toBe(true);
  });
  it('exits 1 when one pin is behind, and names it', async () => {
    const { rows, exitCode } = await check({ pins, readers: readers({ containerd: async () => '1.0.1' }) });
    expect(exitCode).toBe(1);
    expect(rows.find((r) => r.key === 'containerd').status).toBe('BEHIND');
    expect(renderMarkdown(rows)).toContain('| containerd.io (carries runc) | 1.0.0 | 1.0.1 | BEHIND |');
  });
  it('exits 2 when a source cannot be read, even if nothing is behind — not evaluated is not fine', async () => {
    const { rows, exitCode } = await check({
      pins,
      readers: readers({
        vault: async () => {
          throw new Error('HTTP 503');
        },
      }),
    });
    expect(exitCode).toBe(2);
    expect(rows.find((r) => r.key === 'vault').status).toMatch(/^unreadable: HTTP 503/);
  });
  it('exits 2 when a pin is missing from group_vars', async () => {
    const { exitCode, rows } = await check({ pins: { ...pins, caddy: null }, readers: readers({}) });
    expect(exitCode).toBe(2);
    expect(rows.find((r) => r.key === 'caddy').status).toBe('pin not found');
  });
});

// ── The comments beside a pin (#1444) ──────────────────────────────────────

describe('comments beside a pin the weekly bump moves', () => {
  const file = 'pins.yml';
  const foo = `foo_version: v1.2.3\nfoo_digest: sha256:${'ab12'.repeat(16)}`;
  const problems = (text, wheres = ['foo_version']) =>
    pinCommentProblems({ [file]: text }, wheres.map((where) => ({ file, where })));

  it('reports a comment that names a different version than its pin, with the file, the line, the version and the pin', () => {
    const found = problems(['---', '# Foo 1.2.0 is the newest release, read 2026-09-26.', foo, ''].join('\n'));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ file, line: 2, kind: 'version', token: '1.2.0', repeats: false });
    expect(found[0].pins).toEqual([{ file, where: 'foo_version', line: 3, value: 'v1.2.3' }]);
    expect(describePinCommentProblem(found[0])).toMatch(
      /^pins\.yml:2 names the version 1\.2\.0, but the pin it sits beside holds something else: foo_version = v1\.2\.3 \(line 3\)\./
    );
  });

  it("reports a comment that names the pin's own value too, because the next bump leaves it behind", () => {
    const found = problems(['---', '# Foo 1.2.3, the release the pin holds.', foo, ''].join('\n'));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ line: 2, token: '1.2.3', repeats: true });
    expect(describePinCommentProblem(found[0])).toContain('which is what the pin holds today (foo_version = v1.2.3 (line 3))');
  });

  it('names a tag-style version in full, and a digest prefix', () => {
    const text = [
      '---',
      '# The index of foo:1.2.0-builder is sha256:ab12ab12ab12... (read 2026-09-25).',
      'foo_version: 1.2.3-builder',
      `foo_digest: sha256:${'cd34'.repeat(16)}`,
      '',
    ].join('\n');
    expect(problems(text, ['foo_version', 'foo_digest']).map((p) => [p.kind, p.token, p.repeats])).toEqual([
      ['version', '1.2.0-builder', false],
      ['digest', 'sha256:ab12ab12ab12', false],
    ]);
  });

  it('lets a comment keep its dates, a release line, a number of another length and "the pin below"', () => {
    const text = [
      '---',
      '# The pin below was read on 2026-09-26 and again 2026-10-07 (released 2026-10-06).',
      '# The 1.2 line, or just 1, suits Ubuntu 26.04; HTTP/1.1 and 20260924 are other numbers.',
      foo,
      '',
    ].join('\n');
    expect(problems(text)).toEqual([]);
  });

  it("reads only the comment run directly above the pin's group of lines, so one product's comment is not held against another", () => {
    const text = [
      '---',
      '# Far away 7.7.7, cut off by the blank line.',
      '',
      '# Foo 9.9.9.',
      'foo_image: foo',
      foo,
      '# Bar line 4.4, and 8.8.8 which is the wrong length for a two-part pin.',
      'bar_version: "4.5"',
      '# Below the pins 6.6.6.',
      '',
    ].join('\n');
    expect(problems(text, ['foo_version', 'bar_version']).map((p) => [p.line, p.token, p.pins.map((x) => x.where)])).toEqual([
      [4, '9.9.9', ['foo_version']],
      [8, '4.4', ['bar_version']],
    ]);
  });

  it('shares one report between the pins that sit under the same comment', () => {
    const text = ['---', '# Foo 7.7.7.', 'foo_version: v1.2.3', 'foo_old: 1.2.0', ''].join('\n');
    const found = problems(text, ['foo_version', 'foo_old']);
    expect(found).toHaveLength(1);
    expect(found[0].pins.map((p) => p.where)).toEqual(['foo_version', 'foo_old']);
    expect(found[0].repeats).toBe(false);
    // Naming one pin's own value points at that pin alone.
    const repeated = problems(['---', '# Foo 1.2.0.', 'foo_version: v1.2.3', 'foo_old: 1.2.0', ''].join('\n'), ['foo_version', 'foo_old']);
    expect(repeated.map((p) => [p.repeats, p.pins.map((x) => x.where)])).toEqual([[true, ['foo_old']]]);
  });

  it("finds a pin nested under other keys, and a comment at the end of the pin's own line", () => {
    const text = [
      '---',
      '# Pins by codename, 5.5.5.',
      'pins:',
      '  resolute:',
      '    engine: "5:29.9.2-1~ubuntu.26.04~resolute" # was 29.8.1',
      '',
    ].join('\n');
    expect(problems(text, ['pins.resolute.engine']).map((p) => [p.line, p.token, p.repeats])).toEqual([
      [2, '5.5.5', false],
      [5, '29.8.1', false],
    ]);
  });

  it('reads a KEY=value line of a shell script, and holds the caddy test to every comment it has', () => {
    const shell = { 'run.sh': `#!/usr/bin/env bash\n# Tool 3.1.3.\nTOOL_VERSION=3.1.4\nTOOL_SHA256=${'a'.repeat(64)}\n` };
    const pins = [
      { file: 'run.sh', where: 'TOOL_VERSION' },
      { file: 'run.sh', where: 'TOOL_SHA256' },
    ];
    expect(pinCommentProblems(shell, pins).map((p) => [p.line, p.token])).toEqual([[2, '3.1.3']]);
    const caddy = {
      [CADDY_TEST_PATH]: `#!/usr/bin/env bash\n# Caddy 2.11.4 is checked against the SHA-512 below; HTTP/1.1 is not a version.\n\nCADDY_SHA512='${'b'.repeat(128)}'\n`,
    };
    expect(pinCommentProblems(caddy, [{ file: CADDY_TEST_PATH, where: 'CADDY_SHA512' }]).map((p) => [p.line, p.token])).toEqual([[2, '2.11.4']]);
  });

  it('stops with an error, not a pass, when a pin cannot be found', () => {
    expect(() => problems('---\nfoo_version: v1.2.3\n', ['missing_version'])).toThrow(/missing_version/);
    expect(() => pinCommentProblems({}, [{ file: 'absent.yml', where: 'foo' }])).toThrow(/absent\.yml was not read/);
    expect(() => pinCommentProblems({ 'run.sh': 'A=1\n' }, [{ file: 'run.sh', where: 'B' }])).toThrow(/found 0/);
  });
});

describe('a weekly bump of the real lab host files', () => {
  const real = (path) => readFileSync(join(REPO, path), 'utf8');
  const sha = (s) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
  const hex = (c, n = 64) => c.repeat(n);
  // The release every publisher below serves for its product.
  const NEXT = '99.1.0';

  /** A fetch that serves a fixed map of URL → body (string or object); anything else 404s. */
  function fakeFetch(routes) {
    return async (url) => {
      const body = routes[url];
      if (body === undefined) return new Response('not found', { status: 404 });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
    };
  }

  /** What each publisher the host bump reads would serve if it had released NEXT. */
  function publishers() {
    const routes = {};
    const docker = 'https://download.docker.com/linux/ubuntu/dists';
    for (const [codename, release] of [
      ['resolute', '26.04'],
      ['noble', '24.04'],
    ]) {
      const tail = `-1~ubuntu.${release}~${codename}`;
      const stanza = (name, version, c) => `Package: ${name}\nVersion: ${version}\nSHA256: ${hex(c)}\n`;
      const packages = [
        stanza('docker-ce', `5:${NEXT}${tail}`, '1'),
        stanza('docker-ce-cli', `5:${NEXT}${tail}`, '2'),
        stanza('docker-ce-rootless-extras', `5:${NEXT}${tail}`, '3'),
        stanza('containerd.io', `${NEXT}${tail}`, '4'),
        stanza('docker-buildx-plugin', `${NEXT}${tail}`, '5'),
        stanza('docker-compose-plugin', `${NEXT}${tail}`, '6'),
      ].join('\n');
      routes[`${docker}/${codename}/stable/binary-amd64/Packages`] = packages;
      routes[`${docker}/${codename}/InRelease`] = `SHA256:\n ${sha(packages).slice(7)} 1 stable/binary-amd64/Packages\n`;
    }
    const nodesource = 'https://deb.nodesource.com/node_26.x/dists/nodistro';
    const nodejs = `Package: nodejs\nVersion: ${NEXT}-1nodesource1\nSHA256: ${hex('7')}\n`;
    routes[`${nodesource}/main/binary-amd64/Packages`] = nodejs;
    routes[`${nodesource}/InRelease`] = `SHA256:\n ${sha(nodejs).slice(7)} 1 main/binary-amd64/Packages\n`;

    const image = (registry, repository, tag) => {
      const manifest = JSON.stringify({ schemaVersion: 2, manifests: [], repository, tag });
      if (registry === 'ghcr') {
        routes[`https://ghcr.io/token?scope=repository:${repository}:pull`] = { token: 't' };
        routes[`https://ghcr.io/v2/${repository}/manifests/${tag}`] = manifest;
        return;
      }
      routes[`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`] = { token: 't' };
      routes[`https://registry-1.docker.io/v2/${repository}/manifests/${tag}`] = manifest;
      routes[`https://hub.docker.com/v2/repositories/${repository}/tags/${tag}`] = { digest: sha(manifest) };
    };
    image('hub', 'library/caddy', `${NEXT}-builder`);
    image('ghcr', 'coder/coder', `v${NEXT}`);
    image('hub', 'library/postgres', '99.1');
    image('hub', 'portainer/portainer-ee', NEXT);

    routes[`https://github.com/caddyserver/caddy/releases/download/v${NEXT}/caddy_${NEXT}_checksums.txt`] =
      `${hex('c', 128)}  caddy_${NEXT}_linux_amd64.tar.gz\n`;
    routes[`https://sum.golang.org/lookup/github.com/caddy-dns/cloudflare@v${NEXT}`] =
      `1\ngithub.com/caddy-dns/cloudflare v${NEXT} h1:abc123=\n`;
    routes[`https://releases.hashicorp.com/vault/${NEXT}/vault_${NEXT}_SHA256SUMS`] = `${hex('d')}  vault_${NEXT}_linux_amd64.zip\n`;
    routes[`https://github.com/prometheus/node_exporter/releases/download/v${NEXT}/sha256sums.txt`] =
      `${hex('e')}  node_exporter-${NEXT}.linux-amd64.tar.gz\n`;
    routes[`https://github.com/sigstore/cosign/releases/download/v${NEXT}/cosign_checksums.txt`] = `${hex('f')}  cosign-linux-amd64\n`;
    return routes;
  }

  /** The files the host bump reads or is held to, as the repository has them now. */
  const repositoryFiles = () => ({
    [GROUP_VARS_PATH]: real(GROUP_VARS_PATH),
    [BOOTSTRAP_PATH]: real(BOOTSTRAP_PATH),
    [CADDY_TEST_PATH]: real(CADDY_TEST_PATH),
    [DOCKER_CLI_FIXTURE_PATH]: real(DOCKER_CLI_FIXTURE_PATH),
  });

  /** The real bumpers over `files`, with every watched product BEHIND (PostgreSQL's tag has two parts, the rest three). */
  async function bumpEverything(files) {
    const pins = readPins(files[GROUP_VARS_PATH]);
    const rows = Object.keys(LABELS).map((key) => ({
      key,
      label: LABELS[key],
      pinned: pins[key],
      latest: key === 'postgres' ? '99.1' : NEXT,
      status: 'BEHIND',
    }));
    return planHost({
      text: files[GROUP_VARS_PATH],
      files: { [CADDY_TEST_PATH]: files[CADDY_TEST_PATH], [BOOTSTRAP_PATH]: files[BOOTSTRAP_PATH] },
      rows,
      http: makeHttp(fakeFetch(publishers())),
    });
  }

  /** Every (file, key) the plan edited, once. The Docker CLI fixture is moved by its own script, not by the plan, so it is added. */
  function movedBy(plan) {
    const seen = new Map();
    for (const { file, where } of plan.applied.flatMap((bump) => bump.changes)) seen.set(`${file}|${where}`, { file, where });
    return [...seen.values(), { file: DOCKER_CLI_FIXTURE_PATH, where: 'dockerCli' }];
  }

  it("moves every watched product in every file the bump edits, so the pins checked below really are the bump's", async () => {
    const plan = await bumpEverything(repositoryFiles());
    expect(plan.notes).toEqual([]);
    expect(plan.applied.map((bump) => bump.key).sort()).toEqual(Object.keys(LABELS).sort());
    expect([...new Set(movedBy(plan).map((p) => p.file))].sort()).toEqual(
      [BOOTSTRAP_PATH, CADDY_TEST_PATH, DOCKER_CLI_FIXTURE_PATH, GROUP_VARS_PATH].sort()
    );
    expect(plan.files[GROUP_VARS_PATH]).toContain(`caddy_version: v${NEXT}\n`);
    expect(plan.files[GROUP_VARS_PATH]).toContain(`labs_agent_node_version: "${NEXT}-1nodesource1"\n`);
    expect(plan.files[BOOTSTRAP_PATH]).toContain(`COSIGN_VERSION=${NEXT}\n`);
  });

  it('has no comment beside a pin that names a version or a digest today (the bot pull request #1423 had three that contradicted its pins)', async () => {
    const files = repositoryFiles();
    const plan = await bumpEverything(files);
    expect(pinCommentProblems(files, movedBy(plan)).map(describePinCommentProblem)).toEqual([]);
  });

  it('leaves no comment contradicting a pin after it has moved every value', async () => {
    const files = repositoryFiles();
    const plan = await bumpEverything(files);
    const after = { ...files, ...plan.files };
    expect(after[GROUP_VARS_PATH]).not.toBe(files[GROUP_VARS_PATH]);
    expect(pinCommentProblems(after, movedBy(plan)).map(describePinCommentProblem)).toEqual([]);
  });

  it('catches a bump that moves a value whose comment still names the old one, and says where', async () => {
    const files = repositoryFiles();
    const old = setYamlScalar(files[GROUP_VARS_PATH], ['labs_agent_node_version'], 'x').from;
    const lines = files[GROUP_VARS_PATH].split('\n');
    const at = lines.findIndex((l) => l.startsWith('labs_agent_node_version:'));
    lines.splice(at, 0, `# The newest nodejs is ${old}, read 2026-10-27.`);
    const stale = { ...files, [GROUP_VARS_PATH]: lines.join('\n') };

    const plan = await bumpEverything(stale);
    const moved = movedBy(plan);
    const before = pinCommentProblems(stale, moved).filter((p) => p.token === old);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ line: at + 1, repeats: true });

    const found = pinCommentProblems({ ...stale, ...plan.files }, moved).filter((p) => p.token === old);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ file: GROUP_VARS_PATH, line: at + 1, kind: 'version', repeats: false });
    expect(found[0].pins[0].value).toBe(`${NEXT}-1nodesource1`);
    const message = describePinCommentProblem(found[0]);
    expect(message).toContain(`${GROUP_VARS_PATH}:${at + 1} names the version ${old}`);
    expect(message).toContain(`labs_agent_node_version = ${NEXT}-1nodesource1`);
  });
});
