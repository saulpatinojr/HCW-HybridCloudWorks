/**
 * Unit tests for scripts/roll-cloud-credentials.mjs (#1028).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  parseArgs,
  printUsage,
  resolveTargets,
  main,
} from './roll-cloud-credentials.mjs';
import { GOOGLE_TARGETS } from '../functions/src/lib/credentials/google-roll.js';

describe('parseArgs', () => {
  it('defaults to target all and no dry-run or check', () => {
    const opts = parseArgs([]);
    expect(opts).toEqual({
      target: 'all',
      dryRun: false,
      check: false,
      help: false,
      invalid: null,
    });
  });

  it('parses valid target flags', () => {
    expect(parseArgs(['--target', 'gemini']).target).toBe('gemini');
    expect(parseArgs(['--target', 'youtube']).target).toBe('youtube');
    expect(parseArgs(['--target', 'billing']).target).toBe('billing');
    expect(parseArgs(['--target', 'google-all']).target).toBe('google-all');
    expect(parseArgs(['--target', 'aws']).target).toBe('aws');
    expect(parseArgs(['--target', 'all']).target).toBe('all');
  });

  it('parses --dry-run and --check flags', () => {
    const opts = parseArgs(['--dry-run', '--check']);
    expect(opts.dryRun).toBe(true);
    expect(opts.check).toBe(true);
  });

  it('parses --help and -h', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('rejects unknown options', () => {
    const opts = parseArgs(['--unknown-flag']);
    expect(opts.invalid).toContain("Unrecognized option: '--unknown-flag'");
  });

  it('rejects missing --target operand', () => {
    const opts1 = parseArgs(['--target']);
    expect(opts1.invalid).toContain('Option --target requires an operand');

    const opts2 = parseArgs(['--target', '--dry-run']);
    expect(opts2.invalid).toContain('Option --target requires an operand');
  });

  it('rejects invalid target name', () => {
    const opts = parseArgs(['--target', 'azure']);
    expect(opts.invalid).toContain("Invalid target: 'azure'");
  });
});

describe('printUsage', () => {
  it('outputs usage text to provided stream', () => {
    let output = '';
    printUsage((str) => {
      output += str;
    });
    expect(output).toContain('Usage: roll-cloud-credentials.mjs');
    expect(output).toContain('--target <target>');
    expect(output).toContain('GCP_ACCESS_TOKEN');
    expect(output).toContain('AWS_ACCESS_KEY_ID');
  });
});

describe('resolveTargets', () => {
  it('resolves individual Google targets', () => {
    const gemini = resolveTargets('gemini');
    expect(gemini.googleTargets).toEqual([GOOGLE_TARGETS.gemini]);
    expect(gemini.awsTarget).toBe(false);

    const yt = resolveTargets('youtube');
    expect(yt.googleTargets).toEqual([GOOGLE_TARGETS.youtube]);
    expect(yt.awsTarget).toBe(false);

    const billing = resolveTargets('billing');
    expect(billing.googleTargets).toEqual([GOOGLE_TARGETS.billing]);
    expect(billing.awsTarget).toBe(false);
  });

  it('resolves google-all to all three Google targets', () => {
    const gAll = resolveTargets('google-all');
    expect(gAll.googleTargets).toEqual([
      GOOGLE_TARGETS.gemini,
      GOOGLE_TARGETS.youtube,
      GOOGLE_TARGETS.billing,
    ]);
    expect(gAll.awsTarget).toBe(false);
  });

  it('resolves aws to AWS target only', () => {
    const aws = resolveTargets('aws');
    expect(aws.googleTargets).toEqual([]);
    expect(aws.awsTarget).toBe(true);
  });

  it('resolves all to all Google targets and AWS target', () => {
    const all = resolveTargets('all');
    expect(all.googleTargets).toEqual([
      GOOGLE_TARGETS.gemini,
      GOOGLE_TARGETS.youtube,
      GOOGLE_TARGETS.billing,
    ]);
    expect(all.awsTarget).toBe(true);
  });
});

describe('main', () => {
  it('prints usage and returns 0 when --help is passed', async () => {
    let out = '';
    const code = await main(['--help'], {
      stdout: (s) => { out += s; },
    });
    expect(code).toBe(0);
    expect(out).toContain('Usage: roll-cloud-credentials.mjs');
  });

  it('returns 1 with error on invalid CLI arguments', async () => {
    let err = '';
    const code = await main(['--invalid-flag'], {
      stderr: (s) => { err += s; },
    });
    expect(code).toBe(1);
    expect(err).toContain("Unrecognized option: '--invalid-flag'");
  });

  it('returns 1 if GCP_ACCESS_TOKEN is missing for Google targets', async () => {
    let err = '';
    const code = await main(['--target', 'gemini'], {
      env: {},
      stderr: (s) => { err += s; },
    });
    expect(code).toBe(1);
    expect(err).toContain('GCP_ACCESS_TOKEN (or GOOGLE_ACCESS_TOKEN) environment variable is required');
  });

  it('returns 1 if AWS credentials are missing for AWS target', async () => {
    let err = '';
    const code = await main(['--target', 'aws'], {
      env: {},
      stderr: (s) => { err += s; },
    });
    expect(code).toBe(1);
    expect(err).toContain('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables are required');
  });

  it('handles --dry-run cleanly without executing mutations', async () => {
    let out = '';
    const code = await main(['--dry-run', '--target', 'all'], {
      env: {
        GCP_ACCESS_TOKEN: 'fake-gcp-token',
        GCP_PROJECT_ID: 'my-project',
        AWS_ACCESS_KEY_ID: 'AKIA-TEST',
        AWS_SECRET_ACCESS_KEY: 'test-secret',
      },
      stdout: (s) => { out += `${s}\n`; },
    });

    expect(code).toBe(0);
    expect(out).toContain('[dry-run] Planned credential renewals for target \'all\'');
    expect(out).toContain('Google API Key: Mint new GEMINI-API-KEY');
    expect(out).toContain('Google API Key: Mint new YOUTUBE-API-KEY');
    expect(out).toContain('Google API Key: Mint new GCP-BILLING-API-KEY');
    expect(out).toContain('AWS IAM Access Key: Check 2-key quota');
  });

  it('handles --check mode: runs verification probes', async () => {
    let out = '';
    const mockFetch = vi.fn(async (url, options = {}) => {
      // Google Gemini probe
      if (url.includes('generativelanguage.googleapis.com')) {
        return { ok: true, status: 200 };
      }
      // AWS IAM list keys
      if (url.includes('iam.amazonaws.com')) {
        return {
          ok: true,
          status: 200,
          text: async () => '<ListAccessKeysResponse><ListAccessKeysResult><AccessKeyMetadata><member><AccessKeyId>AKIA-1</AccessKeyId><Status>Active</Status></member></AccessKeyMetadata></ListAccessKeysResult></ListAccessKeysResponse>',
        };
      }
      return { ok: true, status: 200 };
    });

    const mockPricingClient = {
      send: vi.fn(async () => ({ PriceList: ['{}'] })),
    };

    const code = await main(['--check', '--target', 'all'], {
      env: {
        GCP_ACCESS_TOKEN: 'fake-gcp-token',
        GEMINI_API_KEY: 'current-gemini-key',
        AWS_ACCESS_KEY_ID: 'AKIA-1',
        AWS_SECRET_ACCESS_KEY: 'sec-1',
      },
      stdout: (s) => { out += `${s}\n`; },
      fetchImpl: mockFetch,
      pricingClient: mockPricingClient,
    });

    expect(code).toBe(0);
    expect(out).toContain('GEMINI-API-KEY: Functional probe succeeded');
    expect(out).toContain('AWS IAM: Access keys list reachable');
    expect(out).toContain('AWS Pricing: Functional GetProducts probe succeeded');
  });

  it('executes live rotation for Google and AWS targets', async () => {
    let out = '';
    const savedSecrets = {};

    const mockVault = {
      setSecret: vi.fn(async (name, val) => {
        savedSecrets[name] = val;
        return { version: 'v1' };
      }),
      refreshReferences: vi.fn(async () => ({ refreshed: true, reason: null })),
    };

    const mockPricingClient = {
      send: vi.fn(async () => ({ PriceList: ['{}'] })),
    };

    const mockFetch = vi.fn(async (url, options = {}) => {
      const body = options.body || '';

      // Google APIs
      if (url.endsWith('/locations/global/keys') && options.method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            name: 'operations/op-1',
            done: true,
            response: { name: 'projects/1/locations/global/keys/new-gemini-key' },
          }),
        };
      }
      if (url.endsWith('/new-gemini-key/keyString')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ keyString: 'AIzaNewGeminiSecret' }),
        };
      }
      if (url.includes('generativelanguage.googleapis.com') ||
          url.includes('youtube/v3/videos') ||
          url.includes('cloudbilling.googleapis.com')) {
        return { ok: true, status: 200 };
      }

      // AWS IAM APIs
      if (body.includes('Action=ListAccessKeys')) {
        return {
          ok: true,
          status: 200,
          text: async () => '<ListAccessKeysResponse><ListAccessKeysResult><AccessKeyMetadata><member><AccessKeyId>AKIA-OLD</AccessKeyId><Status>Active</Status></member></AccessKeyMetadata></ListAccessKeysResult></ListAccessKeysResponse>',
        };
      }
      if (body.includes('Action=CreateAccessKey')) {
        return {
          ok: true,
          status: 200,
          text: async () => '<CreateAccessKeyResponse><CreateAccessKeyResult><AccessKey><AccessKeyId>AKIA-NEW</AccessKeyId><SecretAccessKey>NewSecret123</SecretAccessKey><Status>Active</Status></AccessKey></CreateAccessKeyResult></CreateAccessKeyResponse>',
        };
      }
      if (body.includes('Action=DeleteAccessKey')) {
        return { ok: true, status: 200, text: async () => '<DeleteAccessKeyResponse/>' };
      }

      throw new Error(`Unexpected request: ${url} body: ${body}`);
    });

    const code = await main(['--target', 'all'], {
      env: {
        GCP_ACCESS_TOKEN: 'gcp-tok',
        GCP_PROJECT_ID: 'proj-123',
        AWS_ACCESS_KEY_ID: 'AKIA-OLD',
        AWS_SECRET_ACCESS_KEY: 'old-sec',
      },
      stdout: (s) => { out += `${s}\n`; },
      vault: mockVault,
      pricingClient: mockPricingClient,
      fetchImpl: mockFetch,
    });

    expect(code).toBe(0);
    expect(out).toContain('GEMINI-API-KEY renewed successfully');
    expect(out).toContain('AWS IAM access key renewed successfully');
    expect(savedSecrets['GEMINI-API-KEY']).toBe('AIzaNewGeminiSecret');
    expect(savedSecrets['AWS-ACCESS-KEY-ID']).toBe('AKIA-NEW');
    expect(savedSecrets['AWS-SECRET-ACCESS-KEY']).toBe('NewSecret123');
  });

  it('returns 1 when an error occurs during rotation', async () => {
    let err = '';
    const mockFetch = vi.fn(async () => {
      throw new Error('Network connection timeout');
    });

    const code = await main(['--target', 'gemini'], {
      env: {
        GCP_ACCESS_TOKEN: 'gcp-tok',
        GCP_PROJECT_ID: 'proj-123',
      },
      stderr: (s) => { err += `${s}\n`; },
      fetchImpl: mockFetch,
    });

    expect(code).toBe(1);
    expect(err).toContain('Failed to roll GEMINI-API-KEY: Network connection timeout');
  });
});
