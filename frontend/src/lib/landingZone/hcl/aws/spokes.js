import { block, file, joinBlocks, list, obj, q } from '../format';
import { isSelected } from '../../state';
import { AWS_MODULES } from './moduleVersions';
import { spokeDefaultRoute, tgwVia } from './spokeVpcs';

const slice = (slot, part) =>
  q(`\${cidrsubnet(cidrsubnet(var.spoke_cidr, 4, ${slot}), 2, ${part})}`);

function spokeVpc(name, vpcName, slot, subnetLines, tags) {
  const vpcModule = AWS_MODULES.vpc;
  return block(`module "${name}"`, [
    ['source', q(vpcModule.source)],
    ['version', q(vpcModule.version)],
    ['name', q(vpcName)],
    ['cidr', `cidrsubnet(var.spoke_cidr, 4, ${slot})`],
    ['azs', 'local.azs'],
    ...subnetLines,
    '# No NAT gateway here: the way out is through the hub (transit-gateway.tf).',
    ['enable_nat_gateway', 'false'],
    ['tags', obj(tags)],
  ]);
}

function corpSpoke(i) {
  const name = `corp_spoke_${i}`;
  return [
    spokeVpc(
      name,
      `corp-workload-vpc-${i}`,
      i,
      [['private_subnets', list([slice(i, 0), slice(i, 1)])]],
      [
        ['Environment', q('CorpPrivate')],
        ['WorkloadIndex', q(String(i))],
      ]
    ),
    spokeDefaultRoute(name),
  ];
}

function onlineSpoke(i, slot) {
  const name = `online_spoke_${i}`;
  return [
    spokeVpc(
      name,
      `online-workload-vpc-${i}`,
      slot,
      [
        '# Public subnets for internet-facing load balancers, reached through',
        '# this VPC’s own internet gateway.',
        ['public_subnets', list([slice(slot, 0), slice(slot, 1)])],
        ['private_subnets', list([slice(slot, 2), slice(slot, 3)])],
      ],
      [
        ['Environment', q('OnlinePublicEdge')],
        ['WorkloadIndex', q(String(i))],
      ]
    ),
    spokeDefaultRoute(name),
    block(`resource "aws_route" "${name}_public_to_spokes"`, [
      '# The public subnets keep the internet gateway as their default route;',
      '# traffic for other workload VPCs goes to the Transit Gateway instead.',
      ['route_table_id', `module.${name}.public_route_table_ids[0]`],
      ['destination_cidr_block', 'var.spoke_cidr'],
      ['transit_gateway_id', tgwVia(name)],
    ]),
  ];
}

export function spokesTf(state) {
  const corpCount = isSelected(state, 'corp') ? Number(state.options?.corpCount ?? 1) : 0;
  const onlineCount = isSelected(state, 'online') ? Number(state.options?.onlineCount ?? 1) : 0;
  const blocks = [];

  for (let i = 1; i <= corpCount; i += 1) blocks.push(...corpSpoke(i));
  for (let i = 1; i <= onlineCount; i += 1) blocks.push(...onlineSpoke(i, corpCount + i));

  return file('spokes.tf', joinBlocks(blocks));
}
