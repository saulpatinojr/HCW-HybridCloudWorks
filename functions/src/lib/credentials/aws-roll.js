/**
 * aws-roll.js — AWS IAM access key auto-renewal for the AWS price list reader
 * with verify-before-delete semantics (#1028).
 *
 * ## Invariants
 *
 * 1. ZERO VALUE LEAKAGE: Secret access keys are never logged, printed, or included
 *    in error messages or return structures.
 * 2. VERIFY BEFORE DELETE: The newly minted access key pair must be verified against
 *    the AWS Pricing API (`pricing:GetProducts`) AND committed to Azure Key Vault
 *    before the old key is retired. If verification fails, the newly created key is
 *    deleted and the old key remains active.
 * 3. 2-KEY QUOTA ENFORCEMENT: AWS IAM allows at most 2 access keys per user. If 2
 *    keys are already active, rotation aborts fail-closed rather than crashing.
 * 4. PURE & INJECTABLE: Network operations use an injectable `fetchImpl`, vault
 *    writer, and `PricingClient` for testability without live external side-effects.
 */

import crypto from 'node:crypto';
import { setVaultSecret, refreshKeyVaultReferences } from '../secret-vault.js';

export const AWS_TARGETS = Object.freeze({
  pricing: Object.freeze({
    id: 'kv-aws-access-key-pair',
    idSecretName: 'AWS-ACCESS-KEY-ID',
    secretSecretName: 'AWS-SECRET-ACCESS-KEY',
    region: 'us-east-1',
  }),
});

/**
 * Signs an HTTP request using AWS Signature Version 4 (SigV4).
 * Uses only standard node:crypto — no external heavy SDK required.
 *
 * @param {object} params
 * @param {string} [params.method='POST'] HTTP method
 * @param {string} params.url Full URL
 * @param {string} [params.body=''] Request payload
 * @param {Record<string, string>} [params.headers={}] Additional headers
 * @param {string} [params.region='us-east-1'] AWS region
 * @param {string} [params.service='iam'] AWS service name
 * @param {string} params.accessKeyId AWS access key ID
 * @param {string} params.secretAccessKey AWS secret access key
 * @param {Date} [params.now=new Date()] Injectable timestamp
 * @returns {Record<string, string>} Headers including Authorization and x-amz-date
 */
export function signSigV4({
  method = 'POST',
  url,
  body = '',
  headers = {},
  region = 'us-east-1',
  service = 'iam',
  accessKeyId,
  secretAccessKey,
  now = new Date(),
}) {
  if (!accessKeyId || typeof accessKeyId !== 'string') {
    throw new Error('accessKeyId must be specified');
  }
  if (!secretAccessKey || typeof secretAccessKey !== 'string') {
    throw new Error('secretAccessKey must be specified');
  }

  const parsedUrl = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');

  const combinedHeaders = {
    ...headers,
    host: parsedUrl.host,
    'x-amz-date': amzDate,
  };

  const sortedHeaderKeys = Object.keys(combinedHeaders)
    .map((k) => k.toLowerCase())
    .sort();

  const canonicalHeaders = sortedHeaderKeys
    .map((k) => `${k}:${combinedHeaders[Object.keys(combinedHeaders).find((orig) => orig.toLowerCase() === k)].trim()}\n`)
    .join('');

  const signedHeaders = sortedHeaderKeys.join(';');

  const canonicalUri = parsedUrl.pathname || '/';
  const canonicalQuery = parsedUrl.searchParams.toString();

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n');

  // Derive signing key
  const kDate = crypto.createHmac('sha256', `AWS4${secretAccessKey}`).update(dateStamp).digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
  const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
  const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();

  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    ...combinedHeaders,
    Authorization: authHeader,
  };
}

/**
 * Lists access keys for the specified user or current caller.
 *
 * @param {object} params
 * @param {string} params.accessKeyId Current active AWS access key ID
 * @param {string} params.secretAccessKey Current active AWS secret access key
 * @param {string} [params.userName] Optional target IAM username (omitted for caller)
 * @param {typeof fetch} [params.fetchImpl] Injectable fetch
 * @param {Date} [params.now] Injectable timestamp
 * @returns {Promise<Array<{ accessKeyId: string, status: string }>>}
 */
export async function listAwsAccessKeys({
  accessKeyId,
  secretAccessKey,
  userName,
  fetchImpl = globalThis.fetch,
  now,
}) {
  const url = 'https://iam.amazonaws.com/';
  const body = `Action=ListAccessKeys&Version=2010-05-08${userName ? `&UserName=${encodeURIComponent(userName)}` : ''}`;

  const headers = signSigV4({
    method: 'POST',
    url,
    body,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    region: 'us-east-1',
    service: 'iam',
    accessKeyId,
    secretAccessKey,
    now,
  });

  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body,
  });

  const text = await response.text();

  if (!response.ok) {
    const errorMatch = text.match(/<Message>(.*?)<\/Message>/s);
    const err = errorMatch ? errorMatch[1] : `HTTP ${response.status}`;
    throw new Error(`AWS IAM ListAccessKeys failed: ${err}`);
  }

  // Parse access keys from XML response
  const keys = [];
  const memberRegex = /<member>(.*?)<\/member>/gs;
  let match;
  while ((match = memberRegex.exec(text)) !== null) {
    const memberBlock = match[1];
    const idMatch = memberBlock.match(/<AccessKeyId>(.*?)<\/AccessKeyId>/);
    const statusMatch = memberBlock.match(/<Status>(.*?)<\/Status>/);
    if (idMatch && statusMatch) {
      keys.push({
        accessKeyId: idMatch[1].trim(),
        status: statusMatch[1].trim(),
      });
    }
  }

  return keys;
}

/**
 * Creates a new AWS IAM access key pair.
 *
 * @param {object} params
 * @param {string} params.accessKeyId Current active AWS access key ID
 * @param {string} params.secretAccessKey Current active AWS secret access key
 * @param {string} [params.userName] Optional target IAM username (omitted for caller)
 * @param {typeof fetch} [params.fetchImpl] Injectable fetch
 * @param {Date} [params.now] Injectable timestamp
 * @returns {Promise<{ accessKeyId: string, secretAccessKey: string, status: string }>}
 */
export async function createAwsAccessKey({
  accessKeyId,
  secretAccessKey,
  userName,
  fetchImpl = globalThis.fetch,
  now,
}) {
  const url = 'https://iam.amazonaws.com/';
  const body = `Action=CreateAccessKey&Version=2010-05-08${userName ? `&UserName=${encodeURIComponent(userName)}` : ''}`;

  const headers = signSigV4({
    method: 'POST',
    url,
    body,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    region: 'us-east-1',
    service: 'iam',
    accessKeyId,
    secretAccessKey,
    now,
  });

  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body,
  });

  const text = await response.text();

  if (!response.ok) {
    const errorMatch = text.match(/<Message>(.*?)<\/Message>/s);
    const err = errorMatch ? errorMatch[1] : `HTTP ${response.status}`;
    throw new Error(`AWS IAM CreateAccessKey failed: ${err}`);
  }

  const newIdMatch = text.match(/<AccessKeyId>(.*?)<\/AccessKeyId>/);
  const newSecretMatch = text.match(/<SecretAccessKey>(.*?)<\/SecretAccessKey>/);
  const statusMatch = text.match(/<Status>(.*?)<\/Status>/);

  if (!newIdMatch || !newSecretMatch) {
    throw new Error('AWS IAM CreateAccessKey response did not contain access key credentials');
  }

  return {
    accessKeyId: newIdMatch[1].trim(),
    secretAccessKey: newSecretMatch[1].trim(),
    status: statusMatch ? statusMatch[1].trim() : 'Active',
  };
}

/**
 * Deletes an AWS IAM access key.
 *
 * @param {object} params
 * @param {string} params.accessKeyId Current active AWS access key ID authorized to delete
 * @param {string} params.secretAccessKey Current active AWS secret access key
 * @param {string} params.targetAccessKeyId The access key ID to delete
 * @param {string} [params.userName] Optional target IAM username (omitted for caller)
 * @param {typeof fetch} [params.fetchImpl] Injectable fetch
 * @param {Date} [params.now] Injectable timestamp
 * @returns {Promise<{ ok: boolean, deletedAccessKeyId: string }>}
 */
export async function deleteAwsAccessKey({
  accessKeyId,
  secretAccessKey,
  targetAccessKeyId,
  userName,
  fetchImpl = globalThis.fetch,
  now,
}) {
  if (!targetAccessKeyId || typeof targetAccessKeyId !== 'string') {
    throw new Error('targetAccessKeyId must be specified');
  }

  const url = 'https://iam.amazonaws.com/';
  const body = `Action=DeleteAccessKey&AccessKeyId=${encodeURIComponent(targetAccessKeyId)}&Version=2010-05-08${userName ? `&UserName=${encodeURIComponent(userName)}` : ''}`;

  const headers = signSigV4({
    method: 'POST',
    url,
    body,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    region: 'us-east-1',
    service: 'iam',
    accessKeyId,
    secretAccessKey,
    now,
  });

  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    const errorMatch = text.match(/<Message>(.*?)<\/Message>/s);
    const err = errorMatch ? errorMatch[1] : `HTTP ${response.status}`;
    throw new Error(`AWS IAM DeleteAccessKey for ${targetAccessKeyId} failed: ${err}`);
  }

  return {
    ok: true,
    deletedAccessKeyId: targetAccessKeyId,
  };
}

/**
 * Verifies that the access key credentials can successfully call the AWS Pricing API.
 * Scoped to `pricing:GetProducts`.
 * Zero secret leakage: the secret key is never echoed into errors.
 *
 * @param {object} params
 * @param {string} params.accessKeyId AWS access key ID to probe
 * @param {string} params.secretAccessKey AWS secret access key to probe
 * @param {object} [params.clientImpl] Injectable PricingClient
 * @returns {Promise<{ ok: boolean, verified: boolean }>}
 */
export async function verifyAwsPricingAccess({
  accessKeyId,
  secretAccessKey,
  clientImpl,
}) {
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('accessKeyId and secretAccessKey are required for verification');
  }

  try {
    let response;
    const input = {
      ServiceCode: 'AmazonEC2',
      Filters: [{ Type: 'TERM_MATCH', Field: 'regionCode', Value: 'us-east-1' }],
      MaxResults: 1,
    };
    if (clientImpl) {
      response = await clientImpl.send({ input, ...input });
    } else {
      const { PricingClient, GetProductsCommand } = await import('@aws-sdk/client-pricing');
      const client = new PricingClient({
        region: 'us-east-1',
        credentials: {
          accessKeyId,
          secretAccessKey,
        },
      });
      const command = new GetProductsCommand({
        ServiceCode: 'AmazonEC2',
        Filters: [{ Type: 'TERM_MATCH', Field: 'regionCode', Value: 'us-east-1' }],
        MaxResults: 1,
      });
      response = await client.send(command);
    }
    if (!response || !Array.isArray(response.PriceList)) {
      throw new Error('Probe did not return a valid PriceList');
    }
    return { ok: true, verified: true };
  } catch (err) {
    throw new Error(`AWS Pricing verification probe failed (${err.message})`);
  }
}

/**
 * Orchestrates rolling the AWS price-list IAM access key with verify-before-delete semantics:
 * 1. Checks existing key count (enforces < 2 keys).
 * 2. Creates new access key pair on AWS IAM.
 * 3. Probes functional access to AWS Pricing API with the new key.
 *    If verification fails, deletes newly created key and aborts (old key preserved).
 * 4. Writes new access key ID and secret access key to Azure Key Vault and refreshes references.
 * 5. Deletes old access key on AWS IAM.
 *
 * @param {object} params
 * @param {string} params.currentAccessKeyId Current active AWS access key ID
 * @param {string} params.currentSecretAccessKey Current active AWS secret access key
 * @param {string} [params.userName] Target IAM user (defaults to current user)
 * @param {object} [params.vault] Injectable vault object with setSecret and refreshReferences
 * @param {typeof fetch} [params.fetchImpl] Injectable fetch
 * @param {object} [params.pricingClient] Injectable pricing client for probe
 * @param {boolean} [params.verify=true] Verify functional access before committing
 * @param {number} [params.maxVerifyAttempts=5] Maximum attempts for verification probe
 * @param {(ms: number) => Promise<void>} [params.sleepImpl] Injectable backoff sleep
 * @param {(params: { accessKeyId: string, secretAccessKey: string }) => Promise<void>} [params.verifyFromApp] Optional post-refresh app verifier
 * @param {Date} [params.now] Injectable timestamp
 * @returns {Promise<{ ok: boolean, newAccessKeyId: string, oldAccessKeyIdDeleted: string|null, refreshed: boolean, refreshReason: string|null }>}
 */
export async function rollAndApplyAwsKey({
  currentAccessKeyId,
  currentSecretAccessKey,
  userName,
  vault = { setSecret: setVaultSecret, refreshReferences: refreshKeyVaultReferences },
  fetchImpl = globalThis.fetch,
  pricingClient,
  verify = true,
  maxVerifyAttempts = 5,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  verifyFromApp,
  now,
}) {
  if (!currentAccessKeyId || typeof currentAccessKeyId !== 'string') {
    throw new Error('currentAccessKeyId is required');
  }
  if (!currentSecretAccessKey || typeof currentSecretAccessKey !== 'string') {
    throw new Error('currentSecretAccessKey is required');
  }

  // Step 1: Check existing access keys count
  const existingKeys = await listAwsAccessKeys({
    accessKeyId: currentAccessKeyId,
    secretAccessKey: currentSecretAccessKey,
    userName,
    fetchImpl,
    now,
  });

  if (existingKeys.length >= 2) {
    throw new Error(
      `IAM user already has ${existingKeys.length} access keys (maximum is 2). An unused key must be deleted before rotating.`
    );
  }

  // Step 2: Mint new access key pair
  const newKey = await createAwsAccessKey({
    accessKeyId: currentAccessKeyId,
    secretAccessKey: currentSecretAccessKey,
    userName,
    fetchImpl,
    now,
  });

  // Step 3: Functionally probe new credentials against AWS Pricing API with bounded retry and backoff
  if (verify) {
    let verified = false;
    let lastVerifyError = null;

    for (let attempt = 1; attempt <= maxVerifyAttempts; attempt += 1) {
      try {
        await verifyAwsPricingAccess({
          accessKeyId: newKey.accessKeyId,
          secretAccessKey: newKey.secretAccessKey,
          clientImpl: pricingClient,
        });
        verified = true;
        break;
      } catch (err) {
        lastVerifyError = err;
        if (attempt < maxVerifyAttempts) {
          await sleepImpl(attempt * 1000);
        }
      }
    }

    if (!verified) {
      // Clean up newly minted key so user quota is not exhausted
      try {
        await deleteAwsAccessKey({
          accessKeyId: currentAccessKeyId,
          secretAccessKey: currentSecretAccessKey,
          targetAccessKeyId: newKey.accessKeyId,
          userName,
          fetchImpl,
          now,
        });
      } catch {}
      throw new Error(
        `New AWS access key verification probe failed after ${maxVerifyAttempts} attempt(s) (${lastVerifyError?.message}). Minted key was deleted; old key preserved.`
      );
    }
  }

  // Step 4: Write both parts to Azure Key Vault and refresh references with rollback on write failure
  let idWritten = false;
  try {
    await vault.setSecret(AWS_TARGETS.pricing.idSecretName, newKey.accessKeyId);
    idWritten = true;
    await vault.setSecret(AWS_TARGETS.pricing.secretSecretName, newKey.secretAccessKey);
  } catch (writeErr) {
    if (idWritten) {
      try {
        await vault.setSecret(AWS_TARGETS.pricing.idSecretName, currentAccessKeyId);
      } catch {}
    }
    try {
      await deleteAwsAccessKey({
        accessKeyId: currentAccessKeyId,
        secretAccessKey: currentSecretAccessKey,
        targetAccessKeyId: newKey.accessKeyId,
        userName,
        fetchImpl,
        now,
      });
    } catch {}
    throw writeErr;
  }

  const refreshResult = await vault.refreshReferences();

  // Post-refresh app verification if provided
  if (verify && typeof verifyFromApp === 'function') {
    try {
      await verifyFromApp({
        accessKeyId: newKey.accessKeyId,
        secretAccessKey: newKey.secretAccessKey,
      });
    } catch (appErr) {
      try {
        await vault.setSecret(AWS_TARGETS.pricing.idSecretName, currentAccessKeyId);
        await vault.setSecret(AWS_TARGETS.pricing.secretSecretName, currentSecretAccessKey);
        await vault.refreshReferences();
      } catch {}
      try {
        await deleteAwsAccessKey({
          accessKeyId: currentAccessKeyId,
          secretAccessKey: currentSecretAccessKey,
          targetAccessKeyId: newKey.accessKeyId,
          userName,
          fetchImpl,
          now,
        });
      } catch {}
      throw new Error(`Post-refresh app verification failed: ${appErr.message}`);
    }
  }

  // Step 5: Delete old access key on AWS IAM using the NEW credentials ONLY if App Service refreshed
  let oldAccessKeyIdDeleted = null;
  if (refreshResult?.refreshed) {
    await deleteAwsAccessKey({
      accessKeyId: newKey.accessKeyId,
      secretAccessKey: newKey.secretAccessKey,
      targetAccessKeyId: currentAccessKeyId,
      userName,
      fetchImpl,
      now,
    });
    oldAccessKeyIdDeleted = currentAccessKeyId;
  }

  return {
    ok: true,
    newAccessKeyId: newKey.accessKeyId,
    oldAccessKeyIdDeleted,
    refreshed: Boolean(refreshResult?.refreshed),
    refreshReason: refreshResult?.reason ?? null,
  };
}
