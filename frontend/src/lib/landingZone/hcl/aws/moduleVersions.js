/**
 * AWS module versions and provider constraints (#Deliverable04).
 * Pinned to official terraform-aws-modules registry releases to ensure
 * deterministic, reproducible synthesis.
 */

export const AWS_MODULES = Object.freeze({
  vpc: Object.freeze({
    name: 'terraform-aws-modules/vpc/aws',
    source: 'terraform-aws-modules/vpc/aws',
    version: '5.19.0',
    summary: 'Standard VPC with private subnets, route tables, and NAT gateways.',
  }),
  transitGateway: Object.freeze({
    name: 'terraform-aws-modules/transit-gateway/aws',
    source: 'terraform-aws-modules/transit-gateway/aws',
    version: '2.13.0',
    summary: 'Central Transit Gateway (TGW) with route domains and RAM resource shares.',
  }),
  networkFirewall: Object.freeze({
    name: 'terraform-aws-modules/network-firewall/aws',
    source: 'terraform-aws-modules/network-firewall/aws',
    version: '1.1.0',
    summary: 'Stateful AWS Network Firewall and rule groups inside Inspection VPC.',
  }),
});

export const AWS_PROVIDER_PIN = '~> 5.80';
export const TERRAFORM_REQUIRED_VERSION = '>= 1.9.0';
export const AWS_VERIFIED_ON = '2026-10-14';
