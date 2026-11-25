/**
 * doc-vault/fields.js — what a Doc Vault document may contain (see
 * doc-vault/model.js's header): the categories and limits, and the check of
 * each field a person can set. Pure; nothing here does I/O or logs.
 * model.js re-exports all of it, so callers keep one import.
 */
import {
  CATEGORIES,
  MAX_BODY_BYTES,
  MAX_TITLE_CHARS,
  fail,
  hasControlCharacter,
} from './limits.js';
import { readLink, readTags } from './tags-links.js';

/**
 * A title as a key: Unicode-folded, accents on Latin letters removed, lower
 * case, every run of anything that is not a letter or digit one space. Unlike
 * the draft dedup gate's normalizeTitleForDedup this keeps letters outside
 * A-Z, so a title in another script is still told apart rather than folding
 * to nothing.
 *
 * @param {string} title
 * @returns {string} '' when the title holds no letter or digit
 */
export function normalizeVaultTitle(title) {
  return String(title ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]+/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// ── fields ─────────────────────────────────────────────────────────────────

/** The fields a person can set on a document. Nothing else is read from a request. */
export const EDITABLE_FIELDS = Object.freeze(['title', 'category', 'tags', 'body', 'relatedLink']);

/** The category named, in the spelling the list uses, or null. Case does not matter. */
export function canonicalCategory(value) {
  const wanted = String(value ?? '')
    .trim()
    .toLowerCase();
  return CATEGORIES.find((category) => category.toLowerCase() === wanted) ?? null;
}

/** UTF-8 size of a text. */
export const byteLength = (text) => Buffer.byteLength(text, 'utf8');

/**
 * Line endings as LF and no byte-order mark, so the same text copied from a
 * Windows file and from the page is the same text. Linear: one scan, no
 * backtracking.
 */
export function normalizeText(text) {
  let source = String(text ?? '');
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  return source.includes('\r') ? source.replace(/\r\n?/g, '\n') : source;
}

/**
 * The editable fields of a request, checked. An unknown key is refused rather
 * than ignored, so a request that tries to set `id`, `version`, `createdBy`,
 * `deletedAt`, `docType`, `contentStatus` or `Live` is a 400, not a quiet
 * success. The result is a new object built from the five known names: the
 * request's own object (and any `__proto__` key in it) is never copied.
 *
 * @param {unknown} input
 * @returns {{ title: string, category: string, tags: string[], body: string, relatedLink: string|null }}
 * @throws {DocVaultInputError}
 */
export function validateFields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('fields is required: the title, category, tags, body and link of the document.');
  }
  for (const key of Object.keys(input)) {
    if (!EDITABLE_FIELDS.includes(key)) {
      // The key is not echoed: a refusal never repeats what it was sent.
      fail(`The request has a field a document does not have. Send only ${EDITABLE_FIELDS.join(', ')}.`);
    }
  }

  const rawTitle = input.title;
  if (typeof rawTitle !== 'string') fail('title is required.');
  const title = rawTitle.replace(/\s+/g, ' ').trim();
  if (!title) fail('title is required.');
  if (title.length > MAX_TITLE_CHARS) fail(`The title can be at most ${MAX_TITLE_CHARS} characters.`);
  if (hasControlCharacter(title, { allowLayout: false })) fail('The title cannot hold control characters.');
  if (!normalizeVaultTitle(title)) fail('The title needs at least one letter or digit.');

  const category = canonicalCategory(input.category);
  if (!category) fail(`category must be one of: ${CATEGORIES.join(', ')}.`);

  if (typeof input.body !== 'string') fail('body is required: the text of the document.');
  const body = normalizeText(input.body);
  if (!body.trim()) fail('body is required: the text of the document.');
  if (hasControlCharacter(body, { allowLayout: true })) {
    fail('The text holds control characters, so it is not plain text or markdown.');
  }
  if (byteLength(body) > MAX_BODY_BYTES) {
    fail(`The text is over ${MAX_BODY_BYTES / 1024} KB, the most a document can hold.`);
  }

  return {
    title,
    category,
    tags: readTags(input.tags),
    body,
    relatedLink: readLink(input.relatedLink),
  };
}

/** Is this the same text, tags, title, category and link? Used to avoid a version that changes nothing. */
export function sameContent(stored, fields) {
  const sameText = stored.title === fields.title && stored.category === fields.category && stored.body === fields.body;
  return sameText && sameLinkAndTags(stored, fields);
}

const sameLinkAndTags = (stored, fields) =>
  (stored.relatedLink ?? null) === (fields.relatedLink ?? null) &&
  JSON.stringify(stored.tags ?? []) === JSON.stringify(fields.tags);
