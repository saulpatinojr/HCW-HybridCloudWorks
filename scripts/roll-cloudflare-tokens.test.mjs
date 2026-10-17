/**
 * Tests for scripts/roll-cloudflare-tokens.mjs (#1027).
 */

import { describe, it, expect, vi } from 'vitest';
import { parseArgs, printUsage, runRoll } from './roll-cloudflare-tokens.mjs';

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
      env: {},
      stderr: (m) => stderr.push(m),
    });
    expect(code).toBe(2);
    expect(stderr.join('\n')).toContain('Cloudflare roll token is required');
  });

  it('exits with 2 when TFC token is missing for a TFC target', async () => {
    const stderr = [];
    const code = await runRoll({
      options: { target: 'azure', dryRun: false },
      env: { CLOUDFLARE_ROLL_TOKEN: 'cf-roll-tok' },
      stderr: (m) => stderr.push(m),
    });
    expect(code).toBe(2);
    expect(stderr.join('\n')).toContain('HCP Terraform token is required for TFC targets');
  });

  it('exits with 1 when target token ID is missing in env', async () => {
    const stderr = [];
    const code = await runRoll({
      options: { target: 'azure', dryRun: false },
      env: { CLOUDFLARE_ROLL_TOKEN: 'cf-roll-tok', TFC_TOKEN: 'tfc-tok' },
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
      },
      stdout: (m) => stdout.push(m),
    });
    expect(code).toBe(0);
    const out = stdout.join('\n');
    expect(out).toContain('[dry-run] Would roll token tok-azure-id and update Azure HCP Terraform workspace');
    expect(out).toContain('[dry-run] Would roll token tok-lab-id and update Lab HCP Terraform workspace');
    expect(out).toContain('[dry-run] Would roll token tok-caddy-id and update Lab host Ansible Vault');
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

  it('executes successful roll and apply across all three targets', async () => {
    const stdout = [];
    const stderr = [];

    const mockFetch = vi.fn(async (url, options) => {
      // Roll calls
      if (url.includes('/value')) {
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

    // Zero secret leakage check
    expect(out).not.toContain('secret-val-for');
    expect(out).not.toContain('cf-roll-token');
    expect(out).not.toContain('tfc-app-token');
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
