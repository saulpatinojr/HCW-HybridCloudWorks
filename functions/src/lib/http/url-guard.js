/**
 * http/url-guard.js — the address check behind guarded-fetch.js (whose
 * header explains the threat): http(s) only, no localhost or IPv6 literal, the
 * name resolved to one IPv4 address that is not private, link-local or
 * Azure's platform address, and the connection pinned to that address.
 * guarded-fetch.js re-exports what callers use.
 */
import { lookup } from 'node:dns/promises';
import { Agent } from 'undici';
import { AuthoredError, errorCode } from './error-response.js';

/** Dotted-quad IPv4 as an unsigned 32-bit number, or null when it is not one. */
function ipv4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    n = n * 256 + octet;
  }
  return n;
}

/**
 * The IPv4 ranges this app never fetches from, as inclusive [first, last]
 * pairs. A table rather than a chain of comparisons so each refused range
 * reads as one line with its reason, and adding one is adding a row.
 */
const REFUSED_IPV4_RANGES = [
  ['0.0.0.0', '0.255.255.255', 'this network'],
  ['10.0.0.0', '10.255.255.255', 'RFC 1918'],
  ['100.64.0.0', '100.127.255.255', 'carrier-grade NAT (RFC 6598)'],
  ['127.0.0.0', '127.255.255.255', 'loopback'],
  ['168.63.129.16', '168.63.129.16', 'Azure platform (WireServer, plain HTTP)'],
  ['169.254.0.0', '169.254.255.255', 'link-local, including the cloud metadata endpoint'],
  ['172.16.0.0', '172.31.255.255', 'RFC 1918'],
  ['192.168.0.0', '192.168.255.255', 'RFC 1918'],
  ['224.0.0.0', '255.255.255.255', 'multicast, reserved, broadcast'],
].map(([first, last, reason]) => ({ first: ipv4ToInt(first), last: ipv4ToInt(last), reason }));

/** True for an IPv4 address this app must never fetch from. */
export function isPrivateIp(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  return REFUSED_IPV4_RANGES.some(({ first, last }) => n >= first && n <= last);
}

/**
 * A guard refusal. Every sentence is written in this module from the URL the
 * caller gave and what the guard decided, so an admin route may show it
 * (`authoredMessage`, #945); `refused: true` lets a caller tell "must not
 * fetch this" from "could not fetch this".
 */
export class FetchRefusedError extends AuthoredError {
  /**
   * @param {string} message - the refusal, naming the URL part refused
   * @param {{ code?: string }} [options] - a code other than URL_REFUSED (the host allow-list's)
   */
  constructor(message, { code = 'URL_REFUSED' } = {}) {
    super(message, { code });
    this.refused = true;
  }
}

/**
 * A guard refusal: `refused: true` so a caller can tell "must not fetch this"
 * from "could not fetch this" and skip any fallback that would send the same
 * URL elsewhere.
 *
 * @param {string} message - the authored sentence
 * @returns {FetchRefusedError}
 */
export function refusal(message, options) {
  return new FetchRefusedError(message, options);
}

/**
 * Throws (with `refused: true`) when the URL must not be fetched; otherwise
 * returns `{ address }`, the one IPv4 answer the request must connect to.
 */
export async function validateFetchUrl(
  urlString,
  { resolve = (host) => lookup(host, { family: 4 }) } = {}
) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw refusal(`Invalid URL: ${String(urlString)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw refusal('Invalid protocol');
  if (url.hostname === 'localhost') throw refusal('Localhost access denied');
  // `URL.hostname` keeps the brackets on an IPv6 literal. The guard classifies
  // IPv4 only, so an address it cannot classify is one it does not fetch.
  if (url.hostname.startsWith('[')) throw refusal('IPv6 targets are not fetched');
  let address;
  try {
    ({ address } = await resolve(url.hostname));
  } catch (error) {
    throw refusal(`Host could not be resolved: ${url.hostname} (${errorCode(error)})`);
  }
  if (!address || isPrivateIp(address)) throw refusal(`Private IP access denied: ${address}`);
  return { address };
}

/**
 * A `dns.lookup`-shaped function that answers every query with the one
 * address the guard validated. Given to undici's connector so the socket goes
 * where the check looked, whatever the name resolves to a moment later.
 */
export function pinnedLookup(address) {
  return (_hostname, options, callback) => {
    if (typeof options === 'function') {
      options(null, address, 4);
      return;
    }
    if (options?.all) callback(null, [{ address, family: 4 }]);
    else callback(null, address, 4);
  };
}

/** An undici dispatcher whose connections resolve to `address` only. */
export function pinnedDispatcher(address) {
  return new Agent({ connect: { lookup: pinnedLookup(address) } });
}
