import { describe, expect, it } from 'vitest';

import { createCors } from './cors.js';
import { createClientIdentity } from './client-identity.js';

describe('CORS allowlist', () => {
  const prod = createCors({ environment: 'production' });
  const dev = createCors({ environment: 'development' });

  it('allows the production origins', () => {
    for (const o of ['https://hybridcloudworks.com', 'https://www.hybridcloudworks.com']) {
      expect(prod.isAllowed(o)).toBe(true);
    }
  });

  it('does NOT allow localhost in production', () => {
    // Site-Main allowlists localhost unconditionally. In production that lets
    // any page on a victim's own machine call the API with their token.
    expect(prod.isAllowed('http://localhost:5173')).toBe(false);
    expect(prod.isAllowed('http://127.0.0.1:4173')).toBe(false);
  });

  it('allows localhost on ANY port outside production', () => {
    // The Terraform hardcoded 5173/4173, which is narrower than the source and
    // silently breaks a developer on a different port.
    for (const o of ['http://localhost:5173', 'http://localhost:4173', 'http://localhost:9999', 'http://127.0.0.1:3000']) {
      expect(dev.isAllowed(o)).toBe(true);
    }
  });

  it('rejects lookalike origins', () => {
    for (const o of [
      'https://hybridcloudworks.com.evil.test',
      'https://evilhybridcloudworks.com',
      'http://hybridcloudworks.com', // scheme matters
      'https://sub.hybridcloudworks.com',
    ]) {
      expect(prod.isAllowed(o)).toBe(false);
    }
  });

  it('rejects a localhost lookalike even in dev', () => {
    expect(dev.isAllowed('http://localhost.evil.test')).toBe(false);
    expect(dev.isAllowed('https://notlocalhost:5173')).toBe(false);
  });
});

describe('CORS evaluation', () => {
  const cors = createCors({ environment: 'production' });
  const req = (headers, method = 'POST') => ({
    method,
    headers: { get: (n) => headers[n.toLowerCase()] ?? null },
  });

  // Without this the 401 reason from #517 is set by the API and unreadable by
  // the SPA: WWW-Authenticate is not CORS-safelisted, so a cross-origin caller
  // gets null from res.headers.get() unless the server names it here.
  it('exposes WWW-Authenticate, so the browser can read why a 401 happened', () => {
    const r = cors.evaluate(req({ origin: 'https://hybridcloudworks.com' }));
    expect(r.headers['Access-Control-Expose-Headers']).toContain('WWW-Authenticate');
  });

  it('exposes it on the actual response, not only the preflight', () => {
    const actual = cors.evaluate(req({ origin: 'https://hybridcloudworks.com' }, 'GET'));
    expect(actual.preflight).toBe(false);
    expect(actual.headers['Access-Control-Expose-Headers']).toContain('WWW-Authenticate');
  });

  it('allows a request with no Origin — CORS is not an authorization control', () => {
    const r = cors.evaluate(req({}));
    expect(r.allowed).toBe(true);
    expect(r.response).toBeUndefined();
  });

  it('returns 403 for a disallowed origin rather than omitting the header', () => {
    const r = cors.evaluate(req({ origin: 'https://evil.test' }));
    expect(r.allowed).toBe(false);
    expect(r.response.status).toBe(403);
    expect(JSON.parse(r.response.body)).toEqual({ ok: false, error: 'Origin not allowed' });
  });

  it('echoes the allowed origin and sets Vary', () => {
    const r = cors.evaluate(req({ origin: 'https://hybridcloudworks.com' }));
    expect(r.headers['Access-Control-Allow-Origin']).toBe('https://hybridcloudworks.com');
    expect(r.headers.Vary).toBe('Origin');
  });

  it('answers a preflight with 204', () => {
    const r = cors.evaluate(req({ origin: 'https://hybridcloudworks.com' }, 'OPTIONS'));
    expect(r.preflight).toBe(true);
    expect(r.response.status).toBe(204);
  });

  it('does not send credentials headers — this is a bearer-token API', () => {
    const r = cors.evaluate(req({ origin: 'https://hybridcloudworks.com' }));
    expect(r.headers['Access-Control-Allow-Credentials']).toBeUndefined();
  });
});

describe('anonymous caller identity', () => {
  const req = (headers) => ({ headers: { get: (n) => headers[n.toLowerCase()] ?? null } });
  const SECRET = 'shared-secret';

  it('refuses to produce a key when the origin is unverified in production', () => {
    // Rate limiting on a spoofable header is not rate limiting.
    const id = createClientIdentity({ originSecret: SECRET, allowUnverifiedOrigin: false });
    expect(() => id.anonymousKey(req({ 'cf-connecting-ip': '1.2.3.4' }))).toThrow(/unverified origin/);
  });

  it('produces a key when the Cloudflare shared secret is present', () => {
    const id = createClientIdentity({ originSecret: SECRET, allowUnverifiedOrigin: false, ipSalt: 's' });
    const { key, trusted } = id.anonymousKey(
      req({ 'cf-connecting-ip': '1.2.3.4', 'x-hcw-origin-secret': SECRET })
    );
    expect(trusted).toBe(true);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });

  it('never returns the raw address', () => {
    const id = createClientIdentity({ originSecret: SECRET, allowUnverifiedOrigin: false, ipSalt: 's' });
    const { key } = id.anonymousKey(req({ 'cf-connecting-ip': '1.2.3.4', 'x-hcw-origin-secret': SECRET }));
    expect(key).not.toContain('1.2.3.4');
  });

  it('salts the hash so the quota container is not a rainbow-tableable IP list', () => {
    const mk = (salt) =>
      createClientIdentity({ originSecret: SECRET, allowUnverifiedOrigin: false, ipSalt: salt }).anonymousKey(
        req({ 'cf-connecting-ip': '1.2.3.4', 'x-hcw-origin-secret': SECRET })
      ).key;
    expect(mk('salt-a')).not.toBe(mk('salt-b'));
  });

  it('ignores X-Forwarded-For, which is client-spoofable', () => {
    const id = createClientIdentity({ originSecret: SECRET, allowUnverifiedOrigin: false, ipSalt: 's' });
    const withXff = id.anonymousKey(
      req({ 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '9.9.9.9', 'x-hcw-origin-secret': SECRET })
    ).key;
    const without = id.anonymousKey(
      req({ 'cf-connecting-ip': '1.2.3.4', 'x-hcw-origin-secret': SECRET })
    ).key;
    expect(withXff).toBe(without);
  });

  it('applies no anonymous limit to an authenticated caller', () => {
    // Site-Main only rate-limits when there is no user.
    const id = createClientIdentity({ originSecret: SECRET, allowUnverifiedOrigin: false });
    expect(id.rateLimitKey(req({}), { oid: 'abc' })).toBeNull();
  });

  it('rate-limits an authenticated-looking caller with no oid or sub', () => {
    const id = createClientIdentity({ originSecret: SECRET, allowUnverifiedOrigin: false, ipSalt: 's' });
    const key = id.rateLimitKey(
      req({ 'cf-connecting-ip': '1.2.3.4', 'x-hcw-origin-secret': SECRET }),
      { name: 'no id claims' }
    );
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('the Static Web App origin — retained as the break-glass path (#521)', () => {
  // Added for Migration-Plan §6 step 2, which served the site from the SWA's own
  // hostname before DNS moved. It outlived that: `deploy-azure-frontend.yml`
  // documents the production break-glass as re-pointing the custom domain, and
  // that lands here — so removing the origin would take the admin portal out of
  // the only documented recovery path, discovered during the incident (#521).
  //
  // Compiled in rather than supplied through an app setting: the setting,
  // then named CORS_ALLOWED_ORIGINS, did not take effect on the deployed app
  // (T-513). These tests are the
  // reason a security control belongs in code: an app setting has none.
  it('is allowed by default, with no environment configuration at all', () => {
    const cors = createCors({});
    expect(cors.isAllowed('https://calm-ground-0d0e6a010.7.azurestaticapps.net')).toBe(true);
  });

  it('can be disabled in production unless allowPreview is true', () => {
    const prodNoPreview = createCors({ environment: 'production', allowPreview: false });
    expect(prodNoPreview.isAllowed('https://calm-ground-0d0e6a010.7.azurestaticapps.net')).toBe(false);

    const prodWithPreview = createCors({ environment: 'production', allowPreview: true });
    expect(prodWithPreview.isAllowed('https://calm-ground-0d0e6a010.7.azurestaticapps.net')).toBe(true);
  });

  it('does not open azurestaticapps.net generally', () => {
    const cors = createCors({});
    expect(cors.isAllowed('https://someone-elses-app.azurestaticapps.net')).toBe(false);
    expect(cors.isAllowed('https://calm-ground-0d0e6a010.7.azurestaticapps.net.evil.com')).toBe(false);
  });

  it('still refuses an unrelated origin', () => {
    expect(createCors({}).isAllowed('https://evil.example.com')).toBe(false);
  });
});
