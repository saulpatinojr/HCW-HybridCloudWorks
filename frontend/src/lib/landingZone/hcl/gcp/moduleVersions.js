/**
 * Google Cloud module versions and provider constraints (#Deliverable04).
 * Pinned to official terraform-google-modules registry releases to ensure
 * deterministic, reproducible synthesis.
 *
 * Each `requires` is what that release asks of Terraform and its providers,
 * read on GCP_VERIFIED_ON from its versions.tf and those of the submodules it
 * calls, keeping the tightest bound for each provider
 * (https://raw.githubusercontent.com/terraform-google-modules/terraform-google-<name>/v<version>/versions.tf).
 * cloudModuleVersions.test.js fails when GCP_PROVIDER_PIN or the shared Terraform
 * rule falls outside one of them, and when two modules ask for provider
 * ranges that do not meet.
 *
 * Why log-export is on 10.0.0 (#1863). 9.0.0 asked for google `< 6`, which
 * no google 6.x provider meets, so `terraform init` failed. 10.0.0 is the
 * first release that accepts google 6 (its breaking changes are that
 * floor, Terraform 1.3 and a new optional `intercept_children` input). 11.x
 * and 12.x also accept 6.x, but change only the BigQuery alerting
 * submodule this pack does not use. network 10.0.0 and project-factory
 * 17.1.0 stop at google `< 7`, so the pack stays on google 6.
 *
 * logStorage is log-export's own Cloud Storage destination
 * (`modules/storage`), at the same release as the sink. It makes the bucket
 * and grants the sink's writer identity `roles/storage.objectCreator` on it,
 * which Google needs before it accepts a single log (#1870). It replaces the
 * cloud-storage `simple_bucket` 7.0.0 the pack used before, which made the
 * bucket but left the sink unable to write to it. It calls no kms module,
 * so the google `< 6` clash that pin had to dodge (#1863) cannot come back
 * through it. A module's `requires` includes what the registry modules it
 * calls ask for, because Terraform checks them all together.
 */
import { registryModule } from '../cloudPack';

export const GCP_VERIFIED_ON = '2026-11-25';

export const GCP_MODULES = Object.freeze({
  network: registryModule(
    'terraform-google-modules/network/google',
    '10.0.0',
    'Shared VPC Host network, subnets, Cloud Router, and Cloud NAT.',
    // google-beta's floor comes from the vpc submodule, not the root.
    {
      terraform: '>= 1.3',
      readAt: '10.0.0',
      providers: { google: '>= 4.64, < 7', 'google-beta': '>= 6.13, < 7' },
    }
  ),
  logExport: registryModule(
    'terraform-google-modules/log-export/google',
    '10.0.0',
    'Organization-level aggregated log sink and central Cloud Storage bucket.',
    { terraform: '>= 1.3', readAt: '10.0.0', providers: { google: '>= 5.27, < 7' } }
  ),
  logStorage: registryModule(
    'terraform-google-modules/log-export/google//modules/storage',
    '10.0.0',
    'The Cloud Storage bucket the organization log sink writes to, with the sink allowed to write.',
    // From modules/storage/versions.tf at v10.0.0; it calls no other module.
    { terraform: '>= 1.3', readAt: '10.0.0', providers: { google: '>= 5.22, < 7' } }
  ),
  projectFactory: registryModule(
    'terraform-google-modules/project-factory/google',
    '17.1.0',
    'Creates service projects and attaches them to the central Shared VPC Host.',
    // core_project_factory adds null, random and time; gsuite is only in a
    // submodule the root does not call.
    {
      terraform: '>= 0.13',
      readAt: '17.1.0',
      providers: {
        google: '>= 5.41, < 7',
        'google-beta': '>= 5.41, < 7',
        null: '>= 2.1',
        random: '>= 2.2',
        time: '>= 0.5',
      },
    }
  ),
});

/** The google provider line in the pack's terraform.tf. */
export const GCP_PROVIDER_PIN = '~> 6.15';
