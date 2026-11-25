/**
 * doc-vault/front-matter.js — the front-matter block at the top of an
 * uploaded file (doc-vault/markdown.js): `key: value` lines, and Obsidian's
 * `key:` followed by `- item` lines, read into a Map.
 *
 * LINEAR TIME, as markdown.js's header explains: the text is split into
 * lines once and walked; the only pattern is anchored, one quantifier, over
 * a single character class, so none can backtrack.
 */

/** The block must close within this many lines, or the file is read as text from the top. */
const MAX_FRONT_MATTER_LINES = 200;
const MAX_VALUE_CHARS = 2000;

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

const isQuote = (char) => char === '"' || char === "'";

/** `"a b"` → `a b`; an unquoted value loses a trailing ` # comment` and its edges. */
function readScalar(raw) {
  const value = raw.trim();
  if (isQuote(value[0])) {
    const close = value.indexOf(value[0], 1);
    if (close > 0) return value.slice(1, close);
  }
  const comment = value.indexOf(' #');
  const unquoted = (comment >= 0 ? value.slice(0, comment) : value).trim();
  let start = 0;
  let end = unquoted.length;
  while (start < end && isQuote(unquoted[start])) start += 1;
  while (end > start && isQuote(unquoted[end - 1])) end -= 1;
  return unquoted.slice(start, end);
}

/** `[a, b]` or `a, b` → ['a', 'b'] (unquoted), uncleaned beyond that. */
export function readInlineList(raw) {
  const value = raw.trim();
  const inner = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  return inner.split(',').map((item) => readScalar(item));
}

/** The index of the line that closes the block (`---` or `...`), or -1 when none does within the limit. */
function closingLine(lines) {
  const limit = Math.min(lines.length, MAX_FRONT_MATTER_LINES);
  for (let i = 1; i < limit; i += 1) {
    const line = lines[i].trimEnd();
    if (line === '---' || line === '...') return i;
  }
  return -1;
}

/** The `- item` lines from `start`, up to the close: Obsidian's list form. Answers the items and where they end. */
function listItems(lines, start, close) {
  const items = [];
  let j = start;
  while (j < close) {
    const item = lines[j].trimStart();
    if (item !== '-' && !item.startsWith('- ')) break;
    items.push(readScalar(item.slice(1)));
    j += 1;
  }
  return { items, end: j };
}

/** The lower-cased key a front-matter line sets, or null when the line sets none. */
function keyOf(line) {
  const colon = line.indexOf(':');
  const key = colon > 0 ? line.slice(0, colon) : '';
  return KEY_PATTERN.test(key) ? { name: key.toLowerCase(), rest: line.slice(colon + 1).trim() } : null;
}

/**
 * Read the entry that starts at line `i` into `meta` (the first value of a
 * key wins) and answer the line after it.
 */
function readEntry(lines, i, close, meta) {
  const entry = keyOf(lines[i]);
  if (!entry) return i + 1;
  if (entry.rest) {
    if (!meta.has(entry.name)) meta.set(entry.name, readScalar(entry.rest).slice(0, MAX_VALUE_CHARS));
    return i + 1;
  }
  // `key:` with nothing after it, then `- item` lines: Obsidian's list form.
  const { items, end } = listItems(lines, i + 1, close);
  if (items.length && !meta.has(entry.name)) meta.set(entry.name, items);
  return end > i + 1 ? end : i + 1;
}

/**
 * The front-matter block of already-normalised text, and the lines after it.
 * `meta` is a Map of lower-cased key → string, or string[] for a key written
 * as a list.
 *
 * @param {string[]} lines
 * @returns {{ meta: Map<string, string|string[]>, bodyStart: number, unclosed: boolean }}
 */
export function readFrontMatter(lines) {
  const none = { meta: new Map(), bodyStart: 0, unclosed: false };
  if (lines[0]?.trimEnd() !== '---') return none;
  const close = closingLine(lines);
  if (close < 0) return { ...none, unclosed: true };

  const meta = new Map();
  let i = 1;
  while (i < close) i = readEntry(lines, i, close, meta);
  return { meta, bodyStart: close + 1, unclosed: false };
}
