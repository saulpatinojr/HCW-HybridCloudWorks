/**
 * sync.js: one Search Console run against a stubbed Google and a stubbed
 * store (#1612). Nothing here reaches the network.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  analyticsRange,
  createSearchConsoleSync,
  findStrays,
  HISTORY_MAX,
  MAX_URLS,
  parseSitemap,
  presentSitemaps,
  selectSiteUrls,
  SNAPSHOT_DOC_ID,
  summarizeIndexing,
} from './sync.js';
import { GoogleAuthError } from './google-auth.js';
import { SearchConsoleError } from './client.js';

const ENV = {
  GSC_WIF_AUDIENCE: '//iam.googleapis.com/projects/000000000001/locations/global/workloadIdentityPools/hcw-azure/providers/entra',
  GSC_ENTRA_APP_ID_URI: 'api://00000000-0000-0000-0000-000000000001',
  GSC_SERVICE_ACCOUNT_EMAIL: 'sa-hcw-search-console@example-project.iam.gserviceaccount.com',
};
const NOW = new Date('2026-11-09T00:10:00Z');

const sitemapXml = (urls) =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
    .map((u) => `<url><loc>${u}</loc></url>`)
    .join('')}</urlset>`;

const textResponse = (status, text) => ({ ok: status >= 200 && status < 300, status, text: async () => text });

/** A Cosmos stand-in with ETags, so the ifMatch path is exercised. */
function memoryStore(initial = null) {
  let doc = initial ? { ...initial, _etag: 'e0' } : null;
  let version = 0;
  const store = {
    readDoc: vi.fn(async () => (doc ? structuredClone(doc) : null)),
    createDoc: vi.fn(async (_container, next) => {
      if (doc) throw Object.assign(new Error('conflict'), { code: 409 });
      version += 1;
      doc = { ...next, _etag: `e${version}` };
      return doc;
    }),
    replaceDocIfMatch: vi.fn(async (_container, next, options) => {
      expect(options).toEqual({ partitionKey: 'admin_config' });
      if (!doc || next._etag !== doc._etag) throw Object.assign(new Error('precondition'), { code: 412 });
      version += 1;
      doc = { ...next, _etag: `e${version}` };
      return doc;
    }),
    get doc() {
      return doc;
    },
  };
  return store;
}

function googleStub({ inspect, searchAnalytics, listSitemaps } = {}) {
  return {
    inspect: vi.fn(
      inspect ??
        (async (url) => ({
          inspectionResultLink: `https://search.google.com/search-console/inspect?id=${encodeURIComponent(url)}`,
          indexStatusResult: {
            verdict: url.endsWith('/bad') ? 'FAIL' : 'PASS',
            coverageState: url.endsWith('/bad') ? 'Crawled - currently not indexed' : 'Submitted and indexed',
            pageFetchState: 'SUCCESSFUL',
            robotsTxtState: 'ALLOWED',
            indexingState: 'INDEXING_ALLOWED',
            lastCrawlTime: '2026-11-01T00:00:00Z',
            googleCanonical: url,
            userCanonical: url,
          },
        }))
    ),
    searchAnalytics: vi.fn(
      searchAnalytics ??
        (async (body) => {
          const dimension = body.dimensions?.[0];
          if (!dimension) return [{ clicks: 10, impressions: 200, ctr: 0.05, position: 7.5 }];
          if (dimension === 'date') return [{ keys: ['2026-11-02'], clicks: 1, impressions: 2, ctr: 0.5, position: 3 }, { keys: ['2026-11-01'], clicks: 2, impressions: 4, ctr: 0.5, position: 4 }];
          if (dimension === 'page')
            return [
              { keys: ['https://hybridcloudworks.com/a'], clicks: 5, impressions: 50, ctr: 0.1, position: 2 },
              { keys: ['https://hybridcloudworks.com/old-page'], clicks: 1, impressions: 90, ctr: 0.01, position: 9 },
              { keys: ['https://hybridcloudworks.com/a/'], clicks: 0, impressions: 3, ctr: 0, position: 9 },
              { keys: ['https://api-azure.hybridcloudworks.com/x'], clicks: 0, impressions: 80, ctr: 0, position: 9 },
            ];
          return [{ keys: [`${dimension}-1`], clicks: 3, impressions: 30, ctr: 0.1, position: 5 }];
        })
    ),
    listSitemaps: vi.fn(
      listSitemaps ??
        (async () => [
          {
            path: 'https://hybridcloudworks.com/sitemap.xml',
            lastSubmitted: '2026-11-01T00:00:00Z',
            isPending: false,
            lastDownloaded: '2026-11-08T00:00:00Z',
            warnings: '0',
            errors: '1',
            contents: [{ type: 'web', submitted: '203', indexed: '0' }],
          },
        ])
    ),
  };
}

function setup({ urls = ['https://hybridcloudworks.com/a', 'https://hybridcloudworks.com/bad'], stored = null, google, env = ENV, signal, sitemap } = {}) {
  const store = memoryStore(stored);
  const client = google ?? googleStub();
  const fetchImpl = vi.fn(async () => sitemap ?? textResponse(200, sitemapXml(urls)));
  const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const sync = createSearchConsoleSync({
    store,
    env,
    fetchImpl,
    client,
    now: () => NOW,
    sleep: async () => {},
    spacingMs: 0,
    signal,
    log,
  });
  return { store, client, fetchImpl, log, sync };
}

describe('the pure helpers', () => {
  it('reads <loc> entries, entities and CDATA included, and tells an index from a urlset', () => {
    expect(parseSitemap(sitemapXml(['https://hybridcloudworks.com/a?x=1&amp;y=2']))).toEqual({
      isIndex: false,
      locs: ['https://hybridcloudworks.com/a?x=1&y=2'],
    });
    const index = '<sitemapindex><sitemap><loc><![CDATA[https://hybridcloudworks.com/s1.xml]]></loc></sitemap></sitemapindex>';
    expect(parseSitemap(index)).toEqual({ isIndex: true, locs: ['https://hybridcloudworks.com/s1.xml'] });
  });

  it('keeps root-domain https pages only, once each, up to the cap', () => {
    const locs = [
      'https://hybridcloudworks.com/a',
      'https://hybridcloudworks.com/a',
      'https://api-azure.hybridcloudworks.com/x',
      'https://www.hybridcloudworks.com/y',
      'http://hybridcloudworks.com/z',
      'not a url',
      'https://hybridcloudworks.com/b',
    ];
    expect(selectSiteUrls(locs)).toEqual({ urls: ['https://hybridcloudworks.com/a', 'https://hybridcloudworks.com/b'], total: 2 });
    const many = Array.from({ length: MAX_URLS + 5 }, (_, i) => `https://hybridcloudworks.com/p${i}`);
    expect(selectSiteUrls(many).urls).toHaveLength(MAX_URLS);
    expect(selectSiteUrls(many).total).toBe(MAX_URLS + 5);
  });

  it('ends the range two days ago and spans 90 or 28 days', () => {
    expect(analyticsRange(NOW)).toEqual({ startDate: '2026-08-10', endDate: '2026-11-07' });
    expect(analyticsRange(NOW, 28)).toEqual({ startDate: '2026-10-11', endDate: '2026-11-07' });
  });

  it('finds strays: root-domain pages with traffic the sitemap lacks, trailing slash ignored', () => {
    const rows = [
      { keys: ['https://hybridcloudworks.com/a/'], clicks: 1, impressions: 5 },
      { keys: ['https://hybridcloudworks.com/old'], clicks: 0, impressions: 9 },
      { keys: ['https://hybridcloudworks.com/older'], clicks: 2, impressions: 20 },
      { keys: ['https://labs.hybridcloudworks.com/x'], clicks: 9, impressions: 99 },
    ];
    expect(findStrays(rows, ['https://hybridcloudworks.com/a'])).toEqual([
      { url: 'https://hybridcloudworks.com/older', clicks: 2, impressions: 20 },
      { url: 'https://hybridcloudworks.com/old', clicks: 0, impressions: 9 },
    ]);
  });

  it('counts verdicts and leaves failed inspections as unknown', () => {
    const pages = [
      { verdict: 'PASS', coverageState: 'Submitted and indexed', pageFetchState: 'SUCCESSFUL', error: null },
      { verdict: 'NEUTRAL', coverageState: 'Excluded by noindex', pageFetchState: 'SUCCESSFUL', error: null },
      { verdict: 'VERDICT_UNSPECIFIED', coverageState: '', pageFetchState: '', error: 'HTTP 500' },
    ];
    expect(summarizeIndexing(pages)).toEqual({
      pass: 1,
      neutral: 1,
      fail: 0,
      unknown: 1,
      byCoverageState: [
        { key: 'Excluded by noindex', count: 1 },
        { key: 'Submitted and indexed', count: 1 },
      ],
      byPageFetchState: [{ key: 'SUCCESSFUL', count: 2 }],
    });
  });

  it('turns Google\'s string counts into numbers', () => {
    expect(presentSitemaps([{ path: 'p', warnings: '2', errors: '0', contents: [{ type: 'web', submitted: '5', indexed: '1' }] }])).toEqual([
      { path: 'p', lastSubmitted: null, lastDownloaded: null, isPending: false, warnings: 2, errors: 0, contents: [{ type: 'web', submitted: 5, indexed: 1 }] },
    ]);
  });
});

describe('createSearchConsoleSync', () => {
  it('skips and writes nothing while a sign-in setting is empty', async () => {
    const { sync, store, fetchImpl, client } = setup({ env: { ...ENV, GSC_SERVICE_ACCOUNT_EMAIL: '' } });
    await expect(sync.run()).resolves.toEqual({ skipped: 'not_configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(client.inspect).not.toHaveBeenCalled();
    expect(store.createDoc).not.toHaveBeenCalled();
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
  });

  it('writes the snapshot in the page\'s shape', async () => {
    const { sync, store, client, fetchImpl } = setup();
    const result = await sync.run();
    expect(result).toMatchObject({ status: 'ok', pages: 2, inspected: 2, failed: 0, strays: 1 });
    expect(fetchImpl).toHaveBeenCalledWith('https://hybridcloudworks.com/sitemap.xml', expect.any(Object));

    const doc = store.doc;
    expect(doc).toMatchObject({ id: SNAPSHOT_DOC_ID, configScope: 'admin_config', status: 'ok', siteUrl: 'sc-domain:hybridcloudworks.com' });
    expect(doc.generatedAt).toBe(NOW.toISOString());
    expect(doc.run).toEqual({ startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), inspected: 2, failed: 0, message: null });
    // Problems first.
    expect(doc.indexing.pages.map((p) => [p.url, p.verdict])).toEqual([
      ['https://hybridcloudworks.com/bad', 'FAIL'],
      ['https://hybridcloudworks.com/a', 'PASS'],
    ]);
    expect(Object.keys(doc.indexing.pages[0]).sort()).toEqual(
      ['coverageState', 'error', 'googleCanonical', 'indexingState', 'inspectionResultLink', 'lastCrawlTime', 'pageFetchState', 'robotsTxtState', 'url', 'userCanonical', 'verdict'].sort()
    );
    expect(doc.indexing.summary).toMatchObject({ pass: 1, neutral: 0, fail: 1, unknown: 0 });
    expect(doc.indexing.strays).toEqual([{ url: 'https://hybridcloudworks.com/old-page', clicks: 1, impressions: 90 }]);
    expect(doc.indexing.history).toEqual([{ at: NOW.toISOString(), pass: 1, neutral: 0, fail: 1, inspected: 2, failed: 0 }]);

    expect(doc.performance.range).toEqual({ startDate: '2026-08-10', endDate: '2026-11-07' });
    expect(doc.performance.totals).toEqual({ clicks: 10, impressions: 200, ctr: 0.05, position: 7.5 });
    expect(doc.performance.totals28d).toEqual({ clicks: 10, impressions: 200, ctr: 0.05, position: 7.5 });
    expect(doc.performance.daily.map((d) => d.date)).toEqual(['2026-11-01', '2026-11-02']);
    expect(doc.performance.queries).toEqual([{ key: 'query-1', clicks: 3, impressions: 30, ctr: 0.1, position: 5 }]);
    expect(doc.performance.pages).toHaveLength(4);
    for (const key of ['countries', 'devices', 'searchAppearance']) expect(doc.performance[key]).toHaveLength(1);
    expect(doc.sitemaps[0]).toMatchObject({ errors: 1, contents: [{ type: 'web', submitted: 203, indexed: 0 }] });

    // searchAppearance asked on its own, never with another dimension.
    const dims = client.searchAnalytics.mock.calls.map(([body]) => body.dimensions ?? []);
    expect(dims).toContainEqual(['searchAppearance']);
    expect(dims.every((d) => d.length <= 1)).toBe(true);
    const pageQuery = client.searchAnalytics.mock.calls.find(([body]) => body.dimensions?.[0] === 'page')[0];
    expect(pageQuery.rowLimit).toBe(1000);
  });

  it('records one URL\'s failure on that page and carries on', async () => {
    const google = googleStub({
      inspect: async (url) => {
        if (url.endsWith('/bad')) throw new SearchConsoleError('inspect', 500);
        return { indexStatusResult: { verdict: 'PASS' } };
      },
    });
    const { sync, store } = setup({ google });
    const result = await sync.run();
    expect(result).toMatchObject({ status: 'ok', inspected: 2, failed: 1 });
    const bad = store.doc.indexing.pages.find((p) => p.url.endsWith('/bad'));
    expect(bad).toMatchObject({ verdict: 'VERDICT_UNSPECIFIED', error: 'Search Console inspect failed with HTTP 500.' });
    expect(store.doc.indexing.summary.unknown).toBe(1);
  });

  it('stops on a 403, keeps the last good figures and records the error', async () => {
    const stored = {
      id: SNAPSHOT_DOC_ID,
      configScope: 'admin_config',
      status: 'ok',
      generatedAt: '2026-11-08T12:10:00.000Z',
      indexing: { summary: { pass: 9 }, pages: [{ url: 'kept' }], strays: [], history: [{ at: 'x' }] },
      performance: { totals: { clicks: 99 } },
      sitemaps: [{ path: 'kept' }],
    };
    const google = googleStub({
      inspect: async () => {
        throw new SearchConsoleError('inspect', 403);
      },
    });
    const { sync, store, client } = setup({ stored, google, urls: Array.from({ length: 20 }, (_, i) => `https://hybridcloudworks.com/p${i}`) });
    const result = await sync.run();
    expect(result.status).toBe('error');
    // Four lanes may already be in flight; no more start once one has failed.
    expect(client.inspect.mock.calls.length).toBeLessThanOrEqual(4);
    expect(client.searchAnalytics).not.toHaveBeenCalled();
    expect(store.doc.status).toBe('error');
    expect(store.doc.run.message).toContain('not a Full user');
    expect(store.doc.generatedAt).toBe('2026-11-08T12:10:00.000Z');
    expect(store.doc.indexing.pages).toEqual([{ url: 'kept' }]);
    expect(store.doc.indexing.history).toEqual([{ at: 'x' }]);
    expect(store.doc.performance.totals).toEqual({ clicks: 99 });
    expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(1);
  });

  it('stops when Google sign-in fails, naming the hop', async () => {
    const google = googleStub({
      inspect: async () => {
        throw new GoogleAuthError('sts', 400);
      },
    });
    const { sync, store } = setup({ google });
    const result = await sync.run();
    expect(result.status).toBe('error');
    expect(store.doc.run.message).toBe('Google sign-in failed at hop 2 (Google token exchange) with HTTP 400. The runbook\'s setup steps say what each hop needs.');
  });

  it('keeps the last 120 history entries', async () => {
    const history = Array.from({ length: HISTORY_MAX }, (_, i) => ({ at: `h${i}`, pass: 0, neutral: 0, fail: 0, inspected: 0, failed: 0 }));
    const { sync, store } = setup({ stored: { id: SNAPSHOT_DOC_ID, indexing: { history } } });
    await sync.run();
    expect(store.doc.indexing.history).toHaveLength(HISTORY_MAX);
    expect(store.doc.indexing.history[0].at).toBe('h1');
    expect(store.doc.indexing.history.at(-1).at).toBe(NOW.toISOString());
  });

  it('re-reads and writes again when it loses a race (412)', async () => {
    const { sync, store } = setup({ stored: { id: SNAPSHOT_DOC_ID, indexing: { history: [] } } });
    const real = store.replaceDocIfMatch.getMockImplementation();
    store.replaceDocIfMatch.mockImplementationOnce(async () => {
      throw Object.assign(new Error('precondition'), { code: 412 });
    });
    store.replaceDocIfMatch.mockImplementation(real);
    await expect(sync.run()).resolves.toMatchObject({ status: 'ok' });
    expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(2);
    expect(store.readDoc).toHaveBeenCalledTimes(2);
  });

  it('notes an unreadable sitemap and still reads performance', async () => {
    const { sync, store } = setup({ sitemap: textResponse(503, '') });
    const result = await sync.run();
    expect(result).toMatchObject({ status: 'ok', pages: 0 });
    expect(store.doc.run.message).toContain('The sitemap could not be read (HTTP 503).');
    expect(store.doc.performance.totals.clicks).toBe(10);
  });

  it('reads a sitemap index one level down, on the site\'s own host only', async () => {
    const store = memoryStore();
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/sitemap.xml'))
        return textResponse(200, '<sitemapindex><sitemap><loc>https://hybridcloudworks.com/s1.xml</loc></sitemap><sitemap><loc>https://evil.example/s.xml</loc></sitemap></sitemapindex>');
      return textResponse(200, sitemapXml(['https://hybridcloudworks.com/from-child']));
    });
    const sync = createSearchConsoleSync({ store, env: ENV, fetchImpl, client: googleStub(), now: () => NOW, sleep: async () => {}, spacingMs: 0 });
    await sync.run();
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(['https://hybridcloudworks.com/sitemap.xml', 'https://hybridcloudworks.com/s1.xml']);
    expect(store.doc.indexing.pages.map((p) => p.url)).toEqual(['https://hybridcloudworks.com/from-child']);
  });

  it('logs counts and durations only: no address, no token', async () => {
    const { sync, log } = setup();
    await sync.run();
    const lines = log.log.mock.calls.flat().join('\n');
    expect(lines).not.toContain('hybridcloudworks.com');
    expect(lines).toMatch(/2 pages, 2 inspected, 0 failed, 1 strays, \d+s/);
  });

  it('stops starting inspections once the job\'s signal fires', async () => {
    const controller = new AbortController();
    const google = googleStub({
      inspect: async () => {
        controller.abort();
        return { indexStatusResult: { verdict: 'PASS' } };
      },
    });
    const urls = Array.from({ length: 30 }, (_, i) => `https://hybridcloudworks.com/p${i}`);
    const { sync, client, store } = setup({ google, urls, signal: controller.signal });
    await expect(sync.run()).resolves.toMatchObject({ status: 'error', aborted: true });
    expect(client.inspect.mock.calls.length).toBeLessThanOrEqual(4);
    expect(client.searchAnalytics).not.toHaveBeenCalled();
    // Half a run is not written over the last whole one.
    expect(store.createDoc).not.toHaveBeenCalled();
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
  });
});
