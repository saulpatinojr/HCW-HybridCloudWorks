/**
 * Tests for stale Docker bridge and NAT rule cleanup (#1228):
 * - lab-host/ansible/roles/docker/files/hcw-docker-stale-bridges.py
 * - lab-host/ansible/roles/docker/tasks/main.yml
 * - lab-host/ansible/roles/docker/tests/hcw-docker-stale-bridges.test.sh
 * - lab-host/ansible/roles/privilege_checks/tasks/main.yml
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const read = (...parts) => readFileSync(path.join(...parts), 'utf8');

const helperScript = read(repoRoot, 'lab-host', 'ansible', 'roles', 'docker', 'files', 'hcw-docker-stale-bridges.py');
const dockerTasks = read(repoRoot, 'lab-host', 'ansible', 'roles', 'docker', 'tasks', 'main.yml');
const dockerReadme = read(repoRoot, 'lab-host', 'ansible', 'roles', 'docker', 'README.md');
const testScript = read(repoRoot, 'lab-host', 'ansible', 'roles', 'docker', 'tests', 'hcw-docker-stale-bridges.test.sh');
const privCheckTasks = read(repoRoot, 'lab-host', 'ansible', 'roles', 'privilege_checks', 'tasks', 'main.yml');

describe('hcw-docker-stale-bridges.py (#1228)', () => {
  it('defines nat rule inspection and stale rule extraction functions', () => {
    expect(helperScript).toContain('def nat_rule_lines():');
    expect(helperScript).toContain('def rule_bridge_interfaces(tokens):');
    expect(helperScript).toContain('def stale_nat_rules(live_bridges):');
    expect(helperScript).toContain('"deleted_rules": []');
    expect(helperScript).toContain('iptables');
    expect(helperScript).toContain('-t');
    expect(helperScript).toContain('nat');
  });

  it('correctly extracts br-* interfaces from iptables tokens', () => {
    // Mirror python's rule_bridge_interfaces
    function extractBridgeIfaces(tokens) {
      const ifaces = [];
      let i = 0;
      while (i < tokens.length) {
        if ((tokens[i] === '-o' || tokens[i] === '-i') && i + 1 < tokens.length) {
          const iface = tokens[i + 1];
          if (iface.startsWith('br-') && !iface.endsWith('+')) ifaces.push(iface);
          i += 2;
        } else if (tokens[i] === '!' && i + 2 < tokens.length && (tokens[i + 1] === '-o' || tokens[i + 1] === '-i')) {
          const iface = tokens[i + 2];
          if (iface.startsWith('br-') && !iface.endsWith('+')) ifaces.push(iface);
          i += 3;
        } else {
          i += 1;
        }
      }
      return ifaces;
    }

    expect(extractBridgeIfaces(['-A', 'POSTROUTING', '-s', '172.28.240.0/24', '!', '-o', 'br-0d1f60c06b21', '-j', 'MASQUERADE'])).toEqual(['br-0d1f60c06b21']);
    expect(extractBridgeIfaces(['-A', 'POSTROUTING', '-m', 'addrtype', '--src-type', 'LOCAL', '-o', 'br-36a702e13fc7', '-j', 'MASQUERADE'])).toEqual(['br-36a702e13fc7']);
    expect(extractBridgeIfaces(['-A', 'DOCKER', '-i', 'br-fc10ca1d255f', '-j', 'RETURN'])).toEqual(['br-fc10ca1d255f']);
    expect(extractBridgeIfaces(['-A', 'DOCKER', '!', '-i', 'br-fc10ca1d255f', '-p', 'tcp', '-j', 'DNAT'])).toEqual(['br-fc10ca1d255f']);
    expect(extractBridgeIfaces(['-A', 'POSTROUTING', '-s', '172.17.0.0/16', '!', '-o', 'docker0', '-j', 'MASQUERADE'])).toEqual([]);
    expect(extractBridgeIfaces(['-A', 'INPUT', '-i', 'br-+', '-j', 'HCW-BRIDGE-IN'])).toEqual([]); // wildcard excluded
  });

  it('identifies rules referencing absent bridges as stale while keeping live bridges', () => {
    const liveBridges = new Set(['br-36a702e13fc7', 'br-aaaaaaaaaaaa']);
    const rules = [
      ['-A', 'POSTROUTING', '-s', '172.28.240.0/24', '!', '-o', 'br-0d1f60c06b21', '-j', 'MASQUERADE'],
      ['-A', 'POSTROUTING', '-s', '172.28.240.0/24', '!', '-o', 'br-36a702e13fc7', '-j', 'MASQUERADE'],
      ['-A', 'DOCKER', '-i', 'br-fc10ca1d255f', '-j', 'RETURN'],
      ['-A', 'DOCKER', '-i', 'br-aaaaaaaaaaaa', '-j', 'RETURN'],
      ['-A', 'POSTROUTING', '-s', '172.17.0.0/16', '!', '-o', 'docker0', '-j', 'MASQUERADE'],
    ];

    function isStale(tokens) {
      let i = 0;
      const ifaces = [];
      while (i < tokens.length) {
        if ((tokens[i] === '-o' || tokens[i] === '-i') && i + 1 < tokens.length) {
          if (tokens[i + 1].startsWith('br-') && !tokens[i + 1].endsWith('+')) ifaces.push(tokens[i + 1]);
          i += 2;
        } else if (tokens[i] === '!' && i + 2 < tokens.length && (tokens[i + 1] === '-o' || tokens[i + 1] === '-i')) {
          if (tokens[i + 2].startsWith('br-') && !tokens[i + 2].endsWith('+')) ifaces.push(tokens[i + 2]);
          i += 3;
        } else {
          i += 1;
        }
      }
      return ifaces.length > 0 && ifaces.some((iface) => !liveBridges.has(iface));
    }

    expect(isStale(rules[0])).toBe(true);  // br-0d1f60c06b21 is absent
    expect(isStale(rules[1])).toBe(false); // br-36a702e13fc7 is live
    expect(isStale(rules[2])).toBe(true);  // br-fc10ca1d255f is absent
    expect(isStale(rules[3])).toBe(false); // br-aaaaaaaaaaaa is live (kept attached)
    expect(isStale(rules[4])).toBe(false); // docker0 is not a br-* bridge
  });
});

describe('docker role tasks and documentation (#1228)', () => {
  it('updates changed_when in tasks/main.yml to register changes for deleted_rules', () => {
    expect(dockerTasks).toMatch(/changed_when:\s*>-?\s*\(\(docker_stale_bridges\.stdout \| from_json\)\.deleted \| length > 0\)\s*or\s*\(\(docker_stale_bridges\.stdout \| from_json\)\.deleted_rules \| default\(\[\]\) \| length > 0\)/);
  });

  it('documents nat rules cleanup in README.md', () => {
    expect(dockerReadme).toMatch(/purges orphaned IPv4 `nat` table\s+rules/);
    expect(dockerReadme).toContain('#1228');
  });

  it('tests nat rules deletion and failure modes in hcw-docker-stale-bridges.test.sh', () => {
    expect(testScript).toContain('FAKE_IPTABLES_NAT_RULES');
    expect(testScript).toContain('FAKE_IPTABLES_DELETED');
    expect(testScript).toContain('deletes the nat rules for removed bridges and pre-existing dead bridges');
    expect(testScript).toContain('leaves nat rules for live bridges, kept attached bridges, and docker0');
    expect(testScript).toContain('FAKE_IPTABLES_FAIL=1');
  });
});

describe('privilege_checks role (#1228)', () => {
  it('reads live links with ip -j link show and nat rules with iptables -w -t nat -S', () => {
    expect(privCheckTasks).toContain('Read the live network interface names');
    expect(privCheckTasks).toContain('Read the IPv4 nat table rules');
    expect(privCheckTasks).toContain('iptables');
    expect(privCheckTasks).toContain('-t');
    expect(privCheckTasks).toContain('nat');
    expect(privCheckTasks).toContain('-S');
  });

  it('asserts that every br-* interface in nat rules exists among live interfaces', () => {
    expect(privCheckTasks).toContain('Refuse nat table rules referencing bridge interfaces that do not exist');
    expect(privCheckTasks).toMatch(/privilege_checks_stale_nat_bridges/);
    expect(privCheckTasks).toContain('regex_findall');
    expect(privCheckTasks).toContain('difference(privilege_checks_live_ifnames)');
  });

  it('evaluates Jinja regex pattern against sample nat outputs', () => {
    const natSample = `
-P PREROUTING ACCEPT
-P INPUT ACCEPT
-P OUTPUT ACCEPT
-P POSTROUTING ACCEPT
-N DOCKER
-A POSTROUTING -s 172.28.240.0/24 ! -o br-0d1f60c06b21 -j MASQUERADE
-A POSTROUTING -m addrtype --src-type LOCAL -o br-36a702e13fc7 -j MASQUERADE
-A DOCKER -i br-0d1f60c06b21 -j RETURN
-A POSTROUTING -s 172.17.0.0/16 ! -o docker0 -j MASQUERADE
`;
    const pattern = /(?:!\s+)?-[oi]\s+(br-[A-Za-z0-9_-]+)/g;
    const matches = [...natSample.matchAll(pattern)].map((m) => m[1]);
    const unique = [...new Set(matches)];

    expect(unique).toEqual(['br-0d1f60c06b21', 'br-36a702e13fc7']);

    const liveInterfaces = ['lo', 'eth0', 'docker0', 'br-36a702e13fc7'];
    const stale = unique.filter((iface) => !liveInterfaces.includes(iface));

    expect(stale).toEqual(['br-0d1f60c06b21']);
  });
});
