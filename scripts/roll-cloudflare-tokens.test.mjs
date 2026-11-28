/**
 * Tests for scripts/roll-cloudflare-tokens.mjs (#1027).
 */

import { describe, it, expect, vi } from 'vitest';
import { parseArgs, printUsage, runRoll } from './roll-cloudflare-tokens.mjs';

// A made-up account id of the right shape; never a real one in this public repository.
const ACCOUNT_ID = '00000000000000000000000000000001';

describe('parseArgs', () => {
  it('defaults to all targets and false flags', () => {
    const opts = parseArgs([]);
    expect(opts).toEqual({
      target: 'all',
      tokenId: null,
      dryRun: false,
      check: false,
      help: false,
      invalid: null,
    });
  });

  it('parses valid options without secrets in argv', () => {
    const opts = parseArgs([
      '--target', 'azure',
      '--token-id', 'tok-abc',
      '--dry-run',
      '--check',
    ]);
    expect(opts).toEqual({
      target: 'azure',
      tokenId: 'tok-abc',
      dryRun: true,
      check: true,
      help: false,
      invalid: null,
    });
  });

  it('handles help flags', () => {
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it('flags unrecognized option', () => {
    const opts = parseArgs(['--unknown-flag']);
    expect(opts.invalid).toContain("Unrecognized option: '--unknown-flag'");
  });

  it('flags missing operand for --target', () => {
    const opts = parseArgs(['--target']);
    expect(opts.invalid).toContain('Option --target requires a target operand');
  });

  it('flags hyphen-prefixed operand for --target', () => {
    const opts = parseArgs(['--target', '--dry-run']);
    expect(opts.invalid).toContain('Option --target requires a target operand');
  });

  it('flags missing operand for --token-id', () => {
    const opts = parseArgs(['--token-id']);
    expect(opts.invalid).toContain('Option --token-id requires a non-empty token ID operand');
  });
});

describe('printUsage', () => {
  it('outputs usage options and target names without argv secrets', () => {
    const lines = [];
    printUsage((msg) => lines.push(msg));
    const output = lines.join('\n');
    expect(output).toContain('Usage: roll-cloudflare-tokens.mjs');
    expect(output).toContain('--target');
    expect(output).toContain('--dry-run');
    expect(output).toContain('--token-id');
    expect(output).toContain('CLOUDFLARE_ROLL_TOKEN');
    expect(output).toContain('CLOUDFLARE_ACCOUNT_ID');
    expect(output).toContain('CLOUDFLARE_ACCOUNT_ROLL_TOKEN');
    expect(output).toContain('TFC_TOKEN');
  });
});

describe('runRoll', () => {
  it('prints help and exits with 0', async () => {
    const stdout = [];
    const code = await runRoll({
      options: { help: true },
      stdout: (m) => stdout.push(m),
    });
    expect(code).toBe(0);
    expect(stdout.join('\n')).toContain('Usage: roll-cloudflare-tokens.mjs');
  });

  it('fails with 2 on invalid options from parseArgs', async () => {
    const stderr = [];
    const code = await runRoll({
      options: { invalid: "Unrecognized option: '--bad'" },
      stderr: (m) => stderr.push(m),
    });
    expect(code).toBe(2);
    expect(stderr.join('\n')).toContain("[error] Unrecognized option: '--bad'");
  });

  it('fails with 1 on unknown target', async () => {
    const stderr = [];
    const code = await runRoll({
      options: { target: 'nonexistent' },
      stderr: (m) => stderr.push(m),
    });
    expect(code).toBe(1);
    expect(stderr.join('\n')).toContain("Unknown target: 'nonexistent'");
  });

  it('refuses --token-id when targeting multiple targets', async () => {
    const stderr = [];
    const code = await runRoll({
      options: { target: 'all', tokenId: 'single-id' },
      stderr: (m) => stderr.push(m),
    });
    expect(code).toBe(1);
    expect(stderr.join('\n')).toContain('--token-id cannot be used when targeting multiple targets');
  });

  it('rejects duplicate token IDs across targets', async () => {
    const stderr = [];
    const code = await runRoll({
      options: { target: 'all' },
      env: {
        CLOUDFLARE_AZURE_TOKEN_ID: 'duplicate-tok-id',
        CLOUDFLARE_LAB_TOKEN_ID: 'duplicate-tok-id',
        CLOUDFLARE_CADDY_TOKEN_ID: 'different-tok-id',
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
        CLOUDFLARE_ROLL_TOKEN: 'cf-roll-tok',
        TFC_TOKEN: 'tfc-tok',
      },
      stderr: (m) => stderr.push(m),
    });
    expect(code).toBe(1);
    expect(stderr.join('\n')).toContain("Duplicate token ID 'duplicate-tok-id' detected");
  });

  it('exits with 2 when Cloudflare roll token is missing in env', async () => {
    const stderr = [];
    const code = await runRoll({
      options: { target: 'azure', dryRun: false },
      env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
      stderr: (m) => stderr.push(m),
    });
    expect(code).toBe(2);
    expect(stderr.join('\n')).toContain('Cloudflare roll token is required');
  });

  it('exits with 2 when TFC token is missing for a TFC target', async () => {
    const stderr = [];
    const code = await runRoll({
      options: { target: 'azure', dryRun: false },
      env: { CLOUDFLARE_ROLL_TOKEN: 'cf-roll-tok', CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
      stderr: (m) => stderr.push(m),
    });
    expect(code).toBe(2);
    expect(stderr.join('\n')).toContain('HCP Terraform token is required for TFC targets');
  });

  it('exits with 1 when target token ID is missing in env', async () => {
    const stderr = [];
    const code = await runRoll({
      options: { target: 'azure', dryRun: false },
      env: { CLOUDFLARE_ROLL_TOKEN: 'cf-roll-tok', TFC_TOKEN: 'tfc-tok', CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
      stderr: (m) => stderr.push(m),
    });
    expect(code).toBe(1);
    expect(stderr.join('\n')).toContain("Missing token ID for target 'azure'");
  });

  it('supports dry-run without calling APIs', async () => {
    const stdout = [];
    const code = await runRoll({
      options: { target: 'all', dryRun: true },
      env: {
        CLOUDFLARE_AZURE_TOKEN_ID: 'tok-azure-id',
        CLOUDFLARE_LAB_TOKEN_ID: 'tok-lab-id',
        CLOUDFLARE_CADDY_TOKEN_ID: 'tok-caddy-id',
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      },
      stdout: (m) => stdout.push(m),
    });
    expect(code).toBe(0);
    const out = stdout.join('\n');
    expect(out).toContain('[dry-run] Would roll token tok-azure-id (account-owned token');
    expect(out).toContain('and update Azure HCP Terraform workspace');
    expect(out).toContain('[dry-run] Would roll token tok-lab-id (user token');
    expect(out).toContain('and update Lab HCP Terraform workspace');
    expect(out).toContain('[dry-run] Would roll token tok-caddy-id (user token');
    expect(out).toContain('and update Lab host Ansible Vault');
    // The account id is an identifier, but it is still not printed.
    expect(out).not.toContain(ACCOUNT_ID);
  });

  it('refuses the azure target without CLOUDFLARE_ACCOUNT_ID, even in a dry run (#1927)', async () => {
    for (const options of [{ target: 'azure', dryRun: true }, { target: 'all', dryRun: true }, { target: 'azure', check: true }]) {
      const stderr = [];
      const code = await runRoll({
        options,
        env: { CLOUDFLARE_AZURE_TOKEN_ID: 'tok-az', CLOUDFLARE_LAB_TOKEN_ID: 'tok-lb', CLOUDFLARE_CADDY_TOKEN_ID: 'tok-cd' },
        stderr: (m) => stderr.push(m),
      });
      expect(code, JSON.stringify(options)).toBe(2);
      expect(stderr.join('\n')).toContain('set CLOUDFLARE_ACCOUNT_ID');
      expect(stderr.join('\n')).toContain('(target azure)');
    }
  });

  it('refuses a malformed CLOUDFLARE_ACCOUNT_ID without printing it', async () => {
    const stderr = [];
    const code = await runRoll({
      options: { target: 'azure', dryRun: true },
      env: { CLOUDFLARE_AZURE_TOKEN_ID: 'tok-az', CLOUDFLARE_ACCOUNT_ID: 'Not-An-Id' },
      stderr: (m) => stderr.push(m),
    });
    expect(code).toBe(2);
    expect(stderr.join('\n')).not.toContain('Not-An-Id');
  });

  it('does not need the account id for user-token targets', async () => {
    const stdout = [];
    const code = await runRoll({
      options: { target: 'lab', dryRun: true },
      env: { CLOUDFLARE_LAB_TOKEN_ID: 'tok-lb' },
      stdout: (m) => stdout.push(m),
    });
    expect(code).toBe(0);
    expect(stdout.join('\n')).toContain('tok-lb (user token');
  });

  it('performs live checks in --check mode', async () => {
    const stdout = [];
    const stderr = [];

    const mockFetch = vi.fn(async (url) => {
      if (url.includes('/organizations/hcw/workspaces/')) {
        return { ok: true, status: 200, json: async () => ({ data: { id: 'ws-mock' } }) };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const code = await runRoll({
      options: { target: 'azure', check: true },
      env: {
        CLOUDFLARE_AZURE_TOKEN_ID: 'tok-az',
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
        TFC_TOKEN: 'valid-tfc-token',
      },
      fetchImpl: mockFetch,
      stdout: (m) => stdout.push(m),
      stderr: (m) => stderr.push(m),
    });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join('\n')).toContain("[ok] Target 'azure': verified reachable and configured");
  });

  it('executes successful roll and apply across all three targets, each through its own route', async () => {
    const stdout = [];
    const stderr = [];
    const rolls = [];

    const mockFetch = vi.fn(async (url, options) => {
      // Roll calls
      if (url.includes('/value')) {
        rolls.push({ url, auth: options.headers.Authorization });
        const tokenId = url.split('/tokens/')[1].split('/value')[0];
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, result: `secret-val-for-${tokenId}` }),
        };
      }
      // Verify calls
      if (url.includes('/tokens/verify')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, result: { id: 'verified', status: 'active' } }),
        };
      }
      // TFC workspace calls
      if (url.includes('/organizations/hcw/workspaces/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { id: 'ws-mock-id' } }),
        };
      }
      // TFC vars get
      if (url.includes('/vars') && options.method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ id: 'var-1', attributes: { key: 'cloudflare_api_token', category: 'terraform' } }],
          }),
        };
      }
      // TFC vars patch
      if (url.includes('/vars/var-1') && options.method === 'PATCH') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { id: 'var-1' } }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const mockExec = vi.fn(async () => ({ code: 0, stdout: 'ok', stderr: '' }));

    const code = await runRoll({
      options: { target: 'all' },
      env: {
        CLOUDFLARE_ROLL_TOKEN: 'cf-roll-token',
        CLOUDFLARE_ACCOUNT_ROLL_TOKEN: 'cf-account-roll-token',
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
        TFC_TOKEN: 'tfc-app-token',
        CLOUDFLARE_AZURE_TOKEN_ID: 'tok-az',
        CLOUDFLARE_LAB_TOKEN_ID: 'tok-lb',
        CLOUDFLARE_CADDY_TOKEN_ID: 'tok-cd',
      },
      fetchImpl: mockFetch,
      execImpl: mockExec,
      stdout: (m) => stdout.push(m),
      stderr: (m) => stderr.push(m),
    });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const out = stdout.join('\n');
    expect(out).toContain("[ok] Target 'azure': successfully rolled token tok-az");
    expect(out).toContain("[ok] Target 'lab': successfully rolled token tok-lb");
    expect(out).toContain("[ok] Target 'caddy': successfully rolled token tok-cd");

    // hcw-azure's account-owned token goes through the account route with the
    // account roll token; the two user tokens through the user route.
    expect(rolls).toEqual([
      { url: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/tokens/tok-az/value`, auth: 'Bearer cf-account-roll-token' },
      { url: 'https://api.cloudflare.com/client/v4/user/tokens/tok-lb/value', auth: 'Bearer cf-roll-token' },
      { url: 'https://api.cloudflare.com/client/v4/user/tokens/tok-cd/value', auth: 'Bearer cf-roll-token' },
    ]);

    // Zero secret leakage check
    expect(out).not.toContain('secret-val-for');
    expect(out).not.toContain('cf-roll-token');
    expect(out).not.toContain('cf-account-roll-token');
    expect(out).not.toContain('tfc-app-token');
    expect(out).not.toContain(ACCOUNT_ID);
  });

  it('uses CLOUDFLARE_ROLL_TOKEN for the account route when no account roll token is given', async () => {
    const auths = [];
    const mockFetch = vi.fn(async (url, options) => {
      if (url.includes('/value')) {
        auths.push(options.headers.Authorization);
        return { ok: true, status: 200, json: async () => ({ success: true, result: 'new-value' }) };
      }
      if (url.includes('/tokens/verify')) {
        return { ok: true, status: 200, json: async () => ({ success: true, result: { id: 'x', status: 'active' } }) };
      }
      if (url.includes('/organizations/hcw/workspaces/')) {
        return { ok: true, status: 200, json: async () => ({ data: { id: 'ws' } }) };
      }
      if (url.includes('/vars') && options.method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      }
      if (url.includes('/vars') && options.method === 'POST') {
        return { ok: true, status: 201, json: async () => ({ data: { id: 'var-new' } }) };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const code = await runRoll({
      options: { target: 'azure' },
      env: { CLOUDFLARE_ROLL_TOKEN: 'general-roll', CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, TFC_TOKEN: 't', CLOUDFLARE_AZURE_TOKEN_ID: 'tok-az' },
      fetchImpl: mockFetch,
      stdout: () => {},
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(auths).toEqual(['Bearer general-roll']);
  });

  it('exits with 1 when a target fails to roll', async () => {
    const stdout = [];
    const stderr = [];

    const mockFetch = vi.fn(async (url) => {
      if (url.includes('/value')) {
        return {
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          json: async () => ({ success: false, errors: [{ message: 'Cloudflare service degraded' }] }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const code = await runRoll({
      options: { target: 'caddy', tokenId: 'tok-failing' },
      env: { CLOUDFLARE_ROLL_TOKEN: 'cf-roll-token' },
      fetchImpl: mockFetch,
      stdout: (m) => stdout.push(m),
      stderr: (m) => stderr.push(m),
    });

    expect(code).toBe(1);
    const err = stderr.join('\n');
    expect(err).toContain("[fail] Target 'caddy': failed to roll and apply: Cloudflare roll-token request failed (500)");
  });
});
