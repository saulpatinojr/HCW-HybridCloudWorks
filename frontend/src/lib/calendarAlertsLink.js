/**
 * Which alert links the portal will open. Pure, with no imports, so the
 * calendar file builder can use it without reaching the API client.
 */

/**
 * The link as the browser may open it, or null. Checked again here, though
 * the server only stores these two shapes, because the row is a document a
 * person with database access could have edited: an https address opens in a
 * new tab, a path inside /admin opens in the portal, anything else is not
 * offered.
 *
 * @returns {{ kind: 'external' | 'admin', href: string, host?: string } | null}
 */
export function safeAlertLink(link) {
  if (typeof link !== 'string' || link === '') return null;
  // Printable ASCII only: an address with a space, a control character or a
  // line separator in it is refused, never repaired.
  if (/[^\x21-\x7E]/.test(link) || /[<>"'`\\]/.test(link)) return null;
  if (link.startsWith('/')) {
    const [path] = link.split('?');
    const inside = /^\/admin(?:\/[A-Za-z0-9._~-]+)*\/?$/.test(path);
    const query = link.includes('?')
      ? /^\?[A-Za-z0-9._~%=&-]*$/.test(link.slice(path.length))
      : true;
    const segments = path.split('/');
    // The OAuth callback acts on its query (code, state): an alert may not aim at it.
    const safe = inside && query && !segments.includes('..') && !segments.includes('oauth');
    return safe ? { kind: 'admin', href: link } : null;
  }
  try {
    const url = new URL(link);
    if (url.protocol === 'https:' && url.username === '' && url.password === '') {
      // `host` is what the button shows, so where it goes is read before it is pressed.
      return { kind: 'external', href: url.href, host: url.hostname.replace(/^www\./, '') };
    }
  } catch {
    // not an address
  }
  return null;
}
