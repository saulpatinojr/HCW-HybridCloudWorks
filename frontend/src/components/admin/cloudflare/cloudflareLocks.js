/**
 * What the Cloudflare page may not change, as the browser knows it (#1905).
 *
 * WHAT IS LOCKED IS THE SERVER'S DECISION. The server marks a DNS record or
 * a ruleset `locked` with a reason, and refuses a change to it whatever the
 * browser sends. These lists and checks are a mirror of
 * functions/src/lib/cloudflare/protected.js, so the page can say so before
 * the request instead of after it. cloudflareLocks.test.js imports that file
 * (it imports nothing) and fails when the two differ:
 *
 *   PROTECTED_PHASES     the phase Terraform writes, with its reason (the API
 *                        rate limit left Terraform for this page in #1903)
 *   EDITABLE_PHASES      the only phases that may be replaced (an allow-list:
 *                        every other phase is read-only)
 *   OWNER_ONLY_SETTINGS  zone settings an agent key may not change
 *   DNS name checks      dnsNameLock matches the server's dnsNameProtection:
 *                        a `*.x` entry covers every name under x, `*` and a
 *                        wildcard over a protected name are locked, and the
 *                        prefixes come from the status answer
 *   REDACTED_VALUE       what a hidden secret reads as in an editable phase
 *
 * The status answer (`status.protected`) carries the server's own lists; a
 * list here is used only until the status has been read.
 */

/** The zone the site lives in, used when the status has not named it yet. */
export const ZONE_APEX = 'hybridcloudworks.com';

/** The rule phases Terraform writes, and why. The server's own reason wins when it gives one. */
export const PROTECTED_PHASES = Object.freeze([
  Object.freeze({
    phase: 'http_request_late_transform',
    reason:
      'The origin secret rule (infra/frontend.tf, cloudflare_ruleset.origin_secret) adds the header that proves a visitor came through Cloudflare. Changing it locks every visitor out of the API.',
  }),
]);

/** The only rule phases that may be replaced from the page, each in a line. */
export const EDITABLE_PHASES = Object.freeze(
  [
    {
      phase: 'http_request_dynamic_redirect',
      description: 'Redirects: send a visitor from one address to another.',
    },
    {
      phase: 'http_request_transform',
      description:
        'URL rewrites: change the path or query of a request before it reaches the site.',
    },
    {
      phase: 'http_response_headers_transform',
      description: 'Response headers: add, change or remove headers on what the site sends back.',
    },
    {
      phase: 'http_config_settings',
      description: 'Configuration rules: change some zone settings for the requests that match.',
    },
    {
      phase: 'http_request_firewall_custom',
      description:
        'Custom security rules: block, challenge or log the requests that match (never skip).',
    },
    {
      phase: 'http_ratelimit',
      description:
        'Rate limiting: limit how many requests one address can make, for example to the API.',
    },
  ].map(Object.freeze)
);

/** Why every other phase is read-only. */
export const READ_ONLY_PHASE_REASON =
  "This kind of rule can send or store the site's traffic elsewhere, so it is changed in the Cloudflare dashboard.";

/** Zone settings an agent key may not change; a super admin may. */
export const OWNER_ONLY_SETTINGS = Object.freeze(
  ['ssl', 'min_tls_version', 'always_use_https', 'security_header', 'tls_client_auth'].map(
    (setting) =>
      Object.freeze({
        setting,
        reason:
          'Only you change this one: an agent key is refused, because a wrong value breaks or weakens HTTPS for every visitor.',
      })
  )
);

/** What a hidden secret reads as in an editable phase's rules. */
export const REDACTED_VALUE = '[hidden: change this value in the Cloudflare dashboard]';

/** The certificate-check prefix the server always protects, until the status lists its own. */
export const PROTECTED_DNS_PREFIXES = Object.freeze([
  Object.freeze({
    prefix: '_acme-challenge',
    reason:
      'A certificate check record. The certificate for this name is renewed through it, so it is changed only where the certificate is managed.',
  }),
]);

export const APEX_WILDCARD_REASON =
  'A wildcard for the whole zone answers for every name nobody listed, so it is changed in the Cloudflare dashboard.';

const DEFAULT_LOCK = 'This record keeps the site running, so it is locked.';

const lower = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase();

/** One item of a server list in the shape every list here uses, or null. */
function entry(item, key) {
  if (typeof item === 'string') return { [key]: item, reason: '' };
  if (item && typeof item === 'object' && typeof item[key] === 'string') {
    return { ...item, reason: typeof item.reason === 'string' ? item.reason : '' };
  }
  return null;
}

const listOf = (items, key) => (items ?? []).map((item) => entry(item, key)).filter(Boolean);

// ── Rule phases ──────────────────────────────────────────────────────────────

/** Every Terraform phase with its reason: the server's list joined with the mirror. */
export function protectedPhaseList(status) {
  const byPhase = new Map(PROTECTED_PHASES.map((item) => [item.phase, { ...item }]));
  for (const item of listOf(status?.protected?.phases, 'phase')) {
    const known = byPhase.get(item.phase);
    byPhase.set(item.phase, { phase: item.phase, reason: item.reason || known?.reason || '' });
  }
  return [...byPhase.values()];
}

/** The phases that may be replaced: the server's list once read, else the mirror. */
export function editablePhaseList(status) {
  const fromServer = listOf(status?.protected?.editablePhases, 'phase');
  return fromServer.length ? fromServer : EDITABLE_PHASES.map((item) => ({ ...item }));
}

/** Whether a phase is on the allow-list. */
export const isEditablePhase = (phase, status = null) =>
  editablePhaseList(status).some((item) => item.phase === lower(phase));

/**
 * Why a phase is locked, or null when it may be replaced. The server's mark
 * on a ruleset wins; then a Terraform phase's own reason; then any phase not
 * on the allow-list is read-only.
 */
export function phaseLock(phase, { ruleset = null, status = null } = {}) {
  if (ruleset?.locked) return ruleset.lockedReason || READ_ONLY_PHASE_REASON;
  const listed = protectedPhaseList(status).find((item) => item.phase === phase);
  if (listed) return listed.reason || READ_ONLY_PHASE_REASON;
  return isEditablePhase(phase, status) ? null : READ_ONLY_PHASE_REASON;
}

/** Whether any rule still carries a hidden value, so the list cannot be edited here. */
export const holdsHiddenValue = (rules) => JSON.stringify(rules ?? []).includes(REDACTED_VALUE);

// ── Settings ─────────────────────────────────────────────────────────────────

/** Why an agent key may not change a setting (the server's list once read), or null. */
export function ownerOnlyReason(settingId, status = null) {
  const fromServer = listOf(status?.protected?.ownerOnlySettings, 'setting');
  const list = fromServer.length ? fromServer : OWNER_ONLY_SETTINGS;
  return list.find((item) => item.setting === lower(settingId))?.reason || null;
}

// ── DNS names ────────────────────────────────────────────────────────────────

/** A DNS name as Cloudflare spells it in full: lower case, no trailing dot, `@` read as the zone. */
export function normalizeDnsName(name, zoneName = '') {
  const zone = lower(zoneName).replace(/\.$/, '');
  const value = lower(name).replace(/\.$/, '');
  if (!value) return '';
  if (value === '@') return zone;
  const inside = !zone || value === zone || value.endsWith(`.${zone}`);
  return inside ? value : `${value}.${zone}`;
}

/** Every protected DNS name from the status answer, each `{ name, reason }`. */
export function protectedDnsList(status) {
  return listOf(status?.protected?.dnsNames, 'name');
}

/** Every protected prefix: the status answer's, else the certificate check the server always holds. */
export function protectedPrefixList(status) {
  const fromServer = listOf(status?.protected?.dnsPrefixes, 'prefix');
  return fromServer.length ? fromServer : PROTECTED_DNS_PREFIXES.map((item) => ({ ...item }));
}

/** Whether a listed name covers `full`. A `*.x` entry covers every name under x. */
const covers = (listed, full) =>
  listed === full || (listed.startsWith('*.') && full.endsWith(listed.slice(1)));

function listedLock(full, status, zone) {
  const found = protectedDnsList(status).find((item) =>
    covers(normalizeDnsName(item.name, zone), full)
  );
  return found ? found.reason || DEFAULT_LOCK : null;
}

function prefixLock(full, status) {
  const [first] = full.split('.');
  const found = protectedPrefixList(status).find((item) => first.startsWith(item.prefix));
  return found ? found.reason || DEFAULT_LOCK : null;
}

function wildcardLock(full, status, zone) {
  if (!full.startsWith('*.')) return null;
  const base = full.slice(2);
  if (base === zone) return APEX_WILDCARD_REASON;
  return listedLock(base, status, zone) || prefixLock(base, status);
}

/**
 * Why a DNS name is locked, or null: the same rule as the server's
 * dnsNameProtection, read against the status answer's lists.
 */
export function dnsNameLock(name, { status = null, zoneName = '' } = {}) {
  const zone = lower(zoneName || status?.zone?.name || ZONE_APEX);
  const full = normalizeDnsName(name, zone);
  if (!full) return null;
  return (
    listedLock(full, status, zone) || prefixLock(full, status) || wildcardLock(full, status, zone)
  );
}
