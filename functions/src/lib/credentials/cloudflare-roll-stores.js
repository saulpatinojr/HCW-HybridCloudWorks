/**
 * cloudflare-roll-stores.js: the two stores a rolled Cloudflare token is
 * written back to (#1027, #1927), split from cloudflare-roll.js so each file
 * stays small enough to read.
 *
 *   tfc        a sensitive variable in an HCP Terraform workspace
 *              (JSON:API, `Content-Type: application/vnd.api+json`)
 *   lab-vault  a key in the lab host's Ansible Vault, written by
 *              `sudo -n hcw-vault-set <key>` with the value on stdin only
 *
 * Each store in STORES has a `check`, run BEFORE the roll with the same
 * credentials the write will use, and a `write`, run straight after it.
 * cloudflare-roll.js re-exports everything here, so callers import from there.
 * The invariants are in cloudflare-roll.js's header.
 */

import { spawn } from 'node:child_process';
import { withStatus } from '../http/error-response.js';

/** The lab host helper that writes one vault key from stdin, run through `sudo -n`. */
export const HCW_VAULT_SET = '/usr/local/sbin/hcw-vault-set';

/** The shape of a lab host Ansible Vault key `hcw-vault-set` accepts. */
export const VAULT_KEY_PATTERN = /^vault_[a-z0-9_]+$/;

const DEFAULT_VAULT_KEY = 'vault_cloudflare_api_token';

/**
 * Looks an HCP Terraform workspace up and lists its variables, the two reads
 * a variable write starts with. Throws (with the HTTP status) when either is
 * refused.
 *
 * @param {object} params
 * @param {string} params.tfcToken HCP Terraform API token
 * @param {string} params.organization HCP Terraform organization name
 * @param {string} params.workspace HCP Terraform workspace name
 * @param {typeof fetch} [params.fetchImpl] Injectable fetch
 * @returns {Promise<{ workspaceId: string, variables: object[], varsUrl: string, headers: object, where: string, canUpdateVariable: boolean }>}
 */
export async function readTfcWorkspace({ tfcToken, organization, workspace, fetchImpl = globalThis.fetch }) {
  if (!tfcToken) throw new Error('HCP Terraform token is required');
  if (!organization) throw new Error('HCP Terraform organization is required');
  if (!workspace) throw new Error('HCP Terraform workspace is required');

  const headers = {
    Authorization: `Bearer ${tfcToken}`,
    'Content-Type': 'application/vnd.api+json',
  };
  const where = `${organization}/${workspace}`;

  const wsUrl = `https://app.terraform.io/api/v2/organizations/${encodeURIComponent(organization)}/workspaces/${encodeURIComponent(workspace)}`;
  const ws = await tfcCall(fetchImpl, wsUrl, { method: 'GET', headers });
  if (!ws.response.ok || !ws.data?.data?.id) {
    throw tfcFailure(ws, `HCP Terraform workspace ${where} lookup failed (${ws.response.status})`);
  }
  const workspaceId = ws.data.data.id;

  const varsUrl = `https://app.terraform.io/api/v2/workspaces/${encodeURIComponent(workspaceId)}/vars`;
  const vars = await tfcCall(fetchImpl, varsUrl, { method: 'GET', headers });
  if (!vars.response.ok || !Array.isArray(vars.data?.data)) {
    throw tfcFailure(vars, `HCP Terraform list vars failed for ${where} (${vars.response.status})`);
  }
  // HCP Terraform's "Show workspace" answer says what this token may do
  // there: data.attributes.permissions['can-update-variable']
  // (https://developer.hashicorp.com/terraform/cloud-docs/api-docs/workspaces,
  // read 2026-11-28).
  const canUpdateVariable = ws.data.data.attributes?.permissions?.['can-update-variable'] === true;
  return { workspaceId, variables: vars.data.data, varsUrl, headers, where, canUpdateVariable };
}

/**
 * Before a roll: the HCP Terraform token can read the workspace and its
 * variables, and HCP Terraform says it may write them (`can-update-variable`
 * exactly true). Throws otherwise, so nothing is rolled.
 *
 * @param {object} params Same as readTfcWorkspace
 */
export async function checkTfcVariablesWritable(params) {
  const read = await readTfcWorkspace(params);
  if (!read.canUpdateVariable) {
    throw withStatus(
      new Error(`the HCP Terraform token cannot write variables in ${read.where}; nothing was rolled`),
      403
    );
  }
  return read;
}

/**
 * Before a roll: `sudo -n -l` says this user may run hcw-vault-set without a
 * password. Throws otherwise, so nothing is rolled. Runs through the same
 * injectable runner as the write, with nothing on stdin.
 *
 * @param {object} params
 * @param {Function} [params.execImpl] Injectable command runner
 */
export async function checkLabVaultWritable({ execImpl } = {}) {
  const runner = execImpl || defaultSpawnRunner;
  const res = await runner({ command: 'sudo', args: ['-n', '-l', HCW_VAULT_SET], stdin: '' });
  if (res?.code !== 0) {
    throw new Error(
      `sudo does not allow ${HCW_VAULT_SET} without a password here (sudo -n -l exit code ${res?.code}); nothing was rolled`
    );
  }
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

  // 1 and 2. Resolve the workspace id and list its variables.
  const { variables, varsUrl, headers, where } = await readTfcWorkspace({
    tfcToken,
    organization,
    workspace,
    fetchImpl,
  });

  const existing = variables.find(
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
  if (!vaultKey || !VAULT_KEY_PATTERN.test(vaultKey)) {
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
    args: ['-n', HCW_VAULT_SET, vaultKey],
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

/** The HCP Terraform workspace a `tfc` target names, with its organization defaulted. */
function tfcWorkspaceOf(target) {
  return { organization: target.organization || 'hcw', workspace: target.workspace };
}

/** The vault key a `lab-vault` target names, defaulted. */
function vaultKeyOf(target) {
  return target.vaultKey || DEFAULT_VAULT_KEY;
}

/**
 * The stores a rolled token can be written back to, keyed by target `type`.
 * `check(target, ctx)` runs BEFORE the roll and throws (nothing rolled) when
 * the store cannot take the write; `write(target, value, ctx)` runs after it.
 * `ctx` is `{ tfcToken, fetchImpl, execImpl }`.
 */
export const STORES = Object.freeze({
  tfc: Object.freeze({
    // Looks the workspace up, lists its variables and requires HCP
    // Terraform's can-update-variable for this token.
    async check(target, { tfcToken, fetchImpl }) {
      if (!target.workspace) throw new Error('HCP Terraform workspace is required');
      await checkTfcVariablesWritable({ tfcToken, ...tfcWorkspaceOf(target), fetchImpl });
    },
    write(target, value, { tfcToken, fetchImpl }) {
      return updateTfcVariable({
        tfcToken,
        ...tfcWorkspaceOf(target),
        key: target.key || 'cloudflare_api_token',
        value,
        category: target.category || 'terraform',
        sensitive: target.sensitive ?? true,
        description: target.description,
        fetchImpl,
      });
    },
  }),
  'lab-vault': Object.freeze({
    // The key's shape, then sudo's leave to run hcw-vault-set.
    async check(target, { execImpl }) {
      const vaultKey = vaultKeyOf(target);
      if (!VAULT_KEY_PATTERN.test(vaultKey)) {
        throw new Error(`Invalid lab vault key name: '${vaultKey}' (expected vault_[a-z0-9_]+)`);
      }
      await checkLabVaultWritable({ execImpl });
    },
    write(target, value, { execImpl }) {
      return updateLabVaultSecret({ vaultKey: vaultKeyOf(target), secretValue: value, execImpl });
    },
  }),
});

/** The store for a target, or an error naming the unsupported type. */
export function storeFor(target) {
  if (!target || typeof target !== 'object') {
    throw new Error('Target configuration is required');
  }
  if (!Object.hasOwn(STORES, target.type)) {
    throw new Error(`Unsupported target type: ${target.type}`);
  }
  return STORES[target.type];
}
