/**
 * The AWS pack must route traffic, not just build the pieces (#1876). Before
 * this, the Transit Gateway, the firewall and the workload VPCs were created
 * but never connected, so the firewall inspected nothing. These tests read
 * the routes from the generated Terraform and follow each hop of AWS's
 * centralized inspection design:
 * https://docs.aws.amazon.com/reference-architecture-diagrams/latest/network-firewall-inspection-models/nwfw-combined.html
 */
import { describe, it, expect } from 'vitest';
import { emitFiles } from '../../index';

const packOf = (state) =>
  Object.fromEntries(emitFiles({ cloud: 'aws', ...state }).map((f) => [f.path, f.content]));

/** Every top-level block in the pack whose header starts with `header`, as text. */
function blocksOf(pack, header) {
  const found = [];
  for (const content of Object.values(pack)) {
    let at = content.indexOf(`${header}`);
    while (at !== -1) {
      if (at === 0 || content[at - 1] === '\n') {
        const end = content.indexOf('\n}', at);
        found.push(content.slice(at, end + 2));
      }
      at = content.indexOf(`${header}`, at + 1);
    }
  }
  return found;
}

const oneBlock = (pack, header) => {
  const found = blocksOf(pack, header);
  expect(found, `${header} should appear once`).toHaveLength(1);
  return found[0];
};

/** The attachment entries of the Transit Gateway module's `vpc_attachments` map. */
function attachmentsOf(pack) {
  const tgw = oneBlock(pack, 'module "transit_gateway"');
  const start = tgw.indexOf('vpc_attachments');
  expect(start, 'the Transit Gateway attaches VPCs').toBeGreaterThan(-1);
  const entries = {};
  const re = /^ {4}([a-z0-9_]+) = \{\n([\s\S]*?)\n {4}\}/gm;
  for (const [, key, body] of tgw.slice(start).matchAll(re)) entries[key] = body;
  return entries;
}

const FULL = {};
const CORP3_FIREWALL = {
  selected: ['management-groups', 'connectivity-hub', 'firewall', 'identity', 'corp'],
  options: { corpCount: 3 },
};
const NO_FIREWALL = {
  selected: ['management-groups', 'connectivity-hub', 'corp', 'online'],
};

const SPOKES = {
  full: ['identity_spoke_vpc', 'corp_spoke_1', 'online_spoke_1'],
  corp3: ['identity_spoke_vpc', 'corp_spoke_1', 'corp_spoke_2', 'corp_spoke_3'],
  noFirewall: ['corp_spoke_1', 'online_spoke_1'],
};

describe.each([
  ['the full pack', FULL, SPOKES.full],
  ['three corp spokes and identity', CORP3_FIREWALL, SPOKES.corp3],
  ['the hub without a firewall', NO_FIREWALL, SPOKES.noFirewall],
])('AWS Transit Gateway wiring in %s (#1876)', (_label, state, spokes) => {
  const pack = packOf(state);

  it('turns off the default route table, so every route is written down', () => {
    const tgw = oneBlock(pack, 'module "transit_gateway"');
    expect(tgw).toMatch(/enable_default_route_table_association\s+=\s+false/);
    expect(tgw).toMatch(/enable_default_route_table_propagation\s+=\s+false/);
    for (const [key, body] of Object.entries(attachmentsOf(pack))) {
      expect(body, key).toMatch(/transit_gateway_default_route_table_association\s+=\s+false/);
      expect(body, key).toMatch(/transit_gateway_default_route_table_propagation\s+=\s+false/);
    }
  });

  it('attaches the hub VPC in its own subnets, with appliance mode on', () => {
    const { hub } = attachmentsOf(pack);
    expect(hub).toBeDefined();
    expect(hub).toMatch(/vpc_id\s+=\s+module\.hub_vpc\.vpc_id/);
    expect(hub).toMatch(/subnet_ids\s+=\s+module\.hub_vpc\.intra_subnets/);
    expect(hub).toMatch(/appliance_mode_support\s+=\s+true/);
  });

  it('attaches every workload VPC', () => {
    const attachments = attachmentsOf(pack);
    expect(Object.keys(attachments).sort()).toEqual(['hub', ...spokes].sort());
    for (const spoke of spokes) {
      expect(attachments[spoke]).toMatch(new RegExp(`vpc_id\\s+=\\s+module\\.${spoke}\\.vpc_id`));
    }
  });

  it('sends everything a workload VPC hands the Transit Gateway to the hub', () => {
    const route = oneBlock(
      pack,
      'resource "aws_ec2_transit_gateway_route" "spokes_default_to_hub"'
    );
    expect(route).toMatch(/destination_cidr_block\s+=\s+"0\.0\.0\.0\/0"/);
    expect(route).toMatch(
      /transit_gateway_attachment_id\s+=\s+module\.transit_gateway\.ec2_transit_gateway_vpc_attachment\["hub"\]\.id/
    );
    expect(route).toMatch(/aws_ec2_transit_gateway_route_table\.spokes\.id/);
  });

  it('associates the hub with the hub table and every spoke with the spoke table', () => {
    const hub = oneBlock(pack, 'resource "aws_ec2_transit_gateway_route_table_association" "hub"');
    expect(hub).toMatch(/aws_ec2_transit_gateway_route_table\.hub\.id/);
    const spokesAssoc = oneBlock(
      pack,
      'resource "aws_ec2_transit_gateway_route_table_association" "spokes"'
    );
    expect(spokesAssoc).toMatch(/aws_ec2_transit_gateway_route_table\.spokes\.id/);
    for (const spoke of spokes) expect(pack['transit-gateway.tf']).toContain(`"${spoke}"`);
  });

  it('teaches the hub table where each workload VPC is, for the way back', () => {
    const prop = oneBlock(
      pack,
      'resource "aws_ec2_transit_gateway_route_table_propagation" "spokes_to_hub"'
    );
    expect(prop).toMatch(/aws_ec2_transit_gateway_route_table\.hub\.id/);
  });

  it('sends each workload VPC’s internet traffic to the Transit Gateway', () => {
    for (const spoke of spokes) {
      const route = oneBlock(pack, `resource "aws_route" "${spoke}_default_to_tgw"`);
      expect(route).toMatch(new RegExp(`module\\.${spoke}\\.private_route_table_ids\\[`));
      expect(route).toMatch(/destination_cidr_block\s+=\s+"0\.0\.0\.0\/0"/);
      expect(route).toMatch(
        new RegExp(
          `transit_gateway_id\\s+=\\s+module\\.transit_gateway\\.ec2_transit_gateway_vpc_attachment\\["${spoke}"\\]`
        )
      );
    }
  });

  it('gives the hub per-zone NAT gateways and an internet gateway', () => {
    const vpc = oneBlock(pack, 'module "hub_vpc"');
    expect(vpc).toMatch(/enable_nat_gateway\s+=\s+true/);
    expect(vpc).toMatch(/one_nat_gateway_per_az\s+=\s+true/);
    expect(vpc).toMatch(/single_nat_gateway\s+=\s+false/);
    expect(vpc).toMatch(/public_subnets\s+=/);
    expect(vpc).toMatch(/create_multiple_public_route_tables\s+=\s+true/);
    expect(vpc).toMatch(/create_multiple_intra_route_tables\s+=\s+true/);
  });

  it('gives no workload VPC a NAT gateway of its own, so egress goes through the hub', () => {
    for (const spoke of spokes.filter((s) => s !== 'identity_spoke_vpc')) {
      const vpc = oneBlock(pack, `module "${spoke}"`);
      expect(vpc, spoke).not.toMatch(/enable_nat_gateway\s+=\s+true/);
    }
  });
});

describe.each([
  ['the full pack', FULL, SPOKES.full],
  ['three corp spokes and identity', CORP3_FIREWALL, SPOKES.corp3],
])('AWS traffic passes the firewall in %s (#1876)', (_label, state) => {
  const pack = packOf(state);

  it('sends Transit Gateway traffic in each zone to that zone’s firewall endpoint', () => {
    const route = oneBlock(pack, 'resource "aws_route" "hub_tgw_subnet_to_firewall"');
    expect(route).toMatch(/for_each\s+=\s+local\.az_index/);
    expect(route).toMatch(/module\.hub_vpc\.intra_route_table_ids\[each\.value\]/);
    expect(route).toMatch(/destination_cidr_block\s+=\s+"0\.0\.0\.0\/0"/);
    expect(route).toMatch(/vpc_endpoint_id\s+=\s+local\.firewall_endpoint_by_az\[each\.key\]/);
    expect(pack['network-firewall.tf']).toMatch(
      /firewall_endpoint_by_az = \{\s*for s in module\.network_firewall\.status\[0\]\.sync_states :\s*s\.availability_zone => s\.attachment\[0\]\.endpoint_id/
    );
  });

  it('sends inspected traffic for the workload VPCs back to the Transit Gateway', () => {
    const route = oneBlock(pack, 'resource "aws_route" "hub_firewall_subnet_to_spokes"');
    expect(route).toMatch(/module\.hub_vpc\.private_route_table_ids\[each\.value\]/);
    expect(route).toMatch(/destination_cidr_block\s+=\s+var\.spoke_cidr/);
    expect(route).toMatch(/transit_gateway_id\s+=/);
  });

  it('sends replies from the internet back through the same zone’s firewall endpoint', () => {
    const route = oneBlock(pack, 'resource "aws_route" "hub_public_to_firewall"');
    expect(route).toMatch(/module\.hub_vpc\.public_route_table_ids\[each\.value\]/);
    expect(route).toMatch(/destination_cidr_block\s+=\s+var\.spoke_cidr/);
    expect(route).toMatch(/vpc_endpoint_id\s+=\s+local\.firewall_endpoint_by_az\[each\.key\]/);
  });

  it('never lets one workload VPC reach another without passing the firewall', () => {
    // A spoke learning another spoke's range in its own table would skip
    // the 0.0.0.0/0 route to the hub, and so skip the firewall.
    const propagations = blocksOf(
      pack,
      'resource "aws_ec2_transit_gateway_route_table_propagation"'
    );
    expect(propagations.length).toBeGreaterThan(0);
    for (const prop of propagations) {
      expect(prop).not.toMatch(/aws_ec2_transit_gateway_route_table\.spokes\.id/);
    }
    // The spoke table's only route is the default one to the hub.
    expect(blocksOf(pack, 'resource "aws_ec2_transit_gateway_route"')).toHaveLength(1);
  });

  it('does not send the hub’s Transit Gateway traffic straight to a NAT gateway', () => {
    expect(blocksOf(pack, 'resource "aws_route" "hub_tgw_subnet_to_nat"')).toHaveLength(0);
  });
});

describe('AWS hub without a firewall (#1876)', () => {
  const pack = packOf(NO_FIREWALL);

  it('sends the hub’s Transit Gateway traffic to the same zone’s NAT gateway', () => {
    const route = oneBlock(pack, 'resource "aws_route" "hub_tgw_subnet_to_nat"');
    expect(route).toMatch(/module\.hub_vpc\.intra_route_table_ids\[each\.value\]/);
    expect(route).toMatch(/nat_gateway_id\s+=\s+module\.hub_vpc\.natgw_ids\[each\.value\]/);
  });

  it('sends replies for the workload VPCs from the public subnets to the Transit Gateway', () => {
    const route = oneBlock(pack, 'resource "aws_route" "hub_public_to_spokes"');
    expect(route).toMatch(/module\.hub_vpc\.public_route_table_ids\[each\.value\]/);
    expect(route).toMatch(/destination_cidr_block\s+=\s+var\.spoke_cidr/);
  });

  it('lets workload VPCs reach each other directly', () => {
    const prop = oneBlock(
      pack,
      'resource "aws_ec2_transit_gateway_route_table_propagation" "spokes_to_spokes"'
    );
    expect(prop).toMatch(/aws_ec2_transit_gateway_route_table\.spokes\.id/);
  });

  it('writes no firewall routes and no firewall subnets', () => {
    expect(pack['network-firewall.tf']).toBeUndefined();
    expect(oneBlock(pack, 'module "hub_vpc"')).not.toMatch(/private_subnets/);
  });
});

describe('AWS identity VPC address range (#1876)', () => {
  it('takes its own slice of the spoke range, not the whole range every spoke shares', () => {
    const vpc = oneBlock(packOf(FULL), 'module "identity_spoke_vpc"');
    expect(vpc).not.toMatch(/cidr\s+=\s+var\.spoke_cidr\n/);
    expect(vpc).toMatch(/cidr\s+=\s+cidrsubnet\(var\.spoke_cidr, 4, 15\)/);
  });
});

describe('AWS pack README says how traffic flows (#1876)', () => {
  it('describes the path through the firewall, and no longer says traffic skips it', () => {
    const readme = packOf(FULL)['README.md'];
    expect(readme).toContain('## How traffic flows');
    expect(readme).toMatch(/firewall endpoint in the same Availability Zone → NAT gateway/);
    expect(readme).not.toMatch(/does not yet send traffic/);
  });

  it('says plainly that nothing inspects traffic when the firewall is not selected', () => {
    const readme = packOf(NO_FIREWALL)['README.md'];
    expect(readme).toContain('## How traffic flows');
    expect(readme).toMatch(/Nothing inspects this traffic/);
    expect(readme).not.toContain('## Network Firewall: what it allows');
  });
});
