/**
 * AWS module versions and provider constraints (#Deliverable04).
 * Pinned to official terraform-aws-modules registry releases to ensure
 * deterministic, reproducible synthesis.
 */
import { registryModule } from '../cloudPack';

export const AWS_MODULES = Object.freeze({
  vpc: registryModule(
    'terraform-aws-modules/vpc/aws',
    '5.19.0',
    'Standard VPC with private subnets, route tables, and NAT gateways.'
  ),
  transitGateway: registryModule(
    'terraform-aws-modules/transit-gateway/aws',
    '2.13.0',
    'Central Transit Gateway (TGW) with route domains and RAM resource shares.'
  ),
  networkFirewall: registryModule(
    'terraform-aws-modules/network-firewall/aws',
    '1.1.0',
    'Stateful AWS Network Firewall and rule groups inside Inspection VPC.'
  ),
});

export const AWS_PROVIDER_PIN = '~> 5.80';
export const AWS_VERIFIED_ON = '2026-10-14';
