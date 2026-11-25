/**
 * Google Cloud module versions and provider constraints (#Deliverable04).
 * Pinned to official terraform-google-modules registry releases to ensure
 * deterministic, reproducible synthesis.
 */
import { registryModule } from '../cloudPack';

export const GCP_MODULES = Object.freeze({
  network: registryModule(
    'terraform-google-modules/network/google',
    '10.0.0',
    'Shared VPC Host network, subnets, Cloud Router, and Cloud NAT.'
  ),
  logExport: registryModule(
    'terraform-google-modules/log-export/google',
    '9.0.0',
    'Organization-level aggregated log sink and central Cloud Storage bucket.'
  ),
  projectFactory: registryModule(
    'terraform-google-modules/project-factory/google',
    '17.1.0',
    'Creates service projects and attaches them to the central Shared VPC Host.'
  ),
});

export const GCP_PROVIDER_PIN = '~> 6.15';
export const GCP_VERIFIED_ON = '2026-10-14';
