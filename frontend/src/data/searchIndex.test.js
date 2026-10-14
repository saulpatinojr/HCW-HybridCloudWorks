import { describe, expect, it } from 'vitest';
import { STATIC_SEARCH_ITEMS, SEARCH_CATEGORIES, filterSearchItems } from './searchIndex';

describe('searchIndex', () => {
  it('contains entries across all 5 major categories', () => {
    const categories = new Set(STATIC_SEARCH_ITEMS.map((item) => item.category));
    expect(categories).toContain(SEARCH_CATEGORIES.PROVIDERS);
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
