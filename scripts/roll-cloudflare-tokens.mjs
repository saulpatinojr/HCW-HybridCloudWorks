#!/usr/bin/env node
/**
 * roll-cloudflare-tokens.mjs — CLI orchestrator for automated renewal of
 * Cloudflare API tokens via the roll-token endpoint (#1027).
 *
 * Targets:
 *   azure  - HCP Terraform workspace hcw/hcw-azure (cloudflare_api_token):
 *            the account-owned token `hcw`, rolled through the account route,
 *            so CLOUDFLARE_ACCOUNT_ID must be set (#1927)
 *   lab    - HCP Terraform workspace hcw/hcw-lab (cloudflare_api_token): a user token
 *   caddy  - Lab host Ansible Vault (vault_cloudflare_api_token via hcw-vault-set): a user token
 *   all    - All three targets (default)
 *
 * Invariants:
 *   - Zero token secret leakage: secrets are NEVER accepted via argv (no --roll-token
 *     or --tfc-token on the command line; env vars only) and never printed.
 *   - Write before retire: new tokens are committed to stores immediately after rolling.
 *   - Stdin-only: vault updates pass secret strictly on standard input.
 *
 * Usage:
 *   node scripts/roll-cloudflare-tokens.mjs [--target <azure|lab|caddy|all>] [--dry-run] [--check] [--token-id <id>]
 */

import { fileURLToPath } from 'node:url';
import {
  CLOUDFLARE_TARGETS,
  TOKEN_OWNERS,
  rollAndApplyCloudflareToken,
  tokenOwnerRoutes,
} from '../functions/src/lib/credentials/cloudflare-roll.js';
import { parseArgs, printUsage } from './lib/cloudflare-roll-args.mjs';
// The parts below now live in their own files; they are exported from here too, so callers keep their imports.
export { parseArgs, printUsage } from './lib/cloudflare-roll-args.mjs';

/**
 * Resolves configuration and executes the token renewal orchestration.
 *
 * @param {object} params
 * @param {object} params.options
 * @param {Record<string, string>} [params.env]
 * @param {typeof fetch} [params.fetchImpl]
 * @param {Function} [params.execImpl]
 * @param {Function} [params.stdout]
 * @param {Function} [params.stderr]
 * @returns {Promise<number>} exit code
 */
export async function runRoll({
  options,
  env = process.env,
  fetchImpl = globalThis.fetch,
  execImpl,
  stdout = console.log,
  stderr = console.error,
}) {
  if (options.help) {
    printUsage(stdout);
    return 0;
  }

  const rollToken = env.CLOUDFLARE_ROLL_TOKEN || env.CLOUDFLARE_API_TOKEN;
  // An account-owned token is rolled with "Account API Tokens Write"; when the
  // general roll token does not carry it, a separate one can be given (#1927).
  const accountRollToken = env.CLOUDFLARE_ACCOUNT_ROLL_TOKEN || rollToken;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const tfcToken = env.TFC_TOKEN || env.TFE_TOKEN;

  const targetKeys =
    options.target === 'all'
      ? Object.keys(CLOUDFLARE_TARGETS)
      : [options.target];

  const refusal = preflightRefusal({ options, targetKeys, rollToken, accountRollToken, accountId, tfcToken });
  if (refusal) {
    stderr(`[error] ${refusal.message}`);
    return refusal.code;
  }

  const resolved = resolveTargets({ options, env, targetKeys, stderr });
  if (resolved.code !== 0) return resolved.code;
  const resolvedTargets = resolved.targets;

  // Check mode: verifies connectivity and configuration without modifying anything
  if (options.check) return checkTargets({ resolvedTargets, tfcToken, fetchImpl, stdout, stderr });

  // Dry run mode, or the real execution
  const rollTokens = { user: rollToken, account: accountRollToken };
  return options.dryRun
    ? dryRunTargets(resolvedTargets, stdout)
    : rollTargets({ resolvedTargets, rollTokens, accountId, tfcToken, fetchImpl, execImpl, stdout, stderr });
}

/** The kind of token a target holds: 'user' unless it says otherwise. */
const ownerOf = (target) => target.owner || 'user';

/** --dry-run: say what would be rolled, through which route, and where it would be written. */
function dryRunTargets(resolvedTargets, stdout) {
  for (const { target, tokenId } of resolvedTargets) {
    stdout(
      `[dry-run] Would roll token ${tokenId} (${TOKEN_OWNERS[ownerOf(target)].label}) and update ${target.name} (${target.type})`
    );
  }
  return 0;
}

/**
 * The checks made before anything is resolved, in order. Each returns
 * `{ message, code }` when the options or the environment cannot go ahead.
 */
const PREFLIGHT_CHECKS = [
  ({ options }) => (options.invalid ? { message: options.invalid, code: 2 } : null),
  ({ targetKeys }) => {
    const unknown = targetKeys.find((key) => !CLOUDFLARE_TARGETS[key]);
    if (unknown === undefined) return null;
    return { message: `Unknown target: '${unknown}'. Expected one of: ${Object.keys(CLOUDFLARE_TARGETS).join(', ')}, all`, code: 1 };
  },
  ({ options, targetKeys }) =>
    targetKeys.length > 1 && options.tokenId
      ? { message: '--token-id cannot be used when targeting multiple targets (use environment variables or run per target)', code: 1 }
      : null,
  ({ targetKeys }) => {
    const unknown = targetKeys.find((key) => !Object.hasOwn(TOKEN_OWNERS, ownerOf(CLOUDFLARE_TARGETS[key])));
    return unknown === undefined
      ? null
      : { message: `Target '${unknown}' holds a kind of Cloudflare token this script cannot roll`, code: 1 };
  },
  // Checked in every mode, dry run included: without the account id the
  // account route cannot be built, and finding that out after a roll is
  // what "write before retire" exists to prevent.
  ({ targetKeys, accountId }) => {
    const needsAccount = targetKeys.filter((key) => TOKEN_OWNERS[ownerOf(CLOUDFLARE_TARGETS[key])].needsAccountId);
    if (needsAccount.length === 0) return null;
    try {
      tokenOwnerRoutes({ owner: 'account', accountId });
      return null;
    } catch (err) {
      return { message: `${err.message} (target ${needsAccount.join(', ')})`, code: 2 };
    }
  },
  ({ options, targetKeys, rollToken, accountRollToken }) => {
    if (options.dryRun || options.check) return null;
    const missing = targetKeys.some((key) =>
      ownerOf(CLOUDFLARE_TARGETS[key]) === 'account' ? !accountRollToken : !rollToken
    );
    return missing
      ? { message: 'Cloudflare roll token is required (set CLOUDFLARE_ROLL_TOKEN or CLOUDFLARE_API_TOKEN; CLOUDFLARE_ACCOUNT_ROLL_TOKEN may stand in for account-owned tokens)', code: 2 }
      : null;
  },
  ({ options, targetKeys, tfcToken }) => {
    const needsTfc = targetKeys.some((k) => CLOUDFLARE_TARGETS[k].type === 'tfc');
    return !options.dryRun && needsTfc && !tfcToken
      ? { message: 'HCP Terraform token is required for TFC targets (set TFC_TOKEN or TFE_TOKEN)', code: 2 }
      : null;
  },
];

/** The first reason the run cannot go ahead, as `{ message, code }`, or null when it can. */
function preflightRefusal(context) {
  for (const check of PREFLIGHT_CHECKS) {
    const refusal = check(context);
    if (refusal) return refusal;
  }
  return null;
}

/** The token ID one target uses: --token-id, its own variable, or (for a single target only) CLOUDFLARE_TOKEN_ID. */
function tokenIdFor(target, { options, env, targetKeys }) {
  const tokenId = options.tokenId || env[target.envTokenId];
  // Only allow single-target fallback to generic CLOUDFLARE_TOKEN_ID
  if (!tokenId && targetKeys.length === 1) return env.CLOUDFLARE_TOKEN_ID;
  return tokenId;
}

/**
 * Resolve and validate token IDs. Returns `{ code: 0, targets }`, or the exit
 * code (1) after naming every missing ID or the first repeated one.
 */
function resolveTargets({ options, env, targetKeys, stderr }) {
  const targets = [];
  const seenTokenIds = new Set();
  let missing = 0;

  for (const key of targetKeys) {
    const target = CLOUDFLARE_TARGETS[key];
    const tokenId = tokenIdFor(target, { options, env, targetKeys });

    if (!tokenId) {
      stderr(`[error] Missing token ID for target '${key}' (${target.name}). Set ${target.envTokenId}.`);
      missing += 1;
      continue;
    }

    if (seenTokenIds.has(tokenId)) {
      stderr(`[error] Duplicate token ID '${tokenId}' detected across multiple targets. Each target must have a distinct Cloudflare token.`);
      return { code: 1 };
    }
    seenTokenIds.add(tokenId);

    targets.push({ key, target, tokenId });
  }

  return missing > 0 ? { code: 1 } : { code: 0, targets };
}

/** --check: each target's HCP Terraform workspace looked up (when there is a token), nothing changed. */
async function checkTargets({ resolvedTargets, tfcToken, fetchImpl, stdout, stderr }) {
  let checkFailures = 0;
  for (const { key, target, tokenId } of resolvedTargets) {
    stdout(`[check] Checking target '${key}' (${target.name}) with token ID ${tokenId}...`);
    try {
      if (target.type === 'tfc' && tfcToken) await lookUpWorkspace(target, tfcToken, fetchImpl);
      stdout(`[ok] Target '${key}': verified reachable and configured`);
    } catch (err) {
      stderr(`[fail] Target '${key}': check failed: ${err.message}`);
      checkFailures += 1;
    }
  }
  return checkFailures === 0 ? 0 : 1;
}

async function lookUpWorkspace(target, tfcToken, fetchImpl) {
  const wsUrl = `https://app.terraform.io/api/v2/organizations/${encodeURIComponent(target.organization)}/workspaces/${encodeURIComponent(target.workspace)}`;
  const res = await fetchImpl(wsUrl, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${tfcToken}`,
      'Content-Type': 'application/vnd.api+json',
    },
  });
  if (!res.ok) {
    throw new Error(`HCP Terraform workspace lookup returned HTTP ${res.status}`);
  }
}

/** Roll each target's token and write it back to its store; 1 when any target failed. */
async function rollTargets({ resolvedTargets, rollTokens, accountId, tfcToken, fetchImpl, execImpl, stdout, stderr }) {
  let failed = 0;
  for (const { key, target, tokenId } of resolvedTargets) {
    try {
      stdout(`[roll] Rolling token for target '${key}' (${target.name}, ${TOKEN_OWNERS[ownerOf(target)].label})...`);
      const result = await rollAndApplyCloudflareToken({
        tokenId,
        rollToken: rollTokens[ownerOf(target)],
        target,
        accountId,
        tfcToken,
        fetchImpl,
        execImpl,
        verify: true,
      });
      if (result.warning) {
        stdout(`[warn] Target '${key}': ${result.warning}`);
      }
      stdout(`[ok] Target '${key}': successfully rolled token ${tokenId} and ${result.action} in ${target.name}`);
    } catch (err) {
      stderr(`[fail] Target '${key}': failed to roll and apply: ${err.message}`);
      failed += 1;
    }
  }

  if (failed > 0) {
    stderr(`\nCompleted with ${failed} failure(s).`);
    return 1;
  }

  stdout('\nAll requested Cloudflare token operations completed successfully.');
  return 0;
}

/* c8 ignore start */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const options = parseArgs(process.argv.slice(2));
  runRoll({ options })
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`[fatal] Unexpected error: ${err.message}`);
      process.exit(1);
    });
}
/* c8 ignore stop */
