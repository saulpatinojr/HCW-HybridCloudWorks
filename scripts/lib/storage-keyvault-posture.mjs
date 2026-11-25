/** The storage account's and Key Vault's network posture: read from the az output, and checked to deny by default (check-storage-keyvault-deny.mjs). */

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
