/**
 * lab-host/bootstrap.sh installs ansible-core hash-locked, from the pins the
 * lab image is built from (LAB-13, #959).
 *
 * Until this test, bootstrap.sh carried its own ANSIBLE_CORE_VERSION and
 * ANSIBLE_CORE_SHA256 and installed with `uv tool install
 * "ansible-core==<version>"`, which takes no hashes: the SHA256 it printed
 * verified nothing, the wheels ansible-core depends on arrived unpinned, and
 * nothing held the copy to lab-image/versions.env. Now the script reads the
 * three ANSIBLE_CORE_* lines from versions.env in the commit it checks out,
 * writes the requirements file the way lab-image/Dockerfile's fetch stage
 * does, and installs it with `uv pip install --require-hashes`.
 *
 * Two layers: the script's shape, read from the file, which holds on every
 * platform; and the block that writes the requirements file, cut out of the
 * script and run with bash against this checkout's versions.env, where a
 * POSIX bash is available. The install itself (uv, PyPI, a wrong hash
 * refused, an unpinned dependency refused) was run in an Ubuntu 26.04
 * container when this landed; that needs the network and root, so it is not
 * repeated here.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(REPO, path), 'utf8');
const SCRIPT = read('lab-host/bootstrap.sh');
const DOCKERFILE = read('lab-image/Dockerfile');
const VERSIONS_ENV = read('lab-image/versions.env');
const VAULT_HELPER = read('lab-host/ansible/roles/vault_tools/files/hcw-vault-set');

/** From the line that starts `start` to the first line after it that is exactly `end`. */
function cut(text, start, end) {
  const from = text.indexOf(start);
  if (from < 0) throw new Error(`bootstrap.sh no longer contains ${JSON.stringify(start)}`);
  const lines = text.slice(from).split('\n');
  const last = lines.findIndex((line, i) => i > 0 && line === end);
  if (last < 0) throw new Error(`no ${JSON.stringify(end)} after ${JSON.stringify(start)}`);
  return lines.slice(0, last + 1).join('\n');
}

/** Where a line first occurs in the script; -1 when it does not. */
const at = (needle) => SCRIPT.indexOf(needle);

/** The requirements lines versions.env gives, as the Dockerfile's fetch stage writes them. */
function expectedRequirements(envText) {
  const one = (key) => envText.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1];
  const deps = envText.match(/^ANSIBLE_CORE_DEPS='([^']*)'$/m)?.[1] ?? '';
  return [
    `ansible-core==${one('ANSIBLE_CORE_VERSION')} --hash=sha256:${one('ANSIBLE_CORE_SHA256')}`,
    ...deps.split('\n').filter((line) => line.trim() !== ''),
  ];
}

const WRITE_BLOCK = cut(SCRIPT, 'hcw_ansible_requirements="$(mktemp)"', 'fi');

describe('bootstrap.sh and lab-image/versions.env', () => {
  it('carries no ansible-core pin of its own', () => {
    for (const key of ['ANSIBLE_CORE_VERSION', 'ANSIBLE_CORE_SHA256', 'ANSIBLE_CORE_DEPS']) {
      expect(SCRIPT, key).not.toMatch(new RegExp(`^\\s*${key}=`, 'm'));
    }
    // Where the pins live, said where the old ones were.
    expect(SCRIPT).toMatch(/^# ansible-core is not pinned here\./m);
  });

  it('reads the three lines from versions.env in the checkout it is about to run, in a subshell', () => {
    expect(WRITE_BLOCK).toContain('. "${HCW_SRC_DIR}/lab-image/versions.env"');
    expect(WRITE_BLOCK).toMatch(/^\($/m);
    expect(WRITE_BLOCK).toMatch(/^\) >"\$\{hcw_ansible_requirements\}"$/m);
  });

  it('writes the requirements with the same two printf lines as the Dockerfile\'s fetch stage', () => {
    const dockerfileLines = DOCKERFILE.split('\n')
      .map((line) => line.trim().replace(/;\s*\\$/, ''))
      .filter((line) => line.startsWith('printf ') && line.includes('ANSIBLE_CORE_'));
    expect(dockerfileLines).toHaveLength(2);
    const scriptLines = WRITE_BLOCK.split('\n').map((line) => line.trim());
    for (const line of dockerfileLines) expect(scriptLines).toContain(line);
  });

  it('installs with --require-hashes and --only-binary :all: into its own venv, and never with uv tool install', () => {
    expect(SCRIPT).toMatch(
      /^ {2}"\$\{UV_BIN\}" pip install --python "\$\{hcw_ansible_python\}" --require-hashes --only-binary :all: -r "\$\{hcw_ansible_requirements\}"$/m
    );
    expect(SCRIPT).toMatch(/^ {2}"\$\{UV_BIN\}" venv --clear --managed-python --python "\$\{PYTHON_VERSION\}" "\$\{HCW_ANSIBLE_VENV\}"$/m);
    expect(SCRIPT).toContain('https://docs.astral.sh/uv/reference/cli/#uv-pip-install--require-hashes');
    // The comment says why `uv tool install` went; no command runs it.
    const commands = SCRIPT.split('\n').filter((line) => !/^\s*#/.test(line));
    expect(commands.filter((line) => line.includes('tool install'))).toEqual([]);
  });

  it('holds the environment to the file by count, as the fetch stage holds the wheels', () => {
    expect(SCRIPT).toContain('hcw_ansible_lines="$(wc -l <"${hcw_ansible_requirements}")"');
    expect(SCRIPT).toContain('if [ "${hcw_ansible_installed}" -ne "${hcw_ansible_lines}" ]; then');
    expect(DOCKERFILE).toContain('test "$(find /out/wheels -name \'*.whl\' | wc -l)" -eq "$(wc -l < /out/wheels/requirements.txt)"');
  });

  it('installs after the checkout and the handover, and before the first ansible command', () => {
    const checkout = at('git -C "${HCW_SRC_DIR}" checkout --quiet --detach "${hcw_repo_sha}"');
    const handover = at('exec bash "${hcw_checked_out_script}" "$@"');
    const install = at('pip install --python "${hcw_ansible_python}" --require-hashes');
    const galaxy = at('"${UV_TOOL_BIN_DIR}/ansible-galaxy" collection install');
    expect(checkout).toBeGreaterThan(-1);
    expect(handover).toBeGreaterThan(checkout);
    expect(install).toBeGreaterThan(handover);
    expect(galaxy).toBeGreaterThan(install);
  });

  it('rebuilds on a changed requirements file, a changed release or a changed Python, and keeps the --version guard', () => {
    expect(SCRIPT).toContain('if ! cmp -s "${hcw_ansible_requirements}" "${hcw_ansible_record}" \\');
    expect(SCRIPT).toContain('grep -qF "[core ${hcw_ansible_core_version}]"');
    expect(SCRIPT).toContain('grep -qF "python version = ${PYTHON_VERSION} ("');
  });

  it('removes the old uv tool before it links the four commands, so the uninstall cannot take the new links', () => {
    const uninstall = at('"${UV_BIN}" tool uninstall ansible-core');
    const links = at('for hcw_ansible_command in ansible ansible-playbook ansible-galaxy ansible-vault; do');
    expect(uninstall).toBeGreaterThan(-1);
    expect(links).toBeGreaterThan(uninstall);
    expect(SCRIPT).toContain('if [ -e "${UV_TOOL_DIR}/ansible-core" ]; then');
    expect(SCRIPT).toContain('ln -sfn "${HCW_ANSIBLE_VENV}/bin/${hcw_ansible_command}" "${UV_TOOL_BIN_DIR}/${hcw_ansible_command}"');
  });

  it('keeps the environment where hcw-vault-set runs its Python from', () => {
    const venv = SCRIPT.match(/^HCW_ANSIBLE_VENV=(\S+)$/m)?.[1];
    expect(venv).toBe('/opt/uv/ansible-core');
    expect(VAULT_HELPER).toMatch(new RegExp(`^py=${venv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/bin/python$`, 'm'));
  });

  it('is fed by a versions.env whose lines are each one pinned, hashed wheel', () => {
    const lines = expectedRequirements(VERSIONS_ENV);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line).toMatch(/^[a-z0-9][a-z0-9._-]*==[^\s=]+ --hash=sha256:[0-9a-f]{64}$/);
  });
});

const run = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', ...options });
// On Windows only a Git Bash (MSYSTEM set) is the bash this script is written
// for; System32's bash is WSL, which cannot see these paths.
const shellReady = (process.platform !== 'win32' || Boolean(process.env.MSYSTEM)) && run('bash', ['--version']).status === 0;

describe.skipIf(!shellReady)('the block that writes the requirements file, run', { timeout: 30_000 }, () => {
  let root;
  const slash = (path) => path.replace(/\\/g, '/');
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'hcw-bootstrap-ansible-core-'));
  });
  afterAll(() => root && rmSync(root, { recursive: true, force: true }));

  function runBlock(srcDir) {
    const script = [
      'set -euo pipefail',
      'log() { printf "[bootstrap] %s\\n" "$*"; }',
      `HCW_SRC_DIR='${slash(srcDir)}'`,
      'hcw_repo_sha=0123456789abcdef0123456789abcdef01234567',
      WRITE_BLOCK,
      'printf "version=%s\\n" "${hcw_ansible_core_version}"',
      'cat "${hcw_ansible_requirements}"',
    ].join('\n');
    const file = join(root, `${Math.random().toString(36).slice(2)}.sh`);
    writeFileSync(file, `${script}\n`);
    return run('bash', [slash(file)]);
  }

  /** A checkout holding only lab-image/versions.env, with `text` in it. */
  function checkoutWith(name, text) {
    const dir = join(root, name);
    mkdirSync(join(dir, 'lab-image'), { recursive: true });
    writeFileSync(join(dir, 'lab-image', 'versions.env'), text);
    return dir;
  }

  it('writes exactly the lines the Dockerfile builds from, ansible-core first', () => {
    const result = runBlock(REPO);
    expect(result.status, result.stderr).toBe(0);
    const [versionLine, ...requirements] = result.stdout.trimEnd().split('\n');
    expect(requirements).toEqual(expectedRequirements(VERSIONS_ENV));
    expect(versionLine).toBe(`version=${VERSIONS_ENV.match(/^ANSIBLE_CORE_VERSION=(.*)$/m)[1]}`);
  });

  it('refuses to run when versions.env names no SHA256 for ansible-core', () => {
    const dir = checkoutWith('no-sha', VERSIONS_ENV.replace(/^ANSIBLE_CORE_SHA256=.*$/m, 'ANSIBLE_CORE_SHA256='));
    const result = runBlock(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('refusing to run: lab-image/versions.env at 0123456789abcdef0123456789abcdef01234567 names no ansible-core version with a SHA256');
  });

  it('stops when versions.env has no ANSIBLE_CORE_DEPS, rather than installing without them', () => {
    const dir = checkoutWith('no-deps', VERSIONS_ENV.replace(/^ANSIBLE_CORE_DEPS='[^']*'$/m, ''));
    const result = runBlock(dir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/ANSIBLE_CORE_DEPS: unbound variable/);
  });
});
