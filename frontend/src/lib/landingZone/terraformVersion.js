/**
 * The one Terraform version rule every generated pack writes into its
 * `terraform.tf` (#1860). Azure, AWS and Google Cloud all read it from here,
 * so one Terraform binary can run any pack the builder produces.
 *
 * Why `>= 1.12, < 2.0`:
 *
 *   - The floor of 1.12 comes from Azure. Two of the pinned Azure Verified
 *     Modules need it (avm-ptn-alz 0.22.0 says `>= 1.12, < 2.0`, connectivity
 *     0.18.1 says `~> 1.12`); the per-module table is in avmVersions.js.
 *   - AWS and Google Cloud ask for less, so the same floor satisfies them.
 *     Each pinned module's own `required_version`, read on 2026-11-25 from
 *     its versions.tf at the pinned tag
 *     (https://raw.githubusercontent.com/<org>/<repo>/v<version>/versions.tf):
 *
 *       terraform-aws-vpc 5.19.0                 >= 1.0
 *       terraform-aws-transit-gateway 2.13.0     >= 0.13.1
 *       terraform-aws-network-firewall 1.0.2     >= 1.0 (was 1.1.0, which was
 *                                                never published, #1862)
 *       terraform-google-network 10.0.0          >= 1.3
 *       terraform-google-log-export 10.0.0       >= 1.3 (was 9.0.0, #1863)
 *       terraform-google-project-factory 17.1.0  >= 0.13.0
 *       terraform-google-cloud-storage 7.0.0     >= 0.13 (simple_bucket)
 *
 *     None sets an upper bound. Each module's full record, providers
 *     included, is its `requires` in hcl/aws/moduleVersions.js and
 *     hcl/gcp/moduleVersions.js, and hcl/cloudModuleVersions.test.js checks
 *     it against this line. Providers carry no Terraform version of their
 *     own: the registry lists aws 5.80 and google 6.15 on plugin protocol 5,
 *     which every Terraform 1.x speaks.
 *   - `< 2.0` keeps a future major release, which may break the language,
 *     from being picked up without someone checking the packs first.
 *
 * The lab image ships a Terraform inside this range
 * (lab-image/versions.env, TERRAFORM_VERSION). A module bump that raises a
 * floor above 1.12 raises this line, and its row above changes with it.
 *
 * The lab's own Terraform (the catalogue's samples, the lab image's smoke
 * roots and the Coder templates) states this same rule (#1864), so raising it
 * raises theirs: catalogue.js reads it from here, and
 * scripts/lab-terraform-version.test.mjs fails until the .tf files match.
 */
export const TERRAFORM_REQUIRED_VERSION = '>= 1.12, < 2.0';
