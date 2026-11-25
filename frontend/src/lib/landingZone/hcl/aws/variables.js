import { block, file, joinBlocks, q } from '../format';
import { isSelected } from '../../state';
import { ALLOW_LIST_VARIABLE } from './networkFirewall';
import { nearestRegion } from '../cloudRegion';

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

  // No corp_count or online_count variable: the builder writes one module
  // per workload VPC, so a count in tfvars would change nothing (#1876).

  return file('variables.tf', joinBlocks(blocks));
}

export function tfvarsExample(state) {
  const lines = [
    '# Sample AWS Landing Zone Configuration Parameters',
    `aws_region = "${nearestRegion('aws', state.options?.location, 'us-east-1')}"`,
    `hub_cidr   = "${state.options?.hubCidr || '10.0.0.0/16'}"`,
    `spoke_cidr = "${state.options?.spokeCidr || '10.1.0.0/16'}"`,
  ];
  if (isSelected(state, 'firewall')) {
    // Empty until someone decides what the workloads may reach (#1871).
    lines.push(
      '',
      '# Domains the hub firewall lets out over HTTP and HTTPS. Empty allows nothing.',
      `# ${ALLOW_LIST_VARIABLE} = ["api.example.com", ".amazonaws.com"]`,
      `${ALLOW_LIST_VARIABLE} = []`
    );
  }
  return file('terraform.tfvars.example', lines);
}
