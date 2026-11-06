/**
 * tombstone.js — the mark an interview gets before it is deleted (ADR 0040,
 * D10).
 *
 * Deleting an interview removes its recording and transcripts as well as
 * the document, and an upload may be finishing at that moment. So the
 * delete first writes `provenance.audio.deletedAt` under the ETag it read:
 * an upload completion that read the document before this write fails its
 * own ETag write, and one that reads after it sees the mark. Only then is
 * the document deleted (under the tombstone's new ETag) and the interview's
 * whole `audio/<id>/` and `transcripts/<id>/` prefixes swept
 * (`deleteInterviewAssets` in ./admin.js), which also removes a blob
 * committed in the moment between the two writes.
 *
 * Kept apart from ./admin.js so that lib/content-workflow.js, which every
 * content delete goes through, does not load the admin handlers.
 */

/** Interview ids as the content container mints them: a UUID or a migrated Firestore id. */
export const INTERVIEW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** True for a document of the interview type, however its type is cased. */
export const isInterviewDoc = (doc) => String(doc?.type || '').toLowerCase() === 'interview';

/**
 * Write the tombstone under the document's ETag and answer the document as
 * it now stands, carrying the new ETag the delete must use.
 *
 * Throws the store's error unchanged: a 412 means the document changed since
 * it was read (the caller answers 409), a 404 that it is already gone.
 *
 * @param {{ patchDoc: Function, readDoc: Function }} store
 * @param {object} doc - the content document as read, with `_etag`
 * @param {string} nowIso
 * @returns {Promise<object|null>} the tombstoned document, or null when it is gone
 */
export async function writeInterviewTombstone(store, doc, nowIso) {
  const provenance = doc.provenance && typeof doc.provenance === 'object' ? doc.provenance : {};
  const audio = provenance.audio && typeof provenance.audio === 'object' ? provenance.audio : {};
  const written = await store.patchDoc(
    'content',
    doc.id,
    { provenance: { ...provenance, audio: { ...audio, deletedAt: nowIso } }, updatedAt: nowIso },
    { ifMatch: doc._etag }
  );
  if (written && written._etag) return { ...doc, ...written };
  return store.readDoc('content', doc.id, doc.id);
}
