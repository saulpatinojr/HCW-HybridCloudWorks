/**
 * transit-gateway.tf: the Transit Gateway, the hub VPC behind it, and the
 * two Transit Gateway route tables that decide where traffic goes (#1876).
 *
 * The design is AWS's centralized inspection model: every workload VPC
 * (spoke) sends what it cannot reach locally to the Transit Gateway, the
 * spoke route table sends all of it to the hub, and the hub route table
 * knows where each spoke is for the way back. With the firewall selected,
 * the hub passes everything through the firewall first (see
 * networkFirewall.js); without it, the hub sends internet traffic straight
 * to its NAT gateways and spokes reach each other directly.
 * https://docs.aws.amazon.com/reference-architecture-diagrams/latest/network-firewall-inspection-models/nwfw-combined.html
 */
import { block, file, joinBlocks, list, obj, q } from '../format';
import { isSelected } from '../../state';
import { hubVpcBlocks } from './hubVpc';
import { AWS_MODULES } from './moduleVersions';
import { spokeVpcNames } from './spokeVpcs';

const HUB_ATTACHMENT = 'module.transit_gateway.ec2_transit_gateway_vpc_attachment["hub"].id';
const attachmentId = (key) =>
  `module.transit_gateway.ec2_transit_gateway_vpc_attachment[${key}].id`;

/** The zones every VPC in the pack uses, and each zone's position in a module's lists. */
function zoneLocals() {
  return block('locals', [
    '# The two Availability Zones every VPC in this pack uses.',
    ['azs', list([q('${var.aws_region}a'), q('${var.aws_region}b')])],
    '',
    '# Each zone and its position in the subnet and route table lists the VPC',
    '# module returns, so a route can pick the table of its own zone.',
    ['az_index', '{ for i, az in local.azs : az => i }'],
  ]);
}

/** One entry of the module's `vpc_attachments` map. */
function attachment(vpc, subnets, name, extra = []) {
  return obj([
    ['vpc_id', `module.${vpc}.vpc_id`],
    ['subnet_ids', `module.${vpc}.${subnets}`],
    ...extra,
    ['transit_gateway_default_route_table_association', 'false'],
    ['transit_gateway_default_route_table_propagation', 'false'],
    ['tags', `{ Name = ${q(name)} }`],
  ]);
}

function transitGatewayModule(spokes) {
  const tgwModule = AWS_MODULES.transitGateway;
  return block('module "transit_gateway"', [
    ['source', q(tgwModule.source)],
    ['version', q(tgwModule.version)],
    ['name', q('hub-tgw')],
    ['description', q('Central AWS Transit Gateway for hub-and-spoke interconnect')],
    ['amazon_side_asn', '64512'],
    ['enable_auto_accept_shared_attachments', 'true'],
    ['ram_allow_external_principals', 'false'],
    ['ram_principals', list(['aws_organizations_organization.org.arn'])],
    '',
    '# No default route table: every attachment is placed in one of the two',
    '# route tables below by hand, so the path traffic takes is written down.',
    '# The module would make a single table of its own, which cannot send',
    '# spokes to the hub and the hub back to the spokes, so that is off too.',
    ['enable_default_route_table_association', 'false'],
    ['enable_default_route_table_propagation', 'false'],
    ['create_tgw_routes', 'false'],
    '',
    '# Each VPC joins the Transit Gateway through one subnet per zone.',
    '# Appliance mode on the hub keeps both directions of a connection in the',
    '# same zone, so a stateful firewall or NAT gateway sees the whole flow.',
    [
      'vpc_attachments',
      obj([
        [
          'hub',
          attachment('hub_vpc', 'intra_subnets', 'hub-vpc', [['appliance_mode_support', 'true']]),
        ],
        ...spokes.map((spoke) => [spoke, attachment(spoke, 'private_subnets', spoke)]),
      ]),
    ],
    '',
    ['tags', obj([['Role', q('HubInterconnect')]])],
  ]);
}

function routeTable(name, comment) {
  return block(`resource "aws_ec2_transit_gateway_route_table" "${name}"`, [
    `# ${comment}`,
    ['transit_gateway_id', 'module.transit_gateway.ec2_transit_gateway_id'],
    ['tags', `{ Name = ${q(`tgw-${name}`)} }`],
  ]);
}

/** One association or propagation per spoke attachment, into `table`. */
function perSpoke(kind, name, table, comment) {
  return block(`resource "aws_ec2_transit_gateway_route_table_${kind}" "${name}"`, [
    `# ${comment}`,
    ['for_each', 'toset(local.spoke_attachments)'],
    ['transit_gateway_attachment_id', attachmentId('each.key')],
    ['transit_gateway_route_table_id', `aws_ec2_transit_gateway_route_table.${table}.id`],
  ]);
}

function spokeTableBlocks(spokes, firewall) {
  if (!spokes.length) return [];
  const blocks = [
    block('locals', [
      '# The workload VPCs attached above.',
      ['spoke_attachments', list(spokes.map(q))],
    ]),
    perSpoke(
      'association',
      'spokes',
      'spokes',
      'Each workload VPC looks up the spoke table when it sends traffic.'
    ),
    perSpoke(
      'propagation',
      'spokes_to_hub',
      'hub',
      'The hub table learns each workload VPC’s address range, for the way back.'
    ),
  ];
  if (!firewall) {
    blocks.push(
      perSpoke(
        'propagation',
        'spokes_to_spokes',
        'spokes',
        'No firewall: workload VPCs reach each other directly, without going through the hub.'
      )
    );
  }
  return blocks;
}

function routeTableBlocks(spokes, firewall) {
  return [
    routeTable('spokes', 'The table workload VPCs use: everything goes to the hub.'),
    routeTable(
      'hub',
      firewall
        ? 'The table the hub uses after the firewall: it knows where each workload VPC is.'
        : 'The table the hub uses: it knows where each workload VPC is.'
    ),
    block('resource "aws_ec2_transit_gateway_route" "spokes_default_to_hub"', [
      firewall
        ? '# Hop 1: anything a workload VPC sends, to the internet or to another'
        : '# Hop 1: anything a workload VPC sends to the internet goes to the hub VPC,',
      firewall
        ? '# workload VPC, goes to the hub VPC and through the firewall.'
        : '# which sends it out through a NAT gateway.',
      ['destination_cidr_block', q('0.0.0.0/0')],
      ['transit_gateway_attachment_id', HUB_ATTACHMENT],
      ['transit_gateway_route_table_id', 'aws_ec2_transit_gateway_route_table.spokes.id'],
    ]),
    block('resource "aws_ec2_transit_gateway_route_table_association" "hub"', [
      '# Traffic coming back out of the hub VPC looks up the hub table.',
      ['transit_gateway_attachment_id', HUB_ATTACHMENT],
      ['transit_gateway_route_table_id', 'aws_ec2_transit_gateway_route_table.hub.id'],
    ]),
    ...spokeTableBlocks(spokes, firewall),
  ];
}

export function transitGatewayTf(state) {
  const firewall = isSelected(state, 'firewall');
  const spokes = spokeVpcNames(state);
  return file(
    'transit-gateway.tf',
    joinBlocks([
      zoneLocals(),
      transitGatewayModule(spokes),
      ...hubVpcBlocks(firewall),
      ...routeTableBlocks(spokes, firewall),
    ])
  );
}
