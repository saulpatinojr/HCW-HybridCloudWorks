/**
 * google-rotate.js — the rotation of one Google Cloud API key (#1028), with
 * the verify-before-delete steps google-roll.js's header describes. The API
 * calls it makes live in google-roll.js, which re-exports
 * rollAndApplyGoogleKey so callers keep one import.
 */
import { setVaultSecret, refreshKeyVaultReferences } from '../secret-vault.js';
import {
  createGoogleApiKey,
  defaultSleep,
  deleteGoogleApiKey,
  getGoogleKeyDetails,
  getGoogleKeyString,
  lookupGoogleApiKey,
  pollGoogleOperation,
  verifyGoogleApiKey,
} from './google-roll.js';

/**
 * The key being replaced: its resource name, its project (parent) and the
 * restrictions the new key should copy. Looked up by its value when only the
 * value is known; a value Google does not know is refused unless
 * `allowUnmanagedOldKey` says a new key may be made without revoking one.
 */
async function resolveOldKey({ target, oldKeyString, explicitOldKeyName, explicitParent, allowUnmanagedOldKey }, google) {
  const old = {
    keyName: explicitOldKeyName ?? null,
    parent: explicitParent ?? null,
    restrictions: { apiTargets: [{ service: target.service }] },
  };
  if (oldKeyString && !old.keyName) {
    const lookup = await lookupGoogleApiKey({ keyString: oldKeyString, ...google });
    if (lookup) {
      old.keyName = lookup.name;
      old.parent ??= lookup.parent;
      const details = await getGoogleKeyDetails({ keyName: lookup.name, ...google });
      if (details?.restrictions && Object.keys(details.restrictions).length > 0) {
        old.restrictions = details.restrictions;
      }
    } else if (!allowUnmanagedOldKey) {
      throw new Error(
        `Failed to locate Google API key for ${target.secretName} in GCP; cannot rotate safely without revoking old key.`
      );
    }
  }
  if (!old.parent) {
    throw new Error(`Cannot roll ${target.secretName}: GCP parent project could not be resolved`);
  }
  return old;
}

/** Create the new key and wait for Google to finish making it; answers its resource name. */
async function mintKey({ target, parent, restrictions, sleep }, google) {
  const initResult = await createGoogleApiKey({
    parent,
    displayName: target.displayName,
    restrictions,
    ...google,
  });
  if (initResult.keyName) return initResult.keyName;
  const pollResult = await pollGoogleOperation({
    operationName: initResult.operationName,
    ...google,
    sleep,
  });
  return pollResult.keyName;
}

/** Delete a key, best effort: a failure here must not hide the one that made it necessary. */
async function dropKey(keyName, google) {
  try {
    await deleteGoogleApiKey({ keyName, ...google });
  } catch {}
}

/** The app's own check of the new key; on a failure, put the old value back (when known), drop the new key and throw. */
async function verifyFromAppOrRollBack({ verifyFromApp, vault, target, oldKeyString, newKeyName, newKeyString }, google) {
  try {
    await verifyFromApp({ keyString: newKeyString, target });
  } catch (appErr) {
    if (oldKeyString) {
      try {
        await vault.setSecret(target.secretName, oldKeyString);
        await vault.refreshReferences();
      } catch {}
    }
    await dropKey(newKeyName, google);
    throw new Error(`Post-refresh app verification failed for ${target.secretName}: ${appErr.message}`);
  }
}

/** Delete the old key once the app reads the new one; true when it went. */
async function deleteOldKey(oldKeyName, newKeyName, google) {
  if (!oldKeyName || oldKeyName === newKeyName) return false;
  try {
    await deleteGoogleApiKey({ keyName: oldKeyName, ...google });
    return true;
  } catch {
    return false;
  }
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
 * @param {boolean} [params.allowUnmanagedOldKey=false] Allow creating a new key if oldKeyString is not found
 * @param {(params: { keyString: string, target: object }) => Promise<void>} [params.verifyFromApp] Optional post-refresh app verifier
 * @returns {Promise<{ ok: boolean, secretName: string, newKeyName: string, oldKeyDeleted: boolean, refreshed: boolean, refreshReason: string|null }>}
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
  allowUnmanagedOldKey = false,
  verifyFromApp,
}) {
  if (!target || typeof target !== 'object' || !target.secretName) {
    throw new Error('Target configuration with secretName is required');
  }
  if (!gcpToken || typeof gcpToken !== 'string') {
    throw new Error('gcpToken is required');
  }
  const google = { gcpToken, fetchImpl };

  // Step 1: Discover old key resource if oldKeyString is provided
  const old = await resolveOldKey({ target, oldKeyString, explicitOldKeyName, explicitParent, allowUnmanagedOldKey }, google);

  // Step 2: Mint new key on Google Cloud API Keys API
  const newKeyName = await mintKey({ target, parent: old.parent, restrictions: old.restrictions, sleep }, google);
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
      await dropKey(newKeyName, google);
      throw new Error(
        `New API key verification probe failed for ${target.secretName} (${verifyErr.message}). Minted key was deleted; old key preserved.`
      );
    }
  }

  // Step 4: Write to Azure Key Vault and refresh references
  try {
    await vault.setSecret(target.secretName, newKeyString);
  } catch (writeErr) {
    await dropKey(newKeyName, google);
    throw writeErr;
  }

  const refreshResult = await vault.refreshReferences();

  // Post-refresh app verification if provided
  if (verify && typeof verifyFromApp === 'function') {
    await verifyFromAppOrRollBack({ verifyFromApp, vault, target, oldKeyString, newKeyName, newKeyString }, google);
  }

  // Step 5: Delete old key on Google Cloud ONLY if App Service refreshed
  const oldKeyDeleted = refreshResult?.refreshed ? await deleteOldKey(old.keyName, newKeyName, google) : false;

  return {
    ok: true,
    secretName: target.secretName,
    newKeyName,
    oldKeyDeleted,
    refreshed: Boolean(refreshResult?.refreshed),
    refreshReason: refreshResult?.reason ?? null,
  };
}
