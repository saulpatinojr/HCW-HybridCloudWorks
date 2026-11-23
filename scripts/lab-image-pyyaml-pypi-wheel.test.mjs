/**
 * The lab image takes PyYAML from PyPI as a hash-pinned wheel, and proves in
 * its smoke test that the wheel has the C loader (#1778).
 *
 * Until #1778 the image built PyYAML from source, because PyYAML 6.0.3 had no
 * wheel (ready-built package) for CPython 3.15, and a workflow published the
 * built file for the lab host (#1505). PyYAML 6.0.4 has the wheel, so all of
 * that was deleted. What is left to hold is small, and nothing else holds it:
 *
 *   - pip checks that the file is the pinned file, not what the file can do,
 *     so the check in smoke.sh is the only proof that the wheel carries
 *     libyaml (the C library behind PyYAML's fast loader) inside it. The
 *     image has no libyaml of its own.
 *   - nothing in the Dockerfile builds a Python package from source again
 *     without someone deciding to.
 *
 * docs/runbooks/pyyaml-wheel.md keeps the history.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(REPO, path), 'utf8');
const VERSIONS_ENV = read('lab-image/versions.env');
const DOCKERFILE = read('lab-image/Dockerfile');
const SMOKE = read('lab-image/smoke.sh');

/** A file's lines that are not comments: what actually runs. */
const commands = (text) => text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

describe('PyYAML in the lab image, from PyPI', () => {
  it('is one hashed line of ANSIBLE_CORE_DEPS, with no block of its own', () => {
    const deps = VERSIONS_ENV.match(/^ANSIBLE_CORE_DEPS='([^']*)'$/m)?.[1] ?? '';
    const lines = deps.split('\n').filter((line) => /^pyyaml==/i.test(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^pyyaml==\d+(\.\d+)+ --hash=sha256:[0-9a-f]{64}$/);
    expect(VERSIONS_ENV).not.toMatch(/^PYYAML_/m);
  });

  it('is downloaded with every other wheel in hash-checking mode, and nothing is built from source', () => {
    const run = commands(DOCKERFILE);
    expect(run).toMatch(
      /pip download --disable-pip-version-check --no-cache-dir \\\n\s+--only-binary=:all: --require-hashes --dest \/out\/wheels -r \/out\/wheels\/requirements\.txt/
    );
    expect(run).not.toMatch(/--no-binary|pip wheel|\bgcc\b|libc6-dev|libyaml/);
    expect(run).not.toMatch(/^FROM\s+scratch\b/im);
  });

  it('is installed in the runner offline, from those files only', () => {
    expect(commands(DOCKERFILE)).toMatch(
      /--network=none \\\n\s+python3 -m venv \/opt\/ansible \\\n\s+&& \/opt\/ansible\/bin\/pip install [^\n]*\\\n\s+--no-index --find-links \/tmp\/wheels --require-hashes -r \/tmp\/wheels\/requirements\.txt/
    );
  });

  it('is checked in the built image for the pinned version and the libyaml C loader', () => {
    const run = commands(SMOKE);
    // The version comes from the same line the image was built from.
    expect(run).toContain(`pyyaml_pin="$(printf '%s\\n' "\${ANSIBLE_CORE_DEPS}" | sed -n 's/^pyyaml==\\([^ ]*\\) .*$/\\1/p')"`);
    expect(run).toContain("/opt/ansible/bin/python -c 'import yaml; print(yaml.__version__, yaml.__with_libyaml__, yaml.CSafeLoader.__name__)'");
    expect(run).toContain('[ "$out" = "${pyyaml_pin} True CSafeLoader" ]');
    // Every other outcome is a failure: no pin to compare with, another
    // version or no C loader, or an import that fails.
    expect(run.match(/^\s*bad "(versions\.env: ANSIBLE_CORE_DEPS has no pyyaml line|PyYAML in \/opt\/ansible is not|PyYAML failed to import)/gm)).toHaveLength(3);
  });
});
