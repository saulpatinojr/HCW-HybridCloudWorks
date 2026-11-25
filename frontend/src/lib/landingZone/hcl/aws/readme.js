import { cloudReadme } from '../cloudPack';
import { TERRAFORM_REQUIRED_VERSION } from '../../terraformVersion';
import { isSelected } from '../../state';
import { AWS_MODULES, AWS_PROVIDER_PIN } from './moduleVersions';
import { ALLOW_LIST_VARIABLE } from './networkFirewall';

// What the hub firewall lets through, said plainly, because its default is
// to allow nothing and a reader should learn that here, not from an outage
// (#1871).
const FIREWALL_SECTION = [
  '## Network Firewall: what it allows',
  '',
  'Out of the box the hub firewall **allows nothing**. Every packet that is routed through it is inspected, and any connection that no rule allows is dropped. That includes web traffic, other TCP traffic such as SSH, and all UDP and ICMP traffic.',
  '',
  `To let workloads reach a website or API over HTTP or HTTPS, add its domain to \`${ALLOW_LIST_VARIABLE}\` in your \`terraform.tfvars\`, then run \`terraform plan\` and \`terraform apply\`:`,
  '',
  '```hcl',
  `${ALLOW_LIST_VARIABLE} = [`,
  '  "api.example.com", # exactly this name',
  '  ".example.org",    # this domain and every subdomain',
  ']',
  '```',
  '',
  'The firewall matches the name the client asks for (the HTTP `Host` header, or the server name in the TLS handshake). It does not decrypt traffic.',
  '',
  'Anything other than web traffic needs its own stateful rule group, added to `policy_stateful_rule_group_reference` in `network-firewall.tf`.',
  '',
  'How the policy decides:',
  '',
  '- Every packet, whole or fragmented, goes to the stateful engine (`aws:forward_to_sfe`); nothing is passed without inspection.',
  '- Rules are evaluated in the order they are written (`STRICT_ORDER`).',
  '- A connection no rule allowed is dropped (`aws:drop_established`). The TCP handshake is let through first so the firewall can read the domain name.',
  '',
  'This pack does not yet send traffic to the firewall: the inspection VPC is not attached to the Transit Gateway and no route table points at the firewall endpoints. Until those routes are added, traffic does not pass through the firewall at all.',
  '',
  'AWS explains these settings in [Firewall policy settings](https://docs.aws.amazon.com/network-firewall/latest/developerguide/firewall-policy-settings.html), [Managing evaluation order](https://docs.aws.amazon.com/network-firewall/latest/developerguide/suricata-rule-evaluation-order.html) and [Stateful domain list rule groups](https://docs.aws.amazon.com/network-firewall/latest/developerguide/stateful-rule-groups-domain-names.html).',
  '',
];

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
    sections: isSelected(state, 'firewall') ? FIREWALL_SECTION : [],
    guardrails: [
      '- **AWS Organizations Root**: Central multi-account structure with Security, Infrastructure, and Workloads OUs.',
      '- **Service Control Policies (SCPs)**: Guardrails denying root account usage, enforcing IMDSv2 tokens, and blocking public S3 buckets.',
      '- **Central Audit Logging**: Aggregated multi-region CloudTrail and AWS Config stored in a dedicated KMS-encrypted audit bucket.',
    ],
  });
}
