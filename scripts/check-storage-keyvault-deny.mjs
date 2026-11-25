#!/usr/bin/env node
/**
 * check-storage-keyvault-deny.mjs — Assert deny-by-default posture on Key Vault
 * and Storage Accounts, and verify no standing broad grants exist (SEC-6 / #975).
 *
 * ## Context
 *
 * Security finding SEC-6 requires a reader-identity verification that:
 * 1. Key Vault network ACLs enforce `defaultAction: "Deny"`.
 * 2. Storage Account network rule set enforces `defaultAction: "Deny"`.
 * 3. Key Vault has no standing operator IP rules left open from seeding windows.
 * 4. CI/workload identities hold no broad standing grants (Owner, Contributor,
 *    or subscription-wide Reader) and adhere to least-privilege scoping.
 *
 * Can be run against Azure CLI JSON output via stdin or file flags:
 *   node scripts/check-storage-keyvault-deny.mjs --keyvault kv.json --storage stor.json --roles roles.json
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { verifyKeyVaultPosture, verifyStoragePosture } from './lib/storage-keyvault-posture.mjs';
import { verifyNoStandingGrants } from './lib/standing-grants.mjs';
// The parts below now live in their own files; they are exported from here too, so callers keep their imports.
export { parseInput, verifyKeyVaultPosture, verifyStoragePosture } from './lib/storage-keyvault-posture.mjs';
export { DISALLOWED_STANDING_ROLES, verifyNoStandingGrants } from './lib/standing-grants.mjs';

/**
 * Runs all checks against the provided data objects.
 *
 * @param {object} params
 * @param {object} [params.keyVault]
 * @param {object} [params.storage]
 * @param {Array<object>} [params.roleAssignments]
 * @param {object} [params.roleOptions]
 * @returns {{ ok: boolean, errors: string[], checks: object }}
 */
export function runAllPostureChecks({ keyVault, storage, roleAssignments, roleOptions }) {
  const allErrors = [];
  const checks = {};

  if (keyVault) {
    const kvResult = verifyKeyVaultPosture(keyVault);
    checks.keyVault = kvResult;
    if (!kvResult.ok) allErrors.push(...kvResult.errors);
  }

  if (storage) {
    const storResult = verifyStoragePosture(storage);
    checks.storage = storResult;
    if (!storResult.ok) allErrors.push(...storResult.errors);
  }

  if (roleAssignments) {
    const rolesResult = verifyNoStandingGrants(roleAssignments, roleOptions);
    checks.roleAssignments = rolesResult;
    if (!rolesResult.ok) allErrors.push(...rolesResult.errors);
  }

  return {
    ok: allErrors.length === 0,
    errors: allErrors,
    checks,
  };
}

// CLI runner
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: node check-storage-keyvault-deny.mjs [options]

Options:
  --keyvault <file>     Path to Key Vault JSON file
  --storage <file>      Path to Storage Account JSON file
  --roles <file>        Path to Role Assignments JSON file
  --help, -h            Show this help message
`);
    process.exit(0);
  }

  let kvPath = null;
  let storPath = null;
  let rolesPath = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--keyvault' && args[i + 1]) kvPath = args[++i];
    else if (args[i] === '--storage' && args[i + 1]) storPath = args[++i];
    else if (args[i] === '--roles' && args[i + 1]) rolesPath = args[++i];
  }

  try {
    const keyVault = kvPath ? readFileSync(kvPath, 'utf8') : null;
    const storage = storPath ? readFileSync(storPath, 'utf8') : null;
    const roleAssignments = rolesPath ? readFileSync(rolesPath, 'utf8') : null;

    if (!keyVault && !storage && !roleAssignments) {
      console.error('Error: Provide at least one of --keyvault, --storage, or --roles.');
      process.exit(2);
    }

    const result = runAllPostureChecks({ keyVault, storage, roleAssignments });
    if (result.ok) {
      console.log('✓ All posture checks passed: Deny-by-default enforced, 0 standing grants.');
      process.exit(0);
    } else {
      console.error('✗ Posture checks failed:');
      for (const err of result.errors) {
        console.error(`  - ${err}`);
      }
      process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(2);
  }
}
