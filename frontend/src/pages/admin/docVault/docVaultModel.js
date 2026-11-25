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
  return value.startsWith('/') ? isSafeAdminPath(value) : isSafeHttps(value);
}

/** "/admin" or a page under it, with no backslash or doubled slash to escape it. */
function isSafeAdminPath(value) {
  if (value !== '/admin' && !value.startsWith('/admin/')) return false;
  return !value.includes('\\') && !value.includes('//');
}

/** An https address with a host and no user name or password in it. */
function isSafeHttps(value) {
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

/** The form's checks, in order: each answers its problem, or nothing when it holds. */
const FORM_CHECKS = [
  (form) => !form.title.trim() && 'Give the document a title.',
  (form) =>
    form.title.trim().length > MAX_TITLE_CHARS &&
    `The title can be at most ${MAX_TITLE_CHARS} characters.`,
  (form) => !CATEGORIES.includes(form.category) && 'Choose a category.',
  (form) => !form.body.trim() && 'The document has no text yet.',
  (form) =>
    byteLength(form.body) > MAX_BODY_BYTES &&
    `The text is over ${MAX_BODY_BYTES / 1024} KB, the most a document can hold.`,
  (form) =>
    parseTags(form.tags).length > MAX_TAGS && `A document can have at most ${MAX_TAGS} tags.`,
  (form) =>
    parseTags(form.tags).some((tag) => tag.length > MAX_TAG_CHARS) &&
    `A tag can be at most ${MAX_TAG_CHARS} characters.`,
  (form) => {
    const link = form.relatedLink.trim();
    return (
      Boolean(link && !isSafeLink(link)) &&
      'The link must be an https address, or a page of this admin that starts with /admin/.'
    );
  },
];

/**
 * The plain-words reason the form cannot be saved yet, or null. The API checks
 * the same things again; this saves the round trip.
 */
export function formProblem(form) {
  // Stops at the first problem, in the order the form shows its fields.
  return FORM_CHECKS.reduce((found, check) => found || check(form), null) || null;
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

// The plain-text copy and the upload lines live in their own modules.
export { markdownToPlainText } from './plainText';
export { describeUploadResult, summarizeBatch } from './uploadSummary';
