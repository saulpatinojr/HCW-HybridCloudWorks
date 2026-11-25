/**
 * The inline half of "Copy as plain text": one line of Markdown without its
 * emphasis, code, link and image marks. The rules run left to right, each
 * a bounded look, so the whole stays linear in the line. Used by plainText.js.
 */
const ESCAPABLE = '\\`*_{}[]()#+-.!~>|<';
/** A link's text or address is read no further than this, so a line of '[' cannot make the scan slow. */
const LINK_SCAN = 600;

const isSpace = (char) => char === undefined || char === '' || /\s/.test(char);
const isWordChar = (char) => char !== undefined && /[\p{L}\p{N}]/u.test(char);

/**
 * Where `char` first appears at or after `from`, looking no further than
 * LINK_SCAN characters on, or -1. Not String.indexOf, which would read to the
 * end of the line from every '[' in a line made of them.
 */
function indexWithin(line, char, from) {
  const end = Math.min(line.length, from + LINK_SCAN);
  for (let i = from; i < end; i += 1) if (line[i] === char) return i;
  return -1;
}

/** `[text](address)` at `start`, as { text, url, end }, or null. A bounded look, never a search of the whole line. */
function readLink(line, start) {
  const closeText = indexWithin(line, ']', start + 1);
  if (closeText < 0 || line[closeText + 1] !== '(') return null;
  const closeUrl = indexWithin(line, ')', closeText + 2);
  if (closeUrl < 0) return null;
  const inside = line.slice(closeText + 2, closeUrl).trim();
  // `(address "title")`: the address is the first word.
  const [url] = inside.split(/\s/, 1);
  return { text: line.slice(start + 1, closeText), url, end: closeUrl + 1 };
}

/** Is the `*`, `_` or `~` run at `i`, `length` long, an emphasis marker rather than a symbol or part of a word? */
function isMarker(line, i, length) {
  const before = line[i - 1];
  const after = line[i + length];
  const char = line[i];
  if (char === '_' && isWordChar(before) && isWordChar(after)) return false;
  const opens = !isSpace(after);
  const closes = !isSpace(before);
  return opens || closes;
}

/**
 * The inline rules, tried in this order at each character. A rule answers
 * { text, end } (what to write, and where reading goes on) or null when it
 * does not apply at that character, so the loop below stays a loop and each
 * rule stays small.
 */
const keep = (text, end) => ({ text, end });

/** `\*` is a plain `*`. */
const escaped = (line, i) =>
  line[i] === '\\' && i + 1 < line.length && ESCAPABLE.includes(line[i + 1])
    ? keep(line[i + 1], i + 2)
    : null;

/** `![alt](address)` is its alt text; an image's address is of no use in plain text. */
const image = (line, i) => {
  if (line[i] !== '!' || line[i + 1] !== '[') return null;
  const found = readLink(line, i + 1);
  return found ? keep(found.text, found.end) : null;
};

/** `[text](address)` is the text and, when it adds something, the address in brackets. */
const link = (line, i) => {
  if (line[i] !== '[') return null;
  const found = readLink(line, i);
  if (!found) return null;
  const text = stripInline(found.text);
  return keep(found.url && text !== found.url ? `${text} (${found.url})` : text, found.end);
};

/** `<https://example.com>` is the address. */
const autolink = (line, i) => {
  if (line[i] !== '<' || !/^<https?:\/\/[^\s<>]{1,500}>/.test(line.slice(i, i + 510))) return null;
  const close = line.indexOf('>', i);
  return keep(line.slice(i + 1, close), close + 1);
};

/** `` `code` `` is the code. */
const code = (line, i) => {
  if (line[i] !== '`') return null;
  const close = indexWithin(line, '`', i + 1);
  return close > i ? keep(line.slice(i + 1, close), close + 1) : null;
};

/** `**bold**`, `__bold__` and `~~gone~~`: the doubled mark goes when it is a mark and not a symbol (`a ** b`). */
const doubled = (line, i) => {
  const char = line[i];
  if ((char !== '*' && char !== '_' && char !== '~') || line[i + 1] !== char) return null;
  return isMarker(line, i, 2) ? keep('', i + 2) : keep(char + char, i + 2);
};

/** `*italic*` and `_italic_`: the single mark goes when it is a mark, not a symbol or part of a word. */
const single = (line, i) =>
  (line[i] === '*' || line[i] === '_') && isMarker(line, i, 1) ? keep('', i + 1) : null;

const INLINE_RULES = [escaped, image, link, autolink, code, doubled, single];

/** One line of markdown without its inline marks: emphasis, code, links, images. */
export function stripInline(line) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    let step = null;
    for (const rule of INLINE_RULES) {
      step = rule(line, i);
      if (step) break;
    }
    out += step ? step.text : line[i];
    i = step ? step.end : i + 1;
  }
  return out;
}
