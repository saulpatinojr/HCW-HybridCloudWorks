import { block, file, joinBlocks, key, obj, q } from '../format';

/**
 * The variable that names the GitHub organisation allowed to sign in. It is
 * emitted with identity.tf, and only then (see variables.js).
 *
 * GitHub signs every repository's tokens with the same issuer, so without a
 * condition the provider would trust a workflow in anyone's repository, and
 * Google refuses to create such a provider at all
 * (https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines).
 * There is no default on purpose: the user has to say whose workflows may
 * sign in. The value is placed inside a quoted condition, so the check lets
 * through only what a GitHub name can hold (letters, digits and single
 * hyphens, at most 39 characters), which also keeps a quote out of it.
 */
const GITHUB_NAME = '^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$';

export function githubOrganizationVariable() {
  return block('variable "github_organization"', [
    [
      'description',
      q(
        'GitHub organisation (or user) whose Actions workflows may sign in to Google Cloud, exactly as GitHub shows it. Required.'
      ),
    ],
    ['type', 'string'],
    '',
    ...block('validation', [
      [
        'condition',
        `length(var.github_organization) <= 39 && can(regex(${q(GITHUB_NAME)}, var.github_organization))`,
      ],
      [
        'error_message',
        q(
          'github_organization must be a GitHub organisation or user name: letters, digits and single hyphens, not starting or ending with a hyphen, at most 39 characters.'
        ),
      ],
    ]),
  ]);
}

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

  // GitHub Actions provider. It accepts a token only when the repository's
  // owner is the organisation in var.github_organization (#1870).
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
          [key('attribute.repository_owner'), q('assertion.repository_owner')],
        ]),
      ],
      ['attribute_condition', q("assertion.repository_owner == '\${var.github_organization}'")],
      // `oidc` is a nested block in the google provider, not an attribute.
      ...block('oidc', [['issuer_uri', q('https://token.actions.githubusercontent.com')]]),
    ])
  );

  return file('identity.tf', joinBlocks(blocks));
}
