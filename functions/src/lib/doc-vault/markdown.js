/**
 * doc-vault/markdown.js — the pure half of "Upload files" on /admin/doc-vault:
 * one markdown or text file → the fields of a document.
 *
 * A file may open with a front-matter block between two `---` lines, as the
 * owner's Obsidian notes and docs/content articles do. Four keys are read:
 * `title`, `category`, `tags` (a list in brackets, a comma-separated line, or
 * Obsidian's one-per-line `- item` form) and `link` (also `url`, `related`).
 * Every other key is left out and named in a warning, so nothing is lost
 * without being said. A file with no front matter is all text: the title comes
 * from its first `# heading`, else from the file name.
 *
 * The result is built from those four names and nothing else. A key such as
 * `id`, `slug`, `version`, `createdBy`, `deletedAt`, `docType`, `partitionKey`,
 * `contentStatus`, `Live` or `__proto__` in the front matter is only ever a
 * name in the "not kept" warning; it cannot reach a stored field. The block is
 * read into a Map, never an object, so a key cannot touch a prototype either.
 *
 * LINEAR TIME. The parser before this one (repo-draft.js, for articles) had
 * quadratic regular expressions. This one splits the text into lines once and
 * walks them; the only patterns are anchored, one quantifier, over a single
 * character class, so none can backtrack. The test file feeds it long runs of
 * spaces, quotes, dashes and colons and holds the time to a growth ratio.
 *
 * Nothing here does I/O and nothing here logs the text.
 */
import {
  DEFAULT_CATEGORY,
  MAX_BODY_BYTES,
  MAX_TAGS,
  MAX_TAG_CHARS,
  MAX_TITLE_CHARS,
  byteLength,
  canonicalCategory,
  cleanTag,
  isSafeLink,
  normalizeText,
  validateFields,
} from './model.js';
import { authoredMessage, isAuthoredError } from '../http/error-response.js';

/** Room for the front matter on top of the body cap. */
export const FRONT_MATTER_ALLOWANCE_BYTES = 16 * 1024;
/** The most a file can be: the body cap and the front matter. */
export const MAX_FILE_BYTES = MAX_BODY_BYTES + FRONT_MATTER_ALLOWANCE_BYTES;

/** What the file name must end in. A Word or PDF file is not text and is refused up front. */
export const FILE_EXTENSIONS = Object.freeze(['.md', '.markdown', '.txt', '.text']);
const MAX_FILENAME_CHARS = 255;
/** The block must close within this many lines, or the file is read as text from the top. */
const MAX_FRONT_MATTER_LINES = 200;
const MAX_VALUE_CHARS = 2000;
const MAX_NAMED_KEYS = 5;

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

const refuse = (status, code, error) => ({ ok: false, status, code, error });

/**
 * The file name's stem and whether its extension is one we read. Only the
 * last path segment counts: a browser sends a bare name, but the route does
 * not trust that.
 */
export function describeFilename(filename) {
  if (typeof filename !== 'string') return null;
  const base = filename.split(/[\\/]/).pop().trim();
  if (!base || base.length > MAX_FILENAME_CHARS) return null;
  for (let i = 0; i < base.length; i += 1) {
    if (base.charCodeAt(i) < 32) return null;
  }
  const dot = base.lastIndexOf('.');
  const extension = dot > 0 ? base.slice(dot).toLowerCase() : '';
  if (!FILE_EXTENSIONS.includes(extension)) return null;
  return { stem: base.slice(0, dot).trim() };
}

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
function readInlineList(raw) {
  const value = raw.trim();
  const inner = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  return inner.split(',').map((item) => readScalar(item));
}

/**
 * The front-matter block of already-normalised text, and the lines after it.
 * `meta` is a Map of lower-cased key → string, or string[] for a key written
 * as a list.
 *
 * @param {string[]} lines
 * @returns {{ meta: Map<string, string|string[]>, bodyStart: number, unclosed: boolean }}
 */
function readFrontMatter(lines) {
  const none = { meta: new Map(), bodyStart: 0, unclosed: false };
  if (lines[0]?.trimEnd() !== '---') return none;
  const limit = Math.min(lines.length, MAX_FRONT_MATTER_LINES);
  let close = -1;
  for (let i = 1; i < limit; i += 1) {
    const line = lines[i].trimEnd();
    if (line === '---' || line === '...') {
      close = i;
      break;
    }
  }
  if (close < 0) return { ...none, unclosed: true };

  const meta = new Map();
  let i = 1;
  while (i < close) {
    const line = lines[i];
    const colon = line.indexOf(':');
    const key = colon > 0 ? line.slice(0, colon) : '';
    if (!KEY_PATTERN.test(key)) {
      i += 1;
      continue;
    }
    const name = key.toLowerCase();
    const rest = line.slice(colon + 1).trim();
    if (rest) {
      if (!meta.has(name)) meta.set(name, readScalar(rest).slice(0, MAX_VALUE_CHARS));
      i += 1;
      continue;
    }
    // `key:` with nothing after it, then `- item` lines: Obsidian's list form.
    const items = [];
    let j = i + 1;
    while (j < close) {
      const item = lines[j].trimStart();
      if (item === '-' || item.startsWith('- ')) {
        items.push(readScalar(item.slice(1)));
        j += 1;
      } else {
        break;
      }
    }
    if (items.length && !meta.has(name)) meta.set(name, items);
    i = j > i + 1 ? j : i + 1;
  }
  return { meta, bodyStart: close + 1, unclosed: false };
}

const TITLE_KEYS = ['title'];
const CATEGORY_KEYS = ['category'];
const TAG_KEYS = ['tags', 'tag'];
const LINK_KEYS = ['link', 'url', 'related'];
const KNOWN_KEYS = new Set([...TITLE_KEYS, ...CATEGORY_KEYS, ...TAG_KEYS, ...LINK_KEYS]);

const firstOf = (meta, keys) => {
  for (const key of keys) if (meta.has(key)) return meta.get(key);
  return undefined;
};

const asText = (value) => (Array.isArray(value) ? value.join(', ') : String(value ?? ''));

/** The first non-empty line of the text, when it is a level-1 markdown heading. */
function firstHeading(lines, start) {
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (!line.startsWith('# ')) return null;
    let end = line.length;
    while (end > 2 && line[end - 1] === '#') end -= 1;
    return line.slice(2, end).trim() || null;
  }
  return null;
}

/** Key names worth naming in a warning: short, and only characters a key can have. */
function ignoredKeys(meta) {
  return [...meta.keys()].filter((key) => !KNOWN_KEYS.has(key)).map((key) => key.slice(0, 40));
}

/**
 * One file → the fields of a document, plus anything said about the way.
 * Pure. Never throws.
 *
 * @param {{ filename: unknown, text: unknown, defaultCategory?: unknown }} file
 * @returns {{ ok: true, fields: object, warnings: string[], titleFrom: string }
 *   | { ok: false, status: number, code: string, error: string }}
 */
export function parseVaultFile({ filename, text, defaultCategory }) {
  const named = describeFilename(filename);
  if (!named) {
    return refuse(
      400,
      'BAD_FILENAME',
      `Only text files are read here: a name ending in ${FILE_EXTENSIONS.join(', ')}. A Word or PDF file needs its text pasted in instead.`
    );
  }
  if (typeof text !== 'string') {
    return refuse(400, 'INVALID', 'text is required: the whole text of the file.');
  }
  if (byteLength(text) > MAX_FILE_BYTES) {
    return refuse(
      413,
      'TOO_LARGE',
      `That file is too large (at most about ${Math.round(MAX_FILE_BYTES / 1024)} KB: a ${MAX_BODY_BYTES / 1024} KB document and its front matter). Nothing was saved.`
    );
  }
  if (text.includes('\u0000')) {
    return refuse(422, 'NOT_TEXT', 'The file holds binary data, not text. Nothing was saved.');
  }

  const warnings = [];
  const unchosen = defaultCategory === undefined || defaultCategory === null || defaultCategory === '';
  const fallback = unchosen ? DEFAULT_CATEGORY : canonicalCategory(defaultCategory);
  if (!fallback) {
    return refuse(400, 'INVALID', 'The category chosen for the files is not one the Doc Vault has.');
  }

  const lines = normalizeText(text).split('\n');
  const { meta, bodyStart, unclosed } = readFrontMatter(lines);
  if (unclosed) {
    warnings.push('The file opens with --- but the front-matter block never closes, so all of it was kept as text.');
  }
  const bodyLines = lines.slice(bodyStart);
  while (bodyLines.length && !bodyLines[0].trim()) bodyLines.shift();
  const body = bodyLines.join('\n').trimEnd();
  if (!body.trim()) {
    return refuse(422, 'EMPTY_BODY', 'The file has no text to keep (only front matter, or nothing).');
  }

  // Title: front matter, else the first heading, else the file name.
  let title = asText(firstOf(meta, TITLE_KEYS)).trim();
  let titleFrom = 'front matter';
  if (!title) {
    title = firstHeading(bodyLines, 0) ?? '';
    titleFrom = 'heading';
  }
  if (!title) {
    title = named.stem;
    titleFrom = 'file name';
  }
  if (title.length > MAX_TITLE_CHARS) {
    return refuse(422, 'TITLE_TOO_LONG', `The title is ${title.length} characters; at most ${MAX_TITLE_CHARS}.`);
  }

  // Category: front matter if it names one we have, else the one chosen for the batch.
  let category = fallback;
  const wanted = asText(firstOf(meta, CATEGORY_KEYS)).trim();
  if (wanted) {
    const match = canonicalCategory(wanted);
    if (match) category = match;
    else warnings.push(`The category in the file is not one the Doc Vault has, so it was filed as ${fallback}.`);
  }

  // Tags: lenient, because a vault note can carry far more than a document may.
  const rawTags = firstOf(meta, TAG_KEYS);
  const tags = [];
  if (rawTags !== undefined) {
    const seen = new Set();
    const list = Array.isArray(rawTags) ? rawTags : readInlineList(rawTags);
    let shortened = false;
    let dropped = false;
    for (const item of list) {
      let tag = cleanTag(item);
      if (!tag) continue;
      if (tag.length > MAX_TAG_CHARS) {
        tag = tag.slice(0, MAX_TAG_CHARS).trim();
        shortened = true;
      }
      const folded = tag.toLowerCase();
      if (seen.has(folded)) continue;
      seen.add(folded);
      if (tags.length < MAX_TAGS) tags.push(tag);
      else dropped = true;
    }
    if (dropped) warnings.push(`Only the first ${MAX_TAGS} tags were kept.`);
    if (shortened) warnings.push(`A tag was shortened to ${MAX_TAG_CHARS} characters.`);
  }

  // Link: kept only when the page could show it safely.
  let relatedLink = null;
  const rawLink = asText(firstOf(meta, LINK_KEYS)).trim();
  if (rawLink) {
    if (isSafeLink(rawLink)) relatedLink = rawLink;
    else warnings.push('The link in the file is not an https address or an /admin page, so it was left out.');
  }

  const left = ignoredKeys(meta);
  if (left.length) {
    const shown = left.slice(0, MAX_NAMED_KEYS).join(', ');
    const more = left.length > MAX_NAMED_KEYS ? ` and ${left.length - MAX_NAMED_KEYS} more` : '';
    warnings.push(`Front matter not kept: ${shown}${more}. Only title, category, tags and link are read.`);
  }

  try {
    const fields = validateFields({ title, category, tags, body, relatedLink });
    return { ok: true, fields, warnings, titleFrom };
  } catch (error) {
    if (isAuthoredError(error)) {
      return refuse(422, 'INVALID', authoredMessage(error, 'The file could not be read as a document.'));
    }
    throw error;
  }
}
