import { describe, expect, it } from 'vitest';
import { decodeLz, encodeLz } from './share';
import { normalizeState } from './state';
import { COMPONENT_IDS } from './components';
import {
  LZ_PRESETS,
  MULTI_CLOUD_PACKS,
  STANDING_COSTS_USD,
  activePresetForState,
  estimateMonthlyBaseline,
  presetHref,
} from './presets';

describe('Landing Zone Builder architectural presets (presets.js)', () => {
  it('defines five distinct presets with unique ids and non-empty labels', () => {
    expect(LZ_PRESETS).toHaveLength(5);
    const ids = LZ_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(5);
    for (const preset of LZ_PRESETS) {
      expect(preset.label.length).toBeGreaterThan(5);
      expect(preset.summary.length).toBeGreaterThan(20);
      expect(preset.blueprintSlug).toMatch(/^\//);
    }
  });

  it('normalizes every preset state cleanly with zero CIDR overlap warnings', () => {
    for (const preset of LZ_PRESETS) {
      const normalized = normalizeState(preset.state);
      expect(normalized.warnings).toEqual([]);
      expect(normalized.selected).toEqual(preset.state.selected);
      expect(normalized.options).toEqual(preset.state.options);
    }
  });

  it('round-trips every preset through encodeLz -> decodeLz and matches activePresetForState', () => {
    for (const preset of LZ_PRESETS) {
      const encoded = encodeLz(preset.state);
      const decoded = decodeLz(new URLSearchParams(encoded));
      const matched = activePresetForState(decoded);
      expect(matched?.id).toBe(preset.id);
    }
  });

  it('computes accurate standing monthly FinOps floors for each preset tier', () => {
    const enterprise = LZ_PRESETS.find((p) => p.id === 'enterprise-default');
    const secureBasic = LZ_PRESETS.find((p) => p.id === 'secure-2-tier');
    const skeleton = LZ_PRESETS.find((p) => p.id === 'governance-skeleton');

    const entCost = estimateMonthlyBaseline(enterprise.state);
    const basicCost = estimateMonthlyBaseline(secureBasic.state);
    const skelCost = estimateMonthlyBaseline(skeleton.state);

    // Enterprise Default: Mgmt ($35) + Hub Bastion ($140) + DNS ($28) + FW Standard ($912) + 3 spokes ($36) = $1,151/mo
    expect(entCost.totalMonthlyUsd).toBe(
      STANDING_COSTS_USD.managementWorkspaceBase +
        STANDING_COSTS_USD.hubBastionBasic +
        STANDING_COSTS_USD.privateDnsZonesSet +
        STANDING_COSTS_USD.firewallSku.Standard +
        3 * STANDING_COSTS_USD.peeredSpokeBaseline
    );

    // Basic FW preset saves over $600/mo compared to Standard FW preset
    expect(basicCost.totalMonthlyUsd).toBeLessThan(entCost.totalMonthlyUsd - 600);

    // Governance skeleton has only Log Analytics standing cost ($35/mo) and 0 spokes
    expect(skelCost.totalMonthlyUsd).toBe(STANDING_COSTS_USD.managementWorkspaceBase);
    expect(skelCost.totalSpokes).toBe(0);
  });

  it('raises a FinOps advisory when Standard Firewall is paired with 2 or fewer spokes', () => {
    const enterprise = LZ_PRESETS.find((p) => p.id === 'enterprise-default');
    // Reduce identity/online so totalSpokes <= 2 while keeping Standard FW
    const smallStandard = normalizeState({
      ...enterprise.state,
      selected: ['management-groups', 'connectivity-hub', 'firewall', 'corp'],
      options: {
        ...enterprise.state.options,
        firewallSku: 'Standard',
        corpCount: 1,
        onlineCount: 0,
      },
    });
    const report = estimateMonthlyBaseline(smallStandard);
    expect(report.totalSpokes).toBe(1);
    expect(report.finopsAdvisories.some((msg) => msg.includes('saves $624/month'))).toBe(true);
  });

  it('builds canonical preset deep links via presetHref', () => {
    expect(presetHref('enterprise-default')).toBe('/tools/landing-zone');
    expect(presetHref('secure-2-tier')).toContain('/tools/landing-zone?');
    expect(presetHref('secure-2-tier')).toContain('fw.sku=Basic');
    expect(presetHref('unknown-id')).toBe('/tools/landing-zone');
  });

  it('defines universal 8-component multi-cloud packs for Azure, AWS, and GCP', () => {
    expect(Object.keys(MULTI_CLOUD_PACKS)).toEqual(['azure', 'aws', 'gcp']);
    expect(MULTI_CLOUD_PACKS.azure.status).toBe('active');
    expect(MULTI_CLOUD_PACKS.aws.status).toBe('preview');
    expect(MULTI_CLOUD_PACKS.gcp.status).toBe('preview');

    for (const cloud of ['aws', 'gcp']) {
      const pack = MULTI_CLOUD_PACKS[cloud];
      expect(pack.pinnedModules.length).toBeGreaterThanOrEqual(4);
      expect(pack.componentsMapping).toHaveLength(8);
      const mappedIds = pack.componentsMapping.map((c) => c.id);
      expect(mappedIds).toEqual(COMPONENT_IDS);
    }
  });
});
