/**
 * doc-vault/model.js — the pure half of the Doc Vault, /admin/doc-vault
 * (owner request 2026-10-26): the owner's own templates, pasted applications,
 * letters and notes, kept in the site and never shown on it.
 *
 * Nothing here does I/O and nothing here logs. The routes and the store are
 * ./handlers.js; reading an uploaded file is ./markdown.js. This module decides
 * what a document may contain, how one is told apart from another, and the
 * three shapes it takes: the stored document, the list row (no text) and the
 * view (with text).
 *
 * NOT THE AMBASSADOR EVIDENCE TAB. Evidence (lib/ambassador) is proof of a
 * contribution to a programme: a talk, a certification, an article, linked to
 * the requirements of one programme. The Doc Vault is the owner's own
 * writing, for reuse: a cover-letter template, an application pasted in whole,
 * a letter. The two share no container, no route and no code beyond the Cosmos
 * client and the audit helper.
 *
 * WHERE IT LIVES. Its own Cosmos container, `doc_vault`, and no other. Every
 * public read in this repository (public-reads.js, public-preview.js,
 * public-content-manifest.js, the pre-render, the sitemap, the search index)
 * reads named containers (content, blogs, listen_and_learn and so on), none of
 * which is this one, and doc-vault.no-leak.test.js fails when any module
 * outside the Doc Vault's own files so much as names the container. A
 * document here also carries no field a public read keys on (no Live, no
 * contentStatus, no slug): the second lock, so a document copied into a
 * public container by mistake would still not be served.
 *
 * TWO KINDS OF DOCUMENT, ONE CONTAINER. `docType: 'document'` is the current
 * version of a document; `docType: 'version'` is an earlier one, kept so it can
 * be restored. They are separate items because a document can be 256 KB and
 * Cosmos items stop at 2 MB: ten versions in one item would not fit.
 *
 * ONE DOCUMENT, ONE KEY. A document is told apart by its category and its
 * title, folded (case, accents, punctuation and spacing do not matter). Adding
 * a document whose key is already here does not make a second copy: it becomes
 * the next version of the first (handlers.js saveDocument). The key is stored
 * (`dedupeKey`) so a document renamed on the page is found under its new name.
 */
import { createHash } from 'node:crypto';
import { AuthoredError } from '../http/error-response.js';

export const CONTAINER = 'doc_vault';

/**
 * The lowest role that may use any Doc Vault route.
 *
 * Publisher, because these are private personal documents (letters,
 * applications, notes), not content for the site:
 *   - viewer is the read-only monitoring role; it should not see private
 *     writing at all.
 *   - editor is the role the site's collaborators hold to write and review
 *     articles. It is what an invited co-author gets, and it has no need of
 *     the owner's private letters.
 *   - publisher is the first role that is trusted to put things in front of
 *     the public, which is the right bar for the place where the things that
 *     must never go public are kept; super_admin passes it too.
 * One role for every route, reads included: a read of a private letter is as
 * sensitive as a write of one.
 */
export const DOC_VAULT_ROLE = 'publisher';

export const CATEGORIES = Object.freeze([
  'Template',
  'Application',
  'Letter',
  'Notes',
  'Reference',
  'Other',
]);
export const DEFAULT_CATEGORY = 'Other';

export const DOC_TYPES = Object.freeze({ document: 'document', version: 'version' });
export const SOURCES = Object.freeze({ pasted: 'pasted', uploaded: 'uploaded' });

export const MAX_TITLE_CHARS = 200;
export const MAX_TAGS = 12;
export const MAX_TAG_CHARS = 40;
export const MAX_LINK_CHARS = 500;
/** The body cap, in UTF-8 bytes, as the draft body cap is. */
export const MAX_BODY_BYTES = 256 * 1024;

/**
 * How many versions of one document are kept, the current one included: the
 * newest and the nine before it.
 */
export const KEPT_VERSIONS = 10;
/** How long a deleted document waits in Trash before it is removed for good. */
export const TRASH_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Thrown for input the owner can correct; the handler answers 400 with the sentence (authored, #945). */
export class DocVaultInputError extends AuthoredError {}

const fail = (message) => {
  throw new DocVaultInputError(message);
};

// ── identity ───────────────────────────────────────────────────────────────

/**
 * Fixed forever: changing it gives every document already stored a different
 * derived id, and the next upload of one would make a second copy.
 */
export const DOC_VAULT_ID_NAMESPACE = '3f6a1c52-8d0e-4b97-a5c1-72e4d9b0f318';

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
    .replace(/[̀-ͯ]+/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * The stored key of a document: its category and its folded title.
 *
 * @param {string} category
 * @param {string} title
 * @returns {string|null} null when the title has no letter or digit
 */
export function dedupeKeyOf(category, title) {
  const folded = normalizeVaultTitle(title);
  return folded ? `${String(category).toLowerCase()}|${folded}` : null;
}

/**
 * A deterministic, UUID-shaped id for a key (RFC 9562 version 5: SHA-1 over
 * the namespace and the name), so two uploads of one document, even at the
 * same instant, race to the same id and the create is create-only.
 *
 * @param {string} dedupeKey
 * @returns {string}
 */
export function vaultDocumentId(dedupeKey) {
  const namespace = Buffer.from(DOC_VAULT_ID_NAMESPACE.replace(/-/g, ''), 'hex');
  const bytes = createHash('sha1')
    .update(namespace)
    .update(Buffer.from(`doc-vault:${dedupeKey}`, 'utf8'))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The id of an earlier version of a document. '~' is legal in a Cosmos id and in no document id. */
export const versionDocId = (documentId, version) => `${documentId}~v${version}`;

/** A document id as it arrives in a URL: a UUID, or an id this code made. */
export const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Who to record: the admin's id, never their name or address. */
export const adminIdOf = (user = {}) => [user.oid, user.sub].find(Boolean) || 'unknown';

// ── fields ─────────────────────────────────────────────────────────────────

/** The fields a person can set on a document. Nothing else is read from a request. */
export const EDITABLE_FIELDS = Object.freeze(['title', 'category', 'tags', 'body', 'relatedLink']);

const hasControlCharacter = (text, { allowLayout }) => {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0) return true;
    if (allowLayout && (code === 9 || code === 10 || code === 13)) continue;
    if (code < 32 || code === 127) return true;
  }
  return false;
};

/** The category named, in the spelling the list uses, or null. Case does not matter. */
export function canonicalCategory(value) {
  const wanted = String(value ?? '')
    .trim()
    .toLowerCase();
  return CATEGORIES.find((category) => category.toLowerCase() === wanted) ?? null;
}

/** A tag as stored: trimmed, without a leading '#' (Obsidian writes them with one). */
export const cleanTag = (value) => {
  let tag = String(value ?? '').trim();
  while (tag.startsWith('#')) tag = tag.slice(1);
  return tag.trim();
};

/**
 * The tags of a request: a list, or a comma-separated string, de-duplicated
 * without regard to case. More than 12, or one over 40 characters, is refused
 * (a file upload is more forgiving: markdown.js trims and says so).
 */
export function readTags(value) {
  if (value === undefined || value === null || value === '') return [];
  const list = typeof value === 'string' ? value.split(',') : value;
  if (!Array.isArray(list)) fail('tags must be a list of words');
  const seen = new Set();
  const tags = [];
  for (const item of list) {
    if (typeof item !== 'string') fail('tags must be a list of words');
    const tag = cleanTag(item);
    if (!tag) continue;
    if (tag.length > MAX_TAG_CHARS) fail(`A tag can be at most ${MAX_TAG_CHARS} characters.`);
    if (hasControlCharacter(tag, { allowLayout: false })) fail('A tag cannot hold control characters.');
    const folded = tag.toLowerCase();
    if (!seen.has(folded)) {
      seen.add(folded);
      tags.push(tag);
    }
  }
  if (tags.length > MAX_TAGS) fail(`A document can have at most ${MAX_TAGS} tags.`);
  return tags;
}

/**
 * Is this a link the page may show as one: an https address, or a route of
 * this admin (`/admin/...`)? Anything else (javascript:, data:, http:, a
 * protocol-relative address) is not, so a stored link cannot run script when
 * clicked.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSafeLink(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_LINK_CHARS) return false;
  if (hasControlCharacter(value, { allowLayout: false }) || value.includes(' ')) return false;
  if (value.startsWith('/')) {
    if (value !== '/admin' && !value.startsWith('/admin/')) return false;
    if (value.includes('\\') || value.includes('//')) return false;
    return value.split('/').every((segment) => segment.length <= 120);
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function readLink(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') fail('relatedLink must be text');
  const link = value.trim();
  if (!link) return null;
  if (!isSafeLink(link)) {
    fail(
      `The link must be an https address, or a page of this admin that starts with /admin/ (at most ${MAX_LINK_CHARS} characters).`
    );
  }
  return link;
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
  return (
    stored.title === fields.title &&
    stored.category === fields.category &&
    stored.body === fields.body &&
    (stored.relatedLink ?? null) === (fields.relatedLink ?? null) &&
    JSON.stringify(stored.tags ?? []) === JSON.stringify(fields.tags)
  );
}

// ── documents ──────────────────────────────────────────────────────────────

/** The fields a version carries: what a person can edit, and how the text arrived. */
const snapshotOf = (doc) => ({
  title: doc.title,
  category: doc.category,
  tags: doc.tags ?? [],
  body: doc.body,
  bodyBytes: doc.bodyBytes ?? byteLength(doc.body ?? ''),
  source: doc.source,
  relatedLink: doc.relatedLink ?? null,
});

/**
 * A brand-new document, version 1.
 *
 * @param {{ id: string, fields: object, source: string, adminId: string, now: Date }} args
 */
export function buildNewDocument({ id, fields, source, adminId, now }) {
  const stamp = now.toISOString();
  return {
    id,
    docType: DOC_TYPES.document,
    ...snapshotOf({ ...fields, bodyBytes: byteLength(fields.body), source }),
    dedupeKey: dedupeKeyOf(fields.category, fields.title),
    version: 1,
    restoredFromVersion: null,
    createdAt: stamp,
    createdBy: adminId,
    updatedAt: stamp,
    updatedBy: adminId,
    deletedAt: null,
    deletedBy: null,
  };
}

/**
 * The document after a change of text: the next version number, the new
 * content, the creator and creation time unchanged, and out of Trash (adding a
 * document under a key whose document is in Trash brings it back).
 * Carries the stored `_etag` so replaceDocIfMatch can condition on it.
 */
export function buildNextDocument({ current, fields, source, adminId, now, restoredFromVersion = null }) {
  return {
    id: current.id,
    docType: DOC_TYPES.document,
    ...snapshotOf({ ...fields, bodyBytes: byteLength(fields.body), source }),
    dedupeKey: dedupeKeyOf(fields.category, fields.title),
    version: current.version + 1,
    restoredFromVersion,
    createdAt: current.createdAt,
    createdBy: current.createdBy,
    updatedAt: now.toISOString(),
    updatedBy: adminId,
    deletedAt: null,
    deletedBy: null,
    _etag: current._etag,
  };
}

/** The earlier version a change leaves behind: the document as it stood, under a version id. */
export function buildArchivedVersion(current) {
  return {
    id: versionDocId(current.id, current.version),
    docType: DOC_TYPES.version,
    documentId: current.id,
    version: current.version,
    ...snapshotOf(current),
    restoredFromVersion: current.restoredFromVersion ?? null,
    savedAt: current.updatedAt,
    savedBy: current.updatedBy,
  };
}

/** A version number from a URL: a whole number from 1. */
export function readVersionNumber(value) {
  const text = String(value ?? '');
  if (text.length === 0 || text.length > 6) return null;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 48 || code > 57) return null;
  }
  const number = Number(text);
  return number >= 1 ? number : null;
}

/** When a document in Trash is removed for good. */
export const purgeAtOf = (doc) =>
  doc.deletedAt ? new Date(Date.parse(doc.deletedAt) + TRASH_DAYS * DAY_MS).toISOString() : null;

/** The oldest `deletedAt` that is still inside the Trash window. */
export const trashCutoff = (now) => new Date(now.getTime() - TRASH_DAYS * DAY_MS).toISOString();

/** A list row: everything but the text. */
export function toSummary(doc) {
  return {
    id: doc.id,
    title: doc.title,
    category: doc.category,
    tags: doc.tags ?? [],
    source: doc.source,
    relatedLink: doc.relatedLink ?? null,
    version: doc.version,
    bodyBytes: doc.bodyBytes ?? 0,
    createdAt: doc.createdAt ?? null,
    updatedAt: doc.updatedAt ?? null,
    deletedAt: doc.deletedAt ?? null,
    purgeAt: purgeAtOf(doc),
    etag: doc._etag ?? null,
  };
}

/** A document with its text, and who made it. */
export function toView(doc) {
  return {
    ...toSummary(doc),
    body: doc.body,
    restoredFromVersion: doc.restoredFromVersion ?? null,
    createdBy: doc.createdBy ?? null,
    updatedBy: doc.updatedBy ?? null,
  };
}

/**
 * What a lost race answers with: enough to offer a reload, and nothing of the
 * document's content (no title, tag, link or text), because it travels in a
 * refusal.
 */
export function toConflictSummary(doc) {
  return {
    id: doc.id,
    version: doc.version,
    updatedAt: doc.updatedAt ?? null,
    deletedAt: doc.deletedAt ?? null,
    etag: doc._etag ?? null,
  };
}

/** A version row: when it was saved and how big it is, no text. */
export function toVersionSummary(doc) {
  return {
    version: doc.version,
    title: doc.title,
    category: doc.category,
    source: doc.source,
    bodyBytes: doc.bodyBytes ?? 0,
    restoredFromVersion: doc.restoredFromVersion ?? null,
    savedAt: doc.savedAt ?? doc.updatedAt ?? null,
  };
}

/** One earlier version with its text, ready to read or to restore. */
export function toVersionView(doc) {
  return {
    ...toVersionSummary(doc),
    tags: doc.tags ?? [],
    relatedLink: doc.relatedLink ?? null,
    body: doc.body,
  };
}

/** The fields a version restores: what a person could have typed. */
export const fieldsOfVersion = (version) => ({
  title: version.title,
  category: version.category,
  tags: version.tags ?? [],
  body: version.body,
  relatedLink: version.relatedLink ?? null,
});
