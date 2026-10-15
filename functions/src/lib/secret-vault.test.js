/**
 * The Key Vault writer behind the API Keys page (#817).
 *
 * admin-secrets.test.js injects a fake vault, so until this file the real
 * module never ran in a test. What it has to get right is small and each part
 * fails quietly: one slash in the URL (two is a 404 that reads like a missing
 * secret), an error that names the secret and never carries the value, and a
 * refresh that reports rather than throws, because the secret is already
 * written by the time it runs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  REFRESH_API_VERSION,
  VAULT_API_VERSION,
  refreshKeyVaultReferences,
  resetSecretVaultForTests,
  setVaultSecret,
  vaultBaseUrl,
  versionFromId,
} from './secret-vault.js';

const VALUE = 'sk-live-this-must-never-appear-in-an-error';

const credential = (token = 'tok') => ({ getToken: vi.fn(async (scope) => ({ token, scope })) });
const okFetch = (body = { id: 'https://kv.vault.azure.net/secrets/NAME/abc123' }) =>
  vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));

beforeEach(() => resetSecretVaultForTests());

describe('vaultBaseUrl', () => {
  it('ends in exactly one slash whether or not the setting has one', () => {
    expect(vaultBaseUrl({ KEY_VAULT_URI: 'https://kv.vault.azure.net' })).toBe('https://kv.vault.azure.net/');
    expect(vaultBaseUrl({ KEY_VAULT_URI: 'https://kv.vault.azure.net/' })).toBe('https://kv.vault.azure.net/');
    expect(vaultBaseUrl({ KEY_VAULT_URI: '  https://kv.vault.azure.net/  ' })).toBe('https://kv.vault.azure.net/');
  });

  it('refuses to guess when the setting is absent', () => {
    expect(() => vaultBaseUrl({})).toThrow(/KEY_VAULT_URI is not set/);
  });
});

describe('setVaultSecret', () => {
  it('PUTs the value to one secret URL with a vault-scoped bearer token', async () => {
    const fetch = okFetch();
    const cred = credential('vault-token');
    const result = await setVaultSecret('GEMINI-API-KEY', VALUE, {
      fetch,
      credential: cred,
      env: { KEY_VAULT_URI: 'https://kv.vault.azure.net' },
    });

    expect(cred.getToken).toHaveBeenCalledWith('https://vault.azure.net/.default');
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`https://kv.vault.azure.net/secrets/GEMINI-API-KEY?api-version=${VAULT_API_VERSION}`);
    expect(url).not.toMatch(/[^:]\/\//);
    expect(init.method).toBe('PUT');
    expect(init.headers.Authorization).toBe('Bearer vault-token');
    expect(JSON.parse(init.body)).toEqual({ value: VALUE });
    expect(result).toEqual({ version: 'abc123' });
  });

  it('encodes the name, so a name cannot reshape the path', async () => {
    const fetch = okFetch();
    await setVaultSecret('A/B?x', VALUE, { fetch, credential: credential(), vaultUrl: 'https://kv/' });
    expect(fetch.mock.calls[0][0]).toBe(`https://kv/secrets/A%2FB%3Fx?api-version=${VAULT_API_VERSION}`);
  });

  it('names the secret and the status on a refusal, and never the value or the body', async () => {
    const fetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: `echo: ${VALUE}` } }),
      text: async () => `echo: ${VALUE}`,
    }));
    const failure = await setVaultSecret('OPENAI-API-KEY', VALUE, {
      fetch,
      credential: credential(),
      vaultUrl: 'https://kv/',
    }).catch((error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe('Key Vault refused to set OPENAI-API-KEY: HTTP 403');
    expect(failure.message).not.toContain(VALUE);
  });

  it('fails before any request when no token can be had', async () => {
    const fetch = okFetch();
    const noToken = { getToken: vi.fn(async () => null) };
    await expect(
      setVaultSecret('X', VALUE, { fetch, credential: noToken, vaultUrl: 'https://kv/' })
    ).rejects.toThrow(/Could not acquire a token/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports a null version when the response carries no id', async () => {
    const result = await setVaultSecret('X', VALUE, {
      fetch: okFetch({}),
      credential: credential(),
      vaultUrl: 'https://kv/',
    });
    expect(result).toEqual({ version: null });
  });
});

describe('versionFromId', () => {
  it('takes the last path segment, and is null for anything else', () => {
    expect(versionFromId('https://kv.vault.azure.net/secrets/NAME/v1')).toBe('v1');
    expect(versionFromId(undefined)).toBeNull();
    expect(versionFromId(42)).toBeNull();
  });
});

describe('refreshKeyVaultReferences never throws: the secret is already written', () => {
  const resourceId = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Web/sites/func';

  it('POSTs the refresh endpoint with an ARM-scoped token', async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200 }));
    const cred = credential('arm-token');
    const result = await refreshKeyVaultReferences({ fetch, credential: cred, resourceId });

    expect(cred.getToken).toHaveBeenCalledWith('https://management.azure.com/.default');
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(
      `https://management.azure.com${resourceId}/config/configreferences/appsettings/refresh?api-version=${REFRESH_API_VERSION}`
    );
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer arm-token');
    expect(result).toEqual({ refreshed: true, reason: null });
  });

  it('reports a missing resource id without calling anything', async () => {
    const fetch = vi.fn();
    const result = await refreshKeyVaultReferences({ fetch, credential: credential(), env: {} });
    expect(result).toEqual({ refreshed: false, reason: 'FUNCTION_APP_RESOURCE_ID is not set' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports a refused refresh', async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 429 }));
    const result = await refreshKeyVaultReferences({ fetch, credential: credential(), resourceId });
    expect(result).toEqual({ refreshed: false, reason: 'refresh endpoint returned 429' });
  });

  it('reports a token failure and a network failure instead of throwing', async () => {
    const noToken = { getToken: vi.fn(async () => { throw new Error('no identity'); }) };
    await expect(
      refreshKeyVaultReferences({ fetch: vi.fn(), credential: noToken, resourceId })
    ).resolves.toEqual({ refreshed: false, reason: 'refresh call failed (Error)' });

    const down = vi.fn(async () => { throw new Error('ECONNRESET'); });
    await expect(
      refreshKeyVaultReferences({ fetch: down, credential: credential(), resourceId })
    ).resolves.toEqual({ refreshed: false, reason: 'refresh call failed (Error)' });
  });
});
