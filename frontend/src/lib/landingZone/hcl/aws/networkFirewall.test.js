/**
 * The AWS pack's network firewall must inspect what reaches it and drop what
 * nobody allowed (#1871). It used to take the module's default policy, which
 * passes every packet without inspection, so a deployed pack cost the price of
 * a firewall and protected nothing. These tests read the generated HCL, so a
 * change that brings back a pass-through policy fails here, not in production.
 */
import { describe, it, expect } from 'vitest';
import { emitFiles } from '../../index';

const fileOf = (state, path) => emitFiles({ cloud: 'aws', ...state }).find((f) => f.path === path);

describe.each([
  ['the full pack', {}],
  ['the firewall on its own', { selected: ['firewall'] }],
])('AWS network firewall policy in %s (#1871)', (_label, state) => {
  const tf = fileOf(state, 'network-firewall.tf')?.content ?? '';

  it('is generated', () => {
    expect(tf).toContain('module "network_firewall"');
  });

  it('never passes packets uninspected: stateless defaults forward to the stateful engine', () => {
    expect(tf).not.toContain('aws:pass');
    expect(tf).toMatch(/policy_stateless_default_actions\s+=\s+\["aws:forward_to_sfe"\]/);
    expect(tf).toMatch(/policy_stateless_fragment_default_actions\s+=\s+\["aws:forward_to_sfe"\]/);
  });

  it('evaluates stateful rules in strict order', () => {
    expect(tf).toMatch(
      /policy_stateful_engine_options\s+=\s+\{[^}]*rule_order\s+=\s+"STRICT_ORDER"/
    );
  });

  it('drops by default what no stateful rule allowed', () => {
    // The app-layer form waits for the domain name even when a large TLS
    // hello is split over two packets; plain drop_established can decide on
    // the first packet and drop an allowed site.
    expect(tf).toMatch(
      /policy_stateful_default_actions\s+=\s+\[[^\]]*"aws:drop_established_app_layer_to_server"/
    );
    expect(tf).not.toMatch(/"aws:(drop|alert)_established"/);
  });

  it('declares the allow-list variable and feeds it to a strict-order rule group', () => {
    expect(tf).toContain('variable "firewall_allowed_domains"');
    expect(tf).toMatch(/targets\s+=\s+var\.firewall_allowed_domains/);
    expect(tf).toContain('generated_rules_type = "ALLOWLIST"');
    // A rule group in a strict-order policy must say strict order itself.
    expect(tf).toMatch(/stateful_rule_options \{\s+rule_order = "STRICT_ORDER"/);
    expect(tf).toMatch(
      /policy_stateful_rule_group_reference\s+=.*aws_networkfirewall_rule_group\.egress_allow_list/
    );
  });

  it('treats the spokes as the inside network, not just the inspection VPC', () => {
    // Without this, HOME_NET is the inspection VPC alone and traffic from
    // the workload VPCs never matches the allow-list (AWS domain list docs).
    expect(tf).toMatch(/key\s+=\s+"HOME_NET"/);
    expect(tf).toMatch(/definition = \[var\.hub_cidr, var\.spoke_cidr\]/);
  });
});

describe('AWS pack README and tfvars explain the firewall default (#1871)', () => {
  it('says plainly that nothing is allowed until the allow-list is set, and how to add one', () => {
    const readme = fileOf({}, 'README.md').content;
    expect(readme).toContain('## Network Firewall: what it allows');
    expect(readme).toMatch(/allows nothing/i);
    expect(readme).toContain('firewall_allowed_domains');
  });

  it('leaves the firewall section out when the firewall is not selected', () => {
    const readme = fileOf({ selected: ['policy'] }, 'README.md').content;
    expect(readme).not.toContain('firewall_allowed_domains');
    expect(fileOf({ selected: ['policy'] }, 'terraform.tfvars.example').content).not.toContain(
      'firewall_allowed_domains'
    );
  });

  it('shows the allow-list in the tfvars example when the firewall is selected', () => {
    expect(fileOf({}, 'terraform.tfvars.example').content).toContain('firewall_allowed_domains');
  });
});
