/**
 * The Cloudflare page's calls (#1905): each one is the route the server's
 * contract names, an id in a path is checked before the request, and a purge
 * sends only one of its two shapes.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getJSON = vi.fn();
const postJSON = vi.fn();
const sendJSON = vi.fn();
vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  postJSON: (...args) => postJSON(...args),
  sendJSON: (...args) => sendJSON(...args),
}));

const api = await import('./cloudflare');

beforeEach(() => {
  getJSON.mockReset().mockResolvedValue({});
  postJSON.mockReset().mockResolvedValue({});
  sendJSON.mockReset().mockResolvedValue({});
});

describe('the Cloudflare routes', () => {
  it('reads from the contract’s routes', async () => {
    await api.readCloudflareStatus();
    await api.readCloudflareSettings();
    await api.readCloudflareDns();
    await api.readCloudflareRulesets();
    await api.readCloudflarePhase('http_ratelimit');
    expect(getJSON.mock.calls.map(([route]) => route)).toEqual([
      'cms/cloudflare/status',
      'cms/cloudflare/settings',
      'cms/cloudflare/dns',
      'cms/cloudflare/rulesets',
      'cms/cloudflare/rulesets/phases/http_ratelimit',
    ]);
  });

  it('writes with the contract’s methods and bodies, and never deletes', async () => {
    await api.saveCloudflareSetting('always_use_https', 'on');
    await api.updateCloudflareDnsRecord('0123456789abcdef0123456789abcdef', { content: 'x' });
    await api.replaceCloudflarePhase('http_request_firewall_custom', {
      rules: [],
      expectedVersion: '3',
    });
    await api.createCloudflareDnsRecord({ type: 'A' });
    expect(sendJSON.mock.calls).toEqual([
      ['cms/cloudflare/settings/always_use_https', 'PATCH', { value: 'on' }],
      ['cms/cloudflare/dns/0123456789abcdef0123456789abcdef', 'PATCH', { content: 'x' }],
      [
        'cms/cloudflare/rulesets/phases/http_request_firewall_custom',
        'PUT',
        { rules: [], expectedVersion: '3' },
      ],
    ]);
    expect(postJSON).toHaveBeenCalledWith('cms/cloudflare/dns', { type: 'A' });
    for (const [, method] of sendJSON.mock.calls) expect(method).not.toBe('DELETE');
  });

  it('sends a purge as everything or as files, never both', async () => {
    await api.purgeCloudflareCache({ everything: true, files: ['https://example.com/'] });
    await api.purgeCloudflareCache({ files: ['https://example.com/a'] });
    expect(postJSON.mock.calls).toEqual([
      ['cms/cloudflare/purge', { everything: true }],
      ['cms/cloudflare/purge', { files: ['https://example.com/a'] }],
    ]);
  });

  it('refuses an id that is not the server’s shape before any request', () => {
    expect(() => api.saveCloudflareSetting('../zones', 'on')).toThrow(/not a valid setting id/);
    expect(() => api.readCloudflarePhase('HTTP-1')).toThrow(/not a valid rule phase/);
    expect(api.PHASE_ID.test('ddos_l7')).toBe(true);
    expect(() => api.updateCloudflareDnsRecord('a/b', {})).toThrow(/not a valid record id/);
    // The server's rule exactly: 32 lower-case hex characters.
    expect(() => api.updateCloudflareDnsRecord('abc123', {})).toThrow(/not a valid record id/);
    expect(() => api.updateCloudflareDnsRecord('G'.repeat(32), {})).toThrow(
      /not a valid record id/
    );
    expect(() => api.updateCloudflareDnsRecord('A'.repeat(32), {})).toThrow(
      /not a valid record id/
    );
    expect(sendJSON).not.toHaveBeenCalled();
    expect(getJSON).not.toHaveBeenCalled();
  });
});

describe('the zone (#1911)', () => {
  const LAB = 'hybridcloudinsights.com';
  const ID = '0123456789abcdef0123456789abcdef';

  it('names the zone on every call when one is given, and leaves it off when not', async () => {
    await api.readCloudflareStatus(LAB);
    await api.readCloudflareSettings(LAB);
    await api.readCloudflareDns(LAB);
    await api.readCloudflareRulesets(LAB);
    await api.readCloudflarePhase('http_ratelimit', LAB);
    await api.readCloudflareStatus();
    expect(getJSON.mock.calls.map(([route]) => route)).toEqual([
      `cms/cloudflare/status?zone=${LAB}`,
      `cms/cloudflare/settings?zone=${LAB}`,
      `cms/cloudflare/dns?zone=${LAB}`,
      `cms/cloudflare/rulesets?zone=${LAB}`,
      `cms/cloudflare/rulesets/phases/http_ratelimit?zone=${LAB}`,
      'cms/cloudflare/status',
    ]);
    await api.saveCloudflareSetting('brotli', 'on', LAB);
    await api.updateCloudflareDnsRecord(ID, { content: 'x' }, LAB);
    await api.replaceCloudflarePhase('http_ratelimit', { rules: [] }, LAB);
    expect(sendJSON.mock.calls.map(([route]) => route)).toEqual([
      `cms/cloudflare/settings/brotli?zone=${LAB}`,
      `cms/cloudflare/dns/${ID}?zone=${LAB}`,
      `cms/cloudflare/rulesets/phases/http_ratelimit?zone=${LAB}`,
    ]);
    await api.createCloudflareDnsRecord({ type: 'A' }, LAB);
    await api.purgeCloudflareCache({ everything: true }, LAB);
    expect(postJSON.mock.calls.map(([route]) => route)).toEqual([
      `cms/cloudflare/dns?zone=${LAB}`,
      `cms/cloudflare/purge?zone=${LAB}`,
    ]);
  });

  it('asks for a DNS page past the first with ?page=, beside the zone (#1907)', async () => {
    await api.readCloudflareDns(undefined, 1);
    await api.readCloudflareDns(undefined, 2);
    await api.readCloudflareDns(LAB, 3);
    await api.readCloudflareDns(LAB, api.MAX_DNS_PAGE);
    expect(getJSON.mock.calls.map(([route]) => route)).toEqual([
      'cms/cloudflare/dns',
      'cms/cloudflare/dns?page=2',
      `cms/cloudflare/dns?zone=${LAB}&page=3`,
      `cms/cloudflare/dns?zone=${LAB}&page=1000`,
    ]);
  });

  it('refuses a DNS page the server would refuse, before any request', () => {
    // The server's module reaches Node-only code, so its constant is read from its text.
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(
      resolve(here, '../../../functions/src/lib/cloudflare/dns-routes.js'),
      'utf8'
    );
    expect(source).toContain(`export const MAX_DNS_PAGE = ${api.MAX_DNS_PAGE};`);
    for (const page of [0, -1, 1.5, '2', api.MAX_DNS_PAGE + 1, Number.NaN]) {
      expect(() => api.readCloudflareDns(LAB, page), String(page)).toThrow(/not a valid page/);
    }
    expect(getJSON).not.toHaveBeenCalled();
  });

  it('refuses a zone that is not a plain name before any request', () => {
    for (const zone of ['', 'a b', 'x&zone=evil', 'HYBRIDCLOUDINSIGHTS.COM/..']) {
      expect(() => api.readCloudflareDns(zone), zone).toThrow(/not a valid zone name/);
    }
    expect(getJSON).not.toHaveBeenCalled();
  });
});
