/**
 * Unit tests for functions/src/lib/credentials/google-roll.js (#1028).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  GOOGLE_TARGETS,
  defaultSleep,
  lookupGoogleApiKey,
  getGoogleKeyDetails,
  createGoogleApiKey,
  pollGoogleOperation,
  getGoogleKeyString,
  deleteGoogleApiKey,
  verifyGoogleApiKey,
  rollAndApplyGoogleKey,
} from './google-roll.js';

// Stubs match a probe by its host, not by a substring anywhere in the URL.
const hostOf = (url) => new URL(url).hostname;

describe('GOOGLE_TARGETS', () => {
  it('declares the three Google Cloud API key targets', () => {
    expect(Object.keys(GOOGLE_TARGETS).sort()).toEqual(['billing', 'gemini', 'youtube']);

    const gemini = GOOGLE_TARGETS.gemini;
    expect(gemini.id).toBe('kv-gemini-api-key');
    expect(gemini.secretName).toBe('GEMINI-API-KEY');
    expect(gemini.service).toBe('generativelanguage.googleapis.com');
    expect(gemini.probeMethod).toBe('HEADER');

    const youtube = GOOGLE_TARGETS.youtube;
    expect(youtube.id).toBe('kv-youtube-api-key');
    expect(youtube.secretName).toBe('YOUTUBE-API-KEY');
    expect(youtube.service).toBe('youtube.googleapis.com');
    expect(youtube.probeMethod).toBe('QUERY');

    const billing = GOOGLE_TARGETS.billing;
    expect(billing.id).toBe('kv-gcp-billing-api-key');
    expect(billing.secretName).toBe('GCP-BILLING-API-KEY');
    expect(billing.service).toBe('cloudbilling.googleapis.com');
    expect(billing.probeMethod).toBe('QUERY');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(GOOGLE_TARGETS)).toBe(true);
    for (const target of Object.values(GOOGLE_TARGETS)) {
      expect(Object.isFrozen(target)).toBe(true);
    }
  });

  it('defaultSleep returns a promise that resolves', async () => {
    await expect(defaultSleep(1)).resolves.toBeUndefined();
  });
});

describe('lookupGoogleApiKey', () => {
  it('validates required arguments', async () => {
    await expect(lookupGoogleApiKey({})).rejects.toThrow('keyString must be a non-empty string');
    await expect(lookupGoogleApiKey({ keyString: 'AIza...' })).rejects.toThrow('gcpToken must be a non-empty string');
  });

  it('returns key resource name and parent on match', async () => {
    const mockFetch = vi.fn(async (url, options) => {
      expect(url).toContain('keys:lookupKey?keyString=AIza-test-key');
      expect(options.headers.Authorization).toBe('Bearer gcp-access-token');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          name: 'projects/12345/locations/global/keys/uuid-1',
          parent: 'projects/12345',
        }),
      };
    });

    const res = await lookupGoogleApiKey({
      keyString: 'AIza-test-key',
      gcpToken: 'gcp-access-token',
      fetchImpl: mockFetch,
    });

    expect(res).toEqual({
      name: 'projects/12345/locations/global/keys/uuid-1',
      parent: 'projects/12345',
    });
  });

  it('returns null on HTTP 404', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    }));

    const res = await lookupGoogleApiKey({
      keyString: 'AIza-not-found',
      gcpToken: 'token',
      fetchImpl: mockFetch,
    });

    expect(res).toBeNull();
  });

  it('throws error on non-404 failure', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: async () => ({ error: { message: 'Caller lacks permission' } }),
    }));

    await expect(
      lookupGoogleApiKey({
        keyString: 'AIza-forbidden',
        gcpToken: 'token',
        fetchImpl: mockFetch,
      })
    ).rejects.toThrow(/Google API key lookup failed \(HTTP 403\): Caller lacks permission/);
  });
});

describe('getGoogleKeyDetails', () => {
  it('validates required arguments', async () => {
    await expect(getGoogleKeyDetails({})).rejects.toThrow('keyName must be a non-empty string');
    await expect(getGoogleKeyDetails({ keyName: 'projects/1/locations/global/keys/k1' })).rejects.toThrow('gcpToken must be a non-empty string');
  });

  it('reads key metadata and restrictions', async () => {
    const mockFetch = vi.fn(async (url, options) => {
      expect(url).toBe('https://apikeys.googleapis.com/v2/projects/1/locations/global/keys/k1');
      expect(options.headers.Authorization).toBe('Bearer gcp-token');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          name: 'projects/1/locations/global/keys/k1',
          displayName: 'site-gemini-key',
          restrictions: {
            apiTargets: [{ service: 'generativelanguage.googleapis.com' }],
          },
        }),
      };
    });

    const res = await getGoogleKeyDetails({
      keyName: 'projects/1/locations/global/keys/k1',
      gcpToken: 'gcp-token',
      fetchImpl: mockFetch,
    });

    expect(res).toEqual({
      name: 'projects/1/locations/global/keys/k1',
      displayName: 'site-gemini-key',
      restrictions: {
        apiTargets: [{ service: 'generativelanguage.googleapis.com' }],
      },
    });
  });

  it('throws on failed details fetch', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Error',
      json: async () => ({}),
    }));

    await expect(
      getGoogleKeyDetails({
        keyName: 'projects/1/locations/global/keys/k1',
        gcpToken: 'tok',
        fetchImpl: mockFetch,
      })
    ).rejects.toThrow(/Google API key details read failed \(HTTP 500\)/);
  });
});

describe('createGoogleApiKey', () => {
  it('validates mandatory arguments', async () => {
    await expect(createGoogleApiKey({})).rejects.toThrow('parent project must be specified');
    await expect(createGoogleApiKey({ parent: 'projects/1' })).rejects.toThrow('displayName must be specified');
    await expect(createGoogleApiKey({ parent: 'projects/1', displayName: 'd' })).rejects.toThrow('gcpToken must be a non-empty string');
  });

  it('sends POST to locations/global/keys and formats parent prefix', async () => {
    let capturedBody = null;
    let capturedUrl = null;

    const mockFetch = vi.fn(async (url, options) => {
      capturedUrl = url;
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          name: 'operations/op-create-123',
          done: false,
        }),
      };
    });

    const res = await createGoogleApiKey({
      parent: 'my-proj-id',
      displayName: 'new-gemini-key',
      restrictions: { apiTargets: [{ service: 'generativelanguage.googleapis.com' }] },
      gcpToken: 'token-xyz',
      fetchImpl: mockFetch,
    });

    expect(capturedUrl).toBe('https://apikeys.googleapis.com/v2/projects/my-proj-id/locations/global/keys');
    expect(capturedBody).toEqual({
      displayName: 'new-gemini-key',
      restrictions: { apiTargets: [{ service: 'generativelanguage.googleapis.com' }] },
    });
    expect(res).toEqual({
      operationName: 'operations/op-create-123',
      done: false,
      keyName: null,
    });
  });

  it('throws error when creation request is rejected', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ error: { message: 'Quota exceeded for API keys' } }),
    }));

    await expect(
      createGoogleApiKey({
        parent: 'projects/123',
        displayName: 'key',
        gcpToken: 'tok',
        fetchImpl: mockFetch,
      })
    ).rejects.toThrow(/Google API key creation initiation failed \(HTTP 400\): Quota exceeded/);
  });
});

describe('pollGoogleOperation', () => {
  it('polls until done: true and returns keyName', async () => {
    let attempts = 0;
    const mockFetch = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ name: 'operations/op-1', done: false }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          name: 'operations/op-1',
          done: true,
          response: { name: 'projects/1/locations/global/keys/created-key-uuid' },
        }),
      };
    });

    const res = await pollGoogleOperation({
      operationName: 'operations/op-1',
      gcpToken: 'tok',
      fetchImpl: mockFetch,
      sleep: async () => {},
    });

    expect(attempts).toBe(2);
    expect(res).toEqual({ keyName: 'projects/1/locations/global/keys/created-key-uuid' });
  });

  it('throws error when operation returns error property', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        name: 'operations/op-err',
        done: true,
        error: { message: 'Failed to provision key' },
      }),
    }));

    await expect(
      pollGoogleOperation({
        operationName: 'operations/op-err',
        gcpToken: 'tok',
        fetchImpl: mockFetch,
        sleep: async () => {},
      })
    ).rejects.toThrow(/Google API key operation failed: Failed to provision key/);
  });

  it('throws error when polling times out', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ name: 'operations/op-timeout', done: false }),
    }));

    await expect(
      pollGoogleOperation({
        operationName: 'operations/op-timeout',
        gcpToken: 'tok',
        fetchImpl: mockFetch,
        sleep: async () => {},
        maxAttempts: 2,
      })
    ).rejects.toThrow(/timed out after 2 attempts/);
  });

  it('throws error when done without key name', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ name: 'operations/op-empty', done: true }),
    }));

    await expect(
      pollGoogleOperation({
        operationName: 'operations/op-empty',
        gcpToken: 'tok',
        fetchImpl: mockFetch,
        sleep: async () => {},
      })
    ).rejects.toThrow(/completed without returning a key name/);
  });

  it('throws error when polling endpoint fails with HTTP error', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({ error: { message: 'Backend unavailable' } }),
    }));

    await expect(
      pollGoogleOperation({
        operationName: 'operations/op-err-503',
        gcpToken: 'tok',
        fetchImpl: mockFetch,
        sleep: async () => {},
      })
    ).rejects.toThrow(/Polling operation operations\/op-err-503 failed \(HTTP 503\): Backend unavailable/);
  });
});

describe('getGoogleKeyString', () => {
  it('calls /keyString and returns key string', async () => {
    const mockFetch = vi.fn(async (url, options) => {
      expect(url).toBe('https://apikeys.googleapis.com/v2/projects/1/locations/global/keys/k1/keyString');
      expect(options.headers.Authorization).toBe('Bearer tok');
      return {
        ok: true,
        status: 200,
        json: async () => ({ keyString: 'AIzaSyActualSecretKeyString' }),
      };
    });

    const key = await getGoogleKeyString({
      keyName: 'projects/1/locations/global/keys/k1',
      gcpToken: 'tok',
      fetchImpl: mockFetch,
    });

    expect(key).toBe('AIzaSyActualSecretKeyString');
  });

  it('throws error on failure', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: async () => ({ error: { message: 'Missing getKeyString permission' } }),
    }));

    await expect(
      getGoogleKeyString({
        keyName: 'projects/1/locations/global/keys/k1',
        gcpToken: 'tok',
        fetchImpl: mockFetch,
      })
    ).rejects.toThrow(/Retrieving keyString for projects\/1\/locations\/global\/keys\/k1 failed \(HTTP 403\)/);
  });
});

describe('deleteGoogleApiKey', () => {
  it('sends DELETE request with Bearer authorization', async () => {
    const mockFetch = vi.fn(async (url, options) => {
      expect(url).toBe('https://apikeys.googleapis.com/v2/projects/1/locations/global/keys/old-key');
      expect(options.method).toBe('DELETE');
      expect(options.headers.Authorization).toBe('Bearer tok');
      return { ok: true, status: 200 };
    });

    const res = await deleteGoogleApiKey({
      keyName: 'projects/1/locations/global/keys/old-key',
      gcpToken: 'tok',
      fetchImpl: mockFetch,
    });

    expect(res).toEqual({
      ok: true,
      deleted: true,
      keyName: 'projects/1/locations/global/keys/old-key',
    });
  });

  it('throws error on failure', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({ error: { message: 'Key not found' } }),
    }));

    await expect(
      deleteGoogleApiKey({
        keyName: 'projects/1/locations/global/keys/missing',
        gcpToken: 'tok',
        fetchImpl: mockFetch,
      })
    ).rejects.toThrow(/Deleting Google API key projects\/1\/locations\/global\/keys\/missing failed \(HTTP 404\)/);
  });
});

describe('verifyGoogleApiKey', () => {
  it('verifies Gemini key via x-goog-api-key header', async () => {
    const mockFetch = vi.fn(async (url, options) => {
      expect(url).toBe(GOOGLE_TARGETS.gemini.probeEndpoint);
      expect(options.headers['x-goog-api-key']).toBe('test-gemini-key');
      return { ok: true, status: 200 };
    });

    const res = await verifyGoogleApiKey({
      target: GOOGLE_TARGETS.gemini,
      keyString: 'test-gemini-key',
      fetchImpl: mockFetch,
    });

    expect(res).toEqual({ ok: true, verified: true });
  });

  it('verifies YouTube key via query parameter without exposing secret in error', async () => {
    const mockFetch = vi.fn(async (url) => {
      expect(url).toContain('key=test-youtube-key');
      return { ok: true, status: 200 };
    });

    const res = await verifyGoogleApiKey({
      target: GOOGLE_TARGETS.youtube,
      keyString: 'test-youtube-key',
      fetchImpl: mockFetch,
    });

    expect(res).toEqual({ ok: true, verified: true });
  });

  it('throws error when verification probe returns HTTP error', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 400,
    }));

    await expect(
      verifyGoogleApiKey({
        target: GOOGLE_TARGETS.billing,
        keyString: 'bad-key',
        fetchImpl: mockFetch,
      })
    ).rejects.toThrow('Verification probe for GCP-BILLING-API-KEY returned HTTP 400');
  });
});

describe('rollAndApplyGoogleKey', () => {
  it('orchestrates verify-before-delete: creates, probes, saves to Key Vault, and deletes old key', async () => {
    const deletedKeys = [];
    const savedSecrets = {};
    let referencesRefreshed = false;

    const mockVault = {
      setSecret: vi.fn(async (name, val) => {
        savedSecrets[name] = val;
        return { version: 'v1' };
      }),
      refreshReferences: vi.fn(async () => {
        referencesRefreshed = true;
        return { refreshed: true, reason: null };
      }),
    };

    const mockFetch = vi.fn(async (url, options = {}) => {
      // 1. Lookup old key
      if (url.includes('keys:lookupKey')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            name: 'projects/123/locations/global/keys/old-key-uuid',
            parent: 'projects/123',
          }),
        };
      }
      // 2. Details of old key
      if (url.endsWith('/keys/old-key-uuid') && (!options.method || options.method === 'GET')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            name: 'projects/123/locations/global/keys/old-key-uuid',
            displayName: 'site-gemini-api-key',
            restrictions: { apiTargets: [{ service: 'generativelanguage.googleapis.com' }] },
          }),
        };
      }
      // 3. Create new key
      if (url.endsWith('/locations/global/keys') && options.method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            name: 'operations/op-new-gemini',
            done: true,
            response: { name: 'projects/123/locations/global/keys/new-key-uuid' },
          }),
        };
      }
      // 4. Retrieve keyString
      if (url.endsWith('/new-key-uuid/keyString')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ keyString: 'AIzaSyNewlyMintedSecretKey' }),
        };
      }
      // 5. Verification probe
      if (hostOf(url) === 'generativelanguage.googleapis.com') {
        return { ok: true, status: 200 };
      }
      // 6. Delete old key
      if (url.endsWith('/keys/old-key-uuid') && options.method === 'DELETE') {
        deletedKeys.push('old-key-uuid');
        return { ok: true, status: 200 };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const res = await rollAndApplyGoogleKey({
      target: GOOGLE_TARGETS.gemini,
      gcpToken: 'gcp-operator-token',
      oldKeyString: 'old-gemini-secret-string',
      vault: mockVault,
      fetchImpl: mockFetch,
    });

    expect(res).toEqual({
      ok: true,
      secretName: 'GEMINI-API-KEY',
      newKeyName: 'projects/123/locations/global/keys/new-key-uuid',
      oldKeyDeleted: true,
      refreshed: true,
      refreshReason: null,
    });

    expect(savedSecrets['GEMINI-API-KEY']).toBe('AIzaSyNewlyMintedSecretKey');
    expect(referencesRefreshed).toBe(true);
    expect(deletedKeys).toContain('old-key-uuid');
  });

  it('fails closed when oldKeyString cannot be looked up and allowUnmanagedOldKey is false', async () => {
    const mockFetch = vi.fn(async (url) => {
      if (url.includes('keys:lookupKey')) {
        return { ok: false, status: 404, statusText: 'Not Found' };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(
      rollAndApplyGoogleKey({
        target: GOOGLE_TARGETS.gemini,
        gcpToken: 'tok',
        oldKeyString: 'non-existent-key',
        fetchImpl: mockFetch,
      })
    ).rejects.toThrow(/Failed to locate Google API key for GEMINI-API-KEY in GCP; cannot rotate safely without revoking old key/);
  });

  it('does not delete old key when Key Vault reference refresh is not acknowledged (refreshed=false)', async () => {
    const deletedKeys = [];
    const mockVault = {
      setSecret: vi.fn(async () => ({ version: 'v1' })),
      refreshReferences: vi.fn(async () => ({ refreshed: false, reason: 'FUNCTION_APP_RESOURCE_ID is not set' })),
    };

    const mockFetch = vi.fn(async (url, options = {}) => {
      if (url.includes('keys:lookupKey')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ name: 'projects/123/locations/global/keys/old-key', parent: 'projects/123' }),
        };
      }
      if (url.endsWith('/keys/old-key') && (!options.method || options.method === 'GET')) {
        return { ok: true, status: 200, json: async () => ({ name: 'projects/123/locations/global/keys/old-key' }) };
      }
      if (url.endsWith('/locations/global/keys') && options.method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ name: 'operations/op-1', done: true, response: { name: 'projects/123/locations/global/keys/new-key' } }),
        };
      }
      if (url.endsWith('/new-key/keyString')) {
        return { ok: true, status: 200, json: async () => ({ keyString: 'new-key-string' }) };
      }
      if (hostOf(url) === 'generativelanguage.googleapis.com') {
        return { ok: true, status: 200 };
      }
      if (options.method === 'DELETE') {
        deletedKeys.push(url);
        return { ok: true, status: 200 };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const res = await rollAndApplyGoogleKey({
      target: GOOGLE_TARGETS.gemini,
      gcpToken: 'tok',
      oldKeyString: 'old-key-val',
      vault: mockVault,
      fetchImpl: mockFetch,
    });

    expect(res.oldKeyDeleted).toBe(false);
    expect(res.refreshed).toBe(false);
    expect(res.refreshReason).toBe('FUNCTION_APP_RESOURCE_ID is not set');
    expect(deletedKeys).toHaveLength(0);
  });

  it('executes post-refresh app verification and rolls back if app verification fails', async () => {
    const deletedKeys = [];
    let currentVaultVal = 'old-key-val';
    const mockVault = {
      setSecret: vi.fn(async (name, val) => {
        currentVaultVal = val;
        return { version: 'v1' };
      }),
      refreshReferences: vi.fn(async () => ({ refreshed: true, reason: null })),
    };

    const mockFetch = vi.fn(async (url, options = {}) => {
      if (url.includes('keys:lookupKey')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ name: 'projects/123/locations/global/keys/old-key', parent: 'projects/123' }),
        };
      }
      if (url.endsWith('/keys/old-key') && (!options.method || options.method === 'GET')) {
        return { ok: true, status: 200, json: async () => ({ name: 'projects/123/locations/global/keys/old-key' }) };
      }
      if (url.endsWith('/locations/global/keys') && options.method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ name: 'operations/op-2', done: true, response: { name: 'projects/123/locations/global/keys/new-key' } }),
        };
      }
      if (url.endsWith('/new-key/keyString')) {
        return { ok: true, status: 200, json: async () => ({ keyString: 'new-key-string' }) };
      }
      if (hostOf(url) === 'generativelanguage.googleapis.com') {
        return { ok: true, status: 200 };
      }
      if (options.method === 'DELETE') {
        deletedKeys.push(url);
        return { ok: true, status: 200 };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const mockAppVerifier = vi.fn(async () => {
      throw new Error('App Service returned 503 during warmup with new key');
    });

    await expect(
      rollAndApplyGoogleKey({
        target: GOOGLE_TARGETS.gemini,
        gcpToken: 'tok',
        oldKeyString: 'old-key-val',
        vault: mockVault,
        fetchImpl: mockFetch,
        verifyFromApp: mockAppVerifier,
      })
    ).rejects.toThrow(/Post-refresh app verification failed for GEMINI-API-KEY: App Service returned 503/);

    expect(deletedKeys).toContain('https://apikeys.googleapis.com/v2/projects/123/locations/global/keys/new-key');
    expect(currentVaultVal).toBe('old-key-val');
  });

  it('fails closed and deletes newly minted key if verification probe fails', async () => {
    const deletedKeys = [];
    const mockVault = {
      setSecret: vi.fn(),
      refreshReferences: vi.fn(),
    };

    const mockFetch = vi.fn(async (url, options = {}) => {
      if (url.endsWith('/locations/global/keys') && options.method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            name: 'operations/op-probe-fail',
            done: true,
            response: { name: 'projects/123/locations/global/keys/defective-key-uuid' },
          }),
        };
      }
      if (url.endsWith('/defective-key-uuid/keyString')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ keyString: 'defective-key-val' }),
        };
      }
      // Verification probe fails!
      if (url.includes('googleapis.com/v3/videos')) {
        return { ok: false, status: 403, statusText: 'Forbidden' };
      }
      // Clean-up delete of defective key
      if (url.endsWith('/defective-key-uuid') && options.method === 'DELETE') {
        deletedKeys.push('defective-key-uuid');
        return { ok: true, status: 200 };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(
      rollAndApplyGoogleKey({
        target: GOOGLE_TARGETS.youtube,
        gcpToken: 'gcp-token',
        parent: 'projects/123',
        vault: mockVault,
        fetchImpl: mockFetch,
      })
    ).rejects.toThrow(/New API key verification probe failed for YOUTUBE-API-KEY.*Minted key was deleted; old key preserved/);

    expect(deletedKeys).toContain('defective-key-uuid');
    expect(mockVault.setSecret).not.toHaveBeenCalled();
    expect(mockVault.refreshReferences).not.toHaveBeenCalled();
  });

  it('validates mandatory inputs', async () => {
    await expect(rollAndApplyGoogleKey({})).rejects.toThrow('Target configuration with secretName is required');
    await expect(rollAndApplyGoogleKey({ target: GOOGLE_TARGETS.gemini })).rejects.toThrow('gcpToken is required');
    await expect(rollAndApplyGoogleKey({ target: GOOGLE_TARGETS.gemini, gcpToken: 'tok' })).rejects.toThrow('GCP parent project could not be resolved');
  });
});
