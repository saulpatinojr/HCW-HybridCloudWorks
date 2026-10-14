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
      options: {
        location: 'centralus',
        rootParentId: '',
        hubCidr: '10.0.0.0/16',
        spokeCidr: '10.1.0.0/16',
        privateDnsZones: true,
        firewallSku: 'Standard',
        corpCount: 1,
        onlineCount: 1,
      },
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
      options: {
        location: 'eastus2',
        rootParentId: '',
        hubCidr: '10.0.0.0/16',
        spokeCidr: '10.1.0.0/16',
        privateDnsZones: true,
        firewallSku: 'Basic',
        corpCount: 2,
        onlineCount: 0,
      },
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
      options: {
        location: 'centralus',
        rootParentId: '',
        hubCidr: '10.0.0.0/16',
        spokeCidr: '10.1.0.0/16',
        privateDnsZones: true,
        firewallSku: 'Basic',
        corpCount: 1,
        onlineCount: 1,
      },
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
      options: {
        location: 'eastus2',
        rootParentId: '',
        hubCidr: '10.0.0.0/16',
        spokeCidr: '10.1.0.0/16',
        privateDnsZones: true,
        firewallSku: 'Premium',
        corpCount: 3,
        onlineCount: 0,
      },
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
      options: {
        location: 'centralus',
        rootParentId: '',
        hubCidr: '10.0.0.0/16',
        spokeCidr: '10.1.0.0/16',
        privateDnsZones: false,
        firewallSku: 'Basic',
        corpCount: 0,
        onlineCount: 0,
      },
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

export function estimateMonthlyBaseline(rawState) {
  const state = normalizeState(rawState);
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

/** Checks if the current normalized state matches one of the 5 presets. */
export function activePresetForState(rawState) {
  const currentQuery = new URLSearchParams(encodeLz(rawState)).toString();
  return (
    LZ_PRESETS.find(
      (preset) => new URLSearchParams(encodeLz(preset.state)).toString() === currentQuery
    ) ?? null
  );
}

/** Builds a deep link to `/tools/landing-zone` for a given preset id. */
export function presetHref(presetId) {
  const preset = LZ_PRESETS.find((p) => p.id === presetId);
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
      {
        name: 'Azure/avm-ptn-alz/azurerm',
        version: '0.11.0',
        role: 'Management Groups & Policy Baseline',
      },
      {
        name: 'Azure/avm-ptn-alz-management/azurerm',
        version: '0.6.0',
        role: 'Log Analytics Workspace & Diagnostics',
      },
      {
        name: 'Azure/avm-ptn-alz-connectivity-hub-and-spoke-vnet/azurerm',
        version: '0.4.0',
        role: 'Hub VNet, Bastion, DNS & Azure Firewall',
      },
      {
        name: 'Azure/avm-res-network-virtualnetwork/azurerm',
        version: '0.5.2',
        role: 'Segmented Corp, Online & Identity Spokes',
      },
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
      {
        name: 'terraform-aws-modules/vpc/aws',
        version: 'v5.19.0',
        role: 'Inspection VPC & Workload Spokes',
      },
      {
        name: 'terraform-aws-modules/transit-gateway/aws',
        version: 'v2.13.0',
        role: 'Regional Cloud Router & RAM Sharing',
      },
      {
        name: 'terraform-aws-modules/network-firewall/aws',
        version: 'v1.1.0',
        role: 'Stateful AWS Network Firewall in Hub',
      },
      {
        name: 'hashicorp/aws',
        version: '~> 5.80',
        role: 'Native Organizations, OUs & SCP policies',
      },
    ]),
    componentsMapping: Object.freeze([
      {
        id: 'management-groups',
        name: 'AWS Organizations Root + OUs',
        desc: 'Security, Infrastructure, and Workloads OUs',
      },
      {
        id: 'policy',
        name: 'Service Control Policies (SCPs)',
        desc: 'Deny root account, region lock, require IMDSv2, deny public S3',
      },
      {
        id: 'management',
        name: 'Log Archive & Audit Account',
        desc: 'Central CloudTrail, AWS Config aggregator & KMS key',
      },
      {
        id: 'connectivity-hub',
        name: 'Transit Gateway (TGW) Hub',
        desc: 'Multi-account network hub with Route 53 Resolver',
      },
      {
        id: 'firewall',
        name: 'AWS Network Firewall',
        desc: 'Stateful inspection VPC attached to Transit Gateway',
      },
      {
        id: 'identity',
        name: 'IAM Identity Center (SSO)',
        desc: 'Permission sets and shared directory spoke',
      },
      {
        id: 'corp',
        name: 'Private Workload VPCs',
        desc: 'Egress routed via Transit Gateway inspection VPC',
      },
      {
        id: 'online',
        name: 'Public Ingress Workload VPCs',
        desc: 'Public ALB subnets with East-West Transit Gateway inspection',
      },
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
      {
        name: 'terraform-google-modules/network/google',
        version: 'v10.0.0',
        role: 'Shared VPC Host, Subnets, PSC & Cloud NAT',
      },
      {
        name: 'terraform-google-modules/log-export/google',
        version: 'v9.0.0',
        role: 'Aggregated Audit Log Sink & BigQuery Dataset',
      },
      {
        name: 'terraform-google-modules/project-factory/google',
        version: 'v17.1.0',
        role: 'Service Projects attached to Shared VPC',
      },
      {
        name: 'hashicorp/google',
        version: '~> 6.15',
        role: 'Resource Manager Folders & Org Policy Constraints',
      },
    ]),
    componentsMapping: Object.freeze([
      {
        id: 'management-groups',
        name: 'Cloud Resource Manager Folders',
        desc: 'Shared, Prod, and Non-Prod folder hierarchies',
      },
      {
        id: 'policy',
        name: 'Organization Policy Constraints',
        desc: 'compute.vmExternalIpAccess, requireShieldedVm, domain restrictions',
      },
      {
        name: 'Central Logging Project',
        id: 'management',
        desc: 'Organization log sink, locked Cloud Storage & BigQuery dataset',
      },
      {
        id: 'connectivity-hub',
        name: 'Shared VPC Host Project',
        desc: 'Cloud Router, Private Service Connect (PSC) & Cloud DNS',
      },
      {
        id: 'firewall',
        name: 'Cloud NGFW & Cloud NAT',
        desc: 'Centralized network firewall & Cloud NAT in host project',
      },
      {
        id: 'identity',
        name: 'Cloud Identity & Workforce Pools',
        desc: 'Group bindings and workload identity federation',
      },
      {
        id: 'corp',
        name: 'Private Service Projects',
        desc: 'Zero external IPs, connected to Shared VPC subnets',
      },
      {
        id: 'online',
        name: 'Public Service Projects',
        desc: 'Global External ALB with Cloud Armor security policies',
      },
    ]),
  }),
});
