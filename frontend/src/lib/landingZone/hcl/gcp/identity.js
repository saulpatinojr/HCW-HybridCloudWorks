import { block, file, joinBlocks, key, obj, q } from '../format';

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
          // Quoted keys: a bare `google.subject` reads as a reference.
          [key('google.subject'), q('assertion.sub')],
          [key('attribute.repository'), q('assertion.repository')],
        ]),
      ],
      // `oidc` is a nested block in the google provider, not an attribute.
      ...block('oidc', [['issuer_uri', q('https://token.actions.githubusercontent.com')]]),
    ])
  );

  return file('identity.tf', joinBlocks(blocks));
}
