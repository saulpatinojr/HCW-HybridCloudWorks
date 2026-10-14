import { block, file, joinBlocks, obj, q } from '../format';

export function orgPoliciesTf() {
  const blocks = [];

  // Org Policy: Deny external IP addresses on Corp compute instances
  blocks.push(
    block('resource "google_org_policy_policy" "deny_external_ip"', [
      ['name', q('folders/\${google_folder.corp.folder_id}/policies/compute.vmExternalIpAccess')],
      ['parent', 'google_folder.corp.name'],
      ['spec', obj([['rules', obj([['deny_all', q('TRUE')]])]])],
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
      ['spec', obj([['rules', obj([['enforce', q('TRUE')]])]])],
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
      ['spec', obj([['rules', obj([['enforce', q('TRUE')]])]])],
    ])
  );

  return file('org-policies.tf', joinBlocks(blocks));
}
