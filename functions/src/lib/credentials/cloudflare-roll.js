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
 *    Cloudflare's `/user/tokens/verify` endpoint. Any verification anomaly is
 *    reported as a warning rather than aborting an already-committed rotation.
 * 4. STDIN FOR VAULT: Lab host Ansible Vault updates use `hcw-vault-set`,
 *    passing the token exclusively on stdin.
 * 5. JSON:API FOR TFC: HCP Terraform variables require
 *    `Content-Type: application/vnd.api+json`.
 * 6. PURE & INJECTABLE: Network operations use an injectable `fetchImpl` and
 *    shell operations use an injectable `execImpl` for testability without
 *    live external side-effects.
 */

import { spawn } from 'node:child_process';

/**
 * The three Cloudflare token targets managed by this estate (#1027).
 */
export const CLOUDFLARE_TARGETS = Object.freeze({
  azure: Object.freeze({
    id: 'tfc-azure-cloudflare-api-token',
    name: 'Azure HCP Terraform workspace (hcw/hcw-azure)',
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
 * Rolls a Cloudflare user API token using Cloudflare's roll-token endpoint:
 * PUT https://api.cloudflare.com/client/v4/user/tokens/{tokenId}/value
 *
 * Rolling immediately invalidates the old token string and generates a new
 * secret string while preserving existing permissions and policies.
 *
 * @param {object} params
 * @param {string} params.tokenId Cloudflare alphanumeric token ID
 * @param {string} params.rollToken Cloudflare API token authorized to edit tokens
 * @param {typeof fetch} [params.fetchImpl] Injectable fetch
 * @returns {Promise<{ tokenId: string, tokenValue: string }>}
 */
export async function rollCloudflareToken({
  tokenId,
  rollToken,
  fetchImpl = globalThis.fetch,
}) {
  if (!tokenId || typeof tokenId !== 'string') {
    throw new Error('Cloudflare tokenId is required');
  }
  if (!rollToken || typeof rollToken !== 'string') {
    throw new Error('Cloudflare rollToken is required');
  }

  const url = `https://api.cloudflare.com/client/v4/user/tokens/${encodeURIComponent(tokenId)}/value`;
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
    throw new Error(
      `Cloudflare roll-token request failed (${response.status}): ${errorDetail}`
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
 * Verifies a Cloudflare API token against:
 * GET https://api.cloudflare.com/client/v4/user/tokens/verify
 *
 * @param {object} params
 * @param {string} params.tokenValue The token secret string to verify
 * @param {typeof fetch} [params.fetchImpl] Injectable fetch
 * @returns {Promise<{ valid: boolean, id: string, status: string }>}
 */
export async function verifyCloudflareToken({
  tokenValue,
  fetchImpl = globalThis.fetch,
}) {
  if (!tokenValue || typeof tokenValue !== 'string') {
    throw new Error('Cloudflare tokenValue is required');
  }

  const url = 'https://api.cloudflare.com/client/v4/user/tokens/verify';
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
    throw new Error(
      `Cloudflare token verification failed (${response.status}): ${errorDetail}`
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

  // 1. Resolve workspace ID
  const wsUrl = `https://app.terraform.io/api/v2/organizations/${encodeURIComponent(organization)}/workspaces/${encodeURIComponent(workspace)}`;
  const wsResponse = await fetchImpl(wsUrl, { method: 'GET', headers });
  let wsData = null;
  try {
    wsData = await wsResponse.json();
  } catch {}

  if (!wsResponse.ok || !wsData?.data?.id) {
    const err =
      wsData?.errors?.map((e) => e.detail || e.title).join('; ') ||
      wsResponse.statusText;
    throw new Error(
      `HCP Terraform workspace ${organization}/${workspace} lookup failed (${wsResponse.status}): ${err}`
    );
  }
  const workspaceId = wsData.data.id;

  // 2. List variables to match key and category
  const varsUrl = `https://app.terraform.io/api/v2/workspaces/${encodeURIComponent(workspaceId)}/vars`;
  const varsResponse = await fetchImpl(varsUrl, { method: 'GET', headers });
  let varsData = null;
  try {
    varsData = await varsResponse.json();
  } catch {}

  if (!varsResponse.ok || !Array.isArray(varsData?.data)) {
    const err =
      varsData?.errors?.map((e) => e.detail || e.title).join('; ') ||
      varsResponse.statusText;
    throw new Error(
      `HCP Terraform list vars failed for ${organization}/${workspace} (${varsResponse.status}): ${err}`
    );
  }

  const existing = varsData.data.find(
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

  if (existing) {
    const updateUrl = `https://app.terraform.io/api/v2/workspaces/${encodeURIComponent(workspaceId)}/vars/${encodeURIComponent(existing.id)}`;
    const patchResponse = await fetchImpl(updateUrl, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        data: {
          id: existing.id,
          type: 'vars',
          attributes,
        },
      }),
    });
    let patchData = null;
    try {
      patchData = await patchResponse.json();
    } catch {}

    if (!patchResponse.ok || !patchData?.data?.id) {
      const err =
        patchData?.errors?.map((e) => e.detail || e.title).join('; ') ||
        patchResponse.statusText;
      throw new Error(
        `HCP Terraform update variable ${key} in ${organization}/${workspace} failed (${patchResponse.status}): ${err}`
      );
    }

    return {
      ok: true,
      action: 'updated',
      variableId: patchData.data.id,
      key,
      category,
      workspace: `${organization}/${workspace}`,
    };
  } else {
    const createUrl = `https://app.terraform.io/api/v2/workspaces/${encodeURIComponent(workspaceId)}/vars`;
    const postResponse = await fetchImpl(createUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        data: {
          type: 'vars',
          attributes,
        },
      }),
    });
    let postData = null;
    try {
      postData = await postResponse.json();
    } catch {}

    if (!postResponse.ok || !postData?.data?.id) {
      const err =
        postData?.errors?.map((e) => e.detail || e.title).join('; ') ||
        postResponse.statusText;
      throw new Error(
        `HCP Terraform create variable ${key} in ${organization}/${workspace} failed (${postResponse.status}): ${err}`
      );
    }

    return {
      ok: true,
      action: 'created',
      variableId: postData.data.id,
      key,
      category,
      workspace: `${organization}/${workspace}`,
    };
  }
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
 * @param {string} params.rollToken Cloudflare credential with API Tokens Write permission
 * @param {object} params.target Target descriptor (from CLOUDFLARE_TARGETS or matching shape)
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
  tfcToken,
  fetchImpl = globalThis.fetch,
  execImpl,
  verify = true,
  sleep = defaultSleep,
}) {
  if (!target || typeof target !== 'object') {
    throw new Error('Target configuration is required');
  }

  // Step 1: Roll the token in Cloudflare.
  // Note: Cloudflare's roll endpoint immediately invalidates the previous secret.
  const rolled = await rollCloudflareToken({ tokenId, rollToken, fetchImpl });
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
      await verifyCloudflareToken({ tokenValue: newTokenValue, fetchImpl });
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
