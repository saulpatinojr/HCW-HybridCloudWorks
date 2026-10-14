import { block, file, joinBlocks, obj, q } from '../format';

export function identityTf() {
  const blocks = [];

  // Workload Identity Pool
  blocks.push(
    block('resource "google_iam_workload_identity_pool" "pool"', [
      ['workload_identity_pool_id', q('hcw-workload-pool')],
      ['project', 'var.host_project_id'],
      ['display_name', q('Enterprise Workload Identity Pool')],
      ['description', q('Federated OIDC authentication for automated infrastructure pipelines')],
    ])
  );

  // OIDC Provider
  blocks.push(
    block('resource "google_iam_workload_identity_pool_provider" "oidc_provider"', [
      [
        'workload_identity_pool_id',
        'google_iam_workload_identity_pool.pool.workload_identity_pool_id',
      ],
      ['workload_identity_pool_provider_id', q('oidc-provider')],
      ['project', 'var.host_project_id'],
      ['display_name', q('OIDC Provider')],
      [
        'attribute_mapping',
        obj([
          ['google.subject', q('assertion.sub')],
          ['attribute.repository', q('assertion.repository')],
        ]),
      ],
      ['oidc', obj([['issuer_uri', q('https://token.actions.githubusercontent.com')]])],
    ])
  );

  return file('identity.tf', joinBlocks(blocks));
}
