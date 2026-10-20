/**
 * The Terraform the Landing Zone Builder emits (#667): what each file says
 * for a given selection, and the committed snapshots of the default and
 * tree-only builds, so a change to any emitted line is reviewed as a diff of
 * the Terraform, not of the emitter. The file-by-file shape checks and the
 * provider maps of every module block are in hcl.providers.test.js.
 */
import { describe, it, expect } from 'vitest';
import {
  AVM_MODULES,
  BASELINE_ASSIGNMENTS,
  DEFAULT_STATE,
  HUB_PREFIX_RANGE,
  groupsAssigning,
  POLICY_DEFAULTS,
  SPOKE_PREFIX_RANGE,
  emitFiles,
} from './index';

const byPath = (files) => Object.fromEntries(files.map((f) => [f.path, f.content]));

describe('emitFiles', () => {
  it('emits only the files whose components are selected', () => {
    const paths = (state) => emitFiles(state).map((f) => f.path);
    expect(paths(DEFAULT_STATE)).toEqual([
      'terraform.tf',
      'providers.tf',
      'alz.tf',
      'subscriptions.tf',
      'management.tf',
      'connectivity.tf',
      'identity.tf',
      'application.tf',
      'variables.tf',
      'terraform.tfvars.example',
      'README.md',
    ]);
    expect(paths({ selected: [] })).toEqual(['README.md']);
    expect(paths({ selected: ['management-groups'] })).toEqual([
      'terraform.tf',
      'providers.tf',
      'alz.tf',
      'variables.tf',
      'terraform.tfvars.example',
      'README.md',
    ]);
    expect(paths({ selected: ['firewall'] })).toEqual([
      'terraform.tf',
      'providers.tf',
      'alz.tf',
      'subscriptions.tf',
      'connectivity.tf',
      'variables.tf',
      'terraform.tfvars.example',
      'README.md',
    ]);
    const identity = paths({ selected: ['identity'] });
    expect(identity).toContain('identity.tf');
    expect(identity).toContain('connectivity.tf');
    expect(identity).not.toContain('application.tf');
    expect(paths({ options: { onlineCount: 0 } })).toContain('application.tf');
  });

  it('turns the options into the modules’ current inputs', () => {
    const full = byPath(emitFiles(DEFAULT_STATE));
    expect(full['alz.tf']).toContain('architecture_name  = "alz"');
    expect(full['alz.tf']).toContain(
      'parent_resource_id = coalesce(var.parent_management_group_id, data.azapi_client_config.current.tenant_id)'
    );
    expect(full['alz.tf']).toContain('management_group_name = "corp"');
    expect(full['alz.tf']).toContain('subscription_id       = var.online_subscription_ids[0]');
    expect(full['alz.tf']).toContain('subscription_id       = var.identity_subscription_id');
    expect(full['alz.tf']).toContain('module.alz.management_group_resource_ids["alz"]');
    expect(full['management.tf']).toContain(
      'log_analytics_workspace_name = local.log_analytics_workspace_name'
    );
    expect(full['connectivity.tf']).toContain('default_hub_address_space = var.hub_address_space');
    expect(full['connectivity.tf']).toContain('sku_tier = "Standard"');
    expect(full['connectivity.tf']).toContain('private_dns_zones                     = true');
    expect(full['variables.tf']).toContain('default     = "10.0.0.0/16"');
    expect(full['variables.tf']).toContain('default     = "10.1.0.0/16"');
    expect(full['variables.tf']).toContain('default     = "centralus"');
    expect(full['variables.tf']).toContain('default     = null');
    expect(full['providers.tf']).toContain('ref  = "2026.08.1"');
    expect(full['providers.tf']).toContain('alias           = "corp_1"');
    expect(full['providers.tf']).toMatch(/provider "azapi" \{\n  alias           = "online_1"/);
    expect(full['terraform.tf']).toContain('required_version = ">= 1.12, < 2.0"');
    for (const provider of ['alz', 'azapi', 'azurerm', 'modtm', 'random', 'time']) {
      expect(full['terraform.tf']).toMatch(new RegExp(`^    ${provider} = \\{$`, 'm'));
    }
    for (const provider of ['random', 'modtm', 'time']) {
      expect(full['providers.tf']).toContain(`\nprovider "${provider}" {}\n`);
    }
    expect(full['README.md']).toContain('never been applied by HybridCloudWorks');
    expect(full['README.md']).toContain('HCP Terraform');
    expect(full['README.md']).toContain('tenant');
    expect(full['README.md']).toContain('service principal');
    expect(full['README.md']).toContain('spoke virtual network');
    expect(full['terraform.tfvars.example']).not.toContain('parent_management_group_id');

    const custom = byPath(
      emitFiles({
        options: {
          hubCidr: '10.42.0.0/16',
          spokeCidr: '10.43.0.0/16',
          firewallSku: 'Premium',
          privateDnsZones: false,
          location: 'westeurope',
          corpCount: 2,
          onlineCount: 0,
          rootParentId: 'contoso',
        },
      })
    );
    expect(custom['connectivity.tf']).toContain('sku_tier = "Premium"');
    expect(custom['connectivity.tf']).toContain('sku = "Premium"');
    expect(custom['connectivity.tf']).toContain('private_dns_zones                     = false');
    expect(custom['variables.tf']).toContain('default     = "10.42.0.0/16"');
    expect(custom['variables.tf']).toContain('default     = "10.43.0.0/16"');
    expect(custom['variables.tf']).toContain('default     = "westeurope"');
    expect(custom['variables.tf']).toContain('default     = "contoso"');
    expect(custom['variables.tf']).toContain('length(var.corp_subscription_ids) == 2');
    expect(custom['variables.tf']).not.toContain('online_subscription_ids');
    expect(custom['application.tf']).toContain('module "spoke_corp_2"');
    expect(custom['application.tf']).not.toContain('online_1');
    expect(custom['application.tf']).not.toContain('spoke_online');
    expect(custom['terraform.tfvars.example']).toMatch(/parent_management_group_id\s+= "contoso"/);
    expect(custom['terraform.tfvars.example']).toContain(
      'corp_subscription_ids        = ["00000000-0000-0000-0000-000000000011", "00000000-0000-0000-0000-000000000012"]'
    );
    expect(custom['terraform.tfvars.example']).toContain(
      'management_subscription_id   = "00000000-0000-0000-0000-000000000001"'
    );

    const noFirewall = byPath(emitFiles({ selected: ['connectivity-hub'] }));
    expect(noFirewall['connectivity.tf']).toContain(
      'firewall                              = false'
    );
    expect(noFirewall['connectivity.tf']).not.toContain('sku_tier');
    expect(noFirewall['alz.tf']).not.toContain('policy_assignments_dependencies');
  });

  it('builds a spoke per landing zone: a /24, a two-way hub peering, and a firewall route only where private', () => {
    const full = byPath(emitFiles(DEFAULT_STATE));
    const app = full['application.tf'];
    expect(app).toContain('corp_1   = cidrsubnet(var.spoke_address_space, 8, 0)');
    expect(app).toContain('online_1 = cidrsubnet(var.spoke_address_space, 8, 128)');
    expect(app).toContain(
      '# For 10.1.0.0/16 that is corp_1 = 10.1.0.0/24, online_1 = 10.1.128.0/24.'
    );
    expect(app).toContain('resource "azurerm_resource_group" "spoke_corp_1"');
    expect(app).toContain('resource "azurerm_route_table" "spoke_corp_1"');
    expect(app).not.toContain('resource "azurerm_route_table" "spoke_online_1"');
    expect(app).toContain(
      'next_hop_in_ip_address = module.connectivity.firewall_private_ip_addresses["primary"]'
    );
    expect(app).toContain('bgp_route_propagation_enabled = false');
    expect(app).toContain('module "spoke_corp_1"');
    expect(app).toContain('module "spoke_online_1"');
    expect(app).toContain('parent_id        = azurerm_resource_group.spoke_corp_1.id');
    expect(app).toContain('address_space    = [local.spoke_address_spaces.corp_1]');
    expect(app).toContain(
      'remote_virtual_network_resource_id = module.connectivity.virtual_network_resource_ids["primary"]'
    );
    expect(app).toContain('create_reverse_peering             = true');
    expect(app).toContain('reverse_name                       = "peer-hub-to-online-1"');
    expect(app).toMatch(
      /providers = \{\n    azapi  = azapi\.corp_1\n    modtm  = modtm\n    random = random\n  \}/
    );
    expect(app).not.toContain('resource_group_name = "');

    const identity = full['identity.tf'];
    expect(identity).toContain(
      'identity_address_space = cidrsubnet(var.spoke_address_space, 8, 127)'
    );
    expect(identity).toContain('(10.1.127.0/24 for 10.1.0.0/16)');
    expect(identity).toContain('resource "azurerm_route_table" "spoke_identity"');
    expect(identity).toContain('module "spoke_identity"');

    const noFirewall = byPath(emitFiles({ selected: ['identity', 'corp'] }));
    expect(noFirewall['identity.tf']).not.toContain('azurerm_route_table');
    expect(noFirewall['application.tf']).not.toContain('azurerm_route_table');
    expect(noFirewall['application.tf']).not.toContain('route_table');

    const five = byPath(
      emitFiles({ options: { corpCount: 5, onlineCount: 5, spokeCidr: '10.8.0.0/20' } })
    );
    expect(five['application.tf']).toContain(
      'corp_5   = cidrsubnet(var.spoke_address_space, 4, 4)'
    );
    expect(five['application.tf']).toContain(
      'online_5 = cidrsubnet(var.spoke_address_space, 4, 12)'
    );
    expect(five['identity.tf']).toContain('cidrsubnet(var.spoke_address_space, 4, 7)');
    expect(five['variables.tf']).toContain('length(var.online_subscription_ids) == 5');
  });

  it('supplies every policy default the pinned library declares, or stops enforcing its assignment', () => {
    const names = POLICY_DEFAULTS.map((d) => d.name);
    expect(names).toEqual([
      'private_dns_zone_subscription_id',
      'private_dns_zone_resource_group_name',
      'private_dns_zone_region',
      'ama_user_assigned_managed_identity_id',
      'ama_user_assigned_managed_identity_name',
      'ama_vm_insights_data_collection_rule_id',
      'ama_mdfc_sql_data_collection_rule_id',
      'ama_change_tracking_data_collection_rule_id',
      'ddos_protection_plan_id',
      'log_analytics_workspace_id',
      'resource_group_location',
      'resource_group_name_service_health_alerts',
      'resource_group_name_mdfc',
      'email_security_contact',
    ]);

    const full = byPath(emitFiles(DEFAULT_STATE))['alz.tf'];
    for (const name of names.filter((n) => n !== 'ddos_protection_plan_id')) {
      expect(full, name).toMatch(new RegExp(`^    ${name}\\s+= jsonencode\\(\\{ value = `, 'm'));
    }
    expect(full).not.toMatch(/^\s*ddos_protection_plan_id\s+=/m);
    expect(full).toContain('Enable-DDoS-VNET');
    expect(full).not.toContain('Deploy-Private-DNS-Zones');
    expect(full).toMatch(
      /private_dns_zone_resource_group_name\s+= jsonencode\(\{ value = azurerm_resource_group\.connectivity\.name \}\)/
    );
    expect(full).toContain('email_security_contact');
    expect(full).toContain(
      '"Microsoft.OperationalInsights/workspaces", [local.log_analytics_workspace_name]'
    );
    expect(full).toContain('module.management.resource_id');
    expect(full).not.toContain('replace_me');
    expect(full).not.toContain('00000000-0000-0000-0000-000000000000');

    const noDns = byPath(emitFiles({ options: { privateDnsZones: false } }))['alz.tf'];
    expect(noDns).toContain('Deploy-Private-DNS-Zones');
    expect(noDns).not.toContain('private_dns_zone_subscription_id');
    expect(noDns).toMatch(
      /corp = \{\n      policy_assignments = \{\n        "Deploy-Private-DNS-Zones" = \{/
    );

    const notEnforced = (text) => (text.match(/enforcement_mode = "DoNotEnforce"/g) ?? []).length;
    const baselineCount = Object.values(BASELINE_ASSIGNMENTS).reduce((n, a) => n + a.length, 0);
    expect(baselineCount).toBe(123);
    expect(BASELINE_ASSIGNMENTS.alz).toHaveLength(17);
    expect(BASELINE_ASSIGNMENTS.platform).toHaveLength(40);
    expect(BASELINE_ASSIGNMENTS.landingzones).toHaveLength(53);
    expect(Object.keys(BASELINE_ASSIGNMENTS)).toEqual([
      'alz',
      'platform',
      'landingzones',
      'corp',
      'local',
      'sandbox',
      'connectivity',
      'identity',
      'decommissioned',
    ]);
    const ddosGroups = groupsAssigning('Enable-DDoS-VNET');
    expect(ddosGroups).toEqual(['landingzones', 'connectivity']);
    expect(groupsAssigning('Deploy-Private-DNS-Zones')).toEqual(['corp']);
    expect(groupsAssigning('Nope')).toEqual([]);
    expect(notEnforced(full)).toBe(ddosGroups.length);
    expect((full.match(/"Enable-DDoS-VNET" = \{/g) ?? []).length).toBe(ddosGroups.length);
    for (const group of ddosGroups) {
      expect(full, group).toMatch(
        new RegExp(
          `^    ${group} = \\{\n      policy_assignments = \\{\n        "Enable-DDoS-VNET" = \\{`,
          'm'
        )
      );
    }
    expect(notEnforced(noDns)).toBe(ddosGroups.length + 1);

    const idCalls = full.match(/provider::azapi::resource_group_resource_id\(/g) ?? [];
    const listShaped =
      full.match(
        /provider::azapi::resource_group_resource_id\([^,()]+, [^,()]+, "[^"]+", \[[^\]]+\]\)/g
      ) ?? [];
    expect(idCalls.length).toBe(5);
    expect(listShaped.length).toBe(idCalls.length);

    const treeOnly = byPath(emitFiles({ selected: ['management-groups'] }));
    expect(treeOnly['alz.tf']).toContain('Policy was not selected');
    expect(notEnforced(treeOnly['alz.tf'])).toBe(baselineCount);
    for (const [group, assignments] of Object.entries(BASELINE_ASSIGNMENTS)) {
      expect(treeOnly['alz.tf'], group).toMatch(new RegExp(`^    ${group} = \\{$`, 'm'));
      for (const a of assignments) {
        expect(treeOnly['alz.tf'], `${group}/${a}`).toMatch(
          new RegExp(`^        "${a}" = \\{$`, 'm')
        );
      }
    }
    expect(treeOnly['alz.tf']).not.toContain('policy_assignments_dependencies');
    expect(treeOnly['alz.tf']).not.toContain('module.management');
    // Every hyphenated key is quoted; every plain-identifier key is bare.
    expect(treeOnly['alz.tf']).not.toMatch(/^\s+[A-Za-z0-9_]*-[A-Za-z0-9_-]*\s+=/m);
    expect((treeOnly['alz.tf'].match(/^\s+"[^"]+" = \{$/gm) ?? []).length).toBe(baselineCount);
    expect(treeOnly['alz.tf']).not.toMatch(/^\s+"[a-z_0-9]+" = /m);
    expect(treeOnly['alz.tf']).toMatch(/policy_default_values = \{\n    resource_group_location/);
    for (const name of [
      'resource_group_location',
      'resource_group_name_service_health_alerts',
      'resource_group_name_mdfc',
      'email_security_contact',
    ]) {
      expect(treeOnly['alz.tf'], name).toMatch(new RegExp(`^    ${name}\\s+= jsonencode`, 'm'));
    }
    expect(treeOnly['alz.tf']).not.toContain('log_analytics_workspace_id');
    expect(treeOnly['variables.tf']).toContain('variable "security_contact_email"');

    const managementNoPolicy = byPath(emitFiles({ selected: ['management'] }))['alz.tf'];
    expect(notEnforced(managementNoPolicy)).toBe(baselineCount);
    expect(managementNoPolicy).toContain('policy_assignments_dependencies');
    expect(managementNoPolicy).toContain('log_analytics_workspace_id');

    const policyNoHub = byPath(emitFiles({ selected: ['policy'] }));
    expect(policyNoHub['alz.tf']).toContain('Deploy-Private-DNS-Zones');
    expect(policyNoHub['alz.tf']).toContain('policy_default_values');
    expect(policyNoHub['management.tf']).toContain('module "management"');
    expect(policyNoHub['variables.tf']).toContain('variable "security_contact_email"');
    expect(policyNoHub['terraform.tfvars.example']).toContain(
      'security_contact_email     = "security@example.com"'
    );
    expect(byPath(emitFiles({ selected: ['management-groups'] }))['variables.tf']).toContain(
      'security_contact_email'
    );
  });

  it('mirrors the range rules in variables.tf: shape and prefix bounds, ranges apart, parent a bare name', () => {
    const vars = byPath(emitFiles(DEFAULT_STATE))['variables.tf'];
    const alternation = ([min, max]) =>
      `(${Array.from({ length: max - min + 1 }, (_, i) => min + i).join('|')})`;
    expect(HUB_PREFIX_RANGE).toEqual([8, 24]);
    expect(SPOKE_PREFIX_RANGE).toEqual([8, 20]);
    expect(vars).toContain(
      `condition     = can(regex("^([0-9]{1,3}[.]){3}[0-9]{1,3}/${alternation(HUB_PREFIX_RANGE)}$", var.hub_address_space)) && can(cidrhost(var.hub_address_space, 0))`
    );
    expect(vars).toContain('error_message = "An IPv4 CIDR with a prefix from /8 to /24."');
    expect(vars).toContain(
      `condition     = can(regex("^([0-9]{1,3}[.]){3}[0-9]{1,3}/${alternation(SPOKE_PREFIX_RANGE)}$", var.spoke_address_space)) && can(cidrhost(var.spoke_address_space, 0))`
    );
    expect(vars).toContain('error_message = "An IPv4 CIDR with a prefix from /8 to /20."');
    expect(vars).toMatch(
      /validation \{\n    condition = \(\n      can\(cidrhost\(var\.hub_address_space, 0\)\) && can\(cidrhost\(var\.spoke_address_space, 0\)\)\n      \? \(\n        tonumber\(split\("\/", var\.hub_address_space\)\[1\]\) <= tonumber\(split\("\/", var\.spoke_address_space\)\[1\]\)\n        \? cidrsubnet\("\$\{cidrhost\(var\.spoke_address_space, 0\)\}\/\$\{split\("\/", var\.hub_address_space\)\[1\]\}", 0, 0\) != cidrsubnet\(var\.hub_address_space, 0, 0\)\n        : cidrsubnet\("\$\{cidrhost\(var\.hub_address_space, 0\)\}\/\$\{split\("\/", var\.spoke_address_space\)\[1\]\}", 0, 0\) != cidrsubnet\(var\.spoke_address_space, 0, 0\)\n      \)\n      : true\n    \)\n    error_message = "The spoke range must not overlap the hub address space\."/
    );
    const spokeBlock = vars.slice(vars.indexOf('variable "spoke_address_space"'));
    const hubBlock = vars.slice(
      vars.indexOf('variable "hub_address_space"'),
      vars.indexOf('variable "spoke_address_space"')
    );
    expect(
      (spokeBlock.slice(0, spokeBlock.indexOf('\n}\n')).match(/validation \{/g) ?? []).length
    ).toBe(2);
    expect((hubBlock.match(/validation \{/g) ?? []).length).toBe(1);
    expect(vars).toContain(
      'condition     = var.parent_management_group_id == null ? true : (length(var.parent_management_group_id) > 0 && !strcontains(var.parent_management_group_id, "/"))'
    );
    expect(byPath(emitFiles(DEFAULT_STATE))['alz.tf']).toContain(
      'parent_resource_id = coalesce(var.parent_management_group_id, data.azapi_client_config.current.tenant_id)'
    );

    const overlapping = emitFiles({
      options: { hubCidr: '10.1.0.0/16', spokeCidr: '10.1.0.0/16' },
    });
    expect(byPath(overlapping)['variables.tf']).toContain('default     = "10.2.0.0/16"');
    expect(byPath(overlapping)['application.tf']).toContain('online_1 = 10.2.128.0/24');
  });

  it('lists every placed subscription id once and refuses duplicates', () => {
    const full = byPath(emitFiles(DEFAULT_STATE));
    const subs = full['subscriptions.tf'];
    expect(subs).toContain(
      'placed_subscription_ids = concat(\n    [\n      var.management_subscription_id,\n      var.connectivity_subscription_id,\n      var.identity_subscription_id,\n    ],\n    var.corp_subscription_ids,\n    var.online_subscription_ids,\n  )'
    );
    expect(subs).toContain(
      'condition     = length(distinct(local.placed_subscription_ids)) == length(local.placed_subscription_ids)'
    );
    expect(subs).toContain('output "placed_subscription_ids"');
    expect(subs).toContain('precondition {');
    expect(subs).toMatch(/error_message = "Every subscription id must be distinct/);

    const corpOnly = byPath(emitFiles({ selected: ['corp'] }))['subscriptions.tf'];
    expect(corpOnly).toContain(
      'concat(\n    [\n      var.connectivity_subscription_id,\n    ],\n    var.corp_subscription_ids,\n  )'
    );
    expect(corpOnly).not.toContain('identity');
    expect(corpOnly).not.toContain('online');
    expect(
      byPath(emitFiles({ selected: ['management-groups'] }))['subscriptions.tf']
    ).toBeUndefined();

    const example = full['terraform.tfvars.example'];
    expect(example).toMatch(
      /^# Copy to terraform\.tfvars\. The subscription ids below are placeholders, not defaults:\n# every one must be replaced with a real subscription id before any plan\.\n/
    );
    expect(example).not.toContain('all-zero');
    expect(full['README.md']).toContain('placeholders, not');
    expect(full['README.md']).toContain('replaced with a real subscription id before any plan');
    const ids = [...example.matchAll(/"(00000000-0000-0000-0000-\d{12})"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('matches the committed snapshot of the tree-only build, baseline present and not enforced', () => {
    const files = emitFiles({ selected: ['management-groups'] });
    expect(files.map((f) => f.path)).toMatchSnapshot('tree-only paths');
    for (const f of files) expect(f.content).toMatchSnapshot(`tree-only ${f.path}`);
  });

  it('matches the committed snapshot of the default build', () => {
    const files = emitFiles(DEFAULT_STATE);
    expect(files.map((f) => f.path)).toMatchSnapshot('paths');
    for (const f of files) expect(f.content).toMatchSnapshot(f.path);
  });

  it('lists every selected component in the README', () => {
    const readme = byPath(emitFiles(DEFAULT_STATE))['README.md'];
    for (const label of [
      'Management groups',
      'Policy baseline',
      'Management',
      'Connectivity hub',
      'Azure Firewall',
      'Identity',
      'Corp landing zone (1)',
      'Online landing zone (1)',
    ]) {
      expect(readme).toContain(`**${label}**`);
    }
    // The pinned version, read rather than written, so the weekly bump
    // moves this line with avmVersions.js (#1287).
    const spoke = AVM_MODULES['avm-res-network-virtualnetwork'];
    expect(readme).toContain(`\`${spoke.source}\` ${spoke.version}`);
  });
});

describe('Multi-Cloud Landing Zone HCL emission (#Deliverable04)', () => {
  it('emits AWS Landing Zone files with Organizations, SCPs, TGW, and pinned modules', () => {
    const files = emitFiles({ cloud: 'aws' });
    const paths = files.map((f) => f.path);
    expect(paths).toEqual([
      'terraform.tf',
      'providers.tf',
      'organizations.tf',
      'scp.tf',
      'logging.tf',
      'transit-gateway.tf',
      'network-firewall.tf',
      'identity.tf',
      'spokes.tf',
      'variables.tf',
      'terraform.tfvars.example',
      'README.md',
    ]);

    const byFile = Object.fromEntries(files.map((f) => [f.path, f.content]));
    expect(byFile['terraform.tf']).toContain('hashicorp/aws');
    expect(byFile['organizations.tf']).toContain('aws_organizations_organization');
    expect(byFile['organizations.tf']).toContain('aws_organizations_organizational_unit');
    expect(byFile['scp.tf']).toContain('SERVICE_CONTROL_POLICY');
    expect(byFile['scp.tf']).toContain('DenyRootAccountUsage');
    expect(byFile['transit-gateway.tf']).toContain('terraform-aws-modules/transit-gateway/aws');
    expect(byFile['network-firewall.tf']).toContain('terraform-aws-modules/network-firewall/aws');
    expect(byFile['spokes.tf']).toContain('terraform-aws-modules/vpc/aws');
    expect(byFile['README.md']).toContain('AWS Landing Zone Foundation Architecture');
  });

  it('emits Google Cloud Landing Zone files with Folders, Org Policies, Shared VPC, and pinned modules', () => {
    const files = emitFiles({ cloud: 'gcp' });
    const paths = files.map((f) => f.path);
    expect(paths).toEqual([
      'terraform.tf',
      'providers.tf',
      'folders.tf',
      'org-policies.tf',
      'logging-sink.tf',
      'shared-vpc.tf',
      'cloud-ngfw.tf',
      'identity.tf',
      'projects.tf',
      'variables.tf',
      'terraform.tfvars.example',
      'README.md',
    ]);

    const byFile = Object.fromEntries(files.map((f) => [f.path, f.content]));
    expect(byFile['terraform.tf']).toContain('hashicorp/google');
    expect(byFile['folders.tf']).toContain('google_folder');
    expect(byFile['org-policies.tf']).toContain('google_org_policy_policy');
    expect(byFile['logging-sink.tf']).toContain('terraform-google-modules/log-export/google');
    expect(byFile['shared-vpc.tf']).toContain('terraform-google-modules/network/google');
    expect(byFile['cloud-ngfw.tf']).toContain('google_compute_region_network_firewall_policy');
    expect(byFile['projects.tf']).toContain('terraform-google-modules/project-factory/google');
    expect(byFile['README.md']).toContain('Google Cloud Landing Zone Foundation Architecture');
  });

  it('emits only README for empty AWS or GCP selections', () => {
    expect(emitFiles({ cloud: 'aws', selected: [] }).map((f) => f.path)).toEqual(['README.md']);
    expect(emitFiles({ cloud: 'gcp', selected: [] }).map((f) => f.path)).toEqual(['README.md']);
  });
});
