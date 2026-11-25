/**
 * A URL that is safe to put in an `href` or `src`.
 *
 * WHY THIS EXISTS. CodeQL raised 27 high-severity "DOM text reinterpreted as
 * HTML" alerts on 2026-08-30, every one of them a `href={...}` or `src={...}`
 * fed from content data. They appeared when pre-render hydration (T-714) gave
 * the analyzer a source it could follow — the seed, then read from a
 * `<script id="__PRERENDER_DATA__">` island with `.textContent` — through
 * usePublicData and into those attributes.
 *
 * THE ALERTS ARE NEW; THE WEAKNESS IS NOT. The same values previously arrived
 * from `fetch()` of the public API and reached the same attributes unchecked.
 * Hydration did not create the hole, it made it traceable. A `javascript:` URL
 * in a feed link or a curated article executes on click either way, and the
 * data behind these fields is scraped and author-supplied rather than
 * constant.
 *
 * THIS IS NOT WHAT SILENCED THE ALERTS, and it was never going to be: CodeQL
 * has no way to know a wrapper returning its own argument validated anything,
 * so the taint ran straight through `safeUrl` to the same sinks. The alerts
 * ended when the seed stopped being read from an id-addressed island (see
 * `readSeed` in src/main.jsx). This stays because the sinks are worth guarding
 * on their own terms, from the API path as much as the seed path.
 *
 * ALLOWED: http, https, mailto, and relative references (`/x`, `#x`, `?x`).
 *
 * A LEADING SLASH IS NOT A PROMISE OF SAME ORIGIN. `//evil.example` is a
 * relative reference by the URL grammar and is returned unchanged — correctly,
 * since it navigates over https — but it leaves this site. A caller deciding
 * "internal or external" from the returned string must exclude `//` (see
 * EpisodePlayer and the admin platform-settings page), or a value from a feed
 * becomes a same-tab cross-origin navigation with no `rel="noopener"`.
 * REFUSED: `javascript:`, `data:`, `vbscript:`, `file:`, and anything else.
 * `data:` is refused deliberately even for images — nothing in this app serves
 * one, and permitting it reopens the sink for SVG payloads.
 */
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** Used only to resolve relative references while parsing. Never emitted. */
const PARSE_BASE = 'https://hybridcloudworks.com';

/** Highest code point treated as whitespace or control (U+0020 is space). */
const HIGHEST_CONTROL_CODE = 0x20;

/**
 * Any whitespace or control character, anywhere in the value.
 *
 * The URL parser strips these before deciding the protocol, so a tab placed
 * inside the word "javascript" still parses as `javascript:` and still
 * executes, while reading as safe to any check looking for the literal prefix.
 * Refusing them outright removes the need for that equivalence to hold. No
 * legitimate URL in this application contains one.
 *
 * Written as a code-point scan rather than a regular expression character
 * class so the source file contains no literal control characters of its own.
 */
function hasControlOrSpace(value) {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) <= HIGHEST_CONTROL_CODE) return true;
  }
  return false;
}

/**
 * @param {unknown} value candidate URL, typically from content data
 * @param {string} [fallback] returned when the value is unsafe or absent
 * @returns {string|undefined} the ORIGINAL string when safe, else the fallback
 */
export function safeUrl(value, fallback = undefined) {
  if (typeof value !== 'string') return fallback;

  const trimmed = value.trim();
  if (!trimmed || hasControlOrSpace(trimmed)) return fallback;

  // Relative references carry no protocol and cannot introduce one.
  if (/^[/#?]/.test(trimmed)) return trimmed;

  try {
    const parsed = new URL(trimmed, PARSE_BASE);
    return SAFE_PROTOCOLS.has(parsed.protocol) ? trimmed : fallback;
  } catch {
    return fallback;
  }
}

export default safeUrl;
