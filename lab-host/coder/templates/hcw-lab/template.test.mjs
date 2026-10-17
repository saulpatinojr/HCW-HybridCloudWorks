// The privilege boundary ADR 0032 draws around a Coder workspace, as a test
// over the two files that define it (issue #679, from the boundary comment on
// the issue):
//
//   1. no service holds the host's Docker socket: the proxy holds the
//      rootless sandbox daemon's (LAB-5, 2026-10-07), and the server reaches
//      Docker only through the proxy;
//   2. nothing is `privileged`;
//   3. the workspace mounts no host path, only its own named volume;
//   4. the workspace joins its own bridge network, not the Compose network;
//   5. the workspace runs as uid 65534;
//   6. workspace apps are served on their own names only, never by path on
//      the dashboard's origin (CODER_DISABLE_PATH_APPS, added 2026-09-28).
//
// And one thing that is not the boundary but is easy to lose in an edit: the
// editor's User settings (Workspace Trust off, the built-in AI chat off, the
// README first, telemetry off), with the two versions they were checked
// against.
//
// Then, in every template under lab-host/coder/templates (#954, owner
// decision 2026-10-16): the cloud CLIs' sign-ins on a tmpfs owned by the
// learner, never on the home volume, and a start refused while another of
// the learner's workspaces is starting or running, read from Coder's API with
// the owner's token on a start only, in the words the lab launcher looks for.
//
// Text-level on purpose: no YAML or HCL parser is a dependency of this
// directory, and the assertions are about what a reviewer would grep for.
// Run with `node --test` from lab-host/coder (npm test does the same).

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LIMIT_REFUSAL, isBlocking, limitBlocker } from '../../launcher/launcher.js';

const here = dirname(fileURLToPath(import.meta.url));
const mainTf = readFileSync(join(here, 'main.tf'), 'utf8');
const compose = readFileSync(join(here, '..', '..', 'docker-compose.yml'), 'utf8');

// A line of HCL or YAML with its trailing `#` comment removed. Comments in
// both files talk about the socket and about `privileged` by name, so the
// assertions look at code, not prose.
function stripComment(line) {
  const hash = line.indexOf('#');
  return hash === -1 ? line : line.slice(0, hash);
}

const codeLines = (text) => text.split('\n').map(stripComment);

// Split the Compose file's `services:` map into { name: [lines] } by
// indentation: a service starts at two spaces, its body is deeper.
function composeServices(text) {
  const lines = codeLines(text);
  const services = {};
  let inServices = false;
  let current = null;
  for (const line of lines) {
    if (/^\S/.test(line)) {
      inServices = line.startsWith('services:');
      current = null;
      continue;
    }
    if (!inServices) continue;
    const service = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (service) {
      current = service[1];
      services[current] = [];
      continue;
    }
    if (current && line.trim() !== '') services[current].push(line);
  }
  return services;
}

// The lines of the block that opens on lines[start], by brace matching.
function blockFrom(lines, start) {
  let depth = 0;
  const block = [];
  for (let j = start; j < lines.length; j += 1) {
    depth += (lines[j].match(/\{/g) || []).length;
    depth -= (lines[j].match(/\}/g) || []).length;
    block.push(lines[j]);
    if (depth === 0) break;
  }
  return block;
}

// Every block whose opening line passes `opens`, each as its lines.
const blocksWhere = (lines, opens) => lines.flatMap((line, i) => (opens(line) ? [blockFrom(lines, i)] : []));

// Top-level HCL blocks as { header, body } so a `volumes {` inside the
// container can be inspected without a parser.
function hclBlocks(text, header) {
  return blocksWhere(codeLines(text), (line) => line.startsWith(header)).map((block) => ({
    header: block[0],
    body: block.join('\n'),
  }));
}

// Nested blocks of one name inside a body, by brace matching.
function nestedBlocks(body, name) {
  const opens = new RegExp(`^\\s*${name}\\s*\\{`);
  return blocksWhere(body.split('\n'), (line) => opens.test(line)).map((block) => block.join('\n'));
}

// The body of `name = { ... }` inside a block's body, by brace matching.
function assignedObject(body, name) {
  const opens = new RegExp(`^\\s*${name}\\s*=\\s*\\{\\s*$`);
  const [block] = blocksWhere(body.split('\n'), (line) => opens.test(line));
  return block ? block.slice(1, -1).join('\n') : null;
}

const services = composeServices(compose);
const containers = hclBlocks(mainTf, 'resource "docker_container"');

test('the Compose file defines exactly the three services ADR 0032 names', () => {
  assert.deepEqual(Object.keys(services).sort(), ['coder', 'coder-docker-proxy', 'coder-postgres']);
});

test('no service holds the host\'s Docker socket; the proxy holds the sandbox daemon\'s, read-only (LAB-5)', () => {
  const hostSocket = (lines) => lines.filter((line) => /\/var\/run\/docker\.sock|\/run\/docker\.sock/.test(line));
  for (const [name, lines] of Object.entries(services)) {
    assert.equal(hostSocket(lines).length, 0, `${name} never mounts or names the host daemon's socket`);
  }
  const proxy = services['coder-docker-proxy'];
  const mounts = proxy.filter((line) => /^\s*-\s*\/.+:.+$/.test(line));
  assert.deepEqual(
    mounts.map((line) => line.trim()),
    ['- /run/hcw-coder-docker:/run/hcw-coder-docker:ro'],
    'the proxy\'s one mount is the coder_sandbox daemon\'s socket directory, read-only',
  );
  assert.ok(
    proxy.some((line) => /^\s*SOCKET_PATH:\s*\/run\/hcw-coder-docker\/docker\.sock\s*$/.test(line)),
    'and it connects to that daemon\'s socket',
  );
  assert.equal(proxy.filter((line) => /^\s*userns_mode:\s*host\s*$/.test(line)).length, 1, 'the proxy opts out of the host daemon\'s remap, which it needs to open another user\'s socket');
  for (const name of ['coder', 'coder-postgres']) {
    assert.equal(services[name].filter((line) => /userns_mode/.test(line)).length, 0, `${name} stays remapped`);
    assert.equal(services[name].filter((line) => /hcw-coder-docker/.test(line)).length, 0, `${name} never sees the sandbox daemon's socket`);
  }
  assert.equal(codeLines(mainTf).filter((line) => line.includes('docker.sock')).length, 0, 'the template never names a socket');
  assert.equal(codeLines(mainTf).filter((line) => /\/var\/run\b|\/run\/hcw-/.test(line)).length, 0, 'the template never reaches under /var/run or the socket directory');
});

test('the socket directory the proxy mounts is the one the coder_sandbox role creates (LAB-5)', () => {
  const sandboxVars = readFileSync(join(here, '..', '..', '..', 'ansible', 'roles', 'coder_sandbox', 'vars', 'main.yml'), 'utf8');
  assert.match(sandboxVars, /^coder_sandbox_socket_dir: \/run\/hcw-coder-docker$/m);
  assert.match(sandboxVars, /^coder_sandbox_socket: "\{\{ coder_sandbox_socket_dir \}\}\/docker\.sock"$/m);
});

test('the coder server keeps its non-root user and reaches the daemon only through the proxy', () => {
  assert.equal(services.coder.filter((line) => /^\s*group_add:/.test(line)).length, 0, 'no docker group membership');
  assert.ok(
    services.coder.some((line) => /^\s*DOCKER_HOST:\s*"tcp:\/\/coder-docker-proxy:2375"\s*$/.test(line)),
    'DOCKER_HOST names the proxy on the Compose network',
  );
  assert.ok(
    codeLines(mainTf).some((line) => /host\s*=\s*"tcp:\/\/coder-docker-proxy:2375"/.test(line)),
    'the template\'s Docker provider names the same proxy',
  );
  assert.equal(services.coder.filter((line) => /^\s*user:/.test(line)).length, 0, 'no user: override, so the image default (non-root coder) stands');
  assert.equal(services['coder-docker-proxy'].filter((line) => /^\s*ports:/.test(line)).length, 0, 'the proxy publishes no port');
});

test('the proxy policy is exactly the allowlist the provisioner needs, every key pinned (LAB-5)', () => {
  const proxy = services['coder-docker-proxy'];
  const value = (name) => proxy.find((line) => new RegExp(`^\\s*${name}:`).test(line))?.match(/"(\d)"/)?.[1];
  const on = ['CONTAINERS', 'IMAGES', 'NETWORKS', 'VOLUMES', 'POST', 'ALLOW_START', 'ALLOW_STOP', 'ALLOW_RESTARTS', 'INFO', 'VERSION', 'PING', 'EVENTS'];
  const off = ['EXEC', 'BUILD', 'COMMIT', 'AUTH', 'SECRETS', 'SWARM', 'SERVICES', 'NODES', 'TASKS', 'SYSTEM', 'PLUGINS', 'SESSION', 'DISTRIBUTION', 'CONFIGS'];
  for (const name of on) assert.equal(value(name), '1', `${name} is on`);
  for (const name of off) assert.equal(value(name), '0', `${name} is off`);
  // Every policy key the service sets is one of the two lists above: a key
  // added or renamed without a decision here fails, which is the point of
  // a regression guard (#900 review).
  const configured = proxy
    .map((line) => line.match(/^\s*([A-Z_]+):\s*"[01]"\s*$/)?.[1])
    .filter(Boolean);
  assert.deepEqual(configured.sort(), [...on, ...off].sort());
});

test('the proxy and the server share a control network that PostgreSQL is not on (#900 review)', () => {
  const networksOf = (lines) => {
    const start = lines.findIndex((line) => /^\s*networks:\s*$/.test(line));
    if (start === -1) return [];
    const out = [];
    for (const line of lines.slice(start + 1)) {
      const m = line.match(/^\s*-\s*([a-z-]+)\s*$/);
      if (!m) break;
      out.push(m[1]);
    }
    return out;
  };
  assert.deepEqual(networksOf(services['coder-docker-proxy']), ['coder-control'], 'the proxy is on the control network only');
  assert.deepEqual(networksOf(services.coder), ['coder', 'coder-control'], 'the server is on both, coder first');
  assert.deepEqual(networksOf(services['coder-postgres']), ['coder'], 'postgres never joins the control network');
});

test('nothing in either file is privileged', () => {
  for (const [name, lines] of Object.entries(services)) {
    assert.equal(lines.filter((line) => /privileged/.test(line)).length, 0, `${name} has no privileged key`);
  }
  const privileged = codeLines(mainTf).filter((line) => /\bprivileged\b/.test(line));
  assert.ok(privileged.length >= 1, 'the template states privileged explicitly');
  for (const line of privileged) {
    assert.match(line, /^\s*privileged\s*=\s*false\s*$/, 'and it is false');
  }
});

test('the workspace mounts no host path', () => {
  assert.equal(containers.length, 1, 'one workspace container resource');
  const [container] = containers;
  const volumes = nestedBlocks(container.body, 'volumes');
  assert.equal(volumes.length, 1, 'exactly one volumes block');
  assert.match(volumes[0], /volume_name\s*=\s*docker_volume\./, 'it is the named volume');
  assert.doesNotMatch(volumes[0], /host_path/, 'and it has no host_path');
  assert.equal(nestedBlocks(container.body, 'mounts').length, 0, 'no mounts blocks (bind mounts live there)');
  assert.doesNotMatch(container.body, /host_path/, 'no host_path anywhere in the container');
  assert.doesNotMatch(container.body, /devices\s*\{/, 'no device passthrough');
});

test('the workspace joins its own bridge network, not the Compose network', () => {
  const [container] = containers;
  assert.doesNotMatch(container.body, /network_mode/, 'no network_mode (host, none, container: or a named network by string)');
  const attach = nestedBlocks(container.body, 'networks_advanced');
  assert.equal(attach.length, 1, 'attached to exactly one network');
  assert.match(attach[0], /name\s*=\s*docker_network\.workspace\[count\.index\]\.name/, 'the per-workspace docker_network resource');
  const networks = hclBlocks(mainTf, 'resource "docker_network"');
  assert.equal(networks.length, 1);
  assert.match(networks[0].body, /name\s*=\s*"coder-ws-\$\{data\.coder_workspace\.me\.id\}"/, 'named per workspace');
  assert.match(networks[0].body, /driver\s*=\s*"bridge"/);
  assert.match(networks[0].body, /count\s*=\s*data\.coder_workspace\.me\.start_count/, 'removed with the container');
  const composeNetwork = compose.match(/^networks:\n(?:\s*#.*\n)*\s+([A-Za-z0-9_-]+):/m);
  assert.ok(composeNetwork, 'the Compose file names its network');
  assert.doesNotMatch(networks[0].body, new RegExp(`"${composeNetwork[1]}"`), 'the workspace network is not the Compose network');
  assert.doesNotMatch(container.body, new RegExp(`"${composeNetwork[1]}"`), 'the container never names the Compose network');
});

test('the workspace runs as uid 65534 with hard limits and no capabilities', () => {
  const [container] = containers;
  assert.match(container.body, /^\s*user\s*=\s*"65534:65534"\s*$/m);
  assert.match(container.body, /^\s*memory\s*=\s*local\.memory_mib\s*$/m);
  assert.match(mainTf, /memory_mib\s*=\s*2048/);
  assert.match(container.body, /^\s*cpu_quota\s*=\s*local\.cpu_quota\s*$/m);
  assert.match(mainTf, /cpu_quota\s*=\s*100000/);
  assert.match(mainTf, /cpu_period\s*=\s*100000/);
  assert.match(container.body, /security_opts\s*=\s*\["no-new-privileges:true"\]/);
  const caps = nestedBlocks(container.body, 'capabilities');
  assert.equal(caps.length, 1);
  assert.match(caps[0], /drop\s*=\s*\["ALL"\]/);
  assert.doesNotMatch(caps[0], /\badd\b/);
});

test('the workspace takes its passwd from the image, not an upload', () => {
  // The hcw-lab image gives uid 65534 /bin/bash and /tmp/home (#693, #698),
  // so the template writes no file into the container before it starts.
  const [container] = containers;
  assert.equal(nestedBlocks(container.body, 'upload').length, 0);
  assert.doesNotMatch(mainTf, /^\s*passwd\s*=/m);
});

test('the workspace image is the hcw-lab digest and Coder itself binds to loopback only', () => {
  assert.match(mainTf, /docker\.io\/hybridcloudworks\/hcw-lab@\$\{local\.image_digest\}/);
  assert.match(mainTf, /image_digest\s*=\s*"sha256:[0-9a-f]{64}"/);
  const ports = services.coder.filter((line) => /^\s*-\s*"/.test(line) && /:\d+:\d+"/.test(line));
  assert.equal(ports.length, 1);
  assert.match(ports[0], /"127\.0\.0\.1:7080:7080"/);
  assert.equal(services['coder-postgres'].filter((line) => /^\s*ports:/.test(line)).length, 0, 'postgres publishes nothing');
});

test('Coder does not redirect to its access URL behind the TLS-terminating proxy', () => {
  // With this on, Coder answers every plain-HTTP request from Caddy with a
  // redirect to the https access URL, and the browser loops (PR #722).
  const redirect = services.coder.filter((line) => /^\s*CODER_REDIRECT_TO_ACCESS_URL:/.test(line));
  assert.equal(redirect.length, 1);
  assert.match(redirect[0], /CODER_REDIRECT_TO_ACCESS_URL:\s*"false"\s*$/);
});

test('workspace apps are served on their own names only, never on the dashboard origin', () => {
  // Path-based apps (/@<owner>/<workspace>/apps/<app>/) run a workspace's
  // JavaScript on the dashboard's origin, where it can call the Coder API as
  // the learner, and Coder v2.37.3 enables them unless told not to. Coder's
  // own guidance is to disable them whenever a wildcard access URL exists,
  // and every app this template declares is a subdomain app.
  const wildcard = services.coder.filter((line) => /^\s*CODER_WILDCARD_ACCESS_URL:/.test(line));
  assert.equal(wildcard.length, 1, 'a wildcard access URL is configured');
  const pathApps = services.coder.filter((line) => /^\s*CODER_DISABLE_PATH_APPS:/.test(line));
  assert.equal(pathApps.length, 1);
  assert.match(pathApps[0], /CODER_DISABLE_PATH_APPS:\s*"true"\s*$/);
  // Owner decision 2026-09-28: Coder's anonymized usage telemetry is off.
  const telemetry = services.coder.filter((line) => /^\s*CODER_TELEMETRY_ENABLE:/.test(line));
  assert.equal(telemetry.length, 1, 'telemetry is set exactly once');
  assert.match(telemetry[0], /CODER_TELEMETRY_ENABLE:\s*"false"\s*$/);
  const appModules = hclBlocks(mainTf, 'module "code-server"');
  assert.equal(appModules.length, 1);
  assert.match(appModules[0].body, /^\s*subdomain\s*=\s*true\s*$/m, 'code-server is a subdomain app');
  const pathApp = codeLines(mainTf).filter((line) => /^\s*subdomain\s*=\s*false\b/.test(line));
  assert.equal(pathApp.length, 0, 'no app in the template asks to be served by path');
});

test('code-server opens trusted, without the AI chat, on the README, with telemetry off', () => {
  // 2026-09-28: the first workspace opened in Restricted Mode with the
  // built-in Chat panel asking for a sign-in. The settings are the fix; each
  // name was checked against VS Code 1.140.0, which code-server 4.140.0
  // carries, and the `settings` input against the module at 1.6.0. A bump
  // of either pin means checking them again, which is why both are here.
  const [codeServer] = hclBlocks(mainTf, 'module "code-server"');
  assert.match(codeServer.body, /^\s*version\s*=\s*"1\.6\.0"\s*$/m, 'the module the settings input was read from');
  assert.match(codeServer.body, /^\s*install_version\s*=\s*"4\.140\.0"\s*$/m, 'the code-server the setting names were read from');
  // The release notice stays off: its link opened a window the site's
  // sandboxed pane could not navigate (#911), and the release is this pin.
  assert.match(codeServer.body, /^\s*additional_args\s*=\s*"--disable-update-check"\s*$/m, 'release notices off');
  const settings = assignedObject(codeServer.body, 'settings');
  assert.ok(settings !== null, 'the module is given User settings');
  const entries = settings
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.match(/^\s*"([^"]+)"\s*=\s*(\S.*?)\s*$/));
  assert.ok(entries.every(Boolean), `every line of settings is one "name" = value:\n${settings}`);
  assert.deepEqual(Object.fromEntries(entries.map(([, name, value]) => [name, value])), {
    'security.workspace.trust.enabled': 'false',
    'chat.disableAIFeatures': 'true',
    'workbench.startupEditor': '"readme"',
    'telemetry.telemetryLevel': '"off"',
    'terminal.integrated.rightClickBehavior': '"copyPaste"',
  });
});

// ---------------------------------------------------------------------------
// #954, in every template.

const templatesDir = join(here, '..');
const TEMPLATES = ['amo-guided-lab', 'hcw-lab', 'na-guided-lab'];
/** Every status a workspace build can have (codersdk.WorkspaceStatus, Coder v2.38.0). */
const BUILD_STATUSES = [
  'pending',
  'starting',
  'running',
  'stopping',
  'stopped',
  'failed',
  'canceling',
  'canceled',
  'deleting',
  'deleted',
];
const templateTf = (name) => readFileSync(join(templatesDir, name, 'main.tf'), 'utf8');

/** The value of `name = <value>` on one line of a body, comment stripped and trimmed, or null. */
function attribute(body, name) {
  const line = codeLines(body).find((candidate) => new RegExp(`^\\s*${name}\\s*=`).test(candidate));
  return line ? line.replace(new RegExp(`^\\s*${name}\\s*=\\s*`), '').trim() : null;
}

/** Every top-level `locals { }` body of a template, joined. */
const localsOf = (text) =>
  hclBlocks(text, 'locals {')
    .map((block) => block.body)
    .join('\n');

test('the #954 checks cover every template there is', () => {
  const found = readdirSync(templatesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(templatesDir, entry.name, 'main.tf')))
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(found, TEMPLATES);
});

for (const name of TEMPLATES) {
  const text = templateTf(name);
  const locals = localsOf(text);
  const [container] = hclBlocks(text, 'resource "docker_container"');
  const [agent] = hclBlocks(text, 'resource "coder_agent"');
  const [listing] = hclBlocks(text, 'data "http" "owner_workspaces"');

  test(`${name}: cloud sign-ins live on a tmpfs the learner owns, never on the home volume`, () => {
    assert.equal(attribute(locals, 'cloud_creds_dir'), '"/tmp/cloud-creds"');
    const home = JSON.parse(attribute(locals, 'home'));
    assert.ok(!`/tmp/cloud-creds/`.startsWith(`${home}/`), 'the tmpfs is not under the home volume');
    const tmpfs = assignedObject(container.body, 'tmpfs');
    assert.ok(tmpfs !== null, 'the container has a tmpfs map');
    const entries = tmpfs.split('\n').filter((line) => line.trim() !== '');
    assert.equal(entries.length, 1, 'one tmpfs');
    const [, key, options] = entries[0].match(/^\s*(\S+)\s*=\s*"([^"]+)"\s*$/) ?? [];
    assert.equal(key, '(local.cloud_creds_dir)');
    const opts = new Set(options.split(','));
    for (const flag of ['nosuid', 'nodev', 'noexec', 'mode=0700']) assert.ok(opts.has(flag), `${flag} in ${options}`);
    assert.ok([...opts].some((opt) => /^size=\d+[km]$/.test(opt)), `a size in ${options}`);
    // Owned by the uid and gid the workspace runs as, so the learner can write there.
    const user = attribute(container.body, 'user');
    const runAs = user === 'local.uid' ? JSON.parse(attribute(locals, 'uid')) : JSON.parse(user);
    const [uid, gid] = runAs.split(':');
    assert.equal(uid, '65534');
    assert.ok(opts.has(`uid=${uid}`) && opts.has(`gid=${gid}`), `uid ${uid} and gid ${gid} in ${options}`);
    // Still no mounts block: the only mount is the named volume.
    assert.equal(nestedBlocks(container.body, 'mounts').length, 0);
  });

  test(`${name}: the agent points the Azure, AWS and Google Cloud CLIs into the tmpfs`, () => {
    const env = assignedObject(locals, 'cloud_creds_env');
    assert.ok(env !== null, 'local.cloud_creds_env');
    const vars = Object.fromEntries(
      env
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => line.match(/^\s*([A-Z_]+)\s*=\s*"([^"]+)"\s*$/).slice(1))
    );
    assert.deepEqual(Object.keys(vars).sort(), [
      'AWS_CONFIG_FILE',
      'AWS_SHARED_CREDENTIALS_FILE',
      'AZURE_CONFIG_DIR',
      'CLOUDSDK_CONFIG',
    ]);
    for (const [variable, value] of Object.entries(vars)) {
      assert.match(value, /^\$\{local\.cloud_creds_dir\}\/[a-z]+(\/[a-z]+)?$/, `${variable} is under the tmpfs`);
    }
    assert.match(agent.body, /^\s*env\s*=\s*merge\(local\.cloud_creds_env,\s*\{\s*$/m, 'the agent env merges them');
    // The AWS CLI's caches (sso/cache, cli/cache) have no setting, so all of
    // ~/.aws is a link into the tmpfs, made first thing at every start.
    assert.match(locals, /^ {4}mkdir -p '\$\{local\.cloud_creds_dir\}\/aws'$/m, 'local.aws_home_link makes the directory');
    assert.match(locals, /^ {4}if \[ ! -L "\$HOME\/\.aws" \]; then rm -rf "\$HOME\/\.aws"; fi$/m, 'and removes a directory left there');
    assert.match(locals, /^ {4}ln -sfn '\$\{local\.cloud_creds_dir\}\/aws' "\$HOME\/\.aws"$/m, 'and links ~/.aws to the tmpfs');
    const start = agent.body.slice(agent.body.indexOf('startup_script = <<-EOT'));
    const firstLines = start.split('\n').slice(1, 4).map((line) => line.trim());
    assert.ok(
      firstLines.some((line) => /^\$\{local\.aws_home_link\}$/.test(line)),
      `the start script calls it first: ${firstLines.join(' | ')}`
    );
    assert.doesNotMatch(
      agent.body,
      /^\s*(AZURE_CONFIG_DIR|AWS_CONFIG_FILE|AWS_SHARED_CREDENTIALS_FILE|CLOUDSDK_CONFIG)\s*=/m,
      'and nothing in the agent overrides them'
    );
  });

  test(`${name}: a start is refused while another of the learner's workspaces runs`, () => {
    assert.equal(attribute(locals, 'max_running_workspaces'), '1');
    const lifecycle = nestedBlocks(container.body, 'lifecycle');
    assert.equal(lifecycle.length, 1);
    const [precondition] = nestedBlocks(lifecycle[0], 'precondition');
    assert.ok(precondition, 'a precondition on the container');
    assert.equal(
      attribute(precondition, 'condition'),
      'length(local.other_running_workspaces) < local.max_running_workspaces'
    );
    const message = attribute(precondition, 'error_message');
    assert.ok(message.endsWith('Stop your other lab first: ${join(", ", local.other_running_workspaces)}."'), message);
    // The words the lab launcher reads out of the failed build's log, as
    // `terraform plan -json` gave the detail on 2026-10-16.
    assert.ok(LIMIT_REFUSAL.test('Stop your other lab first: lab-lzb.'));
    assert.equal(
      limitBlocker([
        { log_level: 'error', output: 'Only one lab workspace can run at a time. Stop your other lab first: lab-lzb.' },
      ]),
      'lab-lzb'
    );
    // Counted by the latest builds that leave a container running, or may.
    const counted = locals.slice(locals.indexOf('other_running_workspaces'));
    assert.match(counted, /for listing in data\.http\.owner_workspaces/);
    assert.match(counted, /w\.id != data\.coder_workspace\.me\.id/, 'this workspace is left out');
    assert.match(
      counted,
      /contains\(lookup\(local\.blocking_builds, w\.latest_build\.transition, \[\]\), w\.latest_build\.status\)/
    );
    const blocking = assignedObject(locals, 'blocking_builds');
    assert.ok(blocking !== null, 'local.blocking_builds');
    const builds = Object.fromEntries(
      blocking
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => {
          const [, transition, list] = line.match(/^\s*([a-z]+)\s*=\s*\[([^\]]*)\]\s*$/);
          return [transition, [...list.matchAll(/"([a-z]+)"/g)].map(([, status]) => status)];
        })
    );
    assert.deepEqual(builds, { start: ['pending', 'starting', 'running', 'canceling'], stop: ['failed'] });
    // And counted exactly as the lab launcher counts them, so the launcher
    // starts this lab again only once the template would let it.
    for (const transition of ['start', 'stop', 'delete']) {
      for (const status of BUILD_STATUSES) {
        assert.equal(
          isBlocking({ latest_build: { transition, status } }),
          (builds[transition] ?? []).includes(status),
          `${transition} ${status}`
        );
      }
    }
  });

  test(`${name}: the owner's workspaces are read on a start only, inside Coder's container, failing closed`, () => {
    assert.ok(listing, 'data "http" "owner_workspaces"');
    assert.equal(
      attribute(listing.body, 'count'),
      'data.coder_workspace.me.start_count > 0 && nonsensitive(data.coder_workspace_owner.me.session_token != "") ? 1 : 0'
    );
    assert.equal(attribute(locals, 'coder_api_url'), '"http://127.0.0.1:7080"');
    assert.equal(attribute(listing.body, 'url'), '"${local.coder_api_url}/api/v2/workspaces?q=owner:me"');
    const headers = assignedObject(listing.body, 'request_headers');
    assert.match(headers, /^\s*Coder-Session-Token\s*=\s*data\.coder_workspace_owner\.me\.session_token\s*$/m);
    const [postcondition] = nestedBlocks(listing.body, 'postcondition');
    assert.equal(attribute(postcondition, 'condition'), 'self.status_code == 200');
    // The provider, pinned exactly, and in the lock file at that version for both platforms.
    const pinned = text.match(/http = \{\s*source\s*=\s*"hashicorp\/http"\s*version\s*=\s*"(\d+\.\d+\.\d+)"\s*\}/);
    assert.ok(pinned, 'hashicorp/http pinned to an exact version');
    const lock = readFileSync(join(templatesDir, name, '.terraform.lock.hcl'), 'utf8');
    const locked = lock.match(
      /provider "registry\.terraform\.io\/hashicorp\/http" \{\n\s*version\s*=\s*"([^"]+)"[\s\S]*?hashes = \[([\s\S]*?)\]/
    );
    assert.ok(locked, 'the lock file carries hashicorp/http');
    assert.equal(locked[1], pinned[1]);
    assert.equal((locked[2].match(/"h1:/g) ?? []).length, 2, 'linux_amd64 and windows_amd64, as for the other providers');
  });
}
