import { block, file, joinBlocks, q } from '../format';

export function variablesTf() {
  const blocks = [];

  blocks.push(
    block('variable "aws_region"', [
      ['description', q('Target AWS deployment region for hub and workload VPCs.')],
      ['type', 'string'],
      ['default', q('us-east-1')],
    ])
  );

  blocks.push(
    block('variable "hub_cidr"', [
      ['description', q('IPv4 address range for the central inspection and hub VPC.')],
      ['type', 'string'],
      ['default', q('10.0.0.0/16')],
    ])
  );

  blocks.push(
    block('variable "spoke_cidr"', [
      ['description', q('Base IPv4 CIDR block allocated for workload spoke VPC partitions.')],
      ['type', 'string'],
      ['default', q('10.1.0.0/16')],
    ])
  );

  blocks.push(
    block('variable "corp_count"', [
      ['description', q('Number of private Corp workload VPCs to provision.')],
      ['type', 'number'],
      ['default', '1'],
    ])
  );

  blocks.push(
    block('variable "online_count"', [
      ['description', q('Number of public edge Online workload VPCs to provision.')],
      ['type', 'number'],
      ['default', '1'],
    ])
  );

  return file('variables.tf', joinBlocks(blocks));
}

export function tfvarsExample(state) {
  const lines = [
    '# Sample AWS Landing Zone Configuration Parameters',
    `aws_region   = "${state.options?.location || 'us-east-1'}"`,
    `hub_cidr     = "${state.options?.hubCidr || '10.0.0.0/16'}"`,
    `spoke_cidr   = "${state.options?.spokeCidr || '10.1.0.0/16'}"`,
    `corp_count   = ${state.options?.corpCount ?? 1}`,
    `online_count = ${state.options?.onlineCount ?? 1}`,
  ];
  return file('terraform.tfvars.example', lines);
}
