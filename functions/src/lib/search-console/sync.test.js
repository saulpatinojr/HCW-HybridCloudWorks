/**
 * sync.js: one Search Console run against a stubbed Google and a stubbed
 * store (#1612). Nothing here reaches the network.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  analyticsRange,
  comparableUrl,
  createSearchConsoleSync,
  findStrays,
  HISTORY_MAX,
  keptInspection,
  MAX_URLS,
  parseSitemap,
  presentSitemaps,
  selectSiteUrls,
  sitemapRoot,
  siteAddress,
  hostOf,
  SNAPSHOT_DOC_ID,
  sortPages,
  STRAYS_INSPECTED_MAX,
  summarizeIndexing,
} from './sync.js';
import { LEASE_DOC_ID } from './lease.js';
import { GoogleAuthError } from './google-auth.js';
import { SearchConsoleError } from './client.js';

const ENV = {
  GSC_WIF_AUDIENCE: '//iam.googleapis.com/projects/000000000001/locations/global/workloadIdentityPools/hcw-azure/providers/entra',
  GSC_ENTRA_APP_ID_URI: 'api://00000000-0000-0000-0000-000000000001',
  GSC_SERVICE_ACCOUNT_EMAIL: 'sa-hcw-search-console@example-project.iam.gserviceaccount.com',
};
/** 00:10 UTC on 2026-11-09 is 2026-11-08 on Google's Pacific quota day. */
const NOW = new Date('2026-11-09T00:10:00Z');
const PACIFIC_DAY = '2026-11-08';

const A = 'https://hybridcloudworks.com/a';
const BAD = 'https://hybridcloudworks.com/bad';

const sitemapXml = (urls) =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
    .map((u) => `<url><loc>${u}</loc></url>`)
    .join('')}</urlset>`;

const textResponse = (status, text) => ({ ok: status >= 200 && status < 300, status, text: async () => text });

/** A Cosmos stand-in for admin_config, by document id, with ETags, so the ifMatch paths are exercised. */
function memoryStore({ snapshot = null, lease = null, jobs = {} } = {}) {
  const docs = new Map();
  let version = 0;
  if (snapshot) docs.set(SNAPSHOT_DOC_ID, { ...snapshot, id: SNAPSHOT_DOC_ID, _etag: 'e0' });
  if (lease) docs.set(LEASE_DOC_ID, { ...lease, id: LEASE_DOC_ID, _etag: 'e0' });
  const store = {
    readDoc: vi.fn(async (container, id) => {
      // Job documents live in their own container (lib/jobs.js).
      if (container === 'jobs') return jobs[id] ?? null;
      return docs.has(id) ? structuredClone(docs.get(id)) : null;
    }),
    createDoc: vi.fn(async (_container, next) => {
      if (docs.has(next.id)) throw Object.assign(new Error('conflict'), { code: 409 });
      version += 1;
      docs.set(next.id, { ...next, _etag: `e${version}` });
      return docs.get(next.id);
    }),
    replaceDocIfMatch: vi.fn(async (_container, next, options) => {
      expect(options).toEqual({ partitionKey: 'admin_config' });
      const current = docs.get(next.id);
      if (!current || next._etag !== current._etag) throw Object.assign(new Error('precondition'), { code: 412 });
      version += 1;
      docs.set(next.id, { ...next, _etag: `e${version}` });
      return docs.get(next.id);
    }),
    /** The snapshot document. */
    get doc() {
      return docs.get(SNAPSHOT_DOC_ID) ?? null;
    },
    get lease() {
      return docs.get(LEASE_DOC_ID) ?? null;
    },
    /** Writes (create or replace) of the snapshot only. */
    snapshotWrites() {
      return [...store.createDoc.mock.calls, ...store.replaceDocIfMatch.mock.calls].filter(([, doc]) => doc.id === SNAPSHOT_DOC_ID).length;
    },
  };
  return store;
}

const passResult = (url) => ({
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
});

/**
 * Asks `beforeSend` before each of `requests` requests, the way client.js
 * does before a first request and each retry, and fails the way client.js
 * does when it answers false.
 */
async function sendAsClientDoes(options, requests = 1) {
  for (let request = 1; request <= requests; request += 1) {
    if (options?.beforeSend && !(await options.beforeSend())) {
      if (request === 1) throw new SearchConsoleError('inspect', undefined, { reason: 'not_sent' });
      throw new SearchConsoleError('inspect', 503);
    }
  }
}

/**
 * Search Analytics' page rows with two strays: a page the sitemap does not
 * list on the main site, and one on a subdomain. `A/` is A with a trailing
 * slash, so it is not a stray. The stub answers no page rows unless a test
 * asks for these, so most tests inspect only their sitemap's pages.
 */
const OLD_PAGE = 'https://hybridcloudworks.com/old-page';
const API_PAGE = 'https://api-azure.hybridcloudworks.com/x';
const STRAY_PAGE_ROWS = [
  { keys: [A], clicks: 5, impressions: 50, ctr: 0.1, position: 2 },
  { keys: [OLD_PAGE], clicks: 1, impressions: 90, ctr: 0.01, position: 9 },
  { keys: ['https://hybridcloudworks.com/a/'], clicks: 0, impressions: 3, ctr: 0, position: 9 },
  { keys: [API_PAGE], clicks: 0, impressions: 80, ctr: 0, position: 9 },
];

/** The Search Analytics queries a run asked, by their dimension ('totals' for none). */
const askedFor = (client) => client.searchAnalytics.mock.calls.map(([body]) => body.dimensions?.[0] ?? 'totals');

function googleStub({ inspect, searchAnalytics, listSitemaps, pageRows = [] } = {}) {
  const answer = inspect ?? (async (url) => passResult(url));
  return {
    inspect: vi.fn(async (url, options) => {
      await sendAsClientDoes(options);
      return answer(url, options);
    }),
    searchAnalytics: vi.fn(
      searchAnalytics ??
        (async (body) => {
          const dimension = body.dimensions?.[0];
          if (!dimension) return [{ clicks: 10, impressions: 200, ctr: 0.05, position: 7.5 }];
          if (dimension === 'date') return [{ keys: ['2026-11-02'], clicks: 1, impressions: 2, ctr: 0.5, position: 3 }, { keys: ['2026-11-01'], clicks: 2, impressions: 4, ctr: 0.5, position: 4 }];
          if (dimension === 'page') return pageRows;
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

function setup({ urls = [A, BAD], stored = null, lease = null, jobs, google, env = ENV, signal, sitemap, fetchImpl, jobId, jobCreatedAt, deadlineMs } = {}) {
  const store = memoryStore({ snapshot: stored, lease, jobs });
  const client = google ?? googleStub();
  const fetch = fetchImpl ?? vi.fn(async () => sitemap ?? textResponse(200, sitemapXml(urls)));
  const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const sync = createSearchConsoleSync({
    store,
    env,
    fetchImpl: fetch,
    client,
    now: () => NOW,
    sleep: async () => {},
    spacingMs: 0,
    signal,
    jobId,
    jobCreatedAt,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
    log,
  });
  return { store, client, fetchImpl: fetch, log, sync };
}

/** A stored snapshot from an earlier good run, with one answer per page. */
const previousRun = (pages = [A, BAD]) => ({
  status: 'ok',
  generatedAt: '2026-11-08T12:10:00.000Z',
  run: { inspected: pages.length, failed: 0 },
  indexing: {
    summary: { pass: 9 },
    pages: pages.map((url) => ({
      url,
      verdict: 'PASS',
      coverageState: 'Submitted and indexed',
      pageFetchState: 'SUCCESSFUL',
      error: null,
      stale: false,
      inspectedAt: '2026-11-08T12:10:00.000Z',
    })),
    strays: [{ url: 'https://hybridcloudworks.com/kept-stray', clicks: 1, impressions: 2 }],
    history: [{ at: 'x' }],
  },
  performance: { totals: { clicks: 99, impressions: 999, ctr: 0.1, position: 3 }, queries: [{ key: 'kept' }] },
  sitemaps: [{ path: 'kept' }],
});

describe('the pure helpers', () => {
  it('reads <loc> entries, entities and CDATA included, and tells an index from a urlset', () => {
    expect(parseSitemap(sitemapXml(['https://hybridcloudworks.com/a?x=1&amp;y=2']))).toEqual({
      isIndex: false,
      locs: ['https://hybridcloudworks.com/a?x=1&y=2'],
    });
    const index = '<sitemapindex><sitemap><loc><![CDATA[https://hybridcloudworks.com/s1.xml]]></loc></sitemap></sitemapindex>';
    expect(parseSitemap(index)).toEqual({ isIndex: true, locs: ['https://hybridcloudworks.com/s1.xml'] });
    expect(parseSitemap(undefined)).toEqual({ isIndex: false, locs: [] });
  });

  it('decodes numeric entities in decimal and hex, once only', () => {
    const { locs } = parseSitemap(
      sitemapXml([
        'https://hybridcloudworks.com/a?x=1&#38;y=2',
        'https://hybridcloudworks.com/b?x=1&#x26;y=2&#X26;z=3',
        'https://hybridcloudworks.com/c?q=&amp;lt;',
        'https://hybridcloudworks.com/d?q=&lt;&gt;&quot;&apos;&AMP;',
        'https://hybridcloudworks.com/e?q=&#0;&#x110000;&#99999999999;',
      ])
    );
    expect(locs).toEqual([
      'https://hybridcloudworks.com/a?x=1&y=2',
      'https://hybridcloudworks.com/b?x=1&y=2&z=3',
      'https://hybridcloudworks.com/c?q=&lt;',
      'https://hybridcloudworks.com/d?q=<>"\'&',
      // Not real characters: left as written.
      'https://hybridcloudworks.com/e?q=&#0;&#x110000;&#99999999999;',
    ]);
  });

  it('keeps https pages on the domain and its subdomains only, once each, up to the cap', () => {
    const locs = [
      A,
      A,
      'https://api-azure.hybridcloudworks.com/x',
      'https://www.hybridcloudworks.com/y',
      'https://HYBRIDCLOUDWORKS.COM/upper',
      'http://hybridcloudworks.com/z',
      'not a url',
      // Look-alikes: the host must be the domain or end with ".hybridcloudworks.com".
      'https://evilhybridcloudworks.com/a',
      'https://hybridcloudworks.com.example.net/a',
      'https://example.net/?u=https://hybridcloudworks.com/',
      'https://hybridcloudworks.com/b',
    ];
    expect(selectSiteUrls(locs)).toEqual({
      urls: [A, 'https://api-azure.hybridcloudworks.com/x', 'https://www.hybridcloudworks.com/y', 'https://HYBRIDCLOUDWORKS.COM/upper', 'https://hybridcloudworks.com/b'],
      total: 5,
    });
    const many = Array.from({ length: MAX_URLS + 5 }, (_, i) => `https://hybridcloudworks.com/p${i}`);
    expect(selectSiteUrls(many).urls).toHaveLength(MAX_URLS);
    expect(selectSiteUrls(many).total).toBe(MAX_URLS + 5);
  });

  it('ends the range two days ago and spans 90 or 28 days', () => {
    expect(analyticsRange(NOW)).toEqual({ startDate: '2026-08-10', endDate: '2026-11-07' });
    expect(analyticsRange(NOW, 28)).toEqual({ startDate: '2026-10-11', endDate: '2026-11-07' });
  });

  it('finds strays on the domain and its subdomains with traffic the sitemap lacks, trailing slashes ignored', () => {
    const rows = [
      { keys: ['https://hybridcloudworks.com/a//'], clicks: 1, impressions: 5 },
      { keys: ['https://hybridcloudworks.com/old'], clicks: 0, impressions: 9 },
      { keys: ['https://hybridcloudworks.com/older'], clicks: 2, impressions: 20 },
      { keys: ['https://hybridcloudworks.com/'], clicks: 2, impressions: 15 },
      { keys: ['https://labs.hybridcloudworks.com/x'], clicks: 9, impressions: 99 },
      { keys: ['https://docs.hybridcloudworks.com/listed/'], clicks: 9, impressions: 98 },
      { keys: ['https://hybridcloudworks.com.example.net/x'], clicks: 9, impressions: 97 },
    ];
    expect(findStrays(rows, [A, 'https://docs.hybridcloudworks.com/listed'])).toEqual([
      { url: 'https://labs.hybridcloudworks.com/x', clicks: 9, impressions: 99 },
      { url: 'https://hybridcloudworks.com/older', clicks: 2, impressions: 20 },
      { url: 'https://hybridcloudworks.com/', clicks: 2, impressions: 15 },
      { url: 'https://hybridcloudworks.com/old', clicks: 0, impressions: 9 },
    ]);
    expect(findStrays(rows, [A], { max: 2 })).toHaveLength(2);
  });

  it('compares a path made only of slashes, and a long run of them, without a slow pattern', () => {
    expect(comparableUrl('https://hybridcloudworks.com//')).toBe('https://hybridcloudworks.com/');
    const many = `https://hybridcloudworks.com/${'/'.repeat(50000)}x`;
    const started = Date.now();
    expect(comparableUrl(many)).toBe(`https://hybridcloudworks.com/${'/'.repeat(50000)}x`);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('reads a <loc> whose spaces never close in a time that grows only with its length', () => {
    const hostile = `<urlset><loc>${' '.repeat(30000)}</urlset>`;
    const started = Date.now();
    expect(parseSitemap(hostile).locs).toEqual([]);
    expect(parseSitemap(`<urlset>${'<loc>'.repeat(20000)}</urlset>`).locs).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
    // A <loc> holding markup, an empty one, and a closing tag with no opening one give nothing.
    expect(parseSitemap('<urlset></loc><loc><b>x</b></loc><loc>  </loc><LOC> https://hybridcloudworks.com/u </LOC></urlset>').locs).toEqual([
      'https://hybridcloudworks.com/u',
    ]);
  });

  it('counts verdicts by the latest answer, kept answers included, and leaves pages with none as unknown', () => {
    const pages = [
      { verdict: 'PASS', coverageState: 'Submitted and indexed', pageFetchState: 'SUCCESSFUL', error: null },
      { verdict: 'NEUTRAL', coverageState: 'Excluded by noindex', pageFetchState: 'SUCCESSFUL', error: null },
      { verdict: 'PASS', coverageState: '', pageFetchState: 'SUCCESSFUL', error: 'Not inspected', stale: true },
      { verdict: 'VERDICT_UNSPECIFIED', coverageState: '', pageFetchState: '', error: 'HTTP 500' },
    ];
    expect(summarizeIndexing(pages)).toEqual({
      pass: 2,
      neutral: 1,
      fail: 0,
      unknown: 1,
      byCoverageState: [
        { key: 'Excluded by noindex', count: 1 },
        { key: 'Not reported', count: 1 },
        { key: 'Submitted and indexed', count: 1 },
      ],
      byPageFetchState: [{ key: 'SUCCESSFUL', count: 3 }],
    });
  });

  it('keeps an earlier answer as stale, but not an earlier failure', () => {
    const answer = { url: A, verdict: 'PASS', error: null, stale: false, inspectedAt: 'then' };
    expect(keptInspection(answer, A, 'why')).toEqual({ ...answer, stale: true, error: 'why' });
    const staleAgain = keptInspection({ ...answer, stale: true, error: 'older why' }, A, 'why');
    expect(staleAgain).toMatchObject({ verdict: 'PASS', stale: true, error: 'why', inspectedAt: 'then' });
    const failedBefore = { url: A, verdict: 'VERDICT_UNSPECIFIED', error: 'HTTP 500', stale: false };
    expect(keptInspection(failedBefore, A, 'why')).toMatchObject({ verdict: 'VERDICT_UNSPECIFIED', stale: false, error: 'why' });
    expect(keptInspection(undefined, A, 'why')).toMatchObject({ url: A, stale: false, error: 'why', inspectedAt: null });
  });

  it('sorts problems first and treats an unexpected stored verdict as unknown', () => {
    const pages = [
      { url: 'c', verdict: 'PASS' },
      { url: 'b', verdict: 'ODD' },
      { url: 'a', verdict: 'FAIL' },
      { url: 'd', verdict: 'VERDICT_UNSPECIFIED' },
    ];
    expect(sortPages(pages).map((p) => p.url)).toEqual(['a', 'b', 'd', 'c']);
  });

  it('turns Google\'s string counts into numbers and drops the deprecated indexed count', () => {
    expect(presentSitemaps([{ path: 'p', warnings: '2', errors: '0', contents: [{ type: 'web', submitted: '5', indexed: '1' }] }])).toEqual([
      { path: 'p', lastSubmitted: null, lastDownloaded: null, isPending: false, warnings: 2, errors: 0, contents: [{ type: 'web', submitted: 5 }] },
    ]);
    expect(presentSitemaps(null)).toEqual([]);
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
    const { sync, store, client, fetchImpl } = setup({ google: googleStub({ pageRows: STRAY_PAGE_ROWS }) });
    const result = await sync.run();
    // Two sitemap pages and the two strays, one of them on a subdomain.
    expect(result).toMatchObject({ status: 'ok', pages: 4, inspected: 4, failed: 0, stale: 0, strays: 2 });
    expect(fetchImpl).toHaveBeenCalledWith('https://hybridcloudworks.com/sitemap.xml', expect.objectContaining({ signal: expect.any(AbortSignal) }));

    const doc = store.doc;
    expect(doc).toMatchObject({ id: SNAPSHOT_DOC_ID, configScope: 'admin_config', status: 'ok', siteUrl: 'sc-domain:hybridcloudworks.com' });
    expect(doc.generatedAt).toBe(NOW.toISOString());
    expect(doc.run).toEqual({ startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), inspected: 4, failed: 0, stale: 0, message: null });
    // Problems first, then by address; each says where it came from and its host.
    expect(doc.indexing.pages.map((p) => [p.url, p.verdict, p.source, p.host])).toEqual([
      [BAD, 'FAIL', 'sitemap', 'hybridcloudworks.com'],
      [API_PAGE, 'PASS', 'search', 'api-azure.hybridcloudworks.com'],
      [A, 'PASS', 'sitemap', 'hybridcloudworks.com'],
      [OLD_PAGE, 'PASS', 'search', 'hybridcloudworks.com'],
    ]);
    expect(Object.keys(doc.indexing.pages[0]).sort()).toEqual(
      [
        'coverageState',
        'error',
        'googleCanonical',
        'host',
        'indexingState',
        'inspectedAt',
        'inspectionResultLink',
        'lastCrawlTime',
        'pageFetchState',
        'robotsTxtState',
        'source',
        'stale',
        'url',
        'userCanonical',
        'verdict',
      ].sort()
    );
    expect(doc.indexing.pages[0]).toMatchObject({ stale: false, inspectedAt: NOW.toISOString(), error: null });
    expect(doc.indexing.summary).toMatchObject({ pass: 3, neutral: 0, fail: 1, unknown: 0 });
    expect(doc.indexing.strays).toEqual([
      { url: OLD_PAGE, clicks: 1, impressions: 90 },
      { url: API_PAGE, clicks: 0, impressions: 80 },
    ]);
    expect(doc.indexing.history).toEqual([{ at: NOW.toISOString(), pass: 3, neutral: 0, fail: 1, inspected: 4, failed: 0 }]);
    // Sitemap pages are inspected first, then the strays, most impressions first.
    expect(client.inspect.mock.calls.map(([url]) => url)).toEqual([A, BAD, OLD_PAGE, API_PAGE]);

    expect(doc.performance.range).toEqual({ startDate: '2026-08-10', endDate: '2026-11-07' });
    expect(doc.performance.totals).toEqual({ clicks: 10, impressions: 200, ctr: 0.05, position: 7.5 });
    expect(doc.performance.totals28d).toEqual({ clicks: 10, impressions: 200, ctr: 0.05, position: 7.5 });
    expect(doc.performance.daily.map((d) => d.date)).toEqual(['2026-11-01', '2026-11-02']);
    expect(doc.performance.queries).toEqual([{ key: 'query-1', clicks: 3, impressions: 30, ctr: 0.1, position: 5 }]);
    // Full addresses, the subdomain's included.
    expect(doc.performance.pages.map((row) => row.key)).toEqual(STRAY_PAGE_ROWS.map((row) => row.keys[0]));
    for (const key of ['countries', 'devices', 'searchAppearance']) expect(doc.performance[key]).toHaveLength(1);
    expect(doc.sitemaps[0]).toMatchObject({ errors: 1, contents: [{ type: 'web', submitted: 203 }] });

    // searchAppearance asked on its own, never with another dimension.
    const dims = client.searchAnalytics.mock.calls.map(([body]) => body.dimensions ?? []);
    expect(dims).toContainEqual(['searchAppearance']);
    expect(dims.every((d) => d.length <= 1)).toBe(true);
    const pageQuery = client.searchAnalytics.mock.calls.find(([body]) => body.dimensions?.[0] === 'page')[0];
    expect(pageQuery.rowLimit).toBe(1000);
    // The page query comes first (it finds the strays to inspect). No query
    // carries a filter: the figures cover the whole property, the domain and
    // every subdomain (owner decision of 2026-11-09 on #1612).
    expect(askedFor(client)).toEqual(['page', 'totals', 'totals', 'date', 'query', 'country', 'device', 'searchAppearance']);
    for (const [body] of client.searchAnalytics.mock.calls) expect(body).not.toHaveProperty('dimensionFilterGroups');

    // The lease is given back, with the four inspections counted for the Pacific day.
    expect(store.lease).toMatchObject({ holder: null, expiresAt: null, by: null, budget: { day: PACIFIC_DAY, used: 4 } });
  });

  it('reads the real clock by default', async () => {
    const store = memoryStore();
    const sync = createSearchConsoleSync({
      store,
      env: ENV,
      fetchImpl: vi.fn(async () => textResponse(200, sitemapXml([A]))),
      client: googleStub(),
      sleep: async () => {},
      spacingMs: 0,
    });
    await expect(sync.run()).resolves.toMatchObject({ status: 'ok', inspected: 1 });
    expect(Date.parse(store.doc.generatedAt)).toBeGreaterThan(NOW.getTime());
  });

  it('signs in and calls Google through the real client when none is given', async () => {
    const json = (body) => ({ ok: true, status: 200, json: async () => body, headers: { get: () => null } });
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/sitemap.xml')) return textResponse(200, sitemapXml([A]));
      if (url.startsWith('https://sts.googleapis.com/')) return json({ access_token: 'federated' });
      if (url.startsWith('https://iamcredentials.googleapis.com/')) return json({ accessToken: 'sa-token', expireTime: '2026-11-09T01:10:00Z' });
      if (url.includes('urlInspection')) return json({ inspectionResult: passResult(A) });
      if (url.endsWith('/searchAnalytics/query')) return json({ rows: [] });
      return json({ sitemap: [] });
    });
    const store = memoryStore();
    const credential = { getToken: vi.fn(async () => ({ token: 'entra' })) };
    const sync = createSearchConsoleSync({ store, env: ENV, fetchImpl, credential, now: () => NOW, sleep: async () => {}, spacingMs: 0 });
    await expect(sync.run()).resolves.toMatchObject({ status: 'ok', inspected: 1, failed: 0 });
    // The run's cancel switch reaches hop 1 too.
    expect(credential.getToken).toHaveBeenCalledWith('api://00000000-0000-0000-0000-000000000001/.default', {
      abortSignal: expect.any(AbortSignal),
    });
    expect(store.doc.indexing.pages[0]).toMatchObject({ url: A, verdict: 'PASS' });
  });

  it('records the job\'s id on the lease while a job runs it', async () => {
    let seen = null;
    const google = googleStub({
      inspect: async (url) => {
        seen ??= structuredClone(store.lease);
        return passResult(url);
      },
    });
    const { sync, store } = setup({ google, jobId: 'job-7' });
    await sync.run();
    expect(seen).toMatchObject({ by: 'job', jobId: 'job-7' });
    expect(Date.parse(seen.expiresAt)).toBeGreaterThan(NOW.getTime());
  });

  it('does nothing, calls nothing and keeps the lease while another run holds it', async () => {
    const lease = { holder: 'other-run', by: 'timer', expiresAt: '2026-11-09T00:30:00Z', budget: { day: PACIFIC_DAY, used: 2 } };
    const { sync, store, client, fetchImpl, log } = setup({ lease });
    await expect(sync.run()).resolves.toEqual({ skipped: 'already_running' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(client.inspect).not.toHaveBeenCalled();
    expect(store.createDoc).not.toHaveBeenCalled();
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
    expect(store.lease.holder).toBe('other-run');
    expect(log.log.mock.calls.flat().join('\n')).toContain('skipped: another run is in progress');
  });

  it('takes over a lease that lapsed, for example after a run died', async () => {
    const lease = { holder: 'dead-run', expiresAt: '2026-11-08T23:00:00Z', budget: { day: PACIFIC_DAY, used: 10 } };
    const { sync, store } = setup({ lease });
    await expect(sync.run()).resolves.toMatchObject({ status: 'ok', inspected: 2 });
    expect(store.lease).toMatchObject({ holder: null, budget: { day: PACIFIC_DAY, used: 12 } });
  });

  it('records one URL\'s failure on that page, keeps its last answer as stale, and carries on', async () => {
    const google = googleStub({
      inspect: async (url) => {
        if (url.endsWith('/bad')) throw new SearchConsoleError('inspect', 500);
        return { indexStatusResult: { verdict: 'PASS' } };
      },
    });
    const { sync, store } = setup({ google, stored: previousRun() });
    const result = await sync.run();
    expect(result).toMatchObject({ status: 'ok', inspected: 2, failed: 1, stale: 1 });
    const bad = store.doc.indexing.pages.find((p) => p.url === BAD);
    expect(bad).toMatchObject({ verdict: 'PASS', stale: true, error: 'Search Console inspect failed with HTTP 500.', inspectedAt: '2026-11-08T12:10:00.000Z' });
    expect(store.doc.indexing.summary).toMatchObject({ pass: 2, unknown: 0 });
    // History counts only the fresh answer.
    expect(store.doc.indexing.history.at(-1)).toEqual({ at: NOW.toISOString(), pass: 1, neutral: 0, fail: 0, inspected: 1, failed: 1 });
    expect(store.doc.run.stale).toBe(1);
  });

  it('marks a page that has never had an answer as unknown, not stale', async () => {
    const google = googleStub({
      inspect: async () => {
        throw new SearchConsoleError('inspect');
      },
    });
    const { sync, store } = setup({ google, urls: [A] });
    await sync.run();
    expect(store.doc.indexing.pages).toEqual([expect.objectContaining({ url: A, verdict: 'VERDICT_UNSPECIFIED', stale: false, error: 'Search Console inspect could not be reached.' })]);
    expect(store.doc.indexing.summary.unknown).toBe(1);
    // No fresh answer: no history point.
    expect(store.doc.indexing.history).toEqual([]);
  });

  it('turns any other thrown failure into a fixed sentence', async () => {
    const google = googleStub({
      inspect: async () => {
        throw new Error('raw text that must not be stored');
      },
    });
    const { sync, store } = setup({ google, urls: [A] });
    await sync.run();
    expect(store.doc.indexing.pages[0].error).toBe('The inspection failed.');
  });

  it('stops inspecting when Google still answers 429, keeps the rest as stale and hands back the unused budget', async () => {
    const urls = Array.from({ length: 20 }, (_, i) => `https://hybridcloudworks.com/p${i}`);
    const google = googleStub({
      inspect: async (url) => {
        if (url.endsWith('/p1')) throw new SearchConsoleError('inspect', 429);
        return passResult(url);
      },
    });
    const { sync, store, client } = setup({ google, urls, stored: previousRun(urls) });
    const result = await sync.run();
    expect(result.status).toBe('ok');
    // Four lanes may already be in flight; no more start once one has hit the quota.
    const sent = client.inspect.mock.calls.length;
    expect(sent).toBeLessThanOrEqual(5);
    expect(result.inspected).toBe(sent);
    expect(store.doc.run.message).toContain('Google still answered 429');
    const notTried = store.doc.indexing.pages.find((p) => p.url.endsWith('/p19'));
    expect(notTried).toMatchObject({ verdict: 'PASS', stale: true, error: 'Not inspected in the last run: Google answered that its quota was used up.' });
    expect(store.doc.indexing.pages.find((p) => p.url.endsWith('/p1'))).toMatchObject({ stale: true, error: "Search Console inspect hit Google's quota (HTTP 429)." });
    // Performance still read: a different quota.
    expect(client.searchAnalytics).toHaveBeenCalled();
    // Only what was sent stays counted for the day.
    expect(store.lease.budget).toEqual({ day: PACIFIC_DAY, used: sent });
  });

  it('inspects only what is left of the daily budget; the rest keep their last answer', async () => {
    const urls = Array.from({ length: 10 }, (_, i) => `https://hybridcloudworks.com/p${i}`);
    const lease = { holder: null, budget: { day: PACIFIC_DAY, used: 1796 } };
    const { sync, store, client } = setup({ urls, lease, stored: previousRun(urls) });
    const result = await sync.run();
    expect(client.inspect).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({ status: 'ok', inspected: 4, stale: 6 });
    expect(store.doc.run.message).toContain('Only 4 of 10 pages fit in what is left of today\'s allowance of 1,800');
    expect(store.doc.run.message).toContain('(2026-11-09 08:00 UTC)');
    expect(store.doc.indexing.pages.filter((p) => p.stale)).toHaveLength(6);
    expect(store.doc.indexing.pages.find((p) => p.stale).error).toBe(
      'Not inspected in the last run: the daily allowance of Google page inspections was used up.'
    );
    expect(store.doc.indexing.history.at(-1)).toMatchObject({ inspected: 4 });
    expect(store.lease.budget).toEqual({ day: PACIFIC_DAY, used: 1800 });
  });

  it('with the budget spent, inspects nothing, keeps every page, adds no history point and still reads performance', async () => {
    const lease = { holder: null, budget: { day: PACIFIC_DAY, used: 1800 } };
    const { sync, store, client } = setup({ lease, stored: previousRun() });
    const result = await sync.run();
    expect(client.inspect).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'ok', inspected: 0, stale: 2 });
    expect(store.doc.status).toBe('ok');
    expect(store.doc.run.message).toContain("Today's allowance of 1,800 Google page inspections is used up.");
    expect(store.doc.run.message).toContain('No page was inspected; each keeps its last result.');
    expect(store.doc.indexing.pages.every((p) => p.stale && p.verdict === 'PASS')).toBe(true);
    expect(store.doc.indexing.history).toEqual([{ at: 'x' }]);
    expect(store.doc.performance.totals.clicks).toBe(10);
  });

  it('keeps to a lower budget set in the app setting', async () => {
    const { sync, client } = setup({ env: { ...ENV, GSC_DAILY_INSPECTION_BUDGET: '1' } });
    await sync.run();
    expect(client.inspect).toHaveBeenCalledTimes(1);
  });

  it('stops on a 403, keeps the last good figures and records the error', async () => {
    const google = googleStub({
      inspect: async () => {
        throw new SearchConsoleError('inspect', 403);
      },
    });
    const { sync, store, client } = setup({ stored: previousRun(), google, urls: Array.from({ length: 20 }, (_, i) => `https://hybridcloudworks.com/p${i}`) });
    const result = await sync.run();
    expect(result.status).toBe('error');
    // Four lanes may already be in flight; no more start once one has failed.
    expect(client.inspect.mock.calls.length).toBeLessThanOrEqual(4);
    // Only the page query, which finds the strays before the inspections.
    expect(askedFor(client)).toEqual(['page']);
    expect(store.doc.status).toBe('error');
    expect(store.doc.run.message).toContain('not a Full user');
    expect(store.doc.generatedAt).toBe('2026-11-08T12:10:00.000Z');
    expect(store.doc.indexing.pages.map((p) => p.url)).toEqual([A, BAD]);
    expect(store.doc.indexing.history).toEqual([{ at: 'x' }]);
    expect(store.doc.performance.totals.clicks).toBe(99);
    expect(store.snapshotWrites()).toBe(1);
    expect(store.lease.holder).toBeNull();
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

  it('names an unknown hop and a hop with no status in plain words', async () => {
    const unknown = Object.assign(new GoogleAuthError('entra'), { kind: 'other' });
    const google = googleStub({
      inspect: async () => {
        throw unknown;
      },
    });
    const { sync, store } = setup({ google });
    await sync.run();
    expect(store.doc.run.message).toBe('Google sign-in failed at an unknown hop. The runbook\'s setup steps say what each hop needs.');
  });

  it('stops when a performance query is refused (401), keeping the last figures', async () => {
    const google = googleStub({
      searchAnalytics: async () => {
        throw new SearchConsoleError('searchAnalytics', 401);
      },
    });
    const { sync, store, client } = setup({ google, stored: previousRun() });
    await expect(sync.run()).resolves.toMatchObject({ status: 'error' });
    // No more queries once the run cannot go on, and no sitemaps list.
    expect(client.searchAnalytics).toHaveBeenCalledTimes(1);
    expect(client.listSitemaps).not.toHaveBeenCalled();
    expect(store.doc).toMatchObject({ status: 'error', generatedAt: '2026-11-08T12:10:00.000Z' });
    expect(store.doc.run.message).toBe('Search Console searchAnalytics failed with HTTP 401.');
  });

  it('keeps the last figures for a performance query that failed, and says so', async () => {
    const base = googleStub().searchAnalytics.getMockImplementation();
    const google = googleStub({
      searchAnalytics: async (body) => {
        if (body.dimensions?.[0] === 'query') throw new SearchConsoleError('searchAnalytics', 500);
        if (body.dimensions?.[0] === 'page') throw new Error('raw');
        return base(body);
      },
    });
    const { sync, store } = setup({ google, stored: previousRun() });
    await expect(sync.run()).resolves.toMatchObject({ status: 'ok' });
    expect(store.doc.performance.queries).toEqual([{ key: 'kept' }]);
    expect(store.doc.performance.totals.clicks).toBe(10);
    // The page rows failed, so the strays are the last run's.
    expect(store.doc.indexing.strays).toEqual([{ url: 'https://hybridcloudworks.com/kept-stray', clicks: 1, impressions: 2 }]);
    expect(store.doc.run.message).toContain('Performance query: Search Console searchAnalytics failed with HTTP 500. The last figures were kept.');
    expect(store.doc.run.message).toContain('Performance page: the query failed. The last figures were kept.');
  });

  it('keeps the last sitemaps list when it cannot be read, and fills an empty one first time', async () => {
    const google = googleStub({
      listSitemaps: async () => {
        throw new SearchConsoleError('sitemaps', 503);
      },
    });
    const { sync, store } = setup({ google, stored: previousRun() });
    await expect(sync.run()).resolves.toMatchObject({ status: 'ok' });
    expect(store.doc.sitemaps).toEqual([{ path: 'kept' }]);
    expect(store.doc.run.message).toContain('Sitemaps: Search Console sitemaps failed with HTTP 503. The last list was kept.');

    const first = setup({
      google: googleStub({
        listSitemaps: async () => {
          throw new Error('raw');
        },
      }),
    });
    await first.sync.run();
    expect(first.store.doc.sitemaps).toEqual([]);
    expect(first.store.doc.run.message).toContain('Sitemaps: the list could not be read.');
  });

  it('stops when the sitemaps list is refused (403)', async () => {
    const google = googleStub({
      listSitemaps: async () => {
        throw new SearchConsoleError('sitemaps', 403);
      },
    });
    const { sync, store } = setup({ google, stored: previousRun() });
    await expect(sync.run()).resolves.toMatchObject({ status: 'error' });
    expect(store.doc.sitemaps).toEqual([{ path: 'kept' }]);
  });

  it('keeps the last 120 history entries', async () => {
    const history = Array.from({ length: HISTORY_MAX }, (_, i) => ({ at: `h${i}`, pass: 0, neutral: 0, fail: 0, inspected: 0, failed: 0 }));
    const { sync, store } = setup({ stored: { indexing: { history } } });
    await sync.run();
    expect(store.doc.indexing.history).toHaveLength(HISTORY_MAX);
    expect(store.doc.indexing.history[0].at).toBe('h1');
    expect(store.doc.indexing.history.at(-1).at).toBe(NOW.toISOString());
  });

  it('re-reads and writes again when it loses a race (412), and gives up after three', async () => {
    const { sync, store } = setup({ stored: { indexing: { history: [] } } });
    const real = store.replaceDocIfMatch.getMockImplementation();
    let lost = 0;
    store.replaceDocIfMatch.mockImplementation(async (container, doc, options) => {
      if (doc.id === SNAPSHOT_DOC_ID && lost === 0) {
        lost += 1;
        throw Object.assign(new Error('precondition'), { code: 412 });
      }
      return real(container, doc, options);
    });
    await expect(sync.run()).resolves.toMatchObject({ status: 'ok' });
    expect(store.snapshotWrites()).toBe(2);

    const again = setup({ stored: { indexing: { history: [] } } });
    const realAgain = again.store.replaceDocIfMatch.getMockImplementation();
    again.store.replaceDocIfMatch.mockImplementation(async (container, doc, options) => {
      if (doc.id === SNAPSHOT_DOC_ID) throw Object.assign(new Error('precondition'), { code: 412 });
      return realAgain(container, doc, options);
    });
    await expect(again.sync.run()).rejects.toThrow('precondition');
    expect(again.store.snapshotWrites()).toBe(3);
    // The lease is given back even though the run failed.
    expect(again.store.lease.holder).toBeNull();
  });

  it('treats an unreadable sitemap as an error that changes nothing but the message', async () => {
    const { sync, store, client } = setup({ sitemap: textResponse(503, ''), stored: previousRun() });
    const result = await sync.run();
    expect(result).toMatchObject({ status: 'error', pages: 0, inspected: 0 });
    expect(client.inspect).not.toHaveBeenCalled();
    expect(client.searchAnalytics).not.toHaveBeenCalled();
    expect(store.doc.status).toBe('error');
    expect(store.doc.run.message).toBe('The sitemap could not be read (HTTP 503), so nothing was asked of Google.');
    expect(store.doc.indexing.pages.every((p) => !p.stale)).toBe(true);
    expect(store.doc.indexing.strays).toEqual(previousRun().indexing.strays);
    expect(store.doc.indexing.history).toEqual([{ at: 'x' }]);
    expect(store.doc.performance.totals.clicks).toBe(99);
    expect(store.doc.sitemaps).toEqual([{ path: 'kept' }]);
    expect(store.doc.generatedAt).toBe('2026-11-08T12:10:00.000Z');
    expect(store.lease).toMatchObject({ holder: null, budget: { day: PACIFIC_DAY, used: 0 } });
  });

  it('treats an unreachable sitemap, and one whose body fails to arrive, as unreadable', async () => {
    const unreachable = setup({ fetchImpl: vi.fn(async () => Promise.reject(new Error('socket'))) });
    await expect(unreachable.sync.run()).resolves.toMatchObject({ status: 'error' });
    expect(unreachable.store.doc.run.message).toBe('The sitemap could not be read (unreachable), so nothing was asked of Google.');

    const brokenBody = setup({
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => {
          throw new Error('body cut off');
        },
      })),
    });
    await expect(brokenBody.sync.run()).resolves.toMatchObject({ status: 'error' });
    expect(brokenBody.store.doc.run.message).toContain('(unreachable)');
  });

  it('treats a sitemap with no page on the domain or a subdomain as an error', async () => {
    const { sync, store, client } = setup({ urls: ['https://example.com/x', 'http://hybridcloudworks.com/y', 'https://hybridcloudworks.com.example.net/z'] });
    await expect(sync.run()).resolves.toMatchObject({ status: 'error' });
    expect(client.inspect).not.toHaveBeenCalled();
    expect(store.doc.run.message).toBe('The sitemap lists no page on hybridcloudworks.com or its subdomains, so nothing was asked of Google.');
  });

  it('inspects a subdomain page the sitemap lists', async () => {
    const { sync, store } = setup({ urls: [API_PAGE] });
    await expect(sync.run()).resolves.toMatchObject({ status: 'ok', pages: 1, inspected: 1 });
    expect(store.doc.indexing.pages[0]).toMatchObject({ url: API_PAGE, source: 'sitemap', host: 'api-azure.hybridcloudworks.com' });
  });

  it('reads the sitemap from GSC_SITEMAP_URL when it is set', async () => {
    const { sync, fetchImpl } = setup({ env: { ...ENV, GSC_SITEMAP_URL: ' https://hybridcloudworks.com/other.xml ' } });
    await sync.run();
    expect(fetchImpl.mock.calls[0][0]).toBe('https://hybridcloudworks.com/other.xml');
  });

  it('notes when the sitemap lists more pages than one run inspects', async () => {
    const urls = Array.from({ length: MAX_URLS + 1 }, (_, i) => `https://hybridcloudworks.com/p${i}`);
    const { sync, store, client } = setup({ urls });
    await sync.run();
    expect(client.inspect).toHaveBeenCalledTimes(MAX_URLS);
    expect(store.doc.run.message).toContain(`The sitemap lists ${MAX_URLS + 1} pages; only the first ${MAX_URLS} are inspected.`);
  });

  it('reads a sitemap index one level down, on the main site\'s own host only, and counts the others as not read', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/sitemap.xml'))
        return textResponse(
          200,
          '<sitemapindex><sitemap><loc>https://hybridcloudworks.com/s1.xml</loc></sitemap><sitemap><loc>https://evil.example/s.xml</loc></sitemap><sitemap><loc>https://docs.hybridcloudworks.com/s.xml</loc></sitemap></sitemapindex>'
        );
      return textResponse(200, sitemapXml(['https://hybridcloudworks.com/from-child']));
    });
    const { sync, store } = setup({ fetchImpl, google: googleStub({ pageRows: STRAY_PAGE_ROWS }) });
    await sync.run();
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(['https://hybridcloudworks.com/sitemap.xml', 'https://hybridcloudworks.com/s1.xml']);
    expect(store.doc.indexing.pages.find((p) => p.source === 'sitemap').url).toBe('https://hybridcloudworks.com/from-child');
    // Two children are on other hosts and were not read, so the list is not
    // whole: the strays are not worked out from it, and the note says why.
    expect(store.doc.indexing.strays).toEqual([]);
    expect(store.doc.run.message).toContain('2 child sitemaps are not on hybridcloudworks.com and were not read');
  });

  it('works out the strays from an index whose children are all on the main site', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/sitemap.xml'))
        return textResponse(200, '<sitemapindex><sitemap><loc>https://hybridcloudworks.com/s1.xml</loc></sitemap></sitemapindex>');
      return textResponse(200, sitemapXml(['https://hybridcloudworks.com/from-child']));
    });
    const { sync, store } = setup({ fetchImpl, google: googleStub({ pageRows: STRAY_PAGE_ROWS }) });
    await sync.run();
    expect(store.doc.indexing.strays.length).toBeGreaterThan(0);
  });

  it('with a child sitemap unread, inspects the rest but keeps the last strays', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/sitemap.xml'))
        return textResponse(200, '<sitemapindex><sitemap><loc>https://hybridcloudworks.com/s1.xml</loc></sitemap><sitemap><loc>https://hybridcloudworks.com/s2.xml</loc></sitemap></sitemapindex>');
      if (url.endsWith('/s2.xml')) return textResponse(500, '');
      return textResponse(200, sitemapXml([A]));
    });
    const { sync, store } = setup({ fetchImpl, stored: previousRun() });
    await expect(sync.run()).resolves.toMatchObject({ status: 'ok', pages: 1 });
    expect(store.doc.indexing.strays).toEqual([{ url: 'https://hybridcloudworks.com/kept-stray', clicks: 1, impressions: 2 }]);
    expect(store.doc.run.message).toContain(
      '1 of 2 child sitemaps could not be read, so the strays were not worked out this run, and pages the part read does not list keep their last result.'
    );
  });

  it('treats a sitemap index whose children all fail as unreadable', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/sitemap.xml')) return textResponse(200, '<sitemapindex><sitemap><loc>https://hybridcloudworks.com/s1.xml</loc></sitemap></sitemapindex>');
      return textResponse(404, '');
    });
    const { sync, store } = setup({ fetchImpl });
    await expect(sync.run()).resolves.toMatchObject({ status: 'error' });
    expect(store.doc.run.message).toBe('The sitemap could not be read (none of its 1 child sitemaps could be read), so nothing was asked of Google.');
  });

  it('logs counts and durations only: no address, no token', async () => {
    const { sync, log } = setup({ google: googleStub({ pageRows: STRAY_PAGE_ROWS }) });
    await sync.run();
    const lines = log.log.mock.calls.flat().join('\n');
    expect(lines).not.toContain('hybridcloudworks.com');
    expect(lines).toMatch(/4 pages \(2 from search\), 4 inspected, 0 failed, 0 stale, 2 strays, \d+s/);
  });

  it('logs, and still answers, when the lease cannot be given back', async () => {
    const { sync, store, log } = setup();
    const real = store.replaceDocIfMatch.getMockImplementation();
    store.replaceDocIfMatch.mockImplementation(async (container, doc, options) => {
      if (doc.id === LEASE_DOC_ID && doc.holder === null) throw new Error('write refused');
      return real(container, doc, options);
    });
    await expect(sync.run()).resolves.toMatchObject({ status: 'ok' });
    expect(log.log.mock.calls.flat().join('\n')).toContain('lease not given back; it lapses within 35 minutes');
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
    expect(askedFor(client)).toEqual(['page']);
    // Half a run is not written over the last whole one.
    expect(store.snapshotWrites()).toBe(0);
  });
});

describe('createSearchConsoleSync, Copilot review round 1 (#1614)', () => {
  const pagesNamed = (count) => Array.from({ length: count }, (_, i) => `https://hybridcloudworks.com/p${i}`);
  const indexOf = (children) =>
    `<sitemapindex>${children.map((c) => `<sitemap><loc>${c}</loc></sitemap>`).join('')}</sitemapindex>`;

  it('treats a sitemap index with more children than it reads as not read in full', async () => {
    const children = Array.from({ length: 21 }, (_, i) => `https://hybridcloudworks.com/s${i}.xml`);
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/sitemap.xml')) return textResponse(200, indexOf(children));
      return textResponse(200, sitemapXml([A]));
    });
    const { sync, store } = setup({ fetchImpl, stored: previousRun([A, BAD]) });
    await expect(sync.run()).resolves.toMatchObject({ status: 'ok' });
    // The root and the first 20 children; the 21st is not read.
    expect(fetchImpl).toHaveBeenCalledTimes(21);
    expect(fetchImpl.mock.calls.map(([url]) => url)).not.toContain('https://hybridcloudworks.com/s20.xml');
    // Not read in full: the last strays are kept, not worked out again.
    expect(store.doc.indexing.strays).toEqual([{ url: 'https://hybridcloudworks.com/kept-stray', clicks: 1, impressions: 2 }]);
    expect(store.doc.run.message).toContain(
      'The sitemap index lists 21 child sitemaps and only the first 20 were read, so the strays were not worked out this run'
    );
    // BAD may be in the child that was not read, so it keeps its last answer.
    expect(store.doc.indexing.pages.find((p) => p.url === BAD)).toMatchObject({ stale: true, verdict: 'PASS' });
  });

  it('names both gaps when children fail and some are not read', async () => {
    const children = Array.from({ length: 22 }, (_, i) => `https://hybridcloudworks.com/s${i}.xml`);
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/sitemap.xml')) return textResponse(200, indexOf(children));
      if (url.endsWith('/s0.xml')) return textResponse(500, '');
      return textResponse(200, sitemapXml([A]));
    });
    const { sync, store } = setup({ fetchImpl });
    await sync.run();
    expect(store.doc.run.message).toContain(
      '1 of 20 child sitemaps could not be read; the sitemap index lists 22 child sitemaps and only the first 20 were read, so the strays'
    );
  });

  it('keeps pages from the last run that a sitemap read only in part leaves out, stale, with the reason', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/sitemap.xml'))
        return textResponse(200, indexOf(['https://hybridcloudworks.com/s1.xml', 'https://hybridcloudworks.com/s2.xml']));
      if (url.endsWith('/s2.xml')) return textResponse(503, '');
      return textResponse(200, sitemapXml([A]));
    });
    const stored = previousRun([A, BAD]);
    // A page the last run had no answer for is kept too, still without one.
    const never = 'https://hybridcloudworks.com/never';
    stored.indexing.pages.push({ url: never, verdict: 'VERDICT_UNSPECIFIED', error: 'The inspection failed.', stale: false });
    const { sync, store, client } = setup({ fetchImpl, stored });
    const result = await sync.run();
    expect(client.inspect.mock.calls.map(([url]) => url)).toEqual([A]);
    expect(result).toMatchObject({ status: 'ok', pages: 1, inspected: 1, stale: 1 });
    expect(store.doc.indexing.pages.find((p) => p.url === BAD)).toMatchObject({
      verdict: 'PASS',
      stale: true,
      error: 'Not inspected in the last run: the sitemap could not be read in full, and the part that was read does not list this page.',
    });
    expect(store.doc.indexing.pages.find((p) => p.url === never)).toMatchObject({ verdict: 'VERDICT_UNSPECIFIED', stale: false });
    expect(store.doc.indexing.pages.find((p) => p.url === A)).toMatchObject({ stale: false, error: null });
    expect(store.doc.indexing.summary).toMatchObject({ pass: 2, unknown: 1 });
  });

  it('drops pages the sitemap no longer lists when it was read in full', async () => {
    const { sync, store } = setup({ urls: [A], stored: previousRun([A, BAD]) });
    await sync.run();
    expect(store.doc.indexing.pages.map((p) => p.url)).toEqual([A]);
  });

  it('keeps no more than MAX_URLS pages in all when it keeps pages a partial sitemap left out', async () => {
    const urls = pagesNamed(MAX_URLS);
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/sitemap.xml'))
        return textResponse(200, indexOf(['https://hybridcloudworks.com/s1.xml', 'https://hybridcloudworks.com/s2.xml']));
      if (url.endsWith('/s2.xml')) return textResponse(500, '');
      return textResponse(200, sitemapXml(urls));
    });
    const { sync, store } = setup({ fetchImpl, stored: previousRun([BAD]) });
    await sync.run();
    expect(store.doc.indexing.pages).toHaveLength(MAX_URLS);
    expect(store.doc.indexing.pages.map((p) => p.url)).not.toContain(BAD);
  });

  it('counts every request sent, retries included, and sends no retry the budget has no room for', async () => {
    // Three left today; A needs three requests (two retries), BAD one.
    const lease = { holder: null, budget: { day: PACIFIC_DAY, used: 1797 } };
    let allowedRequests = 0;
    const google = googleStub();
    google.inspect.mockImplementation(async (url, options) => {
      const counting = async () => {
        const ok = await options.beforeSend();
        if (ok) allowedRequests += 1;
        return ok;
      };
      await sendAsClientDoes({ beforeSend: counting }, url === A ? 3 : 1);
      return passResult(url);
    });
    const { sync, store } = setup({ google, lease, stored: previousRun() });
    const result = await sync.run();
    // A's first request and BAD's used the two reserved; A's first retry got
    // the last one left today; its second retry was not sent.
    expect(allowedRequests).toBe(3);
    expect(store.lease.budget).toEqual({ day: PACIFIC_DAY, used: 1800 });
    expect(result).toMatchObject({ status: 'ok', inspected: 2, failed: 1 });
    expect(store.doc.indexing.pages.find((p) => p.url === A)).toMatchObject({ stale: true, error: 'Search Console inspect failed with HTTP 503.' });
    expect(store.doc.run.message).toContain(
      "Retries used up what was left of today's allowance of 1,800 Google page inspections, so the run stopped inspecting after 2 of 2 pages"
    );
  });

  it('does not send a page whose first request has no room left, and counts it as not inspected', async () => {
    const urls = pagesNamed(6);
    // Six left today, for six pages; p0 needs three requests.
    const lease = { holder: null, budget: { day: PACIFIC_DAY, used: 1794 } };
    const google = googleStub();
    google.inspect.mockImplementation(async (url, options) => {
      await sendAsClientDoes(options, url.endsWith('/p0') ? 3 : 1);
      return passResult(url);
    });
    const { sync, store } = setup({ google, urls, lease, stored: previousRun(urls) });
    const result = await sync.run();
    // Which request loses depends on how the four lanes interleave; what
    // holds either way is that six requests were sent, no more, and at least
    // one page was never sent, so it is not counted as inspected.
    expect(result.status).toBe('ok');
    expect(result.inspected).toBeLessThan(6);
    expect(store.lease.budget).toEqual({ day: PACIFIC_DAY, used: 1800 });
    const notSent = store.doc.indexing.pages.filter(
      (p) => p.stale && p.error === 'Not inspected in the last run: the daily allowance of Google page inspections was used up.'
    );
    expect(notSent).toHaveLength(6 - result.inspected);
    expect(store.doc.run.message).toContain(`so the run stopped inspecting after ${result.inspected} of 6 pages`);
  });

  it('does not ask the budget for more once the run has stopped', async () => {
    const lease = { holder: null, budget: { day: PACIFIC_DAY, used: 1798 } };
    const google = googleStub();
    let retryAllowed = null;
    google.inspect.mockImplementation(async (url, options) => {
      if (url === A) {
        await options.beforeSend();
        throw new SearchConsoleError('inspect', 403);
      }
      await options.beforeSend();
      // Let A's fatal answer land before this page's retry asks.
      await new Promise((resolve) => setTimeout(resolve, 5));
      retryAllowed = await options.beforeSend();
      throw new SearchConsoleError('inspect', 503);
    });
    const { sync, store } = setup({ google, lease, stored: previousRun() });
    await expect(sync.run()).resolves.toMatchObject({ status: 'error' });
    expect(retryAllowed).toBe(false);
    // Two reserved, two sent, nothing more asked of the budget.
    expect(store.lease.budget).toEqual({ day: PACIFIC_DAY, used: 1800 });
  });

  it('counts a request as not sent when the budget cannot be asked', async () => {
    const lease = { holder: null, budget: { day: PACIFIC_DAY, used: 1798 } };
    const google = googleStub();
    google.inspect.mockImplementation(async (url, options) => {
      await sendAsClientDoes(options, url === A ? 2 : 1);
      return passResult(url);
    });
    const { sync, store } = setup({ google, lease, stored: previousRun() });
    // The lease document cannot be read once inspecting starts.
    const real = store.readDoc.getMockImplementation();
    let reads = 0;
    store.readDoc.mockImplementation(async (container, id, pk) => {
      if (id === LEASE_DOC_ID) {
        reads += 1;
        if (reads === 3) throw new Error('read refused');
      }
      return real(container, id, pk);
    });
    await expect(sync.run()).resolves.toMatchObject({ status: 'ok', failed: 1 });
    expect(store.doc.indexing.pages.find((p) => p.url === A)).toMatchObject({ error: 'Search Console inspect failed with HTTP 503.' });
  });

  it('sends a retry through the real client only after the budget gives one more', async () => {
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body, headers: { get: () => null } });
    let inspections = 0;
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/sitemap.xml')) return textResponse(200, sitemapXml([A]));
      if (url.startsWith('https://sts.googleapis.com/')) return json(200, { access_token: 'federated' });
      if (url.startsWith('https://iamcredentials.googleapis.com/')) return json(200, { accessToken: 'sa-token', expireTime: '2026-11-09T01:10:00Z' });
      if (url.includes('urlInspection')) {
        inspections += 1;
        return json(503, {});
      }
      return json(200, {});
    });
    // One left today: the first request is sent, its retry is not.
    const store = memoryStore({ lease: { holder: null, budget: { day: PACIFIC_DAY, used: 1799 } } });
    const credential = { getToken: vi.fn(async () => ({ token: 'entra' })) };
    const sync = createSearchConsoleSync({ store, env: ENV, fetchImpl, credential, now: () => NOW, sleep: async () => {}, spacingMs: 0 });
    await expect(sync.run()).resolves.toMatchObject({ status: 'ok', inspected: 1, failed: 1 });
    expect(inspections).toBe(1);
    expect(store.lease.budget).toEqual({ day: PACIFIC_DAY, used: 1800 });
    // An empty Search Analytics answer ({}) is a good empty answer.
    expect(store.doc.performance.queries).toEqual([]);
  });

  it('keeps the last figures when Google answers a query with something it does not document', async () => {
    const google = googleStub({
      searchAnalytics: async (body) => {
        if (body.dimensions?.[0] === 'query') throw new SearchConsoleError('searchAnalytics', 200, { reason: 'unreadable' });
        return [];
      },
    });
    const { sync, store } = setup({ google, stored: previousRun() });
    await expect(sync.run()).resolves.toMatchObject({ status: 'ok' });
    expect(store.doc.performance.queries).toEqual([{ key: 'kept' }]);
    expect(store.doc.run.message).toContain(
      'Performance query: Search Console searchAnalytics sent an answer that is not what Google documents, so it was not used. The last figures were kept.'
    );
  });

  it("keeps a page's last answer when its inspection answer is not what Google documents", async () => {
    const google = googleStub({
      inspect: async () => {
        throw new SearchConsoleError('inspect', 200, { reason: 'unreadable' });
      },
    });
    const { sync, store } = setup({ google, urls: [A], stored: previousRun([A]) });
    await expect(sync.run()).resolves.toMatchObject({ status: 'ok', failed: 1 });
    expect(store.doc.indexing.pages[0]).toMatchObject({
      verdict: 'PASS',
      stale: true,
      error: 'Search Console inspect sent an answer that is not what Google documents, so it was not used.',
    });
  });

  it.each([
    ['an inspection', { inspect: async () => Promise.reject(new SearchConsoleError('inspect', 404)) }],
    ['a performance query', { searchAnalytics: async () => Promise.reject(new SearchConsoleError('searchAnalytics', 404)) }],
    ['the sitemaps list', { listSitemaps: async () => Promise.reject(new SearchConsoleError('sitemaps', 404)) }],
  ])('stops on a 404 to %s, keeps the last good figures and names GSC_SITE_URL', async (_label, overrides) => {
    const google = googleStub(overrides);
    const { sync, store } = setup({ google, stored: previousRun() });
    await expect(sync.run()).resolves.toMatchObject({ status: 'error' });
    expect(store.doc.status).toBe('error');
    expect(store.doc.run.message).toBe(
      "Google answered 404: it has no Search Console property at the address in the GSC_SITE_URL setting, or the service account cannot see it. Check the setting against the property's name in Search Console."
    );
    expect(store.doc.performance.totals.clicks).toBe(99);
    expect(store.doc.sitemaps).toEqual([{ path: 'kept' }]);
    expect(store.doc.generatedAt).toBe('2026-11-08T12:10:00.000Z');
  });
});

describe('createSearchConsoleSync, Copilot review round 2 (#1614)', () => {
  /** What the site sends, with HTTP 200, for any address it does not know (#1613). */
  const HTML_SHELL = '<!doctype html><html lang="en"><head><title>HCW</title></head><body><div id="root"></div></body></html>';
  const indexOf = (children) =>
    `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${children
      .map((c) => `<sitemap><loc>${c}</loc></sitemap>`)
      .join('')}</sitemapindex>`;
  const S1 = 'https://hybridcloudworks.com/s1.xml';
  const S2 = 'https://hybridcloudworks.com/s2.xml';
  const pagesNamed = (count) => Array.from({ length: count }, (_, i) => `https://hybridcloudworks.com/p${i}`);
  const DEADLINE_NOTE = 'Not inspected in the last run: the run reached its 25-minute time limit first.';

  /** A Google call that waits until the run's cancel switch fires, then fails the way client.js does. */
  const untilCancelled =
    (kind) =>
    (...args) => {
      const signal = args.map((arg) => arg?.signal).find(Boolean);
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new SearchConsoleError(kind)), { once: true });
      });
    };

  describe('a sitemap counts as read only when it really is one (finding A)', () => {
    it('names the first element, past a byte-order mark, the declaration, comments and a DOCTYPE', () => {
      expect(sitemapRoot(sitemapXml([A]))).toBe('urlset');
      expect(
        sitemapRoot(
          '﻿<?xml version="1.0"?>\n<!-- made by the build -->\n<!DOCTYPE urlset [<!ENTITY x "y">]>\n<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9"/>'
        )
      ).toBe('urlset');
      expect(sitemapRoot('<?xml version="1.0"?><?xml-stylesheet href="s.xsl"?><SitemapIndex>')).toBe('sitemapindex');
      expect(sitemapRoot(HTML_SHELL)).toBe('html');
      expect(sitemapRoot('<rss version="2.0"><channel/></rss>')).toBe('rss');
      expect(sitemapRoot('')).toBeNull();
      expect(sitemapRoot('not markup')).toBeNull();
      expect(sitemapRoot('<!-- never closed <urlset>')).toBeNull();
      expect(sitemapRoot(undefined)).toBeNull();
    });

    it('does not take a web page that merely contains <sitemapindex> for an index', () => {
      expect(parseSitemap('<html><body><code><sitemapindex ></code></body></html>').isIndex).toBe(false);
    });

    it('counts a child sitemap that answers 200 with the web page as unread, keeps its pages and the last strays', async () => {
      const fetchImpl = vi.fn(async (url) => {
        if (url.endsWith('/sitemap.xml')) return textResponse(200, indexOf([S1, S2]));
        if (url === S2) return textResponse(200, HTML_SHELL);
        return textResponse(200, sitemapXml([A]));
      });
      const { sync, store, client } = setup({ fetchImpl, stored: previousRun([A, BAD]) });
      await expect(sync.run()).resolves.toMatchObject({ status: 'ok', pages: 1, inspected: 1 });
      expect(client.inspect.mock.calls.map(([url]) => url)).toEqual([A]);
      expect(store.doc.run.message).toContain(
        '1 of 2 child sitemaps could not be read, so the strays were not worked out this run, and pages the part read does not list keep their last result.'
      );
      // BAD was listed only by the child that moved: it keeps its last answer, marked stale.
      expect(store.doc.indexing.pages.find((p) => p.url === BAD)).toMatchObject({
        verdict: 'PASS',
        stale: true,
        error: 'Not inspected in the last run: the sitemap could not be read in full, and the part that was read does not list this page.',
      });
      expect(store.doc.indexing.strays).toEqual(previousRun().indexing.strays);
    });

    it('does not follow an index inside an index, and does not inspect its addresses as pages', async () => {
      const fetchImpl = vi.fn(async (url) => {
        if (url.endsWith('/sitemap.xml')) return textResponse(200, indexOf([S1, S2]));
        if (url === S2) return textResponse(200, indexOf(['https://hybridcloudworks.com/s3.xml']));
        return textResponse(200, sitemapXml([A]));
      });
      const { sync, store, client } = setup({ fetchImpl, stored: previousRun([A]) });
      await expect(sync.run()).resolves.toMatchObject({ status: 'ok', pages: 1 });
      expect(client.inspect.mock.calls.map(([url]) => url)).toEqual([A]);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(store.doc.run.message).toContain('1 of 2 child sitemaps could not be read');
    });

    it.each([
      ['the web page', HTML_SHELL],
      ['an empty body', ''],
      ['another kind of XML', '<rss version="2.0"><channel/></rss>'],
    ])('treats a sitemap address that answers 200 with %s as unreadable, keeping the last good figures', async (_label, body) => {
      const { sync, store, client } = setup({ sitemap: textResponse(200, body), stored: previousRun() });
      await expect(sync.run()).resolves.toMatchObject({ status: 'error', pages: 0, inspected: 0 });
      expect(client.inspect).not.toHaveBeenCalled();
      expect(client.searchAnalytics).not.toHaveBeenCalled();
      expect(store.doc.status).toBe('error');
      expect(store.doc.run.message).toBe('The sitemap could not be read (the answer is not a sitemap), so nothing was asked of Google.');
      expect(store.doc.indexing.pages.every((p) => !p.stale)).toBe(true);
      expect(store.doc.indexing.strays).toEqual(previousRun().indexing.strays);
      expect(store.doc.performance.totals.clicks).toBe(99);
      expect(store.doc.generatedAt).toBe('2026-11-08T12:10:00.000Z');
    });
  });

  describe('a run is bounded in time and writes only while it holds the lease (finding B)', () => {
    /** Another run takes the lease, as it could once this run's lease had lapsed. */
    async function changeLease(store, fields = { holder: 'newer-run', expiresAt: '2026-11-09T00:50:00Z' }) {
      const current = await store.readDoc('admin_config', LEASE_DOC_ID, 'admin_config');
      await store.replaceDocIfMatch('admin_config', { ...current, ...fields }, { partitionKey: 'admin_config' });
    }

    it("writes nothing when another run took the lease before the save, and leaves that run's lease alone", async () => {
      let store;
      const google = googleStub({
        listSitemaps: async () => {
          await changeLease(store);
          return [];
        },
      });
      const ctx = setup({ google, stored: previousRun() });
      store = ctx.store;
      await expect(ctx.sync.run()).resolves.toEqual({ skipped: 'lease_lost' });
      expect(store.snapshotWrites()).toBe(0);
      expect(store.doc.generatedAt).toBe('2026-11-08T12:10:00.000Z');
      expect(store.lease).toMatchObject({ holder: 'newer-run', expiresAt: '2026-11-09T00:50:00Z' });
      const lines = ctx.log.log.mock.calls.flat().join('\n');
      expect(lines).toMatch(/stopped: the run lease was lost before saving, nothing written, \d+s/);
      expect(lines).not.toContain('hybridcloudworks.com');
    });

    it('writes nothing when its own lease has lapsed by the time it saves', async () => {
      let store;
      const google = googleStub({
        listSitemaps: async () => {
          await changeLease(store, { expiresAt: '2026-11-09T00:09:00Z' });
          return [];
        },
      });
      const ctx = setup({ google });
      store = ctx.store;
      await expect(ctx.sync.run()).resolves.toEqual({ skipped: 'lease_lost' });
      expect(store.snapshotWrites()).toBe(0);
    });

    it('writes no error document either when the lease was lost while the sitemap was read', async () => {
      let store;
      const fetchImpl = vi.fn(async () => {
        await changeLease(store);
        return textResponse(503, '');
      });
      const ctx = setup({ fetchImpl, stored: previousRun() });
      store = ctx.store;
      await expect(ctx.sync.run()).resolves.toEqual({ skipped: 'lease_lost' });
      expect(store.snapshotWrites()).toBe(0);
    });

    it.each([
      ['writes nothing when renewing keeps losing to another writer (412)', Infinity, { skipped: 'lease_lost' }, 0, 3],
      ['still saves when one renew loses to a Run now press and the lease is still its own', 1, { status: 'ok' }, 1, 2],
    ])('%s', async (_label, failFirst, result, writes, tries) => {
      let saving = false;
      const google = googleStub({
        listSitemaps: async () => {
          saving = true;
          return [];
        },
      });
      const ctx = setup({ google });
      const real = ctx.store.replaceDocIfMatch.getMockImplementation();
      let renewTries = 0;
      ctx.store.replaceDocIfMatch.mockImplementation(async (container, doc, options) => {
        if (saving && doc.id === LEASE_DOC_ID && doc.holder !== null) {
          renewTries += 1;
          if (renewTries <= failFirst) throw Object.assign(new Error('precondition'), { code: 412 });
        }
        return real(container, doc, options);
      });
      await expect(ctx.sync.run()).resolves.toMatchObject(result);
      expect(renewTries).toBe(tries);
      expect(ctx.store.snapshotWrites()).toBe(writes);
    });

    it('at the time limit, cuts off the inspections still waiting, starts no more, and saves what it has', async () => {
      const urls = pagesNamed(10);
      const google = googleStub({ inspect: untilCancelled('inspect') });
      const { sync, store, client } = setup({ google, urls, stored: previousRun(urls), deadlineMs: 20 });
      await expect(sync.run()).resolves.toMatchObject({ status: 'ok', pages: 10, inspected: 4, failed: 0 });
      expect(client.inspect).toHaveBeenCalledTimes(4);
      expect(askedFor(client)).toEqual(['page']);
      expect(client.listSitemaps).not.toHaveBeenCalled();
      expect(store.snapshotWrites()).toBe(1);
      expect(store.doc.status).toBe('ok');
      expect(store.doc.run.message).toBe(
        'The run reached its 25-minute time limit after 4 of 10 pages were sent to Google, so it stopped; the pages it did not finish keep their last result, and any part not read keeps its last figures.'
      );
      for (const page of store.doc.indexing.pages) expect(page).toMatchObject({ verdict: 'PASS', stale: true, error: DEADLINE_NOTE });
      expect(store.doc.performance.totals.clicks).toBe(99);
      expect(store.doc.sitemaps).toEqual([{ path: 'kept' }]);
      // The page query answered before the limit, so the strays were worked out (none).
      expect(store.doc.indexing.strays).toEqual([]);
      expect(store.doc.indexing.history).toEqual([{ at: 'x' }]);
      expect(store.lease.holder).toBeNull();
    });

    it.each([
      // The page query answers (it comes before the inspections); the next one hangs.
      ['a performance query', { searchAnalytics: (body, options) => (body.dimensions?.[0] === 'page' ? [] : untilCancelled('searchAnalytics')(body, options)) }, 99],
      ['the sitemaps list', { listSitemaps: untilCancelled('sitemaps') }, 10],
    ])('at the time limit, cuts off %s and keeps the last figures for what was not read', async (_label, overrides, clicks) => {
      const google = googleStub(overrides);
      const { sync, store } = setup({ google, stored: previousRun(), deadlineMs: 20 });
      await expect(sync.run()).resolves.toMatchObject({ status: 'ok', inspected: 2, failed: 0 });
      expect(store.doc.run.message).toContain('25-minute time limit after 2 of 2 pages');
      expect(store.doc.run.message).not.toContain('Performance');
      expect(store.doc.run.message).not.toContain('Sitemaps:');
      expect(store.doc.performance.totals.clicks).toBe(clicks);
      expect(store.doc.sitemaps).toEqual([{ path: 'kept' }]);
      // Pages Google answered before the limit are fresh.
      expect(store.doc.indexing.pages.every((p) => !p.stale)).toBe(true);
    });

    it('ends the pause between inspection starts at the time limit, and starts nothing after it', async () => {
      const store = memoryStore({ snapshot: previousRun([A, BAD]) });
      const client = googleStub();
      // A pause that would never end by itself.
      const sleep = vi.fn(() => new Promise(() => {}));
      const sync = createSearchConsoleSync({ store, env: ENV, fetchImpl: vi.fn(async () => textResponse(200, sitemapXml([A, BAD]))), client, now: () => NOW, sleep, spacingMs: 1000, deadlineMs: 20 });
      await expect(sync.run()).resolves.toMatchObject({ status: 'ok', inspected: 1 });
      expect(sleep).toHaveBeenCalledWith(1000);
      expect(client.inspect.mock.calls.map(([url]) => url)).toEqual([A]);
      expect(store.doc.indexing.pages.find((p) => p.url === BAD)).toMatchObject({ stale: true, error: DEADLINE_NOTE });
    });

    it('cuts off a hanging request through the real client and sign-in, and does not retry it', async () => {
      const json = (status, body) => ({ ok: status < 300, status, json: async () => body, headers: { get: () => null } });
      let inspections = 0;
      const fetchImpl = vi.fn((url, init) => {
        if (url.endsWith('/sitemap.xml')) return Promise.resolve(textResponse(200, sitemapXml([A])));
        if (url.startsWith('https://sts.googleapis.com/')) return Promise.resolve(json(200, { access_token: 'federated' }));
        if (url.startsWith('https://iamcredentials.googleapis.com/'))
          return Promise.resolve(json(200, { accessToken: 'sa-token', expireTime: '2026-11-09T01:10:00Z' }));
        if (url.includes('urlInspection')) {
          inspections += 1;
          return new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
          });
        }
        return Promise.resolve(json(200, {}));
      });
      const store = memoryStore({ snapshot: previousRun([A]) });
      const credential = { getToken: vi.fn(async () => ({ token: 'entra' })) };
      const sync = createSearchConsoleSync({ store, env: ENV, fetchImpl, credential, now: () => NOW, sleep: async () => {}, spacingMs: 0, deadlineMs: 20 });
      await expect(sync.run()).resolves.toMatchObject({ status: 'ok', inspected: 1, failed: 0 });
      expect(inspections).toBe(1);
      // Only the page query, made before the inspections; none after the limit.
      expect(fetchImpl.mock.calls.filter(([url]) => url.endsWith('/searchAnalytics/query'))).toHaveLength(1);
      expect(store.doc.indexing.pages[0]).toMatchObject({ verdict: 'PASS', stale: true, error: DEADLINE_NOTE });
    });

    it("cuts off the inspections still waiting when the job's signal fires, and saves nothing", async () => {
      const controller = new AbortController();
      const google = googleStub({
        inspect: (url, options) => {
          setTimeout(() => controller.abort(), 5);
          return untilCancelled('inspect')(url, options);
        },
      });
      const { sync, store, client } = setup({ google, signal: controller.signal, stored: previousRun() });
      await expect(sync.run()).resolves.toMatchObject({ status: 'error', aborted: true });
      expect(askedFor(client)).toEqual(['page']);
      expect(store.snapshotWrites()).toBe(0);
      expect(store.lease.holder).toBeNull();
    });

    it("reads nothing when the job's signal fired before the run began", async () => {
      const { sync, store, client, fetchImpl, log } = setup({ signal: AbortSignal.abort() });
      await expect(sync.run()).resolves.toMatchObject({ status: 'error', aborted: true, pages: 0 });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(client.inspect).not.toHaveBeenCalled();
      expect(store.snapshotWrites()).toBe(0);
      expect(store.lease.holder).toBeNull();
      expect(log.log.mock.calls.flat().join('\n')).toMatch(/stopped: out of time while reading the sitemap, \d+s/);
    });
  });
});

describe('createSearchConsoleSync, every subdomain and the strays inspected (owner decision 2026-11-09, #1612)', () => {
  const pagesNamed = (count, host = 'hybridcloudworks.com') => Array.from({ length: count }, (_, i) => `https://${host}/p${i}`);
  /** Page rows for `count` strays on a subdomain, the first with the most impressions. */
  const strayRows = (count) =>
    Array.from({ length: count }, (_, i) => ({ keys: [`https://docs.hybridcloudworks.com/s${i}`], clicks: 0, impressions: 10000 - i, ctr: 0, position: 5 }));
  /** A stored stray from an earlier run. */
  const storedStray = (url) => ({ url, verdict: 'PASS', coverageState: 'Submitted and indexed', error: null, stale: false, source: 'search', inspectedAt: '2026-11-08T12:10:00.000Z' });

  it('inspects at most 150 strays a run, the ones with the most impressions, and says how many it left', async () => {
    const google = googleStub({ pageRows: strayRows(160) });
    const { sync, store, client } = setup({ google });
    await expect(sync.run()).resolves.toMatchObject({ status: 'ok', pages: 2 + STRAYS_INSPECTED_MAX, inspected: 2 + STRAYS_INSPECTED_MAX });
    const inspected = client.inspect.mock.calls.map(([url]) => url);
    expect(inspected.slice(0, 2)).toEqual([A, BAD]);
    expect(inspected.at(-1)).toBe(`https://docs.hybridcloudworks.com/s${STRAYS_INSPECTED_MAX - 1}`);
    expect(store.doc.run.message).toBe(
      `Google shows 160 pages in search that the sitemap does not list; only the ${STRAYS_INSPECTED_MAX} with the most impressions are inspected.`
    );
    // The strays table keeps its own length.
    expect(store.doc.indexing.strays).toHaveLength(100);
    expect(store.doc.indexing.pages.filter((p) => p.source === 'search')).toHaveLength(STRAYS_INSPECTED_MAX);
    expect(store.doc.indexing.pages.find((p) => p.source === 'search').host).toBe('docs.hybridcloudworks.com');
  });

  it('keeps the strays inside the 900 a run, after the sitemap pages', async () => {
    const urls = pagesNamed(MAX_URLS - 10);
    const google = googleStub({ pageRows: strayRows(20) });
    const { sync, store, client } = setup({ google, urls });
    await sync.run();
    expect(client.inspect).toHaveBeenCalledTimes(MAX_URLS);
    expect(store.doc.run.message).toContain('Google shows 20 pages in search that the sitemap does not list; only the 10 with the most impressions are inspected.');
  });

  it('inspects no stray when the sitemap pages fill the run, and says so', async () => {
    const google = googleStub({ pageRows: strayRows(3) });
    const { sync, store, client } = setup({ google, urls: pagesNamed(MAX_URLS) });
    await sync.run();
    expect(client.inspect).toHaveBeenCalledTimes(MAX_URLS);
    expect(store.doc.run.message).toContain(`Google shows 3 pages in search that the sitemap does not list; none were inspected, because the sitemap's pages fill the run's ${MAX_URLS}.`);
  });

  it('spends the day\'s allowance on sitemap pages first; a stray without room keeps its last answer, stale', async () => {
    const stray = 'https://docs.hybridcloudworks.com/s0';
    const lease = { holder: null, budget: { day: PACIFIC_DAY, used: 1798 } };
    const stored = { ...previousRun(), indexing: { ...previousRun().indexing, pages: [...previousRun().indexing.pages, storedStray(stray)] } };
    const { sync, store, client } = setup({ google: googleStub({ pageRows: strayRows(1) }), lease, stored });
    await expect(sync.run()).resolves.toMatchObject({ status: 'ok', pages: 3, inspected: 2, stale: 1 });
    expect(client.inspect.mock.calls.map(([url]) => url)).toEqual([A, BAD]);
    expect(store.doc.indexing.pages.find((p) => p.url === stray)).toMatchObject({
      source: 'search',
      host: 'docs.hybridcloudworks.com',
      verdict: 'PASS',
      stale: true,
      error: 'Not inspected in the last run: the daily allowance of Google page inspections was used up.',
    });
  });

  it('fails only the stray on a 403 (an address outside the property), and the run goes on', async () => {
    const stray = 'https://docs.hybridcloudworks.com/s0';
    const google = googleStub({
      pageRows: strayRows(1),
      inspect: async (url) => {
        if (url === stray) throw new SearchConsoleError('inspect', 403);
        return passResult(url);
      },
    });
    const { sync, store } = setup({ google });
    await expect(sync.run()).resolves.toMatchObject({ status: 'ok', failed: 1 });
    expect(store.doc.status).toBe('ok');
    expect(store.doc.indexing.pages.find((p) => p.url === stray).error).toContain('may not be part of the Search Console property');
  });

  it('records a stray\'s failed inspection on that stray, keeping its last answer', async () => {
    const stray = 'https://docs.hybridcloudworks.com/s0';
    const google = googleStub({
      pageRows: strayRows(1),
      inspect: async (url) => {
        if (url === stray) throw new SearchConsoleError('inspect', 500);
        return passResult(url);
      },
    });
    const stored = { ...previousRun(), indexing: { ...previousRun().indexing, pages: [...previousRun().indexing.pages, storedStray(stray)] } };
    const { sync, store } = setup({ google, stored });
    await expect(sync.run()).resolves.toMatchObject({ status: 'ok', failed: 1, stale: 1 });
    expect(store.doc.indexing.pages.find((p) => p.url === stray)).toMatchObject({ source: 'search', stale: true, error: 'Search Console inspect failed with HTTP 500.' });
  });

  it('drops a stray from the last run once the strays are worked out again and it is not one', async () => {
    const gone = 'https://docs.hybridcloudworks.com/gone';
    const stored = { ...previousRun(), indexing: { ...previousRun().indexing, pages: [...previousRun().indexing.pages, storedStray(gone)] } };
    const { sync, store } = setup({ stored });
    await sync.run();
    expect(store.doc.indexing.pages.map((p) => p.url).sort()).toEqual([A, BAD]);
  });

  it('keeps a stray from the last run, stale, when the page query fails', async () => {
    const kept = 'https://docs.hybridcloudworks.com/kept';
    const listedNow = `${A}/`;
    const google = googleStub({
      searchAnalytics: async (body) => {
        if (body.dimensions?.[0] === 'page') throw new SearchConsoleError('searchAnalytics', 500);
        return [];
      },
    });
    const stored = {
      ...previousRun(),
      // An older snapshot's page with no `source` is a sitemap page, and a
      // stray the sitemap now lists (A with a trailing slash) is not kept.
      indexing: { ...previousRun().indexing, pages: [...previousRun().indexing.pages.map(({ source, ...page }) => page), storedStray(kept), storedStray(listedNow)] },
    };
    const { sync, store } = setup({ google, stored });
    await expect(sync.run()).resolves.toMatchObject({ status: 'ok', inspected: 2, stale: 1 });
    expect(store.doc.indexing.pages.map((p) => p.url).sort()).toEqual([A, BAD, kept].sort());
    expect(store.doc.indexing.pages.find((p) => p.url === kept)).toMatchObject({
      source: 'search',
      stale: true,
      error: "Not inspected in the last run: the pages Google shows in search could not be worked out (the sitemap or Google's page list could not be read in full), so this page was not looked for.",
    });
    expect(store.doc.indexing.strays).toEqual(previousRun().indexing.strays);
    expect(store.doc.run.message).toContain('Performance page: Search Console searchAnalytics failed with HTTP 500. The last figures were kept.');
  });

  it('keeps a stray from the last run, stale, when the sitemap is read only in part, and inspects no new stray', async () => {
    const kept = 'https://docs.hybridcloudworks.com/kept';
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/sitemap.xml'))
        return textResponse(200, '<sitemapindex><sitemap><loc>https://hybridcloudworks.com/s1.xml</loc></sitemap><sitemap><loc>https://hybridcloudworks.com/s2.xml</loc></sitemap></sitemapindex>');
      if (url.endsWith('/s2.xml')) return textResponse(500, '');
      return textResponse(200, sitemapXml([A]));
    });
    const stored = { ...previousRun([A]), indexing: { ...previousRun([A]).indexing, pages: [...previousRun([A]).indexing.pages, storedStray(kept)] } };
    const { sync, store, client } = setup({ fetchImpl, stored, google: googleStub({ pageRows: strayRows(2) }) });
    await sync.run();
    expect(client.inspect.mock.calls.map(([url]) => url)).toEqual([A]);
    expect(store.doc.indexing.pages.find((p) => p.url === kept)).toMatchObject({ source: 'search', stale: true });
  });

  it('reads Search Analytics for the whole property: no filter on any query', async () => {
    const { sync, client } = setup();
    await sync.run();
    expect(client.searchAnalytics.mock.calls.length).toBeGreaterThan(0);
    for (const [body] of client.searchAnalytics.mock.calls) expect(body.dimensionFilterGroups).toBeUndefined();
  });

  it('knows the domain and its subdomains by the parsed host name', () => {
    expect(siteAddress('https://docs.hybridcloudworks.com/x')?.hostname).toBe('docs.hybridcloudworks.com');
    expect(siteAddress('https://a.b.lab.hybridcloudworks.com/')).not.toBeNull();
    for (const bad of [
      'https://hybridcloudworks.com.example.net/',
      'https://evilhybridcloudworks.com/',
      'http://docs.hybridcloudworks.com/',
      'ftp://hybridcloudworks.com/',
      'https://hybridcloudworks.com:8443/x',
      'https://user:pass@docs.hybridcloudworks.com/',
      'https://user@hybridcloudworks.com/',
      'nonsense',
      null,
    ]) {
      expect(siteAddress(bad)).toBeNull();
    }
    expect(hostOf('https://Docs.HybridCloudWorks.com/x')).toBe('docs.hybridcloudworks.com');
    expect(hostOf('https://example.net/')).toBeNull();
  });
});

describe('createSearchConsoleSync, a job that is no longer needed (Copilot review round 3, #1614)', () => {
  const JOB_CREATED = '2026-11-09T00:00:00.000Z';
  const marker = (jobId) => ({ jobId, claimedAt: '2026-11-09T00:05:00.000Z', expiresAt: '2026-11-09T00:40:00.000Z' });

  it('stops before the lease and calls nothing when the marker names another job still waiting (a job queued straight through enqueueJob)', async () => {
    const lease = { holder: null, budget: { day: PACIFIC_DAY, used: 0 }, pendingJob: marker('job-run-now') };
    const { sync, store, client, fetchImpl, log } = setup({
      lease,
      jobs: { 'job-run-now': { id: 'job-run-now', status: 'queued' } },
      jobId: 'job-direct',
      jobCreatedAt: JOB_CREATED,
    });
    await expect(sync.run()).resolves.toEqual({ skipped: 'superseded' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(client.inspect).not.toHaveBeenCalled();
    expect(client.searchAnalytics).not.toHaveBeenCalled();
    // The other job's marker is left for it, and the lease was never taken.
    expect(store.lease.pendingJob.jobId).toBe('job-run-now');
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
    expect(log.log.mock.calls.flat().join('\n')).toContain('skipped: a newer run or another queued job makes this one unneeded');
  });

  it('stops when a run finished after the job was queued (a queue message the sweeper sent again), and clears its own marker', async () => {
    const stored = { ...previousRun(), run: { finishedAt: '2026-11-09T00:04:00.000Z' } };
    const lease = { holder: null, budget: { day: PACIFIC_DAY, used: 2 }, pendingJob: marker('job-late') };
    const { sync, store, client } = setup({ stored, lease, jobs: { 'job-late': { id: 'job-late', status: 'running' } }, jobId: 'job-late', jobCreatedAt: JOB_CREATED });
    await expect(sync.run()).resolves.toEqual({ skipped: 'superseded' });
    expect(client.inspect).not.toHaveBeenCalled();
    expect(store.lease.pendingJob).toBeNull();
    expect(store.lease.budget).toEqual({ day: PACIFIC_DAY, used: 2 });
    expect(store.snapshotWrites()).toBe(0);
  });

  it('leaves the marker alone when it names another job that has finished, and gives way to a newer run', async () => {
    const stored = { ...previousRun(), run: { finishedAt: '2026-11-09T00:04:00.000Z' } };
    const lease = { holder: null, pendingJob: marker('job-old') };
    const { sync, store } = setup({ stored, lease, jobs: { 'job-old': { id: 'job-old', status: 'succeeded' } }, jobId: 'job-late', jobCreatedAt: JOB_CREATED });
    await expect(sync.run()).resolves.toEqual({ skipped: 'superseded' });
    expect(store.lease.pendingJob.jobId).toBe('job-old');
  });

  it('still runs when the last run finished only seconds after the job was queued (clocks on two hosts)', async () => {
    const stored = { ...previousRun(), run: { finishedAt: '2026-11-09T00:00:02.000Z' } };
    const { sync, client } = setup({ stored, jobId: 'job-now', jobCreatedAt: JOB_CREATED });
    await expect(sync.run()).resolves.not.toEqual({ skipped: 'superseded' });
    expect(client.inspect).toHaveBeenCalled();
  });

  it('tries again when the marker changes while it is cleared (412)', async () => {
    const stored = { ...previousRun(), run: { finishedAt: '2026-11-09T00:04:00.000Z' } };
    const lease = { holder: null, pendingJob: marker('job-late') };
    const { sync, store } = setup({ stored, lease, jobId: 'job-late', jobCreatedAt: JOB_CREATED });
    const real = store.replaceDocIfMatch.getMockImplementation();
    store.replaceDocIfMatch.mockImplementationOnce(async () => {
      throw Object.assign(new Error('precondition'), { code: 412 });
    });
    store.replaceDocIfMatch.mockImplementation(real);
    await expect(sync.run()).resolves.toEqual({ skipped: 'superseded' });
    expect(store.lease.pendingJob).toBeNull();
    expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(2);
  });

  it('runs when the marker names this job and no run finished since it was queued', async () => {
    const stored = { ...previousRun(), run: { finishedAt: '2026-11-08T23:00:00.000Z' } };
    const lease = { holder: null, pendingJob: marker('job-1') };
    const { sync, store } = setup({ stored, lease, jobs: { 'job-1': { id: 'job-1', status: 'running' } }, jobId: 'job-1', jobCreatedAt: JOB_CREATED });
    await expect(sync.run()).resolves.toMatchObject({ status: 'ok', inspected: 2 });
    // Taking the lease cleared the marker that named this job.
    expect(store.lease.pendingJob).toBeNull();
  });

  it('runs a job queued straight through enqueueJob when nothing else is waiting', async () => {
    const { sync } = setup({ stored: previousRun(), jobId: 'job-direct', jobCreatedAt: JOB_CREATED });
    await expect(sync.run()).resolves.toMatchObject({ status: 'ok' });
  });

  it('judges only by the marker when the job has no readable queued time', async () => {
    const stored = { ...previousRun(), run: { finishedAt: '2026-11-09T00:04:00.000Z' } };
    const { sync } = setup({ stored, jobId: 'job-direct', jobCreatedAt: 'not a time' });
    await expect(sync.run()).resolves.toMatchObject({ status: 'ok' });
  });

  it('never stops a timer run this way', async () => {
    const stored = { ...previousRun(), run: { finishedAt: '2026-11-09T00:04:00.000Z' } };
    const lease = { holder: null, pendingJob: marker('job-run-now') };
    const { sync, store } = setup({ stored, lease, jobs: { 'job-run-now': { id: 'job-run-now', status: 'queued' } } });
    await expect(sync.run()).resolves.toMatchObject({ status: 'ok' });
    // The queued job's marker is kept for it.
    expect(store.lease.pendingJob.jobId).toBe('job-run-now');
  });
});
