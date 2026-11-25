import { block, file, joinBlocks, q } from '../format';
import { isSelected } from '../../state';
import { githubOrganizationVariable } from './identity';
import { nearestRegion } from '../cloudRegion';

/**
 * The pack's variables. `github_organization` has no default, so Terraform
 * stops until it is set; it is written only when identity.tf is, so a pack
 * without the GitHub sign-in never asks for it (#1870).
 */
export function variablesTf(state) {
  const blocks = [];

  if (isSelected(state, 'identity')) blocks.push(githubOrganizationVariable());

  blocks.push(
    block('variable "organization_id"', [
      ['description', q('Google Cloud Organization ID number for top-level folder anchoring.')],
      ['type', 'string'],
      ['default', q('123456789012')],
    ])
  );

  blocks.push(
    block('variable "billing_account_id"', [
      ['description', q('Billing Account ID associated with newly synthesized service projects.')],
      ['type', 'string'],
      ['default', q('012345-6789AB-CDEF01')],
    ])
  );

  blocks.push(
    block('variable "gcp_region"', [
      ['description', q('Default GCP deployment region for networking and storage.')],
      ['type', 'string'],
      ['default', q('us-central1')],
    ])
  );

  blocks.push(
    block('variable "host_project_id"', [
      ['description', q('Project ID designated as the Shared VPC Host.')],
      ['type', 'string'],
      ['default', q('prj-shared-vpc-host-hcw')],
    ])
  );

  blocks.push(
    block('variable "logging_project_id"', [
      ['description', q('Project ID designated for central organization audit log storage.')],
      ['type', 'string'],
      ['default', q('prj-logging-hub-hcw')],
    ])
  );

  blocks.push(
    block('variable "spoke_cidr"', [
      ['description', q('Base IPv4 CIDR block partitioned across Shared VPC subnet allocations.')],
      ['type', 'string'],
      ['default', q('10.1.0.0/16')],
    ])
  );

  // No corp_count / online_count: the builder writes one project module per
  // service project, so a count in tfvars would change nothing (the AWS pack
  // dropped the same two for the same reason, #1876).

  return file('variables.tf', joinBlocks(blocks));
}

export function tfvarsExample(state) {
  const lines = [
    '# Sample Google Cloud Landing Zone Configuration Parameters',
    'organization_id    = "123456789012"',
    'billing_account_id = "012345-6789AB-CDEF01"',
    `gcp_region         = "${nearestRegion('gcp', state.options?.location, 'us-central1')}"`,
    'host_project_id    = "prj-shared-vpc-host-hcw"',
    'logging_project_id = "prj-logging-hub-hcw"',
    `spoke_cidr         = "${state.options?.spokeCidr || '10.1.0.0/16'}"`,
  ];
  if (isSelected(state, 'identity')) {
    lines.push(
      '',
      '# Required: the GitHub organisation (or user) whose Actions workflows may sign in.',
      '# Change this to your own; no other organisation is accepted.',
      'github_organization = "example-org"'
    );
  }
  return file('terraform.tfvars.example', lines);
}
