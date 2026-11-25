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
  'Between workload VPCs: workload VPC → Transit Gateway → hub VPC → firewall endpoint → Transit Gateway → the other workload VPC. Workload VPCs never reach each other without passing the firewall, and with the default policy below nothing crosses between them until a rule group allows it: directory traffic between the identity VPC and the other workload VPCs (LDAP, Kerberos, DNS) is dropped until you add a rule for it.',
  '',
  'The hub attachment has [appliance mode](https://docs.aws.amazon.com/vpc/latest/tgw/how-transit-gateways-work.html) turned on, so both directions of a connection use the same zone’s firewall endpoint; a stateful firewall that sees only one direction drops the connection. The routes through the firewall are in `network-firewall.tf`.',
  '',
  'Not inspected:',
  '',
  '- Traffic inside one VPC.',
  '- Anything placed in the public subnets of an online workload VPC. Those subnets use that VPC’s own internet gateway, so whatever runs there reaches the internet, and is reached from it, without passing the firewall. Inbound inspection is not built. Traffic from those public subnets to other workload VPCs does go through the firewall.',
  '- Traffic from a workload VPC to the hub VPC’s own address range, which is delivered inside the hub without passing the firewall. Nothing runs in the hub today, so this matters only if you add something there.',
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

// What changes for a landing zone an earlier build of this pack deployed
// (#1876), named only for the parts in this build.
function upgradeSection(state) {
  const notes = [];
  if (isSelected(state, 'identity')) {
    notes.push(
      '- **The identity VPC is replaced.** Its address range changed from the whole spoke range to its own slice, and AWS cannot change a VPC’s range in place, so Terraform destroys the old identity VPC and builds a new one. Anything running in it is destroyed with it: move it out first.'
    );
  }
  if (isSelected(state, 'firewall')) {
    notes.push(
      '- **The hub VPC is renamed, not rebuilt.** It used to be `module.inspection_vpc`; a `moved` block in `network-firewall.tf` tells Terraform it is now `module.hub_vpc`. Read the plan anyway: if it shows the firewall or its endpoints being replaced, traffic stops while they are rebuilt.'
    );
  }
  if (isSelected(state, 'online')) {
    notes.push(
      '- **Online workload VPCs lose their own NAT gateway.** Their private subnets now leave through the hub, so the old NAT gateway and its Elastic IP address are destroyed; anything outside that allowed that address must allow the hub’s NAT addresses instead.'
    );
  }
  if (!notes.length) return [];
  return [
    '## Upgrading a landing zone an earlier build deployed',
    '',
    'Earlier builds of this pack did not route traffic. Upgrading one changes these resources; read `terraform plan` before you apply.',
    '',
    ...notes,
    '',
  ];
}

function sectionsFor(state) {
  if (!isSelected(state, 'connectivity-hub')) return [];
  if (!isSelected(state, 'firewall'))
    return [...TRAFFIC_WITHOUT_FIREWALL, ...upgradeSection(state)];
  return [...TRAFFIC_WITH_FIREWALL, ...FIREWALL_SECTION, ...upgradeSection(state)];
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
