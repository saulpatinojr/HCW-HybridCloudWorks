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
  // From post_tasks: after every role and the handlers they notified (a new
  // Caddy route is reloaded before the check fetches through it), after the
  // privilege checks, before the commit record, and whatever the tags.
  it('runs from post_tasks, after the privilege checks and before the commit record, whatever the tags', () => {
    const roles = site.slice(site.indexOf('  roles:'), site.indexOf('  post_tasks:'));
    expect(roles).not.toContain('workspace_reach');
    const post = site.slice(site.indexOf('  post_tasks:'));
    const privilege = post.indexOf("- name: Check the container runtime's privilege separation");
    const task = post.indexOf('- name: Check that a lab workspace reaches Coder and the lab repository');
    const record = post.indexOf('- name: Read the commit this playbook runs from');
    expect(privilege).toBeGreaterThan(-1);
    expect(task).toBeGreaterThan(privilege);
    expect(record).toBeGreaterThan(task);
    expect(post.slice(task, record)).toContain(
      '      tags: [always]\n      ansible.builtin.import_role:\n        name: workspace_reach\n',
    );
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

  it("reads the image's repository and the lab repository from the hcw-lab template, which holds exactly one of each", () => {
    expect(vars).toContain('workspace_reach_template: "{{ role_path }}/../../../coder/templates/hcw-lab/main.tf"');
    const hcwLab = templates.find((t) => t.name === 'hcw-lab').text;
    // The role's two patterns, as JavaScript.
    expect([...hcwLab.matchAll(/^\s*image\s*=\s*"([^"@$]+)@[$][{]local[.]image_digest[}]"\s*$/gm)]).toHaveLength(1);
    expect([...hcwLab.matchAll(/^\s*repo_url\s*=\s*"(https:\/\/[^"]+)"\s*$/gm)]).toHaveLength(1);
    for (const pattern of [
      `regex_findall('(?m)^\\s*image\\s*=\\s*"([^"@$]+)@[$][{]local[.]image_digest[}]"\\s*$')`,
      `regex_findall('(?m)^\\s*repo_url\\s*=\\s*"(https://[^"]+)"\\s*$')`,
    ]) {
      expect(tasks).toContain(pattern);
    }
    // Never a digest in the unit: a narrowed run that moves the pin would
    // leave it naming an image lab_images has removed.
    expect(code(tasks)).not.toContain('image_digest\\s');
  });
});

describe('workspace_reach: the unit and the timer', () => {
  it('runs the script as the sandbox user, sandboxed, and reports a failure to the lab alert', () => {
    expect(unit).toMatch(/^User=\{\{ workspace_reach_user \}\}$/m);
    expect(unit).toMatch(/^OnFailure=hcw-unit-failed@%n\.service$/m);
    expect(unit).toMatch(/^Type=oneshot$/m);
    expect(unit).toContain(
      'ExecStart={{ workspace_reach_script }} {{ workspace_reach_docker_host }} {{ workspace_reach_image_repository }} {{ workspace_reach_coder_url }} {{ workspace_reach_repo_url }}',
    );
    // Its own name in the journal, which the README's and the runbook's
    // commands read with -t.
    expect(unit).toMatch(/^SyslogIdentifier=\{\{ workspace_reach_unit \}\}$/m);
    expect(vars).toMatch(/^workspace_reach_unit: hcw-workspace-reach$/m);
    // Skipped, not failed, once coder_sandbox turns lingering off (Coder off).
    expect(unit).toMatch(/^ConditionPathExists=\/var\/lib\/systemd\/linger\/\{\{ workspace_reach_user \}\}$/m);
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
    // A skipped run is not a pass.
    expect(tasks).toContain("- workspace_reach_condition.stdout | trim == 'yes'");
  });

  it('enables the timer in check mode only where a real run installed it', () => {
    const enable = tasks.slice(tasks.indexOf('- name: Enable the timer'), tasks.indexOf('- name: Run the check once now'));
    expect(tasks.indexOf('- name: Look for the timer')).toBeLessThan(tasks.indexOf('- name: Enable the timer'));
    expect(enable).toContain('- not ansible_check_mode or workspace_reach_timer_file.stat.exists');
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

  it('asks the daemon and finds the image inside each attempt, so a restart is retried, not reported', () => {
    const attempt = script.slice(script.indexOf('attempt_once() {'), script.indexOf('\n}\n', script.indexOf('attempt_once() {')));
    expect(attempt).toContain("docker version --format '{{.Server.Version}}'");
    expect(attempt).toContain('docker image ls --quiet --no-trunc --filter "reference=${repository}"');
    expect(script.indexOf('attempt_once\n')).toBeGreaterThan(script.indexOf('while :; do'));
  });

  it('is tested in CI', () => {
    expect(ci).toContain('run: bash roles/workspace_reach/tests/hcw-workspace-reach.test.sh');
  });
});
