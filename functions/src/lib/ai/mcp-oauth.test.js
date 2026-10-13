/**
 * The MCP OAuth Connect protocol (mcp-oauth.js), against fixtures shaped
 * exactly like the documents Replicate and Hostinger published on
 * 2026-10-08: Replicate's 401 names no resource_metadata and its metadata
 * lives at the origin; Hostinger's 401 names its resource_metadata, its
 * authorization server is another host, and it lists one scope.
 *
 * Every request goes through the real guardedFetch over a fake fetch, so the
 * https-only and no-redirect rules are the production ones.
 */
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  MCP_OAUTH_REDIRECT_URI,
  McpOAuthError,
  PENDING_TTL_MS,
  authorizationServerMetadataUrls,
  buildAuthorizationUrl,
  chooseTokenEndpointAuthMethod,
  codeChallengeS256,
  connectedUpdates,
  createCodeVerifier,
  createOAuthHttp,
  discoverOAuth,
  exchangeAuthorizationCode,
  hashState,
  oauthConnectionState,
  parseTokenResponse,
  protectedResourceMetadataUrls,
  refreshOAuthToken,
  registrationRequestBody,
  resourceMetadataFromChallenge,
  reusableClient,
  revokeOAuthGrant,
  sameIssuer,
  startOAuthConnect,
  tokenExpiresWithin,
  tokenRequest,
} from './mcp-oauth.js';

const PUBLIC = '93.184.216.34';
const resolve = async () => ({ address: PUBLIC });
const pin = () => ({ close: async () => {} });
const NOW = new Date('2026-10-08T12:00:00.000Z');
const now = () => NOW;

const reply = (status, body = '', headers = {}) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  };
};

/** A fake internet: `routes` maps "METHOD url" (or a bare url) to a reply or a function. */
function network(routes) {
  const calls = [];
  const fetch = vi.fn(async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, headers: init.headers || {}, body: init.body });
    const handler = routes[`${method} ${url}`] ?? routes[url];
    if (!handler) return reply(404, { error: 'not_found' });
    return typeof handler === 'function' ? handler(init, calls) : handler;
  });
  return { fetch, calls, http: createOAuthHttp({ fetch, resolve, dispatcherFor: pin }) };
}

// ─── Replicate, as published ────────────────────────────────────────────────
const REPLICATE_URL = 'https://mcp.replicate.com/sse';
const REPLICATE_PRM = {
  resource: 'https://mcp.replicate.com/',
  authorization_servers: ['https://mcp.replicate.com/'],
};
const REPLICATE_AS = {
  // Without the trailing slash its resource metadata gives (measured 2026-10-08).
  issuer: 'https://mcp.replicate.com',
  authorization_endpoint: 'https://mcp.replicate.com/authorize',
  token_endpoint: 'https://mcp.replicate.com/token',
  registration_endpoint: 'https://mcp.replicate.com/register',
  code_challenge_methods_supported: ['plain', 'S256'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
};
const replicateRoutes = (over = {}) => ({
  'POST https://mcp.replicate.com/sse': reply(401, '', {
    'www-authenticate': 'Bearer realm="OAuth", error="invalid_token"',
  }),
  'GET https://mcp.replicate.com/.well-known/oauth-protected-resource': reply(200, REPLICATE_PRM),
  'GET https://mcp.replicate.com/.well-known/oauth-authorization-server': reply(200, REPLICATE_AS),
  'POST https://mcp.replicate.com/register': reply(201, {
    client_id: 'rep-client-1',
    token_endpoint_auth_method: 'none',
  }),
  ...over,
});

// ─── Hostinger, as published ────────────────────────────────────────────────
const HOSTINGER_URL = 'https://mcp.hostinger.com';
const HOSTINGER_CHALLENGE =
  'Bearer realm="mcp", resource_metadata="https://mcp.hostinger.com/.well-known/oauth-protected-resource"';
const HOSTINGER_PRM = {
  resource: 'https://mcp.hostinger.com',
  authorization_servers: ['https://auth.hostinger.com'],
  bearer_methods_supported: ['header'],
  scopes_supported: ['mcp:use'],
};
const HOSTINGER_OAUTH = 'https://auth.hostinger.com/api/external/v1/oauth-server';
const HOSTINGER_AS = {
  issuer: 'https://auth.hostinger.com',
  authorization_endpoint: `${HOSTINGER_OAUTH}/authorize`,
  token_endpoint: `${HOSTINGER_OAUTH}/token`,
  registration_endpoint: `${HOSTINGER_OAUTH}/register`,
  code_challenge_methods_supported: ['S256'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  token_endpoint_auth_methods_supported: ['none'],
  scopes_supported: [],
};
const hostingerRoutes = (over = {}) => ({
  'POST https://mcp.hostinger.com/': reply(401, '', { 'www-authenticate': HOSTINGER_CHALLENGE }),
  'GET https://mcp.hostinger.com/.well-known/oauth-protected-resource': reply(200, HOSTINGER_PRM),
  'GET https://auth.hostinger.com/.well-known/oauth-authorization-server': reply(200, HOSTINGER_AS),
  [`POST ${HOSTINGER_OAUTH}/register`]: reply(201, { client_id: 'hst-client-1' }),
  ...over,
});

const replicateServer = (over = {}) => ({
  id: 'replicate-mcp',
  name: 'Replicate MCP',
  url: REPLICATE_URL,
  transport: 'sse',
  authType: 'oauth',
  ...over,
});
const hostingerServer = (over = {}) => ({
  id: 'hostinger-mcp',
  name: 'Hostinger MCP',
  url: HOSTINGER_URL,
  transport: 'http',
  authType: 'oauth',
  ...over,
});

// Deterministic but distinct per call, so the state and the verifier differ.
let seed = 0;
const fixedRandom = (n) => Buffer.alloc(n, (seed += 1));

describe('discovery (RFC 9728 → RFC 8414)', () => {
  it('reads resource_metadata from a 401 challenge, and nothing from one without it', () => {
    expect(resourceMetadataFromChallenge(HOSTINGER_CHALLENGE)).toBe(
      'https://mcp.hostinger.com/.well-known/oauth-protected-resource'
    );
    expect(resourceMetadataFromChallenge('Bearer realm="OAuth", error="invalid_token"')).toBeNull();
    expect(resourceMetadataFromChallenge(undefined)).toBeNull();
  });

  it('looks in the challenge first, then path-appended, then at the origin', () => {
    expect(protectedResourceMetadataUrls(REPLICATE_URL)).toEqual([
      'https://mcp.replicate.com/.well-known/oauth-protected-resource/sse',
      'https://mcp.replicate.com/.well-known/oauth-protected-resource',
    ]);
    expect(
      protectedResourceMetadataUrls('https://mcp.hostinger.com/', 'https://mcp.hostinger.com/meta.json')
    ).toEqual([
      'https://mcp.hostinger.com/meta.json',
      'https://mcp.hostinger.com/.well-known/oauth-protected-resource',
    ]);
    // A non-https hint is ignored rather than fetched.
    expect(protectedResourceMetadataUrls('https://a.example/', 'http://a.example/meta')).toEqual([
      'https://a.example/.well-known/oauth-protected-resource',
    ]);
    expect(authorizationServerMetadataUrls('https://auth.hostinger.com')).toEqual([
      'https://auth.hostinger.com/.well-known/oauth-authorization-server',
      'https://auth.hostinger.com/.well-known/openid-configuration',
    ]);
    expect(authorizationServerMetadataUrls('https://login.example/tenant/v2')).toEqual([
      'https://login.example/.well-known/oauth-authorization-server/tenant/v2',
      'https://login.example/.well-known/openid-configuration/tenant/v2',
      'https://login.example/tenant/v2/.well-known/openid-configuration',
    ]);
  });

  it('discovers Replicate: path-appended metadata absent, origin metadata used, no scope', async () => {
    const net = network(replicateRoutes());
    const found = await discoverOAuth({ serverUrl: REPLICATE_URL, http: net.http, name: 'Replicate MCP' });
    expect(found).toMatchObject({
      issuer: 'https://mcp.replicate.com',
      authorizationEndpoint: 'https://mcp.replicate.com/authorize',
      tokenEndpoint: 'https://mcp.replicate.com/token',
      registrationEndpoint: 'https://mcp.replicate.com/register',
      resource: 'https://mcp.replicate.com/',
      scope: '',
    });
    expect(net.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET https://mcp.replicate.com/.well-known/oauth-protected-resource/sse',
      'GET https://mcp.replicate.com/.well-known/oauth-protected-resource',
      'GET https://mcp.replicate.com/.well-known/oauth-authorization-server',
    ]);
  });

  it('discovers Hostinger from the challenge, on another host, with its one scope', async () => {
    const net = network(hostingerRoutes());
    const found = await discoverOAuth({
      serverUrl: 'https://mcp.hostinger.com/',
      challenge: HOSTINGER_CHALLENGE,
      http: net.http,
      name: 'Hostinger MCP',
    });
    expect(found).toMatchObject({
      issuer: 'https://auth.hostinger.com',
      authorizationEndpoint: `${HOSTINGER_OAUTH}/authorize`,
      tokenEndpoint: `${HOSTINGER_OAUTH}/token`,
      registrationEndpoint: `${HOSTINGER_OAUTH}/register`,
      resource: 'https://mcp.hostinger.com',
      scope: 'mcp:use',
      tokenEndpointAuthMethods: ['none'],
    });
    expect(net.calls[0].url).toBe('https://mcp.hostinger.com/.well-known/oauth-protected-resource');
  });

  it('prefers the challenge’s resource_metadata URL over the well-known ones', async () => {
    const net = network({
      ...hostingerRoutes(),
      'GET https://mcp.hostinger.com/.well-known/oauth-protected-resource': reply(404, {}),
      'GET https://mcp.hostinger.com/meta/prm.json': reply(200, HOSTINGER_PRM),
    });
    const found = await discoverOAuth({
      serverUrl: 'https://mcp.hostinger.com/',
      challenge: 'Bearer realm="mcp", resource_metadata="https://mcp.hostinger.com/meta/prm.json"',
      http: net.http,
    });
    expect(found.scope).toBe('mcp:use');
    expect(net.calls[0].url).toBe('https://mcp.hostinger.com/meta/prm.json');
  });

  it('keeps an https revocation_endpoint, and none at all for a server without one or with an http one (#1116)', async () => {
    const withRevocation = (revocation_endpoint) =>
      network(
        replicateRoutes({
          'GET https://mcp.replicate.com/.well-known/oauth-authorization-server': reply(200, {
            ...REPLICATE_AS,
            ...(revocation_endpoint === undefined ? {} : { revocation_endpoint }),
          }),
        })
      );
    const discover = (net) => discoverOAuth({ serverUrl: REPLICATE_URL, http: net.http, name: 'Replicate MCP' });
    expect((await discover(withRevocation('https://mcp.replicate.com/revoke'))).revocationEndpoint).toBe(
      'https://mcp.replicate.com/revoke'
    );
    // Neither Replicate's nor Hostinger's metadata named one when read (2026-10-08).
    expect((await discover(withRevocation(undefined))).revocationEndpoint).toBeNull();
    // A bad address is not a reason to refuse the sign-in; it is just nowhere to revoke.
    expect((await discover(withRevocation('http://mcp.replicate.com/revoke'))).revocationEndpoint).toBeNull();
    expect((await discover(withRevocation('https://u:p@mcp.replicate.com/revoke'))).revocationEndpoint).toBeNull();
    expect((await discover(withRevocation('   '))).revocationEndpoint).toBeNull();
    // It travels from the pending sign-in onto the stored connection.
    const { updates } = await startOAuthConnect({
      server: replicateServer(),
      serverId: 'replicate-mcp',
      userId: 'u',
      http: withRevocation('https://mcp.replicate.com/revoke').http,
      now,
    });
    expect(updates.oauthPending.revocationEndpoint).toBe('https://mcp.replicate.com/revoke');
    const tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: null, scope: null };
    expect(connectedUpdates({ pending: updates.oauthPending, tokens, now }).oauth.revocationEndpoint).toBe(
      'https://mcp.replicate.com/revoke'
    );
    expect(connectedUpdates({ pending: { ...updates.oauthPending, revocationEndpoint: undefined }, tokens, now }).oauth.revocationEndpoint).toBeNull();
  });

  it('falls back to the OpenID configuration when RFC 8414 metadata is absent', async () => {
    const net = network({
      'GET https://mcp.example.com/.well-known/oauth-protected-resource': reply(200, {
        resource: 'https://mcp.example.com',
        authorization_servers: ['https://login.example.com'],
      }),
      'GET https://login.example.com/.well-known/openid-configuration': reply(200, {
        issuer: 'https://login.example.com',
        authorization_endpoint: 'https://login.example.com/authorize',
        token_endpoint: 'https://login.example.com/token',
        registration_endpoint: 'https://login.example.com/register',
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['openid', 'mcp'],
      }),
    });
    const found = await discoverOAuth({ serverUrl: 'https://mcp.example.com/', http: net.http });
    expect(found.tokenEndpoint).toBe('https://login.example.com/token');
    // The resource lists no scopes, and the authorization server's list —
    // everything it can grant — is not asked for: the smallest grant wins.
    expect(found.scope).toBe('');
    expect(net.calls.map((c) => c.url)).toContain(
      'https://login.example.com/.well-known/oauth-authorization-server'
    );
  });
});

describe('discovery refuses what this flow cannot use, and says which', () => {
  const discoverWith = (asOver = {}, prmOver = {}) => {
    const net = network(
      replicateRoutes({
        'GET https://mcp.replicate.com/.well-known/oauth-protected-resource': reply(200, {
          ...REPLICATE_PRM,
          ...prmOver,
        }),
        'GET https://mcp.replicate.com/.well-known/oauth-authorization-server': reply(200, {
          ...REPLICATE_AS,
          ...asOver,
        }),
      })
    );
    return { net, run: discoverOAuth({ serverUrl: REPLICATE_URL, http: net.http, name: 'Replicate MCP' }) };
  };

  it('refuses a server without PKCE S256', async () => {
    await expect(discoverWith({ code_challenge_methods_supported: ['plain'] }).run).rejects.toThrow(
      /does not offer PKCE with S256/
    );
    await expect(discoverWith({ code_challenge_methods_supported: undefined }).run).rejects.toThrow(
      /S256/
    );
  });

  it('refuses a server without dynamic client registration', async () => {
    await expect(discoverWith({ registration_endpoint: undefined }).run).rejects.toThrow(
      /offers no dynamic client registration \(no registration_endpoint\)/
    );
  });

  it('refuses non-https endpoints, authorization servers and resources', async () => {
    await expect(discoverWith({ token_endpoint: 'http://mcp.replicate.com/token' }).run).rejects.toThrow(
      /token endpoint must be an https address/
    );
    await expect(
      discoverWith({ authorization_endpoint: 'http://mcp.replicate.com/authorize' }).run
    ).rejects.toThrow(/authorization endpoint must be an https address/);
    await expect(
      discoverWith({ registration_endpoint: 'http://mcp.replicate.com/register' }).run
    ).rejects.toThrow(/registration endpoint must be an https address/);
    await expect(
      discoverWith({}, { authorization_servers: ['http://mcp.replicate.com/'] }).run
    ).rejects.toThrow(/authorization server must be an https address/);
  });

  it('refuses a resource on another origin, and an issuer on another host', async () => {
    await expect(discoverWith({}, { resource: 'https://attacker.example/' }).run).rejects.toThrow(
      /names the resource https:\/\/attacker\.example\/, which is not its own address/
    );
    await expect(discoverWith({ issuer: 'https://attacker.example' }).run).rejects.toThrow(
      /names the issuer/
    );
  });

  it('accepts a resource that is the server or a parent of it, and nothing beside it', async () => {
    for (const resource of ['https://mcp.replicate.com', 'https://mcp.replicate.com/sse']) {
      await expect(discoverWith({}, { resource }).run).resolves.toMatchObject({ resource });
    }
    for (const resource of [
      'https://mcp.replicate.com/other',
      'https://mcp.replicate.com/ss',
      'https://mcp.replicate.com/?tenant=x',
    ]) {
      await expect(discoverWith({}, { resource }).run).rejects.toThrow(/which is not its own address/);
    }
  });

  it('records whether the server promises the RFC 9207 iss parameter', async () => {
    const net = network(
      replicateRoutes({
        'GET https://mcp.replicate.com/.well-known/oauth-authorization-server': reply(200, {
          ...REPLICATE_AS,
          authorization_response_iss_parameter_supported: true,
        }),
      })
    );
    const { updates } = await startOAuthConnect({
      server: replicateServer(),
      serverId: 'replicate-mcp',
      userId: 'u',
      http: net.http,
      now,
    });
    expect(updates.oauthPending.issParameterSupported).toBe(true);
    expect(sameIssuer('https://mcp.replicate.com/', 'https://mcp.replicate.com')).toBe(true);
    expect(sameIssuer('https://evil.example', 'https://mcp.replicate.com')).toBe(false);
    expect(sameIssuer('', '')).toBe(false);
  });

  it('holds the metadata issuer to the identifier it was fetched for (RFC 8414 §3.3, review of #1019)', () => {
    // Identical, and an origin alone with and without the root "/" (one URL).
    expect(sameIssuer('https://login.example/tenant-a', 'https://login.example/tenant-a')).toBe(true);
    expect(sameIssuer('https://mcp.replicate.com', 'https://mcp.replicate.com/')).toBe(true);
    // Another tenant on the same origin, a path's trailing slash, a missing issuer: not the same.
    expect(sameIssuer('https://login.example/tenant-b', 'https://login.example/tenant-a')).toBe(false);
    expect(sameIssuer('https://login.example/tenant-a/', 'https://login.example/tenant-a')).toBe(false);
    expect(sameIssuer('https://login.example', 'https://login.example/tenant-a')).toBe(false);
    expect(sameIssuer(undefined, 'https://login.example')).toBe(false);
    expect(sameIssuer(' https://login.example', 'https://login.example')).toBe(false);
  });

  it('refuses metadata with no issuer, or one on another path of the same origin', async () => {
    const { issuer: _dropped, ...withoutIssuer } = HOSTINGER_AS;
    for (const metadata of [withoutIssuer, { ...HOSTINGER_AS, issuer: 'https://auth.hostinger.com/tenant-b' }]) {
      const net = network(
        hostingerRoutes({ 'GET https://auth.hostinger.com/.well-known/oauth-authorization-server': reply(200, metadata) })
      );
      await expect(
        discoverOAuth({ serverUrl: HOSTINGER_URL, challenge: HOSTINGER_CHALLENGE, http: net.http, name: 'Hostinger MCP' })
      ).rejects.toThrow(/names the issuer .*not https:\/\/auth\.hostinger\.com/);
      // No endpoint the refused metadata named was used.
      expect(net.calls.some((c) => c.url.includes('/oauth-server/'))).toBe(false);
    }
  });

  it('never follows a metadata redirect down to http', async () => {
    const down = reply(302, '', { location: 'http://mcp.replicate.com/insecure' });
    const net = network(
      replicateRoutes({
        'GET https://mcp.replicate.com/.well-known/oauth-protected-resource/sse': down,
        'GET https://mcp.replicate.com/.well-known/oauth-protected-resource': down,
      })
    );
    await expect(
      discoverOAuth({ serverUrl: REPLICATE_URL, http: net.http, name: 'Replicate MCP' })
    ).rejects.toThrow(/could not be read: .*not an address this site fetches \(Only https is fetched here/);
    expect(net.calls.every((c) => c.url.startsWith('https://'))).toBe(true);
  });

  it('says a server publishes no metadata only when it answered without any', async () => {
    const net = network({});
    await expect(
      discoverOAuth({ serverUrl: REPLICATE_URL, http: net.http, name: 'Replicate MCP' })
    ).rejects.toThrow(/Replicate MCP publishes no OAuth protected-resource metadata \(RFC 9728\)/);
  });

  it('refuses an http URL before any request', async () => {
    const net = network({});
    await expect(net.http('http://mcp.replicate.com/token')).rejects.toThrow(McpOAuthError);
    expect(net.fetch).not.toHaveBeenCalled();
  });
});

describe('dynamic client registration (RFC 7591)', () => {
  it('sends the registration this site needs, as a public client where offered', async () => {
    const net = network(replicateRoutes());
    const { updates } = await startOAuthConnect({
      server: replicateServer(),
      serverId: 'replicate-mcp',
      userId: 'owner-oid',
      http: net.http,
      now,
      random: fixedRandom,
    });
    const registration = net.calls.find((c) => c.url === 'https://mcp.replicate.com/register');
    expect(registration.method).toBe('POST');
    expect(JSON.parse(registration.body)).toEqual({
      client_name: 'HybridCloudWorks',
      redirect_uris: ['https://hybridcloudworks.com/admin/ai-engine/oauth/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
    expect(updates.oauthClient).toEqual({
      issuer: 'https://mcp.replicate.com',
      redirectUri: MCP_OAUTH_REDIRECT_URI,
      clientId: 'rep-client-1',
      tokenEndpointAuthMethod: 'none',
      registeredAt: NOW.toISOString(),
    });
    expect(updates.oauthClientSecret).toBeNull();
  });

  it('chooses none, else the first secret method offered; RFC 8414’s default is basic', () => {
    expect(chooseTokenEndpointAuthMethod(['client_secret_basic', 'client_secret_post', 'none'])).toBe('none');
    expect(chooseTokenEndpointAuthMethod(['client_secret_post', 'client_secret_basic'])).toBe(
      'client_secret_basic'
    );
    expect(chooseTokenEndpointAuthMethod(['client_secret_post'])).toBe('client_secret_post');
    expect(chooseTokenEndpointAuthMethod(['private_key_jwt'])).toBeNull();
    expect(registrationRequestBody({ redirectUri: 'https://x/cb', tokenEndpointAuthMethod: 'none' }))
      .toMatchObject({ redirect_uris: ['https://x/cb'], token_endpoint_auth_method: 'none' });
  });

  it('keeps a confidential client’s secret write-only on the document', async () => {
    const net = network(
      replicateRoutes({
        'GET https://mcp.replicate.com/.well-known/oauth-authorization-server': reply(200, {
          ...REPLICATE_AS,
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
        }),
        'POST https://mcp.replicate.com/register': reply(201, {
          client_id: 'rep-conf',
          client_secret: 'rep-secret',
          token_endpoint_auth_method: 'client_secret_basic',
        }),
      })
    );
    const { updates } = await startOAuthConnect({
      server: replicateServer(),
      serverId: 'replicate-mcp',
      userId: 'owner-oid',
      http: net.http,
      now,
    });
    expect(updates.oauthClient.tokenEndpointAuthMethod).toBe('client_secret_basic');
    expect(updates.oauthClientSecret).toBe('rep-secret');
    expect(JSON.stringify(updates.oauthClient)).not.toContain('rep-secret');
  });

  it('reuses a registration for the same issuer and redirect URI, and re-registers when either changes', async () => {
    const stored = {
      issuer: 'https://mcp.replicate.com',
      redirectUri: MCP_OAUTH_REDIRECT_URI,
      clientId: 'rep-client-0',
      tokenEndpointAuthMethod: 'none',
    };
    const net = network(replicateRoutes());
    const { updates, authorizationUrl } = await startOAuthConnect({
      server: replicateServer({ oauthClient: stored }),
      serverId: 'replicate-mcp',
      userId: 'owner-oid',
      http: net.http,
      now,
    });
    expect(net.calls.some((c) => c.url.endsWith('/register'))).toBe(false);
    expect(updates).not.toHaveProperty('oauthClient');
    expect(new URL(authorizationUrl).searchParams.get('client_id')).toBe('rep-client-0');

    expect(reusableClient({ oauthClient: stored }, { issuer: 'https://other.example/', redirectUri: MCP_OAUTH_REDIRECT_URI })).toBeNull();
    expect(reusableClient({ oauthClient: stored }, { issuer: stored.issuer, redirectUri: 'https://www.hybridcloudworks.com/cb' })).toBeNull();
    // A secret method with no stored secret cannot be reused either.
    expect(
      reusableClient(
        { oauthClient: { ...stored, tokenEndpointAuthMethod: 'client_secret_basic' } },
        { issuer: stored.issuer, redirectUri: MCP_OAUTH_REDIRECT_URI }
      )
    ).toBeNull();

    const moved = network(replicateRoutes());
    const again = await startOAuthConnect({
      server: replicateServer({ oauthClient: { ...stored, redirectUri: 'https://old.example/cb' } }),
      serverId: 'replicate-mcp',
      userId: 'owner-oid',
      http: moved.http,
      now,
    });
    expect(moved.calls.some((c) => c.url.endsWith('/register'))).toBe(true);
    expect(again.updates.oauthClient.clientId).toBe('rep-client-1');
  });

  it('refuses a registration the server rejects, with its reason', async () => {
    const net = network(
      replicateRoutes({
        'POST https://mcp.replicate.com/register': reply(400, {
          error: 'invalid_redirect_uri',
          error_description: 'redirect not allowed',
        }),
      })
    );
    await expect(
      startOAuthConnect({ server: replicateServer(), serverId: 'replicate-mcp', userId: 'u', http: net.http, now })
    ).rejects.toThrow(/refused to register this site: invalid_redirect_uri: redirect not allowed/);
  });
});

describe('PKCE, state and the authorization request', () => {
  it('computes the RFC 7636 Appendix B S256 challenge', () => {
    expect(codeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    );
  });

  it('makes a 43-character unreserved verifier from 32 random bytes', () => {
    const verifier = createCodeVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(verifier).toHaveLength(43);
    expect(createCodeVerifier()).not.toBe(verifier);
  });

  it('sends Hostinger’s resource and scope, stores only the state’s hash, and expires in ten minutes', async () => {
    const net = network(hostingerRoutes());
    const { authorizationUrl, updates } = await startOAuthConnect({
      server: hostingerServer(),
      serverId: 'hostinger-mcp',
      userId: 'owner-oid',
      http: net.http,
      now,
      random: fixedRandom,
    });
    const url = new URL(authorizationUrl);
    expect(`${url.origin}${url.pathname}`).toBe(`${HOSTINGER_OAUTH}/authorize`);
    const params = Object.fromEntries(url.searchParams);
    expect(params).toMatchObject({
      response_type: 'code',
      client_id: 'hst-client-1',
      redirect_uri: 'https://hybridcloudworks.com/admin/ai-engine/oauth/callback',
      code_challenge_method: 'S256',
      resource: 'https://mcp.hostinger.com',
      scope: 'mcp:use',
    });
    const pending = updates.oauthPending;
    expect(params.code_challenge).toBe(codeChallengeS256(pending.codeVerifier));
    expect(pending.stateHash).toBe(createHash('sha256').update(params.state).digest('hex'));
    expect(pending.stateHash).toBe(hashState(params.state));
    expect(JSON.stringify(updates)).not.toContain(params.state);
    expect(pending).toMatchObject({
      createdBy: 'owner-oid',
      createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + PENDING_TTL_MS).toISOString(),
      issuer: 'https://auth.hostinger.com',
      tokenEndpoint: `${HOSTINGER_OAUTH}/token`,
      clientId: 'hst-client-1',
      tokenEndpointAuthMethod: 'none',
      resource: 'https://mcp.hostinger.com',
      scope: 'mcp:use',
    });
    expect(PENDING_TTL_MS).toBe(10 * 60_000);
  });

  it('omits scope when neither document lists one (Replicate)', async () => {
    const net = network(replicateRoutes());
    const { authorizationUrl } = await startOAuthConnect({
      server: replicateServer(),
      serverId: 'replicate-mcp',
      userId: 'u',
      http: net.http,
      now,
    });
    const params = new URL(authorizationUrl).searchParams;
    expect(params.has('scope')).toBe(false);
    expect(params.get('resource')).toBe('https://mcp.replicate.com/');
  });

  it('keeps a query string the authorization endpoint already carries', () => {
    const url = buildAuthorizationUrl({
      authorizationEndpoint: 'https://login.example/authorize?tenant=a',
      clientId: 'c',
      redirectUri: 'https://x/cb',
      codeChallenge: 'ch',
      state: 's',
      resource: 'https://mcp.example',
      scope: '',
    });
    expect(new URL(url).searchParams.get('tenant')).toBe('a');
    expect(new URL(url).searchParams.has('scope')).toBe(false);
  });

  it('refuses a server whose URL is not https before any request', async () => {
    const net = network({});
    await expect(
      startOAuthConnect({
        server: hostingerServer({ url: 'http://localhost:8100' }),
        serverId: 'hostinger-mcp',
        userId: 'u',
        http: net.http,
      })
    ).rejects.toMatchObject({ status: 400 });
    expect(net.fetch).not.toHaveBeenCalled();
  });
});

describe('token requests', () => {
  const pending = {
    issuer: 'https://auth.hostinger.com',
    tokenEndpoint: `${HOSTINGER_OAUTH}/token`,
    clientId: 'hst-client-1',
    tokenEndpointAuthMethod: 'none',
    redirectUri: MCP_OAUTH_REDIRECT_URI,
    resource: 'https://mcp.hostinger.com',
    scope: 'mcp:use',
    codeVerifier: 'v'.repeat(43),
  };

  it('exchanges the code with the verifier, redirect URI, client id and resource', async () => {
    const net = network({
      [`POST ${HOSTINGER_OAUTH}/token`]: reply(200, {
        access_token: 'at-1',
        refresh_token: 'rt-1',
        token_type: 'Bearer',
        expires_in: 3600,
      }),
    });
    const tokens = await exchangeAuthorizationCode({ pending, code: 'the-code', http: net.http, now, name: 'Hostinger MCP' });
    expect(tokens).toEqual({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: '2026-10-08T13:00:00.000Z',
      scope: null,
    });
    const [call] = net.calls;
    expect(call.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(call.headers).not.toHaveProperty('Authorization');
    expect(Object.fromEntries(new URLSearchParams(call.body))).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: 'https://hybridcloudworks.com/admin/ai-engine/oauth/callback',
      code_verifier: 'v'.repeat(43),
      resource: 'https://mcp.hostinger.com',
      client_id: 'hst-client-1',
    });
    expect(connectedUpdates({ pending, tokens, now })).toMatchObject({
      oauthToken: 'at-1',
      oauthRefreshToken: 'rt-1',
      oauthPending: null,
      lastError: null,
      oauth: { status: 'connected', scope: 'mcp:use', expiresAt: '2026-10-08T13:00:00.000Z' },
    });
  });

  it('authenticates a confidential client with Basic or in the body', () => {
    const basic = tokenRequest({
      params: { grant_type: 'refresh_token', refresh_token: 'r' },
      clientId: 'id',
      tokenEndpointAuthMethod: 'client_secret_basic',
      clientSecret: 's',
    });
    expect(basic.headers.Authorization).toBe(`Basic ${Buffer.from('id:s').toString('base64')}`);
    expect(new URLSearchParams(basic.body).has('client_secret')).toBe(false);
    const post = tokenRequest({
      params: { grant_type: 'refresh_token', refresh_token: 'r' },
      clientId: 'id',
      tokenEndpointAuthMethod: 'client_secret_post',
      clientSecret: 's',
    });
    expect(post.headers).not.toHaveProperty('Authorization');
    expect(new URLSearchParams(post.body).get('client_secret')).toBe('s');
  });

  it('does not follow a redirect from the token endpoint', async () => {
    const net = network({
      [`POST ${HOSTINGER_OAUTH}/token`]: reply(307, '', { location: 'https://elsewhere.example/token' }),
    });
    await expect(
      exchangeAuthorizationCode({ pending, code: 'c', http: net.http, now, name: 'Hostinger MCP' })
    ).rejects.toThrow(/redirect, which this sign-in does not follow/);
    expect(net.calls.map((c) => c.url)).toEqual([`${HOSTINGER_OAUTH}/token`]);
  });

  it('refuses an error reply and a token that is not a bearer token', () => {
    expect(() =>
      parseTokenResponse(
        { status: 400, text: JSON.stringify({ error: 'invalid_grant', error_description: 'code expired' }) },
        { name: 'X', grant: 'sign-in code', now }
      )
    ).toThrow(/refused the sign-in code: invalid_grant: code expired/);
    expect(() =>
      parseTokenResponse(
        { status: 200, text: JSON.stringify({ access_token: 'a', token_type: 'mac' }) },
        { name: 'X', grant: 'sign-in code', now }
      )
    ).toThrow(/not a bearer token/);
    expect(
      parseTokenResponse({ status: 200, text: JSON.stringify({ access_token: 'a' }) }, { name: 'X', grant: 'g', now })
    ).toEqual({ accessToken: 'a', refreshToken: null, expiresAt: null, scope: null });
  });
});

describe('revocation (RFC 7009, #1116)', () => {
  const REVOKE = 'https://mcp.podbean.com/revoke';
  const connected = (over = {}) => ({
    id: 'podbean-mcp',
    name: 'Podbean MCP',
    oauthToken: 'at-1',
    oauthRefreshToken: 'rt-1',
    oauth: {
      status: 'connected',
      issuer: 'https://mcp.podbean.com',
      tokenEndpoint: 'https://mcp.podbean.com/token',
      revocationEndpoint: REVOKE,
      clientId: 'pb-client-1',
      tokenEndpointAuthMethod: 'none',
    },
    ...over,
  });
  const revoke = (server, net) => revokeOAuthGrant({ server, serverId: 'podbean-mcp', http: net.http });

  it('posts the refresh token, then the access token, each with its hint and the client id', async () => {
    const net = network({ [`POST ${REVOKE}`]: reply(200, '') });
    expect(await revoke(connected(), net)).toEqual({ revoked: true, issuer: 'https://mcp.podbean.com' });
    expect(net.calls.map((c) => Object.fromEntries(new URLSearchParams(c.body)))).toEqual([
      { token: 'rt-1', token_type_hint: 'refresh_token', client_id: 'pb-client-1' },
      { token: 'at-1', token_type_hint: 'access_token', client_id: 'pb-client-1' },
    ]);
    expect(net.calls.every((c) => c.method === 'POST' && !('Authorization' in c.headers))).toBe(true);
  });

  it('revokes only what is stored, and has nowhere to revoke without an endpoint or without tokens', async () => {
    const net = network({ [`POST ${REVOKE}`]: reply(200, '') });
    expect(await revoke(connected({ oauthRefreshToken: null }), net)).toEqual({ revoked: true, issuer: 'https://mcp.podbean.com' });
    expect(net.calls.map((c) => new URLSearchParams(c.body).get('token_type_hint'))).toEqual(['access_token']);
    const none = network({});
    const { revocationEndpoint: _none, ...withoutEndpoint } = connected().oauth;
    expect(await revoke(connected({ oauth: withoutEndpoint }), none)).toEqual({ revoked: null, issuer: 'https://mcp.podbean.com' });
    expect(await revoke(connected({ oauthToken: null, oauthRefreshToken: null }), none)).toEqual({
      revoked: null,
      issuer: 'https://mcp.podbean.com',
    });
    expect(await revoke({ id: 'x' }, none)).toEqual({ revoked: null, issuer: null });
    expect(none.fetch).not.toHaveBeenCalled();
  });

  it('does not follow a redirect from the revocation endpoint, and the reason carries no token', async () => {
    const net = network({ [`POST ${REVOKE}`]: reply(307, '', { location: 'https://elsewhere.example/revoke' }) });
    const result = await revoke(connected(), net);
    expect(result.revoked).toBe(false);
    expect(result.reason).toMatch(/redirect, which this sign-in does not follow/);
    expect(result.reason).not.toMatch(/at-1|rt-1/);
    expect(net.calls.map((c) => c.url)).toEqual([REVOKE, REVOKE]);
  });

  it('refuses an endpoint that is not https before any request', async () => {
    const net = network({});
    const result = await revoke(connected({ oauth: { ...connected().oauth, revocationEndpoint: 'http://mcp.podbean.com/revoke' } }), net);
    expect(result).toMatchObject({ revoked: false, issuer: 'https://mcp.podbean.com' });
    expect(result.reason).toMatch(/Podbean MCP's revocation endpoint must be an https address/);
    expect(net.fetch).not.toHaveBeenCalled();
  });
});

describe('refresh', () => {
  const connected = (over = {}) =>
    hostingerServer({
      oauthToken: 'at-old',
      oauthRefreshToken: 'rt-old',
      oauth: {
        status: 'connected',
        issuer: 'https://auth.hostinger.com',
        tokenEndpoint: `${HOSTINGER_OAUTH}/token`,
        clientId: 'hst-client-1',
        tokenEndpointAuthMethod: 'none',
        resource: 'https://mcp.hostinger.com',
        scope: 'mcp:use',
        expiresAt: '2026-10-08T12:01:00.000Z',
      },
      ...over,
    });
  /** One document with ETags, as Cosmos keeps it: a guarded write to a changed document is a 412. */
  const storeFor = (doc) => {
    let version = 0;
    const store = {
      current: { _etag: 'e0', ...doc },
      readDoc: vi.fn(async () => store.current),
      patchDoc: vi.fn(async (_c, _id, updates, options) => {
        if (options?.ifMatch && options.ifMatch !== store.current._etag) {
          throw Object.assign(new Error('changed since read'), { code: 412 });
        }
        store.current = { ...store.current, ...updates, _etag: `e${(version += 1)}` };
        return store.current;
      }),
      /** Another writer: an unguarded change, as a Disconnect or a config write lands. */
      meanwhile(change) {
        store.current = { ...store.current, ...change, _etag: `e${(version += 1)}` };
      },
    };
    return store;
  };

  it('knows a connection from an expired one, and an expiring token', () => {
    expect(oauthConnectionState(connected())).toBe('connected');
    expect(oauthConnectionState(connected({ oauthToken: null }))).toBe('not_connected');
    expect(oauthConnectionState({ oauth: { status: 'disconnected' } })).toBe('expired');
    expect(oauthConnectionState({})).toBe('not_connected');
    expect(tokenExpiresWithin(connected(), 2 * 60_000, now)).toBe(true);
    expect(tokenExpiresWithin(connected(), 30_000, now)).toBe(false);
    expect(tokenExpiresWithin(connected({ oauth: { status: 'connected' } }), 2 * 60_000, now)).toBe(false);
  });

  it('refreshes with the refresh grant and keeps the old refresh token when none comes back', async () => {
    const net = network({
      [`POST ${HOSTINGER_OAUTH}/token`]: reply(200, { access_token: 'at-new', expires_in: 3600 }),
    });
    const doc = connected();
    const store = storeFor(doc);
    const result = await refreshOAuthToken({ store, serverId: 'hostinger-mcp', server: doc, http: net.http, now });
    expect(result.ok).toBe(true);
    expect(Object.fromEntries(new URLSearchParams(net.calls[0].body))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'rt-old',
      resource: 'https://mcp.hostinger.com',
      client_id: 'hst-client-1',
    });
    const [, , updates] = store.patchDoc.mock.calls[0];
    expect(updates.oauthToken).toBe('at-new');
    expect(updates.oauthRefreshToken).toBe('rt-old');
    expect(updates.oauth).toMatchObject({
      status: 'connected',
      expiresAt: '2026-10-08T13:00:00.000Z',
      refreshedAt: NOW.toISOString(),
      scope: 'mcp:use',
    });
    expect(result.server.oauthToken).toBe('at-new');
  });

  it('stores a rotated refresh token', async () => {
    const net = network({
      [`POST ${HOSTINGER_OAUTH}/token`]: reply(200, { access_token: 'at-new', refresh_token: 'rt-new' }),
    });
    const doc = connected();
    const store = storeFor(doc);
    await refreshOAuthToken({ store, serverId: 'hostinger-mcp', server: doc, http: net.http, now });
    expect(store.patchDoc.mock.calls[0][2].oauthRefreshToken).toBe('rt-new');
  });

  it('marks the server disconnected, tokens cleared, when the grant is refused', async () => {
    const net = network({
      [`POST ${HOSTINGER_OAUTH}/token`]: reply(400, { error: 'invalid_grant' }),
    });
    const doc = connected();
    const store = storeFor(doc);
    const result = await refreshOAuthToken({ store, serverId: 'hostinger-mcp', server: doc, http: net.http, now });
    expect(result).toEqual({
      ok: false,
      disconnected: true,
      message:
        'Sign-in to Hostinger MCP has expired. Press Connect on its card under AI Engine → MCP Servers to sign in again.',
    });
    const [, , updates] = store.patchDoc.mock.calls[0];
    expect(updates).toMatchObject({
      oauthToken: null,
      oauthRefreshToken: null,
      status: 'needs_connection',
      oauth: { status: 'disconnected', disconnectReason: 'refresh_failed' },
    });
    expect(updates.lastError).toMatch(/Press Connect/);
  });

  it('treats a 401 from the token endpoint as a dead grant too, and a missing refresh token the same', async () => {
    const net = network({ [`POST ${HOSTINGER_OAUTH}/token`]: reply(401, { error: 'invalid_client' }) });
    const doc = connected();
    expect(
      (await refreshOAuthToken({ store: storeFor(doc), serverId: 'h1', server: doc, http: net.http, now })).disconnected
    ).toBe(true);
    const bare = connected({ oauthRefreshToken: null });
    const silent = network({});
    expect(
      (await refreshOAuthToken({ store: storeFor(bare), serverId: 'h2', server: bare, http: silent.http, now }))
        .disconnected
    ).toBe(true);
    expect(silent.fetch).not.toHaveBeenCalled();
  });

  it('leaves everything as it was when the token endpoint is down', async () => {
    const net = network({ [`POST ${HOSTINGER_OAUTH}/token`]: reply(503, 'busy') });
    const doc = connected();
    const store = storeFor(doc);
    const result = await refreshOAuthToken({ store, serverId: 'h3', server: doc, http: net.http, now });
    expect(result).toMatchObject({ ok: false, transient: true });
    expect(store.patchDoc).not.toHaveBeenCalled();
  });

  it('accepts a refresh another instance completed first with the same rotating token', async () => {
    const net = network({ [`POST ${HOSTINGER_OAUTH}/token`]: reply(400, { error: 'invalid_grant' }) });
    const doc = connected();
    const latest = connected({ oauthToken: 'at-other', oauthRefreshToken: 'rt-other' });
    const store = { readDoc: vi.fn(async () => latest), patchDoc: vi.fn() };
    const result = await refreshOAuthToken({ store, serverId: 'h4', server: doc, http: net.http, now });
    expect(result).toEqual({ ok: true, server: latest });
    expect(store.patchDoc).not.toHaveBeenCalled();
  });

  describe('a write that lands while a refresh is in flight (review of #1019)', () => {
    /** A token endpoint that lets `during` change the document before it answers. */
    const tokenEndpoint = (during, answer = reply(200, { access_token: 'at-new', refresh_token: 'rt-new' })) =>
      network({
        [`POST ${HOSTINGER_OAUTH}/token`]: async () => {
          during();
          return answer;
        },
      });

    it('does not undo a Disconnect', async () => {
      const store = storeFor(connected());
      const net = tokenEndpoint(() =>
        store.meanwhile({ oauthToken: null, oauthRefreshToken: null, oauth: { status: 'disconnected' } })
      );
      const result = await refreshOAuthToken({ store, serverId: 'r1', server: store.current, http: net.http, now });
      expect(result).toMatchObject({ ok: false, disconnected: true, changed: true });
      expect(store.current.oauthToken).toBeNull();
      expect(store.current.oauth.status).toBe('disconnected');
    });

    it('does not take a token for the old resource to a moved server', async () => {
      const store = storeFor(connected());
      const net = tokenEndpoint(() =>
        store.meanwhile({ url: 'https://mcp.elsewhere.example', oauthToken: null, oauthRefreshToken: null, oauth: null })
      );
      const result = await refreshOAuthToken({ store, serverId: 'r2', server: store.current, http: net.http, now });
      expect(result).toMatchObject({ ok: false, disconnected: true });
      expect(store.current.url).toBe('https://mcp.elsewhere.example');
      expect(store.current.oauthToken).toBeNull();
    });

    it('keeps the refresh through an unrelated write, such as a rename', async () => {
      const store = storeFor(connected());
      const net = tokenEndpoint(() => store.meanwhile({ name: 'Hostinger (VPS)' }));
      const result = await refreshOAuthToken({ store, serverId: 'r3', server: store.current, http: net.http, now });
      expect(result.ok).toBe(true);
      expect(store.current).toMatchObject({ name: 'Hostinger (VPS)', oauthToken: 'at-new', oauthRefreshToken: 'rt-new' });
    });

    it('a refused refresh does not clear a rotation another instance stored after its read', async () => {
      const store = storeFor(connected());
      const net = network({ [`POST ${HOSTINGER_OAUTH}/token`]: reply(400, { error: 'invalid_grant' }) });
      const read = store.readDoc;
      let reads = 0;
      store.readDoc = vi.fn(async (...args) => {
        const doc = await read(...args);
        // Just after this instance's read, the other instance stores its rotation.
        if ((reads += 1) === 1) store.meanwhile({ oauthToken: 'at-other', oauthRefreshToken: 'rt-other' });
        return doc;
      });
      const result = await refreshOAuthToken({ store, serverId: 'r4', server: store.current, http: net.http, now });
      expect(result.ok).toBe(true);
      expect(result.server.oauthToken).toBe('at-other');
      expect(store.current).toMatchObject({ oauthToken: 'at-other', oauthRefreshToken: 'rt-other' });
      expect(store.current.oauth.status).toBe('connected');
    });
  });

  it('spends a rotating refresh token once for concurrent callers in one process', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const net = network({
      [`POST ${HOSTINGER_OAUTH}/token`]: async () => {
        await gate;
        return reply(200, { access_token: 'at-new', refresh_token: 'rt-new' });
      },
    });
    const doc = connected();
    const store = storeFor(doc);
    const a = refreshOAuthToken({ store, serverId: 'h5', server: doc, http: net.http, now });
    const b = refreshOAuthToken({ store, serverId: 'h5', server: doc, http: net.http, now });
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.ok && rb.ok).toBe(true);
    expect(net.fetch).toHaveBeenCalledTimes(1);
  });
});
