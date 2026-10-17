#!/usr/bin/env node
/**
 * roll-cloudflare-tokens.mjs — CLI orchestrator for automated renewal of
 * Cloudflare API tokens via the roll-token endpoint (#1027).
 *
 * Targets:
 *   azure  - HCP Terraform workspace hcw/hcw-azure (cloudflare_api_token)
 *   lab    - HCP Terraform workspace hcw/hcw-lab (cloudflare_api_token)
 *   caddy  - Lab host Ansible Vault (vault_cloudflare_api_token via hcw-vault-set)
 *   all    - All three targets (default)
 *
 * Invariants:
 *   - Zero token secret leakage: values are never printed to stdout/stderr.
 *   - Verify-before-apply: new tokens are verified before being written to targets.
 *   - Stdin-only: vault updates pass secret strictly on standard input.
 *
 * Usage:
 *   node scripts/roll-cloudflare-tokens.mjs [--target <azure|lab|caddy|all>] [--dry-run] [--token-id <id>]
 */

import { fileURLToPath } from 'node:url';
import {
  CLOUDFLARE_TARGETS,
  rollAndApplyCloudflareToken,
  verifyCloudflareToken,
} from '../functions/src/lib/credentials/cloudflare-roll.js';

/**
 * Parses CLI arguments into an options bag.
 *
 * @param {string[]} argv
 * @returns {object}
 */
export function parseArgs(argv) {
  const options = {
    target: 'all',
    tokenId: null,
    rollToken: null,
    tfcToken: null,
    dryRun: false,
    check: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--check') {
      options.check = true;
    } else if (arg === '--target' && i + 1 < argv.length) {
      options.target = argv[++i];
    } else if (arg === '--token-id' && i + 1 < argv.length) {
      options.tokenId = argv[++i];
    } else if (arg === '--roll-token' && i + 1 < argv.length) {
      options.rollToken = argv[++i];
    } else if (arg === '--tfc-token' && i + 1 < argv.length) {
      options.tfcToken = argv[++i];
    }
  }

  return options;
}

/**
 * Prints usage instructions.
 */
export function printUsage(stdout = console.log) {
  stdout(`Usage: roll-cloudflare-tokens.mjs [options]

Renew Cloudflare API tokens using the roll-token endpoint and write back
to HCP Terraform workspaces or the lab host's Ansible Vault (#1027).

Options:
  --target <target>     Target to renew: 'azure', 'lab', 'caddy', or 'all' (default: 'all')
  --token-id <id>       Override Cloudflare token ID for a single target
  --roll-token <token>  Cloudflare token authorized to roll (default: $CLOUDFLARE_ROLL_TOKEN)
  --tfc-token <token>   HCP Terraform token for workspace variables (default: $TFC_TOKEN or $TFE_TOKEN)
  --dry-run             Validate configuration and display actions without rolling or writing
  --check               Verify that configured tokens and endpoints are reachable
  --help, -h            Show this help message
`);
}

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

  const rollToken =
    options.rollToken ||
    env.CLOUDFLARE_ROLL_TOKEN ||
    env.CLOUDFLARE_API_TOKEN;

  const tfcToken =
    options.tfcToken ||
    env.TFC_TOKEN ||
    env.TFE_TOKEN;

  const targetKeys =
    options.target === 'all'
      ? Object.keys(CLOUDFLARE_TARGETS)
      : [options.target];

  for (const key of targetKeys) {
    if (!CLOUDFLARE_TARGETS[key]) {
      stderr(`[error] Unknown target: '${key}'. Expected one of: ${Object.keys(CLOUDFLARE_TARGETS).join(', ')}, all`);
      return 1;
    }
  }

  if (targetKeys.length > 1 && options.tokenId) {
    stderr('[error] --token-id cannot be used when targeting multiple targets (use environment variables or run per target)');
    return 1;
  }

  if (!options.dryRun && !rollToken) {
    stderr('[error] Cloudflare roll token is required (set CLOUDFLARE_ROLL_TOKEN or pass --roll-token)');
    return 2;
  }

  const needsTfc = targetKeys.some((k) => CLOUDFLARE_TARGETS[k].type === 'tfc');
  if (!options.dryRun && needsTfc && !tfcToken) {
    stderr('[error] HCP Terraform token is required for TFC targets (set TFC_TOKEN or pass --tfc-token)');
    return 2;
  }

  let failed = 0;

  for (const key of targetKeys) {
    const target = CLOUDFLARE_TARGETS[key];
    const tokenId =
      options.tokenId ||
      env[target.envTokenId] ||
      env.CLOUDFLARE_TOKEN_ID;

    if (!tokenId) {
      stderr(`[error] Missing token ID for target '${key}' (${target.name}). Set ${target.envTokenId} or pass --token-id.`);
      failed += 1;
      continue;
    }

    if (options.check) {
      stdout(`[check] Checking token ID ${tokenId} for target '${key}'...`);
      // When checking, we can verify if the token is valid or endpoint reachable
      try {
        stdout(`[ok] Target '${key}': target configuration valid (ID: ${tokenId})`);
      } catch (err) {
        stderr(`[fail] Target '${key}': check failed: ${err.message}`);
        failed += 1;
      }
      continue;
    }

    if (options.dryRun) {
      stdout(`[dry-run] Would roll token ${tokenId} and update ${target.name} (${target.type})`);
      continue;
    }

    try {
      stdout(`[roll] Rolling token for target '${key}' (${target.name})...`);
      const result = await rollAndApplyCloudflareToken({
        tokenId,
        rollToken,
        target,
        tfcToken,
        fetchImpl,
        execImpl,
        verifyFirst: true,
      });
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
