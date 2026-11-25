/**
 * Architectural presets and live FinOps baseline estimation for the
 * Landing Zone Builder.
 *
 * Pure data and pure functions: every preset is a valid state for
 * `normalizeState` in `./state.js`, and every string is visitor copy that
 * passes `public-copy.test.js`.
 */
import { COMPONENT_IDS } from './components';
import { normalizeState, isSelected } from './state';
import { encodeLz } from './share';

/**
 * A preset's builder options. Every preset starts at the tenant root with the
 * same hub and first-spoke address ranges, so only the rest is passed in.
 */
const presetOptions = (location, privateDnsZones, firewallSku, corpCount, onlineCount) => ({
  location,
  rootParentId: '',
  hubCidr: '10.0.0.0/16',
  spokeCidr: '10.1.0.0/16',
  privateDnsZones,
  firewallSku,
  corpCount,
  onlineCount,
});

/** A module a cloud's pack pins, its version, and the job it does. */
const pinnedModule = (name, version, role) => ({ name, version, role });

/** What one builder component becomes on a cloud. */
const componentRow = (id, name, desc) => ({ id, name, desc });

export const LZ_PRESETS = Object.freeze([
  Object.freeze({
    id: 'enterprise-default',
    label: 'Full Enterprise ALZ',
    badge: 'Validated Pattern',
    blueprintSlug: '/azure/architecture-designs/enterprise-hub-spoke-landing-zone',
    blueprintTitle: 'Enterprise Hub-and-Spoke Landing Zone',
    summary:
      'Every platform component enabled with Standard Firewall, Private DNS zones, one Corp spoke, and one Online spoke.',
    state: normalizeState({
      selected: COMPONENT_IDS,
      options: presetOptions('centralus', true, 'Standard', 1, 1),
    }),
  }),
  Object.freeze({
    id: 'secure-2-tier',
    label: 'Cost-Aware Secure Hub (Basic FW)',
    badge: 'Blueprint HCW-BP-AZ-001',
    blueprintSlug: '/azure/architecture-designs/secure-2-tier-azure',
    blueprintTitle: 'Secure 2-Tier Application on Azure',
    summary:
      'Replaces Standard Firewall with Basic SKU for workloads under 250 Mbps and provisions two isolated Corp spokes.',
    state: normalizeState({
      selected: [
        'management-groups',
        'policy',
        'management',
        'connectivity-hub',
        'firewall',
        'corp',
      ],
      options: presetOptions('eastus2', true, 'Basic', 2, 0),
    }),
  }),
  Object.freeze({
    id: 'finops-lean-hub',
    label: 'FinOps Lean Governance',
    badge: 'Blueprint HCW-BP-AZ-004',
    blueprintSlug: '/azure/architecture-designs/finops-guardrails-azure',
    blueprintTitle: 'FinOps Guardrails for Azure Subscriptions',
    summary:
      'Management groups, Policy baseline, central logging, and hub connectivity without standing Firewall hourly charges.',
    state: normalizeState({
      selected: ['management-groups', 'policy', 'management', 'connectivity-hub', 'corp', 'online'],
      options: presetOptions('centralus', true, 'Basic', 1, 1),
    }),
  }),
  Object.freeze({
    id: 'zero-trust-regulated',
    label: 'Regulated Premium Inspection',
    badge: 'High Compliance',
    blueprintSlug: '/azure/architecture-designs/zero-trust-identity-control-plane',
    blueprintTitle: 'Zero Trust Identity Control Plane',
    summary:
      'Adds Azure Firewall Premium for TLS inspection and IDPS, dedicated Identity spoke, and three internal Corp spokes.',
    state: normalizeState({
      selected: [
        'management-groups',
        'policy',
        'management',
        'connectivity-hub',
        'firewall',
        'identity',
        'corp',
      ],
      options: presetOptions('eastus2', true, 'Premium', 3, 0),
    }),
  }),
  Object.freeze({
    id: 'governance-skeleton',
    label: 'Governance Skeleton Only',
    badge: 'Zero Standing Network Cost',
    blueprintSlug: '/azure/architecture-designs',
    blueprintTitle: 'Azure Architecture Catalogue',
    summary:
      'Deploys only the Management Group hierarchy, central logging workspace, and Policy baseline with zero networks.',
    state: normalizeState({
      selected: ['management-groups', 'policy', 'management'],
      options: presetOptions('centralus', false, 'Basic', 0, 0),
    }),
  }),
]);

/**
 * Standing monthly baseline estimate (USD/month, 730 hours) for the selected
 * platform and application components. Used to teach FinOps cost floors
 * before a learner downloads and applies the Terraform.
 */
export const STANDING_COSTS_USD = Object.freeze({
  managementWorkspaceBase: 35,
  hubBastionBasic: 140,
  privateDnsZonesSet: 28,
  firewallSku: Object.freeze({
    Basic: 288,
    Standard: 912,
    Premium: 1277,
  }),
  peeredSpokeBaseline: 12,
});

const FIREWALL_SKU_NOTES = Object.freeze({
  Basic: 'Cheapest hourly floor ($288/mo), but charges $0.035/GB processed.',
  Standard: 'Standard hourly floor ($912/mo) with lower $0.016/GB processing fee.',
  Premium: 'Premium hourly floor ($1,277/mo) with TLS inspection and IDPS.',
});

function countTotalSpokes(state) {
  let count = 0;
  if (isSelected(state, 'identity')) count += 1;
  if (isSelected(state, 'corp')) count += Number(state.options.corpCount || 0);
  if (isSelected(state, 'online')) count += Number(state.options.onlineCount || 0);
  return count;
}

function computeFinopsAdvisories(state, totalSpokes) {
  const advisories = [];
  if (
    isSelected(state, 'firewall') &&
    state.options.firewallSku === 'Standard' &&
    totalSpokes <= 2
  ) {
    advisories.push(
      'FinOps tip: With 2 or fewer spokes and under 32 TB/month of traffic, switching Firewall SKU from Standard ($912/mo) to Basic ($288/mo) saves $624/month.'
    );
  }
  if (
    isSelected(state, 'connectivity-hub') &&
    !isSelected(state, 'firewall') &&
    state.options.corpCount > 0
  ) {
    advisories.push(
      'Architecture note: Corp spokes are selected without Azure Firewall. Spokes will egress directly unless you add a central firewall or NAT gateway.'
    );
  }
  return advisories;
}

export const AWS_PRESETS = Object.freeze([
  Object.freeze({
    id: 'aws-org-tgw-standard',
    label: 'AWS Multi-Account TGW Baseline',
    badge: 'Standard Pattern',
    blueprintSlug: '/aws/architecture-designs/global-load-balancing',
    blueprintTitle: 'Global Load Balancing & Multi-Region VPC',
    summary:
      'AWS Organizations, Service Control Policies, Transit Gateway hub, and one Corp and one Online VPC.',
    state: normalizeState({
      cloud: 'aws',
      selected: COMPONENT_IDS,
      options: presetOptions('us-east-1', true, 'Standard', 1, 1),
    }),
  }),
  Object.freeze({
    id: 'aws-regulated-firewall',
    label: 'AWS Network Firewall Inspection',
    badge: 'High Compliance',
    // No AWS inspection-VPC design is published yet, so this points at the
    // catalogue, as the governance-only presets do (#1628).
    blueprintSlug: '/aws/architecture-designs',
    blueprintTitle: 'AWS Architecture Catalogue',
    summary:
      'Dedicated Inspection VPC with AWS Network Firewall and three isolated Corp workload VPCs.',
    state: normalizeState({
      cloud: 'aws',
      selected: [
        'management-groups',
        'policy',
        'management',
        'connectivity-hub',
        'firewall',
        'identity',
        'corp',
      ],
      options: presetOptions('us-east-1', true, 'Standard', 3, 0),
    }),
  }),
  Object.freeze({
    id: 'aws-governance-only',
    label: 'AWS Organizations & SCPs Only',
    badge: 'Zero Network Cost',
    blueprintSlug: '/aws/architecture-designs',
    blueprintTitle: 'AWS Architecture Catalogue',
    summary:
      'Deploys Organizations hierarchy, Security & Workloads OUs, SCP guardrails, and audit CloudTrail without VPCs.',
    state: normalizeState({
      cloud: 'aws',
      selected: ['management-groups', 'policy', 'management'],
      options: presetOptions('us-east-1', false, 'Standard', 0, 0),
    }),
  }),
]);

export const GCP_PRESETS = Object.freeze([
  Object.freeze({
    id: 'gcp-enterprise-shared-vpc',
    label: 'GCP Shared VPC Host & Service Projects',
    badge: 'Foundation Fabric',
    blueprintSlug: '/gcp/architecture-designs/global-load-balancing',
    blueprintTitle: 'Global Load Balancing Architecture',
    summary:
      'Platform & Workloads folders, Org Policies, Shared VPC Host network, Cloud NAT, and Corp/Online service projects.',
    state: normalizeState({
      cloud: 'gcp',
      selected: COMPONENT_IDS,
      options: presetOptions('us-central1', true, 'Standard', 1, 1),
    }),
  }),
  Object.freeze({
    id: 'gcp-cloud-ngfw-inspection',
    label: 'GCP Cloud NGFW & Private Services',
    badge: 'Zero Trust Network',
    blueprintSlug: '/gcp/architecture-designs/zero-trust-security',
    blueprintTitle: 'Zero Trust Security Architecture',
    summary:
      'Regional Cloud NGFW policy on Shared VPC with Workload Identity Federation and two private service projects.',
    state: normalizeState({
      cloud: 'gcp',
      selected: [
        'management-groups',
        'policy',
        'management',
        'connectivity-hub',
        'firewall',
        'identity',
        'corp',
      ],
      options: presetOptions('us-central1', true, 'Standard', 2, 0),
    }),
  }),
  Object.freeze({
    id: 'gcp-org-foundation-only',
    label: 'GCP Folders & Org Policies Only',
    badge: 'Zero Network Cost',
    blueprintSlug: '/gcp/architecture-designs',
    blueprintTitle: 'GCP Architecture Catalogue',
    summary:
      'Deploys Folder hierarchy, Org Policy constraints, and organization audit log export without networks.',
    state: normalizeState({
      cloud: 'gcp',
      selected: ['management-groups', 'policy', 'management'],
      options: presetOptions('us-central1', false, 'Standard', 0, 0),
    }),
  }),
]);

export const MULTI_CLOUD_PRESETS = Object.freeze({
  azure: LZ_PRESETS,
  aws: AWS_PRESETS,
  gcp: GCP_PRESETS,
});

function estimateAwsBaseline(state) {
  const items = [];
  if (isSelected(state, 'management')) {
    items.push({
      label: 'Central Audit CloudTrail & KMS Key',
      monthlyUsd: 40,
      note: 'Multi-region organization trail with KMS customer-managed key.',
    });
  }
  if (isSelected(state, 'connectivity-hub')) {
    items.push({
      label: 'AWS Transit Gateway & Route 53 Resolver',
      monthlyUsd: 117,
      note: 'Central interconnect hourly fee and Route 53 Resolver endpoints.',
    });
  }
  if (isSelected(state, 'firewall')) {
    items.push({
      label: 'AWS Network Firewall (Stateful inspection)',
      monthlyUsd: 288,
      note: 'Hourly base fee in dedicated Inspection VPC.',
    });
  }
  const totalSpokes = countTotalSpokes(state);
  if (totalSpokes > 0) {
    items.push({
      label: `Transit Gateway VPC Attachments (${totalSpokes} spoke${totalSpokes === 1 ? '' : 's'})`,
      monthlyUsd: totalSpokes * 36,
      note: 'Hourly fee for connecting workload VPCs to TGW.',
    });
  }
  const totalMonthlyUsd = items.reduce((sum, item) => sum + item.monthlyUsd, 0);
  const finopsAdvisories = [];
  if (isSelected(state, 'firewall') && totalSpokes <= 2) {
    finopsAdvisories.push(
      'FinOps tip: For low-throughput dev environments, an egress NAT Gateway can be used before deploying stateful Network Firewall.'
    );
  }
  return { items, totalMonthlyUsd, totalSpokes, finopsAdvisories };
}

function estimateGcpBaseline(state) {
  const items = [];
  if (isSelected(state, 'management')) {
    items.push({
      label: 'Central Audit Log Export & Storage Bucket',
      monthlyUsd: 30,
      note: 'Aggregated organization sink with locked Cloud Storage destination.',
    });
  }
  if (isSelected(state, 'connectivity-hub')) {
    items.push({
      label: 'Shared VPC Host, Cloud Router & NAT Gateway',
      monthlyUsd: 41,
      note: 'Hourly NAT gateway base charge and Cloud DNS private zones.',
    });
  }
  if (isSelected(state, 'firewall')) {
    items.push({
      label: 'Cloud NGFW Enterprise Policy',
      monthlyUsd: 75,
      note: 'Intrusion prevention service and regional security rules.',
    });
  }
  const totalSpokes = countTotalSpokes(state);
  if (totalSpokes > 0) {
    items.push({
      label: `Service Projects & PSC Endpoints (${totalSpokes} service project${totalSpokes === 1 ? '' : 's'})`,
      monthlyUsd: totalSpokes * 15,
      note: 'Nominal baseline for cross-project Private Service Connect and routing.',
    });
  }
  const totalMonthlyUsd = items.reduce((sum, item) => sum + item.monthlyUsd, 0);
  const finopsAdvisories = [];
  return { items, totalMonthlyUsd, totalSpokes, finopsAdvisories };
}

export function estimateMonthlyBaseline(rawState) {
  const state = normalizeState(rawState);
  const cloud = rawState?.cloud || state.cloud;
  if (cloud === 'aws') return estimateAwsBaseline(state);
  if (cloud === 'gcp') return estimateGcpBaseline(state);

  const items = [];

  if (isSelected(state, 'management')) {
    items.push({
      label: 'Central Log Analytics baseline ingestion',
      monthlyUsd: STANDING_COSTS_USD.managementWorkspaceBase,
      note: 'First 5 GB/month billable allowance + automation account.',
    });
  }

  if (isSelected(state, 'connectivity-hub')) {
    items.push({
      label: 'Hub VNet + Bastion host standing charge',
      monthlyUsd: STANDING_COSTS_USD.hubBastionBasic,
      note: 'Shared administrative access in the connectivity hub.',
    });
    if (state.options.privateDnsZones) {
      items.push({
        label: 'Private Link DNS zones & resolver',
        monthlyUsd: STANDING_COSTS_USD.privateDnsZonesSet,
        note: 'Hosted zones linked to the hub virtual network.',
      });
    }
  }

  if (isSelected(state, 'firewall')) {
    const sku = state.options.firewallSku || 'Standard';
    const fwCost = STANDING_COSTS_USD.firewallSku[sku] ?? 912;
    items.push({
      label: `Azure Firewall (${sku} SKU)`,
      monthlyUsd: fwCost,
      note: FIREWALL_SKU_NOTES[sku] ?? FIREWALL_SKU_NOTES.Standard,
    });
  }

  const totalSpokes = countTotalSpokes(state);
  if (totalSpokes > 0) {
    items.push({
      label: `Spoke VNet peering & routing (${totalSpokes} spoke${totalSpokes === 1 ? '' : 's'})`,
      monthlyUsd: totalSpokes * STANDING_COSTS_USD.peeredSpokeBaseline,
      note: 'Nominal baseline for bidirectional peering and route tables.',
    });
  }

  const totalMonthlyUsd = items.reduce((sum, item) => sum + item.monthlyUsd, 0);
  const finopsAdvisories = computeFinopsAdvisories(state, totalSpokes);

  return { items, totalMonthlyUsd, totalSpokes, finopsAdvisories };
}

/** Checks if the current normalized state matches one of the presets. */
export function activePresetForState(rawState) {
  const cloud = rawState?.cloud || 'azure';
  const presets = MULTI_CLOUD_PRESETS[cloud] || LZ_PRESETS;
  const currentQuery = new URLSearchParams(encodeLz(rawState)).toString();
  return (
    presets.find(
      (preset) => new URLSearchParams(encodeLz(preset.state)).toString() === currentQuery
    ) ?? null
  );
}

/** Builds a deep link to `/tools/landing-zone` for a given preset id. */
export function presetHref(presetId) {
  const allPresets = [...LZ_PRESETS, ...AWS_PRESETS, ...GCP_PRESETS];
  const preset = allPresets.find((p) => p.id === presetId);
  if (!preset) return '/tools/landing-zone';
  const query = new URLSearchParams(encodeLz(preset.state)).toString();
  return query ? `/tools/landing-zone?${query}` : '/tools/landing-zone';
}

/**
 * Multi-cloud landing zone provider pack definitions (Master Deliverable 04).
 * Unifies Azure, AWS, and Google Cloud under the universal 8-component ontology.
 */
export const MULTI_CLOUD_PACKS = Object.freeze({
  azure: Object.freeze({
    id: 'azure',
    label: 'Microsoft Azure',
    shortLabel: 'Azure',
    status: 'active',
    patternUrl:
      'https://developer.hashicorp.com/validated-patterns/terraform/build-azure-lz-with-terraform',
    blueprintSlug: '/azure/architecture-designs/enterprise-hub-spoke-landing-zone',
    description: 'Production Azure Landing Zone powered by Azure Verified Modules (AVM).',
    pinnedModules: Object.freeze([
      pinnedModule('Azure/avm-ptn-alz/azurerm', '0.11.0', 'Management Groups & Policy Baseline'),
      pinnedModule(
        'Azure/avm-ptn-alz-management/azurerm',
        '0.6.0',
        'Log Analytics Workspace & Diagnostics'
      ),
      pinnedModule(
        'Azure/avm-ptn-alz-connectivity-hub-and-spoke-vnet/azurerm',
        '0.4.0',
        'Hub VNet, Bastion, DNS & Azure Firewall'
      ),
      pinnedModule(
        'Azure/avm-res-network-virtualnetwork/azurerm',
        '0.5.2',
        'Segmented Corp, Online & Identity Spokes'
      ),
    ]),
  }),
  aws: Object.freeze({
    id: 'aws',
    label: 'Amazon Web Services',
    shortLabel: 'AWS',
    status: 'preview',
    patternUrl:
      'https://docs.aws.amazon.com/prescriptive-guidance/latest/security-reference-architecture/welcome.html',
    blueprintSlug: '/aws/architecture-designs/global-load-balancing',
    description:
      'AWS Organizations + Transit Gateway hub-and-spoke with Service Control Policies (SCPs).',
    pinnedModules: Object.freeze([
      pinnedModule('terraform-aws-modules/vpc/aws', 'v5.19.0', 'Inspection VPC & Workload Spokes'),
      pinnedModule(
        'terraform-aws-modules/transit-gateway/aws',
        'v2.13.0',
        'Regional Cloud Router & RAM Sharing'
      ),
      pinnedModule(
        'terraform-aws-modules/network-firewall/aws',
        'v1.1.0',
        'Stateful AWS Network Firewall in Hub'
      ),
      pinnedModule('hashicorp/aws', '~> 5.80', 'Native Organizations, OUs & SCP policies'),
    ]),
    componentsMapping: Object.freeze([
      componentRow(
        'management-groups',
        'AWS Organizations Root + OUs',
        'Security, Infrastructure, and Workloads OUs'
      ),
      componentRow(
        'policy',
        'Service Control Policies (SCPs)',
        'Deny root account, region lock, require IMDSv2, deny public S3'
      ),
      componentRow(
        'management',
        'Log Archive & Audit Account',
        'Central CloudTrail, AWS Config aggregator & KMS key'
      ),
      componentRow(
        'connectivity-hub',
        'Transit Gateway (TGW) Hub',
        'Multi-account network hub with Route 53 Resolver'
      ),
      componentRow(
        'firewall',
        'AWS Network Firewall',
        'Stateful inspection VPC attached to Transit Gateway'
      ),
      componentRow(
        'identity',
        'IAM Identity Center (SSO)',
        'Permission sets and shared directory spoke'
      ),
      componentRow(
        'corp',
        'Private Workload VPCs',
        'Egress routed via Transit Gateway inspection VPC'
      ),
      componentRow(
        'online',
        'Public Ingress Workload VPCs',
        'Public ALB subnets with East-West Transit Gateway inspection'
      ),
    ]),
  }),
  gcp: Object.freeze({
    id: 'gcp',
    label: 'Google Cloud Platform',
    shortLabel: 'Google Cloud',
    status: 'preview',
    patternUrl: 'https://cloud.google.com/architecture/security-foundations',
    blueprintSlug: '/gcp/architecture-designs/global-load-balancing',
    description:
      'Enterprise Foundations / Cloud Foundation Fabric with Shared VPC and organization policies.',
    pinnedModules: Object.freeze([
      pinnedModule(
        'terraform-google-modules/network/google',
        'v10.0.0',
        'Shared VPC Host, Subnets, PSC & Cloud NAT'
      ),
      pinnedModule(
        'terraform-google-modules/log-export/google',
        'v9.0.0',
        'Aggregated Audit Log Sink & BigQuery Dataset'
      ),
      pinnedModule(
        'terraform-google-modules/project-factory/google',
        'v17.1.0',
        'Service Projects attached to Shared VPC'
      ),
      pinnedModule(
        'hashicorp/google',
        '~> 6.15',
        'Resource Manager Folders & Org Policy Constraints'
      ),
    ]),
    componentsMapping: Object.freeze([
      componentRow(
        'management-groups',
        'Cloud Resource Manager Folders',
        'Shared, Prod, and Non-Prod folder hierarchies'
      ),
      componentRow(
        'policy',
        'Organization Policy Constraints',
        'compute.vmExternalIpAccess, requireShieldedVm, domain restrictions'
      ),
      {
        name: 'Central Logging Project',
        id: 'management',
        desc: 'Organization log sink, locked Cloud Storage & BigQuery dataset',
      },
      componentRow(
        'connectivity-hub',
        'Shared VPC Host Project',
        'Cloud Router, Private Service Connect (PSC) & Cloud DNS'
      ),
      componentRow(
        'firewall',
        'Cloud NGFW & Cloud NAT',
        'Centralized network firewall & Cloud NAT in host project'
      ),
      componentRow(
        'identity',
        'Cloud Identity & Workforce Pools',
        'Group bindings and workload identity federation'
      ),
      componentRow(
        'corp',
        'Private Service Projects',
        'Zero external IPs, connected to Shared VPC subnets'
      ),
      componentRow(
        'online',
        'Public Service Projects',
        'Global External ALB with Cloud Armor security policies'
      ),
    ]),
  }),
});
