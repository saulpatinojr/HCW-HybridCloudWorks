import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import {
  CLOUDFLARE_TARGETS,
  TOKEN_OWNERS,
  tokenOwnerRoutes,
  defaultSpawnRunner,
  rollCloudflareToken,
  verifyCloudflareToken,
  updateTfcVariable,
  updateLabVaultSecret,
  rollAndApplyCloudflareToken,
} from './cloudflare-roll.js';

// A made-up account id of the right shape; never a real one in this public repository.
const ACCOUNT_ID = '00000000000000000000000000000001';

/**
 * A command runner that answers the `sudo -n -l` check made before a roll as
 * allowed, and hands every other call (the vault write) to `write`.
 */
const vaultRunner = (write) =>
  vi.fn(async (params) =>
    params.args?.[1] === '-l' ? { code: 0, stdout: '/usr/local/sbin/hcw-vault-set', stderr: '' } : write(params)
  );

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

  it('says which kind of token each target holds (#1927)', () => {
    // hcw-azure holds the account-owned token `hcw` (observed 2026-11-27).
    expect(CLOUDFLARE_TARGETS.azure).toMatchObject({ owner: 'account', tokenName: 'hcw', tokenNameConfirmed: true });
    // hcw-lab most likely holds a user token; not confirmed.
    expect(CLOUDFLARE_TARGETS.lab).toMatchObject({
      owner: 'user',
      tokenName: 'hcp-terraform-cloudflare-dns',
      tokenNameConfirmed: false,
    });
    expect(CLOUDFLARE_TARGETS.caddy).toMatchObject({ owner: 'user', tokenName: null });
    for (const [key, target] of Object.entries(CLOUDFLARE_TARGETS)) {
      expect(Object.hasOwn(TOKEN_OWNERS, target.owner), key).toBe(true);
    }
  });

  it('is frozen', () => {
    expect(Object.isFrozen(CLOUDFLARE_TARGETS)).toBe(true);
    for (const target of Object.values(CLOUDFLARE_TARGETS)) {
      expect(Object.isFrozen(target)).toBe(true);
    }
  });
});

describe('tokenOwnerRoutes', () => {
  it('knows exactly the two kinds Cloudflare has', () => {
    expect(Object.keys(TOKEN_OWNERS).sort()).toEqual(['account', 'user']);
    expect(Object.isFrozen(TOKEN_OWNERS)).toBe(true);
  });

  it('builds the user and account routes', () => {
    expect(tokenOwnerRoutes({ owner: 'user' }).rollPath({ tokenId: 'tok-1' })).toBe('/user/tokens/tok-1/value');
    expect(tokenOwnerRoutes({ owner: 'user' }).verifyPath({})).toBe('/user/tokens/verify');
    const account = tokenOwnerRoutes({ owner: 'account', accountId: ACCOUNT_ID });
    expect(account.rollPath({ tokenId: 'tok-1', accountId: ACCOUNT_ID })).toBe(`/accounts/${ACCOUNT_ID}/tokens/tok-1/value`);
    expect(account.verifyPath({ accountId: ACCOUNT_ID })).toBe(`/accounts/${ACCOUNT_ID}/tokens/verify`);
  });

  it('refuses an unknown kind, and an account kind without a well-formed account id, without echoing the id', () => {
    expect(() => tokenOwnerRoutes({ owner: 'organisation' })).toThrow(/Unknown Cloudflare token owner kind: 'organisation'/);
    expect(() => tokenOwnerRoutes({ owner: 'toString' })).toThrow(/Unknown Cloudflare token owner kind/);
    expect(() => tokenOwnerRoutes({ owner: 'account' })).toThrow(/needs the Cloudflare account id/);
    const bad = 'NOT-AN-ACCOUNT-ID';
    try {
      tokenOwnerRoutes({ owner: 'account', accountId: bad });
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err.message).toMatch(/set CLOUDFLARE_ACCOUNT_ID/);
      expect(err.message).not.toContain(bad);
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

  it('rolls an account-owned token through the account route (#1927)', async () => {
    const calls = [];
    const mockFetch = vi.fn(async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ success: true, result: 'new-account-token-value' }) };
    });

    const res = await rollCloudflareToken({
      tokenId: 'tok-account-1',
      rollToken: 'operator-account-roll-token',
      owner: 'account',
      accountId: ACCOUNT_ID,
      fetchImpl: mockFetch,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/tokens/tok-account-1/value`);
    expect(calls[0].options.method).toBe('PUT');
    expect(calls[0].options.body).toBe('{}');
    expect(res).toEqual({ tokenId: 'tok-account-1', tokenValue: 'new-account-token-value' });
  });

  it('sends nothing for an account-owned token without the account id', async () => {
    const mockFetch = vi.fn();
    await expect(
      rollCloudflareToken({ tokenId: 'tok-account-1', rollToken: 'op', owner: 'account', fetchImpl: mockFetch })
    ).rejects.toThrow(/needs the Cloudflare account id/);
    expect(mockFetch).not.toHaveBeenCalled();
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

  it('verifies an account-owned token against the account verify endpoint (#1927)', async () => {
    const mockFetch = vi.fn(async (url, options) => {
      expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/tokens/verify`);
      expect(options.headers).toEqual({ Authorization: 'Bearer account-token-to-verify' });
      return { ok: true, status: 200, json: async () => ({ success: true, result: { id: 'tok-a', status: 'active' } }) };
    });

    await expect(
      verifyCloudflareToken({ tokenValue: 'account-token-to-verify', owner: 'account', accountId: ACCOUNT_ID, fetchImpl: mockFetch })
    ).resolves.toEqual({ valid: true, id: 'tok-a', status: 'active' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
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
          json: async () => ({ data: { id: 'ws-azure-123', attributes: { permissions: { 'can-update-variable': true } } } }),
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
          json: async () => ({ data: { id: 'ws-lab-456', attributes: { permissions: { 'can-update-variable': true } } } }),
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

  it('throws error when HCP Terraform PATCH fails', async () => {
    const mockFetch = vi.fn(async (url, options) => {
      if (url.includes('/organizations/hcw/workspaces/hcw-azure')) {
        return { ok: true, status: 200, json: async () => ({ data: { id: 'ws-1', attributes: { permissions: { 'can-update-variable': true } } } }) };
      }
      if (url.includes('/workspaces/ws-1/vars') && (!options?.method || options?.method === 'GET')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ id: 'var-1', attributes: { key: 'cloudflare_api_token', category: 'terraform' } }],
          }),
        };
      }
      if (url.includes('/vars/var-1') && options.method === 'PATCH') {
        return {
          ok: false,
          status: 422,
          statusText: 'Unprocessable Entity',
          json: async () => ({ errors: [{ detail: 'Variable locked by active run' }] }),
        };
      }
      throw new Error(`Unexpected call: ${url}`);
    });

    await expect(
      updateTfcVariable({
        tfcToken: 'tok',
        organization: 'hcw',
        workspace: 'hcw-azure',
        key: 'cloudflare_api_token',
        value: 'val',
        fetchImpl: mockFetch,
      })
    ).rejects.toThrow(/HCP Terraform update variable cloudflare_api_token in hcw\/hcw-azure failed \(422\): Variable locked by active run/);
  });

  it('throws error when HCP Terraform POST fails', async () => {
    const mockFetch = vi.fn(async (url, options) => {
      if (url.includes('/organizations/hcw/workspaces/hcw-azure')) {
        return { ok: true, status: 200, json: async () => ({ data: { id: 'ws-1', attributes: { permissions: { 'can-update-variable': true } } } }) };
      }
      if (url.includes('/workspaces/ws-1/vars') && options.method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      }
      if (url.includes('/workspaces/ws-1/vars') && options.method === 'POST') {
        return {
          ok: false,
          status: 403,
          statusText: 'Forbidden',
          json: async () => ({ errors: [{ title: 'Insufficient permissions' }] }),
        };
      }
      throw new Error(`Unexpected call: ${url}`);
    });

    await expect(
      updateTfcVariable({
        tfcToken: 'tok',
        organization: 'hcw',
        workspace: 'hcw-azure',
        key: 'cloudflare_api_token',
        value: 'val',
        fetchImpl: mockFetch,
      })
    ).rejects.toThrow(/HCP Terraform create variable cloudflare_api_token in hcw\/hcw-azure failed \(403\): Insufficient permissions/);
  });

  it('throws error when HCP Terraform workspace lookup fails', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({ errors: [{ detail: 'Workspace not found' }] }),
    }));

    await expect(
      updateTfcVariable({
        tfcToken: 'tok',
        organization: 'hcw',
        workspace: 'missing-ws',
        key: 'cloudflare_api_token',
        value: 'val',
        fetchImpl: mockFetch,
      })
    ).rejects.toThrow(/HCP Terraform workspace hcw\/missing-ws lookup failed \(404\): Workspace not found/);
  });

  it('throws error when HCP Terraform list vars fails', async () => {
    const mockFetch = vi.fn(async (url) => {
      if (url.includes('/organizations/hcw/workspaces/hcw-azure')) {
        return { ok: true, status: 200, json: async () => ({ data: { id: 'ws-1', attributes: { permissions: { 'can-update-variable': true } } } }) };
      }
      return {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => ({ errors: [{ title: 'Internal error' }] }),
      };
    });

    await expect(
      updateTfcVariable({
        tfcToken: 'tok',
        organization: 'hcw',
        workspace: 'hcw-azure',
        key: 'cloudflare_api_token',
        value: 'val',
        fetchImpl: mockFetch,
      })
    ).rejects.toThrow(/HCP Terraform list vars failed for hcw\/hcw-azure \(500\): Internal error/);
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
      stderr: 'hcw-vault-set: no vault password at /etc/hcw/ansible/vault-password',
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

describe('defaultSpawnRunner', () => {
  it('writes stdin and captures stdout on close 0', async () => {
    const mockProc = new EventEmitter();
    mockProc.stdout = new EventEmitter();
    mockProc.stderr = new EventEmitter();
    mockProc.stdin = new EventEmitter();
    mockProc.stdin.end = vi.fn();
    const mockSpawn = vi.fn().mockReturnValue(mockProc);

    const promise = defaultSpawnRunner({
      command: 'echo',
      args: ['hello'],
      stdin: 'input-data',
      spawnImpl: mockSpawn,
    });

    mockProc.stdout.emit('data', 'output-data');
    mockProc.emit('close', 0);

    const res = await promise;
    expect(res).toEqual({ code: 0, stdout: 'output-data', stderr: '' });
    expect(mockProc.stdin.end).toHaveBeenCalledWith('input-data');
  });

  it('captures stderr and non-zero exit code, ignoring stdin EPIPE', async () => {
    const mockProc = new EventEmitter();
    mockProc.stdout = new EventEmitter();
    mockProc.stderr = new EventEmitter();
    mockProc.stdin = new EventEmitter();
    mockProc.stdin.end = vi.fn();
    const mockSpawn = vi.fn().mockReturnValue(mockProc);

    const promise = defaultSpawnRunner({
      command: 'bad-cmd',
      args: [],
      stdin: 'input',
      spawnImpl: mockSpawn,
    });

    mockProc.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    mockProc.stderr.emit('data', 'error occurred');
    mockProc.emit('close', 1);

    const res = await promise;
    expect(res).toEqual({ code: 1, stdout: '', stderr: 'error occurred' });
  });

  it('rejects on a stdin error other than EPIPE, even when the child then exits 0', async () => {
    const mockProc = new EventEmitter();
    mockProc.stdout = new EventEmitter();
    mockProc.stderr = new EventEmitter();
    mockProc.stdin = new EventEmitter();
    mockProc.stdin.end = vi.fn();
    const mockSpawn = vi.fn().mockReturnValue(mockProc);

    const promise = defaultSpawnRunner({
      command: 'hcw-vault-set',
      args: ['vault_key'],
      stdin: 'secret',
      spawnImpl: mockSpawn,
    });

    mockProc.stdin.emit('error', Object.assign(new Error('write ECONNRESET'), { code: 'ECONNRESET' }));
    mockProc.emit('close', 0);

    await expect(promise).rejects.toThrow('write ECONNRESET');
  });

  it('rejects on proc error event', async () => {
    const mockProc = new EventEmitter();
    mockProc.stdout = new EventEmitter();
    mockProc.stderr = new EventEmitter();
    mockProc.stdin = new EventEmitter();
    mockProc.stdin.end = vi.fn();
    const mockSpawn = vi.fn().mockReturnValue(mockProc);

    const promise = defaultSpawnRunner({
      command: 'missing-cmd',
      args: [],
      stdin: 'input',
      spawnImpl: mockSpawn,
    });

    mockProc.emit('error', new Error('spawn ENOENT'));

    await expect(promise).rejects.toThrow('spawn ENOENT');
  });
});

describe('rollAndApplyCloudflareToken', () => {
  it('orchestrates rolling, verifying, and writing to HCP Terraform, through the account route for hcw-azure', async () => {
    const cloudflareUrls = [];
    const mockFetch = vi.fn(async (url, options) => {
      if (url.startsWith('https://api.cloudflare.com/')) cloudflareUrls.push(url);
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
          json: async () => ({ data: { id: 'ws-azure', attributes: { permissions: { 'can-update-variable': true } } } }),
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
      accountId: ACCOUNT_ID,
      tfcToken: 'tfc-token-xyz',
      fetchImpl: mockFetch,
    });

    expect(cloudflareUrls).toEqual([
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/tokens/tok-azure-1/value`,
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/tokens/verify`,
    ]);
    expect(JSON.stringify(res)).not.toContain('newly-rolled-azure-token');
    expect(res).toEqual({
      ok: true,
      tokenId: 'tok-azure-1',
      targetType: 'tfc',
      targetName: 'Azure HCP Terraform workspace (hcw/hcw-azure)',
      action: 'updated',
      verified: true,
    });
  });

  it('orchestrates rolling, verifying, and writing to lab host vault, through the user route', async () => {
    const mockFetch = vi.fn(async (url) => {
      expect(url.startsWith('https://api.cloudflare.com/client/v4/user/tokens/')).toBe(true);
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

    const mockExec = vaultRunner(async (params) => {
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
    const mockExec = vaultRunner(async (params) => {
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

    const mockExec = vaultRunner(async () => {
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

  it('refuses an account-owned target without the account id BEFORE rolling, so the old token still works', async () => {
    const mockFetch = vi.fn();
    await expect(
      rollAndApplyCloudflareToken({
        tokenId: 'tok-azure-1',
        rollToken: 'operator-roll-token',
        target: CLOUDFLARE_TARGETS.azure,
        tfcToken: 'tfc-token-xyz',
        fetchImpl: mockFetch,
      })
    ).rejects.toThrow(/needs the Cloudflare account id/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses an unknown token kind or store BEFORE rolling', async () => {
    const mockFetch = vi.fn();
    await expect(
      rollAndApplyCloudflareToken({
        tokenId: 't1',
        rollToken: 'r1',
        target: { ...CLOUDFLARE_TARGETS.lab, owner: 'organisation' },
        tfcToken: 'tfc',
        fetchImpl: mockFetch,
      })
    ).rejects.toThrow(/Unknown Cloudflare token owner kind/);
    await expect(
      rollAndApplyCloudflareToken({ tokenId: 't1', rollToken: 'r1', target: { type: 'kv' }, fetchImpl: mockFetch })
    ).rejects.toThrow(/Unsupported target type: kv/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses a target without `owner` instead of taking it for a user token (#1927)', async () => {
    const mockFetch = vi.fn();
    const { owner, ...ownerless } = CLOUDFLARE_TARGETS.caddy;
    expect(owner).toBe('user');
    await expect(
      rollAndApplyCloudflareToken({ tokenId: 't1', rollToken: 'r1', target: ownerless, fetchImpl: mockFetch, execImpl: vi.fn() })
    ).rejects.toThrow(/does not say which kind of Cloudflare token it holds/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses a tfc target without an HCP Terraform token, or without a workspace, BEFORE rolling', async () => {
    const mockFetch = vi.fn();
    await expect(
      rollAndApplyCloudflareToken({ tokenId: 't1', rollToken: 'r1', target: CLOUDFLARE_TARGETS.lab, fetchImpl: mockFetch })
    ).rejects.toThrow(/HCP Terraform token is required/);
    await expect(
      rollAndApplyCloudflareToken({
        tokenId: 't1',
        rollToken: 'r1',
        target: { ...CLOUDFLARE_TARGETS.lab, workspace: '' },
        tfcToken: 'tfc',
        fetchImpl: mockFetch,
      })
    ).rejects.toThrow(/HCP Terraform workspace is required/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses a lab-vault target with a malformed vault key BEFORE rolling', async () => {
    const mockFetch = vi.fn();
    const execImpl = vi.fn();
    await expect(
      rollAndApplyCloudflareToken({
        tokenId: 't1',
        rollToken: 'r1',
        target: { ...CLOUDFLARE_TARGETS.caddy, vaultKey: 'Not A Key' },
        fetchImpl: mockFetch,
        execImpl,
      })
    ).rejects.toThrow(/Invalid lab vault key name/);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(execImpl).not.toHaveBeenCalled();
  });

  it('looks the workspace up BEFORE rolling, and rolls nothing when HCP Terraform answers 403 (#1927)', async () => {
    const mockFetch = vi.fn(async (url) => {
      if (url.includes('/organizations/hcw/workspaces/hcw-azure')) {
        return { ok: false, status: 403, statusText: 'Forbidden', json: async () => ({ errors: [{ title: 'forbidden' }] }) };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    await expect(
      rollAndApplyCloudflareToken({
        tokenId: 'tok-azure-1',
        rollToken: 'operator-roll-token',
        target: CLOUDFLARE_TARGETS.azure,
        accountId: ACCOUNT_ID,
        tfcToken: 'tfc-token-xyz',
        fetchImpl: mockFetch,
      })
    ).rejects.toThrow(/HCP Terraform workspace hcw\/hcw-azure lookup failed \(403\)/);
    const cloudflareCalls = mockFetch.mock.calls.filter(([url]) => url.startsWith('https://api.cloudflare.com/'));
    expect(cloudflareCalls).toEqual([]);
  });

  it('rolls nothing when HCP Terraform says the token cannot write variables (can-update-variable false) (#1927)', async () => {
    for (const permissions of [{ 'can-update-variable': false }, {}, { 'can-update-variable': 'true' }]) {
      const mockFetch = vi.fn(async (url) => {
        if (url.includes('/organizations/hcw/workspaces/hcw-azure')) {
          return { ok: true, status: 200, json: async () => ({ data: { id: 'ws-azure', attributes: { permissions } } }) };
        }
        if (url.endsWith('/workspaces/ws-azure/vars')) {
          return { ok: true, status: 200, json: async () => ({ data: [] }) };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });
      await expect(
        rollAndApplyCloudflareToken({
          tokenId: 'tok-azure-1',
          rollToken: 'operator-roll-token',
          target: CLOUDFLARE_TARGETS.azure,
          accountId: ACCOUNT_ID,
          tfcToken: 'tfc-read-only-token',
          fetchImpl: mockFetch,
        })
      ).rejects.toThrow('the HCP Terraform token cannot write variables in hcw/hcw-azure; nothing was rolled');
      expect(mockFetch.mock.calls.filter(([url]) => url.startsWith('https://api.cloudflare.com/'))).toEqual([]);
    }
  });

  it('rolls nothing when the workspace has no variable for the roll to replace (#1927)', async () => {
    // A same-named variable in the other category does not count either.
    for (const variables of [[], [{ id: 'var-env', attributes: { key: 'cloudflare_api_token', category: 'env' } }]]) {
      const mockFetch = vi.fn(async (url) => {
        if (url.includes('/organizations/hcw/workspaces/hcw-azure')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: { id: 'ws-azure', attributes: { permissions: { 'can-update-variable': true } } } }),
          };
        }
        if (url.endsWith('/workspaces/ws-azure/vars')) {
          return { ok: true, status: 200, json: async () => ({ data: variables }) };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });
      await expect(
        rollAndApplyCloudflareToken({
          tokenId: 'tok-azure-1',
          rollToken: 'operator-roll-token',
          target: CLOUDFLARE_TARGETS.azure,
          accountId: ACCOUNT_ID,
          tfcToken: 'tfc-token-xyz',
          fetchImpl: mockFetch,
        })
      ).rejects.toThrow('hcw/hcw-azure has no terraform variable cloudflare_api_token to replace');
      expect(mockFetch.mock.calls.filter(([url]) => url.startsWith('https://api.cloudflare.com/'))).toEqual([]);
    }
  });

  it('never creates the variable after a roll, even when it disappeared after the check (#1927)', async () => {
    const present = [{ id: 'var-1', attributes: { key: 'cloudflare_api_token', category: 'terraform' } }];
    let listReads = 0;
    const mockFetch = vi.fn(async (url, options = {}) => {
      if (url.includes('/organizations/hcw/workspaces/hcw-azure')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { id: 'ws-azure', attributes: { permissions: { 'can-update-variable': true } } } }),
        };
      }
      if (url.endsWith('/workspaces/ws-azure/vars') && (options.method || 'GET') === 'GET') {
        listReads += 1;
        // The check sees the variable; every read after the roll does not.
        return { ok: true, status: 200, json: async () => ({ data: listReads === 1 ? present : [] }) };
      }
      if (url.includes('/value')) {
        return { ok: true, status: 200, json: async () => ({ success: true, result: 'new-secret-value' }) };
      }
      throw new Error(`Unexpected call: ${options.method} ${url}`);
    });
    const error = await rollAndApplyCloudflareToken({
      tokenId: 'tok-azure-1',
      rollToken: 'operator-roll-token',
      target: CLOUDFLARE_TARGETS.azure,
      accountId: ACCOUNT_ID,
      tfcToken: 'tfc-token-xyz',
      fetchImpl: mockFetch,
      sleep: async () => {},
    }).catch((err) => err);
    expect(error.message).toContain('no longer has the terraform variable cloudflare_api_token; the new value was not written');
    expect(error.message).not.toContain('new-secret-value');
    expect(mockFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toEqual([]);
  });

  it('rolls nothing when sudo does not allow hcw-vault-set for the caddy target (#1927)', async () => {
    const mockFetch = vi.fn();
    const calls = [];
    const execImpl = vi.fn(async (params) => {
      calls.push(params);
      return { code: 1, stdout: '', stderr: 'Sorry, user may not run sudo' };
    });
    await expect(
      rollAndApplyCloudflareToken({ tokenId: 't1', rollToken: 'r1', target: CLOUDFLARE_TARGETS.caddy, fetchImpl: mockFetch, execImpl })
    ).rejects.toThrow(/sudo does not allow \/usr\/local\/sbin\/hcw-vault-set without a password here .*nothing was rolled/);
    expect(mockFetch).not.toHaveBeenCalled();
    // Only the check ran: `sudo -n -l <helper>`, with nothing on stdin.
    expect(calls).toEqual([{ command: 'sudo', args: ['-n', '-l', '/usr/local/sbin/hcw-vault-set'], stdin: '' }]);
  });

  it('rolls nothing when listing the workspace variables is refused', async () => {
    const mockFetch = vi.fn(async (url) => {
      if (url.includes('/organizations/hcw/workspaces/hcw-lab')) {
        return { ok: true, status: 200, json: async () => ({ data: { id: 'ws-lab', attributes: { permissions: { 'can-update-variable': true } } } }) };
      }
      if (url.endsWith('/workspaces/ws-lab/vars')) {
        return { ok: false, status: 403, statusText: 'Forbidden', json: async () => ({}) };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    await expect(
      rollAndApplyCloudflareToken({ tokenId: 't1', rollToken: 'r1', target: CLOUDFLARE_TARGETS.lab, tfcToken: 'tfc', fetchImpl: mockFetch })
    ).rejects.toThrow(/list vars failed for hcw\/hcw-lab \(403\)/);
    expect(mockFetch.mock.calls.some(([url]) => url.startsWith('https://api.cloudflare.com/'))).toBe(false);
  });

  it('rejects missing target or unsupported target type', async () => {
    await expect(
      rollAndApplyCloudflareToken({
        tokenId: 't1',
        rollToken: 'r1',
        target: null,
      })
    ).rejects.toThrow('Target configuration is required');

    await expect(
      rollAndApplyCloudflareToken({
        tokenId: 't1',
        rollToken: 'r1',
        target: { type: 'unsupported_provider' },
        fetchImpl: vi.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => ({ success: true, result: 'new-tok' }),
        })),
        sleep: async () => {},
      })
    ).rejects.toThrow(/Unsupported target type: unsupported_provider/);
  });
});
