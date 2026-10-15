/**
 * The two things about this config that must never silently change (#516).
 *
 * `msalConfig.js` is the whole of the SPA's identity configuration and none of
 * it was pinned. The authority in particular defaulted to `common` when the
 * tenant variable was empty, which is a value that *works* — it authenticates
 * anyone in any Microsoft directory — and then fails on every API call. A test
 * is the only thing that distinguishes "configured" from "configured wrongly
 * but plausibly" here.
 *
 * Env is stubbed rather than read, and modules are reset between cases, because
 * `msalConfig` reads `import.meta.env` once at module scope.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TENANT = '1a2fce27-b5f6-43c7-a86e-cf0bb74d4672';
const CLIENT = 'ac696e96-e203-47be-ade8-c35ece8a6c4a';

async function loadConfig(env) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return import('./msalConfig.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('the authority', () => {
  it('is the configured tenant when one is set', async () => {
    const { msalConfig } = await loadConfig({
      VITE_ENTRA_TENANT_ID: TENANT,
      VITE_ENTRA_CLIENT_ID: CLIENT,
    });
    expect(msalConfig.auth.authority).toBe(`https://login.microsoftonline.com/${TENANT}`);
  });

  // The regression this file exists for. `common` accepts a sign-in from every
  // Entra tenant and every personal Microsoft account; `organizations` and
  // `consumers` are the same mistake wearing different hats.
  it.each(['common', 'organizations', 'consumers'])(
    'never falls back to %s when the tenant is missing',
    async (multiTenant) => {
      const { msalConfig } = await loadConfig({
        VITE_ENTRA_TENANT_ID: '',
        VITE_ENTRA_CLIENT_ID: CLIENT,
      });
      expect(msalConfig.auth.authority).not.toContain(multiTenant);
    }
  );

  it('resolves to an authority that cannot authenticate anyone when unset', async () => {
    const { msalConfig } = await loadConfig({
      VITE_ENTRA_TENANT_ID: '',
      VITE_ENTRA_CLIENT_ID: CLIENT,
    });
    // A GUID that is not a tenant: MSAL fails at authority resolution, which
    // surfaces as the sign-in card rather than as a signed-in-but-broken app.
    expect(msalConfig.auth.authority).toBe(
      'https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000'
    );
  });
});

describe('the API token request', () => {
  it('asks for the configured scope, and nothing else', async () => {
    const scope = `api://${CLIENT}/access_as_admin`;
    const { apiTokenRequest } = await loadConfig({
      VITE_ENTRA_TENANT_ID: TENANT,
      VITE_ENTRA_CLIENT_ID: CLIENT,
      VITE_ENTRA_API_SCOPE: scope,
    });
    // The scope is what puts `access_as_admin` in the token's `scp` claim, and
    // since #515 the API rejects a token without it.
    expect(apiTokenRequest.scopes).toEqual([scope]);
  });
});

describe('the redirect path', () => {
  // THE DRIFT THIS CATCHES BREAKS SIGN-IN IN PRODUCTION AND NOWHERE ELSE.
  //
  // Entra redirects to `redirectUri`. If the router does not declare that path,
  // the SPA serves its 404 with the authorization code still in the fragment
  // and nothing consumes it — which is precisely the 2026-08-23 failure, in a
  // new costume. No test that renders a component would notice, because no
  // component is involved: it is an agreement between a config string and a
  // route table.
  it('is a route App.jsx actually declares, from the same constant', async () => {
    const app = readFileSync(join(process.cwd(), 'src', 'App.jsx'), 'utf8');

    // The literal would also work and is what this file used to assert. The
    // constant is stronger: a second spelling cannot appear, because there is
    // only one string and both sides import it from authRoutes.js.
    expect(app).toContain('path={AUTH_REDIRECT_PATH}');
    expect(app).toContain("from '@/lib/authRoutes'");
  });

  it('is what redirectUri points at, not a second copy of the string', async () => {
    const { msalConfig } = await loadConfig({
      VITE_ENTRA_TENANT_ID: TENANT,
      VITE_ENTRA_CLIENT_ID: CLIENT,
    });
    const { AUTH_REDIRECT_PATH } = await import('./authRoutes.js');

    expect(msalConfig.auth.redirectUri.endsWith(AUTH_REDIRECT_PATH)).toBe(true);
    // An absolute URI, because Entra matches the registered value exactly.
    expect(msalConfig.auth.redirectUri).toMatch(/^https?:\/\//);
  });

  // The bare origin is what sent the fragment to the public home page and
  // forced an admin-only hook onto every route in the application.
  it('is not the bare origin', async () => {
    const { msalConfig } = await loadConfig({
      VITE_ENTRA_TENANT_ID: TENANT,
      VITE_ENTRA_CLIENT_ID: CLIENT,
    });
    expect(msalConfig.auth.redirectUri).not.toBe(window.location.origin);
  });
});

describe('the token cache', () => {
  // AP-F11 (#935). sessionStorage, so a DOM XSS or a compromised dependency
  // cannot read a token pair that outlives the tab; the reasoning, the known
  // risk and the rollback sit on the setting itself. Pinned because
  // `localStorage` is the value every MSAL tutorial pastes and the one this
  // file held until #935, and nothing but a test distinguishes the two.
  it('lives in sessionStorage and in no cookie', async () => {
    const { msalConfig } = await loadConfig({
      VITE_ENTRA_TENANT_ID: TENANT,
      VITE_ENTRA_CLIENT_ID: CLIENT,
    });
    expect(msalConfig.cache).toEqual({
      cacheLocation: 'sessionStorage',
      storeAuthStateInCookie: false,
    });
  });
});
