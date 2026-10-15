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
 * Three layers: the script's shape, read from the file, which holds on every
 * platform; the block that writes the requirements file, cut out of the
 * script and run with bash against this checkout's versions.env, where a
 * POSIX bash is available; and the blocks that build a generation and switch
 * HCW_ANSIBLE_VENV to it, retire the old uv tool after the play, and prepare
 * a handover to a bootstrap.sh from before this change, cut out and run with
 * a stand-in for uv, where bash can also make real symlinks. The install
 * itself (uv, PyPI, a wrong hash refused, an unpinned dependency refused) was
 * run in an Ubuntu 26.04 container when this landed; that needs the network
 * and root, so it is not repeated here.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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

/** A string as a regular expression that matches only itself. */
const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

  it('installs with --require-hashes and --only-binary :all: into a generation of its own, and never with uv tool install', () => {
    expect(SCRIPT).toMatch(
      /^ {2}"\$\{UV_BIN\}" pip install --python "\$\{hcw_ansible_python\}" --require-hashes --only-binary :all: -r "\$\{hcw_ansible_requirements\}"$/m
    );
    expect(SCRIPT).toMatch(/^ {2}"\$\{UV_BIN\}" venv --managed-python --python "\$\{PYTHON_VERSION\}" "\$\{hcw_ansible_generation\}"$/m);
    expect(SCRIPT).toContain('hcw_ansible_python="${hcw_ansible_generation}/bin/python"');
    expect(SCRIPT).toContain('https://docs.astral.sh/uv/reference/cli/#uv-pip-install--require-hashes');
    // The comment says why `uv tool install` went; no command runs it, and
    // nothing clears an environment in place.
    const commands = SCRIPT.split('\n').filter((line) => !/^\s*#/.test(line));
    expect(commands.filter((line) => line.includes('tool install'))).toEqual([]);
    expect(commands.filter((line) => line.includes('--clear'))).toEqual([]);
  });

  it('switches HCW_ANSIBLE_VENV by renaming a new link over it, only after the new generation passes every check', () => {
    const record = at('install -m 0644 -o root -g root "${hcw_ansible_requirements}" "${hcw_ansible_record}"');
    const checks = [
      '"${UV_BIN}" pip check --python "${hcw_ansible_python}"',
      'if [ "${hcw_ansible_installed}" -ne "${hcw_ansible_lines}" ]; then',
      'if ! hcw_ansible_answers "${hcw_ansible_generation}"; then',
    ];
    for (const check of checks) {
      expect(at(check), check).toBeGreaterThan(-1);
      expect(record, check).toBeGreaterThan(at(check));
    }
    expect(SCRIPT).toContain('ln -sfn "${hcw_ansible_generation}" "${HCW_ANSIBLE_VENV}.next"');
    expect(at('mv -T "${HCW_ANSIBLE_VENV}.next" "${HCW_ANSIBLE_VENV}"')).toBeGreaterThan(record);
    expect(SCRIPT).toMatch(/^HCW_ANSIBLE_GENERATIONS=\/opt\/uv\/ansible-core-generations$/m);
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

  it('builds a new generation on a changed requirements file, a changed release or a changed Python, and keeps the --version guard', () => {
    expect(SCRIPT).toContain(
      'hcw_ansible_generation="${HCW_ANSIBLE_GENERATIONS}/${hcw_ansible_core_version}-py${PYTHON_VERSION}-$(sha256sum "${hcw_ansible_requirements}" | cut -c 1-12)"'
    );
    expect(SCRIPT).toContain('if ! cmp -s "${hcw_ansible_requirements}" "${hcw_ansible_record}" || ! hcw_ansible_answers "${hcw_ansible_generation}"; then');
    expect(SCRIPT).toContain('grep -qF "[core ${hcw_ansible_core_version}]"');
    expect(SCRIPT).toContain('grep -qF "python version = ${PYTHON_VERSION} ("');
  });

  it('links the four commands through HCW_ANSIBLE_VENV before the play, and retires the old uv tool only after it, once the installed helper no longer runs its Python', () => {
    const definition = at('hcw_link_ansible_commands() {');
    const firstLink = SCRIPT.indexOf('\nhcw_link_ansible_commands\n', definition);
    const play = at('"${UV_TOOL_BIN_DIR}/ansible-playbook" -i inventory/localhost.yml site.yml');
    const uninstall = at('"${UV_BIN}" tool uninstall ansible-core');
    const relink = SCRIPT.indexOf('\n  hcw_link_ansible_commands\n', uninstall);
    expect(definition).toBeGreaterThan(-1);
    expect(firstLink).toBeGreaterThan(definition);
    expect(play).toBeGreaterThan(firstLink);
    expect(uninstall).toBeGreaterThan(play);
    expect(relink).toBeGreaterThan(uninstall);
    expect(SCRIPT).toContain('if [ -e "${UV_TOOL_DIR}/ansible-core" ] && ! grep -qF "${UV_TOOL_DIR}/ansible-core/" "${HCW_VAULT_HELPER}" 2>/dev/null; then');
    expect(SCRIPT).toContain('ln -sfn "${HCW_ANSIBLE_VENV}/bin/${hcw_ansible_command}" "${UV_TOOL_BIN_DIR}/${hcw_ansible_command}"');
    // The helper this revision ships names no uv tool path, so the run that installs it is the run that retires the tool.
    const toolDir = SCRIPT.match(/^export UV_TOOL_DIR=(\S+)$/m)?.[1];
    expect(toolDir).toBe('/opt/uv/tools');
    expect(VAULT_HELPER).not.toContain(`${toolDir}/ansible-core/`);
  });

  it('keeps the environment where hcw-vault-set runs its Python from, and looks for the helper where the role installs it', () => {
    const venv = SCRIPT.match(/^HCW_ANSIBLE_VENV=(\S+)$/m)?.[1];
    expect(venv).toBe('/opt/uv/ansible-core');
    expect(VAULT_HELPER).toMatch(new RegExp(`^py=${esc(venv)}/bin/python$`, 'm'));
    const helper = SCRIPT.match(/^HCW_VAULT_HELPER=(\S+)$/m)?.[1];
    expect(helper).toBe('/usr/local/sbin/hcw-vault-set');
    expect(read('lab-host/ansible/roles/vault_tools/tasks/main.yml')).toMatch(new RegExp(`^ +dest: ${esc(helper)}$`, 'm'));
  });

  it('removes the ansible-playbook link, when it does, before it hands over, and only for a bootstrap.sh without HCW_ANSIBLE_VENV', () => {
    const removal = at('    rm -f "${UV_TOOL_BIN_DIR}/ansible-playbook"');
    expect(removal).toBeGreaterThan(at('if [ -z "${HCW_BOOTSTRAP_HANDED_OVER:-}" ] && [ -f "${hcw_checked_out_script}" ] \\'));
    expect(at('exec bash "${hcw_checked_out_script}" "$@"')).toBeGreaterThan(removal);
    expect(SCRIPT).toContain('  if ! grep -q \'^HCW_ANSIBLE_VENV=\' "${hcw_checked_out_script}" \\');
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

  it('refuses an ANSIBLE_CORE_VERSION that is not a version, because it names a directory', () => {
    for (const version of ['../../../etc', '2.21.4/x', '']) {
      const dir = checkoutWith(`bad-version-${version.length}`, VERSIONS_ENV.replace(/^ANSIBLE_CORE_VERSION=.*$/m, `ANSIBLE_CORE_VERSION=${version}`));
      const result = runBlock(dir);
      expect(result.status, version).toBe(1);
      expect(result.stderr, version).toContain('names no ansible-core version with a SHA256');
    }
  });
});

// The generation switch, the uv tool's retirement and the handover's link
// removal, each cut out of the script and run against a scratch /opt/uv with
// a stand-in for uv. Git Bash makes real symlinks only when MSYS asks for
// them, and only where Windows allows it, so this runs where it can.
const linkEnv = process.platform === 'win32' ? { MSYS: 'winsymlinks:nativestrict' } : {};
const bash = (args, env = {}) => run('bash', args, { env: { ...process.env, ...linkEnv, ...env } });
const linksReady =
  shellReady && bash(['-c', 'd="$(mktemp -d)"; ln -s "$d" "$d/l" && [ -L "$d/l" ]; s=$?; rm -rf "$d"; exit "$s"']).status === 0;

const PYTHON_VERSION = SCRIPT.match(/^PYTHON_VERSION=(\S+)$/m)?.[1];
const SWITCH_BLOCK = cut(SCRIPT, 'hcw_ansible_requirements="$(mktemp)"', '"${UV_TOOL_BIN_DIR}/ansible-playbook" --version | sed -n \'1p;/python version/p\'');
const LINK_FUNCTION = cut(SCRIPT, 'hcw_link_ansible_commands() {', '}');
const RETIRE_BLOCK = cut(SCRIPT, 'if [ -e "${UV_TOOL_DIR}/ansible-core" ] && ! grep -qF', 'fi');
const HANDOVER_BLOCK = cut(SCRIPT, '  if ! grep -q \'^HCW_ANSIBLE_VENV=\' "${hcw_checked_out_script}" \\', '  fi');
const COMMANDS = ['ansible', 'ansible-playbook', 'ansible-galaxy', 'ansible-vault'];

/** uv, as far as these blocks use it: every call logged, and a venv whose commands answer --version as ansible-core's do. */
const STAND_IN_UV = [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  'printf "%s\\n" "$*" >>"$UV_STUB_LOG"',
  'venv_of() { dirname "$(dirname "$1")"; }',
  'case "$1 $2" in',
  '  "venv --managed-python")',
  '    [ ! -e "$5" ] || { echo "uv venv: $5 exists" >&2; exit 2; }',
  '    mkdir -p "$5/bin"',
  '    ;;',
  '  "pip install")',
  '    [ "${UV_STUB_FAIL:-}" != install ] || { echo "stand-in uv: a hash did not match" >&2; exit 1; }',
  '    dir="$(venv_of "$4")"',
  '    requirements="${!#}"',
  '    version="$(head -n 1 "$requirements" | cut -d " " -f 1 | cut -d = -f 3)"',
  '    cut -d " " -f 1 "$requirements" >"$dir/stand-in-installed"',
  '    for c in ansible ansible-playbook ansible-galaxy ansible-vault; do',
  '      printf "#!/usr/bin/env bash\\necho \'%s [core %s]\'\\necho \'  python version = %s (main) (%s/bin/python)\'\\n" "$c" "$version" "${UV_STUB_PYTHON:-$PYTHON_VERSION}" "$dir" >"$dir/bin/$c"',
  '      chmod +x "$dir/bin/$c"',
  '    done',
  '    ;;',
  '  "pip check") [ "${UV_STUB_FAIL:-}" != check ] || { echo "stand-in uv: a requirement is not met" >&2; exit 1; } ;;',
  '  "pip freeze")',
  '    cat "$(venv_of "$4")/stand-in-installed"',
  '    [ "${UV_STUB_FAIL:-}" != count ] || echo "unlisted==1.0"',
  '    ;;',
  '  "tool uninstall")',
  '    rm -rf "$UV_TOOL_DIR/ansible-core"',
  '    for c in ansible ansible-playbook ansible-galaxy ansible-vault ansible-doc; do rm -f "$UV_TOOL_BIN_DIR/$c"; done',
  '    ;;',
  '  *) echo "stand-in uv: unexpected $*" >&2; exit 2 ;;',
  'esac',
];

describe.skipIf(!linksReady)('the generation switch and the uv tool\'s retirement, run with a stand-in uv', { timeout: 60_000 }, () => {
  let dir;
  let root;
  const slash = (path) => path.replace(/\\/g, '/');
  const scriptAt = (name) => slash(join(dir, name));

  /** The variables the blocks read, pointed at a scratch tree under $ROOT. */
  const preamble = () => [
    'set -euo pipefail',
    'log() { printf "[bootstrap] %s\\n" "$*"; }',
    // Not root here: the ownership flags are dropped, and nothing else.
    'install() { local a=(); while [ "$#" -gt 0 ]; do case "$1" in -o | -g) shift 2 ;; *) a+=("$1"); shift ;; esac; done; command install "${a[@]}"; }',
    'HCW_SRC_DIR="$ROOT/src"',
    'hcw_repo_sha=0123456789abcdef0123456789abcdef01234567',
    `export PYTHON_VERSION=${PYTHON_VERSION}`,
    `UV_BIN='${scriptAt('uv')}'`,
    'HCW_ANSIBLE_VENV="$ROOT/opt/uv/ansible-core"',
    'HCW_ANSIBLE_GENERATIONS="$ROOT/opt/uv/ansible-core-generations"',
    'HCW_VAULT_HELPER="$ROOT/sbin/hcw-vault-set"',
    'export UV_TOOL_DIR="$ROOT/opt/uv/tools" UV_TOOL_BIN_DIR="$ROOT/bin" UV_STUB_LOG="$ROOT/uv.log"',
    'mkdir -p "$UV_TOOL_BIN_DIR" "$ROOT/opt/uv" "$ROOT/sbin" "$HCW_SRC_DIR/lab-image" "$ROOT/checked-out"',
  ];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'hcw-bootstrap-generations-'));
    writeFileSync(join(dir, 'uv'), `${STAND_IN_UV.join('\n')}\n`, { mode: 0o755 });
    const write = (name, lines) => writeFileSync(join(dir, name), `${[...preamble(), ...lines].join('\n')}\n`);
    write('switch.sh', ['printf "%s" "$HCW_TEST_VERSIONS_ENV" >"$HCW_SRC_DIR/lab-image/versions.env"', SWITCH_BLOCK]);
    write('retire.sh', [LINK_FUNCTION, RETIRE_BLOCK]);
    write('handover.sh', ['hcw_checked_out_script="$ROOT/checked-out/bootstrap.sh"', 'printf "%s" "$HCW_TEST_SCRIPT" >"${hcw_checked_out_script}"', HANDOVER_BLOCK]);
  });
  afterAll(() => dir && rmSync(dir, { recursive: true, force: true }));
  // The scratch tree is made by bash, so every path the blocks compare is in bash's own spelling.
  beforeEach(() => {
    root = bash(['-c', 'mktemp -d']).stdout.trim();
  });
  afterEach(() => root && bash(['-c', 'rm -rf "$1"', '_', root]));

  const sh = (command, env = {}) => bash(['-c', command], { ROOT: root, ...env }).stdout.trim();
  const step = (envText, env = {}) => bash([scriptAt('switch.sh')], { ROOT: root, HCW_TEST_VERSIONS_ENV: envText, ...env });
  const retire = () => bash([scriptAt('retire.sh')], { ROOT: root });
  const handOver = (script) => bash([scriptAt('handover.sh')], { ROOT: root, HCW_TEST_SCRIPT: script });
  const inUse = () => sh('readlink "$ROOT/opt/uv/ansible-core"');
  const generations = () => sh('ls "$ROOT/opt/uv/ansible-core-generations"').split('\n').filter(Boolean).sort();
  const calls = (pattern) => Number(sh(`grep -c '${pattern}' "$ROOT/uv.log" 2>/dev/null || true`) || 0);
  const answer = () => sh('"$ROOT/bin/ansible-playbook" --version');
  const name = (path) => path.split('/').pop();

  const pinned = VERSIONS_ENV.match(/^ANSIBLE_CORE_VERSION=(.*)$/m)[1];
  const [major, minor] = pinned.split('.');
  const later = (patch) => `${major}.${minor}.${patch}`;
  const withVersion = (version) => VERSIONS_ENV.replace(/^ANSIBLE_CORE_VERSION=.*$/m, `ANSIBLE_CORE_VERSION=${version}`);

  it('builds the first generation, links the four commands through HCW_ANSIBLE_VENV, and installs nothing on a re-run', () => {
    const first = step(VERSIONS_ENV);
    expect(first.status, first.stderr).toBe(0);
    const generation = inUse();
    expect(generation).toMatch(new RegExp(`^${esc(root)}/opt/uv/ansible-core-generations/${esc(pinned)}-py${esc(PYTHON_VERSION)}-[0-9a-f]{12}$`));
    expect(first.stdout).toContain(`switched ${root}/opt/uv/ansible-core to ${generation}\n`);
    for (const command of COMMANDS) expect(sh(`readlink "$ROOT/bin/${command}"`)).toBe(`${root}/opt/uv/ansible-core/bin/${command}`);
    expect(first.stdout).toContain(`ansible-playbook [core ${pinned}]`);

    const again = step(VERSIONS_ENV);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).not.toContain('installing ansible-core');
    expect(again.stdout).not.toContain('switched');
    expect(inUse()).toBe(generation);
    expect(calls('^venv ')).toBe(1);
  });

  for (const [failure, env] of [
    ['a failed download or hash', { UV_STUB_FAIL: 'install' }],
    ['a failed uv pip check', { UV_STUB_FAIL: 'check' }],
    ['a package the file does not list', { UV_STUB_FAIL: 'count' }],
    ['an ansible-playbook that reports another Python', { UV_STUB_PYTHON: '3.0.0' }],
  ]) {
    it(`leaves HCW_ANSIBLE_VENV and every command on the generation that worked after ${failure}, and the next run rebuilds the new one`, () => {
      expect(step(VERSIONS_ENV).status).toBe(0);
      const working = inUse();
      const failed = step(withVersion(later(99)), env);
      expect(failed.status).not.toBe(0);
      expect(inUse()).toBe(working);
      expect(answer()).toContain(`[core ${pinned}]`);
      if (env.UV_STUB_FAIL !== 'install' && env.UV_STUB_FAIL !== 'check') expect(failed.stderr).toContain(`still points to ${working}`);

      const retried = step(withVersion(later(99)));
      expect(retried.status, retried.stderr).toBe(0);
      expect(inUse()).not.toBe(working);
      expect(answer()).toContain(`[core ${later(99)}]`);
    });
  }

  it('keeps the generation it switched away from, removes older ones, and switches back to a kept one without installing', () => {
    const made = [];
    for (const version of [pinned, later(97), later(98)]) {
      const result = step(withVersion(version));
      expect(result.status, result.stderr).toBe(0);
      made.push(inUse());
    }
    expect(generations()).toEqual([made[1], made[2]].map(name).sort());
    expect(calls('^venv ')).toBe(3);

    const back = step(withVersion(later(97)));
    expect(back.status, back.stderr).toBe(0);
    expect(back.stdout).not.toContain('installing ansible-core');
    expect(back.stdout).toContain(`keeping ${made[2]} until the next switch`);
    expect(inUse()).toBe(made[1]);
    expect(answer()).toContain(`[core ${later(97)}]`);
    expect(generations()).toEqual([made[1], made[2]].map(name).sort());
    expect(calls('^venv ')).toBe(3);
  });

  it('replaces a venv built in place at HCW_ANSIBLE_VENV with the link', () => {
    sh('mkdir -p "$ROOT/opt/uv/ansible-core/bin" && touch "$ROOT/opt/uv/ansible-core/hcw-requirements.txt"');
    const result = step(VERSIONS_ENV);
    expect(result.status, result.stderr).toBe(0);
    expect(inUse()).toContain('/opt/uv/ansible-core-generations/');
    expect(answer()).toContain(`[core ${pinned}]`);
  });

  /** A host an earlier bootstrap.sh set up, after this one has linked the four commands through HCW_ANSIBLE_VENV. */
  function legacyHost() {
    sh(
      [
        'mkdir -p "$ROOT/bin" "$ROOT/sbin" "$ROOT/opt/uv/tools/ansible-core/bin" "$ROOT/opt/uv/ansible-core/bin"',
        'for c in ansible ansible-playbook ansible-galaxy ansible-vault ansible-doc; do touch "$ROOT/opt/uv/tools/ansible-core/bin/$c" "$ROOT/opt/uv/ansible-core/bin/$c"; done',
        'for c in ansible ansible-playbook ansible-galaxy ansible-vault; do ln -sfn "$ROOT/opt/uv/ansible-core/bin/$c" "$ROOT/bin/$c"; done',
        'ln -sfn "$ROOT/opt/uv/tools/ansible-core/bin/ansible-doc" "$ROOT/bin/ansible-doc"',
      ].join(' && ')
    );
  }
  const installHelper = (text) => sh('printf "%s" "$HELPER" >"$ROOT/sbin/hcw-vault-set"', { HELPER: text });

  it('keeps the uv tool while the installed hcw-vault-set still runs its Python, as after a check run or a run that left out vault_tools', () => {
    legacyHost();
    installHelper(`py=${root}/opt/uv/tools/ansible-core/bin/python\n`);
    const result = retire();
    expect(result.status, result.stderr).toBe(0);
    expect(calls('^tool uninstall')).toBe(0);
    expect(sh('[ -d "$ROOT/opt/uv/tools/ansible-core" ] && echo kept')).toBe('kept');
    expect(sh('readlink "$ROOT/bin/ansible-doc"')).toBe(`${root}/opt/uv/tools/ansible-core/bin/ansible-doc`);
  });

  it('retires the uv tool once the installed helper is the one this revision ships, and links the four commands again', () => {
    legacyHost();
    installHelper(VAULT_HELPER);
    const result = retire();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('no longer runs its Python');
    expect(calls('^tool uninstall ansible-core$')).toBe(1);
    expect(sh('[ -e "$ROOT/opt/uv/tools/ansible-core" ] || echo gone')).toBe('gone');
    expect(sh('[ -e "$ROOT/bin/ansible-doc" ] || echo gone')).toBe('gone');
    for (const command of COMMANDS) expect(sh(`readlink "$ROOT/bin/${command}"`)).toBe(`${root}/opt/uv/ansible-core/bin/${command}`);
  });

  it('retires it when no helper is installed, and does nothing on a host without the uv tool', () => {
    legacyHost();
    expect(retire().status).toBe(0);
    expect(calls('^tool uninstall')).toBe(1);
    expect(retire().status).toBe(0);
    expect(calls('^tool uninstall')).toBe(1);
  });

  it('removes the ansible-playbook link before handing over to a bootstrap.sh from before HCW_ANSIBLE_VENV, so that script reinstalls its uv tool', () => {
    const linkTo = (target) =>
      sh(`mkdir -p "$ROOT/bin" "$(dirname "${target}")" && touch "${target}" && ln -sfn "${target}" "$ROOT/bin/ansible-playbook"`);
    const link = () => sh('readlink "$ROOT/bin/ansible-playbook" || true');
    const before = 'ANSIBLE_CORE_VERSION=2.21.4\n';

    linkTo(`${root}/opt/uv/ansible-core/bin/ansible-playbook`);
    const older = handOver(before);
    expect(older.status, older.stderr).toBe(0);
    expect(older.stdout).toContain("bootstrap.sh installs ansible-core as a uv tool; removing");
    expect(link()).toBe('');

    linkTo(`${root}/opt/uv/ansible-core/bin/ansible-playbook`);
    expect(handOver(`HCW_ANSIBLE_VENV=/opt/uv/ansible-core\n${before}`).status).toBe(0);
    expect(link()).toBe(`${root}/opt/uv/ansible-core/bin/ansible-playbook`);

    // Still the uv tool's link: the older script's own check decides.
    linkTo(`${root}/opt/uv/tools/ansible-core/bin/ansible-playbook`);
    expect(handOver(before).status).toBe(0);
    expect(link()).toBe(`${root}/opt/uv/tools/ansible-core/bin/ansible-playbook`);
  });
});
