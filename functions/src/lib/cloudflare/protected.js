/**
 * cloudflare/protected.js — the zones the Cloudflare page and Claude Network
 * Guy may act on, and what in them they may never change (#1905, #1911).
 *
 * THE ZONES are a fixed list (MANAGED_ZONES): the site's own zone and the
 * lab's certificate zone. A zone not on it is refused before Cloudflare is
 * called, whatever the token could reach. Each zone carries its own DNS
 * names, prefixes and Terraform phases; the allow-list of phases and the
 * owner-only settings are the same for every zone.
 *
 * Three kinds of list:
 *
 *   - DNS names. The site's own address (the apex and www), every record
 *     Terraform manages in infra/frontend.tf, the lab's records in
 *     infra-lab/dns.tf, and any name that starts `_acme-challenge` (a
 *     certificate check). Changing one of these from the portal would either
 *     take part of the site down or be undone by the next Terraform run. A
 *     wildcard (`*.x`) whose base `x` is protected is protected too, and so is
 *     the zone-wide wildcard `*`, because a wildcard answers for names nobody
 *     listed. A wildcard entry in the list (`*.lab...`) protects every name
 *     under its parent: a record made there would answer in its place.
 *     A wildcard `*.x` is refused too when a protected name lies under x,
 *     because it would answer for that name whenever no exact record does.
 *     In the lab zone (#1911): its apex, the certificate checks Caddy writes,
 *     every name starting `_` (Caddy's checks, and the verification and
 *     mail-policy names outside services read), the whole `lab` subtree the
 *     checks live in (LAB_SUBTREE, from the delegation
 *     target infra-lab/variables.tf points at), and every wildcard, because
 *     a wildcard there could answer the DNS-01 check for the lab's
 *     certificates between renewals. Its `www` and other names stay open.
 *   - Rule phases, as an ALLOW-list. A phase is the point in handling a
 *     request where a group of rules runs. Only the phases in EDITABLE_PHASES
 *     may be replaced from here. Every other phase is read-only: the one
 *     Terraform writes in the site's zone (PROTECTED_PHASES, with its own
 *     reason) and any other
 *     phase, named or not, because some kinds of rule can send or store the
 *     site's traffic elsewhere (an origin rule, a snippet, a cloud
 *     connector), and a kind Cloudflare adds later should start shut. The
 *     API rate limit (`http_ratelimit`) is editable since 2026-11-26: the
 *     owner moved it from Terraform to this page and Claude Network Guy
 *     (#1903, ADR 0047's amendment).
 *   - Zone settings only the owner changes (OWNER_ONLY_SETTINGS). A person
 *     with the super admin role may change them; an agent key may not,
 *     because a wrong value breaks or weakens HTTPS for every visitor.
 *
 * It imports nothing, so the browser can mirror it, and protected.test.js
 * reads the .tf files and fails when a Terraform record or phase is missing
 * from the lists below, or when a phase Terraform writes is on the
 * allow-list.
 */

/** The zone the site lives in (infra/variables.tf `domain`), and the one a request names when it names none. */
export const SITE_ZONE = 'hybridcloudworks.com';
export const ZONE_APEX = SITE_ZONE;

/**
 * The lab's certificate zone (#948, #1911): the lab host's Caddy writes its
 * short-lived `_acme-challenge` proof records here, never into the site's
 * zone. Nothing else lives in it; no Terraform manages a record in it.
 */
export const LAB_ZONE = 'hybridcloudinsights.com';

/** The lab host's name (infra-lab/variables.tf `lab_hostname`). */
const LAB = `lab.${ZONE_APEX}`;

const SITE =
  "The site itself, on the Static Web App. Its CNAME is managed by Terraform in infra/frontend.tf since #1929, including whether Cloudflare proxies it (the site_proxied_hosts switch), so a change to it here is undone by the next run. The apex's other records (Azure's validation TXT, mail, CAA) are changed in the Cloudflare dashboard by hand; the validation TXT must never be deleted, because Azure reads it again if the apex has to be validated again.";
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

const ACME = '_acme-challenge';

/** Name prefixes refused wherever they appear: a certificate check anywhere in the zone. */
export const PROTECTED_DNS_PREFIXES = Object.freeze([
  Object.freeze({
    prefix: ACME,
    reason: 'A certificate check. Changing it can stop a certificate from renewing.',
  }),
]);

/**
 * The one name in the lab zone the site zone's `_acme-challenge` CNAMEs point
 * at, where Caddy writes its DNS-01 answers (infra-lab/variables.tf
 * `lab_acme_challenge_target`; protected.test.js holds the two equal).
 */
export const LAB_ACME_TARGET = `_acme-challenge.lab.${LAB_ZONE}`;

/** The subtree that target lives in: every name under it is the lab's certificate business. */
export const LAB_SUBTREE = LAB_ACME_TARGET.slice(LAB_ACME_TARGET.indexOf('.') + 1);

const LAB_README = 'lab-host/README.md, "The Cloudflare runtime token and its scope"';

/** The lab zone's protected names: its apex, and the subtree of the lab's certificate checks. */
const LAB_DNS_NAMES = Object.freeze(
  [
    {
      name: LAB_ZONE,
      reason:
        "The lab zone's own address. Nothing lives there, and a record there (an MX or TXT, say) could receive mail for the domain or pass a check that the domain is ours, so it is changed in the Cloudflare dashboard.",
    },
    { name: LAB_SUBTREE, reason: `Where the lab's certificate checks live: the site zone's _acme-challenge names point here (${LAB_README}).` },
    { name: `*.${LAB_SUBTREE}`, reason: `Where the lab's certificate checks live: the site zone's _acme-challenge names point here (${LAB_README}).` },
  ].map(Object.freeze)
);

/** Why every wildcard in the lab zone is refused. */
export const LAB_WILDCARD_REASON = `A wildcard in the lab zone could answer the lab's certificate check whenever Caddy's record is not there (${LAB_README}), so wildcards are changed in the Cloudflare dashboard.`;

/**
 * Every lab-zone name whose first label starts with `_` (#1911 review R1):
 * the only such names there are Caddy's certificate checks, and outside
 * services prove a domain is ours or set its mail policy with them
 * (`_dmarc`, `_domainkey`, a provider's `_verification` record), so none is
 * made from here.
 */
const LAB_DNS_PREFIXES = Object.freeze([
  Object.freeze({
    prefix: '_',
    reason: `In the lab zone the only names with a part starting with _ are the certificate checks the lab host's Caddy writes when it renews the lab's certificates (${LAB_README}), and outside services prove the domain is ours or set its mail policy with such names (_dmarc, _domainkey and the like), so they are changed in the Cloudflare dashboard.`,
  }),
]);

/** Why the zone-wide wildcard `*` is refused. */
export const APEX_WILDCARD_REASON =
  'A wildcard for the whole zone answers for every name nobody listed, so it is changed in the Cloudflare dashboard.';

/** Rule phases Terraform writes: read-only, each with its own reason. */
export const PROTECTED_PHASES = Object.freeze(
  [
    {
      phase: 'http_request_late_transform',
      reason:
        'The origin secret rule (cloudflare_ruleset.origin_secret in infra/frontend.tf). Changing it locks every visitor out of the API.',
    },
  ].map(Object.freeze)
);

/**
 * The zones the site may act on, each with its role in a sentence and its
 * own protected names, prefixes and Terraform phases, and, where every
 * wildcard is refused, the reason (`wildcardReason`). The first is the one
 * a request that names no zone acts on.
 */
export const MANAGED_ZONES = Object.freeze(
  [
    {
      name: SITE_ZONE,
      role: "The site's own zone: the website, its API, the documentation, the podcast, the link page, the notes and the lab host's addresses.",
      dnsNames: PROTECTED_DNS_NAMES,
      dnsPrefixes: PROTECTED_DNS_PREFIXES,
      phases: PROTECTED_PHASES,
      wildcardReason: null,
    },
    {
      name: LAB_ZONE,
      role: "The lab's certificate zone: the lab host's Caddy writes its short-lived certificate checks here, and nothing else lives in it.",
      dnsNames: LAB_DNS_NAMES,
      dnsPrefixes: LAB_DNS_PREFIXES,
      phases: Object.freeze([]),
      wildcardReason: LAB_WILDCARD_REASON,
    },
  ].map(Object.freeze)
);

/** The managed zone a name means (any letter case), or null when it is not one. */
export function managedZone(name) {
  const wanted = String(name ?? '').toLowerCase();
  return MANAGED_ZONES.find((zone) => zone.name === wanted) ?? null;
}

/** Why anything in a zone that is not managed is refused. */
export const UNMANAGED_ZONE_REASON = 'This zone is not one the site manages, so nothing in it is changed from here.';

/** The only rule phases that may be replaced from the portal, each described in a line. */
export const EDITABLE_PHASES = Object.freeze(
  [
    { phase: 'http_request_dynamic_redirect', description: 'Redirects: send a visitor from one address to another.' },
    { phase: 'http_request_transform', description: 'URL rewrites: change the path or query of a request before it reaches the site.' },
    { phase: 'http_response_headers_transform', description: 'Response headers: add, change or remove headers on what the site sends back.' },
    { phase: 'http_config_settings', description: 'Configuration rules: change some zone settings for the requests that match.' },
    { phase: 'http_request_firewall_custom', description: 'Custom security rules: block, challenge or log the requests that match (never skip).' },
    { phase: 'http_ratelimit', description: 'Rate limiting: limit how many requests one address can make, for example to the API.' },
  ].map(Object.freeze)
);

/** Why every phase that is neither editable nor Terraform's is read-only. */
export const READ_ONLY_PHASE_REASON =
  "This kind of rule can send or store the site's traffic elsewhere, so it is changed in the Cloudflare dashboard.";

/**
 * What a secret-sounding header value in an editable phase reads as when the
 * server answers it (rules-routes.js). The browser mirrors it, so its editor
 * refuses to open a list holding it, and the server refuses it sent back.
 */
export const REDACTED_VALUE = '[hidden: change this value in the Cloudflare dashboard]';

/** The custom security rule action refused: it lets matching requests past the other checks. */
export const REFUSED_FIREWALL_ACTION = 'skip';

const OWNER_STEP = 'Change it on the Cloudflare page yourself, signed in as the owner.';

/** Zone settings an agent key may not change, with the reason the page shows. */
export const OWNER_ONLY_SETTINGS = Object.freeze(
  [
    { setting: 'ssl', reason: `How Cloudflare connects to the site; the wrong mode breaks HTTPS for every visitor. ${OWNER_STEP}` },
    { setting: 'min_tls_version', reason: `The oldest encryption a browser may use; a wrong value locks visitors out or weakens HTTPS. ${OWNER_STEP}` },
    { setting: 'always_use_https', reason: `Sends every visitor to HTTPS; turning it off lets pages load unencrypted. ${OWNER_STEP}` },
    { setting: 'security_header', reason: `The HSTS header, which browsers remember for months, so a wrong value is slow to undo. ${OWNER_STEP}` },
    { setting: 'tls_client_auth', reason: `Whether Cloudflare shows the site a certificate of its own; turning it off weakens how the site checks who is calling. ${OWNER_STEP}` },
  ].map(Object.freeze)
);

const lower = (value) => String(value ?? '').trim().toLowerCase();

/**
 * A DNS name as Cloudflare stores it: lower case, no trailing dot, `@` for
 * the apex, and a name without the zone on the end read as one inside it,
 * as Cloudflare reads it. Used for names Cloudflare sends back; a name a
 * caller sends goes through checkDnsName, which is strict.
 */
export function normalizeDnsName(name, apex = ZONE_APEX) {
  const raw = lower(name).replace(/\.+$/, '');
  if (raw === '' || raw === '@') return apex;
  if (raw === apex || raw.endsWith(`.${apex}`)) return raw;
  return `${raw}.${apex}`;
}

const LABEL = /^[a-z0-9_-]{1,63}$/;
const EMPTY_LABEL = 'name may not start or end with a dot, or hold two dots in a row.';
const WILDCARD_PLACE = 'name may hold * only as its whole first part, as in *.blog.';
const LABEL_SHAPE = 'Each part of name holds 1 to 63 letters, digits, hyphens or underscores, and @ may only be the whole name.';

/** What is wrong with one label of a caller's name, or '' when nothing is. */
function labelProblem(label, index) {
  if (label === '') return EMPTY_LABEL;
  if (label === '*') return index === 0 ? '' : WILDCARD_PLACE;
  return LABEL.test(label) ? '' : LABEL_SHAPE;
}

/** A name inside the zone, written in full. */
const fullName = (raw, apex) => (raw === apex || raw.endsWith(`.${apex}`) ? raw : `${raw}.${apex}`);

/**
 * A name a caller sent, checked strictly, as `{ name }` (the full name in
 * lower case: what is checked against the lists and what is sent to
 * Cloudflare) or `{ problem }` (a sentence). `@` is the apex and only on its
 * own; `*` only as the whole first label; no empty label anywhere, so no
 * leading, trailing or double dot.
 */
export function checkDnsName(name, apex = ZONE_APEX) {
  const raw = lower(name);
  if (raw === '@') return { name: apex };
  const problem = raw.split('.').map(labelProblem).find(Boolean);
  if (problem) return { problem };
  const full = fullName(raw, apex);
  return full.length > 253 ? { problem: 'name must be at most 253 characters in full.' } : { name: full };
}

/** Whether a listed name covers `full`. A `*.x` entry covers every name under x. */
const covers = (listed, full) => listed === full || (listed.startsWith('*.') && full.endsWith(listed.slice(1)));

/** The reason a zone's listed name covers `full`, or null. */
function listedReason(zone, full) {
  const entry = zone.dnsNames.find((item) => covers(item.name, full));
  return entry ? entry.reason : null;
}

/** The reason a zone's certificate-check prefix covers `full`, or null. */
function prefixReason(zone, full) {
  // Any label, not only the first: `s1._domainkey` is a mail-signing name too.
  const labels = full.split('.');
  const entry = zone.dnsPrefixes.find((item) => labels.some((label) => label.startsWith(item.prefix)));
  return entry ? entry.reason : null;
}

/** The reason of a listed name lying under `base` (a `*.y` entry counts as y), or null. */
function listedUnderReason(zone, base) {
  const entry = zone.dnsNames.find((item) => item.name.replace(/^\*\./, '').endsWith(`.${base}`));
  return entry ? entry.reason : null;
}

/**
 * The reason of a protected prefix a wildcard over `base` would answer for, or
 * null. `*.foo` answers `_acme-challenge.foo` whenever no exact record exists,
 * so a zone that protects a prefix refuses every wildcard (#1913 review).
 */
function prefixChildReason(zone, base) {
  const entry = zone.dnsPrefixes.find((item) => prefixReason(zone, `${item.prefix}.${base}`));
  return entry ? entry.reason : null;
}

/**
 * Why a wildcard `*.x` may not be changed, or null: the zone's own wildcard,
 * any wildcard in a zone that refuses them all, or a wildcard that would
 * answer for a protected name (x itself, a listed name under x, or a
 * protected prefix's name under x).
 */
function wildcardReason(zone, full) {
  if (!full.startsWith('*.')) return null;
  const base = full.slice(2);
  if (base === zone.name) return APEX_WILDCARD_REASON;
  if (zone.wildcardReason) return zone.wildcardReason;
  // The first check that finds a reason; checks run in this order.
  const checks = [listedReason, prefixReason, listedUnderReason, prefixChildReason];
  return checks.map((check) => check(zone, base)).find(Boolean) ?? null;
}

/** Why a full DNS name may not be added or edited in a zone entry (MANAGED_ZONES' shape), or null. */
export function protectionIn(zone, full) {
  return listedReason(zone, full) || prefixReason(zone, full) || wildcardReason(zone, full);
}

/** Why a DNS name in a zone may not be added or edited, or null when it may. */
export function dnsNameProtection(name, zoneName = SITE_ZONE) {
  const zone = managedZone(zoneName);
  if (!zone) return UNMANAGED_ZONE_REASON;
  return protectionIn(zone, normalizeDnsName(name, zone.name));
}

/**
 * The other managed zone a name sent for `zoneName` belongs to (it is that
 * zone's apex or ends with it, and is not inside `zoneName`), or null.
 */
export function otherManagedZone(name, zoneName) {
  const raw = lower(name).replace(/\.+$/, '');
  const inside = (apex) => raw === apex || raw.endsWith(`.${apex}`);
  if (inside(zoneName)) return null;
  return MANAGED_ZONES.find((zone) => zone.name !== zoneName && inside(zone.name))?.name ?? null;
}

/** Whether a phase is on the allow-list. */
export function isEditablePhase(phase) {
  const wanted = lower(phase);
  return EDITABLE_PHASES.some((entry) => entry.phase === wanted);
}

/** Why a rule phase in a zone may not be replaced (Terraform's reason, or the read-only one), or null when it may. */
export function phaseProtection(phase, zoneName = SITE_ZONE) {
  const wanted = lower(phase);
  const found = (managedZone(zoneName)?.phases ?? []).find((entry) => entry.phase === wanted);
  if (found) return found.reason;
  return isEditablePhase(wanted) ? null : READ_ONLY_PHASE_REASON;
}

/** Why an agent key may not change a zone setting, or null when it may. */
export function ownerOnlySettingReason(settingId) {
  const wanted = lower(settingId);
  const found = OWNER_ONLY_SETTINGS.find((entry) => entry.setting === wanted);
  return found ? found.reason : null;
}
