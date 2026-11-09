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
  keptInspection,
  MAX_URLS,
  parseSitemap,
  presentSitemaps,
  selectSiteUrls,
  SNAPSHOT_DOC_ID,
  sortPages,
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
function memoryStore({ snapshot = null, lease = null } = {}) {
  const docs = new Map();
  let version = 0;
  if (snapshot) docs.set(SNAPSHOT_DOC_ID, { ...snapshot, id: SNAPSHOT_DOC_ID, _etag: 'e0' });
  if (lease) docs.set(LEASE_DOC_ID, { ...lease, id: LEASE_DOC_ID, _etag: 'e0' });
  const store = {
    readDoc: vi.fn(async (_container, id) => (docs.has(id) ? structuredClone(docs.get(id)) : null)),
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

function googleStub({ inspect, searchAnalytics, listSitemaps } = {}) {
  return {
    inspect: vi.fn(inspect ?? (async (url) => passResult(url))),
    searchAnalytics: vi.fn(
      searchAnalytics ??
        (async (body) => {
          const dimension = body.dimensions?.[0];
          if (!dimension) return [{ clicks: 10, impressions: 200, ctr: 0.05, position: 7.5 }];
          if (dimension === 'date') return [{ keys: ['2026-11-02'], clicks: 1, impressions: 2, ctr: 0.5, position: 3 }, { keys: ['2026-11-01'], clicks: 2, impressions: 4, ctr: 0.5, position: 4 }];
          if (dimension === 'page')
            return [
              { keys: [A], clicks: 5, impressions: 50, ctr: 0.1, position: 2 },
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

function setup({ urls = [A, BAD], stored = null, lease = null, google, env = ENV, signal, sitemap, fetchImpl, jobId } = {}) {
  const store = memoryStore({ snapshot: stored, lease });
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

  it('keeps root-domain https pages only, once each, up to the cap', () => {
    const locs = [
      A,
      A,
      'https://api-azure.hybridcloudworks.com/x',
      'https://www.hybridcloudworks.com/y',
      'http://hybridcloudworks.com/z',
      'not a url',
      'https://hybridcloudworks.com/b',
    ];
    expect(selectSiteUrls(locs)).toEqual({ urls: [A, 'https://hybridcloudworks.com/b'], total: 2 });
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
      { keys: ['https://hybridcloudworks.com/'], clicks: 2, impressions: 15 },
      { keys: ['https://labs.hybridcloudworks.com/x'], clicks: 9, impressions: 99 },
    ];
    expect(findStrays(rows, [A])).toEqual([
      { url: 'https://hybridcloudworks.com/older', clicks: 2, impressions: 20 },
      { url: 'https://hybridcloudworks.com/', clicks: 2, impressions: 15 },
      { url: 'https://hybridcloudworks.com/old', clicks: 0, impressions: 9 },
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
    const { sync, store, client, fetchImpl } = setup();
    const result = await sync.run();
    expect(result).toMatchObject({ status: 'ok', pages: 2, inspected: 2, failed: 0, stale: 0, strays: 1 });
    expect(fetchImpl).toHaveBeenCalledWith('https://hybridcloudworks.com/sitemap.xml', expect.objectContaining({ signal: expect.any(AbortSignal) }));

    const doc = store.doc;
    expect(doc).toMatchObject({ id: SNAPSHOT_DOC_ID, configScope: 'admin_config', status: 'ok', siteUrl: 'sc-domain:hybridcloudworks.com' });
    expect(doc.generatedAt).toBe(NOW.toISOString());
    expect(doc.run).toEqual({ startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), inspected: 2, failed: 0, stale: 0, message: null });
    // Problems first.
    expect(doc.indexing.pages.map((p) => [p.url, p.verdict])).toEqual([
      [BAD, 'FAIL'],
      [A, 'PASS'],
    ]);
    expect(Object.keys(doc.indexing.pages[0]).sort()).toEqual(
      ['coverageState', 'error', 'googleCanonical', 'indexingState', 'inspectedAt', 'inspectionResultLink', 'lastCrawlTime', 'pageFetchState', 'robotsTxtState', 'stale', 'url', 'userCanonical', 'verdict'].sort()
    );
    expect(doc.indexing.pages[0]).toMatchObject({ stale: false, inspectedAt: NOW.toISOString(), error: null });
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
    expect(doc.sitemaps[0]).toMatchObject({ errors: 1, contents: [{ type: 'web', submitted: 203 }] });

    // searchAppearance asked on its own, never with another dimension.
    const dims = client.searchAnalytics.mock.calls.map(([body]) => body.dimensions ?? []);
    expect(dims).toContainEqual(['searchAppearance']);
    expect(dims.every((d) => d.length <= 1)).toBe(true);
    const pageQuery = client.searchAnalytics.mock.calls.find(([body]) => body.dimensions?.[0] === 'page')[0];
    expect(pageQuery.rowLimit).toBe(1000);

    // The lease is given back, with the two inspections counted for the Pacific day.
    expect(store.lease).toMatchObject({ holder: null, expiresAt: null, by: null, budget: { day: PACIFIC_DAY, used: 2 } });
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
    expect(credential.getToken).toHaveBeenCalledWith('api://00000000-0000-0000-0000-000000000001/.default');
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
    expect(client.searchAnalytics).not.toHaveBeenCalled();
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

  it('treats a sitemap with no root-domain page as an error', async () => {
    const { sync, store, client } = setup({ urls: ['https://api-azure.hybridcloudworks.com/x'] });
    await expect(sync.run()).resolves.toMatchObject({ status: 'error' });
    expect(client.inspect).not.toHaveBeenCalled();
    expect(store.doc.run.message).toBe('The sitemap lists no page on hybridcloudworks.com, so nothing was asked of Google.');
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
    expect(store.doc.run.message).toContain(`The sitemap lists ${MAX_URLS + 1} root-domain pages; only the first ${MAX_URLS} are inspected.`);
  });

  it('reads a sitemap index one level down, on the site\'s own host only', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/sitemap.xml'))
        return textResponse(200, '<sitemapindex><sitemap><loc>https://hybridcloudworks.com/s1.xml</loc></sitemap><sitemap><loc>https://evil.example/s.xml</loc></sitemap></sitemapindex>');
      return textResponse(200, sitemapXml(['https://hybridcloudworks.com/from-child']));
    });
    const { sync, store } = setup({ fetchImpl });
    await sync.run();
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(['https://hybridcloudworks.com/sitemap.xml', 'https://hybridcloudworks.com/s1.xml']);
    expect(store.doc.indexing.pages.map((p) => p.url)).toEqual(['https://hybridcloudworks.com/from-child']);
    // Read in full: the strays are worked out.
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
    expect(store.doc.run.message).toContain('1 of 2 child sitemaps could not be read, so the strays were not worked out this run.');
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
    const { sync, log } = setup();
    await sync.run();
    const lines = log.log.mock.calls.flat().join('\n');
    expect(lines).not.toContain('hybridcloudworks.com');
    expect(lines).toMatch(/2 pages, 2 inspected, 0 failed, 0 stale, 1 strays, \d+s/);
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
    expect(client.searchAnalytics).not.toHaveBeenCalled();
    // Half a run is not written over the last whole one.
    expect(store.snapshotWrites()).toBe(0);
  });
});
