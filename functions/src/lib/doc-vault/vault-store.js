/**
 * doc-vault/vault-store.js — how the Doc Vault reads and writes its
 * container (doc-vault/handlers.js has the routes): a document and its
 * versions, the version window, the id salt, saving under a document's etag,
 * and removing a document from Trash for good. A write decided from an
 * earlier read is conditional on that read's etag, and a lost race answers
 * the 412 with what is stored now.
 */
import {
  CONTAINER,
  DOC_TYPES,
  KEPT_VERSIONS,
  toConflictSummary,
  toVersionSummary,
  trashCutoff,
} from './model.js';
import { CONFLICT_MESSAGE, NOT_FOUND, Refusal, isPreconditionFailure, refuseIf } from './refusals.js';

/** Rows the list returns. The vault is one person's shelf; this is generous. */
export const MAX_LISTED_DOCUMENTS = 500;
/** Expired Trash removed per list load, so a load stays short. */
export const PURGE_BATCH = 20;

// ── the queries, as constants so a test can name them ──────────────────────

const ACTIVE = '(NOT IS_DEFINED(c.deletedAt) OR IS_NULL(c.deletedAt))';
const TRASHED = '(IS_DEFINED(c.deletedAt) AND NOT IS_NULL(c.deletedAt))';
const LIST_PROJECTION = [
  'c.id',
  'c.title',
  'c.category',
  'c.tags',
  'c.source',
  'c.relatedLink',
  'c.version',
  'c.bodyBytes',
  'c.createdAt',
  'c.updatedAt',
  'c.deletedAt',
  'c._etag',
].join(', ');
const listQuery = (clause) =>
  `SELECT TOP ${MAX_LISTED_DOCUMENTS + 1} ${LIST_PROJECTION} FROM c WHERE c.docType = @docType AND ${clause} ORDER BY c.updatedAt DESC`;
export const LIST_ACTIVE_QUERY = listQuery(ACTIVE);
export const LIST_TRASH_QUERY = listQuery(TRASHED);
export const FIND_BY_KEY_QUERY =
  'SELECT TOP 2 * FROM c WHERE c.docType = @docType AND c.dedupeKey = @key';
export const VERSIONS_QUERY =
  'SELECT c.version, c.title, c.category, c.source, c.bodyBytes, c.restoredFromVersion, c.savedAt FROM c WHERE c.docType = @docType AND c.documentId = @id ORDER BY c.version DESC';
export const VERSION_IDS_QUERY =
  'SELECT c.id, c.version FROM c WHERE c.docType = @docType AND c.documentId = @id';
export const EXPIRED_TRASH_QUERY = `SELECT TOP ${PURGE_BATCH} c.id, c._etag, c.purging FROM c WHERE c.docType = @docType AND ${TRASHED} AND c.deletedAt < @cutoff`;

/** A stored document of the kind asked for, or null. */
export async function readStored(deps, id, docType) {
  const doc = await deps.store.readDoc(CONTAINER, id, id);
  return doc && doc.docType === docType ? doc : null;
}

export async function readDocument(deps, id) {
  const doc = await readStored(deps, id, DOC_TYPES.document);
  refuseIf(!doc && NOT_FOUND);
  return doc;
}

/** The 412 a lost race answers, with what is stored now (or 404 if it is gone). Always throws. */
export async function conflict(deps, id) {
  const latest = await readStored(deps, id, DOC_TYPES.document).catch(() => null);
  refuseIf(!latest && { ...NOT_FOUND, error: 'This document no longer exists.' });
  throw new Refusal(
    { status: 412, code: 'CONFLICT', error: CONFLICT_MESSAGE },
    { current: toConflictSummary(latest) }
  );
}

export async function patchUnderEtag(deps, id, update, etag) {
  try {
    return await deps.store.patchDoc(CONTAINER, id, update, { ifMatch: etag });
  } catch (error) {
    if (isPreconditionFailure(error)) await conflict(deps, id);
    throw error;
  }
}

/** The document holding a key, other than `exceptId` (the document asking), or null. */
export async function findByKey(deps, key, exceptId = null) {
  const rows = await deps.store.queryDocs(CONTAINER, FIND_BY_KEY_QUERY, [
    { name: '@docType', value: DOC_TYPES.document },
    { name: '@key', value: key },
  ]);
  return rows.find((row) => row.id !== exceptId) ?? null;
}

const versionRows = (deps, id) =>
  deps.store.queryDocs(CONTAINER, VERSION_IDS_QUERY, [
    { name: '@docType', value: DOC_TYPES.version },
    { name: '@id', value: id },
  ]);

/** An id and a version number read from a delete's query: both or nothing. */
const isVersionRow = (row) => typeof row?.id === 'string' && Number.isInteger(row.version);

/** Remove a document that is already gone without complaint: a retry meets a half-finished delete. */
export async function deleteQuietly(deps, id) {
  try {
    await deps.store.deleteDoc(CONTAINER, id, id);
  } catch (error) {
    if (error?.code !== 404) throw error;
  }
}

/**
 * The versions older than the newest KEPT_VERSIONS, removed. Best-effort: the
 * list and the viewer both ignore a version outside the window, so one that
 * survives a failed delete is invisible and goes with the next save.
 */
export async function pruneVersions(deps, id, currentVersion) {
  try {
    const rows = (await versionRows(deps, id)).filter(isVersionRow);
    for (const row of rows) {
      if (row.version <= currentVersion - KEPT_VERSIONS) await deleteQuietly(deps, row.id);
    }
  } catch {
    // Nothing to report: the next save tries again.
  }
}

/** Is an archived version inside the window the vault keeps? */
export const withinWindow = (current, version) =>
  version < current.version && version > current.version - KEPT_VERSIONS;

/** The earlier versions of a document that the page may offer, newest first. */
export async function listVersions(deps, current) {
  const rows = await deps.store.queryDocs(CONTAINER, VERSIONS_QUERY, [
    { name: '@docType', value: DOC_TYPES.version },
    { name: '@id', value: current.id },
  ]);
  return rows
    .filter((row) => Number.isInteger(row?.version) && withinWindow(current, row.version))
    .map(toVersionSummary)
    .sort((a, b) => b.version - a.version);
}

/**
 * Documents that have waited in Trash past the window, removed with their
 * versions, each under the etag the query read: a document put back since
 * fails its condition and is left alone. Best-effort, and one failure does not
 * stop the others; Trash is tidied again on the next load.
 */
export async function purgeExpiredTrash(deps) {
  let expired = [];
  try {
    expired = await deps.store.queryDocs(CONTAINER, EXPIRED_TRASH_QUERY, [
      { name: '@docType', value: DOC_TYPES.document },
      { name: '@cutoff', value: trashCutoff(deps.now()) },
    ]);
  } catch {
    return;
  }
  for (const row of expired) {
    if (typeof row?.id !== 'string' || typeof row._etag !== 'string') continue;
    try {
      await eraseDocument(deps, { id: row.id, _etag: row._etag, purging: row.purging === true });
    } catch {
      // Put back, edited elsewhere or already gone: leave it.
    }
  }
}

/**
 * Remove a document that is in Trash, and its versions, in an order that
 * neither loses a document's history while the document lives, nor leaves
 * history behind when the document goes, even if the work is interrupted or
 * races a put-back:
 *   1. mark it `purging` under its etag. From here a put-back, an edit and a
 *      second delete are refused, so nothing can revive it half-deleted; and a
 *      put-back that got in first fails this step, with the history intact.
 *   2. delete its versions (a retry meets none, quietly).
 *   3. delete the document under the marked etag.
 * An interruption after step 1 leaves a trashed document marked purging, which
 * "Delete forever" and the next list load both finish.
 *
 * @param {object} deps
 * @param {{ id: string, _etag: string, purging?: boolean }} doc a document in Trash
 */
export async function eraseDocument(deps, doc) {
  const marked = doc.purging
    ? doc
    : await patchUnderEtag(deps, doc.id, { purging: true }, doc._etag);
  for (const row of (await versionRows(deps, doc.id)).filter(isVersionRow)) {
    await deleteQuietly(deps, row.id);
  }
  try {
    await deps.store.deleteDocIfMatch(CONTAINER, doc.id, marked._etag, doc.id);
  } catch (error) {
    if (error?.code === 404) return;
    if (error?.code === 412) await conflict(deps, doc.id);
    throw error;
  }
}
