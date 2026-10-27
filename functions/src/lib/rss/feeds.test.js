import { describe, it, expect } from 'vitest';
import {
  feedImageUrl,
  PROVIDER_FEEDS,
  PROVIDERS,
  MAX_CACHE_ITEMS_PER_FEED,
  cleanFeedTitle,
  categorizeItem,
  normalizeCategories,
  truncateText,
  estimateReadTime,
  generateSlug,
  cacheDocId,
  buildCacheItems,
  buildRssContentDoc,
  describeFeedError,
  buildHomepageFeedItems,
} from './feeds.js';

const NOW = new Date('2026-08-21T16:00:00.000Z');
const feed = { name: 'Azure Blog', url: 'https://azure.microsoft.com/en-us/blog/feed/' };

describe('feed catalogue', () => {
  it('names every provider the public news pages know, with https feeds only', () => {
    expect(PROVIDERS).toEqual([
      'azure',
      'aws',
      'gcp',
      'github',
      'terraform',
      'ansible',
      'vmware',
      'finops',
      'docker',
    ]);
    for (const list of Object.values(PROVIDER_FEEDS)) {
      for (const f of list) expect(f.url).toMatch(/^https:\/\//);
    }
  });

  it('reads Docker’s blog at the address its old one redirects to (#777)', () => {
    // https://www.docker.com/blog/feed/ answers with a redirect to this URL.
    expect(PROVIDER_FEEDS.docker).toEqual([
      { name: 'Docker Blog', url: 'https://www.docker.com/feed/' },
    ]);
    expect(describeFeedError('docker/Docker Blog: Status code 404')).toBe(
      'Docker Blog (Docker): the feed address no longer exists.'
    );
  });
});

describe('text helpers', () => {
  it('strips markup, collapses whitespace, truncates on a word boundary', () => {
    expect(truncateText('<p>Hello   <b>world</b> again</p>', 11)).toBe('Hello...');
    expect(truncateText('short', 50)).toBe('short');
    expect(truncateText('', 10)).toBe('');
  });

  it('estimates read time at 200 wpm with a 1-minute floor and a 3-minute default', () => {
    expect(estimateReadTime('')).toBe('3 min');
    expect(estimateReadTime('one two three')).toBe('1 min');
    expect(estimateReadTime(Array(401).fill('w').join(' '))).toBe('3 min');
  });

  it('slugs are lowercase, hyphenated, capped at 60', () => {
    expect(generateSlug('Hello, World! 2026')).toBe('hello-world-2026');
    expect(generateSlug('x'.repeat(80))).toHaveLength(60);
  });

  it('normalizes preview and launched prefixes without duplicate tags', () => {
    expect(cleanFeedTitle('[In preview] Public Preview: Azure SQL DB offline')).toBe(
      'Public Preview: Azure SQL DB offline'
    );
    expect(cleanFeedTitle('[In preview] Azure Cosmos DB feature')).toBe(
      'Public Preview: Azure Cosmos DB feature'
    );
    expect(cleanFeedTitle('[Launched] Generally Available: Azure App Service v3')).toBe(
      'GA: Azure App Service v3'
    );
    expect(cleanFeedTitle('[Launched] Azure Functions v4')).toBe('GA: Azure Functions v4');
    expect(cleanFeedTitle('Standard Announcement Title')).toBe('Standard Announcement Title');
    expect(cleanFeedTitle('')).toBe('');
  });
});

describe('categories', () => {
  it('normalizes string, xml2js-object and junk category shapes', () => {
    expect(
      normalizeCategories(['A', { _: 'B' }, { $: { term: 'C' } }, {}, null, 7, ' D '])
    ).toEqual(['A', 'B', 'C', 'D']);
    expect(normalizeCategories(undefined)).toEqual([]);
  });

  it('picks the first matching category, else Update', () => {
    expect(categorizeItem({ title: 'New Kubernetes release' })).toBe('Containers');
    expect(categorizeItem({ title: 'Quarterly notes', contentSnippet: 'budget review' })).toBe(
      'Cost'
    );
    expect(categorizeItem({ title: 'Hello', categories: [{ _: 'security' }] })).toBe('Security');
    expect(categorizeItem({ title: 'Nothing special' })).toBe('Update');
  });
});

describe('cache documents', () => {
  it('ids and caps items per feed, in the shape the public feed reads', () => {
    expect(cacheDocId('azure', feed)).toBe('azure_azure_blog');
    const items = Array.from({ length: 25 }, (_, i) => ({
      title: `t${i}`,
      link: `https://x/${i}`,
      pubDate: '2026-08-20',
      contentSnippet: 'serverless things',
    }));
    const cached = buildCacheItems(items, feed);
    expect(cached).toHaveLength(MAX_CACHE_ITEMS_PER_FEED);
    expect(cached[0]).toEqual({
      title: 't0',
      link: 'https://x/0',
      pubDate: '2026-08-20',
      summary: 'serverless things',
      category: 'Serverless',
      author: 'Azure Blog',
    });
  });

  // T-319. Feed order is conventionally newest-first, but nothing enforces
  // it, and both readers of this array sort by pubDate — so anything the cap
  // drops here is dropped from the site, not merely from the top of a list.
  it('keeps the newest items, not the first, when a feed exceeds the cap', () => {
    const items = Array.from({ length: 25 }, (_, i) => ({
      title: `t${i}`,
      link: `https://x/${i}`,
      // Ascending: oldest first, which a first-N cap would keep.
      pubDate: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
    }));
    const cached = buildCacheItems(items, feed);

    expect(cached).toHaveLength(MAX_CACHE_ITEMS_PER_FEED);
    expect(cached[0].title).toBe('t24');
    expect(cached.at(-1).title).toBe('t5');
  });

  it('falls back to isoDate when an item has no pubDate', () => {
    const items = [
      { title: 'old', link: 'https://x/o', isoDate: '2026-01-01T00:00:00Z' },
      { title: 'new', link: 'https://x/n', isoDate: '2026-06-01T00:00:00Z' },
    ];
    const cached = buildCacheItems(items, feed, 1);

    expect(cached[0].title).toBe('new');
    expect(cached[0].pubDate).toBe('2026-06-01T00:00:00Z');
  });

  it('sorts undated items last so they are dropped before dated ones', () => {
    // Date.parse('') is NaN. Treating a missing date as "now" would let one
    // malformed item evict a real article.
    const items = [
      ...Array.from({ length: 22 }, (_, i) => ({ title: `u${i}`, link: `https://x/u${i}` })),
      { title: 'dated', link: 'https://x/d', pubDate: '2026-07-01T00:00:00Z' },
    ];
    const cached = buildCacheItems(items, feed);

    expect(cached).toHaveLength(MAX_CACHE_ITEMS_PER_FEED);
    expect(cached[0].title).toBe('dated');
  });

  it('leaves an all-undated feed in its original order', () => {
    const items = Array.from({ length: 22 }, (_, i) => ({ title: `u${i}`, link: `https://x/${i}` }));
    const cached = buildCacheItems(items, feed);

    expect(cached.map((c) => c.title)).toEqual(
      Array.from({ length: MAX_CACHE_ITEMS_PER_FEED }, (_, i) => `u${i}`)
    );
  });

  it('does not mutate the parsed feed array it was handed', () => {
    const items = [
      { title: 'a', link: 'https://x/a', pubDate: '2026-01-01T00:00:00Z' },
      { title: 'b', link: 'https://x/b', pubDate: '2026-09-01T00:00:00Z' },
    ];
    buildCacheItems(items, feed);

    // draftNewContent reads the same array afterwards and drafts in feed order.
    expect(items.map((i) => i.title)).toEqual(['a', 'b']);
  });
});

describe('buildRssContentDoc', () => {
  const base = {
    item: {
      title: 'Intro to AKS',
      link: 'https://a/b',
      isoDate: '2026-08-19T10:00:00Z',
      content: '<p>AKS news</p>',
      categories: ['k8s'],
    },
    sourceUrl: 'https://a/b',
    title: 'Intro to AKS',
    summary: 'AKS news',
    provider: 'azure',
    feed,
    dedupFields: { normalizedUrl: 'a/b', normalizedTitle: 'intro to aks' },
    now: NOW,
    uuid: () => 'doc-1',
  };

  it('is an ingested, non-live Draft with the site field names and ISO dates', () => {
    const doc = buildRssContentDoc(base);
    expect(doc).toMatchObject({
      id: 'doc-1',
      normalizedUrl: 'a/b',
      'Created At': NOW.toISOString(),
      'Cloud Provider': 'Azure',
      Title: 'Intro to AKS',
      'CD Url': 'https://a/b',
      Slug: 'intro-to-aks',
      Live: false,
      'Published At': '2026-08-19T10:00:00.000Z',
      Status: 'Draft',
      Tags: ['k8s'],
      source: 'rss',
      storageCollection: 'content',
      category: 'Containers',
      contentStatus: 'ingested',
      inspectTrigger: true,
      fetchedAt: NOW.toISOString(),
    });
  });

  it('never invents a publish date', () => {
    const doc = buildRssContentDoc({ ...base, item: { ...base.item, isoDate: undefined } });
    expect(doc).not.toHaveProperty('Published At');
    const bad = buildRssContentDoc({ ...base, item: { ...base.item, isoDate: 'not a date' } });
    expect(bad).not.toHaveProperty('Published At');
  });
});

describe('describeFeedError', () => {
  it('explains the common failures in plain English with the friendly provider name', () => {
    expect(describeFeedError('azure/Azure Blog: TLS validation failed (CERT_HAS_EXPIRED)')).toBe(
      "Azure Blog (Microsoft Azure): their site's security certificate couldn't be verified, so we skipped it to stay safe."
    );
    expect(describeFeedError('gcp/GCP Release Notes: Status code 404')).toBe(
      'GCP Release Notes (Google Cloud): the feed address no longer exists.'
    );
    expect(describeFeedError('aws/AWS Blog: Non-whitespace before first tag.')).toMatch(
      /badly formatted data/
    );
    expect(describeFeedError('weird')).toMatch(/^A feed: we hit an unexpected problem/);
  });
});

describe('buildHomepageFeedItems', () => {
  it('interleaves the two newest linked items per provider, ten in all, ids by provider and pass', () => {
    const doc = (provider, n) => ({
      provider,
      feedName: `${provider} feed`,
      items: Array.from({ length: n }, (_, i) => ({
        title: `${provider}${i}`,
        link: i === 0 ? '' : `https://${provider}/${i}`, // the first has no link and must be dropped
        pubDate: `2026-08-${10 + i}`,
        summary: 's',
        category: 'Update',
      })),
    });
    const byProvider = Object.fromEntries(PROVIDERS.map((p) => [p, [doc(p, 4)]]));
    const items = buildHomepageFeedItems(byProvider);
    expect(items).toHaveLength(10);
    // One newest item from each of the nine providers, then the second pass
    // starts; with Docker (#777) there is room for one second-pass item.
    expect(items.slice(0, PROVIDERS.length).map((i) => i.provider)).toEqual(PROVIDERS);
    expect(items[0]).toMatchObject({ id: 'azure-0', title: 'azure3', link: 'https://azure/3' });
    expect(items[8]).toMatchObject({ id: 'docker-0', title: 'docker3' });
    expect(items[9]).toMatchObject({ id: 'azure-1', title: 'azure2' });
    expect(items.every((i) => i.link)).toBe(true);
  });

  it('copes with providers that have nothing cached', () => {
    expect(buildHomepageFeedItems({})).toEqual([]);
  });
});


it('does not confuse feed audio or video enclosures with article images', () => {
  expect(feedImageUrl({ enclosure: { url: 'https://example.com/audio', type: 'audio/mpeg' } })).toBe('');
  expect(feedImageUrl({ enclosure: { url: 'https://example.com/clip.mp4?width=400' } })).toBe('');
  expect(feedImageUrl({ enclosure: { url: 'https://example.com/picture', type: 'image/jpeg' } })).toBe('https://example.com/picture');
  expect(feedImageUrl({ mediaContent: { $: { url: 'https://example.com/hero.png' } } })).toBe('https://example.com/hero.png');
});
