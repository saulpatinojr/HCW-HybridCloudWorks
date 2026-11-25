import { block, file, joinBlocks, list, obj, q } from '../format';
import { AWS_MODULES } from './moduleVersions';

export function networkFirewallTf() {
  const blocks = [];
  const nfwModule = AWS_MODULES.networkFirewall;
  const vpcModule = AWS_MODULES.vpc;

  // Dedicated Inspection VPC
  blocks.push(
    block('module "inspection_vpc"', [
      ['source', q(vpcModule.source)],
      ['version', q(vpcModule.version)],
      ['name', q('inspection-vpc')],
      ['cidr', 'var.hub_cidr'],
      ['azs', list([q('${var.aws_region}a'), q('${var.aws_region}b')])],
      [
        'private_subnets',
        list([q('${cidrsubnet(var.hub_cidr, 4, 0)}'), q('${cidrsubnet(var.hub_cidr, 4, 1)}')]),
      ],
      ['tags', obj([['Role', q('InspectionTier')]])],
    ])
  );

  // AWS Network Firewall
  blocks.push(
    block('module "network_firewall"', [
      ['source', q(nfwModule.source)],
      ['version', q(nfwModule.version)],
      ['name', q('hub-network-firewall')],
      ['description', q('Central stateful inspection firewall for ingress, egress, and east-west')],
      ['vpc_id', 'module.inspection_vpc.vpc_id'],
      // The module reads `subnet_id` from each entry of this map, so every
      // entry is an object, not a bare subnet id (#1862).
      [
        'subnet_mapping',
        obj([
          ['subnet_1', obj([['subnet_id', 'module.inspection_vpc.private_subnets[0]']])],
          ['subnet_2', obj([['subnet_id', 'module.inspection_vpc.private_subnets[1]']])],
        ]),
      ],
      ['delete_protection', 'false'],
      ['tags', obj([['Tier', q('StatefulInspection')]])],
    ])
  );

  return file('network-firewall.tf', joinBlocks(blocks));
}
