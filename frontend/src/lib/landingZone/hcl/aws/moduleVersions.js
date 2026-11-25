/**
 * AWS module versions and provider constraints (#Deliverable04).
 * Pinned to official terraform-aws-modules registry releases to ensure
 * deterministic, reproducible synthesis.
 *
 * Each `requires` is what that release asks of Terraform and the aws
 * provider, read on AWS_VERIFIED_ON from its versions.tf and those of the
 * submodules it calls
 * (https://raw.githubusercontent.com/terraform-aws-modules/terraform-aws-<name>/v<version>/versions.tf).
 * cloudModuleVersions.test.js fails when AWS_PROVIDER_PIN or the shared Terraform
 * rule falls outside one of them.
 *
 * Why network-firewall is on 1.0.2 and not 2.x (#1862). The old pin, 1.1.0,
 * was never published, so `terraform init` could not find it. Every 2.x
 * release needs aws `>= 6.5` (2.3.0 needs `>= 6.28`), and this pack pins aws
 * 5.x, as vpc 5.19.0 was written for. Moving to 2.x means moving the whole
 * pack to aws 6, with vpc and transit-gateway majors to match: a separate
 * change. 1.0.2 is the newest release that works with aws 5.x, and its
 * inputs are the ones the generator writes.
 */
// With its `.js` ending, so plain Node can load this file (see registryModule.js).
import { registryModule } from '../registryModule.js';

export const AWS_VERIFIED_ON = '2026-11-25';

export const AWS_MODULES = Object.freeze({
  vpc: registryModule(
    'terraform-aws-modules/vpc/aws',
    '5.19.0',
    'Standard VPC with private subnets, route tables, and NAT gateways.',
    { terraform: '>= 1.0', readAt: '5.19.0', providers: { aws: '>= 5.79' } }
  ),
  transitGateway: registryModule(
    'terraform-aws-modules/transit-gateway/aws',
    '2.13.0',
    'Central Transit Gateway (TGW) with route domains and RAM resource shares.',
    { terraform: '>= 0.13.1', readAt: '2.13.0', providers: { aws: '>= 4.4' } }
  ),
  networkFirewall: registryModule(
    'terraform-aws-modules/network-firewall/aws',
    '1.0.2',
    'Stateful AWS Network Firewall and rule groups inside Inspection VPC.',
    // The root module declares no provider; its firewall and policy
    // submodules each ask for aws >= 5.2.
    { terraform: '>= 1.0', readAt: '1.0.2', providers: { aws: '>= 5.2' } }
  ),
});

/** The aws provider line in the pack's terraform.tf. */
export const AWS_PROVIDER_PIN = '~> 5.80';
