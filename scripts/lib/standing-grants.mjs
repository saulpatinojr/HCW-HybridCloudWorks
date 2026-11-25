/** Role assignments that would let something reach the data with no window open: which roles count, and which grants hold one (check-storage-keyvault-deny.mjs). */
import { parseInput } from './storage-keyvault-posture.mjs';

/** Broad roles that must never be assigned as standing grants to CI or workload identities. */
export const DISALLOWED_STANDING_ROLES = new Set([
  'Owner',
  'Contributor',
  'User Access Administrator',
  'Role Based Access Control Administrator',
]);
/** A role assignment's role name, scope and principal, read from the top level or from `properties`. */
function readAssignment(assignment) {
  return {
    roleName: assignment.roleDefinitionName || assignment.roleName || assignment.properties?.roleDefinitionName,
    scope: assignment.scope || assignment.properties?.scope || '',
    principalId: assignment.principalId || assignment.properties?.principalId,
  };
}

/** The problems with one role assignment: a disallowed role, and a subscription-wide Reader when that is forbidden. */
function grantProblems({ roleName, scope, principalId }, disallowed, options) {
  const problems = [];
  if (roleName && disallowed.has(roleName)) {
    problems.push(
      `Disallowed standing grant found: role "${roleName}" assigned at scope "${scope}" (principal: ${principalId || 'unknown'}).`
    );
  }

  // Check for subscription-wide Reader if forbidden
  if (options.forbidSubscriptionReader && roleName === 'Reader' && scope.match(/^\/subscriptions\/[^/]+$/i)) {
    problems.push(
      `Disallowed subscription-wide Reader role assigned at scope "${scope}" (principal: ${principalId || 'unknown'}).`
    );
  }
  return problems;
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
    const grant = readAssignment(assignment);
    if (options.targetAssignee && grant.principalId !== options.targetAssignee) {
      continue;
    }

    evaluatedCount++;
    errors.push(...grantProblems(grant, disallowed, options));
  }

  return {
    ok: errors.length === 0,
    errors,
    evaluatedCount,
  };
}
