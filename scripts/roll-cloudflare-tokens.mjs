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
  rollAndApplyCloudflareToken,
} from '../functions/src/lib/credentials/cloudflare-roll.js';

/**
 * Parses CLI arguments into an options bag. Rejects unknown flags and
 * flags with missing operands (exits or reports error).
 *
 * @param {string[]} argv
 * @returns {object}
 */
export function parseArgs(argv) {
  const options = {
    target: 'all',
    tokenId: null,
    dryRun: false,
    check: false,
    help: false,
    invalid: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--check') {
      options.check = true;
    } else if (arg === '--target') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        options.invalid = 'Option --target requires a target operand (azure, lab, caddy, or all)';
        return options;
      }
      options.target = argv[++i];
    } else if (arg === '--token-id') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        options.invalid = 'Option --token-id requires a non-empty token ID operand';
        return options;
      }
      options.tokenId = argv[++i];
    } else {
      options.invalid = `Unrecognized option: '${arg}'`;
      return options;
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
  --token-id <id>       Override Cloudflare token ID (allowed only with a single target)
  --dry-run             Validate configuration and display actions without rolling or writing
  --check               Verify that configured tokens and workspace targets are reachable
  --help, -h            Show this help message

Environment variables:
  CLOUDFLARE_ROLL_TOKEN   Cloudflare API token with 'API Tokens:Edit' permission (or CLOUDFLARE_API_TOKEN)
  TFC_TOKEN               HCP Terraform token for workspace variables (or TFE_TOKEN)
  CLOUDFLARE_AZURE_TOKEN_ID   Cloudflare token ID for the Azure HCP Terraform workspace
  CLOUDFLARE_LAB_TOKEN_ID     Cloudflare token ID for the Lab HCP Terraform workspace
  CLOUDFLARE_CADDY_TOKEN_ID   Cloudflare token ID for the Lab host Caddy Ansible Vault
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

  if (options.invalid) {
    stderr(`[error] ${options.invalid}`);
    return 2;
  }

  const rollToken = env.CLOUDFLARE_ROLL_TOKEN || env.CLOUDFLARE_API_TOKEN;
  const tfcToken = env.TFC_TOKEN || env.TFE_TOKEN;

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

  if (!options.dryRun && !options.check && !rollToken) {
    stderr('[error] Cloudflare roll token is required (set CLOUDFLARE_ROLL_TOKEN or CLOUDFLARE_API_TOKEN)');
    return 2;
  }

  const needsTfc = targetKeys.some((k) => CLOUDFLARE_TARGETS[k].type === 'tfc');
  if (!options.dryRun && needsTfc && !tfcToken) {
    stderr('[error] HCP Terraform token is required for TFC targets (set TFC_TOKEN or TFE_TOKEN)');
    return 2;
  }

  // Resolve and validate token IDs
  const resolvedTargets = [];
  const seenTokenIds = new Set();
  let missing = 0;

  for (const key of targetKeys) {
    const target = CLOUDFLARE_TARGETS[key];
    let tokenId = options.tokenId || env[target.envTokenId];

    // Only allow single-target fallback to generic CLOUDFLARE_TOKEN_ID
    if (!tokenId && targetKeys.length === 1) {
      tokenId = env.CLOUDFLARE_TOKEN_ID;
    }

    if (!tokenId) {
      stderr(`[error] Missing token ID for target '${key}' (${target.name}). Set ${target.envTokenId}.`);
      missing += 1;
      continue;
    }

    if (seenTokenIds.has(tokenId)) {
      stderr(`[error] Duplicate token ID '${tokenId}' detected across multiple targets. Each target must have a distinct Cloudflare token.`);
      return 1;
    }
    seenTokenIds.add(tokenId);

    resolvedTargets.push({ key, target, tokenId });
  }

  if (missing > 0) {
    return 1;
  }

  // Check mode: verifies connectivity and configuration without modifying anything
  if (options.check) {
    let checkFailures = 0;
    for (const { key, target, tokenId } of resolvedTargets) {
      stdout(`[check] Checking target '${key}' (${target.name}) with token ID ${tokenId}...`);
      try {
        if (target.type === 'tfc' && tfcToken) {
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
        stdout(`[ok] Target '${key}': verified reachable and configured`);
      } catch (err) {
        stderr(`[fail] Target '${key}': check failed: ${err.message}`);
        checkFailures += 1;
      }
    }
    return checkFailures === 0 ? 0 : 1;
  }

  // Dry run mode
  if (options.dryRun) {
    for (const { target, tokenId } of resolvedTargets) {
      stdout(`[dry-run] Would roll token ${tokenId} and update ${target.name} (${target.type})`);
    }
    return 0;
  }

  // Real execution
  let failed = 0;
  for (const { key, target, tokenId } of resolvedTargets) {
    try {
      stdout(`[roll] Rolling token for target '${key}' (${target.name})...`);
      const result = await rollAndApplyCloudflareToken({
        tokenId,
        rollToken,
        target,
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
