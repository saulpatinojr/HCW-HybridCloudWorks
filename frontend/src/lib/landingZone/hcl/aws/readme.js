import { cloudReadme } from '../cloudPack';
import { AWS_MODULES, AWS_PROVIDER_PIN, TERRAFORM_REQUIRED_VERSION } from './moduleVersions';

export function readmeMd(state, files) {
  return cloudReadme({
    title: 'AWS Landing Zone Foundation Architecture',
    summary:
      'It deploys a multi-account AWS Organizations environment with a central Transit Gateway hub, stateful inspection, and standardized workload VPCs.',
    files,
    modules: [
      ['Transit Gateway', AWS_MODULES.transitGateway],
      ['VPC & Subnets', AWS_MODULES.vpc],
      ['Network Firewall', AWS_MODULES.networkFirewall],
    ],
    terraformVersion: TERRAFORM_REQUIRED_VERSION,
    providerLine: `- **AWS Provider**: \`hashicorp/aws ${AWS_PROVIDER_PIN}\``,
    guardrails: [
      '- **AWS Organizations Root**: Central multi-account structure with Security, Infrastructure, and Workloads OUs.',
      '- **Service Control Policies (SCPs)**: Guardrails denying root account usage, enforcing IMDSv2 tokens, and blocking public S3 buckets.',
      '- **Central Audit Logging**: Aggregated multi-region CloudTrail and AWS Config stored in a dedicated KMS-encrypted audit bucket.',
    ],
  });
}
