/**
 * presented-key.js — the key a request presents, in the shapes the site's
 * key-protected APIs accept: `Authorization: Bearer <key>`, the bare key as
 * the whole Authorization value, or one of the API's own key headers.
 *
 * A non-empty Authorization wins; one that is absent or blank is the same
 * thing, and the key headers are read in order. A bare Authorization value
 * counts only when it is shaped like the API's key. A query string is never
 * read: addresses end up in logs.
 *
 * @param {{ headers?: { get?: (name: string) => string | null } }} request
 * @param {{ keyHeaders: readonly string[], looksLikeKey: (value: string) => boolean }} shape
 * @returns {string | null}
 */
export function presentedKey(request, { keyHeaders, looksLikeKey }) {
  const read = (name) => {
    const value = request?.headers?.get?.(name);
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  };
  const authorization = read('authorization');
  if (authorization) {
    const bearer = /^Bearer\s+(.+)$/i.exec(authorization);
    if (bearer) return bearer[1].trim() || null;
    return looksLikeKey(authorization) ? authorization : null;
  }
  for (const name of keyHeaders) {
    const value = read(name);
    if (value) return value;
  }
  return null;
}
