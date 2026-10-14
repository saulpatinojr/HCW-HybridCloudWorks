import { block, file, joinBlocks, list, q } from '../format';
import { isSelected } from '../../state';
import { GCP_MODULES } from './moduleVersions';

export function projectsTf(state) {
  const blocks = [];
  const pfModule = GCP_MODULES.projectFactory;
  const corpCount = isSelected(state, 'corp') ? Number(state.options?.corpCount ?? 1) : 0;
  const onlineCount = isSelected(state, 'online') ? Number(state.options?.onlineCount ?? 1) : 0;

  for (let i = 1; i <= corpCount; i += 1) {
    blocks.push(
      block(`module "corp_service_project_${i}"`, [
        ['source', q(pfModule.source)],
        ['version', q(pfModule.version)],
        ['name', q(`prj-corp-workload-${i}`)],
        ['random_project_id', 'true'],
        ['org_id', 'var.organization_id'],
        ['billing_account', 'var.billing_account_id'],
        ['folder_id', 'google_folder.corp.folder_id'],
        ['shared_vpc', 'var.host_project_id'],
        ['shared_vpc_subnets', list([q('sb-corp-private')])],
        [
          'activate_apis',
          list([
            q('compute.googleapis.com'),
            q('container.googleapis.com'),
            q('logging.googleapis.com'),
            q('monitoring.googleapis.com'),
          ]),
        ],
      ])
    );
  }

  for (let i = 1; i <= onlineCount; i += 1) {
    blocks.push(
      block(`module "online_service_project_${i}"`, [
        ['source', q(pfModule.source)],
        ['version', q(pfModule.version)],
        ['name', q(`prj-online-workload-${i}`)],
        ['random_project_id', 'true'],
        ['org_id', 'var.organization_id'],
        ['billing_account', 'var.billing_account_id'],
        ['folder_id', 'google_folder.online.folder_id'],
        ['shared_vpc', 'var.host_project_id'],
        ['shared_vpc_subnets', list([q('sb-online-edge')])],
        [
          'activate_apis',
          list([
            q('compute.googleapis.com'),
            q('container.googleapis.com'),
            q('logging.googleapis.com'),
            q('monitoring.googleapis.com'),
          ]),
        ],
      ])
    );
  }

  return file('projects.tf', joinBlocks(blocks));
}
