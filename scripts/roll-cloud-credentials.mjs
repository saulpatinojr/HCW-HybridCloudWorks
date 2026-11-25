#!/usr/bin/env node
/**
 * roll-cloud-credentials.mjs — CLI orchestrator for automated renewal of
 * Google Cloud API keys and AWS IAM pricing access keys (#1028).
 *
 * Targets:
 *   gemini     - Google Gemini API key (GEMINI-API-KEY)
 *   youtube    - Google YouTube Data API key (YOUTUBE-API-KEY)
 *   billing    - Google Cloud Billing API key (GCP-BILLING-API-KEY)
 *   google-all - All three Google Cloud API keys
 *   aws        - AWS IAM access key pair for pricing:GetProducts
 *   all        - All Google API keys and AWS access keys (default)
 *
 * Invariants:
 *   - Zero credential leakage: credentials are NEVER accepted via argv (no --api-key
 *     or --secret-key flags; environment variables only) and never printed.
 *   - Verify before delete: newly minted keys are functionally tested against the
 *     live services and written to Azure Key Vault before old keys are retired.
 *
 * Usage:
 *   node scripts/roll-cloud-credentials.mjs [--target <gemini|youtube|billing|google-all|aws|all>] [--dry-run] [--check]
 */

import { fileURLToPath } from 'node:url';
import {
  GOOGLE_TARGETS,
  verifyGoogleApiKey,
  rollAndApplyGoogleKey,
} from '../functions/src/lib/credentials/google-roll.js';
import {
  listAwsAccessKeys,
  verifyAwsPricingAccess,
  rollAndApplyAwsKey,
} from '../functions/src/lib/credentials/aws-roll.js';

export const VALID_TARGETS = ['gemini', 'youtube', 'billing', 'google-all', 'aws', 'all'];

/**
 * Parses CLI arguments into an options bag. Rejects unknown flags and
 * flags with missing operands.
 *
 * @param {string[]} argv
 * @returns {object}
 */
export function parseArgs(argv) {
  const options = {
    target: 'all',
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
        options.invalid = `Option --target requires an operand (${VALID_TARGETS.join(', ')})`;
        return options;
      }
      options.target = argv[++i];
    } else {
      options.invalid = `Unrecognized option: '${arg}'`;
      return options;
    }
  }

  if (!VALID_TARGETS.includes(options.target)) {
    options.invalid = `Invalid target: '${options.target}' (must be one of: ${VALID_TARGETS.join(', ')})`;
  }

  return options;
}

/**
 * Prints usage instructions.
 */
export function printUsage(stdout = console.log) {
  stdout(`Usage: roll-cloud-credentials.mjs [options]

Renew Google Cloud API keys and the AWS pricing IAM access key with
verify-before-delete semantics and Azure Key Vault updates (#1028).

Options:
  --target <target>     Target to renew: 'gemini', 'youtube', 'billing', 'google-all', 'aws', or 'all' (default: 'all')
  --dry-run             Validate configuration and display actions without mutating keys
  --check               Verify that current credentials and provider endpoints are operational
  --help, -h            Show this help message

Environment variables:
  GCP_ACCESS_TOKEN          Google Cloud OAuth2 token with apikeys admin permission (or GOOGLE_ACCESS_TOKEN)
  GCP_PROJECT_ID            Google Cloud Project ID (or GCP_PROJECT_NUMBER)
  GEMINI_API_KEY            (Optional) Current Gemini API key for lookup
  YOUTUBE_API_KEY           (Optional) Current YouTube API key for lookup
  GCP_BILLING_API_KEY       (Optional) Current Billing API key for lookup
  AWS_ACCESS_KEY_ID         AWS IAM Access Key ID
  AWS_SECRET_ACCESS_KEY     AWS IAM Secret Access Key
  KEY_VAULT_URI             Azure Key Vault base URI (for live mutations)
`);
}

/**
 * Resolves the targets to process based on the --target argument.
 *
 * @param {string} target
 * @returns {{ googleTargets: object[], awsTarget: boolean }}
 */
export function resolveTargets(target) {
  const chosen = Object.hasOwn(TARGET_SETS, target) ? TARGET_SETS[target] : { google: [], aws: false };
  return { googleTargets: chosen.google.map((name) => GOOGLE_TARGETS[name]), awsTarget: chosen.aws };
}

/** What each --target value renews: Google keys by GOOGLE_TARGETS name, and whether the AWS pair is included. */
const TARGET_SETS = {
  gemini: { google: ['gemini'], aws: false },
  youtube: { google: ['youtube'], aws: false },
  billing: { google: ['billing'], aws: false },
  'google-all': { google: ['gemini', 'youtube', 'billing'], aws: false },
  aws: { google: [], aws: true },
  all: { google: ['gemini', 'youtube', 'billing'], aws: true },
};

/** The environment variable that holds the current value of each Google key, by its Key Vault secret name. */
const CURRENT_KEY_VARIABLES = { 'GEMINI-API-KEY': 'GEMINI_API_KEY', 'YOUTUBE-API-KEY': 'YOUTUBE_API_KEY' };

/** The current value of a Google key from the environment, trimmed; '' when it is not set. */
function currentGoogleKey(target, env) {
  const variable = CURRENT_KEY_VARIABLES[target.secretName] ?? 'GCP_BILLING_API_KEY';
  return (env[variable] || '').trim();
}

/**
 * Main orchestrator for CLI execution.
 *
 * @param {string[]} argv
 * @param {object} [deps]
 * @returns {Promise<number>} Exit code (0 for success, 1 for failure)
 */
export async function main(
  argv = process.argv.slice(2),
  {
    env = process.env,
    stdout = console.log,
    stderr = console.error,
    fetchImpl = globalThis.fetch,
    vault,
    pricingClient,
  } = {}
) {
  const options = parseArgs(argv);

  if (options.help) {
    printUsage(stdout);
    return 0;
  }

  if (options.invalid) {
    stderr(`Error: ${options.invalid}\n`);
    printUsage(stderr);
    return 1;
  }

  const { googleTargets, awsTarget } = resolveTargets(options.target);
  const run = {
    options,
    env,
    stdout,
    stderr,
    fetchImpl,
    vault,
    pricingClient,
    googleTargets,
    awsTarget,
    gcpToken: (env.GCP_ACCESS_TOKEN || env.GOOGLE_ACCESS_TOKEN || '').trim(),
    gcpProjectId: (env.GCP_PROJECT_ID || env.GCP_PROJECT_NUMBER || '').trim(),
    awsAccessKeyId: (env.AWS_ACCESS_KEY_ID || '').trim(),
    awsSecretAccessKey: (env.AWS_SECRET_ACCESS_KEY || '').trim(),
  };

  // Validate environment variables based on selected targets
  const missing = missingCredential(run);
  if (missing) {
    stderr(missing);
    return 1;
  }

  // CHECK MODE: Verify current credentials and connectivity without mutating
  if (options.check) return checkCredentials(run);

  // DRY-RUN MODE: Output planned actions without side-effects; otherwise the LIVE ROTATION EXECUTION
  return options.dryRun ? dryRunCredentials(run) : rollCredentials(run);
}

/** The error line for a credential the selected targets need and the environment lacks, or null. */
function missingCredential({ googleTargets, awsTarget, gcpToken, awsAccessKeyId, awsSecretAccessKey }) {
  if (googleTargets.length > 0 && !gcpToken) {
    return 'Error: GCP_ACCESS_TOKEN (or GOOGLE_ACCESS_TOKEN) environment variable is required for Google targets.';
  }
  if (awsTarget && (!awsAccessKeyId || !awsSecretAccessKey)) {
    return 'Error: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables are required for AWS target.';
  }
  return null;
}

/** --check: probe each current key, change nothing. */
async function checkCredentials(run) {
  const { options, env, stdout, stderr, fetchImpl, googleTargets, awsTarget } = run;
  stdout(`Checking credentials for target '${options.target}'...`);
  let allChecksPassed = true;

  for (const target of googleTargets) {
    const currentKey = currentGoogleKey(target, env);

    if (currentKey) {
      try {
        await verifyGoogleApiKey({ target, keyString: currentKey, fetchImpl });
        stdout(`  ✓ ${target.secretName}: Functional probe succeeded.`);
      } catch (err) {
        stderr(`  ✗ ${target.secretName}: Functional probe failed: ${err.message}`);
        allChecksPassed = false;
      }
    } else {
      stdout(`  - ${target.secretName}: No current key in env to probe.`);
    }
  }

  if (awsTarget && !(await checkAws(run))) allChecksPassed = false;

  return allChecksPassed ? 0 : 1;
}

/** The AWS half of --check: the key list and a Pricing probe. Returns whether both passed. */
async function checkAws({ stdout, stderr, fetchImpl, pricingClient, awsAccessKeyId, awsSecretAccessKey }) {
  try {
    const keys = await listAwsAccessKeys({
      accessKeyId: awsAccessKeyId,
      secretAccessKey: awsSecretAccessKey,
      fetchImpl,
    });
    stdout(`  ✓ AWS IAM: Access keys list reachable (currently ${keys.length} active key(s)).`);
    await verifyAwsPricingAccess({
      accessKeyId: awsAccessKeyId,
      secretAccessKey: awsSecretAccessKey,
      clientImpl: pricingClient,
    });
    stdout('  ✓ AWS Pricing: Functional GetProducts probe succeeded.');
    return true;
  } catch (err) {
    stderr(`  ✗ AWS target check failed: ${err.message}`);
    return false;
  }
}

/** --dry-run: the planned steps for each target, with nothing changed. */
function dryRunCredentials({ options, stdout, googleTargets, awsTarget }) {
  stdout(`[dry-run] Planned credential renewals for target '${options.target}':`);
  for (const target of googleTargets) {
    stdout(`  [dry-run] Google API Key: Mint new ${target.secretName} -> verify probe -> save to Key Vault -> delete old key`);
  }
  if (awsTarget) {
    stdout('  [dry-run] AWS IAM Access Key: Check 2-key quota -> create new key -> probe AWS Pricing -> save to Key Vault -> delete old key');
  }
  stdout('[dry-run] Configuration valid; no mutations performed.');
  return 0;
}

/** The Google project the new keys are made in, as `projects/<id>`; undefined when none is set. */
function googleParent(gcpProjectId) {
  if (!gcpProjectId) return undefined;
  return gcpProjectId.startsWith('projects/') ? gcpProjectId : `projects/${gcpProjectId}`;
}

/** The live renewal: each Google key, then the AWS pair. 1 when any failed. */
async function rollCredentials(run) {
  const { options, env, stdout, stderr, fetchImpl, vault, googleTargets, awsTarget, gcpToken, gcpProjectId } = run;
  stdout(`Executing automated credential renewal for target '${options.target}'...`);
  let hadFailure = false;

  // Process Google targets
  for (const target of googleTargets) {
    const currentKey = currentGoogleKey(target, env);

    try {
      stdout(`Rolling Google API Key '${target.secretName}'...`);
      const res = await rollAndApplyGoogleKey({
        target,
        gcpToken,
        oldKeyString: currentKey || undefined,
        parent: googleParent(gcpProjectId),
        vault,
        fetchImpl,
      });
      stdout(`  ✓ ${target.secretName} renewed successfully (Resource: ${res.newKeyName}, Old deleted: ${res.oldKeyDeleted}).`);
    } catch (err) {
      stderr(`  ✗ Failed to roll ${target.secretName}: ${err.message}`);
      hadFailure = true;
    }
  }

  // Process AWS target
  if (awsTarget && !(await rollAws(run))) hadFailure = true;

  if (hadFailure) {
    stderr('\nRenewal completed with one or more failures.');
    return 1;
  }

  stdout('\nAll requested credential renewals succeeded.');
  return 0;
}

/** The AWS key pair renewed. Returns whether it worked. */
async function rollAws({ stdout, stderr, fetchImpl, vault, pricingClient, awsAccessKeyId, awsSecretAccessKey }) {
  try {
    stdout('Rolling AWS IAM price-list access key pair...');
    const res = await rollAndApplyAwsKey({
      currentAccessKeyId: awsAccessKeyId,
      currentSecretAccessKey: awsSecretAccessKey,
      vault,
      fetchImpl,
      pricingClient,
    });
    stdout(`  ✓ AWS IAM access key renewed successfully (New key ID: ${res.newAccessKeyId}, Old deleted: ${res.oldAccessKeyIdDeleted}).`);
    return true;
  } catch (err) {
    stderr(`  ✗ Failed to roll AWS IAM access key: ${err.message}`);
    return false;
  }
}

// Execute when invoked directly via CLI
const isDirectCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectCli) {
  main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
