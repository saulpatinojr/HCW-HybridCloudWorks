/**
 * How check-image-hosts.mjs reads a Content-Security-Policy's img-src
 * (moved out of that file by #1845): what a URL needs from the directive,
 * whether a list of sources admits it, and the sources of a policy string.
 */

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/** The origin of an absolute URL, or `fallback` when it does not parse. */
function originOr(text, fallback) {
  try {
    return new URL(text).origin;
  } catch {
    return fallback;
  }
}

/**
 * What a URL needs from img-src: `'self'` for a relative path, its origin
 * for http and https, and otherwise its scheme as a token (`data:`, `blob:`,
 * and equally `ftp:` or `javascript:`). Only a URL with NO scheme is
 * relative: anything else goes to `allowedBy` under its own name, so a
 * scheme the policy never heard of is reported missing rather than waved
 * through as a page of the site. A protocol-relative URL resolves on https.
 */
export function imageOrigin(url) {
  const value = url.trim();
  if (value.startsWith('//')) return originOr(`https:${value}`, value);
  const scheme = SCHEME.exec(value)?.[1].toLowerCase();
  if (!scheme) return "'self'";
  if (scheme === 'http' || scheme === 'https') return originOr(value, value);
  return `${scheme}:`;
}

/**
 * Whether an origin is admitted by a list of img-src sources. `'self'` admits
 * only relative URLs: the site answers on the apex and on www, and an absolute
 * URL to one of them would fail on the other. A `https://*.example` source
 * admits every subdomain and not the bare domain, as the browser reads it.
 */
export function allowedBy(origin, sources) {
  if (origin === "'self'" || origin === 'data:' || origin === 'blob:')
    return sources.includes(origin);
  if (!origin.startsWith('https://')) return false;
  const host = origin.slice('https://'.length);
  return sources.some((source) => {
    if (source === origin) return true;
    if (source.startsWith('https://*.')) {
      const suffix = source.slice('https://*'.length);
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return false;
  });
}

/** The img-src sources of a policy, or an empty list when the directive is absent. */
export function imgSrcOf(policy) {
  const directive = policy
    .split(';')
    .map((part) => part.trim())
    .find((part) => part === 'img-src' || part.startsWith('img-src '));
  return directive ? directive.slice('img-src'.length).trim().split(/\s+/).filter(Boolean) : [];
}
