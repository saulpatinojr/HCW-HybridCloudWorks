/** Reading the function app's access restrictions for assert-origin-lock.mjs: addresses, intervals, and the ranges infra/ declares. */

/** The Terraform variable that decides the posture, named in every failure. */
export const LOCK_VARIABLE = 'functions_origin_lock_enabled';

/** The Terraform variable that lists the ranges Cloudflare reaches the origin from. */
export const RANGES_VARIABLE = 'cloudflare_ip_ranges';

/**
 * Fewer declared ranges than this means the parse broke, not that Cloudflare
 * shrank: it publishes fifteen IPv4 ranges today. Without the floor a parse
 * that found nothing would fail every rule as "not declared", or, worse, a
 * future edit could make it pass with nothing to hold the rules to.
 */
export const MIN_DECLARED_RANGES = 10;

/** Addresses that, on an Allow rule, admit everyone. */
export const EVERYONE = new Set(['any', '0.0.0.0/0', '::/0']);

/** The address field on a rule, whichever spelling the CLI used. */
const addressOf = (rule) => String(rule?.ip_address ?? rule?.ipAddress ?? '').trim();

/**
 * Every address a rule lists. Azure accepts several, comma-separated, in one
 * rule, so a check that compared the whole string would miss one of them.
 */
export const addressesOf = (rule) =>
  addressOf(rule)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

/** Whether a rule admits rather than refuses. */
export const isAllow = (rule) => String(rule?.action ?? '').toLowerCase() === 'allow';

/** Whether a rule refuses rather than admits. */
const isDeny = (rule) => String(rule?.action ?? '').toLowerCase() === 'deny';

/** Whether an address is one host: a bare IP, an IPv4 /32 or an IPv6 /128. */
export function isSingleAddress(address) {
  const [ip, prefix] = String(address).split('/');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return prefix === undefined || prefix === '32';
  if (/^[0-9a-f:]+$/i.test(ip) && ip.includes(':')) return prefix === undefined || prefix === '128';
  return false;
}

/**
 * An IPv4 address or CIDR as the first and last address it covers, as
 * integers; null for anything that is not IPv4.
 */
export function ipv4Interval(cidr) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(String(cidr).trim());
  if (!m) return null;
  const octets = m.slice(1, 5).map(Number);
  const prefix = m[5] === undefined ? 32 : Number(m[5]);
  if (octets.some((octet) => octet > 255) || prefix > 32) return null;
  const base = octets.reduce((value, octet) => value * 256 + octet, 0);
  const size = 2 ** (32 - prefix);
  const start = Math.floor(base / size) * size;
  return [start, start + size - 1];
}

/**
 * Whether a rule address covers any part of an IPv4 range. `Any` covers
 * everything; an IPv6 address covers no IPv4 range.
 */
export function overlaps(address, range) {
  if (String(address).trim().toLowerCase() === 'any') return true;
  const a = ipv4Interval(address);
  const b = ipv4Interval(range);
  if (!a || !b) return false;
  return a[0] <= b[1] && b[0] <= a[1];
}

/**
 * The first Deny rule App Service evaluates before `allow` that refuses any
 * part of `range`, or undefined. Rules are evaluated in ascending priority,
 * and rules of equal priority in the order they are listed, so a Deny with a
 * smaller number, or the same number listed earlier, wins over the Allow
 * whatever the Allow says.
 */
export function shadowingDeny(rules, allow, range) {
  const at = Number(allow?.priority);
  if (!Number.isFinite(at)) return undefined;
  const allowIndex = rules.indexOf(allow);
  const first = (deny) => {
    const priority = Number(deny?.priority);
    return priority < at || (priority === at && rules.indexOf(deny) < allowIndex);
  };
  return rules
    .filter(isDeny)
    .filter(first)
    .sort((x, y) => Number(x.priority) - Number(y.priority) || rules.indexOf(x) - rules.indexOf(y))
    .find((deny) => addressesOf(deny).some((address) => overlaps(address, range)));
}

/**
 * A rule's header filter, when it has one. Terraform writes none on the
 * Cloudflare rules, and App Service admits through a filtered rule only the
 * requests whose headers match, so a filtered rule is not unconditional.
 */
export function headerFilterOf(rule) {
  const headers = rule?.headers;
  if (!headers || typeof headers !== 'object') return null;
  const names = Object.keys(headers).filter((name) => {
    const values = headers[name];
    return Array.isArray(values) ? values.length > 0 : values !== null && values !== undefined && values !== '';
  });
  return names.length > 0 ? names : null;
}

/**
 * The Cloudflare ranges `infra/` admits: the default of `cloudflare_ip_ranges`,
 * which `infra/functionapp.tf` turns into one Allow rule each.
 *
 * @param {string} source - the Terraform module, as terraformSource() returns it
 * @returns {string[]} the ranges, in declaration order; empty when not found
 */
export function declaredCloudflareRanges(source) {
  const at = String(source).indexOf(`variable "${RANGES_VARIABLE}"`);
  if (at < 0) return [];
  const end = source.indexOf('\n}', at);
  const block = source.slice(at, end < 0 ? undefined : end);
  const list = /default\s*=\s*\[([\s\S]*?)\]/.exec(block);
  if (!list) return [];
  return [...list[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * Read the access-restriction document.
 *
 * Throws when it is not the shape `az functionapp config access-restriction
 * show` prints, because a document without the main site's rules says nothing
 * about the lock and must not be read as "no rules, so open" or "fine".
 */
export function parseRestrictions(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('the input is not JSON. Expected `az functionapp config access-restriction show -o json`.');
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.ipSecurityRestrictions)) {
    throw new Error(
      'the input has no `ipSecurityRestrictions` list. Expected `az functionapp config access-restriction show -o json`.'
    );
  }
  return doc;
}
