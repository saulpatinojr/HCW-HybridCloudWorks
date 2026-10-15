/**
 * Write one Key Vault secret, and ask the platform to re-read its references.
 *
 * ## This module can write and cannot read, on purpose
 *
 * There is no `getSecret` here, and adding one would defeat the feature this
 * serves. The API-keys page promises that a pasted credential cannot be pulled
 * back out; a read function in this module is the first thing a future change
 * would reach for to "just show the last four characters".
 *
 * That promise is also enforced BELOW the code: the Function App's identity
 * holds a custom role with `Microsoft.KeyVault/vaults/secrets/setSecret/action`
 * and nothing else — not `getSecret`, not `delete`, not `purge`. If this module
 * grew a reader it would get a 403, not a secret.
 *
 * The honest limit of that: a secret that HAS resolved into an app setting is
 * already in `process.env`, so the app can read the values it is actively
 * using by definition. The set-only role stops it reading other secrets, other
 * VERSIONS of the same secret, and anything it has no reference for — and it
 * stops a compromised app destroying the vault's contents, which
 * `Key Vault Secrets Officer` would allow.
 *
 * ## No SDK
 *
 * `@azure/keyvault-secrets` was removed from this codebase when GCP pricing
 * stopped needing a runtime vault client. Setting a secret is one authenticated
 * PUT, so it comes back as `fetch` rather than as a dependency — the same
 * decision, for the same reason, as the one that removed it.
 *
 * ## Why the refresh call exists and why it must never throw
 *
 * App Service caches Key Vault references and refetches them every 24 hours.
 * Without a nudge, a pasted key is in the vault but not in the running app for
 * up to a day, and the page would look broken. The documented nudge is a POST
 * to the site's `config/configreferences/appsettings/refresh` endpoint.
 *
 * It is best-effort by design. If the grant is missing, ARM is throttling, or
 * the endpoint changes, the SECRET IS ALREADY SAFELY WRITTEN — the only cost is
 * that the value goes live on the 24-hour cycle instead of now. Letting a
 * refresh failure fail the request would report "seeding failed" for a seeding
 * that succeeded, and the operator's next move would be to paste it again.
 */

import { DefaultAzureCredential } from '@azure/identity';
import { errorCode } from './http/error-response.js';

/** Key Vault data-plane API version. */
export const VAULT_API_VERSION = '7.4';

/** ARM API version for the config-references refresh endpoint. */
export const REFRESH_API_VERSION = '2022-03-01';

const VAULT_SCOPE = 'https://vault.azure.net/.default';
const ARM_SCOPE = 'https://management.azure.com/.default';

let cachedCredential = null;

function credential(deps = {}) {
  if (deps.credential) return deps.credential;
  cachedCredential ??= new DefaultAzureCredential();
  return cachedCredential;
}

/** Drop the memoised credential. Tests only. */
export function resetSecretVaultForTests() {
  cachedCredential = null;
}

async function bearer(scope, deps) {
  const token = await credential(deps).getToken(scope);
  if (!token?.token) throw new Error(`Could not acquire a token for ${scope}`);
  return token.token;
}

/**
 * The vault address, from the app setting Terraform derives.
 *
 * Returned with exactly one trailing slash so callers can concatenate without
 * producing `//secrets/NAME`, which Key Vault answers with a 404 that reads
 * like a missing secret.
 */
export function vaultBaseUrl(env = process.env) {
  const raw = String(env?.KEY_VAULT_URI ?? '').trim();
  if (!raw) throw new Error('KEY_VAULT_URI is not set — the vault address is unknown');
  return raw.endsWith('/') ? raw : `${raw}/`;
}

/**
 * Write a new version of one secret.
 *
 * Key Vault's PUT creates a new VERSION rather than overwriting, and the app's
 * references are versionless, so the newest version is what resolves. Nothing
 * is destroyed by a rotation — the previous value stays recoverable through
 * soft delete for the vault's 90-day retention.
 *
 * @returns {Promise<{version: string|null}>}
 */
export async function setVaultSecret(name, value, deps = {}) {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const base = deps.vaultUrl ?? vaultBaseUrl(deps.env ?? process.env);
  const token = await bearer(VAULT_SCOPE, deps);

  const url = `${base}secrets/${encodeURIComponent(name)}?api-version=${VAULT_API_VERSION}`;
  const response = await doFetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });

  if (!response.ok) {
    // The NAME is safe to report and is what an operator needs. The body is
    // not: a Key Vault error can echo the request, and this request's body is
    // the credential.
    throw new Error(`Key Vault refused to set ${name}: HTTP ${response.status}`);
  }

  const json = await response.json().catch(() => ({}));
  return { version: versionFromId(json?.id) };
}

/** The version segment of a Key Vault secret id, or null. */
export function versionFromId(id) {
  if (typeof id !== 'string') return null;
  const parts = id.split('/').filter(Boolean);
  return parts.length ? (parts[parts.length - 1] ?? null) : null;
}

/**
 * Ask App Service to re-resolve every Key Vault reference now.
 *
 * Never throws — see the module header. Returns what happened so the caller can
 * tell the operator whether to expect the key live now or within 24 hours.
 *
 * @returns {Promise<{refreshed: boolean, reason: string|null}>}
 */
export async function refreshKeyVaultReferences(deps = {}) {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const env = deps.env ?? process.env;
  const resourceId = deps.resourceId ?? String(env?.FUNCTION_APP_RESOURCE_ID ?? '').trim();

  if (!resourceId) {
    return { refreshed: false, reason: 'FUNCTION_APP_RESOURCE_ID is not set' };
  }

  try {
    const token = await bearer(ARM_SCOPE, deps);
    const url =
      `https://management.azure.com${resourceId}` +
      `/config/configreferences/appsettings/refresh?api-version=${REFRESH_API_VERSION}`;
    const response = await doFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      return { refreshed: false, reason: `refresh endpoint returned ${response.status}` };
    }
    return { refreshed: true, reason: null };
  } catch (error) {
    // Reaches the secrets page's answer: the code, never the SDK's sentence (#945).
    return { refreshed: false, reason: `refresh call failed (${errorCode(error)})` };
  }
}
