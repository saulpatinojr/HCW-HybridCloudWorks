import { block, file, joinBlocks, q } from '../format';

export function variablesTf() {
  const blocks = [];

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

  blocks.push(
    block('variable "corp_count"', [
      ['description', q('Number of private Corp service projects to attach to the Shared VPC.')],
      ['type', 'number'],
      ['default', '1'],
    ])
  );

  blocks.push(
    block('variable "online_count"', [
      ['description', q('Number of public edge Online service projects to attach.')],
      ['type', 'number'],
      ['default', '1'],
    ])
  );

  return file('variables.tf', joinBlocks(blocks));
}

export function tfvarsExample(state) {
  const lines = [
    '# Sample Google Cloud Landing Zone Configuration Parameters',
    'organization_id    = "123456789012"',
    'billing_account_id = "012345-6789AB-CDEF01"',
    `gcp_region         = "${state.options?.location || 'us-central1'}"`,
    'host_project_id    = "prj-shared-vpc-host-hcw"',
    'logging_project_id = "prj-logging-hub-hcw"',
    `spoke_cidr         = "${state.options?.spokeCidr || '10.1.0.0/16'}"`,
    `corp_count         = ${state.options?.corpCount ?? 1}`,
    `online_count       = ${state.options?.onlineCount ?? 1}`,
  ];
  return file('terraform.tfvars.example', lines);
}
