/**
 * The host_firewall role's contract (#954, #958; owner decision 2026-10-16),
 * read from its files as text. What the rules do to packets is proved by
 * lab-host/ansible/roles/host_firewall/tests/hcw-host-firewall.test.sh, which
 * loads the rendered files into real iptables in a scratch network
 * namespace; this holds the shape that test was written for, and the parts
 * of the role it cannot run: the chain names and their order, the jumps
 * first in their chains, every range the owner named, the add-ons' rules
 * left alone, the boot unit's ordering and failure report, the removal path,
 * and where the role sits in site.yml.
 *
 * In the CI matrix this runs in the `scripts (operations)` row, whose filter
 * covers lab-host/.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** A repository file as text. */
const read = (relative) => readFileSync(path.join(repoRoot, relative), 'utf8');

const ROLE = 'lab-host/ansible/roles/host_firewall';
const vars = read(`${ROLE}/vars/main.yml`);
const defaults = read(`${ROLE}/defaults/main.yml`);
const specs = read(`${ROLE}/meta/argument_specs.yml`);
const main = read(`${ROLE}/tasks/main.yml`);
const present = read(`${ROLE}/tasks/present.yml`);
const absent = read(`${ROLE}/tasks/absent.yml`);
const rules = read(`${ROLE}/templates/hcw.rules.j2`);
const jumps = read(`${ROLE}/templates/hcw.jumps.j2`);
const unit = read(`${ROLE}/templates/hcw-host-firewall.service.j2`);
const dropin = read(`${ROLE}/templates/user-manager-requires-firewall.conf.j2`);
const helper = read(`${ROLE}/files/hcw-host-firewall`);
const site = read('lab-host/ansible/site.yml');
const ci = read('.github/workflows/ci.yml');

/** The lines of a text that are not comments. */
const code = (text) =>
  text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

/** The YAML list under `key:` (a block of `- item` lines), at any indentation. */
function yamlList(text, key) {
  const match = new RegExp(`^(\\s*)${key}:\\n((?:\\1  - .+\\n)+)`, 'm').exec(text);
  if (!match) throw new Error(`no list ${key}`);
  return match[2].split('\n').filter(Boolean).map((line) => line.replace(/^\s*- /, '').trim());
}

/** A family's block of host_firewall_families in vars/main.yml. */
const family = (name) => {
  const start = vars.indexOf(`  ${name}:\n`);
  const end = vars.indexOf('\n  ipv', start + 1);
  return vars.slice(start, end === -1 ? undefined : end + 1);
};

/** The rules of one chain in the template, without the `-A {{ chain }} ` prefix. */
const chainRules = (name) =>
  rules
    .split('\n')
    .filter((line) => line.startsWith(`-A {{ ${name} }} `))
    .map((line) => line.slice(`-A {{ ${name} }} `.length));

/** Positions in `lines` of the first line containing each needle, in the needles' order. */
const positions = (lines, needles) => needles.map((needle) => lines.findIndex((line) => line.includes(needle)));

const RESERVED_V4 = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  '169.254.0.0/16',
  '0.0.0.0/8',
  '224.0.0.0/4',
  '240.0.0.0/4',
];

describe('host_firewall: the chains', () => {
  it('names the four chains, every one HCW-*, which is all the helper will declare', () => {
    expect(vars).toMatch(/^host_firewall_sandbox_chain: HCW-SANDBOX-OUT$/m);
    expect(vars).toMatch(/^host_firewall_bridge_chain: HCW-BRIDGE-IN$/m);
    expect(vars).toMatch(/^host_firewall_refuse_chain: HCW-REFUSE$/m);
    expect(vars).toMatch(/^host_firewall_control_chain: HCW-CONTROL-OUT$/m);
    expect(rules).toContain(':{{ bridge }} - [0:0]\n:{{ control }} - [0:0]\n:{{ refuse }} - [0:0]\n:{{ sandbox }} - [0:0]\n');
    expect(helper).toContain("chain_shape='^HCW-[A-Z0-9-]+$'");
    expect(helper).toContain('declare HCW-* chains only');
  });

  it('loads them with --noflush, one transaction per family, and flushes or deletes chains only in remove', () => {
    expect(helper).toMatch(/"\$\{ipt\}-restore" -w --noflush <<<"\$\{transactions\[\$1\]\}"/);
    const removal = helper.slice(helper.indexOf('removal() {'), helper.indexOf('\n}\n', helper.indexOf('removal() {')));
    const outside = helper.replace(removal, '');
    expect(removal).toContain('transaction+=$\'\\n\'"-F ${name}"');
    expect(removal).toContain('transaction+=$\'\\n\'"-X ${name}"');
    expect(code(outside)).not.toMatch(/"-[FXZ] |--flush|--delete-chain/);
    expect(removal).toContain('awk \'$1 == "-N" && $2 ~ /^HCW-/ { print $2 }\'');
  });

  it('dry-runs both families before committing either, for apply and for remove', () => {
    expect(helper).toMatch(/"\$\{ipt\}-restore" -w --noflush --test <<<"\$\{transaction\}"/);
    for (const what of ['transaction', 'removal']) {
      const dry = helper.indexOf(`dry_run "\${version}" ${what}`);
      const commit = helper.indexOf(`commit "\${version}" ${what}`);
      expect(dry, what).toBeGreaterThan(0);
      expect(commit, what).toBeGreaterThan(dry);
      // The dry run's loop closes before the commit's begins.
      expect(helper.slice(dry, commit), what).toMatch(/\n\s*done\n(?:[\s\S]*\n)?\s*for version in 4 6; do\n/);
    }
    expect(helper).toContain('a rule jumps to ${BASH_REMATCH[1]}, which the file does not declare');
  });

  it('runs one at a time, under a lock in /run that exists before any unit starts', () => {
    expect(helper).toContain('lock="${HCW_FIREWALL_LOCK:-/run/hcw-host-firewall.lock}"');
    expect(helper).toContain('flock -w "${lock_wait}" 9 ||');
    expect(helper.indexOf('flock -w')).toBeLessThan(helper.indexOf('if [ "${mode}" = remove ]; then'));
    expect(helper).not.toContain('/run/lock/');
  });

  it('refuses every range the owner named, IPv4 and IPv6', () => {
    expect(yamlList(family('ipv4'), 'reserved')).toEqual(RESERVED_V4);
    expect(yamlList(family('ipv6'), 'reserved')).toEqual(['::1/128', 'fc00::/7', 'fe80::/10', 'ff00::/8']);
    expect(rules).toContain('{% for range in family.reserved %}\n-A {{ sandbox }} -d {{ range }} ');
  });

  it('decides the sandbox in this order, so a flow open at the first load to a refused place is cut', () => {
    expect(family('ipv4')).toContain('resolvers: [127.0.0.53]');
    expect(family('ipv6')).toContain('resolvers: []');
    expect(vars).toMatch(/^host_firewall_own_tcp_ports: \[443\]$/m);
    expect(vars).toMatch(/^host_firewall_sandbox_tcp_ports: \[80, 443\]$/m);
    const sandbox = chainRules('sandbox');
    const order = positions(sandbox, [
      '--dport 53 -m comment --comment "hcw: the host resolver" -j RETURN',
      '! -d {{ family.loopback }} -p tcp -m tcp --dport {{ port }} -m addrtype --dst-type LOCAL -m comment --comment "hcw: https to this host" -j RETURN',
      '-m addrtype --dst-type LOCAL -m comment --comment "hcw: host-local, refused" -j {{ refuse }}',
      '-d {{ range }} -m comment --comment "hcw: private or reserved, refused" -j {{ refuse }}',
      '-m conntrack --ctstate RELATED,ESTABLISHED --ctdir REPLY -m comment --comment "hcw: replies" -j RETURN',
      '-p tcp -m multiport --dports {{ host_firewall_sandbox_tcp_ports',
      '-m comment --comment "hcw: refused" -j {{ refuse }}',
    ]);
    expect(order.every((index) => index >= 0), String(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(sandbox.at(-1)).toBe('-m comment --comment "hcw: refused" -j {{ refuse }}');
    expect(sandbox.filter((line) => line.endsWith('-j RETURN'))).toHaveLength(4);
  });

  it("matches the host's own HTTPS by address type, loopback left out, so a change of address needs no run", () => {
    expect(family('ipv4')).toContain('loopback: 127.0.0.0/8');
    expect(family('ipv6')).toContain('loopback: ::1/128');
    expect(present).not.toMatch(/default_ipv4|default_ipv6|own_addresses/);
    expect(rules).not.toMatch(/own_addresses/);
  });

  it('lets containers on the bridges open HTTP and HTTPS to the host and answer it, and refuses the rest', () => {
    expect(vars).toMatch(/^host_firewall_bridge_interfaces: \[docker0, br-\+\]$/m);
    expect(vars).toMatch(/^host_firewall_bridge_tcp_ports: \[80, 443\]$/m);
    const bridge = chainRules('bridge');
    expect(bridge[0]).toContain('--ctstate RELATED,ESTABLISHED');
    expect(bridge.at(-1)).toBe('-m comment --comment "hcw: refused" -j {{ refuse }}');
    expect(family('ipv6')).toContain('neighbour_discovery: [135, 136]');
  });

  it('refuses with a TCP reset for TCP and port-unreachable otherwise, so a refusal is never a wait', () => {
    expect(rules).toContain('-A {{ refuse }} -p tcp -m comment --comment "hcw: refused with a reset" -j REJECT --reject-with tcp-reset\n');
    expect(rules).toContain('-j REJECT --reject-with {{ family.reject_with }}\n');
    expect(family('ipv4')).toContain('reject_with: icmp-port-unreachable');
    expect(family('ipv6')).toContain('reject_with: icmp6-port-unreachable');
    expect(code(rules).match(/-j REJECT/g)).toHaveLength(2);
  });

  it('holds no IPv4 address or range in its files but the resolver and the reserved ranges', () => {
    const files = { vars, defaults, specs, main, present, absent, rules, jumps, unit, dropin, helper };
    const allowed = new Set([...RESERVED_V4, '127.0.0.53']);
    for (const [name, text] of Object.entries(files)) {
      const literals = text.match(/\b\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?\b/g) ?? [];
      expect(literals.filter((literal) => !allowed.has(literal)), name).toEqual([]);
    }
  });
});

describe('host_firewall: the jumps', () => {
  it('jumps from OUTPUT for the sandbox user by name and for all the host sends, and from INPUT for each bridge', () => {
    expect(code(jumps).trim().split('\n')).toEqual([
      '-A OUTPUT -m owner --uid-owner {{ host_firewall_sandbox_user }} -j {{ host_firewall_sandbox_chain }}',
      '-A OUTPUT -j {{ host_firewall_control_chain }}',
      '{% for interface in host_firewall_bridge_interfaces %}',
      '-A INPUT -i {{ interface }} -j {{ host_firewall_bridge_chain }}',
      '{% endfor %}',
    ]);
  });

  it('puts each at position 1, removing every other jump to an HCW-* chain first', () => {
    expect(helper).toContain('fixes+=("-I ${builtin} 1 ${line#-A "${builtin}" }")');
    expect(helper).toContain('for line in "${removals[@]}"; do fixes+=("-D ${line#-A }"); done');
    expect(helper).toContain('for builtin in INPUT FORWARD OUTPUT; do');
    expect(helper).toMatch(/\$\(i \+ 1\) ~ \/\^HCW-\//);
  });

  it('matches the same user the sandbox daemon runs as', () => {
    const sandboxUser = /^coder_sandbox_user: (.+)$/m.exec(read('lab-host/ansible/roles/coder_sandbox/defaults/main.yml'))[1];
    expect(defaults).toMatch(new RegExp(`^host_firewall_sandbox_user: ${sandboxUser}$`, 'm'));
    expect(sandboxUser).toBe('hcw-coder-docker');
  });

  it('takes that user from coder_sandbox_user in group_vars, so the two cannot be set apart', () => {
    const groupVars = read('lab-host/ansible/group_vars/all.yml');
    expect(groupVars).toMatch(/^coder_sandbox_user: hcw-coder-docker$/m);
    expect(groupVars).toMatch(/^host_firewall_sandbox_user: "\{\{ coder_sandbox_user \}\}"$/m);
    expect(code(site)).not.toMatch(/host_firewall_sandbox_user/);
  });

  // The sandbox chain is written for rootlesskit's user-mode network drivers
  // (slirp4netns or pasta). A change of driver changes how the sandbox's
  // traffic leaves the host, so it has to revisit this role, and this test
  // makes that change fail until it does.
  it('keeps the sandbox daemon on the user-mode network driver this role is written for', () => {
    const sandboxUnit = read('lab-host/ansible/roles/coder_sandbox/templates/hcw-coder-docker.service.j2');
    expect(sandboxUnit).toMatch(/^Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_NET=(slirp4netns|pasta)$/m);
  });
});

describe("host_firewall: Coder's internal network", () => {
  const compose = read('lab-host/coder/docker-compose.yml');

  it("lets the host answer connections opened from it, in the reply direction only, and refuses the host's own", () => {
    expect(chainRules('control')).toEqual([
      '-d {{ subnet }} -m conntrack --ctstate RELATED,ESTABLISHED --ctdir REPLY -m comment --comment "hcw: replies on the internal network" -j RETURN',
      '-d {{ subnet }} -m comment --comment "hcw: internal network, refused" -j {{ refuse }}',
    ]);
    expect(rules).toContain('{% for subnet in control_subnets %}\n-A {{ control }}');
    expect(rules).toContain('{% set control_subnets = host_firewall_control_subnets[host_firewall_family_name] %}');
    expect(chainRules('control').join('\n')).not.toMatch(/--uid-owner|--gid-owner/);
  });

  it('reads the subnet at play time, from Docker and from the Compose file', () => {
    expect(vars).toMatch(/^host_firewall_control_network: coder-control$/m);
    expect(vars).toContain('host_firewall_control_compose_file: "{{ role_path }}/../../../coder/docker-compose.yml"');
    expect(present).toMatch(/community\.docker\.docker_network_info:\n\s+name: "\{\{ host_firewall_control_network \}\}"/);
    expect(present).toContain("lookup('ansible.builtin.file', host_firewall_control_compose_file) | from_yaml");
    expect(present).toContain('host_firewall_control_all: "{{ (host_firewall_control_live + host_firewall_control_declared) | unique }}"');
    expect(present).toMatch(/- host_firewall_control_subnets\['ipv4'\] \| length > 0/);
  });

  it('is an internal network of the Compose file, with Coder on it', () => {
    const networks = compose.slice(compose.indexOf('\nnetworks:\n'));
    expect(networks).toMatch(/\n {2}coder-control:\n {4}name: coder-control\n {4}driver: bridge\n {4}internal: true\n {4}ipam:\n {6}config:\n {8}- subnet: /);
    const coder = compose.slice(compose.indexOf('\n  coder:\n'), compose.indexOf('\n  coder-', compose.indexOf('\n  coder:\n') + 1));
    expect(coder).toMatch(/\n {4}networks:\n(?: {6}- .+\n)* {6}- coder-control\n/);
  });
});

describe('host_firewall: what it leaves alone', () => {
  it('never touches DOCKER-USER, ufw rules files or FORWARD', () => {
    for (const [name, text] of Object.entries({ present, absent, rules, jumps, unit })) {
      expect(code(text), name).not.toMatch(/DOCKER-USER|\/etc\/ufw|after\.rules|before\.rules|FORWARD/);
    }
    expect(code(helper)).not.toMatch(/DOCKER-USER|\/etc\/ufw/);
  });

  it("leaves the add-ons' egress rules where #1043 put them", () => {
    const addons = read('lab-host/ansible/roles/addons/tasks/main.yml');
    const after = read('lab-host/ansible/roles/addons/templates/ufw-after-rules.j2');
    expect(addons.match(/chain: DOCKER-USER/g).length).toBeGreaterThanOrEqual(3);
    expect(addons).toContain('marker: "# {mark} ANSIBLE MANAGED BLOCK: hcw-addons egress (roles/addons)"');
    expect(after).not.toMatch(/HCW-/);
    expect(addons).not.toMatch(/HCW-/);
  });
});

describe('host_firewall: at boot', () => {
  it('runs after ufw and before the network, Docker and the sandbox user manager', () => {
    expect(unit).toContain('DefaultDependencies=no\n');
    expect(unit).toContain('After=local-fs.target ufw.service\n');
    expect(unit).toContain('Before=network-pre.target docker.service\n');
    expect(unit).toContain('Type=oneshot\nRemainAfterExit=yes\n');
    expect(unit).toContain('ExecStart={{ host_firewall_script }} apply {{ host_firewall_config_dir }}\n');
    expect(unit).toContain('ExecReload={{ host_firewall_script }} apply {{ host_firewall_config_dir }}\n');
    expect(unit).toContain('RefuseManualStop=yes\n');
    expect(unit).toContain('WantedBy=multi-user.target\n');
    expect(code(unit)).not.toMatch(/ExecStop/);
  });

  it('reports a failure to the notifier alert-lab-unit-failed reads', () => {
    expect(unit).toMatch(/\[Unit\][\s\S]*\nOnFailure=hcw-unit-failed@%n\.service\n[\s\S]*\[Service\]/);
    expect(read('lab-host/ansible/roles/hardening/templates/hcw-unit-failed@.service.j2')).toContain('-t hcw-unit-failed');
  });

  it("makes the sandbox user's manager require it, by the uid read on the host", () => {
    expect(code(dropin)).toContain('[Unit]\nRequires={{ host_firewall_unit }}.service\nAfter={{ host_firewall_unit }}.service\n');
    expect(present).toContain('dest: "/etc/systemd/system/user@{{ host_firewall_sandbox_uid }}.service.d/{{ host_firewall_unit }}.conf"');
    expect(present).toContain("host_firewall_sandbox_uid: \"{{ ansible_facts['getent_passwd'][host_firewall_sandbox_user][1] }}\"");
    expect(code(present)).not.toMatch(/user@\d+|user@\.service\.d/);
  });

  it('is started, never restarted or stopped, by the role', () => {
    expect(code(present)).not.toMatch(/state: (restarted|reloaded)/);
    // The one stop in present.yml is the rescue's, of the sandbox user's manager, never of the unit.
    expect(code(present).match(/state: stopped/g)).toHaveLength(1);
    expect(present).toMatch(/name: "user@\{\{ host_firewall_sandbox_uid \}\}\.service"\n\s+state: stopped/);
    expect(present).toMatch(/name: "\{\{ host_firewall_unit \}\}\.service"\n\s+enabled: true\n\s+state: started/);
  });
});

describe('host_firewall: failing closed', () => {
  const lines = present.split('\n');
  const at = (needle) => lines.findIndex((line) => line.includes(needle));

  it('installs the boot unit and the drop-in before anything that can fail to load, inside the block', () => {
    const order = [
      '- name: Load the host firewall, and stop the sandbox if it cannot be loaded',
      '- name: Install the boot unit that loads the firewall',
      '- name: Make the sandbox user\'s manager require the firewall',
      '- name: Reload systemd, so the requirement holds from the manager\'s next start',
      '- name: Read the host\'s resolver configuration',
      '- name: Read Coder\'s internal network as Docker has it',
      '- name: Load the chains and put the jumps first',
      '- name: Refuse a host whose live firewall differs from what this run loaded',
      '- name: Enable the boot unit',
      '  rescue:',
      '- name: Say what the firewall allows',
    ].map(at);
    expect(order.every((index) => index >= 0), String(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(lines[order[0] + 1]).toBe('  block:');
  });

  it('stops the sandbox user\'s manager only when no loaded firewall governs it, never in check mode, then fails', () => {
    const rescue = present.slice(present.indexOf('  rescue:\n'), present.indexOf('- name: Say what the firewall allows'));
    expect(rescue).toContain("'-A OUTPUT -m owner --uid-owner ' ~ host_firewall_sandbox_uid ~ ' -j ' ~ host_firewall_sandbox_chain");
    expect(rescue).toContain("select('search', ' -j ' ~ host_firewall_refuse_chain ~ '$') | list | length == 2");
    expect(rescue).toMatch(/name: "user@\{\{ host_firewall_sandbox_uid \}\}\.service"\n\s+state: stopped\n\s+when:\n\s+- not ansible_check_mode\n\s+- not host_firewall_rescue_governed \| bool\n/);
    expect(rescue).toMatch(/- name: Fail the play[^\n]*\n\s+ansible\.builtin\.fail:/);
    expect(rescue.indexOf('ansible.builtin.fail:')).toBeGreaterThan(rescue.indexOf('state: stopped'));
    for (const read of rescue.match(/ansible\.builtin\.command:[\s\S]*?check_mode: false/g)) {
      expect(read).toContain('changed_when: false');
      expect(read).toContain('failed_when: false');
    }
  });
});

describe('host_firewall: taking it out', () => {
  it('is a state of the role, present unless asked', () => {
    expect(defaults).toMatch(/^host_firewall_state: present$/m);
    expect(specs).toMatch(/host_firewall_state:\n\s+type: str\n\s+required: false\n\s+default: present\n\s+choices:\n\s+- present\n\s+- absent\n/);
    expect(main).toMatch(/import_tasks: present\.yml\n\s+when: host_firewall_state == 'present'/);
    expect(main).toMatch(/import_tasks: absent\.yml\n\s+when: host_firewall_state == 'absent'/);
  });

  it("removes the user manager's requirement first, then the unit, then the jumps and chains, then the files", () => {
    const steps = positions(absent.split('\n'), [
      '- name: Remove the drop-ins, so no user manager requires the firewall',
      '- name: Reload systemd so the user managers no longer require the firewall',
      '- name: Disable the boot unit',
      '- name: Remove the boot unit',
      '- name: Reload systemd so the boot unit is gone',
      '- name: Stop the boot unit left from before',
      '- name: Delete the jumps, then flush and delete the chains',
      '- name: Remove the helper and the rules files',
      '- name: Refuse to call the firewall removed while any of it is left',
    ]);
    expect(steps.every((index) => index >= 0), String(steps)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    expect(absent).toContain('argv: ["{{ host_firewall_script }}", remove]');
  });
});

describe('host_firewall: in the play', () => {
  it('reads back what it loaded and fails the play on a difference, and is safe in check mode', () => {
    expect(present).toMatch(/- apply\n[\s\S]*?when: not ansible_check_mode/);
    expect(present).toMatch(/- verify\n[\s\S]*?changed_when: ansible_check_mode and host_firewall_verify\.rc != 0\n\s+failed_when: false\n\s+check_mode: false/);
    expect(present).toMatch(/- host_firewall_verify\.rc == 0[\s\S]*?when: not ansible_check_mode/);
  });

  it('runs straight after coder_sandbox and before coder, with its own tag', () => {
    const roles = [...site.matchAll(/^ {4}- role: ([a-z_]+)$/gm)].map((match) => match[1]);
    const at = roles.indexOf('host_firewall');
    expect(at).toBeGreaterThan(0);
    expect(roles[at - 1]).toBe('coder_sandbox');
    expect(roles[at + 1]).toBe('coder');
    expect(site).toContain('    - role: host_firewall\n      tags: [host_firewall]\n');
  });

  it('has its packet test run in CI, as root, with ufw installed and its proof required', () => {
    expect(ci).toContain('sudo apt-get install -y -qq ufw');
    expect(ci).toContain('sudo env "PATH=$PATH" HCW_REQUIRE_UFW=1 bash roles/host_firewall/tests/hcw-host-firewall.test.sh');
  });
});
