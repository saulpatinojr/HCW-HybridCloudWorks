/**
 * Google Cloud module versions and provider constraints (#Deliverable04).
 * Pinned to official terraform-google-modules registry releases to ensure
 * deterministic, reproducible synthesis.
 *
 * Each `requires` is what that release asks of Terraform and its providers,
 * read on GCP_VERIFIED_ON from its versions.tf and those of the submodules it
 * calls, keeping the tightest bound for each provider
 * (https://raw.githubusercontent.com/terraform-google-modules/terraform-google-<name>/v<version>/versions.tf).
 * moduleVersions.test.js fails when GCP_PROVIDER_PIN or the shared Terraform
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
 * cloudStorage is the `simple_bucket` submodule: one named bucket, which is
 * what the log sink writes to. It was written straight into loggingSink.js
 * as the root module at `~> 6.0`, which takes a list of `names`, not `name`,
 * so `terraform init` refused the call. 6.x also fails for a second reason:
 * simple_bucket calls the kms module at `~> 2.0`, which asks for google
 * `< 6`. 7.0.0 is the first release whose kms call (`~> 3.0`, google
 * `>= 5.31, < 7`) accepts google 6; its other breaking change renames a
 * lifecycle field this pack does not set. A module's `requires` includes
 * what the registry modules it calls ask for, because Terraform checks them
 * all together.
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
      providers: { google: '>= 4.64, < 7', 'google-beta': '>= 6.13, < 7' },
    }
  ),
  logExport: registryModule(
    'terraform-google-modules/log-export/google',
    '10.0.0',
    'Organization-level aggregated log sink and central Cloud Storage bucket.',
    { terraform: '>= 1.3', providers: { google: '>= 5.27, < 7' } }
  ),
  cloudStorage: registryModule(
    'terraform-google-modules/cloud-storage/google//modules/simple_bucket',
    '7.0.0',
    'The Cloud Storage bucket the organization log sink writes to.',
    // Its own floor is google >= 5.43; the kms 3.x module it calls stops at < 7.
    { terraform: '>= 0.13', providers: { google: '>= 5.43, < 7' } }
  ),
  projectFactory: registryModule(
    'terraform-google-modules/project-factory/google',
    '17.1.0',
    'Creates service projects and attaches them to the central Shared VPC Host.',
    // core_project_factory adds null, random and time; gsuite is only in a
    // submodule the root does not call.
    {
      terraform: '>= 0.13',
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
