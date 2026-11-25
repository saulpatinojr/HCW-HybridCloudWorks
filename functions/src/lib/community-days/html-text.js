/**
 * html-text.js — the two steps that turn an event page's HTML into plain
 * text: take the tags out, then decode the few common entities; and the cut
 * to a number of bytes. Used by htmlToText in events.js (which re-exports
 * cutToBytes), which says what the text is for and how long it may be.
 */

const ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' });

/** Tags whose contents are code or styling, never words for a reader. */
const UNSEEN_TAGS = Object.freeze(['script', 'style']);

/**
 * The text of `html` with its tags taken out.
 *
 * A `<` starts a tag only when a letter, `/`, `!` or `?` follows it and a `>`
 * closes it later, which is how a browser reads it. Any other `<` ("a < b",
 * or one with no `>` after it) is kept as the character it is, so the words
 * after it are not lost. The contents of `<script>` and `<style>` are dropped
 * with their tags, and so is a comment.
 */
export function stripTags(html) {
  // Once a search finds no `>` there is none further on either; remembering
  // that (`noMoreClosers`) keeps a page of bare `<` characters from being
  // searched again each time.
  const scan = { html, lower: html.toLowerCase(), noMoreClosers: false };
  let out = '';
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf('<', at);
    if (open === -1) {
      out += html.slice(at);
      break;
    }
    out += html.slice(at, open);
    const step = afterAngle(scan, open);
    out += step.text;
    at = step.at;
  }
  return out;
}

/** What a `<` at `open` leaves in the text, and where reading goes on. */
function afterAngle(scan, open) {
  const close = scan.noMoreClosers ? -1 : scan.html.indexOf('>', open + 1);
  if (close === -1) scan.noMoreClosers = true;
  if (close === -1 || !/[a-z/!?]/.test(scan.lower[open + 1] ?? '')) {
    return { text: '<', at: open + 1 };
  }
  // A tag ends a word, so it leaves a space behind.
  return { text: ' ', at: tagEnd(scan, open, close) };
}

/** Where reading goes on after the tag that opens at `open` and closes at `close`. */
function tagEnd({ html, lower }, open, close) {
  if (lower.startsWith('<!--', open)) {
    const end = lower.indexOf('-->', open + 4);
    return end === -1 ? html.length : end + 3;
  }
  const name = /^<([a-z]+)/.exec(lower.slice(open, open + 12))?.[1];
  if (UNSEEN_TAGS.includes(name)) {
    // Everything up to the matching end tag is dropped; with no end tag,
    // the rest is, as a browser would treat it.
    const end = lower.indexOf(`</${name}`, close + 1);
    const endClose = end === -1 ? -1 : lower.indexOf('>', end);
    return endClose === -1 ? html.length : endClose + 1;
  }
  return close + 1;
}

/** The few common named entities, and numeric ones, decoded once. */
export function decodeEntities(value) {
  return value.replace(/&(#\d{1,6}|#x[0-9a-f]{1,5}|[a-z]{2,6});/gi, (whole, name) => {
    const key = name.toLowerCase();
    if (Object.hasOwn(ENTITIES, key)) return ENTITIES[key];
    if (key.startsWith('#')) return numericEntity(key);
    return whole;
  });
}

function numericEntity(key) {
  const code = key[1] === 'x' ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10);
  // A decoded angle bracket stays text: nothing downstream reads this as HTML.
  return Number.isInteger(code) && code >= 32 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
}

/**
 * `value` cut to at most `maxBytes` bytes of UTF-8, never in the middle of a
 * character.
 *
 * @param {string} value
 * @param {number} maxBytes
 * @returns {string}
 */
export function cutToBytes(value, maxBytes) {
  if (typeof value !== 'string' || maxBytes <= 0) return '';
  // No character is more than three bytes per UTF-16 unit, so short text needs no count.
  if (value.length * 3 <= maxBytes) return value;
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const code = char.codePointAt(0);
    let size = 4;
    if (code < 0x80) size = 1;
    else if (code < 0x800) size = 2;
    else if (code < 0x10000) size = 3;
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return value.slice(0, end).trimEnd();
}
