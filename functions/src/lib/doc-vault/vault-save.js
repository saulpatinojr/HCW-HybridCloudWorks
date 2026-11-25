/**
 * doc-vault/vault-save.js — saving a Doc Vault document (doc-vault/handlers.js
 * has the routes): a new document under its derived id, or the next version
 * of the one that holds its key, written under the etag of the read it was
 * decided from. vault-store.js has the reads and the removal from Trash.
 */
import {
  CONTAINER,
  DOC_TYPES,
  SALT_DOCUMENT_ID,
  buildArchivedVersion,
  buildNewDocument,
  buildNextDocument,
  dedupeKeyOf,
  sameContent,
  vaultDocumentId,
} from './model.js';
import { DUPLICATE, PURGING, Refusal, isPreconditionFailure, refuseIf } from './refusals.js';
import { conflict, deleteQuietly, findByKey, patchUnderEtag, pruneVersions, readStored } from './vault-store.js';

// ── saving ─────────────────────────────────────────────────────────────────

export async function refuseIfKeyTaken(deps, fields, current) {
  const key = dedupeKeyOf(fields.category, fields.title);
  if (key === current.dedupeKey) return;
  refuseIf((await findByKey(deps, key, current.id)) && DUPLICATE);
}

/**
 * Write `fields` as the next version of `current`: archive what is there,
 * replace it under its etag, prune the oldest. Identical content writes
 * nothing (a document in Trash is brought back instead).
 *
 * @returns {Promise<{ outcome: 'versioned'|'unchanged'|'restored', doc: object }>}
 */
export async function addVersion(deps, { current, fields, source, adminId, restoredFromVersion = null }) {
  refuseIf(current.purging && PURGING);
  if (sameContent(current, fields)) {
    if (!current.deletedAt) return { outcome: 'unchanged', doc: current };
    const doc = await patchUnderEtag(
      deps,
      current.id,
      { deletedAt: null, deletedBy: null },
      current._etag
    );
    return { outcome: 'restored', doc };
  }
  const next = buildNextDocument({
    current,
    fields,
    source,
    adminId,
    now: deps.now(),
    restoredFromVersion,
  });
  // The earlier text goes first, under an id that names its version, so a
  // repeat after a failure rewrites the same item rather than adding one.
  const archive = buildArchivedVersion(current);
  await deps.store.upsertDoc(CONTAINER, archive);
  let stored;
  try {
    stored = await deps.store.replaceDocIfMatch(CONTAINER, next);
  } catch (error) {
    if (isPreconditionFailure(error)) {
      // The document may have been removed, or be mid-removal, since it was
      // read. Then the item just written belongs to nothing and nothing would
      // ever delete it: take it back before answering.
      const latest = await readStored(deps, current.id, DOC_TYPES.document).catch(() => null);
      if (!latest || latest.purging) await deleteQuietly(deps, archive.id).catch(() => {});
      await conflict(deps, current.id);
    }
    throw error;
  }
  await pruneVersions(deps, current.id, next.version);
  return { outcome: 'versioned', doc: stored || next };
}

/**
 * The container's id salt (model.js SALT_DOCUMENT_ID): read, or made the first
 * time it is needed. Made create-only, so two instances starting together agree
 * on one: the loser of the create reads the winner's.
 */
async function idSalt(deps) {
  const usable = (doc) =>
    doc && doc.docType === DOC_TYPES.salt && typeof doc.value === 'string' && doc.value.length >= 16;
  const stored = await deps.store.readDoc(CONTAINER, SALT_DOCUMENT_ID, SALT_DOCUMENT_ID);
  if (usable(stored)) return stored.value;
  const value = deps.newSalt();
  try {
    await deps.store.createDoc(CONTAINER, {
      id: SALT_DOCUMENT_ID,
      docType: DOC_TYPES.salt,
      value,
      createdAt: deps.now().toISOString(),
    });
    return value;
  } catch (error) {
    if (error?.code !== 409) throw error;
  }
  const winner = await deps.store.readDoc(CONTAINER, SALT_DOCUMENT_ID, SALT_DOCUMENT_ID);
  if (!usable(winner)) throw new Error('the id salt item exists and cannot be read');
  return winner.value;
}

/** Create the document under its derived id; when that id is taken, say who holds it. */
async function createNew(deps, { key, fields, source, adminId }) {
  const build = (id) => buildNewDocument({ id, fields, source, adminId, now: deps.now() });
  const derivedId = vaultDocumentId(key, await idSalt(deps));
  const first = build(derivedId);
  try {
    return { doc: (await deps.store.createDoc(CONTAINER, first)) || first };
  } catch (error) {
    if (error?.code !== 409) throw error;
  }
  const holder = await readStored(deps, derivedId, DOC_TYPES.document);
  if (holder && holder.dedupeKey === key) return { holder };
  // The derived id belongs to a document since renamed to something else: use a fresh id.
  const second = build(deps.uuid());
  return { doc: (await deps.store.createDoc(CONTAINER, second)) || second };
}

/**
 * A pasted or uploaded document: new, or the next version of the one that
 * holds its key. A lost race with another write to the same document is run
 * once more from the top, because an upload carries no etag to ask the page
 * about.
 *
 * @returns {Promise<{ outcome: 'created'|'versioned'|'unchanged'|'restored', doc: object }>}
 */
export async function saveDocument(deps, { fields, source, adminId }) {
  const key = dedupeKeyOf(fields.category, fields.title);
  for (let attempt = 0; ; attempt += 1) {
    try {
      let current = await findByKey(deps, key);
      if (!current) {
        const made = await createNew(deps, { key, fields, source, adminId });
        if (made.doc) return { outcome: 'created', doc: made.doc };
        current = made.holder;
      }
      return await addVersion(deps, { current, fields, source, adminId });
    } catch (error) {
      if (!(error instanceof Refusal) || error.refusalCode !== 'CONFLICT' || attempt > 0) throw error;
    }
  }
}
