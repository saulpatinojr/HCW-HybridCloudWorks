/**
 * The hub VPC, written into transit-gateway.tf (#1876). It is where traffic
 * from the workload VPCs meets the firewall (when selected) and leaves for
 * the internet. Per zone it has:
 *
 * - a small /28 Transit Gateway subnet (the module's "intra" subnets, renamed "tgw"),
 *   where the Transit Gateway delivers traffic from the workload VPCs;
 * - a firewall subnet (the module's "private" subnets, renamed "firewall"),
 *   only when the firewall is selected, holding that zone's firewall endpoint;
 * - a public subnet with that zone's NAT gateway, and the internet gateway.
 *
 * Every subnet type gets one route table per zone, because each zone's
 * traffic must use that zone's firewall endpoint and NAT gateway. One NAT
 * gateway per zone rather than one for the VPC: if a zone fails, the other
 * zone's workloads keep their way out.
 */
import { block, list, q } from '../format';
import { AWS_MODULES } from './moduleVersions';
import { PER_AZ, tgwVia } from './spokeVpcs';

const subnets = (a, b) =>
  list([q(`\${cidrsubnet(var.hub_cidr, 4, ${a})}`), q(`\${cidrsubnet(var.hub_cidr, 4, ${b})}`)]);

function firewallSubnetLines(firewall) {
  if (!firewall) {
    // The module adds a NAT route to every private route table; with no
    // private subnets there are no tables to add it to, so it is turned off.
    return [
      '# No firewall, so no firewall subnets.',
      ['create_private_nat_gateway_route', 'false'],
    ];
  }
  return [
    '# Firewall subnets: one endpoint of the firewall in each zone. The module',
    '# gives each zone a route table whose default route is that zone’s NAT',
    '# gateway, which is how inspected traffic leaves for the internet.',
    ['private_subnets', subnets(0, 1)],
    ['private_subnet_suffix', q('firewall')],
  ];
}

function hubVpcModule(firewall) {
  const vpcModule = AWS_MODULES.vpc;
  return block('module "hub_vpc"', [
    ['source', q(vpcModule.source)],
    ['version', q(vpcModule.version)],
    ['name', q('hub-vpc')],
    ['cidr', 'var.hub_cidr'],
    ['azs', 'local.azs'],
    '',
    '# Transit Gateway subnets: where traffic from the workload VPCs arrives.',
    ['intra_subnets', 'local.tgw_subnets'],
    ['intra_subnet_suffix', q('tgw')],
    ['create_multiple_intra_route_tables', 'true'],
    '',
    ...firewallSubnetLines(firewall),
    '',
    '# Public subnets: one NAT gateway per zone, and the internet gateway.',
    ['public_subnets', subnets(2, 3)],
    ['create_multiple_public_route_tables', 'true'],
    ['enable_nat_gateway', 'true'],
    ['single_nat_gateway', 'false'],
    ['one_nat_gateway_per_az', 'true'],
    '',
    ['tags', `{ Role = ${q(firewall ? 'InspectionTier' : 'EgressHub')} }`],
  ]);
}

/** Without a firewall, the hub sends traffic straight to its NAT gateways. */
function directEgressRoutes() {
  return [
    block('resource "aws_route" "hub_tgw_subnet_to_nat"', [
      '# Hop 2: traffic from the workload VPCs goes to the NAT gateway in the',
      '# same zone, then out through the internet gateway.',
      PER_AZ,
      ['route_table_id', 'module.hub_vpc.intra_route_table_ids[each.value]'],
      ['destination_cidr_block', q('0.0.0.0/0')],
      ['nat_gateway_id', 'module.hub_vpc.natgw_ids[each.value]'],
    ]),
    block('resource "aws_route" "hub_public_to_spokes"', [
      '# The way back: replies for the workload VPCs go from the NAT gateway to',
      '# the Transit Gateway, which sends each to its VPC.',
      PER_AZ,
      ['route_table_id', 'module.hub_vpc.public_route_table_ids[each.value]'],
      ['destination_cidr_block', 'var.spoke_cidr'],
      ['transit_gateway_id', tgwVia('hub')],
    ]),
  ];
}

/** The two /28 Transit Gateway subnets, worked out from whatever size the hub range is. */
function tgwSubnetLocals() {
  return block('locals', [
    '# Transit Gateway subnets are /28s, the size AWS recommends: they hold only',
    '# the Transit Gateway’s network interfaces. These are the bits to add to the',
    '# hub range (a /8 to a /24) to get a /28.',
    '# https://docs.aws.amazon.com/vpc/latest/tgw/tgw-best-design-practices.html',
    ['tgw_subnet_newbits', '28 - tonumber(split("/", var.hub_cidr)[1])'],
    '',
    '# The first two /28s of the hub range’s fifth sixteenth, which no other',
    '# subnet uses (firewall subnets take the first two sixteenths, public the next two).',
    [
      'tgw_subnets',
      [
        '[',
        'for i in [0, 1] :',
        'cidrsubnet(var.hub_cidr, local.tgw_subnet_newbits, 4 * pow(2, local.tgw_subnet_newbits - 4) + i)',
        ']',
      ],
    ],
  ]);
}

/**
 * The hub VPC, and, when there is no firewall, its routes. With the
 * firewall, network-firewall.tf writes the hub's routes through it.
 *
 * @param {boolean} firewall whether the firewall is selected
 * @returns {string[][]} the HCL blocks
 */
export function hubVpcBlocks(firewall) {
  return [tgwSubnetLocals(), hubVpcModule(firewall), ...(firewall ? [] : directEgressRoutes())];
}
