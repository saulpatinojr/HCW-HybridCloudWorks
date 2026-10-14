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
