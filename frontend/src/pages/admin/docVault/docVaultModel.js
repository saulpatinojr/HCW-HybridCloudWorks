/**
 * The Doc Vault page's shared words and small pure functions (route
 * /admin/doc-vault, owner request 2026-10-26). The server half, and the rules
 * these mirror, is functions/src/lib/doc-vault/model.js; the API is the rule,
 * and this only spares a request the API would refuse.
 */

export const DOC_VAULT_ROUTE = 'cms/doc-vault';
export const UPLOAD_ROUTE = 'cms/doc-vault/upload';
export const docRoute = (id) => `${DOC_VAULT_ROUTE}/${encodeURIComponent(id)}`;
export const versionRoute = (id, version) =>
  `${docRoute(id)}/versions/${encodeURIComponent(version)}`;
export const restoreVersionRoute = (id) => `${docRoute(id)}/restore-version`;
export const untrashRoute = (id) => `${docRoute(id)}/untrash`;
export const trashListRoute = `${DOC_VAULT_ROUTE}?view=trash`;

/** The lowest role the page and every route behind it need. */
export const DOC_VAULT_MIN_ROLE = 'publisher';

/** The line that stays at the top of the page. Word for word as the owner asked. */
export const PRIVATE_BANNER =
  'Private. Only signed-in admins see this. Never shown on the public site.';

export const CATEGORIES = Object.freeze([
  'Template',
  'Application',
  'Letter',
  'Notes',
  'Reference',
  'Other',
]);
export const DEFAULT_CATEGORY = 'Other';

export const MAX_TITLE_CHARS = 200;
export const MAX_TAGS = 12;
export const MAX_TAG_CHARS = 40;
export const MAX_LINK_CHARS = 500;
export const MAX_BODY_BYTES = 256 * 1024;
/** A file: the text and room for its front matter (functions/src/lib/doc-vault/markdown.js). */
export const MAX_FILE_BYTES = MAX_BODY_BYTES + 16 * 1024;
export const KEPT_VERSIONS = 10;
/** The most documents the list returns (functions/src/lib/doc-vault/handlers.js MAX_LISTED_DOCUMENTS). */
export const LIST_LIMIT = 500;
export const TRASH_DAYS = 30;

/** What the file picker offers: the four endings the API reads. */
export const UPLOAD_ACCEPT = '.md,.markdown,.txt,.text,text/markdown,text/plain';

// ── sizes and dates ────────────────────────────────────────────────────────

/** UTF-8 size of a text, as the API counts it. */
export const byteLength = (text) => new TextEncoder().encode(String(text ?? '')).length;

/** `532 bytes`, `12.3 KB`. */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} ${n === 1 ? 'byte' : 'bytes'}`;
  const kb = n / 1024;
  return `${kb >= 100 ? Math.round(kb) : kb.toFixed(1)} KB`;
}

/** `Oct 26, 2026`, or `Oct 26, 2026, 12:03 PM` with `withTime`; '' when there is no date. */
export function formatWhen(value, { withTime = false } = {}) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  });
}

// ── the link ───────────────────────────────────────────────────────────────

/**
 * Is this a link the page may show as one: https, or a route of this admin?
 * The same rule as the API, so a stored link cannot run script when clicked.
 */
export function isSafeLink(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_LINK_CHARS) return false;
  if (/[\u0000-\u001f\u007f ]/.test(value)) return false;
  if (value.startsWith('/')) {
    if (value !== '/admin' && !value.startsWith('/admin/')) return false;
    return !value.includes('\\') && !value.includes('//');
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export const isAdminRoute = (value) => typeof value === 'string' && value.startsWith('/');

// ── the form ───────────────────────────────────────────────────────────────

export const emptyForm = (category = DEFAULT_CATEGORY) => ({
  title: '',
  category,
  tags: '',
  body: '',
  relatedLink: '',
});

/** A stored document as the form shows it: tags on one comma-separated line. */
export const formFromDocument = (doc) => ({
  title: doc.title ?? '',
  category: doc.category ?? DEFAULT_CATEGORY,
  tags: (doc.tags ?? []).join(', '),
  body: doc.body ?? '',
  relatedLink: doc.relatedLink ?? '',
});

/** The comma-separated tag line as a list: trimmed, no leading #, no repeats. */
export function parseTags(line) {
  const seen = new Set();
  const tags = [];
  for (const part of String(line ?? '').split(',')) {
    let tag = part.trim();
    while (tag.startsWith('#')) tag = tag.slice(1);
    tag = tag.trim();
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
  }
  return tags;
}

/** What the API takes: exactly the five editable fields. */
export const payloadFromForm = (form) => ({
  title: form.title.trim(),
  category: form.category,
  tags: parseTags(form.tags),
  body: form.body,
  relatedLink: form.relatedLink.trim() || null,
});

/** Has the form changed from the one it started as? */
export const isDirty = (form, original) =>
  ['title', 'category', 'tags', 'body', 'relatedLink'].some((key) => form[key] !== original[key]);

/**
 * The plain-words reason the form cannot be saved yet, or null. The API checks
 * the same things again; this saves the round trip.
 */
export function formProblem(form) {
  const title = form.title.trim();
  if (!title) return 'Give the document a title.';
  if (title.length > MAX_TITLE_CHARS)
    return `The title can be at most ${MAX_TITLE_CHARS} characters.`;
  if (!CATEGORIES.includes(form.category)) return 'Choose a category.';
  if (!form.body.trim()) return 'The document has no text yet.';
  if (byteLength(form.body) > MAX_BODY_BYTES) {
    return `The text is over ${MAX_BODY_BYTES / 1024} KB, the most a document can hold.`;
  }
  const tags = parseTags(form.tags);
  if (tags.length > MAX_TAGS) return `A document can have at most ${MAX_TAGS} tags.`;
  if (tags.some((tag) => tag.length > MAX_TAG_CHARS)) {
    return `A tag can be at most ${MAX_TAG_CHARS} characters.`;
  }
  const link = form.relatedLink.trim();
  if (link && !isSafeLink(link)) {
    return 'The link must be an https address, or a page of this admin that starts with /admin/.';
  }
  return null;
}

// ── the list ───────────────────────────────────────────────────────────────

export const EMPTY_FILTERS = Object.freeze({ q: '', category: '', tag: '' });

/** The documents that match the search words, category and tag; all three may be empty. */
export function filterDocuments(documents, { q = '', category = '', tag = '' } = {}) {
  const words = q.trim().toLowerCase();
  const wantedTag = tag.trim().toLowerCase();
  return documents.filter((doc) => {
    if (category && doc.category !== category) return false;
    if (wantedTag && !(doc.tags ?? []).some((t) => t.toLowerCase() === wantedTag)) return false;
    if (!words) return true;
    return [doc.title, doc.category, ...(doc.tags ?? [])].some((text) =>
      String(text ?? '')
        .toLowerCase()
        .includes(words)
    );
  });
}

export const anyFilter = (filters) => Boolean(filters.q.trim() || filters.category || filters.tag);

// ── copy as plain text ─────────────────────────────────────────────────────

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
function stripInline(line) {
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

const isRule = (trimmed) => {
  if (trimmed.length < 3) return false;
  const [first] = trimmed;
  if (first !== '-' && first !== '*' && first !== '_') return false;
  return [...trimmed].every((char) => char === first || char === ' ');
};

/** The heading marks, quote marks and list bullet at the start of a line, as plain text. */
function stripBlock(line) {
  let text = line.trimStart();
  const indent = line.slice(0, line.length - text.length);
  let hashes = 0;
  while (hashes < 6 && text[hashes] === '#') hashes += 1;
  if (hashes > 0 && (text[hashes] === ' ' || text[hashes] === '\t')) {
    text = text.slice(hashes).trim();
    let end = text.length;
    while (end > 0 && text[end - 1] === '#') end -= 1;
    // A closing run of # counts only after a space: "C#" keeps its #.
    if (end < text.length && (end === 0 || text[end - 1] === ' '))
      text = text.slice(0, end).trimEnd();
    return text;
  }
  if (text.startsWith('>')) {
    while (text.startsWith('>')) text = text.slice(text[1] === ' ' ? 2 : 1);
    return text;
  }
  // A bullet keeps its indent, so a nested list stays nested.
  if (/^[-*+] /.test(text)) return `${indent}- ${text.slice(2)}`;
  return line;
}

/** ``` or ~~~ when the line opens or closes a fenced code block, else null. */
function fenceMarker(trimmed) {
  if (trimmed.startsWith('```')) return '```';
  return trimmed.startsWith('~~~') ? '~~~' : null;
}

/**
 * Markdown as the plain text a person would have typed: no heading marks,
 * emphasis marks, code ticks or link syntax (a link keeps its address in
 * brackets after its words), lists kept as "- " lines, code blocks kept as
 * written. For pasting into a form or an email, where the marks would show.
 * Linear in the text; never throws.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function markdownToPlainText(markdown) {
  const lines = String(markdown ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const out = [];
  let fence = null;
  for (const raw of lines) {
    const trimmed = raw.trim();
    const marker = fenceMarker(trimmed);
    if (fence) {
      if (marker === fence) fence = null;
      else out.push(raw);
    } else if (marker) {
      fence = marker;
    } else if (isRule(trimmed)) {
      out.push('');
    } else {
      out.push(stripInline(stripBlock(raw)).trimEnd());
    }
  }
  const squeezed = [];
  for (const line of out) {
    if (line === '' && squeezed[squeezed.length - 1] === '') continue;
    squeezed.push(line);
  }
  return squeezed.join('\n').trim();
}

// ── uploads ────────────────────────────────────────────────────────────────

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * One line of the result list for one file (or the pasted text): `answer` is
 * what the API said, or `error` is what went wrong. Plain words, no codes.
 *
 * @param {string} name
 * @param {{ answer?: object, error?: Error }} outcome
 * @returns {{ name: string, kind: 'created'|'versioned'|'unchanged'|'restored'|'failed',
 *   tone: 'ok'|'skip'|'bad', text: string, warnings: string[] }}
 */
export function describeUploadResult(name, { answer, error } = {}) {
  if (error) {
    return {
      name,
      kind: 'failed',
      tone: 'bad',
      text: `Not added: ${error.message || 'something went wrong; nothing was saved.'}`,
      warnings: [],
    };
  }
  const warnings = Array.isArray(answer?.warnings) ? answer.warnings : [];
  const doc = answer?.document;
  const where = doc?.category ? ` in ${doc.category}` : '';
  switch (answer?.outcome) {
    case 'created':
      return {
        name,
        kind: 'created',
        tone: 'ok',
        text: `Added as a new document${where}`,
        warnings,
      };
    case 'versioned':
      return {
        name,
        kind: 'versioned',
        tone: 'ok',
        text: `Saved as version ${doc?.version ?? 'next'} of a document already here${where}`,
        warnings,
      };
    case 'unchanged':
      return {
        name,
        kind: 'unchanged',
        tone: 'skip',
        text: 'Already here with exactly this text; nothing changed',
        warnings,
      };
    case 'restored':
      return {
        name,
        kind: 'restored',
        tone: 'ok',
        text: 'Brought back from Trash; the text was the same',
        warnings,
      };
    default:
      return {
        name,
        kind: 'failed',
        tone: 'bad',
        text: 'Not added: the answer was not one this page understands; nothing was changed.',
        warnings: [],
      };
  }
}

/** The one line under a finished batch: "3 files: 1 added, 1 new version, 1 not added." */
export function summarizeBatch(lines, noun = 'file') {
  const count = (kind) => lines.filter((line) => line.kind === kind).length;
  const added = count('created') + count('restored');
  const versions = count('versioned');
  const unchanged = count('unchanged');
  const failed = count('failed');
  const parts = [
    `${added} added`,
    `${plural(versions, 'new version', 'new versions')}`,
    `${unchanged} already here`,
    `${failed} not added`,
  ];
  return `${plural(lines.length, noun, `${noun}s`)}: ${parts.join(', ')}.`;
}
