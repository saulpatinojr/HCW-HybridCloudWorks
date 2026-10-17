/**
 * Unit tests for functions/src/lib/credentials/aws-roll.js (#1028).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  AWS_TARGETS,
  signSigV4,
  listAwsAccessKeys,
  createAwsAccessKey,
  deleteAwsAccessKey,
  verifyAwsPricingAccess,
  rollAndApplyAwsKey,
} from './aws-roll.js';

describe('AWS_TARGETS', () => {
  it('declares the AWS price list target', () => {
    expect(AWS_TARGETS.pricing).toBeDefined();
    expect(AWS_TARGETS.pricing.idSecretName).toBe('AWS-ACCESS-KEY-ID');
    expect(AWS_TARGETS.pricing.secretSecretName).toBe('AWS-SECRET-ACCESS-KEY');
    expect(AWS_TARGETS.pricing.region).toBe('us-east-1');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(AWS_TARGETS)).toBe(true);
    expect(Object.isFrozen(AWS_TARGETS.pricing)).toBe(true);
  });
});

describe('signSigV4', () => {
  it('validates mandatory credentials', () => {
    expect(() => signSigV4({ url: 'https://iam.amazonaws.com/' })).toThrow('accessKeyId must be specified');
    expect(() => signSigV4({ url: 'https://iam.amazonaws.com/', accessKeyId: 'AKIA123' })).toThrow('secretAccessKey must be specified');
  });

  it('produces valid SigV4 authorization headers with fixed timestamp', () => {
    const fixedDate = new Date('2026-10-17T02:00:00.000Z');
    const headers = signSigV4({
      method: 'POST',
      url: 'https://iam.amazonaws.com/',
      body: 'Action=ListAccessKeys&Version=2010-05-08',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      service: 'iam',
      now: fixedDate,
    });

    expect(headers['x-amz-date']).toBe('20261017T020000Z');
    expect(headers.host).toBe('iam.amazonaws.com');
    expect(headers.Authorization).toContain('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20261017/us-east-1/iam/aws4_request');
    expect(headers.Authorization).toContain('SignedHeaders=host;x-amz-date');
    expect(headers.Authorization).toContain('Signature=');
  });
});

describe('listAwsAccessKeys', () => {
  it('parses access key metadata from XML response', async () => {
    const xml = `
      <ListAccessKeysResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/">
        <ListAccessKeysResult>
          <AccessKeyMetadata>
            <member>
              <AccessKeyId>AKIA11111111EXAMPLE</AccessKeyId>
              <Status>Active</Status>
            </member>
          </AccessKeyMetadata>
          <IsTruncated>false</IsTruncated>
        </ListAccessKeysResult>
      </ListAccessKeysResponse>`;

    const mockFetch = vi.fn(async (url, options) => {
      expect(url).toBe('https://iam.amazonaws.com/');
      expect(options.body).toContain('Action=ListAccessKeys');
      expect(options.headers.Authorization).toBeDefined();
      return {
        ok: true,
        status: 200,
        text: async () => xml,
      };
    });

    const keys = await listAwsAccessKeys({
      accessKeyId: 'AKIA11111111EXAMPLE',
      secretAccessKey: 'secret-1',
      fetchImpl: mockFetch,
      now: new Date('2026-10-17T02:00:00Z'),
    });

    expect(keys).toEqual([
      { accessKeyId: 'AKIA11111111EXAMPLE', status: 'Active' },
    ]);
  });

  it('throws error when IAM response is non-200', async () => {
    const xml = `
      <ErrorResponse>
        <Error>
          <Code>AccessDenied</Code>
          <Message>User is not authorized to perform: iam:ListAccessKeys</Message>
        </Error>
      </ErrorResponse>`;

    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => xml,
    }));

    await expect(
      listAwsAccessKeys({
        accessKeyId: 'AKIA-bad',
        secretAccessKey: 'sec',
        fetchImpl: mockFetch,
        now: new Date('2026-10-17T02:00:00Z'),
      })
    ).rejects.toThrow(/AWS IAM ListAccessKeys failed: User is not authorized/);
  });
});

describe('createAwsAccessKey', () => {
  it('creates new key and parses credentials from response', async () => {
    const xml = `
      <CreateAccessKeyResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/">
        <CreateAccessKeyResult>
          <AccessKey>
            <UserName>pricing-reader</UserName>
            <AccessKeyId>AKIA22222222NEWKEY</AccessKeyId>
            <Status>Active</Status>
            <SecretAccessKey>newSecretKeyString123456789</SecretAccessKey>
          </AccessKey>
        </CreateAccessKeyResult>
      </CreateAccessKeyResponse>`;

    const mockFetch = vi.fn(async (url, options) => {
      expect(options.body).toContain('Action=CreateAccessKey');
      return {
        ok: true,
        status: 200,
        text: async () => xml,
      };
    });

    const res = await createAwsAccessKey({
      accessKeyId: 'AKIA11111111EXAMPLE',
      secretAccessKey: 'secret-1',
      fetchImpl: mockFetch,
      now: new Date('2026-10-17T02:00:00Z'),
    });

    expect(res).toEqual({
      accessKeyId: 'AKIA22222222NEWKEY',
      secretAccessKey: 'newSecretKeyString123456789',
      status: 'Active',
    });
  });

  it('throws error on quota limit exceeded', async () => {
    const xml = `
      <ErrorResponse>
        <Error>
          <Code>LimitExceeded</Code>
          <Message>Cannot exceed quota for AccessKeysPerUser: 2</Message>
        </Error>
      </ErrorResponse>`;

    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 409,
      text: async () => xml,
    }));

    await expect(
      createAwsAccessKey({
        accessKeyId: 'AKIA-1',
        secretAccessKey: 'sec-1',
        fetchImpl: mockFetch,
        now: new Date('2026-10-17T02:00:00Z'),
      })
    ).rejects.toThrow(/AWS IAM CreateAccessKey failed: Cannot exceed quota/);
  });
});

describe('deleteAwsAccessKey', () => {
  it('sends DeleteAccessKey request with target access key ID', async () => {
    let capturedBody = null;
    const mockFetch = vi.fn(async (url, options) => {
      capturedBody = options.body;
      return {
        ok: true,
        status: 200,
        text: async () => '<DeleteAccessKeyResponse/>',
      };
    });

    const res = await deleteAwsAccessKey({
      accessKeyId: 'AKIA-ACTIVE',
      secretAccessKey: 'secret-active',
      targetAccessKeyId: 'AKIA-OLD-TO-DELETE',
      fetchImpl: mockFetch,
      now: new Date('2026-10-17T02:00:00Z'),
    });

    expect(capturedBody).toContain('Action=DeleteAccessKey');
    expect(capturedBody).toContain('AccessKeyId=AKIA-OLD-TO-DELETE');
    expect(res).toEqual({ ok: true, deletedAccessKeyId: 'AKIA-OLD-TO-DELETE' });
  });

  it('throws error when targetAccessKeyId is missing or deletion fails', async () => {
    await expect(deleteAwsAccessKey({})).rejects.toThrow('targetAccessKeyId must be specified');

    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => '<Error><Message>The Access Key does not exist</Message></Error>',
    }));

    await expect(
      deleteAwsAccessKey({
        accessKeyId: 'AKIA-1',
        secretAccessKey: 's-1',
        targetAccessKeyId: 'AKIA-NONEXISTENT',
        fetchImpl: mockFetch,
        now: new Date('2026-10-17T02:00:00Z'),
      })
    ).rejects.toThrow(/AWS IAM DeleteAccessKey for AKIA-NONEXISTENT failed: The Access Key does not exist/);
  });
});

describe('verifyAwsPricingAccess', () => {
  it('validates mandatory parameters', async () => {
    await expect(verifyAwsPricingAccess({})).rejects.toThrow('accessKeyId and secretAccessKey are required');
  });

  it('sends GetProductsCommand and returns verified on successful PriceList', async () => {
    const mockPricingClient = {
      send: vi.fn(async (command) => {
        expect(command.input.ServiceCode).toBe('AmazonEC2');
        return {
          PriceList: [JSON.stringify({ product: { productFamily: 'Compute Instance' } })],
        };
      }),
    };

    const res = await verifyAwsPricingAccess({
      accessKeyId: 'AKIA-VERIFY',
      secretAccessKey: 'secret-verify',
      clientImpl: mockPricingClient,
    });

    expect(res).toEqual({ ok: true, verified: true });
  });

  it('throws error if pricing probe returns no price list or client throws', async () => {
    const mockPricingClient = {
      send: vi.fn(async () => {
        throw new Error('The security token included in the request is invalid');
      }),
    };

    await expect(
      verifyAwsPricingAccess({
        accessKeyId: 'AKIA-FAIL',
        secretAccessKey: 'secret-fail',
        clientImpl: mockPricingClient,
      })
    ).rejects.toThrow(/AWS Pricing verification probe failed \(The security token included in the request is invalid\)/);
  });
});

describe('rollAndApplyAwsKey', () => {
  it('orchestrates verify-before-delete: checks quota, creates key, probes, writes to Key Vault, deletes old', async () => {
    const savedSecrets = {};
    const deletedKeys = [];
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

    const mockPricingClient = {
      send: vi.fn(async () => ({
        PriceList: ['{"terms":{}}'],
      })),
    };

    const mockFetch = vi.fn(async (url, options) => {
      const body = options.body || '';
      // 1. ListAccessKeys (1 existing key)
      if (body.includes('Action=ListAccessKeys')) {
        return {
          ok: true,
          status: 200,
          text: async () => `
            <ListAccessKeysResponse>
              <ListAccessKeysResult>
                <AccessKeyMetadata>
                  <member>
                    <AccessKeyId>AKIA-OLD-CURRENT</AccessKeyId>
                    <Status>Active</Status>
                  </member>
                </AccessKeyMetadata>
              </ListAccessKeysResult>
            </ListAccessKeysResponse>`,
        };
      }
      // 2. CreateAccessKey
      if (body.includes('Action=CreateAccessKey')) {
        return {
          ok: true,
          status: 200,
          text: async () => `
            <CreateAccessKeyResponse>
              <CreateAccessKeyResult>
                <AccessKey>
                  <AccessKeyId>AKIA-NEW-MINTED</AccessKeyId>
                  <SecretAccessKey>NewSecretKeyActualValue123</SecretAccessKey>
                  <Status>Active</Status>
                </AccessKey>
              </CreateAccessKeyResult>
            </CreateAccessKeyResponse>`,
        };
      }
      // 3. DeleteAccessKey (deleting old key)
      if (body.includes('Action=DeleteAccessKey')) {
        if (body.includes('AccessKeyId=AKIA-OLD-CURRENT')) {
          deletedKeys.push('AKIA-OLD-CURRENT');
          return {
            ok: true,
            status: 200,
            text: async () => '<DeleteAccessKeyResponse/>',
          };
        }
      }
      throw new Error(`Unexpected request: ${body}`);
    });

    const res = await rollAndApplyAwsKey({
      currentAccessKeyId: 'AKIA-OLD-CURRENT',
      currentSecretAccessKey: 'old-secret',
      vault: mockVault,
      pricingClient: mockPricingClient,
      fetchImpl: mockFetch,
      now: new Date('2026-10-17T02:00:00Z'),
    });

    expect(res).toEqual({
      ok: true,
      newAccessKeyId: 'AKIA-NEW-MINTED',
      oldAccessKeyIdDeleted: 'AKIA-OLD-CURRENT',
    });

    expect(savedSecrets['AWS-ACCESS-KEY-ID']).toBe('AKIA-NEW-MINTED');
    expect(savedSecrets['AWS-SECRET-ACCESS-KEY']).toBe('NewSecretKeyActualValue123');
    expect(referencesRefreshed).toBe(true);
    expect(deletedKeys).toContain('AKIA-OLD-CURRENT');
  });

  it('fails closed when IAM user already has 2 access keys', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => `
        <ListAccessKeysResponse>
          <ListAccessKeysResult>
            <AccessKeyMetadata>
              <member><AccessKeyId>KEY-1</AccessKeyId><Status>Active</Status></member>
              <member><AccessKeyId>KEY-2</AccessKeyId><Status>Active</Status></member>
            </AccessKeyMetadata>
          </ListAccessKeysResult>
        </ListAccessKeysResponse>`,
    }));

    await expect(
      rollAndApplyAwsKey({
        currentAccessKeyId: 'KEY-1',
        currentSecretAccessKey: 'sec',
        fetchImpl: mockFetch,
        now: new Date('2026-10-17T02:00:00Z'),
      })
    ).rejects.toThrow(/IAM user already has 2 access keys \(maximum is 2\)/);
  });

  it('aborts and deletes newly minted key when pricing verification fails', async () => {
    const deletedKeys = [];
    const mockVault = {
      setSecret: vi.fn(),
      refreshReferences: vi.fn(),
    };

    const mockPricingClient = {
      send: vi.fn(async () => {
        throw new Error('SignatureDoesNotMatch');
      }),
    };

    const mockFetch = vi.fn(async (url, options) => {
      const body = options.body || '';
      if (body.includes('Action=ListAccessKeys')) {
        return {
          ok: true,
          status: 200,
          text: async () => `
            <ListAccessKeysResponse>
              <ListAccessKeysResult>
                <AccessKeyMetadata>
                  <member><AccessKeyId>AKIA-OLD</AccessKeyId><Status>Active</Status></member>
                </AccessKeyMetadata>
              </ListAccessKeysResult>
            </ListAccessKeysResponse>`,
        };
      }
      if (body.includes('Action=CreateAccessKey')) {
        return {
          ok: true,
          status: 200,
          text: async () => `
            <CreateAccessKeyResponse>
              <CreateAccessKeyResult>
                <AccessKey>
                  <AccessKeyId>AKIA-DEFECTIVE</AccessKeyId>
                  <SecretAccessKey>defective-secret</SecretAccessKey>
                  <Status>Active</Status>
                </AccessKey>
              </CreateAccessKeyResult>
            </CreateAccessKeyResponse>`,
        };
      }
      if (body.includes('Action=DeleteAccessKey') && body.includes('AccessKeyId=AKIA-DEFECTIVE')) {
        deletedKeys.push('AKIA-DEFECTIVE');
        return { ok: true, status: 200, text: async () => '<DeleteAccessKeyResponse/>' };
      }
      throw new Error(`Unexpected body: ${body}`);
    });

    await expect(
      rollAndApplyAwsKey({
        currentAccessKeyId: 'AKIA-OLD',
        currentSecretAccessKey: 'old-sec',
        vault: mockVault,
        pricingClient: mockPricingClient,
        fetchImpl: mockFetch,
        now: new Date('2026-10-17T02:00:00Z'),
      })
    ).rejects.toThrow(/New AWS access key verification failed \(AWS Pricing verification probe failed \(SignatureDoesNotMatch\)\)\. Minted key was deleted; old key preserved\./);

    expect(deletedKeys).toContain('AKIA-DEFECTIVE');
    expect(mockVault.setSecret).not.toHaveBeenCalled();
    expect(mockVault.refreshReferences).not.toHaveBeenCalled();
  });

  it('validates mandatory arguments', async () => {
    await expect(rollAndApplyAwsKey({})).rejects.toThrow('currentAccessKeyId is required');
    await expect(rollAndApplyAwsKey({ currentAccessKeyId: 'AKIA-1' })).rejects.toThrow('currentSecretAccessKey is required');
  });
});
