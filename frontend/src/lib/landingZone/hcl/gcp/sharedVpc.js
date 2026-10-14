import { block, file, joinBlocks, list, obj, q } from '../format';
import { GCP_MODULES } from './moduleVersions';

export function sharedVpcTf() {
  const blocks = [];
  const netModule = GCP_MODULES.network;

  // Shared VPC Host Network & Subnets
  blocks.push(
    block('module "shared_vpc_host"', [
      ['source', q(netModule.source)],
      ['version', q(netModule.version)],
      ['project_id', 'var.host_project_id'],
      ['network_name', q('shared-vpc-host')],
      ['shared_vpc_host', 'true'],
      [
        'subnets',
        list([
          obj([
            ['subnet_name', q('sb-corp-private')],
            ['subnet_ip', 'cidrsubnet(var.spoke_cidr, 4, 1)'],
            ['subnet_region', 'var.gcp_region'],
            ['subnet_private_access', q('true')],
          ]),
          obj([
            ['subnet_name', q('sb-online-edge')],
            ['subnet_ip', 'cidrsubnet(var.spoke_cidr, 4, 2)'],
            ['subnet_region', 'var.gcp_region'],
            ['subnet_private_access', q('true')],
          ]),
        ]),
      ],
    ])
  );

  // Cloud Router and Cloud NAT for secure private egress
  blocks.push(
    block('resource "google_compute_router" "nat_router"', [
      ['name', q('cr-shared-vpc-egress')],
      ['project', 'var.host_project_id'],
      ['region', 'var.gcp_region'],
      ['network', 'module.shared_vpc_host.network_id'],
    ])
  );

  blocks.push(
    block('resource "google_compute_router_nat" "nat_gateway"', [
      ['name', q('nat-shared-vpc-egress')],
      ['project', 'var.host_project_id'],
      ['router', 'google_compute_router.nat_router.name'],
      ['region', 'var.gcp_region'],
      ['nat_ip_allocate_option', q('AUTO_ONLY')],
      ['source_subnetwork_ip_ranges_to_nat', q('ALL_SUBNETWORKS_ALL_IP_RANGES')],
    ])
  );

  return file('shared-vpc.tf', joinBlocks(blocks));
}
