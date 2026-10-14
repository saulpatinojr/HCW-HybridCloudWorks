/**
 * Google Cloud module versions and provider constraints (#Deliverable04).
 * Pinned to official terraform-google-modules registry releases to ensure
 * deterministic, reproducible synthesis.
 */

export const GCP_MODULES = Object.freeze({
  network: Object.freeze({
    name: 'terraform-google-modules/network/google',
    source: 'terraform-google-modules/network/google',
    version: '10.0.0',
    summary: 'Shared VPC Host network, subnets, Cloud Router, and Cloud NAT.',
  }),
  logExport: Object.freeze({
    name: 'terraform-google-modules/log-export/google',
    source: 'terraform-google-modules/log-export/google',
    version: '9.0.0',
    summary: 'Organization-level aggregated log sink and central Cloud Storage bucket.',
  }),
  projectFactory: Object.freeze({
    name: 'terraform-google-modules/project-factory/google',
    source: 'terraform-google-modules/project-factory/google',
    version: '17.1.0',
    summary: 'Creates service projects and attaches them to the central Shared VPC Host.',
  }),
});

export const GCP_PROVIDER_PIN = '~> 6.15';
export const TERRAFORM_REQUIRED_VERSION = '>= 1.9.0';
export const GCP_VERIFIED_ON = '2026-10-14';
