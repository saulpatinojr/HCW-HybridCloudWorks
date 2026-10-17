/**
 * Azure Arc SSH (#953, LAB-7; ADR 0032, amendment of 2026-10-16) is three
 * pieces in three places, and nothing at run time checks one against
 * another until the owner's first connection fails:
 *
 *   - infra/lab-hybrid.tf declares the Arc machine's connectivity endpoint
 *     and its SSH service configuration, the one port the relay may reach;
 *   - the arc role turns the agent's incoming connections on for that port
 *     alone, and must leave the extension allowlist exactly as LAB-6 set it;
 *   - scripts/lab/Connect-Lab.ps1 -Arc names the machine, its group and the
 *     service configuration's api-version.
 *
 * So the port, the names and the version are held together here, with the
 * parts of the decision that are not negotiable: port 22 only, no extension
 * added, the resources gated on the Arc machine existing, and both creates
 * declared for the plan check.
 *
 * In the CI matrix this runs in the `scripts (operations)` row, whose filter
 * covers infra/, lab-host/ and scripts/.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DECLARED } from './assert-expected-plan.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(repoRoot, relative), 'utf8');

const labHybrid = read('infra/lab-hybrid.tf');
const groupVars = read('lab-host/ansible/group_vars/all.yml');
const arcDefaults = read('lab-host/ansible/roles/arc/defaults/main.yml');
const arcVars = read('lab-host/ansible/roles/arc/vars/main.yml');
const arcSpecs = read('lab-host/ansible/roles/arc/meta/argument_specs.yml');
const onboard = read('lab-host/ansible/roles/arc/tasks/onboard.yml');
const connectLab = read('scripts/lab/Connect-Lab.ps1');

/** One top-level block of lab-hybrid.tf, up to its closing brace. */
function block(header) {
  const start = labHybrid.indexOf(header);
  expect(start, `${header} is not in infra/lab-hybrid.tf`).toBeGreaterThanOrEqual(0);
  return labHybrid.slice(start, labHybrid.indexOf('\n}\n', start) + 2);
}

/** A top-level `key: value` from a YAML file, unquoted, ignoring a trailing comment. */
function yamlScalar(text, key) {
  const match = text.match(new RegExp(`^${key}:\\s*"?([^"\\n#]*?)"?\\s*(?:#.*)?$`, 'm'));
  expect(match, `${key} is not set as a plain scalar`).not.toBeNull();
  return match[1];
}

/** A `$name = '<value>'` assignment in Connect-Lab.ps1. */
function psString(name) {
  const match = connectLab.match(new RegExp(`^\\$${name} = '([^']+)'$`, 'm'));
  expect(match, `$${name} is not assigned in scripts/lab/Connect-Lab.ps1`).not.toBeNull();
  return match[1];
}

/** One task of onboard.yml by its name, up to the next task. */
function task(name) {
  const start = onboard.indexOf(`- name: ${name}\n`);
  expect(start, `no task "${name}" in roles/arc/tasks/onboard.yml`).toBeGreaterThanOrEqual(0);
  const next = onboard.indexOf('\n- name: ', start + 1);
  return onboard.slice(start, next < 0 ? undefined : next);
}

const endpoint = block('resource "azapi_resource" "lab_hybrid_arc_connectivity_endpoint"');
const service = block('resource "azapi_resource" "lab_hybrid_arc_ssh_service_configuration"');

describe('the connectivity endpoint and its SSH service configuration (infra/lab-hybrid.tf)', () => {
  it('are the default endpoint on the Arc machine, and one SSH service configuration under it', () => {
    expect(endpoint).toMatch(/^\s*type\s*=\s*"Microsoft\.HybridConnectivity\/endpoints@2024-12-01"$/m);
    expect(endpoint).toMatch(/^\s*name\s*=\s*"default"$/m);
    expect(endpoint).toMatch(/^\s*parent_id\s*=\s*data\.azapi_resource\.lab_hybrid_arc_machine\.id$/m);
    expect(endpoint).toMatch(/^\s*type\s*=\s*"default"$/m);
    expect(service).toMatch(/^\s*type\s*=\s*"Microsoft\.HybridConnectivity\/endpoints\/serviceConfigurations@2024-12-01"$/m);
    expect(service).toMatch(/^\s*name\s*=\s*"SSH"$/m);
    expect(service).toMatch(/^\s*parent_id\s*=\s*azapi_resource\.lab_hybrid_arc_connectivity_endpoint\[0\]\.id$/m);
    expect(service).toMatch(/^\s*serviceName\s*=\s*"SSH"$/m);
  });

  it('let the relay reach port 22 and no other', () => {
    const ports = [...service.matchAll(/^\s*port\s*=\s*(\d+)$/gm)].map((m) => m[1]);
    expect(ports).toEqual(['22']);
  });

  it('plan to nothing while there is no Arc machine, like the vault seal grant', () => {
    for (const body of [endpoint, service]) {
      expect(body).toMatch(/^\s*count\s*=\s*local\.lab_hybrid_arc_principal_id == "" \? 0 : 1$/m);
    }
  });

  it('grant nobody anything: no role assignment names them', () => {
    expect(labHybrid).not.toMatch(/scope\s*=\s*azapi_resource\.lab_hybrid_arc_(connectivity_endpoint|ssh_service_configuration)/);
  });

  it('are no longer declared for the plan check, since their apply (run-b3Wd3pqtJxikRWzu, 2026-10-17)', () => {
    // Declared as creates until the apply, then pruned as the plan check's
    // header asks: a stale create would let a later recreate pass unread.
    const addresses = DECLARED.map((d) => d.address);
    expect(addresses).not.toContain('azapi_resource.lab_hybrid_arc_connectivity_endpoint[0]');
    expect(addresses).not.toContain('azapi_resource.lab_hybrid_arc_ssh_service_configuration[0]');
  });
});

describe('the arc role opens the same port, and nothing else', () => {
  it('turns Arc SSH on by default, through a variable with an argument spec', () => {
    expect(yamlScalar(arcDefaults, 'arc_incoming_ssh_enabled')).toBe('true');
    expect(arcSpecs).toMatch(/^ {6}arc_incoming_ssh_enabled:\n {8}type: bool\n {8}required: false\n {8}default: true\n/m);
  });

  it('admits port 22, the port the service configuration names, and an empty list with Arc SSH off', () => {
    expect(arcVars).toContain(`arc_incoming_ports_wanted: "{{ ['22'] if arc_incoming_ssh_enabled | bool else [] }}"`);
    const set = task('Admit port 22 alone for incoming connections through Arc');
    expect(set).toContain('- incomingconnections.ports\n      - "22"');
    expect(set).toContain('- arc_incoming_ssh_enabled | bool');
    const ports = [...service.matchAll(/^\s*port\s*=\s*(\d+)$/gm)].map((m) => m[1]);
    expect(ports).toEqual(['22']);
  });

  it('reads each setting before it writes, and writes only when it differs', () => {
    for (const key of ['incomingconnections.enabled', 'incomingconnections.ports', 'extensions.allowlist']) {
      expect(onboard).toContain(`- get\n      - ${key}`);
    }
    expect(task('Turn incoming connections through Arc on for Arc SSH, or off without it')).toContain(
      '- arc_incoming_current != arc_incoming_enabled_wanted'
    );
    expect(task('Admit port 22 alone for incoming connections through Arc')).toContain(
      '- arc_ports_current != arc_incoming_ports_wanted'
    );
  });

  it('refuses to turn Arc SSH off while ufw keeps port 22 closed, before any write that would (#953 stage 3)', () => {
    // With 22 closed at ufw, Arc SSH is the only SSH path; a run narrowed to
    // this role's tag would otherwise clear it and strand the host
    // (CodeRabbit on #1258). ufw-closed-ports.test.sh runs the guard against
    // a real ufw.
    const guard = read('lab-host/ansible/roles/arc/tasks/ssh_off_guard.yml');
    const importAt = onboard.indexOf('ansible.builtin.import_tasks: ssh_off_guard.yml');
    expect(importAt, 'onboard.yml does not import ssh_off_guard.yml').toBeGreaterThan(0);
    expect(importAt).toBeLessThan(onboard.indexOf('- name: Turn incoming connections through Arc on for Arc SSH, or off without it'));
    expect(importAt).toBeLessThan(onboard.indexOf('- name: Clear the incoming ports when Arc SSH is off'));
    expect(guard).toContain('- not (arc_incoming_ssh_enabled | bool)');
    expect(guard).toContain("- arc_incoming_current == 'true'");
    expect(guard).toContain("- \"'22' in arc_ports_current\"");
    expect(guard).toContain('- not ansible_check_mode');
    // Read conservatively (CodeRabbit on #1261): an installed ufw must answer,
    // any DENY or REJECT naming 22 refuses, and only a general allow counts.
    expect(guard).toContain('not arc_ufw_bin.stat.exists');
    expect(guard).toContain('or (arc_ufw_status.rc == 0');
    expect(guard).toContain('(arc_ufw_admits_22 and not arc_ufw_denies_22)');
    expect(guard).toContain('+(DENY|REJECT)');
    expect(guard).toContain('+(ALLOW|LIMIT)( IN)? +Anywhere *$');
    expect(yamlScalar(arcDefaults, 'arc_ufw_path')).toBe('/usr/sbin/ufw');
  });

  it('is turned off with port 22 reopened in the same run, by the hardening role that runs first', () => {
    const groupVarsText = read('lab-host/ansible/group_vars/all.yml');
    expect(groupVarsText).toContain('hardening_arc_ssh_wanted: "{{ arc_incoming_ssh_enabled | default(true) }}"');
    const site = read('lab-host/ansible/site.yml');
    expect(site.indexOf('- role: hardening')).toBeLessThan(site.indexOf('- role: arc'));
    expect(read('lab-host/ansible/roles/hardening/tasks/ufw.yml')).toContain(
      "{{ 'open' if not (hardening_arc_ssh_wanted | bool)"
    );
  });

  it('reads the settings in check mode too, and reports a difference there as a changed task the nightly drift check counts', () => {
    // hcw-playbook-drift (LAB-4) runs the play with --check --diff and counts
    // changed tasks as drift. Skipped reads made the agent's lockdown
    // invisible to it; a failed task would stop the check at this role and
    // hide drift in every role after it.
    for (const name of [
      "Read the Arc agent's extension allowlist",
      'Read whether incoming connections through Arc are enabled',
      'Read the ports incoming connections through Arc may reach',
      'Read whether guest configuration is enabled on the Arc agent',
    ]) {
      const read = task(name);
      expect(read, name).toMatch(/^ {2}check_mode: false$/m);
      expect(read, name).toMatch(/^ {2}changed_when: false$/m);
      expect(read, name).not.toContain('ansible_check_mode');
    }
    expect(task('Reduce the four readings to comparable values')).not.toContain('ansible_check_mode');
    const report = task("Report Arc agent settings that differ from this role's (check mode)");
    expect(report).toContain('ansible.builtin.debug:');
    expect(report).toMatch(/^ {2}changed_when: true$/m);
    expect(report).toContain('    - ansible_check_mode\n');
    for (const difference of [
      'arc_allowlist_current != arc_allowlist_wanted',
      'arc_incoming_current != arc_incoming_enabled_wanted',
      'arc_ports_current != arc_incoming_ports_wanted',
      "arc_guestconfig_current != 'false'",
    ]) {
      expect(report).toContain(difference);
    }
    // The writes stay out of check mode, where they could not run anyway.
    for (const name of [
      'Allow only the Azure Monitor Agent extension',
      'Admit port 22 alone for incoming connections through Arc',
      'Turn incoming connections through Arc on for Arc SSH, or off without it',
      'Clear the incoming ports when Arc SSH is off',
      'Turn off guest configuration on the Arc agent',
    ]) {
      expect(task(name), name).toContain('- not ansible_check_mode');
    }
  });

  it('leaves the extension allowlist as LAB-6 set it, and fails closed if it reads back anything else', () => {
    expect(yamlScalar(arcDefaults, 'arc_extensions_allowlist')).toBe('Microsoft.Azure.Monitor/AzureMonitorLinuxAgent');
    const assertion = task('Assert the extension allowlist is unchanged and incoming connections reach port 22 alone');
    expect(assertion).toContain('- arc_allowlist_after == arc_allowlist_wanted');
    expect(assertion).toContain('- arc_ports_after == arc_incoming_ports_wanted');
    expect(assertion).toContain('- arc_incoming_after == arc_incoming_enabled_wanted');
    // The read-back comes after every write of the three settings.
    const readBack = onboard.indexOf('- name: Read the extension allowlist and the incoming-connection settings back');
    for (const write of [
      '- name: Allow only the Azure Monitor Agent extension',
      '- name: Admit port 22 alone for incoming connections through Arc',
      '- name: Turn incoming connections through Arc on for Arc SSH, or off without it',
      '- name: Clear the incoming ports when Arc SSH is off',
    ]) {
      const at = onboard.indexOf(write);
      expect(at, write).toBeGreaterThan(0);
      expect(at, write).toBeLessThan(readBack);
    }
  });
});

describe('Connect-Lab.ps1 -Arc names the same machine', () => {
  it('in the same group, as the Arc role onboards it and infra/ reads it', () => {
    expect(psString('arcResourceGroup')).toBe(yamlScalar(groupVars, 'arc_resource_group'));
    expect(psString('arcMachineName')).toBe(yamlScalar(groupVars, 'arc_resource_name'));
    const arc = block('data "azapi_resource" "lab_hybrid_arc_machine"');
    expect(arc).toContain('/resourceGroups/rg-lab-hybrid-${var.environment}-${var.region_abbreviation}/');
    expect(arc).toContain('/machines/arcs-lab-hybrid-${var.environment}-${var.region_abbreviation}-01"');
  });

  it('reads the service configuration at the api-version infra/ writes it with', () => {
    expect(connectLab).toContain('/providers/Microsoft.HybridConnectivity/endpoints/default/serviceConfigurations/SSH?api-version=2024-12-01');
  });

  it('tells the owner to install the az ssh extension, in those words, when it is missing', () => {
    expect(connectLab).toContain("Command = 'az extension add --name ssh'");
  });
});
