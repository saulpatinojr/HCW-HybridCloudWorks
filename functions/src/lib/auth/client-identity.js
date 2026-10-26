/**
 * Identifying an anonymous caller, for rate limiting.
 *
 * ===========================================================================
 * DECISION 6 — the origin MUST be locked to Cloudflare, and this code refuses
 * to pretend otherwise
 * ===========================================================================
 * Cloudflare sits in front of the API (`infra/main.tf`, proxied records), so
 * the true client address is `CF-Connecting-IP`.
 *
 * That header is only trustworthy if the origin cannot be reached directly.
 * When this was written it could: the Function App had no `ip_restriction`
 * and `<app>.azurewebsites.net` resolved publicly, so anyone who found the
 * origin hostname could send `CF-Connecting-IP: 1.2.3.4` and mint unlimited
 * quota per fabricated address, bypassing the WAF too.
 *
 * So the decision is: lock the origin, and make the code fail loudly unless a
 * request proves it came through Cloudflare, rather than silently trusting a
 * spoofable header.
 *
 * The infrastructure half is in place since 2026-08-20 (infra/): the Function
 * App admits only Cloudflare's published ranges (`functions_origin_lock_enabled`),
 * and `cloudflare_ruleset.origin_secret` stamps `x-hcw-origin-secret` on every
 * request proxied to the API host, checked here against CF_ORIGIN_SECRET. The
 * code still refuses on its own when the secret is missing or wrong, so the
 * lock does not depend on the network rule alone.
 *
 * Note X-Forwarded-For is NOT used: it is client-spoofable, and App Service
 * appends its own hop with a `:port` suffix that trips naive splitting.
 */

import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * The `code` on the error `anonymousKey` throws when it fails closed. A caller
 * that wants to answer that refusal, and let any other error (a bug) through,
 * checks for it (#1387).
 */
export const ORIGIN_NOT_VERIFIED = 'ORIGIN_NOT_VERIFIED';

/** Header Cloudflare sets to the true client address. */
const CF_CLIENT_IP_HEADER = 'cf-connecting-ip';

/**
 * How much of an IPv6 address identifies the *subscriber* rather than the host.
 *
 * A residential or mobile IPv6 customer is allocated a whole prefix, not one
 * address — /64 is the smallest thing RFC 4291 lets a link use, and it is what
 * providers hand out at the low end. Hashing the full address therefore gave
 * one client 2^64 distinct quota documents: unlimited submissions, every bucket
 * reading well under the limit, and unbounded growth of `submission_quota` as a
 * side effect (T-205).
 *
 * Truncating to /64 is the conservative choice in the direction that matters.
 * It can over-group — two households behind one ISP's /64 would share a bucket,
 * which is the same situation every IPv4 NAT already creates — but it cannot
 * under-group, and under-grouping is what makes a limiter decorative.
 */
const IPV6_PREFIX_HEXTETS = 4;

/** `::ffff:192.0.2.1` is an IPv4 client wearing an IPv6 shirt. */
const IPV4_MAPPED_PREFIX = /^::ffff:/i;

/**
 * Expand an IPv6 address to its eight four-digit hextets.
 *
 * `isIP` has already established the address is well-formed, so this only has
 * to handle the two compressions the text form allows: `::` for a run of zero
 * groups, and leading zeros dropped within a group.
 */
function expandIpv6(address) {
  const [head, tail = ''] = address.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const gap = 8 - headParts.length - tailParts.length;
  return [...headParts, ...Array(Math.max(0, gap)).fill('0'), ...tailParts].map((part) =>
    part.toLowerCase().padStart(4, '0')
  );
}

/**
 * Reduce a client address to the unit the quota should actually count.
 *
 * Returns a family-tagged string rather than a bare address so the two shapes
 * can never collide in the hash, and so a `submission_quota` document id is
 * traceable to *what kind* of thing it counted without being traceable to whom.
 *
 * Anything unparseable becomes a single shared bucket. That is deliberate: an
 * unrecognised value means the header is absent or malformed, and the safe
 * reading of "I do not know who this is" is "share one quota with everyone else
 * I cannot identify", not "have a fresh quota of your own".
 *
 * @param {string} raw value of the CF-Connecting-IP header
 * @returns {string} normalized, family-tagged quota unit
 */
export function normalizeClientIp(raw) {
  // A zone index (`fe80::1%eth0`) is link-local scope, meaningless to us and
  // rejected by isIP if left on.
  const address = String(raw ?? '')
    .trim()
    .split('%')[0];

  const family = isIP(address);
  if (family === 4) return `v4:${address}`;
  if (family !== 6) return 'unknown';

  if (IPV4_MAPPED_PREFIX.test(address)) {
    // The embedded address is the real client. Fall back to treating it as
    // opaque IPv6 if it is in the hex rather than the dotted form.
    const embedded = address.slice(address.lastIndexOf(':') + 1);
    if (isIP(embedded) === 4) return `v4:${embedded}`;
  }

  return `v6:${expandIpv6(address).slice(0, IPV6_PREFIX_HEXTETS).join(':')}::/64`;
}

/** Header a Cloudflare transform rule injects, proving the request came via CF. */
const CF_ORIGIN_SECRET_HEADER = 'x-hcw-origin-secret';

/**
 * A setting's value, or '' when it is missing or is a Key Vault reference the
 * platform did not resolve.
 *
 * An unresolved reference reaches `process.env` as the literal
 * `@Microsoft.KeyVault(SecretUri=…)` text, and that text is public: it is in
 * `infra/functionapp.tf`. Used as the origin secret, it would be a shared
 * secret anyone can read, so a request carrying it from any Cloudflare-range
 * address would pass as "via our Cloudflare" and choose its own client key
 * through a spoofed `CF-Connecting-IP`. Treated as unset, the check fails
 * closed instead, which is what an unseeded secret should do. The same rule
 * the AI router, the speech providers and `admin-secrets.js` apply
 * (security review of #738, 2026-09-27).
 *
 * @param {string|undefined} value
 * @returns {string}
 */
export function resolvedSetting(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.startsWith('@Microsoft.KeyVault(')) return '';
  return text;
}

/**
 * Refuse, when a handler set is built, an identity object that lacks a method
 * the handlers will call (#1387).
 *
 * The visitor lab sessions asked this helper for a `fromRequest` method it has
 * never had, so in production every visitor was the same person; the unit
 * tests passed because their hand-written identity had that method. A handler
 * that checks the object it is given when the handlers are built fails then
 * (in the Functions app that is the first request, which builds them lazily),
 * and on every test that gives it a fake, instead of on the first visitor's
 * quota. It checks the names only, not what each method returns. The message
 * names the missing methods and no value.
 *
 * @param {unknown} identity
 * @param {string[]} [required] the methods the caller will use
 * @throws {TypeError} when any is not a function
 */
export function assertClientIdentity(identity, required = ['anonymousKey', 'trustedClientIp']) {
  const missing = required.filter((name) => typeof identity?.[name] !== 'function');
  if (missing.length > 0) {
    throw new TypeError(
      `The client identity given has no ${missing.join(' or ')} method. ` +
        'Pass createClientIdentity() from auth/client-identity.js, not a stand-in.'
    );
  }
}

/**
 * @param {object} [options]
 * @param {string} [options.originSecret] Expected shared secret. When set, a
 *   request without it is treated as bypassing Cloudflare.
 * @param {string} [options.ipSalt] Salt for the address hash.
 * @param {boolean} [options.allowUnverifiedOrigin] Dev escape hatch.
 */
export function createClientIdentity({
  originSecret: rawOriginSecret = process.env.CF_ORIGIN_SECRET,
  ipSalt: rawIpSalt = process.env.CLIENT_IP_SALT,
  allowUnverifiedOrigin = process.env.NODE_ENV !== 'production',
} = {}) {
  // Both read through resolvedSetting: an unresolved Key Vault reference is
  // public text, not a secret or a salt (see resolvedSetting).
  const originSecret = resolvedSetting(rawOriginSecret);
  const ipSalt = resolvedSetting(rawIpSalt);
  /**
   * Did this request actually arrive through Cloudflare?
   *
   * Constant-time-ish comparison is not required — the secret is not derived
   * from user input and a timing oracle here yields nothing an attacker cannot
   * get by simply reaching the origin directly, which is the thing being fixed.
   */
  const viaCloudflare = (request) => {
    if (!originSecret) return false;
    return request?.headers?.get?.(CF_ORIGIN_SECRET_HEADER) === originSecret;
  };

  return {
    viaCloudflare,

    /**
     * The caller's address, only when it can be believed: the request came
     * through our Cloudflare (it carries the origin secret) and
     * `CF-Connecting-IP` is a well-formed address. Otherwise null, never the
     * header's text, because without the secret that header is whatever the
     * caller chose to send.
     *
     * For two consumers, the public lab submission and the visitor lab
     * sessions, each passing it to Turnstile's check (lib/labs/public-lock.js),
     * which hands it to Cloudflare's siteverify as `remoteip`. That field is optional, so null means "omit it", which is
     * what the dev escape hatch below gets. Never stored and never logged: the
     * hash from `anonymousKey` is what the quotas count.
     *
     * @param {object} request
     * @returns {string|null}
     */
    trustedClientIp(request) {
      if (!viaCloudflare(request)) return null;
      const address = String(request?.headers?.get?.(CF_CLIENT_IP_HEADER) ?? '').trim();
      return isIP(address) ? address : null;
    },

    /**
     * A stable, pseudonymous key for an anonymous caller.
     *
     * The hash is deliberate: the raw address is a GDPR-relevant identifier and
     * would otherwise become a Cosmos document id, turning the quota container
     * into a browsable list of visitor IPs. The salt stops that set being
     * rainbow-tableable — it belongs in Key Vault.
     *
     * @param {object} request
     * @returns {{ key: string, trusted: boolean }}
     * @throws when the origin is not verifiably Cloudflare and we are not in dev
     */
    anonymousKey(request) {
      const trusted = viaCloudflare(request);

      if (!trusted && !allowUnverifiedOrigin) {
        // Fail closed. Rate limiting on a spoofable identifier is not rate
        // limiting, and silently degrading to one is how a limiter becomes
        // decorative.
        throw Object.assign(
          new Error(
            'Refusing to rate-limit on an unverified origin: the request did not present ' +
              'the Cloudflare shared secret. Lock the origin (ip_restriction / Authenticated ' +
              'Origin Pulls) and set CF_ORIGIN_SECRET.'
          ),
          { code: ORIGIN_NOT_VERIFIED }
        );
      }

      // Normalized BEFORE hashing, because the hash is what the quota counts:
      // hashing the raw address gave an IPv6 client one bucket per address in
      // its /64 (T-205).
      const unit = normalizeClientIp(request?.headers?.get?.(CF_CLIENT_IP_HEADER));
      const hash = createHash('sha256')
        .update(`${ipSalt ?? ''}:${unit}`)
        .digest('hex');

      return { key: hash, trusted };
    },

    /**
     * The rate-limit key for a caller: their Entra oid when authenticated,
     * otherwise the hashed address.
     *
     * Site-Main only rate-limits anonymous callers (`cloud-tools.js:1809`
     * checks `!user?.uid`); this preserves that by returning null for a known
     * user, meaning "no anonymous limit applies".
     */
    rateLimitKey(request, user) {
      if (user?.oid || user?.sub) return null;
      return this.anonymousKey(request).key;
    },
  };
}
