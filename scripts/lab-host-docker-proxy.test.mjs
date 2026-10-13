/**
 * The lab host's container-runtime privilege separation (LAB-5, 2026-10-07),
 * held to the files that make it:
 *
 *   - the lab agent reaches Docker only through hcw-labs-agent-docker-proxy,
 *     whose HAProxy configuration
 *     (lab-host/ansible/roles/labs_agent/templates/docker-proxy.haproxy.cfg.j2)
 *     is evaluated here, rule by rule, against every request the Docker CLI
 *     the host pins makes for every capability's job
 *     (scripts/fixtures/docker-cli-agent-requests.json, recorded by
 *     scripts/lab/capture-docker-cli-requests.mjs) and against the requests
 *     that would turn a job container into a way out;
 *   - the agent's user is in no docker group, and its unit's DOCKER_HOST is
 *     that proxy;
 *   - the host daemon remaps user namespaces, with the containerd image
 *     store off, which the remap requires.
 *
 * The evaluator reads the configuration as HAProxy would for the subset it
 * uses (named ACLs, `-m reg`, `-m str`, `-m found`, integer comparisons,
 * `method`, AND-ed conditions with `!`, first matching http-request rule
 * wins) and refuses any line outside that subset, so a rule written in a
 * form this test cannot read fails here instead of passing unexamined. The
 * regular expressions are compiled as JavaScript; the constructs used
 * (classes, alternation, lookahead, `(?i:...)`, `\x5c`) mean the same in
 * PCRE2, and CI parses the rendered file with `haproxy -c` at the pinned
 * image for the rest.
 *
 * In the CI matrix this runs in the `scripts (operations)` row, whose filter
 * covers lab-host/ and vps-agent/lib/(capabilities|docker-runner).js.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDockerArgs } from '../vps-agent/lib/docker-runner.js';
import { CAPABILITIES } from '../vps-agent/lib/capabilities.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const ansible = path.join(repoRoot, 'lab-host', 'ansible');
const read = (...parts) => readFileSync(path.join(...parts), 'utf8');

const template = read(ansible, 'roles', 'labs_agent', 'templates', 'docker-proxy.haproxy.cfg.j2');
const fixture = JSON.parse(read(here, 'fixtures', 'docker-cli-agent-requests.json'));
const groupVars = read(ansible, 'group_vars', 'all.yml');
const agentDefaults = read(ansible, 'roles', 'labs_agent', 'defaults', 'main.yml');
const agentVars = read(ansible, 'roles', 'labs_agent', 'vars', 'main.yml');
const agentTasks = read(ansible, 'roles', 'labs_agent', 'tasks', 'main.yml');
const agentUnit = read(ansible, 'roles', 'labs_agent', 'templates', 'hcw-labs-agent.service.j2');
const dockerDefaults = read(ansible, 'roles', 'docker', 'defaults', 'main.yml');
const runnerSource = read(repoRoot, 'vps-agent', 'lib', 'docker-runner.js');

const TMP_DIR = agentDefaults.match(/^labs_agent_tmp_dir: (\S+)$/m)[1];
const SOCKET_DIR = agentVars.match(/^labs_agent_docker_proxy_socket_dir: (\S+)$/m)[1];
const ID = 'f'.repeat(64);

/** Python's re.escape, which Ansible's regex_escape filter is. */
const pythonReEscape = (text) => text.replace(/[()[\]{}?*+\-|^$\\.&~# \t\n\r\v\f]/g, (c) => `\\${c}`);

// ── Rendering ──────────────────────────────────────────────────────────────

const JINJA = {
  '{{ ansible_managed }}': 'Ansible managed (test)',
  '{{ labs_agent_docker_proxy_socket }}': `${SOCKET_DIR}/docker.sock`,
  '{{ labs_agent_docker_proxy_gid }}': '998',
  '{{ labs_agent_tmp_dir | regex_escape }}': pythonReEscape(TMP_DIR),
};

function render(text) {
  let out = text;
  for (const [expression, value] of Object.entries(JINJA)) out = out.split(expression).join(value);
  return out;
}

const config = render(template);

// ── Parsing: the subset of HAProxy configuration the file uses ─────────────

/** Split a configuration line into words, honouring single quotes (HAProxy's strong quoting). */
function words(line) {
  const out = [];
  let current = null;
  let quoted = false;
  for (const ch of line) {
    if (quoted) {
      if (ch === "'") quoted = false;
      else current += ch;
    } else if (ch === "'") {
      quoted = true;
      current = current ?? '';
    } else if (ch === ' ' || ch === '\t') {
      if (current !== null) out.push(current);
      current = null;
    } else {
      current = (current ?? '') + ch;
    }
  }
  if (quoted) throw new Error(`unterminated quote: ${line}`);
  if (current !== null) out.push(current);
  return out;
}

function frontendLines(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^frontend agent\s*$/.test(l));
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) body.push(trimmed);
  }
  return body;
}

const FETCHES = {
  method: (r) => r.method,
  path: (r) => r.path,
  query: (r) => (r.query === '' ? undefined : r.query),
  'req.body': (r) => r.body,
  'req.body_size': (r) => (r.headers['content-length'] !== undefined ? Number(r.headers['content-length']) : Buffer.byteLength(r.body)),
  'req.hdr_cnt(content-length)': (r) => (r.headers['content-length'] !== undefined ? 1 : 0),
  'req.hdr(transfer-encoding)': (r) => r.headers['transfer-encoding'],
  'req.hdr(content-type)': (r) => r.headers['content-type'],
};

function parseAcl(args) {
  const [name, fetch, ...rest] = args;
  if (!(fetch in FETCHES)) throw new Error(`acl ${name}: fetch ${fetch} is not one this test can read`);
  let mode = null;
  let insensitive = false;
  const patterns = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '-m') {
      mode = rest[i + 1];
      i += 1;
    } else if (rest[i] === '-i') {
      insensitive = true;
    } else {
      patterns.push(rest[i]);
    }
  }
  let test;
  if (fetch === 'method') {
    test = (value) => patterns.includes(value);
  } else if (mode === 'reg') {
    expect(patterns).toHaveLength(1);
    const re = new RegExp(patterns[0], insensitive ? 'i' : '');
    test = (value) => value !== undefined && re.test(value);
  } else if (mode === 'str') {
    expect(patterns).toHaveLength(1);
    test = (value) => value !== undefined && (insensitive ? value.toLowerCase() === patterns[0].toLowerCase() : value === patterns[0]);
  } else if (mode === 'found') {
    test = (value) => value !== undefined;
  } else if (mode === null && ['eq', 'gt'].includes(patterns[0])) {
    const n = Number(patterns[1]);
    test = patterns[0] === 'eq' ? (value) => value === n : (value) => value > n;
  } else {
    throw new Error(`acl ${name}: match ${mode} ${patterns.join(' ')} is not one this test can read`);
  }
  return { name, fetch, source: patterns[0], test };
}

function parse(text) {
  const acls = new Map();
  const rules = [];
  for (const line of frontendLines(text)) {
    const [keyword, ...args] = words(line);
    if (keyword === 'acl') {
      const acl = parseAcl(args);
      acls.set(acl.name, [...(acls.get(acl.name) || []), acl]);
    } else if (keyword === 'http-request') {
      const action = args[0];
      if (!['allow', 'deny'].includes(action)) throw new Error(`http-request ${action} is not one this test can read`);
      const at = args.findIndex((w) => w === 'if' || w === 'unless');
      const condition = at === -1 ? [] : args.slice(at + 1);
      if (at !== -1 && args[at] === 'unless') throw new Error('unless is not one this test can read');
      if (condition.some((w) => w === '||' || w === 'or' || w.startsWith('{'))) {
        throw new Error(`condition ${condition.join(' ')} is not one this test can read`);
      }
      const message = args.includes('string') ? JSON.parse(args[args.indexOf('string') + 1]).message : null;
      rules.push({ action, condition, message, line });
    } else if (!['bind', 'default_backend'].includes(keyword)) {
      throw new Error(`frontend keyword ${keyword} is not one this test can read`);
    }
  }
  return { acls, rules };
}

const parsed = parse(config);

function aclTrue(name, request) {
  const declarations = parsed.acls.get(name);
  if (!declarations) throw new Error(`condition names an undeclared acl ${name}`);
  // Declarations of one name are OR-ed.
  return declarations.some((acl) => acl.test(FETCHES[acl.fetch](request)));
}

/** First http-request rule whose AND-ed condition holds. */
function decide(request) {
  for (const rule of parsed.rules) {
    const holds = rule.condition.every((term) => (term.startsWith('!') ? !aclTrue(term.slice(1), request) : aclTrue(term, request)));
    if (holds) return rule;
  }
  return { action: 'allow', line: '(no rule: HAProxy passes the request)' };
}

// ── Requests ───────────────────────────────────────────────────────────────

const materialise = (r) => ({ ...r, path: r.path.replace('<id>', ID) });
const recordedRuns = Object.entries(fixture.runs);

/**
 * The job image, pinned by digest, moves with every publish (the
 * chore/lab-pins-image-digests pull request), and the recording must not go
 * stale with it: #989 moved the digest while #987 was open and this test
 * went red on a rebase. The argv is compared with its one digest-pinned image
 * reference (the runner, or a capability's own image) normalised on both sides; the proxy rules below still see the recorded
 * digest form, which is all they check.
 */
const PINNED_IMAGE = /^[a-z0-9][a-z0-9./_-]*(?::[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$/;
const samePinnedImage = (arg) => (PINNED_IMAGE.test(arg) ? '<image by digest>' : arg);
const createOf = (run) => materialise(run.requests.find((r) => r.path.endsWith('/containers/create')));

function createWithBody(body, headers = {}) {
  return {
    method: 'POST',
    path: '/v1.56/containers/create',
    query: 'name=labjob-0123456789ab',
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), ...headers },
    body,
  };
}

const call = (method, pathname, query = '') => ({ method, path: pathname, query, headers: {}, body: '' });

// ── The tests ──────────────────────────────────────────────────────────────

describe('the agent proxy configuration', () => {
  it('uses no Jinja beyond the four values this test renders', () => {
    const expressions = [...template.matchAll(/\{\{.*?\}\}|\{%.*?%\}|\{#/g)].map((m) => m[0]);
    expect([...new Set(expressions)].sort()).toEqual(Object.keys(JINJA).sort());
  });

  it('listens on the socket the agent unit names, for the agent group only', () => {
    expect(config).toMatch(new RegExp(`^\\s+bind unix@${SOCKET_DIR}/docker\\.sock mode 660 gid \\d+$`, 'm'));
    expect(agentUnit).toMatch(/^Environment=DOCKER_HOST=\{\{ labs_agent_docker_host \}\}$/m);
    expect(agentVars).toMatch(/^labs_agent_docker_host: "unix:\/\/\{\{ labs_agent_docker_proxy_socket \}\}"$/m);
    expect(agentVars).toMatch(/^labs_agent_docker_proxy_socket: "\{\{ labs_agent_docker_proxy_socket_dir \}\}\/docker\.sock"$/m);
  });

  it('ends in a deny with no condition, so nothing unlisted passes', () => {
    const last = parsed.rules.at(-1);
    expect(last.action).toBe('deny');
    expect(last.condition).toEqual([]);
    expect(parsed.rules.filter((r) => r.action === 'allow').every((r) => r.condition.length > 0)).toBe(true);
  });
});

describe('what Docker CLI does for a job, recorded', () => {
  it('was recorded with the docker CLI the lab host pins', () => {
    const engine = groupVars.match(/^ {2}resolute:\n {4}engine: "5:([0-9.]+)-/m)[1];
    expect(fixture.dockerCli).toBe(engine);
  });

  it('was recorded from the argv buildDockerArgs builds today, for every capability', () => {
    expect(Object.keys(fixture.runs).sort()).toEqual(Object.keys(CAPABILITIES).sort());
    for (const [name, run] of recordedRuns) {
      const argv = buildDockerArgs(CAPABILITIES[name], { ...fixture.job, encoding: run.encoding }, fixture.limits);
      expect(argv.map(samePinnedImage), `${name}: re-run scripts/lab/capture-docker-cli-requests.mjs`).toEqual(
        run.argv.map(samePinnedImage)
      );
      // Exactly one image, pinned by digest, on both sides.
      expect(argv.filter((arg) => PINNED_IMAGE.test(arg))).toHaveLength(1);
      expect(run.argv.filter((arg) => PINNED_IMAGE.test(arg))).toHaveLength(1);
    }
  });

  it('stages each job where the proxy\'s bind rule expects it, and names its container as the rule expects', () => {
    expect(fixture.job.jobDir.startsWith(`${TMP_DIR}/labjob-`)).toBe(true);
    // fs.mkdtemp's suffix is six characters from [A-Za-z0-9]; prepareJobDir uses it.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'labjob-'));
    try {
      expect(path.basename(dir)).toMatch(/^labjob-[A-Za-z0-9]{6}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(runnerSource).toMatch(/fs\.mkdtemp\(path\.join\(os\.tmpdir\(\), 'labjob-'\)\)/);
    expect(runnerSource).toMatch(/const containerName = `labjob-\$\{crypto\.randomBytes\(6\)\.toString\('hex'\)\}`;/);
  });

  it.each(recordedRuns)('passes every request of a %s job', (_name, run) => {
    for (const request of run.requests.map(materialise)) {
      expect(decide(request).action, `${request.method} ${request.path}?${request.query}`).toBe('allow');
    }
  });

  it('passes the docker rm -f a timed-out job sends', () => {
    for (const request of fixture.remove.requests.map(materialise)) {
      expect(decide(request).action, `${request.method} ${request.path}`).toBe('allow');
    }
  });
});

describe('a container create that asks for a way out is refused', () => {
  const base = createOf(fixture.runs['ansible-check']);
  const replaceInHostConfig = (from, to) => {
    expect(base.body.includes(from), `fixture body carries ${from}`).toBe(true);
    return base.body.replace(from, to);
  };
  const addToHostConfig = (fragment) => base.body.replace('"HostConfig":{', `"HostConfig":{${fragment},`);

  const cases = [
    ['privileged mode', () => replaceInHostConfig('"Privileged":false', '"Privileged":true')],
    ['privileged, spelled in lower case', () => replaceInHostConfig('"Privileged":false', '"privileged":true')],
    ['privileged, with whitespace', () => replaceInHostConfig('"Privileged":false', '"Privileged" :\n true')],
    ['privileged, as a second key after a harmless first', () => addToHostConfig('"Privileged":false,"Privileged":true')],
    ['the opt-out of user namespaces', () => replaceInHostConfig('"UsernsMode":""', '"UsernsMode":"host"')],
    ['the host pid namespace', () => replaceInHostConfig('"PidMode":""', '"PidMode":"host"')],
    ['the host ipc namespace', () => replaceInHostConfig('"IpcMode":""', '"IpcMode":"host"')],
    ['the host uts namespace', () => replaceInHostConfig('"UTSMode":""', '"UTSMode":"host"')],
    ['the host cgroup namespace', () => replaceInHostConfig('"CgroupnsMode":""', '"CgroupnsMode":"host"')],
    ['a cgroup parent', () => replaceInHostConfig('"CgroupParent":""', '"CgroupParent":"/"')],
    ['the host network', () => replaceInHostConfig('"NetworkMode":"none"', '"NetworkMode":"host"')],
    ['another container\'s network', () => replaceInHostConfig('"NetworkMode":"none"', '"NetworkMode":"container:coder"')],
    ['an endpoint on a network', () => base.body.replace('"EndpointsConfig":{}', '"EndpointsConfig":{"bridge":{}}')],
    ['an added capability', () => replaceInHostConfig('"CapAdd":null', '"CapAdd":["SYS_ADMIN"]')],
    ['a device', () => replaceInHostConfig('"Devices":[]', '"Devices":[{"PathOnHost":"/dev/sda","PathInContainer":"/dev/sda","CgroupPermissions":"rwm"}]')],
    ['a device cgroup rule', () => replaceInHostConfig('"DeviceCgroupRules":null', '"DeviceCgroupRules":["b *:* rwm"]')],
    ['a GPU request', () => replaceInHostConfig('"DeviceRequests":null', '"DeviceRequests":[{"Count":-1}]')],
    ['a bind mount of /', () => addToHostConfig('"Mounts":[{"Type":"bind","Source":"/","Target":"/host"}]')],
    ['a bind of the host root as the one bind', () => replaceInHostConfig(`"Binds":["${fixture.job.jobDir}:/workspace:ro"]`, '"Binds":["/:/host"]')],
    ['a second bind beside the job directory', () => replaceInHostConfig(`"Binds":["${fixture.job.jobDir}:/workspace:ro"]`, `"Binds":["${fixture.job.jobDir}:/workspace:ro","/etc:/etc2:ro"]`)],
    ['the job directory writable', () => replaceInHostConfig(`${fixture.job.jobDir}:/workspace:ro`, `${fixture.job.jobDir}:/workspace:rw`)],
    ['a job directory outside the staging directory', () => replaceInHostConfig(`${fixture.job.jobDir}:`, '/var/lib/docker/labjob-Ab3xZ9:')],
    ['the staging path in another case', () => replaceInHostConfig(`${fixture.job.jobDir}:`, `${fixture.job.jobDir.toUpperCase().replace('LABJOB-AB3XZ9', 'labjob-Ab3xZ9')}:`)],
    ['the Docker socket as the bind', () => replaceInHostConfig(`${fixture.job.jobDir}:/workspace:ro`, '/var/run/docker.sock:/workspace:ro')],
    ['volumes from another container', () => replaceInHostConfig('"VolumesFrom":null', '"VolumesFrom":["portainer"]')],
    ['a link to another container', () => replaceInHostConfig('"Links":null', '"Links":["coder-postgres:db"]')],
    ['an added group', () => replaceInHostConfig('"GroupAdd":null', '"GroupAdd":["docker"]')],
    ['seccomp off', () => replaceInHostConfig('"SecurityOpt":["no-new-privileges"]', '"SecurityOpt":["no-new-privileges","seccomp=unconfined"]')],
    ['AppArmor off', () => replaceInHostConfig('"SecurityOpt":["no-new-privileges"]', '"SecurityOpt":["apparmor=unconfined"]')],
    ['unmasked kernel paths', () => replaceInHostConfig('"MaskedPaths":null', '"MaskedPaths":[]')],
    ['writable kernel paths', () => replaceInHostConfig('"ReadonlyPaths":null', '"ReadonlyPaths":[]')],
    ['a sysctl', () => addToHostConfig('"Sysctls":{"kernel.shm_rmid_forced":"1"}')],
    ['another runtime', () => addToHostConfig('"Runtime":"io.containerd.runc.v2"')],
    ['a volume driver', () => replaceInHostConfig('"VolumeDriver":""', '"VolumeDriver":"local"')],
    ['a log driver that reaches out', () => replaceInHostConfig('"LogConfig":{"Type":""', '"LogConfig":{"Type":"syslog"')],
    ['OCI annotations', () => addToHostConfig('"Annotations":{"io.kubernetes.cri.container-type":"sandbox"}')],
    ['a published port', () => replaceInHostConfig('"PortBindings":{}', '"PortBindings":{"22/tcp":[{"HostPort":"2222"}]}')],
    ['every port published', () => replaceInHostConfig('"PublishAllPorts":false', '"PublishAllPorts":true')],
    ['the OOM killer off', () => replaceInHostConfig('"OomKillDisable":false', '"OomKillDisable":true')],
    ['an image that is not a digest', () => base.body.replace(/"Image":"[^"]+"/, '"Image":"alpine:latest"')],
    ['a key spelled with a JSON escape', () => replaceInHostConfig('"Privileged":false', '"Privil\\u0065ged":true')],
    ['a key spelled with a character Go folds to s', () => replaceInHostConfig('"UsernsMode":""', '"UsernſMode":"host"')],
    ['a key spelled with the Kelvin sign', () => addToHostConfig('"LinKs":["coder:db"]')],
  ];

  it.each(cases)('%s', (_label, mutate) => {
    const body = mutate();
    expect(body).not.toBe(base.body);
    const rule = decide(createWithBody(body));
    expect(rule.action, rule.line).toBe('deny');
    expect(rule.message).toMatch(/refused this container/);
  });

  it('a body larger than the proxy reads whole', () => {
    const body = base.body.replace('"Env":[', `"Env":["PAD=${'x'.repeat(9000)}",`);
    expect(decide(createWithBody(body)).action).toBe('deny');
  });

  it('a chunked body, which has no length to check', () => {
    const request = createWithBody(base.body, { 'transfer-encoding': 'chunked' });
    delete request.headers['content-length'];
    expect(decide(request).action).toBe('deny');
  });

  it('a body that is not JSON by its content type', () => {
    expect(decide(createWithBody(base.body, { 'content-type': 'text/plain' })).action).toBe('deny');
  });

  it('a create with no name, or a name that is not a job\'s', () => {
    expect(decide({ ...createWithBody(base.body), query: '' }).action).toBe('deny');
    expect(decide({ ...createWithBody(base.body), query: 'name=coder-owner-lab' }).action).toBe('deny');
    expect(decide({ ...createWithBody(base.body), query: 'name=labjob-0123456789ab&platform=linux' }).action).toBe('deny');
  });

  it('while the unchanged body still passes', () => {
    expect(decide(createWithBody(base.body)).action).toBe('allow');
  });
});

describe('every call a job does not make is refused', () => {
  const cases = [
    ['listing containers', call('GET', '/v1.56/containers/json', 'all=1')],
    ['inspecting a container, which shows its environment', call('GET', `/v1.56/containers/${ID}/json`)],
    ['inspecting Coder by name', call('GET', '/v1.56/containers/coder/json')],
    ['creating an exec', call('POST', `/v1.56/containers/${ID}/exec`)],
    ['starting an exec', call('POST', `/v1.56/exec/${ID}/start`)],
    ['killing a container', call('POST', `/v1.56/containers/${ID}/kill`)],
    ['copying files into a container', call('PUT', `/v1.56/containers/${ID}/archive`, 'path=/')],
    ['reading files out of a container', call('GET', `/v1.56/containers/${ID}/archive`, 'path=/')],
    ['pulling an image', call('POST', '/v1.56/images/create', 'fromImage=alpine&tag=latest')],
    ['building an image', call('POST', '/v1.56/build')],
    ['creating a volume', call('POST', '/v1.56/volumes/create')],
    ['creating a network', call('POST', '/v1.56/networks/create')],
    ['installing a plugin', call('POST', '/v1.56/plugins/pull', 'remote=x')],
    ['reading the daemon\'s information', call('GET', '/v1.56/info')],
    ['reading the event stream', call('GET', '/v1.56/events')],
    ['a session', call('POST', '/v1.56/session')],
    ['removing a container that is not a job', call('DELETE', '/v1.56/containers/coder-postgres', 'force=1')],
    ['removing a job without force', call('DELETE', '/v1.56/containers/labjob-0123456789ab')],
    ['removing a job and its volumes', call('DELETE', '/v1.56/containers/labjob-0123456789ab', 'force=1&v=1')],
    ['a create path spelled with an escape', call('POST', '/v1.56/containers%2Fcreate', 'name=labjob-0123456789ab')],
    ['a path that climbs out of a job container', call('POST', `/v1.56/containers/${ID}/../../images/create`)],
    ['a ping by POST', call('POST', '/_ping')],
    ['an attach with a body', { ...call('POST', `/v1.56/containers/${ID}/attach`, 'stream=1'), headers: { 'content-length': '2' }, body: '{}' }],
    ['a start with a body', { ...call('POST', `/v1.56/containers/${ID}/start`), headers: { 'content-length': '2' }, body: '{}' }],
  ];

  it.each(cases)('%s', (_label, request) => {
    const rule = decide(request);
    expect(rule.action, rule.line).toBe('deny');
  });
});

describe('the agent and the daemons around the proxy', () => {
  it('the agent user is put in no supplementary group, and taken out of docker', () => {
    const userTask = agentTasks.match(/- name: Create the agent user[^\n]*\n {2}ansible\.builtin\.user:\n((?: {4}.*\n)+)/);
    expect(userTask).not.toBeNull();
    expect(userTask[1]).toMatch(/^ {4}groups: \[\]$/m);
    expect(userTask[1]).toMatch(/^ {4}append: false$/m);
    expect(agentTasks).not.toMatch(/^\s+- docker\s*$/m);
  });

  it('the proxy is the pinned haproxy image, by digest', () => {
    expect(groupVars).toMatch(/^labs_agent_docker_proxy_image: haproxy$/m);
    expect(groupVars).toMatch(/^labs_agent_docker_proxy_image_tag: "\d+\.\d+\.\d+-alpine"$/m);
    expect(groupVars).toMatch(/^labs_agent_docker_proxy_image_digest: sha256:[0-9a-f]{64}$/m);
  });

  it('the host daemon remaps user namespaces, with the containerd image store off', () => {
    expect(groupVars).toMatch(/^docker_userns_remap: true$/m);
    expect(dockerDefaults).toMatch(/^docker_daemon_userns_config:\n {2}userns-remap: default\n {2}features:\n {4}containerd-snapshotter: false$/m);
    expect(dockerDefaults).toMatch(/^docker_daemon_no_userns_config:\n {2}features:\n {4}containerd-snapshotter: true$/m);
    expect(dockerDefaults).toMatch(/combine\(docker_daemon_userns_config if docker_userns_remap \| bool else docker_daemon_no_userns_config\)/);
  });

  it('the end-of-run checks look at the paths the roles create, not copies that could drift', () => {
    const checks = read(ansible, 'roles', 'privilege_checks', 'defaults', 'main.yml');
    const value = (text, key) => text.match(new RegExp(`^${key}: (.+)$`, 'm'))?.[1].replace(/^"|"$/g, '');
    const sandboxVars = read(ansible, 'roles', 'coder_sandbox', 'vars', 'main.yml');
    const coderDefaults = read(ansible, 'roles', 'coder', 'defaults', 'main.yml');
    const labImagesDefaults = read(ansible, 'roles', 'lab_images', 'defaults', 'main.yml');
    expect(value(checks, 'privilege_checks_agent_socket')).toBe(`${SOCKET_DIR}/docker.sock`);
    expect(value(checks, 'privilege_checks_agent_tmp_dir')).toBe(TMP_DIR);
    expect(value(checks, 'privilege_checks_agent_proxy_container')).toBe(value(agentDefaults, 'labs_agent_docker_proxy_container'));
    const sandboxDir = value(sandboxVars, 'coder_sandbox_socket_dir');
    expect(value(checks, 'privilege_checks_sandbox_socket_dir')).toBe(sandboxDir);
    expect(value(checks, 'privilege_checks_sandbox_docker_host')).toBe(`unix://${sandboxDir}/docker.sock`);
    expect(value(labImagesDefaults, 'lab_images_sandbox_docker_host')).toBe(`unix://${sandboxDir}/docker.sock`);
    expect(value(checks, 'privilege_checks_coder_compose_file')).toBe(
      `${value(coderDefaults, 'coder_project_dir')}/docker-compose.yml`
    );
    expect(value(coderDefaults, 'coder_compose_file')).toBe('{{ coder_project_dir }}/docker-compose.yml');
  });

  it('the site playbook runs the sandbox daemon before Coder, and the checks after everything', () => {
    const site = read(ansible, 'site.yml');
    const roles = [...site.matchAll(/^ {4}- role: (\S+)$/gm)].map((m) => m[1]);
    expect(roles.indexOf('docker')).toBeLessThan(roles.indexOf('coder_sandbox'));
    expect(roles.indexOf('coder_sandbox')).toBeLessThan(roles.indexOf('coder'));
    expect(roles).not.toContain('privilege_checks');
    expect(site).toMatch(/^ {2}post_tasks:\n(?: {4}#.*\n)*? {4}- name: [^\n]+\n {6}ansible\.builtin\.import_role:\n {8}name: privilege_checks$/m);
  });
});
