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
 *
 * AN ID SAYS NOTHING. A document's id is derived from its key and a private
 * salt (vaultDocumentId), not from the key alone, because the id travels: the
 * URL, the audit row's resource, the request telemetry. A plain hash would let
 * anyone who can read those confirm a guessed title.
 */
import { createHmac } from 'node:crypto';
import { byteLength, normalizeVaultTitle } from './fields.js';

export {
  CATEGORIES,
  DEFAULT_CATEGORY,
  DocVaultInputError,
  MAX_BODY_BYTES,
  MAX_LINK_CHARS,
  MAX_TAGS,
  MAX_TAG_CHARS,
  MAX_TITLE_CHARS,
} from './limits.js';
export { cleanTag, isSafeLink, readTags } from './tags-links.js';
export {
  EDITABLE_FIELDS,
  byteLength,
  canonicalCategory,
  normalizeText,
  normalizeVaultTitle,
  sameContent,
  validateFields,
} from './fields.js';

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
 *
 * WHAT THIS DOES AND DOES NOT PROMISE. Every publisher and super_admin the owner
 * has made can read, rewrite and delete every document here: a document records
 * who made it (createdBy) but nothing compares that with who is asking. If the
 * owner is ever the only person who should see these, set this to
 * 'super_admin' (and the Doc Vault row of config/adminNav.js, the routes'
 * entries in .azure/api-surface.json and the runbook with it). Reads are
 * recorded (handlers.js doc_vault_read), so a shared role is at least visible.
 */
export const DOC_VAULT_ROLE = 'publisher';

export const DOC_TYPES = Object.freeze({ document: 'document', version: 'version', salt: 'salt' });

/**
 * The one item of `docType: 'salt'`: a random secret, made the first time a
 * document is created and kept in the container beside the documents. Document
 * ids are derived from it (vaultDocumentId), so an id seen in an audit row, a
 * URL or a telemetry line cannot be checked against a guessed title.
 */
export const SALT_DOCUMENT_ID = 'vault-id-salt';
export const SOURCES = Object.freeze({ pasted: 'pasted', uploaded: 'uploaded' });

/**
 * How many versions of one document are kept, the current one included: the
 * newest and the nine before it.
 */
export const KEPT_VERSIONS = 10;
/** How long a deleted document waits in Trash before it is removed for good. */
export const TRASH_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// ── identity ───────────────────────────────────────────────────────────────

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
 * A deterministic, UUID-shaped id for a key: HMAC-SHA-256 of the key under the
 * container's private salt, cut to 128 bits. The same key and salt always give
 * the same id, so two uploads of one document, even at the same instant, race
 * to the same id and the create is create-only. Without the salt the id cannot
 * be recomputed from a title, so an id that turns up in an audit row or a log
 * line confirms nothing about what the document is called. (A plain hash of the
 * key would: the code is public, and a list of likely titles is short.)
 *
 * The salt is fixed for the life of the container: a different one gives every
 * document already stored a different derived id, and the next upload of one
 * would make a second copy.
 *
 * @param {string} dedupeKey
 * @param {string} salt - the container's salt item (SALT_DOCUMENT_ID)
 * @returns {string}
 */
export function vaultDocumentId(dedupeKey, salt) {
  if (typeof salt !== 'string' || salt.length < 16) {
    throw new Error('vaultDocumentId needs the container salt');
  }
  const bytes = createHmac('sha256', salt)
    .update(`doc-vault:${dedupeKey}`, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // the UUID shape: version nibble
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The id of an earlier version of a document. '~' is legal in a Cosmos id and in no document id. */
export const versionDocId = (documentId, version) => `${documentId}~v${version}`;

/** A document id as it arrives in a URL: a UUID, or an id this code made. The salt item's id also fits, and is refused by its docType. */
export const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Who to record: the admin's id, never their name or address. */
export const adminIdOf = (user = {}) => [user.oid, user.sub].find(Boolean) || 'unknown';

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
