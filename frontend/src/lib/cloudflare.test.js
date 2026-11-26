/**
 * The Cloudflare page's calls (#1905): each one is the route the server's
 * contract names, an id in a path is checked before the request, and a purge
 * sends only one of its two shapes.
 */
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
