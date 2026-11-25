import { block, file, joinBlocks, q } from '../format';

// `spec` and `rules` are nested blocks in the google provider, so they are
// written without `=`; the `=` form failed `terraform validate`.

export function orgPoliciesTf() {
  const blocks = [];

  // Org Policy: Deny external IP addresses on Corp compute instances
  blocks.push(
    block('resource "google_org_policy_policy" "deny_external_ip"', [
      ['name', q('folders/\${google_folder.corp.folder_id}/policies/compute.vmExternalIpAccess')],
      ['parent', 'google_folder.corp.name'],
      ...block('spec', block('rules', [['deny_all', q('TRUE')]])),
    ])
  );

  // Org Policy: Require Shielded VM protection
  blocks.push(
    block('resource "google_org_policy_policy" "require_shielded_vm"', [
      [
        'name',
        q('folders/\${google_folder.workloads.folder_id}/policies/compute.requireShieldedVm'),
      ],
      ['parent', 'google_folder.workloads.name'],
      ...block('spec', block('rules', [['enforce', q('TRUE')]])),
    ])
  );

  // Org Policy: Disable service account key creation
  blocks.push(
    block('resource "google_org_policy_policy" "disable_sa_keys"', [
      [
        'name',
        q(
          'folders/\${google_folder.platform.folder_id}/policies/iam.disableServiceAccountKeyCreation'
        ),
      ],
      ['parent', 'google_folder.platform.name'],
      ...block('spec', block('rules', [['enforce', q('TRUE')]])),
    ])
  );

  return file('org-policies.tf', joinBlocks(blocks));
}
