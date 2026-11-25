/** What is wrong with the origin lock, rule by rule, and which declared ranges the Allow rules cover (assert-origin-lock.mjs). */
import { addressesOf, EVERYONE, headerFilterOf, isAllow, isSingleAddress, LOCK_VARIABLE, RANGES_VARIABLE, shadowingDeny } from './origin-lock-rules.mjs';

/** The problems with one Allow rule, and the declared ranges it admits. */
function allowRuleProblems(rule, declared) {
  const name = String(rule?.name ?? '');
  const label = `\`${name || '(unnamed)'}\``;
  const addresses = addressesOf(rule);
  const admitted = [];

  const everyone = addresses.filter((address) => EVERYONE.has(address.toLowerCase()));
  if (everyone.length > 0) {
    return { problems: [`The Allow rule ${label} admits \`${everyone.join(', ')}\`, which is every address.`], admitted };
  }
  if (addresses.length === 0) {
    return {
      problems: [
        `The Allow rule ${label} lists no IP address (\`${rule?.tag ?? rule?.vnet_subnet_resource_id ?? 'no address'}\`), ` +
          'so whom it admits cannot be held to infra/.',
      ],
      admitted,
    };
  }

  if (name.startsWith('cloudflare-')) {
    const foreign = addresses.filter((address) => !declared.has(address));
    const problems =
      foreign.length === 0
        ? []
        : [
            `The Allow rule ${label} admits \`${foreign.join(', ')}\`, which is not a Cloudflare range ` +
              `\`infra/variables.tf\` declares (\`${RANGES_VARIABLE}\`). A rule's name is not what makes it Cloudflare's.`,
          ];
    // A header filter Terraform does not write: the rule admits only the
    // requests that match it, so its ranges are not counted as admitted.
    const filtered = headerFilterOf(rule);
    if (filtered) {
      problems.push(
        `The Allow rule ${label} carries a header filter (\`${filtered.join(', ')}\`) that Terraform does not ` +
          'write, so it admits only the requests that match it and its ranges are not counted as admitted.'
      );
    } else {
      admitted.push(...addresses.filter((address) => declared.has(address)));
    }
    return { problems, admitted };
  }
  if (name.startsWith('ci-')) {
    // One address, and one host: two /32s in one rule admit a second caller
    // as surely as a /24 does.
    const wide = addresses.filter((address) => !isSingleAddress(address));
    const problems = [];
    if (addresses.length !== 1) {
      problems.push(
        `The Allow rule ${label} lists ${addresses.length} addresses (\`${addresses.join(', ')}\`). ` +
          'A per-run window admits exactly one runner.'
      );
    } else if (wide.length > 0) {
      problems.push(
        `The Allow rule ${label} admits \`${wide.join(', ')}\`. A per-run window admits one runner, as a /32; ` +
          'anything wider is not a window.'
      );
    }
    return { problems, admitted };
  }
  return {
    problems: [
      `The Allow rule ${label} (\`${addresses.join(', ')}\`) is not one Terraform writes (\`cloudflare-*\`) ` +
        "nor a workflow's per-run window (`ci-*`). It was added outside Terraform and admits a caller the " +
        'configuration does not know about.',
    ],
    admitted,
  };
}

/**
 * The reasons the lock is not enforcing; empty when it is.
 *
 * @param {object} doc - parsed access-restriction document
 * @param {{ declaredRanges: string[], windowRule?: string }} options
 */
export function lockProblems(doc, { declaredRanges, windowRule } = {}) {
  const problems = [];
  const rules = doc.ipSecurityRestrictions;
  const declared = new Set(declaredRanges ?? []);

  const defaultAction = doc.ipSecurityRestrictionsDefaultAction;
  const denies = String(defaultAction ?? '').toLowerCase() === 'deny';
  if (!denies) {
    problems.push(
      `The unmatched-request action is \`${defaultAction ?? 'unset'}\`, not \`Deny\`. ` +
        `\`infra/functionapp.tf\` sets it to Deny when \`${LOCK_VARIABLE}\` is true, so this means the ` +
        'variable is false in the `hcw-azure` workspace, or the site has drifted from Terraform. ' +
        'IPv6 and every address no rule names reach the origin directly.'
    );
  }

  const { covered, shadowed } = allowCoverage(rules, declared, problems);

  // Only while unmatched requests are refused: with Allow, every range gets
  // in anyway, and the first problem above already says the lock is off.
  if (denies) problems.push(...coverageProblems({ declared, covered, shadowed }));

  if (windowRule && rules.some((rule) => rule?.name === windowRule)) {
    problems.push(`This run's window \`${windowRule}\` is still on the origin after the step that removes it.`);
  }
  return problems;
}

/**
 * Which declared ranges the Allow rules admit (`covered`) and which a Deny
 * shadows (`shadowed`: range -> the Deny and the Allow). Each Allow rule's own
 * problems go onto `problems`.
 *
 * A declared range counts as admitted only when its Allow rule takes
 * effect: a Deny that App Service evaluates first refuses the range
 * whatever the Allow says.
 */
function allowCoverage(rules, declared, problems) {
  const covered = new Set();
  const shadowed = new Map();
  for (const rule of rules.filter(isAllow)) {
    const result = allowRuleProblems(rule, declared);
    problems.push(...result.problems);
    for (const range of result.admitted) {
      const deny = shadowingDeny(rules, rule, range);
      if (deny) shadowed.set(range, { deny, allow: rule });
      else covered.add(range);
    }
  }
  for (const range of covered) shadowed.delete(range);
  return { covered, shadowed };
}

/** The declared ranges a Deny shadows, and those no Allow admits at all, while unmatched requests are refused. */
function coverageProblems({ declared, covered, shadowed }) {
  const problems = [];
  for (const [range, { deny, allow }] of shadowed) {
    problems.push(
      `The Deny rule \`${deny?.name || '(unnamed)'}\` (priority ${deny?.priority}) is evaluated before ` +
        `\`${allow?.name}\` (priority ${allow?.priority}) and refuses \`${range}\`, so Cloudflare's edges ` +
        'there are refused at the origin.'
    );
  }
  const uncovered = [...declared].filter((range) => !covered.has(range) && !shadowed.has(range));
  if (uncovered.length > 0) {
    problems.push(
      `No Allow rule admits ${uncovered.length} of the ${declared.size} Cloudflare ranges ` +
        `\`infra/variables.tf\` declares: ${uncovered.map((range) => `\`${range}\``).join(', ')}. ` +
        "Cloudflare's edges there are refused at the origin" +
        (covered.size === 0 ? ', and with none admitted the API is unreachable through Cloudflare.' : '.')
    );
  } else if (covered.size === 0 && declared.size > 0) {
    problems.push('No declared Cloudflare range is admitted, so the API is unreachable through Cloudflare.');
  }
  return problems;
}
