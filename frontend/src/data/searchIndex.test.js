import { describe, expect, it } from 'vitest';
import { STATIC_SEARCH_ITEMS, SEARCH_CATEGORIES, filterSearchItems } from './searchIndex';
import { availableLabs } from './labs/catalogue';
import { availableAddons } from './addons/catalogue';

describe('searchIndex', () => {
  it('contains entries across all major categories including Hubs & Sections', () => {
    const categories = new Set(STATIC_SEARCH_ITEMS.map((item) => item.category));
    expect(categories).toContain(SEARCH_CATEGORIES.PROVIDERS);
    expect(categories).toContain(SEARCH_CATEGORIES.SECTIONS);
    expect(categories).toContain(SEARCH_CATEGORIES.BLUEPRINTS);
    expect(categories).toContain(SEARCH_CATEGORIES.TOOLS);
    expect(categories).toContain(SEARCH_CATEGORIES.LABS);
    expect(categories).toContain(SEARCH_CATEGORIES.CERTS);
  });

  it('includes all 9 providers', () => {
    const providers = STATIC_SEARCH_ITEMS.filter(
      (item) => item.category === SEARCH_CATEGORIES.PROVIDERS
    );
    expect(providers.map((p) => p.title)).toEqual([
      'AWS',
      'Azure',
      'Google Cloud (GCP)',
      'VMware',
      'Terraform',
      'Ansible',
      'Docker',
      'GitHub',
      'FinOps',
    ]);
  });

  it('indexes every available browser lab and AddOn tool from the catalogues', () => {
    for (const lab of availableLabs) {
      expect(
        STATIC_SEARCH_ITEMS.some((item) => item.id === `lab-catalogue-${lab.id}`),
        `missing search index entry for lab ${lab.id}`
      ).toBe(true);
    }

    for (const addon of availableAddons) {
      expect(
        STATIC_SEARCH_ITEMS.some((item) => item.id === `addon-${addon.id}`),
        `missing search index entry for addon ${addon.id}`
      ).toBe(true);
    }
  });

  it('indexes provider sections, tools, and Azure certifications', () => {
    expect(filterSearchItems('ansible tools').some((r) => r.path === '/ansible/tools')).toBe(true);
    expect(filterSearchItems('migration hub').some((r) => r.path === '/tools/migration')).toBe(
      true
    );
    expect(
      filterSearchItems('network assessment').some((r) => r.path === '/tools/network-assessment')
    ).toBe(true);
    expect(filterSearchItems('az-900').some((r) => r.path === '/azure/education/az-900')).toBe(
      true
    );
  });

  it('indexes FinOps with FOCUS 1.4 specification', () => {
    const finopsBlueprint = STATIC_SEARCH_ITEMS.find(
      (item) => item.id === 'blueprint-finops-optimization'
    );
    expect(finopsBlueprint).toBeDefined();
    expect(finopsBlueprint.subtitle).toContain('FOCUS 1.4');
    expect(finopsBlueprint.badge).toBe('FOCUS 1.4');

    const finopsCert = STATIC_SEARCH_ITEMS.find((item) => item.id === 'cert-finops-focp');
    expect(finopsCert).toBeDefined();
    expect(finopsCert.title).toContain('FOCUS 1.4');
    expect(finopsCert.badge).toBe('FOCUS 1.4');

    const finopsFofa = STATIC_SEARCH_ITEMS.find((item) => item.id === 'cert-finops-fofa');
    expect(finopsFofa).toBeDefined();
    expect(finopsFofa.title).toContain('FOCUS 1.4');
    expect(finopsFofa.badge).toBe('FOCUS 1.4');

    const finopsValidator = STATIC_SEARCH_ITEMS.find(
      (item) => item.id === 'tool-finops-focus-validator'
    );
    expect(finopsValidator).toBeDefined();
    expect(finopsValidator.subtitle).toContain('FOCUS 1.4');
    expect(finopsValidator.badge).toBe('FOCUS 1.4');
  });

  it('returns all items when query is empty', () => {
    expect(filterSearchItems('')).toEqual(STATIC_SEARCH_ITEMS);
    expect(filterSearchItems('   ')).toEqual(STATIC_SEARCH_ITEMS);
  });

  it('filters by query and prioritizes exact/prefix title matches', () => {
    const results = filterSearchItems('azure');
    expect(results.length).toBeGreaterThan(0);
    // Azure provider or Azure items should be at top
    expect(results[0].title).toMatch(/Azure/i);
  });

  it('matches FOCUS 1.4 query specifically', () => {
    const results = filterSearchItems('focus 1.4');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.badge === 'FOCUS 1.4')).toBe(true);
  });

  it('handles multi-term queries across title and keywords', () => {
    const results = filterSearchItems('terraform validate');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('lab-terraform-validate');
  });

  it('returns empty array when no item matches', () => {
    expect(filterSearchItems('nonexistentxyz123456789')).toEqual([]);
  });
});
