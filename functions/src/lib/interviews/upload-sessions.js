/**
 * interviews/upload-sessions.js — how an interview audio upload's routes
 * (upload.js, upload-complete.js; upload.js's header explains the upload)
 * find a session, write the content document under its ETag, and remove a
 * blob that must not stay.
 */
import { INTERVIEWS_AUDIO_CONTAINER } from './storage.js';
import { CONTENT_CONTAINER, UPLOAD_ID_PATTERN, isSoundSession, isTombstoned } from './upload-checks.js';

export const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * The document an open session, or a completed upload, with this id is on.
 * One indexed query per call; the route carries no interview id, and a
 * caller-supplied interview id would be one more thing to check against the
 * session anyway. `ARRAY_CONTAINS` with a partial match finds the session in
 * the list by its id.
 */
const FIND_QUERY =
  'SELECT TOP 1 * FROM c WHERE c.type = @type AND ' +
  '(ARRAY_CONTAINS(c.provenance.audio.uploads, { "uploadId": @uploadId }, true) OR c.provenance.audio.uploadId = @uploadId)';

/** The 409 every route answers once the interview's deletion has started. */
export const interviewDeleted = () =>
  json(409, { error: 'This interview is being deleted; the upload was not kept', code: 'INTERVIEW_DELETED' });

export const sessionsOf = (doc) => {
  const list = doc?.provenance?.audio?.uploads;
  return Array.isArray(list) ? list : [];
};

/** The signed-in admin's id, as a session records its owner. */
export const ownerOf = (auth) => String(auth.user?.oid || auth.user?.sub || '');

/** The open session of an upload the caller owns, as findSession reports what it found. */
function sessionVerdict(doc, session, oid) {
  if (session.ownerOid !== oid || session.status !== 'open' || !isSoundSession(doc, session)) {
    return { doc: null, session: null, completed: false };
  }
  // Reported only to the session's own admin; anyone else still gets 404.
  if (isTombstoned(doc)) return { doc, session: null, completed: false, deleted: true };
  return { doc, session, completed: false };
}

/**
 * Find the session for an upload id that the caller owns and that is still
 * open. Anything else — unknown id, another admin's session, a forged
 * session, an upload already completed — is `null` to the caller, except
 * that a completed one is reported so `completeUpload` can answer 409
 * rather than 404.
 */
export async function findSession({ store }, uploadId, oid) {
  if (!UPLOAD_ID_PATTERN.test(String(uploadId || ''))) return { doc: null, session: null, completed: false };
  const rows = await store.queryDocs(CONTENT_CONTAINER, FIND_QUERY, [
    { name: '@type', value: 'interview' },
    { name: '@uploadId', value: uploadId },
  ]);
  const doc = Array.isArray(rows) ? rows[0] : null;
  if (!doc) return { doc: null, session: null, completed: false };
  const session = sessionsOf(doc).find((s) => s && s.uploadId === uploadId) ?? null;
  if (session) return sessionVerdict(doc, session, oid);
  const audio = doc.provenance?.audio ?? {};
  const completed = audio.uploadId === uploadId && audio.uploadedBy === oid;
  if (completed && isTombstoned(doc)) return { doc, session: null, completed: false, deleted: true };
  return { doc, session: null, completed };
}

/**
 * After an ETag write of this completion failed: was it the deletion?
 * Re-reads the document; gone or tombstoned means the interview's deletion
 * started after this completion read it, so the blob it committed must go
 * (the delete hook may already have listed the prefix). Anything else is
 * another write (another session, an editor) and the blob is kept for the
 * retry, which re-commits the same, now committed, blocks.
 */
export async function deletedSinceRead({ store }, doc) {
  const fresh = await store.readDoc(CONTENT_CONTAINER, doc.id, doc.id);
  return !fresh || isTombstoned(fresh);
}

/** Write `provenance` as one merged object under the document's ETag. */
export function writeProvenance({ store }, doc, audio, extra = {}) {
  const provenance = { ...(doc.provenance ?? {}), ...extra, audio };
  return store.patchDoc(CONTENT_CONTAINER, doc.id, { provenance }, { ifMatch: doc._etag });
}

/** Best effort: the caller is already answering. Status code only in the log. */
export async function discardBlob({ storage }, path, context, label, why) {
  try {
    // The version-aware delete (slice C's deleteBlobWithVersions) when it
    // is wired: with versioning on, a plain delete leaves the blob as a
    // previous version until slice C's prefix sweep or the lifecycle rule.
    if (typeof storage.deleteBlobWithVersions === 'function') {
      await storage.deleteBlobWithVersions(INTERVIEWS_AUDIO_CONTAINER, path);
    } else {
      await storage.deleteBlob(INTERVIEWS_AUDIO_CONTAINER, path);
    }
  } catch (err) {
    context.warn?.(`${label}: blob not deleted ${why} (${err?.code || err?.statusCode || 'error'})`);
  }
}

/** The session a block or completion goes to; the 409 when the interview is being deleted, the 404 when there is none. */
export const sessionRefusal = ({ session, deleted }) => {
  if (deleted) return interviewDeleted();
  return session ? null : json(404, { error: 'Upload not found' });
};
