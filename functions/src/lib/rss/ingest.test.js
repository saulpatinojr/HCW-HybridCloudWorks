import { describe, it, expect, vi } from 'vitest';
import { createRssIngest, RSS_CACHE_CONTAINER, HOMEPAGE_FEEDS_CONTAINER } from './ingest.js';

const NOW = new Date('2026-08-21T16:00:00.000Z');

function makeStore() {
  const docs = { rss_cache: {}, content: {}, homepage_feeds: {} };
  return {
    docs,
    upsertDoc: vi.fn(async (c, d) => {
      docs[c][d.id] = d;
      return d;
    }),
    queryDocs: vi.fn(async (c, _q, params) => {
      const provider = params?.[0]?.value;
      return Object.values(docs[c] || {}).filter((d) => !provider || d.provider === provider);
    }),
  };
}

const dedupNone = {
  findDuplicateContent: vi.fn(async () => ({ duplicate: false })),
  buildDedupFields: vi.fn(({ url, title }) => ({
    normalizedUrl: url,
    normalizedTitle: title.toLowerCase(),
  })),
};

const item = (i, extra = {}) => ({
  title: `Item ${i}`,
  link: `https://example.test/${i}`,
  isoDate: `2026-08-${String(10 + (i % 10)).padStart(2, '0')}T00:00:00Z`,
  contentSnippet: `snippet ${i}`,
  ...extra,
});

const feeds = {
  azure: [{ name: 'Azure Blog', url: 'https://azure/feed' }],
  aws: [{ name: 'AWS Blog', url: 'https://aws/feed' }],
};

describe('processRssFeeds', () => {
  it('caches every feed (capped), drafts up to 10 new items, rebuilds the homepage, counts everything', async () => {
    const store = makeStore();
    const parser = {
      parseURL: vi.fn(async () => ({ items: Array.from({ length: 30 }, (_, i) => item(i)) })),
    };
    const ingest = createRssIngest({
      store,
      parser,
      dedup: dedupNone,
      now: () => NOW,
      uuid: (() => {
        let n = 0;
        return () => `id-${n++}`;
      })(),
    });

    const r = await ingest.processRssFeeds({ feeds });

    expect(r).toMatchObject({
      processed: 2,
      cached: 2,
      newContent: 20,
      duplicates: 0,
      skipped: 0,
      errors: [],
    });
    const azure = store.docs.rss_cache.azure_azure_blog;
    expect(azure).toMatchObject({
      provider: 'azure',
      feedName: 'Azure Blog',
      itemCount: 20,
      lastFetched: NOW.toISOString(),
    });
    expect(azure.items).toHaveLength(20);
    expect(Object.keys(store.docs.content)).toHaveLength(20);
    expect(Object.values(store.docs.content)[0]).toMatchObject({
      contentStatus: 'ingested',
      Live: false,
      source: 'rss',
    });
    const home = store.docs.homepage_feeds.latest;
    expect(home.itemCount).toBe(r.homepageItems);
    expect(home.items.length).toBeGreaterThan(0);
    expect(home.items.map((i) => i.provider).slice(0, 2)).toEqual(['azure', 'aws']);
  });

  it('caches the newest items of an oldest-first feed, and still drafts in feed order', async () => {
    // The cap used to be applied here, in feed order, before buildCacheItems
    // could choose by date (T-319) — so a feed that publishes oldest-first
    // cached only its archive. Drafting deliberately still walks feed order.
    const store = makeStore();
    const oldestFirst = Array.from({ length: 30 }, (_, i) => ({
      title: `Item ${i}`,
      link: `https://example.test/${i}`,
      isoDate: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
      contentSnippet: `snippet ${i}`,
    }));
    const ingest = createRssIngest({
      store,
      parser: { parseURL: vi.fn(async () => ({ items: oldestFirst })) },
      dedup: dedupNone,
      now: () => NOW,
      uuid: (() => {
        let n = 0;
        return () => `id-${n++}`;
      })(),
    });

    await ingest.processRssFeeds({ feeds: { azure: feeds.azure } });

    const cached = store.docs.rss_cache.azure_azure_blog;
    expect(cached.items).toHaveLength(20);
    expect(cached.items[0].title).toBe('Item 29');
    expect(cached.itemCount).toBe(20);
    // Drafting is unchanged: the first 10 of the parsed feed, as before.
    expect(Object.values(store.docs.content).map((d) => d.Title)).toEqual(
      Array.from({ length: 10 }, (_, i) => `Item ${i}`)
    );
  });

  it('skips duplicates and items without a link, and counts them separately', async () => {
    const store = makeStore();
    const parser = {
      parseURL: vi.fn(async () => ({ items: [item(1), item(2, { link: '' }), item(3)] })),
    };
    const dedup = {
      ...dedupNone,
      findDuplicateContent: vi.fn(async (_s, c) => ({
        duplicate: c.url.endsWith('/3'),
        reason: 'exact_url',
      })),
    };
    const ingest = createRssIngest({ store, parser, dedup, now: () => NOW });
    const r = await ingest.processRssFeeds({ feeds: { azure: feeds.azure } });
    expect(r).toMatchObject({ newContent: 1, duplicates: 1 });
    expect(Object.keys(store.docs.content)).toHaveLength(1);
  });

  it('isolates a failing feed, records the reason, and still builds the homepage', async () => {
    const store = makeStore();
    const parser = {
      parseURL: vi.fn(async (url) => {
        if (url.includes('aws')) throw new Error('Status code 404');
        return { items: [item(1)] };
      }),
    };
    const log = { warn: vi.fn(), log: vi.fn() };
    const ingest = createRssIngest({ store, parser, dedup: dedupNone, now: () => NOW, log });
    const r = await ingest.processRssFeeds({ feeds });
    expect(r.processed).toBe(1);
    // The feed is named; the failure is a sentence with the code and the log
    // line's reference (#945).
    expect(r.errors).toEqual([
      expect.stringMatching(/^aws\/AWS Blog: The feed could not be read \(Error; reference [\w.:-]+\)\.$/),
    ]);
    expect(store.docs.homepage_feeds.latest).toBeDefined();
    expect(log.warn).toHaveBeenCalled();
  });

  it('treats a TLS failure as a skip with its code, never a bypass', async () => {
    const store = makeStore();
    const parser = {
      parseURL: vi.fn(async () => {
        throw Object.assign(new Error('cert'), { code: 'CERT_HAS_EXPIRED' });
      }),
    };
    const ingest = createRssIngest({ store, parser, dedup: dedupNone, now: () => NOW });
    const r = await ingest.processRssFeeds({ feeds: { azure: feeds.azure } });
    expect(r).toMatchObject({
      processed: 0,
      skipped: 1,
      errors: ['azure/Azure Blog: TLS validation failed (CERT_HAS_EXPIRED)'],
    });
    expect(store.upsertDoc).toHaveBeenCalledWith(
      HOMEPAGE_FEEDS_CONTAINER,
      expect.objectContaining({ id: 'latest' })
    );
    expect(store.upsertDoc).not.toHaveBeenCalledWith(RSS_CACHE_CONTAINER, expect.anything());
  });

  it('reports a homepage aggregation failure without losing the feed results', async () => {
    const store = makeStore();
    store.queryDocs.mockRejectedValue(new Error('429'));
    const parser = { parseURL: vi.fn(async () => ({ items: [item(1)] })) };
    const ingest = createRssIngest({ store, parser, dedup: dedupNone, now: () => NOW });
    const r = await ingest.processRssFeeds({ feeds: { azure: feeds.azure } });
    expect(r.processed).toBe(1);
    expect(r.homepageItems).toBeNull();
    expect(r.errors).toEqual([
      expect.stringMatching(
        /^homepage_feeds: The homepage feed could not be rebuilt \(Error; reference [\w.:-]+\)\.$/
      ),
    ]);
  });

  it('throws immediately when signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const store = makeStore();
    const parser = { parseURL: vi.fn() };
    const ingest = createRssIngest({ store, parser, dedup: dedupNone, now: () => NOW });
    await expect(ingest.processRssFeeds({ feeds, signal: controller.signal })).rejects.toThrow();
    expect(parser.parseURL).not.toHaveBeenCalled();
  });
});

describe('configured blog intake', () => {
  it('runs only the requested source, respects its limit, records health, and retains other active homepage sources', async () => {
    const store = makeStore();
    store.docs.admin_settings = {};
    const source = { id: 'blog-source-kiro', name: 'Kiro', url: 'https://kiro.dev/blog/feed.rss', maxItems: 1, fallbackImageUrl: 'https://example.com/default.png', official: true };
    const other = { id: 'blog-source-other', name: 'Other', url: 'https://other.example/feed' };
    store.docs.rss_cache.aws_other = { id: 'aws_other', provider: 'aws', items: [{ title: 'Previously cached', link: 'https://other.example/post', pubDate: NOW.toISOString() }] };
    store.docs.rss_cache.aws_paused = { id: 'aws_paused', provider: 'aws', items: [{ title: 'Paused', link: 'https://paused.example/post', pubDate: NOW.toISOString() }] };
    const parser = { parseURL: vi.fn(async () => ({ items: [item(1), item(2)] })) };
    const result = await createRssIngest({ store, parser, dedup: dedupNone, uuid: () => 'new', now: () => NOW }).processRssFeeds({ feeds: { aws: [source, other] }, sourceId: source.id });
    expect(result.newContent).toBe(1);
    expect(parser.parseURL).toHaveBeenCalledTimes(1);
    expect(store.docs.content.new).toMatchObject({ blogSourceId: source.id, blogFallbackImageUrl: source.fallbackImageUrl, Live: false, inspectTrigger: true });
    expect(store.docs.admin_settings[`run-${source.id}`].status).toBe('succeeded');
    const homepage = store.docs.homepage_feeds.latest.items;
    expect(homepage.some(item => item.title === 'Previously cached')).toBe(true);
    expect(homepage.some(item => item.title === 'Paused')).toBe(false);
  });
  it('records a failed source run without abandoning another source', async () => {
    const store = makeStore(); store.docs.admin_settings = {};
    const parser = { parseURL: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ items: [] }) };
    const result = await createRssIngest({ store, parser, dedup: dedupNone }).processRssFeeds({ feeds: { aws: [
      { id: 'broken', name: 'Broken', url: 'https://broken.example' },
      { id: 'healthy', name: 'Healthy', url: 'https://healthy.example' },
    ] } });
    expect(result.processed).toBe(1);
    expect(store.docs.admin_settings['run-broken'].status).toBe('failed');
    expect(store.docs.admin_settings['run-healthy'].status).toBe('succeeded');
  });
});
