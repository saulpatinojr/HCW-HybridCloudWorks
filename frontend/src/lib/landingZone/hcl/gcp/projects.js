import { block, file, joinBlocks, list, q } from '../format';
import { isSelected } from '../../state';
import { GCP_MODULES } from './moduleVersions';

// The APIs every service project switches on.
const SERVICE_PROJECT_APIS = [
  'compute.googleapis.com',
  'container.googleapis.com',
  'logging.googleapis.com',
  'monitoring.googleapis.com',
];

/**
 * The subnet's path, read from the network module in shared-vpc.tf. The
 * module keys its `subnets` output by "<region>/<name>", and each value's
 * `id` is the "projects/<host>/regions/<region>/subnetworks/<name>" path
 * project-factory asks for. Typing that path out instead gave Terraform no
 * link between the two, so it could attach a project before the subnet
 * existed (#1870).
 */
const subnetId = (subnet) => `module.shared_vpc_host.subnets["\${var.gcp_region}/${subnet}"].id`;

/**
 * One project-factory module for workload `i` of a kind (`corp` or `online`).
 * The host project also comes from the network module, which is what
 * switches it on as a Shared VPC host; the attachment fails until it is.
 * The network module is always present here: corp and online depend on
 * connectivity-hub, so the builder never emits projects without it.
 */
function serviceProject(kind, i, subnet) {
  const pfModule = GCP_MODULES.projectFactory;
  return block(`module "${kind}_service_project_${i}"`, [
    ['source', q(pfModule.source)],
    ['version', q(pfModule.version)],
    ['name', q(`prj-${kind}-workload-${i}`)],
    ['random_project_id', 'true'],
    ['org_id', 'var.organization_id'],
    ['billing_account', 'var.billing_account_id'],
    ['folder_id', `google_folder.${kind}.folder_id`],
    ['svpc_host_project_id', 'module.shared_vpc_host.project_id'],
    ['shared_vpc_subnets', list([subnetId(subnet)])],
    ['activate_apis', list(SERVICE_PROJECT_APIS.map(q))],
  ]);
}

export function projectsTf(state) {
  const blocks = [];
  const corpCount = isSelected(state, 'corp') ? Number(state.options?.corpCount ?? 1) : 0;
  const onlineCount = isSelected(state, 'online') ? Number(state.options?.onlineCount ?? 1) : 0;

  for (let i = 1; i <= corpCount; i += 1) {
    blocks.push(serviceProject('corp', i, 'sb-corp-private'));
  }

  for (let i = 1; i <= onlineCount; i += 1) {
    blocks.push(serviceProject('online', i, 'sb-online-edge'));
  }

  return file('projects.tf', joinBlocks(blocks));
}
