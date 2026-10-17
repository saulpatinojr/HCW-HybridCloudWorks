/**
 * google-roll.js — Google Cloud API keys auto-renewal through Google Cloud
 * API Keys API v2 (apikeys.googleapis.com) with verify-before-delete semantics
 * (#1028).
 *
 * ## Invariants
 *
 * 1. ZERO VALUE LEAKAGE: Secret key strings are never logged, printed, or included
 *    in error messages or return structures.
 * 2. VERIFY BEFORE DELETE: The newly minted API key must be functionally probed
 *    against the actual Google Cloud service (Gemini, YouTube, Cloud Billing)
 *    AND committed to Azure Key Vault before the old key is deleted. If verification
 *    fails, the newly minted key is deleted and the old key remains active.
 * 3. RETRY & POLL LRO: Key creation returns a Long-Running Operation (LRO)
 *    which is polled with backoff until completed.
 * 4. PURE & INJECTABLE: All network calls accept an injectable `fetchImpl`,
 *    vault writer, and sleep helper for testability without live side-effects.
 */

import { setVaultSecret, refreshKeyVaultReferences } from '../secret-vault.js';

export const GOOGLE_TARGETS = Object.freeze({
  gemini: Object.freeze({
    id: 'kv-gemini-api-key',
    secretName: 'GEMINI-API-KEY',
    displayName: 'site-gemini-api-key',
    service: 'generativelanguage.googleapis.com',
    probeEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
    probeMethod: 'HEADER',
  }),
  youtube: Object.freeze({
    id: 'kv-youtube-api-key',
    secretName: 'YOUTUBE-API-KEY',
    displayName: 'site-youtube-api-key',
    service: 'youtube.googleapis.com',
    probeEndpoint: 'https://www.googleapis.com/youtube/v3/videos?part=id&chart=mostPopular&maxResults=1',
    probeMethod: 'QUERY',
  }),
  billing: Object.freeze({
    id: 'kv-gcp-billing-api-key',
    secretName: 'GCP-BILLING-API-KEY',
    displayName: 'site-gcp-billing-api-key',
    service: 'cloudbilling.googleapis.com',
    probeEndpoint: 'https://cloudbilling.googleapis.com/v1/services?pageSize=1',
    probeMethod: 'QUERY',
  }),
});

export const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Looks up an existing Google Cloud API key resource by its secret keyString.
 *
 * @param {object} params
 * @param {string} params.keyString The existing secret API key string
 * @param {string} params.gcpToken OAuth2 access token with apikeys.keys.lookup permission
 * @param {typeof fetch} [params.fetchImpl] Injectable fetch
 * @returns {Promise<{ name: string, parent: string }|null>}
 */
export async function lookupGoogleApiKey({
  keyString,
  gcpToken,
  fetchImpl = globalThis.fetch,
}) {
  if (!keyString || typeof keyString !== 'string') {
    throw new Error('keyString must be a non-empty string');
  }
  if (!gcpToken || typeof gcpToken !== 'string') {
    throw new Error('gcpToken must be a non-empty string');
  }

  const url = `https://apikeys.googleapis.com/v2/keys:lookupKey?keyString=${encodeURIComponent(keyString)}`;
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${gcpToken}`,
    },
  });

  if (response.status === 404) {
    return null;
  }

  let data = null;
  try {
    data = await response.json();
  } catch {}

  if (!response.ok || !data?.name) {
    const err = data?.error?.message || response.statusText || 'unknown error';
    throw new Error(`Google API key lookup failed (HTTP ${response.status}): ${err}`);
  }

  return {
    name: data.name,
    parent: data.parent || data.name.split('/locations/')[0],
  };
}

/**
 * Reads metadata and restrictions for an existing Google Cloud API key.
 *
 * @param {object} params
 * @param {string} params.keyName Resource name (e.g. projects/123/locations/global/keys/uuid)
 * @param {string} params.gcpToken OAuth2 access token
 * @param {typeof fetch} [params.fetchImpl] Injectable fetch
 * @returns {Promise<{ name: string, displayName: string, restrictions: object }>}
 */
export async function getGoogleKeyDetails({
  keyName,
  gcpToken,
  fetchImpl = globalThis.fetch,
}) {
  if (!keyName || typeof keyName !== 'string') {
    throw new Error('keyName must be a non-empty string');
  }
  if (!gcpToken || typeof gcpToken !== 'string') {
    throw new Error('gcpToken must be a non-empty string');
  }

  const url = `https://apikeys.googleapis.com/v2/${keyName}`;
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${gcpToken}`,
    },
  });

  let data = null;
  try {
    data = await response.json();
  } catch {}

  if (!response.ok || !data?.name) {
    const err = data?.error?.message || response.statusText || 'unknown error';
    throw new Error(`Google API key details read failed (HTTP ${response.status}): ${err}`);
  }

  return {
    name: data.name,
    displayName: data.displayName || '',
    restrictions: data.restrictions || {},
  };
}

/**
 * Initiates creation of a new Google Cloud API key. Returns the LRO operation.
 *
 * @param {object} params
 * @param {string} params.parent Resource parent (e.g. projects/123456 or projects/my-project)
 * @param {string} params.displayName Human-readable name for the key
 * @param {object} [params.restrictions] API target restrictions
 * @param {string} params.gcpToken OAuth2 access token
 * @param {typeof fetch} [params.fetchImpl] Injectable fetch
 * @returns {Promise<{ operationName: string, done: boolean, keyName?: string }>}
 */
export async function createGoogleApiKey({
  parent,
  displayName,
  restrictions = {},
  gcpToken,
  fetchImpl = globalThis.fetch,
}) {
  if (!parent || typeof parent !== 'string') {
    throw new Error('parent project must be specified (e.g. projects/123)');
  }
  if (!displayName || typeof displayName !== 'string') {
    throw new Error('displayName must be specified');
  }
  if (!gcpToken || typeof gcpToken !== 'string') {
    throw new Error('gcpToken must be a non-empty string');
  }

  const parentPath = parent.startsWith('projects/') ? parent : `projects/${parent}`;
  const url = `https://apikeys.googleapis.com/v2/${parentPath}/locations/global/keys`;

  const body = {
    displayName,
    ...(restrictions && Object.keys(restrictions).length > 0 ? { restrictions } : {}),
  };

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${gcpToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  let data = null;
  try {
    data = await response.json();
  } catch {}

  if (!response.ok || !data?.name) {
    const err = data?.error?.message || response.statusText || 'unknown error';
    throw new Error(`Google API key creation initiation failed (HTTP ${response.status}): ${err}`);
  }

  return {
    operationName: data.name,
    done: Boolean(data.done),
    keyName: data.response?.name ?? null,
  };
}

/**
 * Polls a Google Cloud API Keys LRO until completion.
 *
 * @param {object} params
 * @param {string} params.operationName Operation resource name (e.g. operations/...)
 * @param {string} params.gcpToken OAuth2 access token
 * @param {typeof fetch} [params.fetchImpl] Injectable fetch
 * @param {Function} [params.sleep] Sleep function for backoff
 * @param {number} [params.maxAttempts=20] Max polling attempts
 * @returns {Promise<{ keyName: string }>}
 */
export async function pollGoogleOperation({
  operationName,
  gcpToken,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  maxAttempts = 20,
}) {
  if (!operationName || typeof operationName !== 'string') {
    throw new Error('operationName must be specified');
  }

  const url = `https://apikeys.googleapis.com/v2/${operationName}`;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${gcpToken}`,
      },
    });

    let data = null;
    try {
      data = await response.json();
    } catch {}

    if (!response.ok) {
      const err = data?.error?.message || response.statusText || 'unknown error';
      throw new Error(`Polling operation ${operationName} failed (HTTP ${response.status}): ${err}`);
    }

    if (data.error) {
      throw new Error(`Google API key operation failed: ${data.error.message || 'unknown error'}`);
    }

    if (data.done) {
      const keyName = data.response?.name;
      if (!keyName) {
        throw new Error('Google API key operation completed without returning a key name');
      }
      return { keyName };
    }

    if (attempt < maxAttempts) {
      await sleep(100 * Math.min(attempt, 5));
    }
  }

  throw new Error(`Google API key operation ${operationName} timed out after ${maxAttempts} attempts`);
}

/**
 * Retrieves the plaintext keyString for a Google Cloud API key.
 *
 * @param {object} params
 * @param {string} params.keyName Resource name of the key
 * @param {string} params.gcpToken OAuth2 access token
 * @param {typeof fetch} [params.fetchImpl] Injectable fetch
 * @returns {Promise<string>} Plaintext keyString
 */
export async function getGoogleKeyString({
  keyName,
  gcpToken,
  fetchImpl = globalThis.fetch,
}) {
  if (!keyName || typeof keyName !== 'string') {
    throw new Error('keyName must be a non-empty string');
  }

  const url = `https://apikeys.googleapis.com/v2/${keyName}/keyString`;
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${gcpToken}`,
    },
  });

  let data = null;
  try {
    data = await response.json();
  } catch {}

  if (!response.ok || !data?.keyString) {
    const err = data?.error?.message || response.statusText || 'unknown error';
    throw new Error(`Retrieving keyString for ${keyName} failed (HTTP ${response.status}): ${err}`);
  }

  return data.keyString;
}

/**
 * Deletes a Google Cloud API key.
 *
 * @param {object} params
 * @param {string} params.keyName Resource name of the key to delete
 * @param {string} params.gcpToken OAuth2 access token
 * @param {typeof fetch} [params.fetchImpl] Injectable fetch
 * @returns {Promise<{ ok: boolean, deleted: boolean, keyName: string }>}
 */
export async function deleteGoogleApiKey({
  keyName,
  gcpToken,
  fetchImpl = globalThis.fetch,
}) {
  if (!keyName || typeof keyName !== 'string') {
    throw new Error('keyName must be a non-empty string');
  }

  const url = `https://apikeys.googleapis.com/v2/${keyName}`;
  const response = await fetchImpl(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${gcpToken}`,
    },
  });

  if (!response.ok) {
    let data = null;
    try {
      data = await response.json();
    } catch {}
    const err = data?.error?.message || response.statusText || 'unknown error';
    throw new Error(`Deleting Google API key ${keyName} failed (HTTP ${response.status}): ${err}`);
  }

  return {
    ok: true,
    deleted: true,
    keyName,
  };
}

/**
 * Performs a functional verification probe against the live service using the API key.
 * Zero secret leakage: the keyString is never echoed into errors.
 *
 * @param {object} params
 * @param {object} params.target Target descriptor from GOOGLE_TARGETS
 * @param {string} params.keyString Plaintext API key to verify
 * @param {typeof fetch} [params.fetchImpl] Injectable fetch
 * @returns {Promise<{ ok: boolean, verified: boolean }>}
 */
export async function verifyGoogleApiKey({
  target,
  keyString,
  fetchImpl = globalThis.fetch,
}) {
  if (!target || !target.probeEndpoint) {
    throw new Error('Target configuration with probeEndpoint is required');
  }
  if (!keyString || typeof keyString !== 'string') {
    throw new Error('keyString must be a non-empty string');
  }

  let url = target.probeEndpoint;
  const options = { method: 'GET' };

  if (target.probeMethod === 'HEADER') {
    options.headers = { 'x-goog-api-key': keyString };
  } else {
    const separator = url.includes('?') ? '&' : '?';
    url = `${url}${separator}key=${encodeURIComponent(keyString)}`;
  }

  const response = await fetchImpl(url, options);

  if (!response.ok) {
    throw new Error(
      `Verification probe for ${target.secretName} returned HTTP ${response.status}`
    );
  }

  return { ok: true, verified: true };
}

/**
 * Orchestrates rolling a Google Cloud API key with verify-before-delete semantics:
 * 1. Mint new key matching existing target restrictions.
 * 2. Functionally probe new key against the actual Google service.
 *    If verification fails, delete the new key immediately and abort (old key untouched).
 * 3. Commit new key to Azure Key Vault and trigger configuration reference refresh.
 * 4. Delete old key from Google Cloud API Keys.
 *
 * @param {object} params
 * @param {object} params.target Target descriptor (e.g. GOOGLE_TARGETS.gemini)
 * @param {string} params.gcpToken OAuth2 access token with apikeys admin permissions
 * @param {string} [params.oldKeyString] Current key secret (used to lookup old resource)
 * @param {string} [params.oldKeyName] Explicit old key resource name if known
 * @param {string} [params.parent] Project resource name (e.g. projects/123456 or projects/my-proj)
 * @param {object} [params.vault] Injectable vault object with setSecret and refreshReferences
 * @param {typeof fetch} [params.fetchImpl] Injectable fetch
 * @param {Function} [params.sleep] Injectable sleep
 * @param {boolean} [params.verify=true] Verify functional access before committing
 * @returns {Promise<{ ok: boolean, secretName: string, newKeyName: string, oldKeyDeleted: boolean }>}
 */
export async function rollAndApplyGoogleKey({
  target,
  gcpToken,
  oldKeyString,
  oldKeyName: explicitOldKeyName,
  parent: explicitParent,
  vault = { setSecret: setVaultSecret, refreshReferences: refreshKeyVaultReferences },
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  verify = true,
}) {
  if (!target || typeof target !== 'object' || !target.secretName) {
    throw new Error('Target configuration with secretName is required');
  }
  if (!gcpToken || typeof gcpToken !== 'string') {
    throw new Error('gcpToken is required');
  }

  let resolvedOldKeyName = explicitOldKeyName ?? null;
  let resolvedParent = explicitParent ?? null;
  let restrictions = {
    apiTargets: [{ service: target.service }],
  };

  // Step 1: Discover old key resource if oldKeyString is provided
  if (oldKeyString && !resolvedOldKeyName) {
    try {
      const lookup = await lookupGoogleApiKey({ keyString: oldKeyString, gcpToken, fetchImpl });
      if (lookup) {
        resolvedOldKeyName = lookup.name;
        resolvedParent ??= lookup.parent;
        const details = await getGoogleKeyDetails({ keyName: lookup.name, gcpToken, fetchImpl });
        if (details.restrictions && Object.keys(details.restrictions).length > 0) {
          restrictions = details.restrictions;
        }
      }
    } catch {
      // Lookup error is non-fatal; we proceed with explicitParent or fallback
    }
  }

  if (!resolvedParent) {
    throw new Error(`Cannot roll ${target.secretName}: GCP parent project could not be resolved`);
  }

  // Step 2: Mint new key on Google Cloud API Keys API
  const initResult = await createGoogleApiKey({
    parent: resolvedParent,
    displayName: target.displayName,
    restrictions,
    gcpToken,
    fetchImpl,
  });

  let newKeyName = initResult.keyName;
  if (!newKeyName) {
    const pollResult = await pollGoogleOperation({
      operationName: initResult.operationName,
      gcpToken,
      fetchImpl,
      sleep,
    });
    newKeyName = pollResult.keyName;
  }

  const newKeyString = await getGoogleKeyString({
    keyName: newKeyName,
    gcpToken,
    fetchImpl,
  });

  // Step 3: Verify the newly minted key against live service BEFORE committing or deleting
  if (verify) {
    try {
      await verifyGoogleApiKey({ target, keyString: newKeyString, fetchImpl });
    } catch (verifyErr) {
      // Clean up newly minted key so estate is not polluted with defective keys
      try {
        await deleteGoogleApiKey({ keyName: newKeyName, gcpToken, fetchImpl });
      } catch {}
      throw new Error(
        `New API key verification probe failed for ${target.secretName} (${verifyErr.message}). Minted key was deleted; old key preserved.`
      );
    }
  }

  // Step 4: Write to Azure Key Vault and refresh references
  await vault.setSecret(target.secretName, newKeyString);
  await vault.refreshReferences();

  // Step 5: Delete old key on Google Cloud
  let oldKeyDeleted = false;
  if (resolvedOldKeyName && resolvedOldKeyName !== newKeyName) {
    try {
      await deleteGoogleApiKey({ keyName: resolvedOldKeyName, gcpToken, fetchImpl });
      oldKeyDeleted = true;
    } catch {}
  }

  return {
    ok: true,
    secretName: target.secretName,
    newKeyName,
    oldKeyDeleted,
  };
}
