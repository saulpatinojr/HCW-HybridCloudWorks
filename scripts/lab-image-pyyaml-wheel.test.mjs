/**
 * The PyYAML wheel the lab image builds from source (the `PYYAML` block in
 * lab-image/versions.env, #1505).
 *
 * PyYAML publishes no wheel for the next CPython, so the Dockerfile's fetch
 * stage builds one from PyPI's source archive, verified by its SHA256, with
 * hash-checked build tools, and the runner installs it in its usual offline
 * `--require-hashes` step. This test holds the block to the shape the
 * Dockerfile reads (a version, a 64-hex sum, and `name==version --hash=...`
 * lines, each name once, a line allowed several hashes), holds
 * `PYYAML_VERSION` equal to the `pyyaml` line in `ANSIBLE_CORE_DEPS` (the lab
 * host installs that line; the build stops when the two differ, and this
 * says so without a Docker build), and holds the Dockerfile and smoke.sh to
 * the hardening the block promises: the source archive is the only thing
 * pip may take as source, the wheel is built with no index and no build
 * isolation, the compiler stays in the fetch stage, the runner's install is
 * unchanged, and the shipped image is checked for the C loader. Building
 * the image needs Docker and the network, so it is not done here.
 *
 * The whole block, the step, the stage and the check are deleted the day
 * PyYAML publishes a wheel for the base's Python; this file goes with them.
 *
 * In the CI matrix this runs in the `scripts (operations)` row, whose filter
 * already covers lab-image/.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSIONS_ENV = readFileSync(join(REPO, 'lab-image', 'versions.env'), 'utf8');
const DOCKERFILE = readFileSync(join(REPO, 'lab-image', 'Dockerfile'), 'utf8');
const SMOKE = readFileSync(join(REPO, 'lab-image', 'smoke.sh'), 'utf8');

const value = (name) => VERSIONS_ENV.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1];
const blockLines = (name) =>
  (VERSIONS_ENV.match(new RegExp(`^${name}='([^']*)'$`, 'm'))?.[1] ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
const HASH = '--hash=sha256:[0-9a-f]{64}';
// Case-insensitive, because pip takes `Cython` and `cython` as one name; normalise() folds them for the once-each check.
const LINE = new RegExp(`^([a-z0-9][a-z0-9._-]*)==(\\d+(?:\\.\\d+)*)( ${HASH})+$`, 'i');
/** pip compares names this way (PEP 503), so `Cython` and `cython` are one package. */
const normalise = (name) => name.replace(/[-_.]+/g, '-').toLowerCase();

describe('the PYYAML block in versions.env', () => {
  it('names the release once and the source archive sum once', () => {
    expect(VERSIONS_ENV.match(/^PYYAML_VERSION=/gm)).toHaveLength(1);
    expect(VERSIONS_ENV.match(/^PYYAML_SDIST_SHA256=/gm)).toHaveLength(1);
    expect(VERSIONS_ENV.match(/^PYYAML_BUILD_DEPS=/gm)).toHaveLength(1);
    expect(value('PYYAML_VERSION')).toMatch(/^\d+(\.\d+)*$/);
    expect(value('PYYAML_SDIST_SHA256')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('pins the same PyYAML release as the pyyaml line in ANSIBLE_CORE_DEPS, which the lab host installs', () => {
    const hostLine = blockLines('ANSIBLE_CORE_DEPS').find((line) => line.startsWith('pyyaml=='));
    expect(hostLine, 'ANSIBLE_CORE_DEPS keeps a pyyaml line for lab-host/bootstrap.sh').toBeTruthy();
    expect(hostLine.split('==')[1].split(' ')[0]).toBe(value('PYYAML_VERSION'));
  });

  it('lists each build tool as one pinned wheel line with one or more hashes', () => {
    const lines = blockLines('PYYAML_BUILD_DEPS');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(LINE);
    const names = lines.map((line) => normalise(line.match(LINE)[1]));
    expect(new Set(names).size).toBe(names.length);
    for (const tool of ['cython', 'setuptools', 'wheel']) expect(names, `${tool}, which PyYAML's pyproject asks for`).toContain(tool);
  });

  it('says when the block goes away', () => {
    expect(VERSIONS_ENV).toMatch(/This block is temporary: it is deleted the day PyYAML publishes a\s+#?\s*wheel\s+#?\s*for BASE_PYTHON_VERSION/);
    // One deletion list, in the runbook; versions.env and the README only point at it.
    expect(VERSIONS_ENV).toMatch(/docs\/runbooks\/pyyaml-wheel\.md under "Deleting it when PyYAML\s+#?\s*ships a wheel"/);
    expect(VERSIONS_ENV).not.toMatch(/Delete this whole block/);
  });
});

describe('the Dockerfile around the block', () => {
  const fetch = DOCKERFILE.slice(DOCKERFILE.indexOf(' AS fetch'), DOCKERFILE.indexOf('FROM scratch AS pyyaml-wheel'));
  const runner = DOCKERFILE.slice(DOCKERFILE.indexOf(' AS runner'), DOCKERFILE.indexOf('FROM runner AS full'));

  it('takes the source archive, and only it, as source, hash-checked and with the pinned tools', () => {
    // Instructions only; the comment above the step may name the flag.
    const code = DOCKERFILE.split('\n').filter((line) => !line.trimStart().startsWith('#'));
    expect(code.filter((line) => line.includes('--no-binary=:all:'))).toHaveLength(1);
    expect(fetch).toMatch(/pip download [^\n]*--no-deps [\\\n ]*--no-binary=:all: --require-hashes --no-build-isolation --check-build-dependencies [\\\n ]*--dest sdist -r sdist.txt/);
    expect(fetch).toContain(`printf 'pyyaml==%s --hash=sha256:%s\\n' "\${PYYAML_VERSION}" "\${PYYAML_SDIST_SHA256}" > sdist.txt`);
    // The tools: wheels only, hash-checked, installed with no index.
    expect(fetch).toMatch(/--only-binary=:all: --require-hashes --dest tools -r tools.txt/);
    expect(fetch).toMatch(/--no-index --find-links tools --no-deps --require-hashes -r tools.txt/);
  });

  it('builds the wheel in a RUN with no network, no index and no build isolation, and checks what came out', () => {
    // The build RUN's flags, then the first things it does: no network at all.
    expect(fetch).toMatch(/\nRUN --network=none set -eu; \. \/build\/versions\.env; \\\n[^\n]*cd \/build\/pyyaml; \\\n[^\n]*rm "\$\(dpkg -L libyaml-dev/);
    expect(fetch).toMatch(/pip wheel [^\n]*--no-deps [\\\n ]*--no-build-isolation --check-build-dependencies --no-index --wheel-dir built/);
    // The import guard runs under -I and the extension is looked for in the venv's lib only.
    expect(fetch).toContain(`ext="$(find check/lib -name '_yaml*.so')"`);
    expect(fetch).toContain(`check/bin/python -I -c 'import sys, yaml;`);
    expect(fetch).toContain('-linux_x86_64.whl") ;;');
    expect(fetch).toContain('if ldd "${ext}" | grep -q yaml; then');
    expect(fetch).toContain('yaml.__with_libyaml__ and yaml.CSafeLoader');
    expect(fetch).toContain(`rm "$(dpkg -L libyaml-dev | grep '/libyaml\\.so$')"`);
  });

  it('keeps the compiler and libyaml in the fetch stage only', () => {
    expect(fetch).toMatch(/apt-get install -y --no-install-recommends [^\n]*\bgcc\b[^\n]*\blibc6-dev\b[^\n]*\blibyaml-dev\b/);
    expect(runner).not.toMatch(/apt-get|gcc|libyaml/);
    expect(DOCKERFILE.slice(DOCKERFILE.indexOf('FROM runner AS full'))).not.toMatch(/gcc|libyaml/);
  });

  it('writes the built wheel into the requirements file the runner installs unchanged, and resolves offline', () => {
    // bootstrap.sh carries the same printf line, held equal by
    // lab-host-bootstrap-ansible-core.test.mjs, so the pyyaml line is set aside one pipe later.
    expect(fetch).toContain(`} | sed '/^pyyaml==/d' > /build/requirements-pypi.txt`);
    expect(fetch).toContain('PYYAML_VERSION and the pyyaml line in ANSIBLE_CORE_DEPS name different releases');
    expect(fetch).toMatch(/pip download [^\n]*--no-deps [\\\n ]*--only-binary=:all: --require-hashes --dest \/out\/wheels -r \/build\/requirements-pypi.txt/);
    expect(fetch).toContain('cat /build/requirements-pypi.txt /build/pyyaml-wheel.txt > /out/wheels/requirements.txt');
    expect(fetch).toMatch(/pip install [^\n]*--dry-run --ignore-installed [\\\n ]*--no-index --find-links \/out\/wheels --only-binary=:all: --require-hashes -r \/out\/wheels\/requirements.txt/);
    expect(fetch).toContain(`test "$(find /out/wheels -name '*.whl' | wc -l)" -eq "$(wc -l < /out/wheels/requirements.txt)"`);
    expect(runner).toContain('RUN --mount=type=bind,from=fetch,source=/out/wheels,target=/tmp/wheels --network=none');
    expect(runner).toContain('--no-index --find-links /tmp/wheels --require-hashes -r /tmp/wheels/requirements.txt');
    expect(runner).toContain('pip uninstall -y pip');
    // The Azure CLI override test's anchor: the one `-Im pip install` is the full target's.
    expect(DOCKERFILE.match(/-Im pip install/g)).toHaveLength(1);
  });

  it('has a pyyaml-wheel stage that carries the built wheel alone and feeds no other stage', () => {
    const stage = DOCKERFILE.slice(DOCKERFILE.indexOf('FROM scratch AS pyyaml-wheel'), DOCKERFILE.indexOf('FROM fetch AS vendor'));
    expect(stage.match(/^(COPY|RUN|ADD) /gm)).toEqual(['COPY ']);
    expect(stage).toContain('COPY --from=fetch /out/pyyaml-wheel/ /');
    expect(DOCKERFILE).not.toMatch(/FROM pyyaml-wheel\b|--from=pyyaml-wheel\b/);
  });
});

describe('smoke.sh', () => {
  it('checks the shipped image for the pinned PyYAML with the libyaml C loader', () => {
    expect(SMOKE).toContain('/opt/ansible/bin/python -c \'import yaml; print(yaml.__version__, yaml.__with_libyaml__, yaml.CSafeLoader.__name__)\'');
    expect(SMOKE).toContain('[ "$out" = "${PYYAML_VERSION} True CSafeLoader" ]');
  });
});
