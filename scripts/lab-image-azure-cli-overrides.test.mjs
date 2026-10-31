/**
 * The Python packages the lab image replaces inside the Azure CLI's own
 * Python (`AZURE_CLI_PYTHON_OVERRIDES` in lab-image/versions.env, #1426).
 *
 * The Dockerfile downloads and installs these lines with pip in hash-checking
 * mode, and smoke.sh compares each installed version with its line, so a line
 * in any other shape fails late, in a Docker build, or not at all (a name
 * listed twice installs whichever pip reads last). This test holds every line
 * to `name==version --hash=sha256:<64 hex>`, with each name once and each
 * version a plain release, and holds the Dockerfile to the order that keeps a
 * newer Azure CLI from being downgraded: the check that the CLI ships an older
 * version comes before the install, in the same RUN that installs the CLI.
 * Building the image needs Docker and the network, so it is not done here.
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

const block = VERSIONS_ENV.match(/^AZURE_CLI_PYTHON_OVERRIDES='([^']*)'$/m);
const lines = (block?.[1] ?? '')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);
/** pip compares names this way (PEP 503), so `PyJWT` and `pyjwt` are one package. */
const normalise = (name) => name.replace(/[-_.]+/g, '-').toLowerCase();

describe('AZURE_CLI_PYTHON_OVERRIDES in versions.env', () => {
  it('is one block, if it is there at all', () => {
    expect(VERSIONS_ENV.match(/^AZURE_CLI_PYTHON_OVERRIDES=/gm)?.length ?? 0).toBeLessThanOrEqual(1);
    if (/^AZURE_CLI_PYTHON_OVERRIDES=/m.test(VERSIONS_ENV)) expect(block, 'a quoted block').not.toBeNull();
  });

  it('has each line as one pinned, hashed wheel', () => {
    for (const line of lines) {
      expect(line).toMatch(/^[a-z0-9][a-z0-9._-]*==[^\s=]+ --hash=sha256:[0-9a-f]{64}$/);
    }
  });

  it('names each package once', () => {
    const names = lines.map((line) => normalise(line.split('==')[0]));
    expect(new Set(names).size).toBe(names.length);
  });

  it('pins plain releases only, so the downgrade check compares like with like', () => {
    for (const line of lines) {
      const version = line.split('==')[1].split(' ')[0];
      expect(version, line).toMatch(/^\d+(\.\d+)*$/);
    }
  });
});

describe('the Dockerfile and smoke.sh around the block', () => {
  const run = DOCKERFILE.slice(DOCKERFILE.indexOf('FROM runner AS full'));
  const at = (text) => run.indexOf(text);

  it('checks for a downgrade before it installs, in the RUN that installs the CLI', () => {
    const apt = at('apt-get install -y --no-install-recommends "azure-cli=');
    const guard = at('already ships {name} {have}, not older than the {want} listed');
    const install = at('-Im pip install');
    const check = at('-Im pip check');
    const end = at('rm -rf /var/lib/apt/lists/* /tmp/versions.env');
    expect(apt).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(apt);
    expect(install).toBeGreaterThan(guard);
    expect(check).toBeGreaterThan(install);
    expect(end).toBeGreaterThan(check);
    // One RUN: no instruction starts between the CLI's install and the cleanup.
    expect(run.slice(apt, end)).not.toMatch(/^[A-Z]+ /m);
    expect(run).toContain('RUN --mount=type=bind,from=fetch,source=/out/az-wheels,target=/tmp/az-wheels');
  });

  it('keeps pip off the network for the install', () => {
    expect(run).toContain('--no-index --find-links /tmp/az-wheels');
    expect(run).toContain('--require-hashes -r /tmp/az-wheels/requirements.txt');
  });

  it('builds and smoke-tests with the block empty or removed', () => {
    expect(DOCKERFILE).toContain('"${AZURE_CLI_PYTHON_OVERRIDES-}"');
    expect(DOCKERFILE).toContain('if [ -s /out/az-wheels/requirements.txt ]; then');
    expect(DOCKERFILE).toContain('if [ -s /tmp/az-wheels/requirements.txt ]; then');
    expect(SMOKE).toContain('<<<"${AZURE_CLI_PYTHON_OVERRIDES-}"');
    expect(DOCKERFILE).not.toMatch(/\$\{AZURE_CLI_PYTHON_OVERRIDES\}/);
    expect(SMOKE).not.toMatch(/\$AZURE_CLI_PYTHON_OVERRIDES\b|\$\{AZURE_CLI_PYTHON_OVERRIDES\}/);
  });
});
