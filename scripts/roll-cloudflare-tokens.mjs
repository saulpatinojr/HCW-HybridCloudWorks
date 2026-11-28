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
 *   - Write immediately after the roll: Cloudflare retires the old value at the roll,
 *     so the new one is written to its store at once. BEFORE any roll (#1927) every
 *     store is checked with the credentials the write will use: each HCP Terraform
 *     workspace must give the token `can-update-variable` and list its variables,
 *     and sudo must allow hcw-vault-set for the caddy target. A refusal stops the
 *     run with nothing rolled. This proves permission, not that the write will
 *     succeed.
 *   - Nothing schedules this script (#1927): a person runs it when the credential
 *     register's 180-day reminder comes.
 *   - Stdin-only: vault updates pass secret strictly on standard input.
 *
 * Usage:
 *   node scripts/roll-cloudflare-tokens.mjs [--target <azure|lab|caddy|all>] [--dry-run] [--check] [--token-id <id>]
 */

import { fileURLToPath } from 'node:url';
import {
  CLOUDFLARE_TARGETS,
  TOKEN_OWNERS,
  checkTfcVariablesWritable,
  rollAndApplyCloudflareToken,
  storeFor,
} from '../functions/src/lib/credentials/cloudflare-roll.js';
import { parseArgs, printUsage } from './lib/cloudflare-roll-args.mjs';
import { ownerOf, planRun } from './lib/cloudflare-roll-plan.mjs';
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
 * @param {Record<string, object>} [params.targets] The roll targets; CLOUDFLARE_TARGETS outside tests
 * @returns {Promise<number>} exit code
 */
export async function runRoll({
  options,
  targets = CLOUDFLARE_TARGETS,
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
  const plan = planRun({ options, targets, env, stderr });
  if (plan.code !== null) return plan.code;
  return MODES[modeOf(options)]({ ...plan, fetchImpl, execImpl, stdout, stderr });
}

/** Which of MODES a run is: --check, --dry-run, or a real roll. */
function modeOf(options) {
  if (options.check) return 'check';
  return options.dryRun ? 'dryRun' : 'roll';
}

/** What each mode does with the plan; each resolves to the exit code. */
const MODES = Object.freeze({
  // Check mode: verifies connectivity and configuration without modifying anything.
  check: (run) => checkTargets(run),
  dryRun: ({ resolvedTargets, stdout }) => dryRunTargets(resolvedTargets, stdout),
  roll: (run) => rollRun(run),
});

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
 * A real roll. Before any roll, every store this run writes to is checked
 * with the credentials the write will use (HCP Terraform's
 * can-update-variable for the token, or sudo's permission for
 * hcw-vault-set). A refusal stops the whole run with nothing rolled (#1927),
 * because a roll retires the old value and a failed write would leave a dead
 * token.
 */
async function rollRun(run) {
  const unwritable = await unwritableStores(run);
  if (unwritable === 0) return rollTargets(run);
  run.stderr(`\nNothing was rolled: ${unwritable} store(s) cannot be written with the credentials given. Every token still works.`);
  return 1;
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

/**
 * Looks a target's HCP Terraform workspace up, lists its variables and
 * requires HCP Terraform's `can-update-variable` for the token; throws
 * otherwise.
 */
async function lookUpWorkspace(target, tfcToken, fetchImpl) {
  await checkTfcVariablesWritable({ tfcToken, organization: target.organization, workspace: target.workspace, fetchImpl });
}

/** Before any roll: the number of stores the given credentials may not write, each named on stderr. */
async function unwritableStores({ resolvedTargets, tfcToken, fetchImpl, execImpl, stderr }) {
  let failures = 0;
  for (const { key, target } of resolvedTargets) {
    try {
      // The same check the library makes before its own roll (STORES[type].check).
      await storeFor(target).check(target, { tfcToken, fetchImpl, execImpl });
    } catch (err) {
      stderr(`[fail] Target '${key}': its store cannot be written, so nothing was rolled: ${err.message}`);
      failures += 1;
    }
  }
  return failures;
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
