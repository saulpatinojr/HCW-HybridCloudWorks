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
  '- A connection no rule allowed is dropped (`aws:drop_established_app_layer_to_server`). The TCP handshake is let through, and the decision waits until the firewall has read the domain name, even when a browser splits it over two packets. Replies from the server are never dropped by this setting.',
  '',
  'AWS explains these settings in [Firewall policy settings](https://docs.aws.amazon.com/network-firewall/latest/developerguide/firewall-policy-settings.html), [Managing evaluation order](https://docs.aws.amazon.com/network-firewall/latest/developerguide/suricata-rule-evaluation-order.html) and [Stateful domain list rule groups](https://docs.aws.amazon.com/network-firewall/latest/developerguide/stateful-rule-groups-domain-names.html).',
  '',
];

// How a packet gets from a workload VPC to the internet or to another
// workload VPC, in the order it travels (#1876). Two versions, because the
// path depends on whether the firewall is in the build.
const TRAFFIC_INTRO = [
  '## How traffic flows',
  '',
  'Every workload VPC is attached to the Transit Gateway (a regional router that connects VPCs), and so is a hub VPC that holds the way out to the internet. The Transit Gateway has two route tables (lists of where to send each address range), written out in `transit-gateway.tf`: workload VPCs use one, the hub uses the other.',
  '',
];

const TRAFFIC_WITH_FIREWALL = [
  ...TRAFFIC_INTRO,
  'To the internet: workload VPC → Transit Gateway → hub VPC → firewall endpoint in the same Availability Zone → NAT gateway in that zone → internet gateway → internet. Replies come back the same way, through the same firewall endpoint.',
  '',
  'Between workload VPCs: workload VPC → Transit Gateway → hub VPC → firewall endpoint → Transit Gateway → the other workload VPC. Workload VPCs never reach each other without passing the firewall.',
  '',
  'The hub attachment has [appliance mode](https://docs.aws.amazon.com/vpc/latest/tgw/how-transit-gateways-work.html) turned on, so both directions of a connection use the same zone’s firewall endpoint; a stateful firewall that sees only one direction drops the connection. The routes through the firewall are in `network-firewall.tf`.',
  '',
  'Not inspected: traffic inside one VPC, and the internet-facing load balancers in the public subnets of online workload VPCs, which use that VPC’s own internet gateway. Traffic from those public subnets to other workload VPCs does go through the firewall.',
  '',
  'AWS describes this design in [Combined inspection with AWS Network Firewall and AWS Transit Gateway](https://docs.aws.amazon.com/reference-architecture-diagrams/latest/network-firewall-inspection-models/nwfw-combined.html) and [Deployment models for AWS Network Firewall](https://aws.amazon.com/blogs/networking-and-content-delivery/deployment-models-for-aws-network-firewall/).',
  '',
];

const TRAFFIC_WITHOUT_FIREWALL = [
  ...TRAFFIC_INTRO,
  'To the internet: workload VPC → Transit Gateway → hub VPC → NAT gateway in the same Availability Zone → internet gateway → internet. Replies come back the same way.',
  '',
  'Between workload VPCs: workload VPC → Transit Gateway → the other workload VPC, directly. Nothing inspects this traffic; add the firewall component to send it, and internet traffic, through AWS Network Firewall.',
  '',
  'AWS describes this design under "Example: Centralized outbound routing to the internet" in [How AWS Transit Gateway works](https://docs.aws.amazon.com/vpc/latest/tgw/how-transit-gateways-work.html).',
  '',
];

function sectionsFor(state) {
  if (!isSelected(state, 'connectivity-hub')) return [];
  if (!isSelected(state, 'firewall')) return TRAFFIC_WITHOUT_FIREWALL;
  return [...TRAFFIC_WITH_FIREWALL, ...FIREWALL_SECTION];
}

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
    sections: sectionsFor(state),
    guardrails: [
      '- **AWS Organizations Root**: Central multi-account structure with Security, Infrastructure, and Workloads OUs.',
      '- **Service Control Policies (SCPs)**: Guardrails denying root account usage, enforcing IMDSv2 tokens, and blocking public S3 buckets.',
      '- **Central Audit Logging**: Aggregated multi-region CloudTrail and AWS Config stored in a dedicated KMS-encrypted audit bucket.',
    ],
  });
}
