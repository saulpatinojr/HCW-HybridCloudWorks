import { cloudReadme } from '../cloudPack';
import { TERRAFORM_REQUIRED_VERSION } from '../../terraformVersion';
import { GCP_MODULES, GCP_PROVIDER_PIN } from './moduleVersions';

// Said in the README whenever identity.tf is in the pack, because the
// variable has no default and Terraform stops until it is set (#1870).
const GITHUB_SIGN_IN =
  '- **GitHub Sign-in (you must set this)**: `identity.tf` lets GitHub Actions workflows sign in to Google Cloud without a stored key, but only from one GitHub organisation. Set `github_organization` in your `terraform.tfvars` to your organisation (or user) name, exactly as GitHub shows it. There is no default on purpose: Terraform stops and asks until it is set, and tokens from any other organisation are refused.';

export function readmeMd(state, files) {
  const hasIdentity = files.some((f) => f.path === 'identity.tf');
  return cloudReadme({
    title: 'Google Cloud Landing Zone Foundation Architecture',
    summary:
      'It deploys a Google Cloud Enterprise Foundations environment featuring Resource Manager folders, organization policies, central log export, Shared VPC Host networking, and isolated service projects.',
    files,
    modules: [
      ['Shared VPC & Subnets', GCP_MODULES.network],
      ['Organization Log Export', GCP_MODULES.logExport],
      ['Audit Log Bucket', GCP_MODULES.logStorage],
      ['Service Project Factory', GCP_MODULES.projectFactory],
    ],
    terraformVersion: TERRAFORM_REQUIRED_VERSION,
    providerLine: `- **Google Provider**: \`hashicorp/google ${GCP_PROVIDER_PIN}\``,
    guardrails: [
      '- **Resource Hierarchy**: Dedicated `Platform` and `Workloads` folders underneath the Organization root.',
      '- **Organization Policies**: Restricts public IP allocation (`compute.vmExternalIpAccess = DENY`) and enforces Shielded VMs.',
      '- **Central Audit Logging**: Organization-level log sink aggregating administrative audit activity into a centralized Cloud Storage bucket. The sink is given permission to write into that bucket, and nothing more.',
      ...(hasIdentity ? [GITHUB_SIGN_IN] : []),
    ],
  });
}
