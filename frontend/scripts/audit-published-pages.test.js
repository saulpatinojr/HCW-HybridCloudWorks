/**
 * The emptiness thresholds of the published-pages audit, at their boundaries.
 *
 * Importing the crawler does not start it (it runs only when invoked
 * directly), so the pure decision can be pinned here. The thresholds exist
 * because of two real misreadings on 2026-09-06: a thin page with "Coming
 * Soon" is a decision while a thin page with nothing is missing content, and
 * a full landing page whose podcast widget says "No episodes available yet."
 * is not an empty page.
 *
 * NODE ENVIRONMENT, NOT THE PROJECT'S jsdom DEFAULT. Nothing here touches a
 * DOM: it imports a Node CLI module and checks pure functions. Building a
 * jsdom for it was pure cost, and the import pulls in Playwright, whose module
 * graph wants web-stream globals that a browser-shaped context does not owe it
 * (#645).
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  CANCELLED_REQUEST,
  decideEmptiness,
  judgeRecord,
  parseOptions,
} from './audit-published-pages.mjs';

const COPY = ['No episodes available yet.'];

describe('parseOptions', () => {
  // Importing the module must never read argv or exit; parsing happens here,
  // on demand, and a usage error is thrown rather than exited.
  it('applies the defaults', () => {
    const o = parseOptions([], {});
    expect(o).toMatchObject({
      baseUrl: 'https://hybridcloudworks.com',
      sitemap: 'https://hybridcloudworks.com/sitemap.xml',
      concurrency: 3,
      limit: 0,
      only: '',
      strict: false,
      channel: undefined,
    });
  });

  it('reads flags and environment, and bounds concurrency', () => {
    const o = parseOptions(['--only', '/azure', '--limit', '5', '--strict'], {
      AUDIT_BASE_URL: 'https://example.test/',
      AUDIT_CONCURRENCY: '40',
      AUDIT_CHANNEL: 'msedge',
    });
    expect(o).toMatchObject({
      baseUrl: 'https://example.test',
      sitemap: 'https://example.test/sitemap.xml',
      concurrency: 8,
      limit: 5,
      only: '/azure',
      strict: true,
      channel: 'msedge',
    });
    expect(parseOptions([], { AUDIT_CONCURRENCY: 'abc' }).concurrency).toBe(3);
  });

  it('throws on a bad --limit instead of exiting', () => {
    expect(() => parseOptions(['--limit', 'abc'], {})).toThrow(/--limit expects/);
    expect(() => parseOptions(['--limit', '-1'], {})).toThrow(/--limit expects/);
    expect(() => parseOptions(['--limit', '2.5'], {})).toThrow(/--limit expects/);
  });
});

describe('decideEmptiness', () => {
  const cases = [
    // mainChars, emptyCopy, verdict, findings count, notes count
    [0, [], 'empty', 1, 0],
    [399, [], 'empty', 1, 0],
    [399, COPY, 'empty', 2, 0],
    [400, [], 'works', 0, 0],
    [400, COPY, 'empty', 1, 0],
    [799, COPY, 'empty', 1, 0],
    [800, COPY, 'works', 0, 1],
    [2179, COPY, 'works', 0, 1],
    [2179, [], 'works', 0, 0],
  ];

  for (const [mainChars, emptyCopy, verdict, findings, notes] of cases) {
    it(`${mainChars} chars ${emptyCopy.length ? 'with' : 'without'} empty-state copy → ${verdict}`, () => {
      const decision = decideEmptiness({ mainChars, emptyCopy });
      expect(decision.verdict).toBe(verdict);
      expect(decision.findings).toHaveLength(findings);
      expect(decision.notes).toHaveLength(notes);
    });
  }

  it('says which copy it saw, on the row for a thin page and as a note on a full one', () => {
    expect(decideEmptiness({ mainChars: 100, emptyCopy: ['Coming Soon'] }).findings).toEqual([
      'thin main region: 100 chars',
      'empty-state copy: Coming Soon',
    ]);
    expect(decideEmptiness({ mainChars: 2000, emptyCopy: COPY }).notes).toEqual([
      'a widget shows empty-state copy: No episodes available yet.',
    ]);
  });
});

describe('CANCELLED_REQUEST', () => {
  // The crawler navigating away cancels requests in flight. Chromium reports
  // that as net::ERR_ABORTED, which is not the network failing to serve the
  // page: on 2026-09-07 it made the home page a defect for a health route
  // that answered 200 when asked directly.
  it('matches an aborted request', () => {
    expect(CANCELLED_REQUEST.test('net::ERR_ABORTED')).toBe(true);
  });

  it('does not match a real network failure', () => {
    for (const e of [
      'net::ERR_CONNECTION_REFUSED',
      'net::ERR_NAME_NOT_RESOLVED',
      'net::ERR_CERT_DATE_INVALID',
      'net::ERR_TIMED_OUT',
      'failed',
    ]) {
      expect(CANCELLED_REQUEST.test(e)).toBe(false);
    }
  });
});

// What a crawled page becomes: findings and a verdict. This lived inside the
// crawler's page function until #1859 moved it out to meet the linter's
// complexity limit; these hold every finding, in the order it is written.
describe('judgeRecord', () => {
  const clean = (extra = {}) => ({
    path: '/azure',
    provider: 'azure',
    status: 200,
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    apiFailures: [],
    title: 'Azure | Hybrid Cloud Works',
    ogTitle: 'Azure',
    themeClass: 'theme-azure',
    mainChars: 2000,
    emptyCopy: [],
    brokenImages: [],
    media: [],
    notes: [],
    acceptedFailures: 0,
    findings: [],
    verdict: 'works',
    ...extra,
  });

  it('passes a clean page through decideEmptiness', () => {
    expect(judgeRecord(clean())).toMatchObject({ verdict: 'works', findings: [], notes: [] });
    expect(judgeRecord(clean({ mainChars: 10 }))).toMatchObject({
      verdict: 'empty',
      findings: ['thin main region: 10 chars'],
    });
    expect(judgeRecord(clean({ emptyCopy: ['Coming Soon'] }))).toMatchObject({
      verdict: 'works',
      notes: ['a widget shows empty-state copy: Coming Soon'],
    });
  });

  it('writes every finding, in order, and calls the page a defect', () => {
    const record = judgeRecord(
      clean({
        status: 500,
        pageErrors: ['x'],
        consoleErrors: [
          'Minified React error #418',
          'Failed to load resource: 404',
          'Failed to load resource: 404',
          'Failed to load resource: 500',
          'something else',
        ],
        acceptedFailures: 1,
        apiFailures: [{ url: 'https://api.example/public/feed?x=1', status: 503 }],
        failedRequests: [{}, {}],
        title: 'Hybrid Cloud Works',
        ogTitle: 'GitHub',
        themeClass: 'theme-github',
        brokenImages: ['/a.png'],
        media: [
          { url: 'a', status: 200 },
          { url: 'b', status: 206 },
          { url: 'c', status: 404 },
          { url: 'd', status: 0 },
        ],
      })
    );
    expect(record.verdict).toBe('defect');
    expect(record.consoleClasses).toEqual([
      'react-hydration-418',
      'network-failed',
      'console-other',
    ]);
    expect(record.findings).toEqual([
      'http 500',
      'page errors: 1',
      'console react-hydration-418: 1',
      'console network-failed: 2',
      'console console-other: 1',
      'API failures: /public/feed→503',
      'failed requests: 2',
      'title lacks provider name: "Hybrid Cloud Works"',
      'og:title lacks provider name: "GitHub"',
      'theme class theme-github on a azure URL',
      'broken images: 1',
      'media not served: 404,0',
    ]);
  });

  it('says "no response" when there was no document, and drops lines an accepted failure explains', () => {
    const record = judgeRecord(
      clean({
        status: null,
        consoleErrors: ['Failed to load resource: 404'],
        acceptedFailures: 3,
      })
    );
    expect(record.findings).toEqual(['no response']);
    expect(record.consoleClasses).toEqual([]);
  });

  it('does not ask a blog post, an empty og:title or a page without a theme for the provider', () => {
    const post = judgeRecord(
      clean({ path: '/azure/blog/some-post', title: 'Some post', ogTitle: 'Some post' })
    );
    expect(post.findings).toEqual([]);
    const bare = judgeRecord(clean({ ogTitle: '', themeClass: '' }));
    expect(bare.findings).toEqual([]);
    const noProvider = judgeRecord(clean({ provider: null, title: 'Anything' }));
    expect(noProvider.findings).toEqual([]);
  });
});
