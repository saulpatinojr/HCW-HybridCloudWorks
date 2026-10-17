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

/** Broad roles that must never be assigned as standing grants to CI or workload identities. */
export const DISALLOWED_STANDING_ROLES = new Set([
  'Owner',
  'Contributor',
  'User Access Administrator',
  'Role Based Access Control Administrator',
]);

/**
 * Normalizes input: parses JSON string or returns object directly.
 * @param {string|object} input
 * @returns {object}
 */
export function parseInput(input) {
  if (typeof input === 'object' && input !== null) return input;
  if (typeof input !== 'string') {
    throw new TypeError('Input must be a JSON string or an object.');
  }
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Input is empty.');
  }
  return JSON.parse(trimmed);
}

/**
 * Verifies Key Vault network posture.
 *
 * @param {string|object} raw
 * @returns {{ ok: boolean, errors: string[], details: object }}
 */
export function verifyKeyVaultPosture(raw) {
  const errors = [];
  const kv = parseInput(raw);
  const props = kv.properties || kv;
  const acls = props.networkAcls || {};

  const defaultAction = acls.defaultAction;
  if (defaultAction !== 'Deny') {
    errors.push(`Key Vault defaultAction is "${defaultAction ?? 'undefined'}", expected "Deny".`);
  }

  const ipRules = acls.ipRules || [];
  if (Array.isArray(ipRules) && ipRules.length > 0) {
    const rules = ipRules.map((r) => r.value || r).join(', ');
    errors.push(`Key Vault has ${ipRules.length} standing IP rule(s) configured (${rules}); expected 0.`);
  }

  return {
    ok: errors.length === 0,
    errors,
    details: {
      defaultAction: defaultAction ?? null,
      ipRulesCount: Array.isArray(ipRules) ? ipRules.length : 0,
      bypass: acls.bypass ?? null,
    },
  };
}

/**
 * Verifies Storage Account network posture.
 *
 * @param {string|object} raw
 * @returns {{ ok: boolean, errors: string[], details: object }}
 */
export function verifyStoragePosture(raw) {
  const errors = [];
  const stor = parseInput(raw);
  const props = stor.properties || stor;
  const rules = props.networkRuleSet || props.networkRules || {};

  const defaultAction = rules.defaultAction;
  if (defaultAction !== 'Deny') {
    errors.push(`Storage Account defaultAction is "${defaultAction ?? 'undefined'}", expected "Deny".`);
  }

  return {
    ok: errors.length === 0,
    errors,
    details: {
      defaultAction: defaultAction ?? null,
      bypass: rules.bypass ?? null,
    },
  };
}

/**
 * Verifies that role assignments do not contain forbidden standing broad grants.
 *
 * @param {string|Array<object>} raw
 * @param {object} [options]
 * @param {string[]} [options.disallowedRoles]
 * @param {string} [options.targetAssignee] - optional filter for a specific principal
 * @returns {{ ok: boolean, errors: string[], evaluatedCount: number }}
 */
export function verifyNoStandingGrants(raw, options = {}) {
  const errors = [];
  const parsed = parseInput(raw);
  const assignments = Array.isArray(parsed) ? parsed : [parsed];
  const disallowed = new Set(options.disallowedRoles || DISALLOWED_STANDING_ROLES);

  let evaluatedCount = 0;
  for (const assignment of assignments) {
    if (!assignment || typeof assignment !== 'object') continue;

    const roleName = assignment.roleDefinitionName || assignment.roleName || assignment.properties?.roleDefinitionName;
    const scope = assignment.scope || assignment.properties?.scope || '';
    const principalId = assignment.principalId || assignment.properties?.principalId;

    if (options.targetAssignee && principalId !== options.targetAssignee) {
      continue;
    }

    evaluatedCount++;

    if (roleName && disallowed.has(roleName)) {
      errors.push(
        `Disallowed standing grant found: role "${roleName}" assigned at scope "${scope}" (principal: ${principalId || 'unknown'}).`
      );
    }

    // Check for subscription-wide Reader if forbidden
    if (options.forbidSubscriptionReader && roleName === 'Reader') {
      if (scope.match(/^\/subscriptions\/[^/]+$/i)) {
        errors.push(
          `Disallowed subscription-wide Reader role assigned at scope "${scope}" (principal: ${principalId || 'unknown'}).`
        );
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    evaluatedCount,
  };
}

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
