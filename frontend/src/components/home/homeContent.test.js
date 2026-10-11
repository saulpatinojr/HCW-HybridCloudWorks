/**
 * The home page's numbers and lists are read from the site, not typed
 * (homeContent.js). These hold each helper to the thing it reads.
 */
import { describe, expect, it } from 'vitest';

import { staticBlueprints as aws } from '@/pages/aws/architecture-blueprints';
import { staticBlueprints as azure } from '@/pages/azure/architecture-blueprints';
import { staticBlueprints as finops } from '@/pages/finops/architecture-blueprints';
import { staticBlueprints as gcp } from '@/pages/gcp/architecture-blueprints';
import { staticBlueprints as vmware } from '@/pages/vmware/architecture-blueprints';
import { architecturesByProvider } from '@/data/architectures';
import {
  BLUEPRINTS_BY_PROVIDER,
  BLUEPRINT_COUNT,
  LATEST_LIMIT,
  blueprintCards,
  formatPublishedDate,
  toLatestItems,
} from './homeContent';

describe('blueprints', () => {
  it('reads every architecture-blueprints module, and counts exactly what they export', () => {
    expect(BLUEPRINTS_BY_PROVIDER).toEqual({ aws, azure, finops, gcp, vmware });
    expect(BLUEPRINT_COUNT).toBe(
      aws.length + azure.length + finops.length + gcp.length + vmware.length
    );
    expect(BLUEPRINT_COUNT).toBeGreaterThan(0);
  });

  it('puts every blueprint in the carousel once, providers taking turns', () => {
    const cards = blueprintCards();
    expect(cards).toHaveLength(BLUEPRINT_COUNT);
    expect(new Set(cards.map((card) => card.key)).size).toBe(cards.length);
    const withBlueprints = Object.entries(BLUEPRINTS_BY_PROVIDER).filter(([, b]) => b.length);
    // The first round has one card from each provider that has any.
    expect(cards.slice(0, withBlueprints.length).map((card) => card.provider)).toEqual(
      withBlueprints.map(([provider]) => provider)
    );
  });

  it('links a detail page only where one can be rendered, and the provider page otherwise', () => {
    for (const card of blueprintCards()) {
      if (card.to === `/${card.provider}/architecture-designs`) continue;
      const slug = card.to.split('/').at(-1);
      expect(architecturesByProvider[card.provider]?.[slug], card.to).toBeDefined();
    }
  });

  it('interleaves uneven lists without dropping or inventing a card', () => {
    const cards = blueprintCards({
      azure: [{ title: 'A1' }, { title: 'A2' }, { title: 'A3' }],
      aws: [{ title: 'B1', slug: 'b-one' }],
      vmware: [],
    });
    expect(cards.map((card) => card.title)).toEqual(['A1', 'B1', 'A2', 'A3']);
    expect(cards[1].to).toBe('/aws/architecture-designs/b-one');
    expect(cards[0].to).toBe('/azure/architecture-designs');
  });
});

describe('toLatestItems', () => {
  const doc = (overrides) => ({
    type: 'blog',
    Title: 'A title',
    slug: 'a-slug',
    'Cloud Provider': 'Azure',
    ...overrides,
  });

  it('shapes a published document into a card that opens its own page', () => {
    const [item] = toLatestItems([
      doc({ Summary: '<p>Hello <b>there</b></p>', 'Published At': '2026-06-05T18:05:16Z' }),
    ]);
    expect(item).toEqual({
      path: '/azure/blog/a-slug',
      title: 'A title',
      summary: 'Hello there',
      provider: 'azure',
      typeLabel: 'Article',
      publishedIso: '2026-06-05T18:05:16.000Z',
      publishedLabel: 'Jun 5, 2026',
    });
  });

  it('prefers the article date the blog list prefers, and shows none rather than a guess', () => {
    const [dated] = toLatestItems([
      doc({ 'Published At': '2026-06-05T00:00:00Z', publishedAt: '2026-06-18T00:00:00Z' }),
    ]);
    expect(dated.publishedLabel).toBe('Jun 5, 2026');
    const [undated] = toLatestItems([doc({})]);
    expect(undated.publishedLabel).toBe('');
    expect(undated.publishedIso).toBe('');
  });

  it('leaves out what has no page or no title, and shows a page once', () => {
    const items = toLatestItems([
      doc({ slug: '' }),
      doc({ 'Cloud Provider': '' }),
      doc({ Title: '', title: '' }),
      doc({}),
      doc({ Title: 'Same page again' }),
      doc({ type: 'architecture', slug: 'hub-spoke' }),
    ]);
    expect(items.map((item) => item.path)).toEqual([
      '/azure/blog/a-slug',
      '/azure/architecture-designs/hub-spoke',
    ]);
    expect(items[1].typeLabel).toBe('Architecture');
  });

  it('shows at most the limit, and copes with nothing at all', () => {
    const many = Array.from({ length: 10 }, (_, i) => doc({ slug: `s-${i}` }));
    expect(toLatestItems(many)).toHaveLength(LATEST_LIMIT);
    expect(toLatestItems(undefined)).toEqual([]);
    expect(toLatestItems(null)).toEqual([]);
  });

  it('formats dates in one locale and zone for every visitor', () => {
    expect(formatPublishedDate(Date.parse('2026-01-01T00:30:00Z'))).toBe('Jan 1, 2026');
    expect(formatPublishedDate(0)).toBe('');
  });
});
