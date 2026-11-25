/**
 * The hub VPC routes that put the firewall in the path, written into
 * network-firewall.tf (#1876). Before these, the firewall was built but no
 * route led to it, so it inspected nothing.
 *
 * Each zone's traffic must use that zone's firewall endpoint, both ways, or
 * the firewall sees half a connection and drops it. The endpoint ids come
 * from the firewall's `status` output (network-firewall module 1.0.2, its
 * outputs.tf), which lists one sync state per zone with the endpoint in it.
 * https://aws.amazon.com/blogs/networking-and-content-delivery/deployment-models-for-aws-network-firewall/
 */
import { block, q } from '../format';
import { PER_AZ, tgwVia } from './spokeVpcs';

const ENDPOINT = ['vpc_endpoint_id', 'local.firewall_endpoint_by_az[each.key]'];

function endpointLocals() {
  return block('locals', [
    '# The firewall endpoint in each zone, by zone name, such as "us-east-1a".',
    [
      'firewall_endpoint_by_az',
      [
        '{',
        'for s in module.network_firewall.status[0].sync_states :',
        's.availability_zone => s.attachment[0].endpoint_id',
        '}',
      ],
    ],
  ]);
}

/** @returns {string[][]} the locals and the three routes, as HCL blocks */
export function firewallRouteBlocks() {
  return [
    endpointLocals(),
    block('resource "aws_route" "hub_tgw_subnet_to_firewall"', [
      '# Hop 2: everything the Transit Gateway delivers to the hub goes to the',
      '# firewall endpoint in the same zone.',
      PER_AZ,
      ['route_table_id', 'module.hub_vpc.intra_route_table_ids[each.value]'],
      ['destination_cidr_block', q('0.0.0.0/0')],
      ENDPOINT,
    ]),
    block('resource "aws_route" "hub_firewall_subnet_to_spokes"', [
      '# Hop 3: what the firewall allows goes on. Traffic for a workload VPC goes',
      '# back to the Transit Gateway; anything else takes the default route the',
      '# module wrote, to the NAT gateway in the same zone, then the internet.',
      PER_AZ,
      ['route_table_id', 'module.hub_vpc.private_route_table_ids[each.value]'],
      ['destination_cidr_block', 'var.spoke_cidr'],
      ['transit_gateway_id', tgwVia('hub')],
    ]),
    block('resource "aws_route" "hub_public_to_firewall"', [
      '# The way back from the internet: the NAT gateway hands replies for the',
      '# workload VPCs to the same zone’s firewall endpoint, which hands them to',
      '# the Transit Gateway by the route above.',
      PER_AZ,
      ['route_table_id', 'module.hub_vpc.public_route_table_ids[each.value]'],
      ['destination_cidr_block', 'var.spoke_cidr'],
      ENDPOINT,
    ]),
  ];
}
