/**
 * The workload VPCs (spokes) an AWS pack builds, and the route that sends
 * each one's outbound traffic to the Transit Gateway (#1876). The Transit
 * Gateway file attaches every VPC named here, and the identity and spoke
 * files write each VPC's route, so the list lives in one place.
 */
import { block } from '../format';
import { isSelected } from '../../state';

/** A route for each Availability Zone: the key is the zone, the value its position in the module's lists. */
export const PER_AZ = ['for_each', 'local.az_index'];

/** The Transit Gateway id, read from one VPC's attachment so a route waits until that VPC is attached. */
export const tgwVia = (attachment) =>
  `module.transit_gateway.ec2_transit_gateway_vpc_attachment["${attachment}"].transit_gateway_id`;

/**
 * The module names of the workload VPCs in this build, in emit order:
 * identity, then corp, then online.
 *
 * @param {object} state a normalized builder state
 * @returns {string[]} module names such as `corp_spoke_1`
 */
export function spokeVpcNames(state) {
  const count = (id, option) => (isSelected(state, id) ? Number(state.options?.[option] ?? 1) : 0);
  const numbered = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}_${i + 1}`);
  return [
    ...(isSelected(state, 'identity') ? ['identity_spoke_vpc'] : []),
    ...numbered('corp_spoke', count('corp', 'corpCount')),
    ...numbered('online_spoke', count('online', 'onlineCount')),
  ];
}

/**
 * The route that sends everything a spoke's private subnets cannot reach
 * locally to the Transit Gateway, one per Availability Zone. The Transit
 * Gateway then sends it to the hub.
 *
 * @param {string} spoke the spoke's module name
 * @returns {string[]} the HCL lines
 */
export function spokeDefaultRoute(spoke) {
  return block(`resource "aws_route" "${spoke}_default_to_tgw"`, [
    '# Anything that is not inside this VPC goes to the Transit Gateway.',
    PER_AZ,
    ['route_table_id', `module.${spoke}.private_route_table_ids[each.value]`],
    ['destination_cidr_block', '"0.0.0.0/0"'],
    ['transit_gateway_id', tgwVia(spoke)],
  ]);
}
