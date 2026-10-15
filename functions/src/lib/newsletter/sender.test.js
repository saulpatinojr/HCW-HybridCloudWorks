/**
 * The newsletter's From address (ADR 0033 Amplify slice): the code constant
 * is the default, a stored address must parse, and a domain other than the
 * default's must be verified in Resend.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_NEWSLETTER_FROM,
  DEFAULT_SENDING_DOMAIN,
  checkSendingDomain,
  parseFromAddress,
  presentSender,
  resolveFromAddress,
} from './sender.js';

describe('parseFromAddress', () => {
  it('reads a bare address and a named one, and refuses anything else', () => {
    expect(parseFromAddress('weekly@news.hybridcloudworks.com')).toMatchObject({
      name: '',
      email: 'weekly@news.hybridcloudworks.com',
      domain: 'news.hybridcloudworks.com',
      from: 'weekly@news.hybridcloudworks.com',
    });
    expect(parseFromAddress('HCW Weekly <Weekly@News.HybridCloudWorks.com>')).toMatchObject({
      name: 'HCW Weekly',
      email: 'weekly@news.hybridcloudworks.com',
      from: 'HCW Weekly <weekly@news.hybridcloudworks.com>',
    });
    expect(parseFromAddress('not an address')).toBeNull();
    expect(parseFromAddress('Name <no-at-sign>')).toBeNull();
    expect(parseFromAddress('')).toBeNull();
  });

  it('the default parses, and its domain is the one always allowed', () => {
    expect(parseFromAddress(DEFAULT_NEWSLETTER_FROM).domain).toBe(DEFAULT_SENDING_DOMAIN);
    expect(DEFAULT_SENDING_DOMAIN).toBe('news.hybridcloudworks.com');
  });
});

describe('presentSender and resolveFromAddress', () => {
  it('nothing stored, or an unparseable value, means the default', async () => {
    expect(presentSender(null)).toMatchObject({
      from: DEFAULT_NEWSLETTER_FROM,
      isDefault: true,
    });
    expect(presentSender({ from: 'garbage' })).toMatchObject({
      from: DEFAULT_NEWSLETTER_FROM,
      isDefault: true,
    });
    expect(
      presentSender({
        from: 'Weekly <w@news.hybridcloudworks.com>',
        updatedAt: 't',
      })
    ).toMatchObject({
      from: 'Weekly <w@news.hybridcloudworks.com>',
      isDefault: false,
      updatedAt: 't',
    });
    const store = {
      readDoc: vi.fn(async () => ({ from: 'w@news.hybridcloudworks.com' })),
    };
    expect(await resolveFromAddress(store)).toBe('w@news.hybridcloudworks.com');
    const broken = {
      readDoc: vi.fn(async () => Promise.reject(new Error('down'))),
    };
    expect(await resolveFromAddress(broken, { warn: vi.fn() })).toBe(DEFAULT_NEWSLETTER_FROM);
  });
});

describe('checkSendingDomain', () => {
  const listing = (rows) => ({
    listDomains: vi.fn(async () => ({
      ok: true,
      status: 200,
      data: { data: rows },
    })),
  });

  it('the default domain needs no Resend call; another must be listed and verified', async () => {
    expect(await checkSendingDomain(DEFAULT_SENDING_DOMAIN, null)).toEqual({
      ok: true,
    });
    expect(await checkSendingDomain('other.example.com', null)).toMatchObject({
      ok: false,
    });
    expect(
      await checkSendingDomain(
        'other.example.com',
        listing([{ name: 'other.example.com', status: 'verified' }])
      )
    ).toEqual({ ok: true });
    expect(
      await checkSendingDomain(
        'other.example.com',
        listing([{ name: 'other.example.com', status: 'pending' }])
      )
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/pending/),
    });
    expect(await checkSendingDomain('other.example.com', listing([]))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not a sending domain/),
    });
  });

  it("names Resend's status and error name, never its sentence (#945)", async () => {
    const client = {
      listDomains: vi.fn(async () => ({
        ok: false,
        status: 401,
        data: { name: 'restricted_api_key', message: 'API key is invalid' },
      })),
    };
    expect(await checkSendingDomain('other.example.com', client)).toEqual({
      ok: false,
      reason: 'Resend could not list sending domains (HTTP 401 restricted_api_key)',
    });
  });
});
