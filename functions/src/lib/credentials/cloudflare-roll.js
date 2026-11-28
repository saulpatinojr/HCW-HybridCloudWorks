/**
 * cloudflare-roll.js — Cloudflare API token auto-renewal through the roll-token
 * endpoint and automated write-back to HCP Terraform / lab host Ansible Vault
 * (#1027).
 *
 * ## Invariants
 *
 * 1. ZERO VALUE LEAKAGE: Token secrets are never logged, printed, or included
 *    in error messages or return structures.
 * 2. WRITE BEFORE RETIRE: Because Cloudflare's roll endpoint immediately
 *    invalidates the old token, the new token is committed to the target store
 *    (with retries) immediately after rolling, ensuring no store is left with
 *    a dead token.
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
 *    belongs to the account (Manage Account → Account API tokens) and rolls
 *    through `/accounts/{account_id}/tokens/{id}/value`. Each target says
 *    which kind it holds (`owner`), and everything that can be known before
 *    the roll (the kind, the account id, the target type) is checked BEFORE
 *    the roll, because the roll retires the old value at once.
 */

import { spawn } from 'node:child_process';
import { withStatus } from '../http/error-response.js';

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
    label: 'account-owned token (Manage Account → Account API tokens)',
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

/** The stores a rolled token can be written back to. */
const WRITABLE_TARGET_TYPES = Object.freeze(['tfc', 'lab-vault']);

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
 * Updates or creates a sensitive variable in an HCP Terraform workspace.
 *
 * @param {object} params
 * @param {string} params.tfcToken HCP Terraform API bearer token
 * @param {string} params.organization HCP Terraform organization name
 * @param {string} params.workspace HCP Terraform workspace name
 * @param {string} params.key Variable key
 * @param {string} params.value New variable value
 * @param {string} [params.category='terraform'] 'terraform' or 'env'
 * @param {boolean} [params.sensitive=true] Sensitive flag
 * @param {string} [params.description] Optional description
 * @param {typeof fetch} [params.fetchImpl] Injectable fetch
 * @returns {Promise<{ ok: boolean, action: 'updated'|'created', variableId: string, key: string, category: string, workspace: string }>}
 */
export async function updateTfcVariable({
  tfcToken,
  organization,
  workspace,
  key,
  value,
  category = 'terraform',
  sensitive = true,
  description,
  fetchImpl = globalThis.fetch,
}) {
  if (!tfcToken) throw new Error('HCP Terraform token is required');
  if (!organization) throw new Error('HCP Terraform organization is required');
  if (!workspace) throw new Error('HCP Terraform workspace is required');
  if (!key) throw new Error('Variable key is required');
  if (!value) throw new Error('Variable value is required');

  const headers = {
    Authorization: `Bearer ${tfcToken}`,
    'Content-Type': 'application/vnd.api+json',
  };
  const where = `${organization}/${workspace}`;

  // 1. Resolve workspace ID
  const wsUrl = `https://app.terraform.io/api/v2/organizations/${encodeURIComponent(organization)}/workspaces/${encodeURIComponent(workspace)}`;
  const ws = await tfcCall(fetchImpl, wsUrl, { method: 'GET', headers });
  if (!ws.response.ok || !ws.data?.data?.id) {
    throw tfcFailure(ws, `HCP Terraform workspace ${where} lookup failed (${ws.response.status})`);
  }
  const workspaceId = ws.data.data.id;

  // 2. List variables to match key and category
  const varsUrl = `https://app.terraform.io/api/v2/workspaces/${encodeURIComponent(workspaceId)}/vars`;
  const vars = await tfcCall(fetchImpl, varsUrl, { method: 'GET', headers });
  if (!vars.response.ok || !Array.isArray(vars.data?.data)) {
    throw tfcFailure(vars, `HCP Terraform list vars failed for ${where} (${vars.response.status})`);
  }

  const existing = vars.data.data.find(
    (v) => v.attributes?.key === key && v.attributes?.category === category
  );

  const attributes = {
    key,
    value,
    category,
    sensitive,
    hcl: false,
    ...(description ? { description } : {}),
  };

  // 3. Change the variable that is there, or create it.
  const write = existing
    ? {
        action: 'updated',
        verb: 'update',
        url: `${varsUrl}/${encodeURIComponent(existing.id)}`,
        method: 'PATCH',
        data: { id: existing.id, type: 'vars', attributes },
      }
    : { action: 'created', verb: 'create', url: varsUrl, method: 'POST', data: { type: 'vars', attributes } };
  const written = await tfcCall(fetchImpl, write.url, {
    method: write.method,
    headers,
    body: JSON.stringify({ data: write.data }),
  });
  if (!written.response.ok || !written.data?.data?.id) {
    throw tfcFailure(written, `HCP Terraform ${write.verb} variable ${key} in ${where} failed (${written.response.status})`);
  }

  return {
    ok: true,
    action: write.action,
    variableId: written.data.data.id,
    key,
    category,
    workspace: where,
  };
}

/** One HCP Terraform API call: the response and its JSON body, or a null body when it is not JSON. */
async function tfcCall(fetchImpl, url, init) {
  const response = await fetchImpl(url, init);
  let data = null;
  try {
    data = await response.json();
  } catch {}
  return { response, data };
}

/** The error for a refused HCP Terraform call: `sentence`, then the API's own error details or the status text. */
function tfcFailure({ response, data }, sentence) {
  const err = data?.errors?.map((e) => e.detail || e.title).join('; ') || response.statusText;
  return withStatus(new Error(`${sentence}: ${err}`), response.status);
}

/**
 * Runs a command with its input on stdin and resolves with its exit code and
 * output once it closes. Rejects when the process cannot be spawned, or when
 * writing its stdin fails for any reason other than the child closing the
 * pipe first (`EPIPE`): that case is the child's to report through its exit
 * code and stderr, which the `close` event carries; any other stdin failure
 * means the child may have run on incomplete input, so a zero exit code must
 * not be reported as success.
 *
 * @param {object} params
 * @param {string} params.command Executable to run
 * @param {string[]} params.args Arguments
 * @param {string} params.stdin Text written to the child's standard input
 * @param {Function} [params.spawnImpl] Injectable `child_process.spawn`
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
export async function defaultSpawnRunner({
  command,
  args,
  stdin,
  spawnImpl = spawn,
}) {
  return new Promise((resolve, reject) => {
    const proc = spawnImpl(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d;
    });
    proc.stderr.on('data', (d) => {
      stderr += d;
    });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    proc.stdin.on('error', (err) => {
      if (err && err.code === 'EPIPE') {
        // The child closed its stdin before reading it all; its exit code
        // and stderr, delivered by 'close', are the result.
        return;
      }
      reject(err);
    });
    proc.stdin.end(stdin);
  });
}

/**
 * Updates a secret in the lab host Ansible Vault via `hcw-vault-set`.
 * Secret is passed strictly on stdin.
 *
 * @param {object} params
 * @param {string} params.vaultKey Vault variable name matching ^vault_[a-z0-9_]+$
 * @param {string} params.secretValue Secret value to write
 * @param {Function} [params.execImpl] Injectable command runner
 * @returns {Promise<{ ok: boolean, action: 'updated', key: string }>}
 */
export async function updateLabVaultSecret({
  vaultKey,
  secretValue,
  execImpl,
}) {
  if (!vaultKey || !/^vault_[a-z0-9_]+$/.test(vaultKey)) {
    throw new Error(
      `Invalid lab vault key name: '${vaultKey}' (expected vault_[a-z0-9_]+)`
    );
  }
  if (!secretValue || typeof secretValue !== 'string') {
    throw new Error('Secret value must be a non-empty string');
  }

  const runner = execImpl || defaultSpawnRunner;

  const res = await runner({
    command: 'sudo',
    args: ['-n', '/usr/local/sbin/hcw-vault-set', vaultKey],
    stdin: secretValue,
  });

  if (res.code !== 0) {
    throw new Error(
      `hcw-vault-set failed (exit code ${res.code}): ${res.stderr?.trim() || res.stdout?.trim() || 'unknown error'}`
    );
  }

  return {
    ok: true,
    action: 'updated',
    key: vaultKey,
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
 *   `owner` defaults to 'user'
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
  if (!target || typeof target !== 'object') {
    throw new Error('Target configuration is required');
  }
  // Everything knowable is checked before the roll, which retires the old
  // value at once: a store the new value cannot be written to, or a token
  // kind the route table does not know, must fail with the old token intact.
  if (!WRITABLE_TARGET_TYPES.includes(target.type)) {
    throw new Error(`Unsupported target type: ${target.type}`);
  }
  const owner = target.owner || 'user';
  tokenOwnerRoutes({ owner, accountId });

  // Step 1: Roll the token in Cloudflare.
  // Note: Cloudflare's roll endpoint immediately invalidates the previous secret.
  const rolled = await rollCloudflareToken({ tokenId, rollToken, owner, accountId, fetchImpl });
  const newTokenValue = rolled.tokenValue;

  // Step 2: Write back to target store immediately with retries so the active store
  // is updated with the new valid secret.
  let applyResult = null;
  try {
    if (target.type === 'tfc') {
      applyResult = await retry(
        () =>
          updateTfcVariable({
            tfcToken,
            organization: target.organization || 'hcw',
            workspace: target.workspace,
            key: target.key || 'cloudflare_api_token',
            value: newTokenValue,
            category: target.category || 'terraform',
            sensitive: target.sensitive ?? true,
            description: target.description,
            fetchImpl,
          }),
        { attempts: 3, sleep }
      );
    } else if (target.type === 'lab-vault') {
      applyResult = await retry(
        () =>
          updateLabVaultSecret({
            vaultKey: target.vaultKey || 'vault_cloudflare_api_token',
            secretValue: newTokenValue,
            execImpl,
          }),
        { attempts: 3, sleep }
      );
    } else {
      throw new Error(`Unsupported target type: ${target.type}`);
    }
  } catch (err) {
    throw new Error(
      `Token was rolled in Cloudflare but failed to write to target ${target.name || target.workspace || target.vaultKey}: ${err.message}`
    );
  }

  // Step 3: Verify the newly applied token against Cloudflare's verify API
  let verificationWarning = null;
  if (verify) {
    try {
      await verifyCloudflareToken({ tokenValue: newTokenValue, owner, accountId, fetchImpl });
    } catch (verifyErr) {
      verificationWarning = verifyErr.message;
    }
  }

  return {
    ok: true,
    tokenId,
    targetType: target.type,
    targetName: target.name || target.workspace || target.vaultKey,
    action: applyResult.action,
    verified: verificationWarning === null,
    ...(verificationWarning
      ? { warning: `Token applied, but post-write verification returned: ${verificationWarning}` }
      : {}),
  };
}
