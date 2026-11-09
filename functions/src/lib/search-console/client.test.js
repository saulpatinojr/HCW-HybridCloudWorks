/**
 * client.js: the three Search Console calls, the retry rule and the 403
 * sentence (#1612). Fetch is a stub; nothing here reaches the network.
 */
import { describe, it, expect, vi } from 'vitest';
import { createSearchConsoleClient, INSPECT_URL, SearchConsoleError } from './client.js';

const SITE = 'sc-domain:hybridcloudworks.com';
const TOKEN = 'access-token-should-never-leak';

const response = (status, body = {}, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
});

function setup(responses) {
  const queue = [...responses];
  const fetchImpl = vi.fn(async () => queue.shift());
  const sleep = vi.fn(async () => {});
  const auth = { getAccessToken: vi.fn(async () => TOKEN), reset: vi.fn() };
  const client = createSearchConsoleClient({ siteUrl: SITE, auth, fetchImpl, sleep });
  return { client, fetchImpl, sleep, auth };
}

describe('createSearchConsoleClient', () => {
  it('inspects one URL against the property, in English', async () => {
    const { client, fetchImpl } = setup([response(200, { inspectionResult: { indexStatusResult: { verdict: 'PASS' } } })]);
    await expect(client.inspect('https://hybridcloudworks.com/a')).resolves.toEqual({
      indexStatusResult: { verdict: 'PASS' },
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(INSPECT_URL);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body)).toEqual({
      inspectionUrl: 'https://hybridcloudworks.com/a',
      siteUrl: SITE,
      languageCode: 'en-US',
    });
  });

  it('queries Search Analytics and lists sitemaps under the encoded property', async () => {
    const { client, fetchImpl } = setup([
      response(200, { rows: [{ keys: ['x'], clicks: 1 }] }),
      response(200, { sitemap: [{ path: 'https://hybridcloudworks.com/sitemap.xml' }] }),
    ]);
    await expect(client.searchAnalytics({ startDate: '2026-01-01', endDate: '2026-01-02' })).resolves.toHaveLength(1);
    await expect(client.listSitemaps()).resolves.toHaveLength(1);
    const base = 'https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Ahybridcloudworks.com';
    expect(fetchImpl.mock.calls[0][0]).toBe(`${base}/searchAnalytics/query`);
    expect(fetchImpl.mock.calls[1][0]).toBe(`${base}/sitemaps`);
    expect(fetchImpl.mock.calls[1][1].method).toBe('GET');
  });

  it('answers [] when Google sends no rows or no sitemaps', async () => {
    const { client } = setup([response(200, {}), response(200, {})]);
    await expect(client.searchAnalytics({})).resolves.toEqual([]);
    await expect(client.listSitemaps()).resolves.toEqual([]);
  });

  it('retries a 429 and a 503 with a growing pause, then succeeds', async () => {
    const { client, sleep } = setup([response(429), response(503), response(200, { inspectionResult: {} })]);
    await expect(client.inspect('https://hybridcloudworks.com/')).resolves.toEqual({});
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000]);
  });

  it('honours a short Retry-After', async () => {
    const { client, sleep } = setup([response(429, {}, { 'retry-after': '3' }), response(200, { rows: [] })]);
    await client.searchAnalytics({});
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it('gives up after three tries with the status and no body text', async () => {
    const { client, fetchImpl } = setup([response(500, { error: 'secret detail' }), response(500), response(500)]);
    const failure = await client.listSitemaps().catch((caught) => caught);
    expect(failure).toBeInstanceOf(SearchConsoleError);
    expect(failure.status).toBe(500);
    expect(failure.message).not.toContain('secret detail');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 403, and says the service account is not a Full user', async () => {
    const { client, fetchImpl } = setup([response(403)]);
    const failure = await client.inspect('https://hybridcloudworks.com/').catch((caught) => caught);
    expect(failure.status).toBe(403);
    expect(failure.message).toContain('the service account is not a Full user on the Search Console property');
    expect(failure.message).not.toContain(TOKEN);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('signs in again once after a 401', async () => {
    const { client, auth } = setup([response(401), response(200, { rows: [] })]);
    await expect(client.searchAnalytics({})).resolves.toEqual([]);
    expect(auth.reset).toHaveBeenCalledTimes(1);
  });

  it('retries a network failure and then reports it without a status', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const client = createSearchConsoleClient({
      siteUrl: SITE,
      auth: { getAccessToken: async () => TOKEN },
      fetchImpl,
      sleep: async () => {},
    });
    const failure = await client.listSitemaps().catch((caught) => caught);
    expect(failure).toBeInstanceOf(SearchConsoleError);
    expect(failure.status).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
