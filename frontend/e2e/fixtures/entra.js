import { test as base, expect } from '@playwright/test';
import { STUB_BUILD_ENV } from './stub-build-env.js';

/**
 * A credential-free identity for the admin browser journey (QA-1, AP-F1).
 *
 * WHAT IT STUBS, AND WHAT IT DOES NOT. The application is the production bundle
 * built with the placeholder configuration in stub-build-env.js. Nothing in it
 * knows it is under test: there is no bypass flag, no injected user and no
 * pre-seeded token cache. A test clicks "Sign in with Microsoft" and the real
 * MSAL code runs the real authorization-code + PKCE redirect flow. What this
 * fixture replaces is the far end of the two network boundaries that flow
 * crosses:
 *
 *   1. login.microsoftonline.com. `page.route()` answers the OpenID metadata,
 *      instance discovery, `/authorize` (a 302 back to the app's redirect URI
 *      with a code and the state MSAL sent) and `/token` (an id token carrying
 *      the nonce MSAL sent, an access token, a refresh token and client_info).
 *      MSAL checks the state and the nonce, so a stub that ignored them would
 *      fail the sign-in, which is the point: the flow is exercised, not
 *      skipped.
 *   2. The API (`/api/...`, same origin). `getCurrentAdminStatus` answers what
 *      the test asks for: a registry record, a refusal, or a 401 carrying the
 *      RFC 6750 `WWW-Authenticate` code the real API sends (require-role.js).
 *      Every other route answers an empty, well-formed body so the pages render
 *      their empty states.
 *
 * Tokens are unsigned. The browser never verifies a signature (the API does),
 * and the API here is this fixture, so nothing is weakened by that.
 *
 * Every request either boundary sees is recorded, so a test can assert on the
 * journey itself: how many times the browser went to `/authorize`, with which
 * `prompt`, and which bearer the API received.
 */

const LOGIN_HOST = 'https://login.microsoftonline.com';

/** Static font hosts, answered locally (see `install`). */
const FONT_HOSTS = new Set(['https://fonts.googleapis.com', 'https://fonts.gstatic.com']);

/** The signed-in person. `example.test` is a reserved name (RFC 6761). */
export const STUB_USER = Object.freeze({
  oid: '0e2e0000-0000-4000-8000-0000000000a1',
  name: 'E2E Admin',
  email: 'e2e.admin@example.test',
});

/** A registry record for an admin, in the shape getCurrentAdminStatus returns. */
export const ADMIN_STATUS = Object.freeze({
  isAdmin: true,
  role: 'super_admin',
  permissions: [],
  canBootstrap: false,
  email: STUB_USER.email,
});

const b64url = (value) =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

/** An unsigned JWT: header, claims, and a signature nobody checks. */
function jwt(claims) {
  return `${b64url({ alg: 'RS256', typ: 'JWT', kid: 'e2e' })}.${b64url(claims)}.${b64url('e2e')}`;
}

/** CORS for a cross-origin answer from the identity host. */
function corsHeaders(request) {
  const headers = request.headers();
  return {
    'access-control-allow-origin': headers.origin || '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': headers['access-control-request-headers'] || '*',
    'access-control-max-age': '600',
  };
}

const json = (body, { status = 200, headers = {} } = {}) => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

/**
 * The answers a test can give to getCurrentAdminStatus, each the exact shape
 * the API produces (functions/src/lib/auth/require-role.js `deny`).
 */
export const STATUS_ANSWERS = Object.freeze({
  /** A registry record: the portal opens. */
  admin: () => json(ADMIN_STATUS),
  /** The registry was read and the caller is not in it. */
  notAdmin: () => json({ isAdmin: false, role: null, permissions: [], canBootstrap: false }),
  /** The token verified and lacks the delegated scope. Signing in again cannot help. */
  insufficientScope: () =>
    json(
      { ok: false, error: 'Authentication required' },
      {
        status: 401,
        headers: {
          'www-authenticate':
            'Bearer realm="", error="insufficient_scope", error_description="The access token is missing the access_as_admin scope."',
        },
      }
    ),
  /** The token was rejected (expired, say). Signing in again is the fix. */
  invalidToken: () =>
    json(
      { ok: false, error: 'Authentication required' },
      {
        status: 401,
        headers: {
          'www-authenticate':
            'Bearer realm="", error="invalid_token", error_description="The access token could not be verified."',
        },
      }
    ),
});

export class IdentityStub {
  constructor(page, baseURL) {
    this.page = page;
    this.origin = new URL(baseURL).origin;
    /** Every `/authorize` navigation, as its query parameters. */
    this.authorizeRequests = [];
    /** Every `/token` POST, as its form parameters. */
    this.tokenRequests = [];
    /** Every getCurrentAdminStatus call, with the bearer it carried. */
    this.statusRequests = [];
    /**
     * Requests nothing here expected: an identity-host path the stub does not
     * model, a tenant or client that is not the placeholder, or anything
     * bound for a third host. A test fails on any.
     */
    this.unexpected = [];
    this.statusAnswer = STATUS_ANSWERS.admin;
    this.apiOverrides = new Map();
    this.codes = new Map();
    this.issued = 0;
  }

  /** Choose what getCurrentAdminStatus answers from now on. */
  answerAdminStatus(answer) {
    this.statusAnswer = answer;
  }

  /** Answer one API route (by its name after `/api/`) with a fixed body. */
  answerApi(name, body) {
    this.apiOverrides.set(name, () => json(body));
  }

  async install() {
    // FAIL CLOSED (review of #985). The two hosts below are the only places
    // this page may talk to. A bundle built with real settings — a local
    // frontend/.env wins over the placeholders in vite.config.js, and a reused
    // server may not be this build at all — would aim the stub's bearer at a
    // real API. That request is aborted here, before it leaves the browser,
    // and the test fails naming it.
    //
    // The one other host the shell asks for is the icon font (index.html's
    // Google Fonts stylesheet). It carries no credential and nothing here
    // asserts on glyphs, so it is answered locally with an empty stylesheet:
    // modelled, never forwarded.
    await this.page.route(
      (url) =>
        /^https?:$/.test(url.protocol) && url.origin !== this.origin && url.origin !== LOGIN_HOST,
      (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (FONT_HOSTS.has(url.origin) && request.method() === 'GET') {
          return url.origin === 'https://fonts.googleapis.com'
            ? route.fulfill({ status: 200, contentType: 'text/css', body: '' })
            : route.fulfill({ status: 404, body: '' });
        }
        this.unexpected.push(`${request.method()} ${request.url()} (third host, aborted)`);
        return route.abort('blockedbyclient');
      }
    );
    await this.page.route(`${LOGIN_HOST}/**`, (route) => this.identityHost(route));
    await this.page.route(
      (url) => url.origin === this.origin && url.pathname.startsWith('/api/'),
      (route) => this.api(route)
    );
  }

  async identityHost(route) {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: corsHeaders(request) });
    }
    const [tenant] = url.pathname.split('/').filter(Boolean);
    // Only the placeholder directory and application. A bundle carrying a real
    // tenant or client id was not built for this suite (a local .env, a reused
    // server), and its journey is not the one under test.
    const isDiscovery = url.pathname.endsWith('/discovery/instance');
    const clientId =
      url.searchParams.get('client_id') ??
      new URLSearchParams(request.postData() || '').get('client_id');
    if (
      (!isDiscovery && tenant !== STUB_BUILD_ENV.VITE_ENTRA_TENANT_ID) ||
      (clientId !== null && clientId !== STUB_BUILD_ENV.VITE_ENTRA_CLIENT_ID)
    ) {
      this.unexpected.push(
        `${request.method()} ${url.pathname} (tenant ${tenant}, client ${clientId}: not the placeholder build)`
      );
      return route.fulfill({ status: 400, headers: corsHeaders(request), body: '' });
    }
    const issuer = `${LOGIN_HOST}/${tenant}/v2.0`;
    const endpoint = (name) => `${LOGIN_HOST}/${tenant}/oauth2/v2.0/${name}`;

    if (url.pathname.endsWith('/.well-known/openid-configuration')) {
      return route.fulfill({
        ...json({
          issuer,
          authorization_endpoint: endpoint('authorize'),
          token_endpoint: endpoint('token'),
          end_session_endpoint: endpoint('logout'),
          jwks_uri: `${LOGIN_HOST}/${tenant}/discovery/v2.0/keys`,
          response_modes_supported: ['query', 'fragment', 'form_post'],
          response_types_supported: ['code', 'id_token', 'code id_token', 'id_token token'],
          scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
          token_endpoint_auth_methods_supported: ['none'],
        }),
        headers: { 'content-type': 'application/json', ...corsHeaders(request) },
      });
    }

    if (url.pathname.endsWith('/discovery/instance')) {
      return route.fulfill({
        ...json({
          tenant_discovery_endpoint: `${issuer}/.well-known/openid-configuration`,
          'api-version': '1.1',
          metadata: [
            {
              preferred_network: 'login.microsoftonline.com',
              preferred_cache: 'login.windows.net',
              aliases: ['login.microsoftonline.com', 'login.windows.net', 'login.microsoft.com'],
            },
          ],
        }),
        headers: { 'content-type': 'application/json', ...corsHeaders(request) },
      });
    }

    if (url.pathname.endsWith('/oauth2/v2.0/authorize')) {
      const params = Object.fromEntries(url.searchParams);
      this.authorizeRequests.push(params);
      const code = `e2e-code-${this.authorizeRequests.length}`;
      this.codes.set(code, { nonce: params.nonce, tenant });
      const answer = new URLSearchParams({
        code,
        client_info: b64url({ uid: STUB_USER.oid, utid: tenant }),
        state: params.state,
        session_state: 'e2e-session',
      });
      const separator = params.response_mode === 'query' ? '?' : '#';
      return route.fulfill({
        status: 302,
        headers: { location: `${params.redirect_uri}${separator}${answer}` },
      });
    }

    if (url.pathname.endsWith('/oauth2/v2.0/token')) {
      const form = Object.fromEntries(new URLSearchParams(request.postData() || ''));
      this.tokenRequests.push(form);
      const issuedFor = this.codes.get(form.code) ?? this.lastCode ?? { tenant };
      if (form.code) this.lastCode = issuedFor;
      this.issued += 1;
      const now = Math.floor(Date.now() / 1000);
      const common = {
        iss: issuer,
        tid: issuedFor.tenant,
        oid: STUB_USER.oid,
        sub: STUB_USER.oid,
        iat: now,
        nbf: now,
        exp: now + 3600,
      };
      const scopes = (form.scope || '')
        .split(' ')
        .filter((scope) => scope && scope !== 'offline_access');
      return route.fulfill({
        ...json({
          token_type: 'Bearer',
          scope: scopes.join(' '),
          expires_in: 3600,
          ext_expires_in: 3600,
          access_token: jwt({
            ...common,
            aud: 'api://e2e-hcw-api',
            scp: 'access_as_admin',
            ver: '2.0',
            n: this.issued,
          }),
          refresh_token: `e2e-refresh-${this.issued}`,
          id_token: jwt({
            ...common,
            aud: form.client_id,
            name: STUB_USER.name,
            preferred_username: STUB_USER.email,
            ver: '2.0',
            ...(issuedFor.nonce ? { nonce: issuedFor.nonce } : {}),
          }),
          client_info: b64url({ uid: STUB_USER.oid, utid: issuedFor.tenant }),
        }),
        headers: { 'content-type': 'application/json', ...corsHeaders(request) },
      });
    }

    this.unexpected.push(`${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 404, headers: corsHeaders(request), body: '' });
  }

  async api(route) {
    const request = route.request();
    const name = new URL(request.url()).pathname.replace(/^\/api\//, '');
    if (name === 'getCurrentAdminStatus') {
      this.statusRequests.push({ authorization: request.headers().authorization || null });
      return route.fulfill(this.statusAnswer());
    }
    // Every other route: an empty, well-formed body, so a page renders its
    // empty state. The fixture fails the test on an uncaught page error, so a
    // page that cannot survive an empty answer shows up rather than hides.
    const answer = this.apiOverrides.get(name);
    return route.fulfill(answer ? answer() : json({}));
  }

  /**
   * Sign in the way a person does: open a route, press the button, come back.
   * Resolves once the browser is back on `route` with the fragment gone.
   */
  async signIn(route) {
    await this.page.goto(route);
    await this.page.getByRole('button', { name: /sign in with microsoft/i }).click();
    await this.page.waitForURL((url) => url.pathname === route && !url.hash);
  }
}

/**
 * `identity`: the stub, installed before the test's first navigation.
 *
 * The test fails if the page threw, if the identity host was asked for
 * something the stub does not model or for a real tenant, or if the page tried
 * a third host — any of them means the journey under test
 * was not the one that ran.
 */
export const test = base.extend({
  identity: async ({ page, baseURL }, provide) => {
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const stub = new IdentityStub(page, baseURL);
    await stub.install();
    await provide(stub);
    expect(stub.unexpected, 'requests outside the stubbed placeholder build').toEqual([]);
    expect(pageErrors, 'uncaught errors in the page').toEqual([]);
  },
});

export { expect };
