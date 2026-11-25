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

/** One project-factory module for workload `i` of a kind (`corp` or `online`). */
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
    ['shared_vpc', 'var.host_project_id'],
    ['shared_vpc_subnets', list([q(subnet)])],
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
