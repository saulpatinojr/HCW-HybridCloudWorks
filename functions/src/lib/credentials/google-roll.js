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

import { withStatus } from '../http/error-response.js';

/** Refuse a missing or non-text argument with `message`. */
function requireText(value, message) {
  if (!value || typeof value !== 'string') {
    throw new Error(message);
  }
}

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

/** The JSON body of a response, or null when it has none. */
async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** The error for a refused Google call: `sentence`, then Google's own message or the status text, with the status kept. */
function googleFailure(response, data, sentence) {
  const err = data?.error?.message || response.statusText || 'unknown error';
  return withStatus(new Error(`${sentence}: ${err}`), response.status);
}

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
  requireText(keyString, 'keyString must be a non-empty string');
  requireText(gcpToken, 'gcpToken must be a non-empty string');

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

  const data = await readJson(response);
  if (!response.ok || !data?.name) {
    throw googleFailure(response, data, `Google API key lookup failed (HTTP ${response.status})`);
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
  requireText(keyName, 'keyName must be a non-empty string');
  requireText(gcpToken, 'gcpToken must be a non-empty string');

  const url = `https://apikeys.googleapis.com/v2/${keyName}`;
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${gcpToken}`,
    },
  });

  const data = await readJson(response);
  if (!response.ok || !data?.name) {
    throw googleFailure(response, data, `Google API key details read failed (HTTP ${response.status})`);
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
  requireText(parent, 'parent project must be specified (e.g. projects/123)');
  requireText(displayName, 'displayName must be specified');
  requireText(gcpToken, 'gcpToken must be a non-empty string');

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

  const data = await readJson(response);
  if (!response.ok || !data?.name) {
    throw googleFailure(response, data, `Google API key creation initiation failed (HTTP ${response.status})`);
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
  requireText(operationName, 'operationName must be specified');

  const url = `https://apikeys.googleapis.com/v2/${operationName}`;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${gcpToken}`,
      },
    });
    const keyName = finishedKeyName(response, await readJson(response), operationName);
    if (keyName) return { keyName };

    if (attempt < maxAttempts) {
      await sleep(100 * Math.min(attempt, 5));
    }
  }

  throw new Error(`Google API key operation ${operationName} timed out after ${maxAttempts} attempts`);
}

/**
 * One poll's answer: the new key's name once the operation is done, null while
 * it runs, and an error when the poll or the operation failed.
 */
function finishedKeyName(response, data, operationName) {
  if (!response.ok) {
    throw googleFailure(response, data, `Polling operation ${operationName} failed (HTTP ${response.status})`);
  }
  if (data.error) {
    throw new Error(`Google API key operation failed: ${data.error.message || 'unknown error'}`);
  }
  if (!data.done) return null;
  const keyName = data.response?.name;
  if (!keyName) {
    throw new Error('Google API key operation completed without returning a key name');
  }
  return keyName;
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
  requireText(keyName, 'keyName must be a non-empty string');

  const url = `https://apikeys.googleapis.com/v2/${keyName}/keyString`;
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${gcpToken}`,
    },
  });

  const data = await readJson(response);
  if (!response.ok || !data?.keyString) {
    throw googleFailure(response, data, `Retrieving keyString for ${keyName} failed (HTTP ${response.status})`);
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
  requireText(keyName, 'keyName must be a non-empty string');

  const url = `https://apikeys.googleapis.com/v2/${keyName}`;
  const response = await fetchImpl(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${gcpToken}`,
    },
  });

  if (!response.ok) {
    const data = await readJson(response);
    throw googleFailure(response, data, `Deleting Google API key ${keyName} failed (HTTP ${response.status})`);
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
  requireText(keyString, 'keyString must be a non-empty string');

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
    throw withStatus(
      new Error(`Verification probe for ${target.secretName} returned HTTP ${response.status}`),
      response.status
    );
  }

  return { ok: true, verified: true };
}

/** The whole rotation, in google-rotate.js; re-exported so callers keep one import. */
export { rollAndApplyGoogleKey } from './google-rotate.js';
