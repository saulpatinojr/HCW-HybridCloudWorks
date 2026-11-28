/**
 * cloudflare-roll.js — Cloudflare API token auto-renewal through the roll-token
 * endpoint and automated write-back to HCP Terraform / lab host Ansible Vault
 * (#1027).
 *
 * ## Invariants
 *
 * 1. ZERO VALUE LEAKAGE: Token secrets are never logged, printed, or included
 *    in error messages or return structures.
 * 2. WRITE IMMEDIATELY AFTER THE ROLL: Cloudflare's roll endpoint retires the
 *    old value at once, so the new value is written to the target store (with
 *    retries) straight after the roll. That cannot be made atomic: if every
 *    write attempt fails, the store is left holding a retired token, and the
 *    error says so (the recovery is in docs/runbooks/dns-token-stolen.md,
 *    "Routine renewal"). To make that unlikely, the store is checked BEFORE
 *    the roll (#1927), with the same credentials the write will use: an
 *    HCP Terraform workspace must report `can-update-variable: true` for
 *    the token and list its variables, and on the lab host `sudo -n -l`
 *    must allow hcw-vault-set. That proves permission, not that the write
 *    itself will succeed (a network failure can still come between).
 * 3. POST-WRITE VERIFICATION: The newly written token is verified against
 *    Cloudflare's verify endpoint for its kind (`/user/tokens/verify` or
 *    `/accounts/{account_id}/tokens/verify`). Any verification anomaly is
 *    reported as a warning rather than aborting an already-committed rotation.
 * 4. STDIN FOR VAULT: Lab host Ansible Vault updates use `hcw-vault-set`,
 *    passing the token exclusively on stdin.
 * 5. JSON:API FOR TFC: HCP Terraform variables require
 *    `Content-Type: application/vnd.api+json`.
 * 6. PURE & INJECTABLE: Network operations use an injectable `fetchImpl` and
 *    shell operations use an injectable `execImpl` for testability without
 *    live external side-effects.
 * 7. ONE ROUTE PER TOKEN KIND (#1927): Cloudflare has two kinds of API token.
 *    A user token belongs to one person's profile (My Profile → API Tokens)
 *    and rolls through `/user/tokens/{id}/value`. An account-owned token
 *    belongs to the account (Manage account → Account API tokens) and rolls
 *    through `/accounts/{account_id}/tokens/{id}/value`. Each target says
 *    which kind it holds (`owner`, required: a target without one is refused,
 *    never taken for a user token), and everything that can be checked
 *    without retiring the old value is checked BEFORE the roll: the kind,
 *    the account id, the target type, the HCP Terraform token's right to
 *    write the workspace's variables, or the vault key's shape and the
 *    right to run hcw-vault-set.
 */

import { withStatus } from '../http/error-response.js';
import { storeFor } from './cloudflare-roll-stores.js';

// The two stores a rolled token is written to live in cloudflare-roll-stores.js;
// callers keep importing them from here.
export {
  readTfcWorkspace,
  checkTfcVariablesWritable,
  checkLabVaultWritable,
  updateTfcVariable,
  defaultSpawnRunner,
  updateLabVaultSecret,
  STORES,
  storeFor,
} from './cloudflare-roll-stores.js';

const CF_API = 'https://api.cloudflare.com/client/v4';

/**
 * The two kinds of Cloudflare API token, and the API routes each one rolls
 * and verifies through (#1927). Cloudflare's API reference:
 *   user:    Roll Token, PUT /user/tokens/{token_id}/value ("API Tokens Write")
 *            https://developers.cloudflare.com/api/resources/user/subresources/tokens/subresources/value/methods/update/
 *   account: Roll Token, PUT /accounts/{account_id}/tokens/{token_id}/value
 *            ("Account API Tokens Write")
 *            https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/subresources/value/methods/update/
 *            Verify Token, GET /accounts/{account_id}/tokens/verify
 *            https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/verify/
 * All three routes, and the permission each roll needs, were read on
 * 2026-11-27 from those pages and from Cloudflare's OpenAPI schema.
 * A kind not in this list cannot be renewed by this module; the register and
 * the runbook are held to it by cloudflare-token-kinds.test.js.
 */
export const TOKEN_OWNERS = Object.freeze({
  user: Object.freeze({
    label: 'user token (My Profile → API Tokens)',
    rollPermission: 'API Tokens Write',
    needsAccountId: false,
    rollPath: ({ tokenId }) => `/user/tokens/${encodeURIComponent(tokenId)}/value`,
    verifyPath: () => '/user/tokens/verify',
  }),
  account: Object.freeze({
    label: 'account-owned token (Manage account → Account API tokens)',
    rollPermission: 'Account API Tokens Write',
    needsAccountId: true,
    rollPath: ({ tokenId, accountId }) =>
      `/accounts/${encodeURIComponent(accountId)}/tokens/${encodeURIComponent(tokenId)}/value`,
    verifyPath: ({ accountId }) => `/accounts/${encodeURIComponent(accountId)}/tokens/verify`,
  }),
});

/** A Cloudflare account id: 32 lowercase hex characters, an identifier and not a credential. */
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * The route table for a token kind, after checking that the kind is known
 * and, for an account-owned token, that an account id of the right shape was
 * given. Throws before anything is sent. The account id is never put in a
 * message.
 *
 * @param {object} params
 * @param {string} [params.owner='user'] 'user' or 'account'
 * @param {string} [params.accountId] Cloudflare account id (32 lowercase hex)
 */
export function tokenOwnerRoutes({ owner = 'user', accountId } = {}) {
  const routes = Object.hasOwn(TOKEN_OWNERS, owner) ? TOKEN_OWNERS[owner] : null;
  if (!routes) {
    throw new Error(
      `Unknown Cloudflare token owner kind: '${owner}' (expected ${Object.keys(TOKEN_OWNERS).join(' or ')})`
    );
  }
  if (routes.needsAccountId && !(typeof accountId === 'string' && ACCOUNT_ID_PATTERN.test(accountId))) {
    throw new Error(
      'An account-owned Cloudflare token needs the Cloudflare account id (32 lowercase hex characters; set CLOUDFLARE_ACCOUNT_ID)'
    );
  }
  return routes;
}

/**
 * The three Cloudflare token targets managed by this estate (#1027).
 *
 * `owner` is the token's kind (TOKEN_OWNERS) and `tokenName` the name the
 * Cloudflare dashboard shows for it, so it can be found there (#1927):
 *   azure  the account-owned token `hcw`. Observed 2026-11-27: its "last
 *          used" time matched hcw-azure runs to the second, and adding a
 *          permission to it is what turned the #1926 trial plan green.
 *   lab    most likely the user token `hcp-terraform-cloudflare-dns`: it was
 *          last used the day #1743 changed infra-lab. NOT CONFIRMED
 *          (`tokenNameConfirmed: false`); how to confirm it is in
 *          docs/runbooks/dns-token-stolen.md.
 *   caddy  a user token, as this module has always rolled it; its name is
 *          kept out of the repository (the CLOUDFLARE_CADDY_TOKEN_NAME
 *          repository variable holds it).
 */
export const CLOUDFLARE_TARGETS = Object.freeze({
  azure: Object.freeze({
    id: 'tfc-azure-cloudflare-api-token',
    name: 'Azure HCP Terraform workspace (hcw/hcw-azure)',
    owner: 'account',
    tokenName: 'hcw',
    tokenNameConfirmed: true,
    type: 'tfc',
    organization: 'hcw',
    workspace: 'hcw-azure',
    key: 'cloudflare_api_token',
    category: 'terraform',
    sensitive: true,
    description: 'Cloudflare API token for the DNS records',
    envTokenId: 'CLOUDFLARE_AZURE_TOKEN_ID',
  }),
  lab: Object.freeze({
    id: 'tfc-lab-cloudflare-api-token',
    name: 'Lab HCP Terraform workspace (hcw/hcw-lab)',
    owner: 'user',
    tokenName: 'hcp-terraform-cloudflare-dns',
    tokenNameConfirmed: false,
    type: 'tfc',
    organization: 'hcw',
    workspace: 'hcw-lab',
    key: 'cloudflare_api_token',
    category: 'terraform',
    sensitive: true,
    description: 'Cloudflare API token for lab DNS records',
    envTokenId: 'CLOUDFLARE_LAB_TOKEN_ID',
  }),
  caddy: Object.freeze({
    id: 'lab-caddy-cloudflare-api-token',
    name: 'Lab host Ansible Vault (vault_cloudflare_api_token)',
    owner: 'user',
    tokenName: null,
    tokenNameConfirmed: false,
    type: 'lab-vault',
    vaultKey: 'vault_cloudflare_api_token',
    envTokenId: 'CLOUDFLARE_CADDY_TOKEN_ID',
  }),
});


const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries an asynchronous operation with exponential backoff.
 */
async function retry(fn, { attempts = 3, sleep = defaultSleep } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        await sleep(50 * Math.pow(2, attempt - 1));
      }
    }
  }
  throw lastError;
}

/**
 * Rolls a Cloudflare API token using Cloudflare's roll-token endpoint for its
 * kind (TOKEN_OWNERS):
 *   user     PUT /user/tokens/{tokenId}/value
 *   account  PUT /accounts/{accountId}/tokens/{tokenId}/value
 *
 * Rolling immediately invalidates the old token string and generates a new
 * secret string while preserving existing permissions and policies.
 *
 * @param {object} params
 * @param {string} params.tokenId Cloudflare alphanumeric token ID
 * @param {string} params.rollToken Cloudflare API token allowed to roll tokens
 *   of that kind (TOKEN_OWNERS[owner].rollPermission)
 * @param {'user'|'account'} [params.owner='user'] The token's kind
 * @param {string} [params.accountId] The Cloudflare account id; required for 'account'
 * @param {typeof fetch} [params.fetchImpl] Injectable fetch
 * @returns {Promise<{ tokenId: string, tokenValue: string }>}
 */
export async function rollCloudflareToken({
  tokenId,
  rollToken,
  owner = 'user',
  accountId,
  fetchImpl = globalThis.fetch,
}) {
  if (!tokenId || typeof tokenId !== 'string') {
    throw new Error('Cloudflare tokenId is required');
  }
  if (!rollToken || typeof rollToken !== 'string') {
    throw new Error('Cloudflare rollToken is required');
  }
  const routes = tokenOwnerRoutes({ owner, accountId });

  const url = `${CF_API}${routes.rollPath({ tokenId, accountId })}`;
  const response = await fetchImpl(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${rollToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    // Non-JSON response
  }

  if (!response.ok || !data?.success) {
    const errorDetail =
      data?.errors?.map((e) => e.message).join('; ') ||
      response.statusText ||
      'unknown error';
    throw withStatus(
      new Error(`Cloudflare roll-token request failed (${response.status}): ${errorDetail}`),
      response.status
    );
  }

  const tokenValue =
    typeof data.result === 'string' ? data.result : data.result?.value;
  if (!tokenValue || typeof tokenValue !== 'string') {
    throw new Error(
      'Cloudflare roll-token response did not contain a valid token secret'
    );
  }

  return { tokenId, tokenValue };
}

/**
 * Verifies a Cloudflare API token against the verify endpoint for its kind:
 *   user     GET /user/tokens/verify
 *   account  GET /accounts/{accountId}/tokens/verify
 *
 * @param {object} params
 * @param {string} params.tokenValue The token secret string to verify
 * @param {'user'|'account'} [params.owner='user'] The token's kind
 * @param {string} [params.accountId] The Cloudflare account id; required for 'account'
 * @param {typeof fetch} [params.fetchImpl] Injectable fetch
 * @returns {Promise<{ valid: boolean, id: string, status: string }>}
 */
export async function verifyCloudflareToken({
  tokenValue,
  owner = 'user',
  accountId,
  fetchImpl = globalThis.fetch,
}) {
  if (!tokenValue || typeof tokenValue !== 'string') {
    throw new Error('Cloudflare tokenValue is required');
  }
  const routes = tokenOwnerRoutes({ owner, accountId });

  const url = `${CF_API}${routes.verifyPath({ accountId })}`;
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${tokenValue}`,
    },
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    // Non-JSON response
  }

  if (!response.ok || !data?.success) {
    const errorDetail =
      data?.errors?.map((e) => e.message).join('; ') ||
      response.statusText ||
      'unknown error';
    throw withStatus(
      new Error(`Cloudflare token verification failed (${response.status}): ${errorDetail}`),
      response.status
    );
  }

  if (data.result?.status !== 'active') {
    throw new Error(
      `Cloudflare token is not active (status: ${data.result?.status || 'unknown'})`
    );
  }

  return {
    valid: true,
    id: data.result.id,
    status: data.result.status,
  };
}

/**
 * Orchestrates rolling a Cloudflare token, writing it back to its target store
 * immediately with retries (preventing destination stores from being left with
 * an invalidated token), and then verifying it.
 *
 * @param {object} params
 * @param {string} params.tokenId Cloudflare token ID to roll
 * @param {string} params.rollToken Cloudflare credential allowed to roll the target's kind of
 *   token (TOKEN_OWNERS[target.owner].rollPermission)
 * @param {object} params.target Target descriptor (from CLOUDFLARE_TARGETS or matching shape);
 *   `owner` ('user' or 'account') is required
 * @param {string} [params.accountId] Cloudflare account id; required when target.owner is 'account'
 * @param {string} [params.tfcToken] HCP Terraform API token (required if target.type === 'tfc')
 * @param {typeof fetch} [params.fetchImpl] Injectable fetch
 * @param {Function} [params.execImpl] Injectable runner for vault
 * @param {boolean} [params.verify=true] Verify token after writing
 * @param {Function} [params.sleep] Injectable sleep for retry backoff
 * @returns {Promise<{ ok: boolean, tokenId: string, targetType: string, targetName: string, action: string, verified: boolean, warning?: string }>}
 */
export async function rollAndApplyCloudflareToken({
  tokenId,
  rollToken,
  target,
  accountId,
  tfcToken,
  fetchImpl = globalThis.fetch,
  execImpl,
  verify = true,
  sleep = defaultSleep,
}) {
  // Everything that can be checked without retiring the old value is
  // checked here, before the roll: the store's type, the kind of token and
  // its route, and that the credentials the write will use are allowed to
  // write that store (#1927). A failure here leaves the old Cloudflare value
  // working.
  const store = storeFor(target);
  const owner = ownerOf(target);
  tokenOwnerRoutes({ owner, accountId });
  const ctx = { tfcToken, fetchImpl, execImpl };
  await store.check(target, ctx);

  // Step 1: Roll the token in Cloudflare. The old value stops working now.
  const rolled = await rollCloudflareToken({ tokenId, rollToken, owner, accountId, fetchImpl });

  // Step 2: Write the new value to the target store at once, with retries.
  const applyResult = await writeRolledValue(store, target, rolled.tokenValue, ctx, sleep);

  // Step 3: Verify the newly applied token against Cloudflare's verify API.
  const verificationWarning = verify
    ? await verificationProblem({ tokenValue: rolled.tokenValue, owner, accountId, fetchImpl })
    : null;

  return {
    ok: true,
    tokenId,
    targetType: target.type,
    targetName: targetLabel(target),
    action: applyResult.action,
    verified: verificationWarning === null,
    ...(verificationWarning
      ? { warning: `Token applied, but post-write verification returned: ${verificationWarning}` }
      : {}),
  };
}

/** A target's name for messages: its name, workspace or vault key. */
function targetLabel(target) {
  return target.name || target.workspace || target.vaultKey;
}

/** The target's token kind; a target that does not say is refused, never taken for a user token. */
function ownerOf(target) {
  if (!Object.hasOwn(target, 'owner')) {
    throw new Error(
      `Target ${targetLabel(target) || '(unnamed)'} does not say which kind of Cloudflare token it holds (owner: ${Object.keys(TOKEN_OWNERS).join(' or ')})`
    );
  }
  return target.owner;
}

/** Writes the rolled value to its store with retries; a final failure names the recovery. */
async function writeRolledValue(store, target, value, ctx, sleep) {
  try {
    return await retry(() => store.write(target, value, ctx), { attempts: 3, sleep });
  } catch (err) {
    throw new Error(
      `Token was rolled in Cloudflare but failed to write to target ${targetLabel(target)}: ${err.message}. The old value no longer works: roll it by hand in the Cloudflare dashboard and paste the new value into the store (docs/runbooks/dns-token-stolen.md, "Routine renewal")`
    );
  }
}

/** Null when the new token verifies, otherwise why it did not (a warning: the rotation is already done). */
async function verificationProblem(params) {
  try {
    await verifyCloudflareToken(params);
    return null;
  } catch (verifyErr) {
    return verifyErr.message;
  }
}
