/**
 * cloudflare-roll-plan.mjs: everything roll-cloudflare-tokens.mjs decides
 * before it touches a network (#1027, #1927). It checks the options and the
 * environment, picks the targets and their token IDs, and picks the
 * credentials each kind of token is rolled with. Nothing here calls
 * Cloudflare, HCP Terraform or the lab host, and no secret is printed.
 */

import { TOKEN_OWNERS, tokenOwnerRoutes } from '../../functions/src/lib/credentials/cloudflare-roll.js';

/**
 * The kind of token a target holds. Required (#1927): a target without
 * `owner` is refused by the preflight, never taken for a user token.
 */
export const ownerOf = (target) => target.owner;

/**
 * The checks made before anything is resolved, in order. Each returns
 * `{ message, code }` when the options or the environment cannot go ahead.
 */
const PREFLIGHT_CHECKS = [
  ({ options }) => (options.invalid ? { message: options.invalid, code: 2 } : null),
  ({ targets, targetKeys }) => {
    const unknown = targetKeys.find((key) => !Object.hasOwn(targets, key));
    if (unknown === undefined) return null;
    return { message: `Unknown target: '${unknown}'. Expected one of: ${Object.keys(targets).join(', ')}, all`, code: 1 };
  },
  ({ options, targetKeys }) =>
    targetKeys.length > 1 && options.tokenId
      ? { message: '--token-id cannot be used when targeting multiple targets (use environment variables or run per target)', code: 1 }
      : null,
  ({ targets, targetKeys }) => {
    const unknown = targetKeys.find((key) => !Object.hasOwn(TOKEN_OWNERS, String(ownerOf(targets[key]))));
    return unknown === undefined
      ? null
      : {
          message: `Target '${unknown}' does not say which kind of Cloudflare token it holds, or holds one this script cannot roll (owner: ${Object.keys(TOKEN_OWNERS).join(' or ')})`,
          code: 1,
        };
  },
  // Checked in every mode, dry run included: without the account id the
  // account route cannot be built, and finding that out after a roll is
  // what the check before the roll exists to prevent.
  ({ targets, targetKeys, accountId }) => {
    const needsAccount = targetKeys.filter((key) => TOKEN_OWNERS[ownerOf(targets[key])].needsAccountId);
    if (needsAccount.length === 0) return null;
    try {
      tokenOwnerRoutes({ owner: 'account', accountId });
      return null;
    } catch (err) {
      return { message: `${err.message} (target ${needsAccount.join(', ')})`, code: 2 };
    }
  },
  ({ options, targets, targetKeys, rollTokens }) => {
    if (options.dryRun || options.check) return null;
    const missing = targetKeys.some((key) => !rollTokens[ownerOf(targets[key])]);
    return missing
      ? { message: 'Cloudflare roll token is required (set CLOUDFLARE_ROLL_TOKEN or CLOUDFLARE_API_TOKEN; CLOUDFLARE_ACCOUNT_ROLL_TOKEN may stand in for account-owned tokens)', code: 2 }
      : null;
  },
  ({ options, targets, targetKeys, tfcToken }) => {
    const needsTfc = targetKeys.some((k) => targets[k].type === 'tfc');
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
function resolveTargets({ options, targets: targetsByKey, env, targetKeys, stderr }) {
  const targets = [];
  const seenTokenIds = new Set();
  let missing = 0;

  for (const key of targetKeys) {
    const target = targetsByKey[key];
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

/**
 * The run's plan: `{ code }` (an exit code, already explained on stderr)
 * when it cannot go ahead, otherwise `{ code: null, resolvedTargets,
 * rollTokens, accountId, tfcToken }`.
 *
 * @param {object} params
 * @param {object} params.options Parsed options
 * @param {Record<string, object>} params.targets The roll targets by key
 * @param {Record<string, string>} params.env The environment
 * @param {Function} params.stderr Error output
 */
export function planRun({ options, targets, env, stderr }) {
  const rollToken = env.CLOUDFLARE_ROLL_TOKEN || env.CLOUDFLARE_API_TOKEN;
  // An account-owned token is rolled with "Account API Tokens Write"; when the
  // general roll token does not carry it, a separate one can be given (#1927).
  const rollTokens = { user: rollToken, account: env.CLOUDFLARE_ACCOUNT_ROLL_TOKEN || rollToken };
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const tfcToken = env.TFC_TOKEN || env.TFE_TOKEN;
  const targetKeys = options.target === 'all' ? Object.keys(targets) : [options.target];

  const refusal = preflightRefusal({ options, targets, targetKeys, rollTokens, accountId, tfcToken });
  if (refusal) {
    stderr(`[error] ${refusal.message}`);
    return { code: refusal.code };
  }

  const resolved = resolveTargets({ options, targets, env, targetKeys, stderr });
  if (resolved.code !== 0) return { code: resolved.code };
  return { code: null, resolvedTargets: resolved.targets, rollTokens, accountId, tfcToken };
}
