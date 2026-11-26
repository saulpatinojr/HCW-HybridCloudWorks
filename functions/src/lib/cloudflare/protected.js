/**
 * cloudflare/protected.js — what the Cloudflare page and Claude Network Guy
 * may never change (#1905).
 *
 * Two lists:
 *
 *   - DNS names. The site's own address (the apex and www), every record
 *     Terraform manages in infra/frontend.tf, the lab's records in
 *     infra-lab/dns.tf, and any name that starts `_acme-challenge` (a
 *     certificate check). Changing one of these from the portal would either
 *     take part of the site down or be undone by the next Terraform run.
 *   - Rule phases. The phases Terraform writes rules into: the origin secret
 *     rule (changing it locks every visitor out of the API) and the API rate
 *     limit.
 *
 * A wildcard entry (`*.lab...`) protects every name under its parent too: a
 * record made there would answer in place of the wildcard.
 *
 * It imports nothing, so the browser can mirror it, and protected.test.js
 * reads the two .tf files and fails when a Terraform record or phase is
 * missing from the lists below.
 */

/** The zone the site lives in (infra/variables.tf `domain`). */
export const ZONE_APEX = 'hybridcloudworks.com';

/** The lab host's name (infra-lab/variables.tf `lab_hostname`). */
const LAB = `lab.${ZONE_APEX}`;

const SITE = 'The site itself, on the Static Web App (made by hand, infra/frontend.tf explains why).';
const FRONTEND = 'Managed by Terraform in infra/frontend.tf; a change here is undone by the next run.';
const LAB_RECORD = 'The lab host, managed by Terraform in infra-lab/dns.tf.';

/** Every protected DNS name, in full and in lower case, with the reason the page shows. */
export const PROTECTED_DNS_NAMES = Object.freeze(
  [
    { name: ZONE_APEX, reason: SITE },
    { name: `www.${ZONE_APEX}`, reason: SITE },
    { name: `api-azure.${ZONE_APEX}`, reason: `The site's API (Azure Functions). ${FRONTEND}` },
    { name: `asuid.api-azure.${ZONE_APEX}`, reason: `Proves the API's custom domain to Azure. ${FRONTEND}` },
    { name: `docs.${ZONE_APEX}`, reason: `The documentation site. ${FRONTEND}` },
    { name: `podcast.${ZONE_APEX}`, reason: `The podcast's website. ${FRONTEND}` },
    { name: `go.${ZONE_APEX}`, reason: `The link page. ${FRONTEND}` },
    { name: `_cf-custom-hostname.go.${ZONE_APEX}`, reason: `Proves the link page's domain. ${FRONTEND}` },
    { name: `notes.${ZONE_APEX}`, reason: `The published notes. ${FRONTEND}` },
    { name: LAB, reason: LAB_RECORD },
    { name: `*.${LAB}`, reason: LAB_RECORD },
    { name: `coder.${LAB}`, reason: LAB_RECORD },
    { name: `*.coder.${LAB}`, reason: LAB_RECORD },
    { name: `_acme-challenge.${LAB}`, reason: `The lab's certificate check. ${LAB_RECORD}` },
    { name: `_acme-challenge.coder.${LAB}`, reason: `The lab's certificate check. ${LAB_RECORD}` },
  ].map(Object.freeze)
);

/** Name prefixes refused wherever they appear: a certificate check anywhere in the zone. */
export const PROTECTED_DNS_PREFIXES = Object.freeze([
  Object.freeze({
    prefix: '_acme-challenge',
    reason: 'A certificate check. Changing it can stop a certificate from renewing.',
  }),
]);

/** Rule phases the portal may read but never replace. */
export const PROTECTED_PHASES = Object.freeze(
  [
    {
      phase: 'http_request_late_transform',
      reason:
        'The origin secret rule (cloudflare_ruleset.origin_secret in infra/frontend.tf). Changing it locks every visitor out of the API.',
    },
    {
      phase: 'http_ratelimit',
      reason: "The API's rate limit rule, managed by Terraform in infra/. A change here is undone by the next run.",
    },
  ].map(Object.freeze)
);

/**
 * A DNS name as Cloudflare stores it: lower case, no trailing dot, `@` for
 * the apex, and a name without the zone on the end read as one inside it,
 * as Cloudflare reads it.
 */
export function normalizeDnsName(name, apex = ZONE_APEX) {
  const raw = String(name ?? '').trim().toLowerCase().replace(/\.+$/, '');
  if (raw === '' || raw === '@') return apex;
  if (raw === apex || raw.endsWith(`.${apex}`)) return raw;
  return `${raw}.${apex}`;
}

/** Why a DNS name may not be added or edited, or null when it may. */
export function dnsNameProtection(name, apex = ZONE_APEX) {
  const full = normalizeDnsName(name, apex);
  for (const entry of PROTECTED_DNS_NAMES) {
    if (entry.name === full) return entry.reason;
    // `*.x` covers every name under x, the wildcard itself included above.
    if (entry.name.startsWith('*.') && full.endsWith(entry.name.slice(1))) return entry.reason;
  }
  const first = full.split('.')[0];
  const prefix = PROTECTED_DNS_PREFIXES.find((entry) => first.startsWith(entry.prefix));
  return prefix ? prefix.reason : null;
}

/** Why a rule phase may not be replaced, or null when it may. */
export function phaseProtection(phase) {
  const found = PROTECTED_PHASES.find((entry) => entry.phase === String(phase ?? '').trim().toLowerCase());
  return found ? found.reason : null;
}
