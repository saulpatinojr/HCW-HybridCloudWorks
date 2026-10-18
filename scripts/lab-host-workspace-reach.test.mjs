/**
 * A lab workspace's DNS and its first minute (#1267), read from the files as
 * text. On 2026-10-17 every Coder workspace started its container and then
 * never connected: the Terraform docker provider creates each one on the
 * sandbox daemon's default bridge and moves it afterwards, so it kept
 * systemd-resolved's upstream servers, which the host firewall's sandbox chain
 * refuses. What the script does is proved by
 * lab-host/ansible/roles/workspace_reach/tests/hcw-workspace-reach.test.sh;
 * this holds the parts around it:
 *
 *   - the sandbox daemon gives every container slirp4netns's forwarder, the
 *     path to the one resolver the firewall allows, and the role checks it
 *     against rootlesskit;
 *   - no template overrides that;
 *   - the workspace_reach role runs after everything a workspace needs, as
 *     the sandbox user, through a unit that reports a failure, and reads the
 *     image and repository the way lab_images does;
 *   - its URL is Coder's access URL.
 *
 * In the CI matrix this runs in the `scripts (operations)` row, whose filter
 * covers lab-host/.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** A repository file as text. */
const read = (relative) => readFileSync(path.join(repoRoot, relative), 'utf8');

/** The lines of a text that are not comments. */
const code = (text) =>
  text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

const ROLE = 'lab-host/ansible/roles/workspace_reach';
const site = read('lab-host/ansible/site.yml');
const groupVars = read('lab-host/ansible/group_vars/all.yml');
const compose = read('lab-host/coder/docker-compose.yml');
const sandboxVars = read('lab-host/ansible/roles/coder_sandbox/vars/main.yml');
const sandboxTasks = read('lab-host/ansible/roles/coder_sandbox/tasks/main.yml');
const sandboxUnit = read('lab-host/ansible/roles/coder_sandbox/templates/hcw-coder-docker.service.j2');
const firewallVars = read('lab-host/ansible/roles/host_firewall/vars/main.yml');
const defaults = read(`${ROLE}/defaults/main.yml`);
const vars = read(`${ROLE}/vars/main.yml`);
const tasks = read(`${ROLE}/tasks/main.yml`);
const unit = read(`${ROLE}/templates/hcw-workspace-reach.service.j2`);
const timer = read(`${ROLE}/templates/hcw-workspace-reach.timer.j2`);
const script = read(`${ROLE}/files/hcw-workspace-reach`);
const ci = read('.github/workflows/ci.yml');

const TEMPLATES = 'lab-host/coder/templates';
const templates = readdirSync(path.join(repoRoot, TEMPLATES), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({ name: entry.name, text: read(`${TEMPLATES}/${entry.name}/main.tf`) }));

describe("the sandbox's DNS (#1267)", () => {
  it("gives every container slirp4netns's forwarder, from the daemon, not per template", () => {
    expect(sandboxVars).toMatch(/^coder_sandbox_dns: 10\.0\.2\.3$/m);
    expect(code(sandboxVars)).toMatch(/^ {2}dns:\n {4}- "\{\{ coder_sandbox_dns \}\}"$/m);
    // 10.0.2.3 is slirp4netns's forwarder; another driver puts it elsewhere.
    expect(sandboxUnit).toMatch(/^Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_NET=slirp4netns$/m);
  });

  it('checks the forwarder against rootlesskit after every start', () => {
    const lookup = sandboxTasks.indexOf("- name: Read the sandbox network's DNS forwarder from rootlesskit");
    const refuse = sandboxTasks.indexOf('- name: Refuse a sandbox network whose DNS forwarder is not the nameserver workspaces are given');
    expect(lookup).toBeGreaterThan(sandboxTasks.indexOf('- name: Refuse a sandbox daemon that is not rootless'));
    expect(refuse).toBeGreaterThan(lookup);
    expect(sandboxTasks).toContain('unix_socket: "{{ coder_sandbox_rootlesskit_api }}"');
    expect(sandboxTasks).toContain('url: http://rootlesskit/v1/info');
    expect(sandboxTasks).toContain('- coder_sandbox_rootlesskit_dns == [coder_sandbox_dns]');
    expect(sandboxVars).toContain('coder_sandbox_rootlesskit_api: "/run/user/{{ coder_sandbox_uid }}/dockerd-rootless/api.sock"');
  });

  it('reaches the one resolver the firewall lets the sandbox reach', () => {
    // slirp4netns answers 10.0.2.3 by asking /etc/resolv.conf's nameserver,
    // which host_firewall holds to the stub.
    expect(firewallVars).toContain('resolvers: [127.0.0.53]');
  });

  it('is not overridden by any template, so the daemon default holds for every lab', () => {
    expect(templates.map((t) => t.name)).toEqual(expect.arrayContaining(['hcw-lab', 'amo-guided-lab', 'na-guided-lab']));
    for (const { name, text } of templates) {
      expect(code(text), name).not.toMatch(/^\s*(dns|dns_opts|dns_search)\s*=/m);
    }
  });
});

describe('workspace_reach: where it runs and as whom', () => {
  it('runs after everything a workspace needs, and before the add-ons', () => {
    const roles = [...site.matchAll(/^ {4}- role: ([a-z_]+)$/gm)].map((m) => m[1]);
    const at = (name) => roles.indexOf(name);
    expect(at('workspace_reach')).toBeGreaterThan(-1);
    for (const before of ['coder_sandbox', 'host_firewall', 'caddy', 'coder', 'lab_images']) {
      expect(at('workspace_reach'), before).toBeGreaterThan(at(before));
    }
    expect(at('workspace_reach')).toBe(at('lab_images') + 1);
    expect(site).toContain('    - role: workspace_reach\n      tags: [workspace_reach]\n');
  });

  it('is on with Coder, as the sandbox user, aimed at Coder\'s access URL', () => {
    expect(groupVars).toMatch(/^workspace_reach_enabled: "\{\{ coder_enabled \}\}"$/m);
    expect(groupVars).toMatch(/^workspace_reach_user: "\{\{ coder_sandbox_user \}\}"$/m);
    expect(groupVars).toMatch(/^workspace_reach_coder_url: "https:\/\/\{\{ coder_domain \}\}"$/m);
    const access = /^\s*CODER_ACCESS_URL: "([^"]+)"$/m.exec(compose)[1];
    expect(defaults).toContain(`workspace_reach_coder_url: ${access}`);
    expect(defaults).toMatch(/^workspace_reach_user: hcw-coder-docker$/m);
    expect(groupVars).toMatch(/^coder_sandbox_user: hcw-coder-docker$/m);
    expect(defaults).toContain('workspace_reach_docker_host: unix:///run/hcw-coder-docker/docker.sock');
  });

  it('reads the image and repository from the hcw-lab template, which holds exactly one of each', () => {
    expect(vars).toContain('workspace_reach_template: "{{ role_path }}/../../../coder/templates/hcw-lab/main.tf"');
    const hcwLab = templates.find((t) => t.name === 'hcw-lab').text;
    // The role's three patterns, as JavaScript.
    expect([...hcwLab.matchAll(/^\s*image_digest\s*=\s*"(sha256:[0-9a-f]{64})"\s*$/gm)]).toHaveLength(1);
    expect([...hcwLab.matchAll(/^\s*image\s*=\s*"([^"@$]+)@[$][{]local[.]image_digest[}]"\s*$/gm)]).toHaveLength(1);
    expect([...hcwLab.matchAll(/^\s*repo_url\s*=\s*"(https:\/\/[^"]+)"\s*$/gm)]).toHaveLength(1);
    for (const pattern of [
      `regex_findall('(?m)^\\s*image_digest\\s*=\\s*"(sha256:[0-9a-f]{64})"\\s*$')`,
      `regex_findall('(?m)^\\s*image\\s*=\\s*"([^"@$]+)@[$][{]local[.]image_digest[}]"\\s*$')`,
      `regex_findall('(?m)^\\s*repo_url\\s*=\\s*"(https://[^"]+)"\\s*$')`,
    ]) {
      expect(tasks).toContain(pattern);
    }
  });
});

describe('workspace_reach: the unit and the timer', () => {
  it('runs the script as the sandbox user, sandboxed, and reports a failure to the lab alert', () => {
    expect(unit).toMatch(/^User=\{\{ workspace_reach_user \}\}$/m);
    expect(unit).toMatch(/^OnFailure=hcw-unit-failed@%n\.service$/m);
    expect(unit).toMatch(/^Type=oneshot$/m);
    expect(unit).toContain(
      'ExecStart={{ workspace_reach_script }} {{ workspace_reach_docker_host }} {{ workspace_reach_image }} {{ workspace_reach_coder_url }} {{ workspace_reach_repo_url }}',
    );
    for (const line of ['ProtectSystem=strict', 'ProtectHome=true', 'PrivateTmp=true', 'NoNewPrivileges=true']) {
      expect(unit).toMatch(new RegExp(`^${line}$`, 'm'));
    }
  });

  it('runs every interval after a delay at boot', () => {
    expect(timer).toMatch(/^OnBootSec=\{\{ workspace_reach_boot_delay \}\}$/m);
    expect(timer).toMatch(/^OnUnitActiveSec=\{\{ workspace_reach_interval \}\}$/m);
    expect(defaults).toMatch(/^workspace_reach_interval: 15min$/m);
  });

  it('enables the timer before the play runs the check, and runs it through the unit', () => {
    const enable = tasks.indexOf('- name: Enable the timer');
    const run = tasks.indexOf('- name: Run the check once now, as the timer runs it');
    const refuse = tasks.indexOf('- name: Refuse a host where a workspace cannot reach Coder or the lab repository');
    expect(enable).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(enable);
    expect(refuse).toBeGreaterThan(run);
    expect(tasks.slice(run, refuse)).toContain('- start\n      - "{{ workspace_reach_unit }}.service"');
    expect(tasks.slice(refuse)).toContain('- workspace_reach_run.rc == 0');
  });
});

describe('workspace_reach: the script', () => {
  it('creates its container the way the provider creates a workspace, never with docker run', () => {
    expect(code(script)).not.toMatch(/docker run\b/);
    expect(script).toContain('docker create --name "${container}" --network bridge --pull never');
    expect(script).toContain('docker network disconnect bridge "${container}"');
    expect(script).toContain('docker network connect "${network}" "${container}"');
    expect(script).toContain('docker start --attach "${container}"');
    expect(code(script)).not.toMatch(/--dns\b/);
  });

  it('is tested in CI', () => {
    expect(ci).toContain('run: bash roles/workspace_reach/tests/hcw-workspace-reach.test.sh');
  });
});
