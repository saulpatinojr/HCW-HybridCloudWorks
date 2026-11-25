/**
 * interviews/upload-complete.js — the last step of an interview audio upload
 * (upload.js has the other routes and the header that explains the upload):
 * commit the blocks, check the file against what was declared, and point the
 * interview at the new recording.
 */
import { INTERVIEWS_AUDIO_CONTAINER } from './storage.js';
import { UPLOAD_SOURCE, blockIdFor, ownsAudioPath } from './upload-checks.js';
import {
  deletedSinceRead,
  discardBlob,
  findSession,
  interviewDeleted,
  json,
  ownerOf,
  sessionRefusal,
  sessionsOf,
  writeProvenance,
} from './upload-sessions.js';

/**
 * A mismatch deletes this session's blob and nothing else: the
 * recording the document already points at has its own name and is
 * untouched. The session stays open for the retry.
 *
 * Fenced against a second completion of the same session: before the
 * blob is deleted, the session's refusal count is written under the
 * document ETag this completion read. If another completion wrote
 * the document in between (it published this very blob after a
 * retry re-staged the blocks), that write answers 412, the outer
 * catch maps it to 409, and nothing is deleted; and once this write
 * has landed, the other completion's publish fails the same way, so
 * a blob is never deleted after it was published.
 */
async function refuseCompletion(deps, { doc, session, uploadId, context }, sentence, line) {
  const fenced = sessionsOf(doc).map((s) =>
    s && s.uploadId === uploadId
      ? { ...s, refusals: (Number.isInteger(s.refusals) ? s.refusals : 0) + 1, lastRefusedAt: deps.now().toISOString() }
      : s
  );
  try {
    await writeProvenance(deps, doc, { ...(doc.provenance?.audio ?? {}), uploads: fenced });
  } catch (error) {
    if (error?.code !== 412 || !(await deletedSinceRead(deps, doc))) throw error;
    await discardBlob(deps, session.path, context, 'interviewUploadComplete', 'after the interview was deleted');
    context.warn?.("interviewUploadComplete: refused; the interview's deletion started meanwhile");
    return interviewDeleted();
  }
  await discardBlob(deps, session.path, context, 'interviewUploadComplete', 'after a refused completion');
  context.warn?.(line);
  return json(422, { error: sentence });
}

/** Commit the blocks in order; the 422 (and null blob) when a block is missing. */
async function commitBlocks({ storage }, { doc, session, oid, context }) {
  const blockIds = Array.from({ length: session.blockCount }, (_, i) => blockIdFor(i));
  try {
    return {
      committed: await storage.commitBlockList(INTERVIEWS_AUDIO_CONTAINER, session.path, blockIds, {
        contentType: session.contentType,
        metadata: { source: UPLOAD_SOURCE, uploadedBy: oid, interviewId: doc.id },
      }),
    };
  } catch (error) {
    if (error?.code !== 'InvalidBlockList') throw error;
    context.warn?.(`interviewUploadComplete: missing blocks (${session.blockCount} expected)`);
    return { refusal: json(422, { error: 'Not every block was uploaded; send the missing blocks and complete again' }) };
  }
}

/** The 422 for a committed blob that is not the file declared (size, then SHA-256), or null when it is. */
async function mismatchRefusal(deps, completion, committed) {
  const { session } = completion;
  if (committed.contentLength !== session.bytes) {
    return refuseCompletion(
      deps,
      completion,
      'The uploaded size does not match the declared size; upload the file again',
      `interviewUploadComplete: size mismatch (${committed.contentLength} B stored, ${session.bytes} B declared)`
    );
  }
  const digest = await deps.storage.hashBlobSha256(INTERVIEWS_AUDIO_CONTAINER, session.path);
  if (digest !== session.sha256) {
    return refuseCompletion(
      deps,
      completion,
      'The uploaded file does not match its declared SHA-256; upload the file again',
      `interviewUploadComplete: hash mismatch (${session.bytes} B)`
    );
  }
  return null;
}

/**
 * The recordings this document replaced, for slice C's sweeper. Only a path
 * this module could have minted for this interview is carried forward: the
 * document is editable through the generic content update route by the same
 * role, and a planted path would otherwise reach the sweeper as something
 * to delete.
 */
function supersededPaths(doc, session) {
  const before = doc.provenance?.audio ?? {};
  const superseded = (Array.isArray(before.superseded) ? before.superseded : []).filter((p) =>
    ownsAudioPath(doc.id, p)
  );
  const replaced = before.path && before.path !== session.path && ownsAudioPath(doc.id, before.path);
  if (replaced && !superseded.includes(before.path)) superseded.push(before.path);
  return superseded;
}

/**
 * The pointer moves. The recording the document pointed at until now
 * is recorded under `superseded` rather than deleted here: slice C's
 * delete helper (deleteBlobWithVersions, which is why the identity
 * holds Storage Blob Data Owner on this container, infra/storage.tf)
 * sweeps that list when the interview or its recording is deleted,
 * and the lifecycle rule expires every blob under audio/ regardless.
 */
function publishedAudio(deps, { doc, session, uploadId, oid }) {
  const uploads = sessionsOf(doc).filter((s) => s && s.uploadId !== uploadId);
  return {
    container: INTERVIEWS_AUDIO_CONTAINER,
    path: session.path,
    bytes: session.bytes,
    sha256: session.sha256,
    contentType: session.contentType,
    durationSec: session.durationSec,
    uploadedAt: deps.now().toISOString(),
    uploadedBy: oid,
    uploadId,
    superseded: supersededPaths(doc, session),
    ...(uploads.length > 0 ? { uploads } : {}),
  };
}

/** Point the document at the new blob, under the ETag it was read at. */
async function publishUpload(deps, completion) {
  const { doc, session, context } = completion;
  try {
    await writeProvenance(deps, doc, publishedAudio(deps, completion), { source: 'upload' });
  } catch (error) {
    // The pointer write lost its ETag. If the interview's deletion
    // started after this completion read the document, the blob just
    // committed is deleted here, since the delete hook may already have
    // listed the prefix; any other writer leaves it for the retry.
    if (error?.code === 412 && (await deletedSinceRead(deps, doc))) {
      await discardBlob(deps, session.path, context, 'interviewUploadComplete', 'after the interview was deleted');
      context.warn?.("interviewUploadComplete: committed; the interview's deletion started meanwhile, blob removed");
      return interviewDeleted();
    }
    throw error;
  }
  context.log?.(`interviewUploadComplete: committed (${session.bytes} B, ${session.blockCount} blocks)`);
  return json(200, { ok: true, bytes: session.bytes, sha256: session.sha256, contentType: session.contentType });
}

/** The session a completion is for; the 409 when it was completed already, else as sessionRefusal says. */
const completionRefusal = (found) => {
  // A tombstone read before the commit: nothing is committed.
  if (found.deleted) return interviewDeleted();
  if (found.completed) return json(409, { error: 'This upload was already completed' });
  return sessionRefusal(found);
};

/**
 * POST /api/cms/interviews/uploads/{uploadId}/complete — commit the blocks
 * in order, check size and SHA-256 against the declaration, point
 * provenance.audio at the new blob, drop the session and remove the
 * recording the document pointed at before. 200 { ok, bytes, sha256,
 * contentType }; 422 with the session's blob deleted on a mismatch; 409
 * when the upload was already completed.
 */
export async function completeUpload(deps, request, context) {
  const auth = await deps.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  const oid = ownerOf(auth);
  const uploadId = String(request.params?.uploadId || '');

  try {
    const found = await findSession(deps, uploadId, oid);
    const refusal = completionRefusal(found);
    if (refusal) return refusal;
    const completion = { doc: found.doc, session: found.session, uploadId, oid, context };
    const commit = await commitBlocks(deps, completion);
    const mismatch = commit.refusal ?? (await mismatchRefusal(deps, completion, commit.committed));
    return mismatch ?? (await publishUpload(deps, completion));
  } catch (error) {
    if (error?.code === 412) return json(409, { error: 'The interview changed while the upload was completed; try again' });
    // Code or status only: a Storage or Cosmos message carries the request URL, which names the blob.
    context.error(`interviewUploadComplete failed (${error?.code ?? error?.statusCode ?? 'n/a'})`);
    return json(500, { error: 'Failed to complete the upload' });
  }
}
