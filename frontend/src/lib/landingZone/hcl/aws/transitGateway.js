import { block, file, joinBlocks, list, obj, q } from '../format';
import { AWS_MODULES } from './moduleVersions';

export function transitGatewayTf() {
  const blocks = [];
  const tgwModule = AWS_MODULES.transitGateway;

  blocks.push(
    block('module "transit_gateway"', [
      ['source', q(tgwModule.source)],
      ['version', q(tgwModule.version)],
      ['name', q('hub-tgw')],
      ['description', q('Central AWS Transit Gateway for hub-and-spoke interconnect')],
      ['amazon_side_asn', '64512'],
      ['enable_auto_accept_shared_attachments', 'true'],
      ['enable_default_route_table_association', 'false'],
      ['enable_default_route_table_propagation', 'false'],
      ['ram_allow_external_principals', 'false'],
      ['ram_principals', list(['aws_organizations_organization.org.arn'])],
      ['tags', obj([['Role', q('HubInterconnect')]])],
    ])
  );

  return file('transit-gateway.tf', joinBlocks(blocks));
}
