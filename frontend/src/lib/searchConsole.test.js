/**
 * The Search Console page's helpers (#1612): Google's codes in words, the
 * number formats, the order of the pages table, `?tab=` and a report with
 * parts missing.
 */
import { describe, it, expect } from 'vitest';
import {
  PAGE_FETCH_WORDS,
  canonicalMismatch,
  countryLabel,
  deviceLabel,
  fetchFailed,
  fetchStateLabel,
  fmtCount,
  fmtCtr,
  fmtPosition,
  hostOf,
  inspectionHref,
  normalizeReport,
  pageLabel,
  pathOf,
  sitePageHref,
  sourceOf,
  resolveTab,
  sortBreakdown,
  sortPages,
  utcText,
  verdictOf,
} from './searchConsole';

describe('fetchStateLabel', () => {
  it('names every PageFetchState Google documents', () => {
    expect(fetchStateLabel('ACCESS_DENIED')).toBe('401 unauthorized');
    expect(fetchStateLabel('ACCESS_FORBIDDEN')).toBe('403 forbidden');
    expect(fetchStateLabel('NOT_FOUND')).toBe('404 not found');
    expect(fetchStateLabel('SERVER_ERROR')).toBe('5xx server error');
    expect(fetchStateLabel('SUCCESSFUL')).toBe('Fetched');
    expect(Object.keys(PAGE_FETCH_WORDS)).toHaveLength(12);
  });

  it('shows an unknown code as Google sent it, and nothing as Unknown', () => {
    expect(fetchStateLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
    expect(fetchStateLabel(undefined)).toBe('Unknown');
  });

  it('flags a failed fetch, not a clean or unknown one', () => {
    expect(fetchFailed('ACCESS_DENIED')).toBe(true);
    expect(fetchFailed('SUCCESSFUL')).toBe(false);
    expect(fetchFailed('PAGE_FETCH_STATE_UNSPECIFIED')).toBe(false);
    expect(fetchFailed(null)).toBe(false);
  });
});

describe('number formats', () => {
  it('turns a CTR fraction into a percentage with one decimal', () => {
    expect(fmtCtr(0.0456)).toBe('4.6%');
    expect(fmtCtr(0)).toBe('0.0%');
    expect(fmtCtr(1)).toBe('100.0%');
    expect(fmtCtr(undefined)).toBe('—');
    expect(fmtCtr('0.1')).toBe('—');
  });

  it('gives position one decimal and counts thousands separators', () => {
    expect(fmtPosition(3)).toBe('3.0');
    expect(fmtPosition(12.36)).toBe('12.4');
    expect(fmtPosition(null)).toBe('—');
    expect(fmtCount(56789)).toBe('56,789');
    expect(fmtCount(Number.NaN)).toBe('—');
  });

  it('writes a UTC time the way the schedule is written', () => {
    expect(utcText('2026-11-09T12:10:00.000Z')).toBe('2026-11-09 12:10 UTC');
    expect(utcText(null)).toBeNull();
    expect(utcText('not a date')).toBeNull();
  });

  it('shows country and device keys readably', () => {
    expect(countryLabel('bra')).toBe('BRA');
    expect(deviceLabel('DESKTOP')).toBe('Desktop');
  });
});

describe('the pages table', () => {
  const page = (url, verdict) => ({ url: `https://hybridcloudworks.com/${url}`, verdict });

  it('puts every page that is not indexed before the indexed ones', () => {
    const sorted = sortPages([
      page('a', 'PASS'),
      page('b', 'NEUTRAL'),
      page('c', 'FAIL'),
      page('d', 'SOMETHING'),
      page('e', 'PASS'),
    ]);
    expect(sorted.map((p) => p.url.slice(-1))).toEqual(['c', 'd', 'b', 'a', 'e']);
    expect(sortPages(undefined)).toEqual([]);
  });

  it('reads an unknown verdict as unknown', () => {
    expect(verdictOf({ verdict: 'PARTIAL' })).toBe('VERDICT_UNSPECIFIED');
    expect(verdictOf(null)).toBe('VERDICT_UNSPECIFIED');
  });

  it('flags a canonical mismatch only when both addresses are known', () => {
    expect(canonicalMismatch({ googleCanonical: 'x', userCanonical: 'y' })).toBe(true);
    expect(canonicalMismatch({ googleCanonical: 'x', userCanonical: 'x' })).toBe(false);
    expect(canonicalMismatch({ googleCanonical: null, userCanonical: 'y' })).toBe(false);
  });

  it('shows the path of an address, or the text when it will not parse', () => {
    expect(pathOf('https://hybridcloudworks.com/azure/x?y=1')).toBe('/azure/x?y=1');
    expect(pathOf('not a url')).toBe('not a url');
  });

  it('orders a breakdown by clicks, then impressions', () => {
    const rows = sortBreakdown([
      { key: 'a', clicks: 1, impressions: 5 },
      { key: 'b', clicks: 3, impressions: 1 },
      { key: 'c', clicks: 1, impressions: 9 },
    ]);
    expect(rows.map((r) => r.key)).toEqual(['b', 'c', 'a']);
  });
});

describe('resolveTab', () => {
  it('keeps a real tab, moves a guessed one, and falls back to Indexing', () => {
    expect(resolveTab('sitemaps')).toBe('sitemaps');
    expect(resolveTab('queries')).toBe('performance');
    expect(resolveTab('nope')).toBe('indexing');
    expect(resolveTab(null)).toBe('indexing');
  });
});

describe('normalizeReport', () => {
  it('fills every list and block the page reads, from nothing', () => {
    const report = normalizeReport(undefined);
    expect(report.status).toBe('error');
    expect(report.indexing.pages).toEqual([]);
    expect(report.indexing.summary.pass).toBeNull();
    expect(report.performance.totals).toEqual({
      clicks: null,
      impressions: null,
      ctr: null,
      position: null,
    });
    expect(report.sitemaps).toEqual([]);
    expect(report.notAvailable).toEqual([]);
    expect(report.run).toBeNull();
  });

  it('gives every page a source and a host, taking the host from the address when the report has none', () => {
    const report = normalizeReport({
      indexing: {
        pages: [
          { url: 'https://docs.hybridcloudworks.com/a', source: 'search' },
          { url: 'https://hybridcloudworks.com/b', host: 'hybridcloudworks.com' },
          { url: 'https://example.net/c' },
        ],
      },
    });
    expect(report.indexing.pages.map((page) => [page.source, page.host])).toEqual([
      ['search', 'docs.hybridcloudworks.com'],
      ['sitemap', 'hybridcloudworks.com'],
      ['sitemap', null],
    ]);
  });

  it('drops entries that are not objects and keeps the known status', () => {
    const report = normalizeReport({
      status: 'never_run',
      indexing: { pages: [null, 'x', { url: 'https://hybridcloudworks.com/a' }] },
      notAvailable: ['Links (internal and external)', 3],
      run: { message: '   ' },
    });
    expect(report.status).toBe('never_run');
    expect(report.indexing.pages).toHaveLength(1);
    expect(report.notAvailable).toEqual(['Links (internal and external)']);
    expect(report.run.message).toBeNull();
  });

  it('marks a page stale only when the server says true, and reads the stale count', () => {
    const report = normalizeReport({
      indexing: {
        pages: [
          { url: 'https://hybridcloudworks.com/a', stale: true },
          { url: 'https://hybridcloudworks.com/b', stale: 'yes' },
          { url: 'https://hybridcloudworks.com/c' },
        ],
      },
      run: { stale: 2, message: 'Only 4 of 10 pages fit.' },
    });
    expect(report.indexing.pages.map((page) => page.stale)).toEqual([true, false, false]);
    expect(report.run).toMatchObject({ stale: 2, message: 'Only 4 of 10 pages fit.' });
    expect(normalizeReport({ run: {} }).run.stale).toBeNull();
  });
});

describe('link addresses', () => {
  it("links Google's inspection screen only on search.google.com", () => {
    const google = 'https://search.google.com/search-console/inspect?resource_id=x&id=y';
    expect(inspectionHref(google)).toBe(google);
    expect(inspectionHref('https://search.google.com.evil.example/x')).toBeNull();
    expect(inspectionHref('javascript:alert(1)')).toBeNull();
    expect(inspectionHref(null)).toBeNull();
  });

  it('links a page only on the public site or one of its subdomains', () => {
    expect(sitePageHref('https://hybridcloudworks.com/blog/x')).toBe(
      'https://hybridcloudworks.com/blog/x'
    );
    expect(sitePageHref('https://docs.hybridcloudworks.com/a')).toBe(
      'https://docs.hybridcloudworks.com/a'
    );
    expect(sitePageHref('https://a.lab.hybridcloudworks.com/')).toBe(
      'https://a.lab.hybridcloudworks.com/'
    );
    // Look-alikes: the parsed host must be the domain or end with ".hybridcloudworks.com".
    expect(sitePageHref('https://hybridcloudworks.com.evil.example/')).toBeNull();
    expect(sitePageHref('https://hybridcloudworks.com:8443/x')).toBeNull();
    expect(sitePageHref('https://user:pass@docs.hybridcloudworks.com/')).toBeNull();
    expect(sitePageHref('https://evilhybridcloudworks.com/')).toBeNull();
    expect(sitePageHref('https://evil.example/?next=https://hybridcloudworks.com/')).toBeNull();
    expect(sitePageHref('https://evil.example/hybridcloudworks.com')).toBeNull();
    expect(sitePageHref('http://hybridcloudworks.com/a')).toBeNull();
    expect(sitePageHref('javascript:alert(1)//.hybridcloudworks.com')).toBeNull();
    expect(sitePageHref('not a url')).toBeNull();
    expect(sitePageHref(undefined)).toBeNull();
  });

  it('names the host, and shows a path on the main site but the whole address on a subdomain', () => {
    expect(hostOf('https://Docs.HybridCloudWorks.com/a')).toBe('docs.hybridcloudworks.com');
    expect(hostOf('https://example.net/')).toBeNull();
    expect(pageLabel('https://hybridcloudworks.com/blog/x?y=1')).toBe('/blog/x?y=1');
    expect(pageLabel('https://docs.hybridcloudworks.com/a')).toBe(
      'https://docs.hybridcloudworks.com/a'
    );
    expect(pageLabel('https://example.net/a')).toBe('https://example.net/a');
    expect(pageLabel(null)).toBe('');
  });

  it('reads a page from search as found in search, and anything else as the sitemap', () => {
    expect(sourceOf({ source: 'search' })).toBe('search');
    expect(sourceOf({ source: 'sitemap' })).toBe('sitemap');
    expect(sourceOf({ source: 'odd' })).toBe('sitemap');
    expect(sourceOf(null)).toBe('sitemap');
  });
});
