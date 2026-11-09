/**
 * google-auth.js: the three hops, the cache, and that no token or Google
 * response text ever lands in an error (#1612). Fetch and the Azure
 * credential are stubs; nothing here reaches the network.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createGoogleTokenProvider,
  GoogleAuthError,
  IAM_CREDENTIALS_BASE,
  readGoogleAuthConfig,
  SEARCH_CONSOLE_READONLY_SCOPE,
  STS_TOKEN_URL,
} from './google-auth.js';

const AUDIENCE = '//iam.googleapis.com/projects/000000000001/locations/global/workloadIdentityPools/hcw-azure/providers/entra';
const APP_ID_URI = 'api://00000000-0000-0000-0000-000000000001';
const SA = 'sa-hcw-search-console@example-project.iam.gserviceaccount.com';
const ENTRA_TOKEN = 'entra-token-value-should-never-leak';
const FEDERATED = 'federated-token-value-should-never-leak';
const SA_TOKEN = 'sa-token-value-should-never-leak';

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

function setup({ sts = jsonResponse(200, { access_token: FEDERATED }), iam, now = () => 0 } = {}) {
  const credential = { getToken: vi.fn(async () => ({ token: ENTRA_TOKEN, expiresOnTimestamp: 3_600_000 })) };
  const fetchImpl = vi.fn(async (url) => {
    if (url === STS_TOKEN_URL) return typeof sts === 'function' ? sts() : sts;
    return iam ?? jsonResponse(200, { accessToken: SA_TOKEN, expireTime: new Date(3_600_000).toISOString() });
  });
  const provider = createGoogleTokenProvider({
    audience: AUDIENCE,
    appIdUri: APP_ID_URI,
    serviceAccountEmail: SA,
    credential,
    fetchImpl,
    now,
  });
  return { provider, fetchImpl, credential };
}

describe('readGoogleAuthConfig', () => {
  it('is not configured while any of the three sign-in settings is empty, and names them', () => {
    const config = readGoogleAuthConfig({ GSC_WIF_AUDIENCE: AUDIENCE, GSC_ENTRA_APP_ID_URI: ' ' });
    expect(config.configured).toBe(false);
    expect(config.missing).toEqual(['GSC_ENTRA_APP_ID_URI', 'GSC_SERVICE_ACCOUNT_EMAIL']);
    expect(config.siteUrl).toBe('sc-domain:hybridcloudworks.com');
  });

  it('is configured when all three are set, and keeps a set site URL', () => {
    const config = readGoogleAuthConfig({
      GSC_WIF_AUDIENCE: AUDIENCE,
      GSC_ENTRA_APP_ID_URI: `${APP_ID_URI}/`,
      GSC_SERVICE_ACCOUNT_EMAIL: SA,
      GSC_SITE_URL: 'https://example.com/',
    });
    expect(config).toMatchObject({ configured: true, missing: [], appIdUri: APP_ID_URI, siteUrl: 'https://example.com/' });
  });
});

describe('createGoogleTokenProvider', () => {
  it('asks Entra for the App ID URI, exchanges it, and impersonates the service account', async () => {
    const { provider, fetchImpl, credential } = setup();
    await expect(provider.getAccessToken()).resolves.toBe(SA_TOKEN);

    expect(credential.getToken).toHaveBeenCalledWith(`${APP_ID_URI}/.default`);

    const [stsUrl, stsInit] = fetchImpl.mock.calls[0];
    expect(stsUrl).toBe(STS_TOKEN_URL);
    const form = new URLSearchParams(stsInit.body);
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      audience: AUDIENCE,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      subject_token: ENTRA_TOKEN,
    });

    const [iamUrl, iamInit] = fetchImpl.mock.calls[1];
    expect(iamUrl).toBe(`${IAM_CREDENTIALS_BASE}/${encodeURIComponent(SA)}:generateAccessToken`);
    expect(iamInit.headers.Authorization).toBe(`Bearer ${FEDERATED}`);
    expect(JSON.parse(iamInit.body)).toEqual({ scope: [SEARCH_CONSOLE_READONLY_SCOPE], lifetime: '3600s' });
  });

  it('reuses the token until five minutes before it expires, then signs in again', async () => {
    let clock = 0;
    const { provider, fetchImpl } = setup({ now: () => clock });
    await provider.getAccessToken();
    clock = 3_600_000 - 5 * 60 * 1000 - 1;
    await provider.getAccessToken();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    clock = 3_600_000 - 5 * 60 * 1000;
    await provider.getAccessToken();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('shares one sign-in between two callers asking at once', async () => {
    const { provider, credential } = setup();
    await Promise.all([provider.getAccessToken(), provider.getAccessToken()]);
    expect(credential.getToken).toHaveBeenCalledTimes(1);
  });

  it('signs in again after reset()', async () => {
    const { provider, credential } = setup();
    await provider.getAccessToken();
    provider.reset();
    await provider.getAccessToken();
    expect(credential.getToken).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['sts', { sts: jsonResponse(400, { error: 'invalid_grant', error_description: `bad ${ENTRA_TOKEN}` }) }, 400],
    ['impersonation', { iam: jsonResponse(403, { error: { message: `denied ${FEDERATED}` } }) }, 403],
  ])('names hop %s and its HTTP status, and nothing Google sent', async (kind, overrides, status) => {
    const { provider } = setup(overrides);
    const failure = await provider.getAccessToken().catch((caught) => caught);
    expect(failure).toBeInstanceOf(GoogleAuthError);
    expect(failure.kind).toBe(kind);
    expect(failure.status).toBe(status);
    const shown = `${failure.message} ${failure.stack} ${JSON.stringify(failure)}`;
    for (const secret of [ENTRA_TOKEN, FEDERATED, SA_TOKEN, 'invalid_grant', 'denied']) {
      expect(shown).not.toContain(secret);
    }
  });

  it('names hop entra when the managed identity cannot get a token, without its text', async () => {
    const credential = { getToken: vi.fn(async () => Promise.reject(new Error(`imds said ${ENTRA_TOKEN}`))) };
    const provider = createGoogleTokenProvider({
      audience: AUDIENCE,
      appIdUri: APP_ID_URI,
      serviceAccountEmail: SA,
      credential,
      fetchImpl: vi.fn(),
    });
    const failure = await provider.getAccessToken().catch((caught) => caught);
    expect(failure).toBeInstanceOf(GoogleAuthError);
    expect(failure.kind).toBe('entra');
    expect(failure.message).not.toContain(ENTRA_TOKEN);
  });

  it('treats a 200 without a token as a failed hop', async () => {
    const { provider } = setup({ sts: jsonResponse(200, {}) });
    await expect(provider.getAccessToken()).rejects.toMatchObject({ kind: 'sts', status: 200 });
  });

  it('treats a network failure as a failed hop with no status', async () => {
    const { provider } = setup({
      sts: () => {
        throw new TypeError('fetch failed');
      },
    });
    const failure = await provider.getAccessToken().catch((caught) => caught);
    expect(failure).toMatchObject({ kind: 'sts' });
    expect(failure.status).toBeUndefined();
  });
});
