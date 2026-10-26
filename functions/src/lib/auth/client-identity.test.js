/**
 * The anonymous rate-limit identity.
 *
 * This module had no tests, which is a bad place not to have them: it is the
 * thing that decides what "one client" means, and every quota in the API counts
 * whatever it returns. Two properties are load-bearing and neither is visible
 * from a passing request.
 *
 *   - **The origin must be verifiably Cloudflare** (DECISION 6). Rate limiting
 *     on a spoofable header is not rate limiting, so production fails closed.
 *   - **The quota unit is the subscriber, not the address** (T-205).
 *     Hashing the full IPv6 address gave one client 2^64 buckets — an unlimited
 *     submission budget where every bucket looked well under the limit.
 *
 * The hash is checked through `anonymousKey` rather than by asserting digests:
 * what matters is which inputs collide and which do not, and a test that pins
 * hex strings would pass just as happily with the salt dropped.
 */
import { describe, it, expect } from 'vitest';
import {
  ORIGIN_NOT_VERIFIED,
  assertClientIdentity,
  createClientIdentity,
  normalizeClientIp,
} from './client-identity.js';

const SECRET = 'origin-secret';

const makeRequest = (headers = {}) => ({
  headers: {
    get: (name) => headers[name.toLowerCase()] ?? null,
  },
});

/** A request that presents the Cloudflare secret, with the given client IP. */
const fromCloudflare = (ip) =>
  makeRequest({ 'x-hcw-origin-secret': SECRET, 'cf-connecting-ip': ip });

const identity = () =>
  createClientIdentity({ originSecret: SECRET, ipSalt: 'salt', allowUnverifiedOrigin: false });

const keyFor = (ip) => identity().anonymousKey(fromCloudflare(ip)).key;

describe('normalizeClientIp — IPv4', () => {
  it('keeps the full address', () => {
    expect(normalizeClientIp('203.0.113.7')).toBe('v4:203.0.113.7');
  });

  it('separates neighbouring addresses', () => {
    expect(normalizeClientIp('203.0.113.7')).not.toBe(normalizeClientIp('203.0.113.8'));
  });
});

describe('normalizeClientIp — IPv6', () => {
  it('truncates to the /64 prefix', () => {
    expect(normalizeClientIp('2001:db8:1234:5678:9abc:def0:1234:5678')).toBe(
      'v6:2001:0db8:1234:5678::/64'
    );
  });

  it('groups every address in one /64 — the defect, stated directly', () => {
    // Before the fix these were 2^64 distinct quota documents. A client with a
    // standard residential allocation could submit without limit while every
    // bucket read zero.
    const first = normalizeClientIp('2001:db8:1234:5678::1');
    const last = normalizeClientIp('2001:db8:1234:5678:ffff:ffff:ffff:ffff');
    const middle = normalizeClientIp('2001:db8:1234:5678:dead:beef:cafe:1');
    expect(new Set([first, last, middle]).size).toBe(1);
  });

  it('still separates different /64s', () => {
    expect(normalizeClientIp('2001:db8:1234:5678::1')).not.toBe(
      normalizeClientIp('2001:db8:1234:5679::1')
    );
  });

  it('expands :: before truncating, wherever it falls', () => {
    // The compression is what makes this easy to get wrong: the same prefix
    // written three ways must land on one bucket.
    expect(normalizeClientIp('2001:db8::1')).toBe('v6:2001:0db8:0000:0000::/64');
    expect(normalizeClientIp('2001:0db8:0:0:0:0:0:1')).toBe('v6:2001:0db8:0000:0000::/64');
    expect(normalizeClientIp('2001:db8:0:0::1')).toBe('v6:2001:0db8:0000:0000::/64');
  });

  it('handles the all-zero and loopback forms', () => {
    expect(normalizeClientIp('::')).toBe('v6:0000:0000:0000:0000::/64');
    expect(normalizeClientIp('::1')).toBe('v6:0000:0000:0000:0000::/64');
  });

  it('normalizes case and leading zeros', () => {
    expect(normalizeClientIp('2001:DB8:0:1::1')).toBe(normalizeClientIp('2001:0db8:0000:0001::1'));
  });

  it('strips a zone index rather than failing on it', () => {
    expect(normalizeClientIp('fe80::1%eth0')).toBe('v6:fe80:0000:0000:0000::/64');
  });

  it('treats a v4-mapped address as the IPv4 client it is', () => {
    // Truncating this to a /64 would collapse every v4-mapped client into one
    // bucket — over-grouping so severe it would be its own denial of service.
    expect(normalizeClientIp('::ffff:203.0.113.7')).toBe('v4:203.0.113.7');
  });

  it('truncates an embedded-IPv4 address that is not v4-mapped', () => {
    // NAT64: the prefix is the translator's, so the /64 is the right unit.
    expect(normalizeClientIp('64:ff9b::203.0.113.7')).toBe('v6:0064:ff9b:0000:0000::/64');
  });
});

describe('normalizeClientIp — unusable input', () => {
  it('collapses anything unparseable into one shared bucket', () => {
    // Not a fresh bucket each: "I cannot identify this caller" must not be a
    // way to obtain an unmetered quota.
    for (const value of [undefined, null, '', 'not-an-ip', '999.999.999.999', '1.2.3.4, 5.6.7.8']) {
      expect(normalizeClientIp(value)).toBe('unknown');
    }
  });
});

describe('anonymousKey', () => {
  it('gives one key to a whole IPv6 /64 and different keys to different /64s', () => {
    expect(keyFor('2001:db8:1:1::1')).toBe(keyFor('2001:db8:1:1:ffff::9999'));
    expect(keyFor('2001:db8:1:1::1')).not.toBe(keyFor('2001:db8:1:2::1'));
  });

  it('does not conflate IPv4 with IPv6', () => {
    expect(keyFor('203.0.113.7')).not.toBe(keyFor('::203.0.113.7'));
  });

  it('salts the hash', () => {
    // Without the salt, `submission_quota` ids would be a rainbow-tableable
    // list of visitor addresses — the reason the hash exists at all.
    const withSalt = createClientIdentity({ originSecret: SECRET, ipSalt: 'a' });
    const withOther = createClientIdentity({ originSecret: SECRET, ipSalt: 'b' });
    const request = fromCloudflare('203.0.113.7');
    expect(withSalt.anonymousKey(request).key).not.toBe(withOther.anonymousKey(request).key);
  });

  it('never returns the address itself', () => {
    expect(keyFor('203.0.113.7')).not.toContain('203.0.113');
  });
});

describe('DECISION 6 — the origin must be verifiably Cloudflare', () => {
  it('refuses a request without the shared secret in production', () => {
    const id = createClientIdentity({ originSecret: SECRET, allowUnverifiedOrigin: false });
    expect(() => id.anonymousKey(makeRequest({ 'cf-connecting-ip': '203.0.113.7' }))).toThrow(
      /unverified origin/i
    );
  });

  it('refuses a request presenting the wrong secret', () => {
    const id = createClientIdentity({ originSecret: SECRET, allowUnverifiedOrigin: false });
    const request = makeRequest({ 'x-hcw-origin-secret': 'wrong', 'cf-connecting-ip': '1.2.3.4' });
    expect(() => id.anonymousKey(request)).toThrow(/unverified origin/i);
  });

  it('refuses when no secret is configured at all', () => {
    // The failure mode this guards against is deploying without
    // CF_ORIGIN_SECRET set and silently getting a decorative limiter.
    const id = createClientIdentity({ originSecret: undefined, allowUnverifiedOrigin: false });
    expect(() => id.anonymousKey(fromCloudflare('203.0.113.7'))).toThrow(/unverified origin/i);
  });

  // An unresolved Key Vault reference reaches process.env as its literal text,
  // which is public in infra/functionapp.tf. As a "secret" anyone could present
  // it (security review of #738, 2026-09-27).
  it('treats an unresolved Key Vault reference as no secret, and refuses a request presenting it', () => {
    const reference =
      '@Microsoft.KeyVault(SecretUri=https://kv-site-prod-cus-01.vault.azure.net/secrets/CF-ORIGIN-SECRET)';
    const id = createClientIdentity({ originSecret: reference, allowUnverifiedOrigin: false });
    const request = makeRequest({ 'x-hcw-origin-secret': reference, 'cf-connecting-ip': '198.51.100.9' });
    expect(id.viaCloudflare(request)).toBe(false);
    expect(() => id.anonymousKey(request)).toThrow(/unverified origin/i);
  });

  it('does not salt with an unresolved Key Vault reference', () => {
    const reference = '@Microsoft.KeyVault(SecretUri=https://kv-site-prod-cus-01.vault.azure.net/secrets/CLIENT-IP-SALT)';
    const withReference = createClientIdentity({ originSecret: SECRET, ipSalt: reference });
    const unsalted = createClientIdentity({ originSecret: SECRET, ipSalt: undefined });
    const request = fromCloudflare('203.0.113.7');
    expect(withReference.anonymousKey(request).key).toBe(unsalted.anonymousKey(request).key);
  });

  it('allows an unverified origin in dev, marked untrusted', () => {
    const id = createClientIdentity({ originSecret: SECRET, allowUnverifiedOrigin: true });
    const result = id.anonymousKey(makeRequest({ 'cf-connecting-ip': '203.0.113.7' }));
    expect(result.trusted).toBe(false);
    expect(result.key).toBeTruthy();
  });
});

describe('rateLimitKey', () => {
  it('returns null for an authenticated user — no anonymous limit applies', () => {
    const id = identity();
    expect(id.rateLimitKey(fromCloudflare('203.0.113.7'), { oid: 'u1' })).toBeNull();
    expect(id.rateLimitKey(fromCloudflare('203.0.113.7'), { sub: 'u2' })).toBeNull();
  });

  it('falls back to the hashed address for an anonymous caller', () => {
    const id = identity();
    expect(id.rateLimitKey(fromCloudflare('203.0.113.7'), null)).toBe(keyFor('203.0.113.7'));
    expect(id.rateLimitKey(fromCloudflare('203.0.113.7'), {})).toBe(keyFor('203.0.113.7'));
  });
});

describe('trustedClientIp', () => {
  // The public lab submission sends this to Turnstile's siteverify as
  // remoteip. Only an address Cloudflare vouched for may go: without the
  // origin secret, CF-Connecting-IP is whatever the caller typed.
  it('returns the address when the request came through Cloudflare', () => {
    expect(identity().trustedClientIp(fromCloudflare('203.0.113.7'))).toBe('203.0.113.7');
    expect(identity().trustedClientIp(fromCloudflare(' 2001:db8::1 '))).toBe('2001:db8::1');
  });

  it('returns null without the origin secret, whatever the header says', () => {
    const spoofed = makeRequest({ 'cf-connecting-ip': '203.0.113.7' });
    expect(identity().trustedClientIp(spoofed)).toBeNull();
    const wrong = makeRequest({ 'x-hcw-origin-secret': 'guess', 'cf-connecting-ip': '203.0.113.7' });
    expect(identity().trustedClientIp(wrong)).toBeNull();
  });

  it('returns null in dev too, where the origin is unverified by design', () => {
    const id = createClientIdentity({ originSecret: SECRET, allowUnverifiedOrigin: true });
    expect(id.trustedClientIp(makeRequest({ 'cf-connecting-ip': '203.0.113.7' }))).toBeNull();
  });

  it('returns null for a header that is not an address', () => {
    expect(identity().trustedClientIp(fromCloudflare('not-an-ip'))).toBeNull();
    expect(identity().trustedClientIp(fromCloudflare(''))).toBeNull();
  });
});

describe('the refusal anonymousKey throws (#1387)', () => {
  it('carries a code, so a caller can answer it and let a bug through', () => {
    let error;
    try {
      createClientIdentity({ originSecret: SECRET, allowUnverifiedOrigin: false }).anonymousKey(makeRequest({}));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(ORIGIN_NOT_VERIFIED);
    expect(ORIGIN_NOT_VERIFIED).toBe('ORIGIN_NOT_VERIFIED');
  });
});

describe('assertClientIdentity (#1387)', () => {
  it('accepts the real helper', () => {
    expect(() => assertClientIdentity(createClientIdentity({ originSecret: SECRET }))).not.toThrow();
  });

  it('refuses an object with only the method the visitor sessions used to ask for', () => {
    const standIn = { fromRequest: () => ({ anonymousKey: () => 'k' }) };
    expect(() => assertClientIdentity(standIn)).toThrow(TypeError);
    expect(() => assertClientIdentity(standIn)).toThrow(/anonymousKey or trustedClientIp/);
  });

  it('names only the methods that are missing, and no value', () => {
    expect(() => assertClientIdentity({ anonymousKey: () => ({ key: 'secret-value' }) })).toThrow(/has no trustedClientIp method/);
    let message;
    try {
      assertClientIdentity({ anonymousKey: 'secret-value' });
    } catch (error) {
      message = error.message;
    }
    expect(message).toMatch(/anonymousKey or trustedClientIp/);
    expect(message).not.toContain('secret-value');
  });

  it('refuses nothing at all, null and undefined', () => {
    expect(() => assertClientIdentity(undefined)).toThrow(TypeError);
    expect(() => assertClientIdentity(null)).toThrow(TypeError);
  });

  it('checks the methods it is told to', () => {
    expect(() => assertClientIdentity({ viaCloudflare: () => true }, ['viaCloudflare'])).not.toThrow();
    expect(() => assertClientIdentity({}, ['viaCloudflare'])).toThrow(/viaCloudflare/);
  });
});
