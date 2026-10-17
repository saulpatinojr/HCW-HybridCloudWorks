/**
 * Unit tests for functions/src/lib/credentials/cloudflare-roll.js (#1027).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  CLOUDFLARE_TARGETS,
  rollCloudflareToken,
  verifyCloudflareToken,
  updateTfcVariable,
  updateLabVaultSecret,
  rollAndApplyCloudflareToken,
} from './cloudflare-roll.js';

describe('CLOUDFLARE_TARGETS', () => {
  it('declares the three approved targets with required metadata', () => {
    expect(Object.keys(CLOUDFLARE_TARGETS).sort()).toEqual(['azure', 'caddy', 'lab']);

    const azure = CLOUDFLARE_TARGETS.azure;
    expect(azure.id).toBe('tfc-azure-cloudflare-api-token');
    expect(azure.type).toBe('tfc');
    expect(azure.workspace).toBe('hcw-azure');
    expect(azure.key).toBe('cloudflare_api_token');
    expect(azure.sensitive).toBe(true);

    const lab = CLOUDFLARE_TARGETS.lab;
    expect(lab.id).toBe('tfc-lab-cloudflare-api-token');
    expect(lab.type).toBe('tfc');
    expect(lab.workspace).toBe('hcw-lab');
    expect(lab.key).toBe('cloudflare_api_token');
    expect(lab.sensitive).toBe(true);

    const caddy = CLOUDFLARE_TARGETS.caddy;
    expect(caddy.id).toBe('lab-caddy-cloudflare-api-token');
    expect(caddy.type).toBe('lab-vault');
    expect(caddy.vaultKey).toBe('vault_cloudflare_api_token');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(CLOUDFLARE_TARGETS)).toBe(true);
    for (const target of Object.values(CLOUDFLARE_TARGETS)) {
      expect(Object.isFrozen(target)).toBe(true);
    }
  });
});

describe('rollCloudflareToken', () => {
  it('requires tokenId and rollToken', async () => {
    await expect(rollCloudflareToken({})).rejects.toThrow(/tokenId is required/);
    await expect(rollCloudflareToken({ tokenId: 'tok-123' })).rejects.toThrow(/rollToken is required/);
  });

  it('calls Cloudflare roll-token API with empty JSON body and Bearer auth', async () => {
    let capturedUrl = null;
    let capturedOptions = null;

    const mockFetch = vi.fn(async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          errors: [],
          messages: [],
          result: 'new-secret-token-xyz',
        }),
      };
    });

    const res = await rollCloudflareToken({
      tokenId: 'tok-1234567890abcdef',
      rollToken: 'operator-roll-token',
      fetchImpl: mockFetch,
    });

    expect(capturedUrl).toBe('https://api.cloudflare.com/client/v4/user/tokens/tok-1234567890abcdef/value');
    expect(capturedOptions.method).toBe('PUT');
    expect(capturedOptions.headers).toEqual({
      Authorization: 'Bearer operator-roll-token',
      'Content-Type': 'application/json',
    });
    expect(capturedOptions.body).toBe('{}');
    expect(res).toEqual({
      tokenId: 'tok-1234567890abcdef',
      tokenValue: 'new-secret-token-xyz',
    });
  });

  it('supports result as an object with value property', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: { value: 'nested-token-value' },
      }),
    }));

    const res = await rollCloudflareToken({
      tokenId: 'tok-nested',
      rollToken: 'op-token',
      fetchImpl: mockFetch,
    });

    expect(res.tokenValue).toBe('nested-token-value');
  });

  it('fails with clear error when Cloudflare rejects the request', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: async () => ({
        success: false,
        errors: [{ code: 1000, message: 'Invalid token permissions' }],
      }),
    }));

    await expect(
      rollCloudflareToken({
        tokenId: 'tok-bad',
        rollToken: 'unauthorized-token',
        fetchImpl: mockFetch,
      })
    ).rejects.toThrow(/Cloudflare roll-token request failed \(403\): Invalid token permissions/);
  });

  it('fails if response contains no new token secret', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: null,
      }),
    }));

    await expect(
      rollCloudflareToken({
        tokenId: 'tok-empty',
        rollToken: 'valid-roll-token',
        fetchImpl: mockFetch,
      })
    ).rejects.toThrow(/response did not contain a valid token secret/);
  });
});

describe('verifyCloudflareToken', () => {
  it('requires tokenValue', async () => {
    await expect(verifyCloudflareToken({})).rejects.toThrow(/tokenValue is required/);
  });

  it('verifies token against Cloudflare verify endpoint', async () => {
    const mockFetch = vi.fn(async (url, options) => {
      expect(url).toBe('https://api.cloudflare.com/client/v4/user/tokens/verify');
      expect(options.method).toBe('GET');
      expect(options.headers).toEqual({
        Authorization: 'Bearer test-verify-token',
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: { id: 'tok-verified-id', status: 'active' },
        }),
      };
    });

    const res = await verifyCloudflareToken({
      tokenValue: 'test-verify-token',
      fetchImpl: mockFetch,
    });

    expect(res).toEqual({
      valid: true,
      id: 'tok-verified-id',
      status: 'active',
    });
  });

  it('fails if token status is not active', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: { id: 'tok-disabled', status: 'disabled' },
      }),
    }));

    await expect(
      verifyCloudflareToken({
        tokenValue: 'test-token',
        fetchImpl: mockFetch,
      })
    ).rejects.toThrow(/Cloudflare token is not active \(status: disabled\)/);
  });

  it('fails on HTTP 401 Unauthorized', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({
        success: false,
        errors: [{ code: 6003, message: 'Invalid request headers' }],
      }),
    }));

    await expect(
      verifyCloudflareToken({
        tokenValue: 'invalid-token',
        fetchImpl: mockFetch,
      })
    ).rejects.toThrow(/Cloudflare token verification failed \(401\)/);
  });
});

describe('updateTfcVariable', () => {
  it('validates mandatory arguments', async () => {
    await expect(updateTfcVariable({})).rejects.toThrow(/HCP Terraform token is required/);
    await expect(updateTfcVariable({ tfcToken: 'x' })).rejects.toThrow(/organization is required/);
    await expect(updateTfcVariable({ tfcToken: 'x', organization: 'hcw' })).rejects.toThrow(/workspace is required/);
    await expect(
      updateTfcVariable({ tfcToken: 'x', organization: 'hcw', workspace: 'hcw-azure' })
    ).rejects.toThrow(/Variable key is required/);
    await expect(
      updateTfcVariable({ tfcToken: 'x', organization: 'hcw', workspace: 'hcw-azure', key: 'k' })
    ).rejects.toThrow(/Variable value is required/);
  });

  it('updates existing variable via PATCH using JSON:API media type', async () => {
    const calls = [];
    const mockFetch = vi.fn(async (url, options) => {
      calls.push({ url, options });
      if (url.includes('/organizations/hcw/workspaces/hcw-azure')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { id: 'ws-azure-123' } }),
        };
      }
      if (url.includes('/workspaces/ws-azure-123/vars') && options.method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                id: 'var-existing-999',
                type: 'vars',
                attributes: { key: 'cloudflare_api_token', category: 'terraform' },
              },
            ],
          }),
        };
      }
      if (url.includes('/workspaces/ws-azure-123/vars/var-existing-999') && options.method === 'PATCH') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { id: 'var-existing-999' } }),
        };
      }
      throw new Error(`Unexpected call: ${url}`);
    });

    const res = await updateTfcVariable({
      tfcToken: 'tfc-secret-token',
      organization: 'hcw',
      workspace: 'hcw-azure',
      key: 'cloudflare_api_token',
      value: 'new-cf-token-val',
      description: 'Cloudflare DNS token',
      fetchImpl: mockFetch,
    });

    expect(res).toEqual({
      ok: true,
      action: 'updated',
      variableId: 'var-existing-999',
      key: 'cloudflare_api_token',
      category: 'terraform',
      workspace: 'hcw/hcw-azure',
    });

    // Check JSON:API headers on PATCH
    const patchCall = calls.find((c) => c.options.method === 'PATCH');
    expect(patchCall.options.headers['Content-Type']).toBe('application/vnd.api+json');
    expect(patchCall.options.headers.Authorization).toBe('Bearer tfc-secret-token');

    const patchBody = JSON.parse(patchCall.options.body);
    expect(patchBody).toEqual({
      data: {
        id: 'var-existing-999',
        type: 'vars',
        attributes: {
          key: 'cloudflare_api_token',
          value: 'new-cf-token-val',
          category: 'terraform',
          sensitive: true,
          hcl: false,
          description: 'Cloudflare DNS token',
        },
      },
    });
  });

  it('creates new variable via POST when not previously existing', async () => {
    const calls = [];
    const mockFetch = vi.fn(async (url, options) => {
      calls.push({ url, options });
      if (url.includes('/organizations/hcw/workspaces/hcw-lab')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { id: 'ws-lab-456' } }),
        };
      }
      if (url.includes('/workspaces/ws-lab-456/vars') && options.method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        };
      }
      if (url.includes('/workspaces/ws-lab-456/vars') && options.method === 'POST') {
        return {
          ok: true,
          status: 201,
          json: async () => ({ data: { id: 'var-new-777' } }),
        };
      }
      throw new Error(`Unexpected call: ${url}`);
    });

    const res = await updateTfcVariable({
      tfcToken: 'tfc-secret-token',
      organization: 'hcw',
      workspace: 'hcw-lab',
      key: 'cloudflare_api_token',
      value: 'lab-cf-token-val',
      fetchImpl: mockFetch,
    });

    expect(res).toEqual({
      ok: true,
      action: 'created',
      variableId: 'var-new-777',
      key: 'cloudflare_api_token',
      category: 'terraform',
      workspace: 'hcw/hcw-lab',
    });
  });
});

describe('updateLabVaultSecret', () => {
  it('validates vault key name pattern', async () => {
    await expect(
      updateLabVaultSecret({ vaultKey: 'bad_key', secretValue: 'val' })
    ).rejects.toThrow(/Invalid lab vault key name/);
    await expect(
      updateLabVaultSecret({ vaultKey: 'vault_bad-name', secretValue: 'val' })
    ).rejects.toThrow(/Invalid lab vault key name/);
    await expect(
      updateLabVaultSecret({ vaultKey: 'vault_ok_key', secretValue: '' })
    ).rejects.toThrow(/Secret value must be a non-empty string/);
  });

  it('passes secret strictly on stdin to sudo -n /usr/local/sbin/hcw-vault-set', async () => {
    let captured = null;
    const mockExec = vi.fn(async (params) => {
      captured = params;
      return { code: 0, stdout: 'hcw-vault-set: set vault_cloudflare_api_token', stderr: '' };
    });

    const res = await updateLabVaultSecret({
      vaultKey: 'vault_cloudflare_api_token',
      secretValue: 'super-secret-caddy-token',
      execImpl: mockExec,
    });

    expect(res).toEqual({
      ok: true,
      action: 'updated',
      key: 'vault_cloudflare_api_token',
    });

    expect(captured.command).toBe('sudo');
    expect(captured.args).toEqual(['-n', '/usr/local/sbin/hcw-vault-set', 'vault_cloudflare_api_token']);
    // Value is strictly on stdin, NEVER in args
    expect(captured.args).not.toContain('super-secret-caddy-token');
    expect(captured.stdin).toBe('super-secret-caddy-token');
  });

  it('fails if hcw-vault-set exits with non-zero status', async () => {
    const mockExec = vi.fn(async () => ({
      code: 2,
      stdout: '',
      stderr: 'hcw-vault-set: no vault password at /etc/hcw/ansible/.vault_password',
    }));

    await expect(
      updateLabVaultSecret({
        vaultKey: 'vault_cloudflare_api_token',
        secretValue: 'secret-val',
        execImpl: mockExec,
      })
    ).rejects.toThrow(/hcw-vault-set failed \(exit code 2\)/);
  });
});

describe('rollAndApplyCloudflareToken', () => {
  it('orchestrates rolling, verifying, and writing to HCP Terraform', async () => {
    const mockFetch = vi.fn(async (url, options) => {
      // 1. Roll endpoint
      if (url.includes('/tokens/tok-azure-1/value')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, result: 'newly-rolled-azure-token' }),
        };
      }
      // 2. Verify endpoint
      if (url.includes('/tokens/verify')) {
        expect(options.headers.Authorization).toBe('Bearer newly-rolled-azure-token');
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, result: { id: 'tok-azure-1', status: 'active' } }),
        };
      }
      // 3. TFC workspace lookup
      if (url.includes('/organizations/hcw/workspaces/hcw-azure')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { id: 'ws-azure' } }),
        };
      }
      // 4. TFC list vars
      if (url.includes('/workspaces/ws-azure/vars') && options.method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ id: 'var-cf-1', attributes: { key: 'cloudflare_api_token', category: 'terraform' } }],
          }),
        };
      }
      // 5. TFC patch
      if (url.includes('/workspaces/ws-azure/vars/var-cf-1') && options.method === 'PATCH') {
        const body = JSON.parse(options.body);
        expect(body.data.attributes.value).toBe('newly-rolled-azure-token');
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { id: 'var-cf-1' } }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const res = await rollAndApplyCloudflareToken({
      tokenId: 'tok-azure-1',
      rollToken: 'operator-roll-token',
      target: CLOUDFLARE_TARGETS.azure,
      tfcToken: 'tfc-token-xyz',
      fetchImpl: mockFetch,
    });

    expect(res).toEqual({
      ok: true,
      tokenId: 'tok-azure-1',
      targetType: 'tfc',
      targetName: 'Azure HCP Terraform workspace (hcw/hcw-azure)',
      action: 'updated',
      verified: true,
    });
  });

  it('orchestrates rolling, verifying, and writing to lab host vault', async () => {
    const mockFetch = vi.fn(async (url) => {
      if (url.includes('/tokens/tok-caddy-1/value')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, result: 'newly-rolled-caddy-token' }),
        };
      }
      if (url.includes('/tokens/verify')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, result: { id: 'tok-caddy-1', status: 'active' } }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const mockExec = vi.fn(async (params) => {
      expect(params.stdin).toBe('newly-rolled-caddy-token');
      expect(params.args).toEqual(['-n', '/usr/local/sbin/hcw-vault-set', 'vault_cloudflare_api_token']);
      return { code: 0, stdout: 'ok', stderr: '' };
    });

    const res = await rollAndApplyCloudflareToken({
      tokenId: 'tok-caddy-1',
      rollToken: 'operator-roll-token',
      target: CLOUDFLARE_TARGETS.caddy,
      fetchImpl: mockFetch,
      execImpl: mockExec,
    });

    expect(res).toEqual({
      ok: true,
      tokenId: 'tok-caddy-1',
      targetType: 'lab-vault',
      targetName: 'Lab host Ansible Vault (vault_cloudflare_api_token)',
      action: 'updated',
      verified: true,
    });
  });

  it('writes to target and reports warning if post-write verification fails', async () => {
    const mockFetch = vi.fn(async (url) => {
      if (url.includes('/tokens/tok-warn/value')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, result: 'rolled-token-needs-verification-warning' }),
        };
      }
      if (url.includes('/tokens/verify')) {
        return {
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          json: async () => ({ success: false, errors: [{ message: 'Verification endpoint error' }] }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    let vaultWritten = false;
    const mockExec = vi.fn(async (params) => {
      expect(params.stdin).toBe('rolled-token-needs-verification-warning');
      vaultWritten = true;
      return { code: 0, stdout: 'ok', stderr: '' };
    });

    const res = await rollAndApplyCloudflareToken({
      tokenId: 'tok-warn',
      rollToken: 'roll-tok',
      target: CLOUDFLARE_TARGETS.caddy,
      fetchImpl: mockFetch,
      execImpl: mockExec,
    });

    expect(vaultWritten).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.verified).toBe(false);
    expect(res.warning).toContain('post-write verification returned');
  });

  it('throws error if writing to target fails after retries', async () => {
    const mockFetch = vi.fn(async (url) => {
      if (url.includes('/tokens/tok-write-fail/value')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, result: 'valid-token' }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const mockExec = vi.fn(async () => {
      return { code: 2, stdout: '', stderr: 'vault permission denied' };
    });

    await expect(
      rollAndApplyCloudflareToken({
        tokenId: 'tok-write-fail',
        rollToken: 'roll-tok',
        target: CLOUDFLARE_TARGETS.caddy,
        fetchImpl: mockFetch,
        execImpl: mockExec,
        sleep: async () => {},
      })
    ).rejects.toThrow(/Token was rolled in Cloudflare but failed to write to target/);
  });
});
