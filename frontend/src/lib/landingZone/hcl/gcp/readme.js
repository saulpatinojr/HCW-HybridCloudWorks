import { cloudReadme } from '../cloudPack';
import { GCP_MODULES, GCP_PROVIDER_PIN, TERRAFORM_REQUIRED_VERSION } from './moduleVersions';

export function readmeMd(state, files) {
  return cloudReadme({
    title: 'Google Cloud Landing Zone Foundation Architecture',
    summary:
      'It deploys a Google Cloud Enterprise Foundations environment featuring Resource Manager folders, organization policies, central log export, Shared VPC Host networking, and isolated service projects.',
    files,
    modules: [
      ['Shared VPC & Subnets', GCP_MODULES.network],
      ['Organization Log Export', GCP_MODULES.logExport],
      ['Service Project Factory', GCP_MODULES.projectFactory],
    ],
    terraformVersion: TERRAFORM_REQUIRED_VERSION,
    providerLine: `- **Google Provider**: \`hashicorp/google ${GCP_PROVIDER_PIN}\``,
    guardrails: [
      '- **Resource Hierarchy**: Dedicated `Platform` and `Workloads` folders underneath the Organization root.',
      '- **Organization Policies**: Restricts public IP allocation (`compute.vmExternalIpAccess = DENY`) and enforces Shielded VMs.',
      '- **Central Audit Logging**: Organization-level log sink aggregating administrative audit activity into a centralized Cloud Storage bucket.',
    ],
  });
}
