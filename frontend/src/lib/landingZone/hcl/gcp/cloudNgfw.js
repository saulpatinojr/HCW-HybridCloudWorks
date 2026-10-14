import { block, file, joinBlocks, list, obj, q } from '../format';

export function cloudNgfwTf() {
  const blocks = [];

  // Regional Network Firewall Policy
  blocks.push(
    block('resource "google_compute_region_network_firewall_policy" "policy"', [
      ['name', q('ngfw-baseline-policy')],
      ['project', 'var.host_project_id'],
      ['region', 'var.gcp_region'],
      ['description', q('Regional Cloud NGFW policy enforcing enterprise inspection rules')],
    ])
  );

  // Association with Shared VPC Network
  blocks.push(
    block('resource "google_compute_region_network_firewall_policy_association" "assoc"', [
      ['name', q('assoc-shared-vpc')],
      ['project', 'var.host_project_id'],
      ['region', 'var.gcp_region'],
      ['attachment_target', 'module.shared_vpc_host.network_id'],
      ['firewall_policy', 'google_compute_region_network_firewall_policy.policy.name'],
    ])
  );

  // Default Rule: Deny all ingress from external untrusted by default
  blocks.push(
    block('resource "google_compute_region_network_firewall_policy_rule" "deny_untrusted"', [
      ['firewall_policy', 'google_compute_region_network_firewall_policy.policy.name'],
      ['project', 'var.host_project_id'],
      ['region', 'var.gcp_region'],
      ['priority', '1000'],
      ['action', q('deny')],
      ['direction', q('INGRESS')],
      [
        'match',
        obj([
          ['src_ip_ranges', list([q('0.0.0.0/0')])],
          ['layer4_configs', list([obj([['ip_protocol', q('all')]])])],
        ]),
      ],
    ])
  );

  return file('cloud-ngfw.tf', joinBlocks(blocks));
}
