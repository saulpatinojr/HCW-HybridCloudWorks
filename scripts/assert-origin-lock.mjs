/**
 * Is the Function App's origin lock enforcing? Read where it is enforced.
 * (PLAT-2, #962)
 *
 * ## What this replaced
 *
 * `deploy-functions.yml` used to prove the lock by curling the API's public,
 * Cloudflare-proxied hostname from the runner and passing on anything but a
 * 200. A GitHub-hosted runner asking that hostname is answered by Cloudflare's
 * Bot Fight Mode with a challenge and a 403 before the request leaves
 * Cloudflare. So the step read Cloudflare's answer, never Azure's, and
 * reported "enforcing" whether the Azure restriction was on or off. Turning
 * `functions_origin_lock_enabled` to false would have left it green.
 *
 * ## What it reads instead
 *
 * The control plane: `az functionapp config access-restriction show`, the
 * Function App's own IP security restrictions, held to what `infra/` declares.
 * `infra/functionapp.tf` writes them from `functions_origin_lock_enabled`:
 * when true, one Allow rule per range in `cloudflare_ip_ranges`
 * (`infra/variables.tf`), an explicit IPv4 deny-all, and
 * `ip_restriction_default_action = "Deny"`; when false, no rules and Allow.
 *
 * It fails when:
 *
 *   1. `ipSecurityRestrictionsDefaultAction` is not `Deny`. That is the
 *      unmatched-request action, the one that decides IPv6 and anything no rule
 *      names, and it is what the variable flips. Allow means the variable is
 *      false in the workspace, or the site has drifted from Terraform.
 *   2. Any address an Allow rule lists is `Any`, `0.0.0.0/0` or `::/0`. A rule
 *      may list several addresses separated by commas, and each one is read:
 *      a permitted address beside an unrestricted one does not hide it.
 *   3. A `cloudflare-*` rule lists an address that is not one of the declared
 *      Cloudflare ranges. The name is not what makes a rule Cloudflare's; the
 *      addresses are.
 *   4. A `ci-*` rule lists more than one address, or anything wider than one
 *      host. A per-run window admits one runner, as a /32.
 *   5. An Allow rule is named neither `cloudflare-*` (Terraform's) nor `ci-*`
 *      (a workflow's per-run window). It was added outside Terraform.
 *   6. Unmatched requests are refused and a declared Cloudflare range has no
 *      Allow rule that takes effect: none at all, one that a Deny rule
 *      evaluated first overrides (a smaller priority number, or the same
 *      number listed earlier), or one narrowed by a header filter Terraform
 *      does not write. Cloudflare's edges in that range are refused at the
 *      origin; with none admitted the API is unreachable through Cloudflare,
 *      which is not a lock that works.
 *   7. `--window-closed <rule>` was given and that rule is still present: the
 *      caller's own window did not close.
 *
 * The SCM site's posture is printed and not asserted: `functions_scm_lock_enabled`
 * governs it (true by default since 2026-10-14, PLAT-10), and
 * deploy-functions.yml's SCM window steps already assert that the posture
 * they found is the posture they left.
 *
 * ## Usage
 *
 *     az functionapp config access-restriction show -n APP -g RG -o json \
 *       | node scripts/assert-origin-lock.mjs [--window-closed ci-smoke-<run id>]
 *
 * Run from a checkout: the declared ranges are read from `infra/`. Exit 0
 * enforcing, 1 not enforcing (each reason named), 2 the input or `infra/`
 * could not be read. Every line is Markdown for a job summary, on stdout.
 */
import { pathToFileURL } from 'node:url';

import { INFRA, terraformSource } from './terraform-source.mjs';
import { addressesOf, declaredCloudflareRanges, headerFilterOf, isAllow, MIN_DECLARED_RANGES, parseRestrictions, RANGES_VARIABLE, shadowingDeny } from './lib/origin-lock-rules.mjs';
import { lockProblems } from './lib/origin-lock-problems.mjs';
// The parts below now live in their own files; they are exported from here too, so callers keep their imports.
export { LOCK_VARIABLE, RANGES_VARIABLE, MIN_DECLARED_RANGES, addressesOf, isSingleAddress, ipv4Interval, overlaps, headerFilterOf, declaredCloudflareRanges, parseRestrictions } from './lib/origin-lock-rules.mjs';
export { lockProblems } from './lib/origin-lock-problems.mjs';

/** Exit code and Markdown lines for a parsed document. */
export function report(doc, options = {}) {
  const problems = lockProblems(doc, options);
  const declared = new Set(options.declaredRanges ?? []);
  const allows = doc.ipSecurityRestrictions.filter(isAllow);
  const admitted = new Set();
  for (const rule of allows.filter((r) => String(r?.name ?? '').startsWith('cloudflare-') && !headerFilterOf(r))) {
    for (const address of addressesOf(rule)) {
      if (declared.has(address) && !shadowingDeny(doc.ipSecurityRestrictions, rule, address)) admitted.add(address);
    }
  }
  const windows = allows
    .map((rule) => String(rule?.name ?? ''))
    .filter((name) => name.startsWith('ci-'));
  const scm = doc.scmIpSecurityRestrictionsDefaultAction ?? 'unset';

  const facts = [
    `Read from the control plane: unmatched requests \`${doc.ipSecurityRestrictionsDefaultAction ?? 'unset'}\`, ` +
      `${admitted.size} of ${declared.size} declared Cloudflare ranges admitted` +
      (windows.length > 0 ? `, open per-run window(s): ${windows.map((n) => `\`${n}\``).join(', ')}` : '') +
      `. SCM (Kudu) unmatched requests \`${scm}\`, reported only; \`functions_scm_lock_enabled\` governs it.`,
  ];

  if (problems.length === 0) {
    return { code: 0, lines: ['✅ Origin lock: **enforcing**', '', ...facts] };
  }
  return {
    code: 1,
    lines: [
      '❌ Origin lock: **NOT ENFORCING**',
      '',
      ...problems.map((problem) => `- ${problem}`),
      '',
      ...facts,
    ],
  };
}

export const USAGE =
  'usage: az functionapp config access-restriction show -n APP -g RG -o json | ' +
  'node scripts/assert-origin-lock.mjs [--window-closed <rule name>]';

/** An exit-2 answer: the check could not run, which says nothing about the lock. */
const unreadable = (reason) => ({
  code: 2,
  lines: [`⚠️ Origin lock: **unreadable**: ${reason} This says nothing about the lock either way.`],
});

/**
 * Arguments and stdin text in; exit code and stdout lines out.
 *
 * `declaredRanges` defaults to the ones `infra/` declares, read from the
 * checkout; tests pass their own.
 */
export function run({ args = [], input = '', declaredRanges }) {
  let windowRule;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--window-closed' && args[i + 1] && !args[i + 1].startsWith('--')) {
      windowRule = args[i + 1];
      i += 1;
    } else {
      return { code: 2, lines: [`⚠️ Origin lock: **unreadable**: unknown or incomplete argument \`${args[i]}\`.`, USAGE] };
    }
  }

  let ranges = declaredRanges;
  if (ranges === undefined) {
    try {
      ranges = declaredCloudflareRanges(terraformSource(INFRA));
    } catch (error) {
      return unreadable(`infra/ could not be read: ${error.message}`);
    }
  }
  if (ranges.length < MIN_DECLARED_RANGES) {
    return unreadable(
      `only ${ranges.length} Cloudflare ranges were parsed from \`${RANGES_VARIABLE}\` in infra/variables.tf, ` +
        `fewer than ${MIN_DECLARED_RANGES}, so the parse is broken and the rules cannot be held to it.`
    );
  }

  let doc;
  try {
    doc = parseRestrictions(input);
  } catch (error) {
    return unreadable(error.message);
  }
  return report(doc, { windowRule, declaredRanges: ranges });
}

/** All of stdin, as text. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  readStdin()
    .then((input) => run({ args: process.argv.slice(2), input }))
    .then(({ code, lines }) => {
      process.stdout.write(`${lines.join('\n')}\n`);
      process.exitCode = code;
    })
    .catch((error) => {
      process.stdout.write(`⚠️ Origin lock: **unreadable**: ${error?.message || String(error)}\n`);
      process.exitCode = 2;
    });
}
