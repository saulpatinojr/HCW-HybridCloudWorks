/**
 * upload.js — a guest's recording reaches the private container in blocks
 * through the Function App (ADR 0040 D1, #1565).
 *
 *   browser → POST cms/interviews/uploads { interviewId, fileName, contentType, bytes, sha256, durationSec }
 *           → 201 { uploadId, blockSize, blockCount }; the session is written on the
 *             interview's content document in the provenance.audio.uploads list
 *   browser → PUT cms/interviews/uploads/{uploadId}/blocks/{index}, one raw 4 MiB body each
 *           → Put Block on audio/<interviewId>/<uploadId>.<ext>; re-sending an index overwrites it
 *   browser → POST cms/interviews/uploads/{uploadId}/complete
 *           → Put Block List in index order, size and SHA-256 checked against the
 *             declaration, provenance.audio pointed at the new blob, the session dropped,
 *             the path it pointed at before kept under provenance.audio.superseded
 *
 * Why blocks and not one request: a request to the Function App cannot carry
 * more than about 210 MB on any plan, and base64 JSON costs about 2.5 times
 * the file in memory. Why not a direct browser write to Storage: the account
 * is closed to the internet (ADR 0031) and stays so. The ADR records both.
 *
 * Every session has its own blob (`audioBlobPath`: `audio/<interviewId>/<uploadId>.<ext>`),
 * so two uploads for the same interview never share a blob or its block ids:
 * their blocks cannot interleave, and a completion checks and keeps or
 * deletes only its own blob. The document points at one verified recording
 * at a time; the ones it pointed at before are listed under `superseded` for
 * slice C's delete helper to sweep, and the lifecycle rule expires every
 * blob under `audio/` regardless.
 *
 * What is checked, and where (ADR 0040 D11):
 *   - the type is one of three audio types, with the same alias spellings the
 *     podcast upload accepts, and the file's extension must agree with it;
 *   - the declared size is 1 to MAX_AUDIO_BYTES, the declared duration is
 *     at most MAX_AUDIO_SECONDS (422 TOO_LONG; a missing one is 422
 *     DURATION_REQUIRED), and `Content-Length` is required on every block and
 *     must be exactly the block's expected length (a full block, or the
 *     remainder for the last one) before the body is read;
 *   - the block index is an integer within the session's block count;
 *   - a session belongs to the admin who opened it: a block or a completion
 *     from another oid answers 404, the same as an unknown id, so the route
 *     never says whether an upload exists;
 *   - a session read back from the document is re-derived at use and treated
 *     as absent unless every field is what `openUpload` would have minted,
 *     because the generic content update route can write `provenance` on the
 *     same role;
 *   - at completion the committed size and the SHA-256 of what Storage holds
 *     must equal the declaration, or the session's blob is deleted and the
 *     answer is 422; the recording the document already points at is untouched;
 *   - a second completion of the same upload answers 409 and changes nothing;
 *   - once the interview's deletion has started (the tombstone
 *     `provenance.audio.deletedAt`, written first by slice C's delete hook),
 *     open, block and complete answer 409 INTERVIEW_DELETED before storing
 *     anything, and a completion that read the document before the tombstone
 *     loses its ETag write, deletes the blob it committed and answers the same;
 *   - the content type is taken from the declaration the server validated,
 *     never from the body.
 *
 * Logs carry the upload id, the interview id, block indexes and byte counts.
 * Never a file name, a path with a name in it, or a hash. upload.test.js
 * asserts it.
 *
 * The sessions live on the interview's own content document (the CMS slice's
 * document; a bare `{ type: 'interview' }` is enough for this module) so there
 * is no second container to keep in step. Every write to it is under the
 * document's ETag through `patchDoc`'s `ifMatch`, and `provenance` is written
 * as one merged object rather than a nested path, because a JSON-pointer `set`
 * on `/provenance/audio/uploads` fails when `provenance` does not exist yet.
 */
import { randomUUID } from 'node:crypto';
import { INTERVIEWS_AUDIO_CONTAINER, audioBlobPath } from './storage.js';
import {
  BLOCK_SIZE,
  CONTENT_CONTAINER,
  INDEX_PATTERN,
  MAX_OPEN_SESSIONS,
  blockIdFor,
  blockLengthFor,
  isTombstoned,
  parseOpenBody,
  readContentLength,
} from './upload-checks.js';
import {
  findSession,
  interviewDeleted,
  json,
  ownerOf,
  sessionRefusal,
  sessionsOf,
  writeProvenance,
} from './upload-sessions.js';
import { completeUpload } from './upload-complete.js';

export {
  BLOCK_SIZE,
  CONTENT_CONTAINER,
  MAX_BLOCK_COUNT,
  MAX_OPEN_SESSIONS,
  UPLOAD_SOURCE,
  blockIdFor,
  blockLengthFor,
  isSoundSession,
  isTombstoned,
  ownsAudioPath,
  parseOpenBody,
} from './upload-checks.js';

/** A new open session for a checked upload, and the document's sessions with it (at most MAX_OPEN_SESSIONS). */
function openSession(deps, doc, oid, value) {
  const { interviewId, contentType, ext, bytes, sha256, durationSec } = value;
  const uploadId = deps.uuid();
  const blockCount = Math.ceil(bytes / BLOCK_SIZE);
  const session = {
    uploadId,
    ownerOid: oid,
    status: 'open',
    contentType,
    ext,
    bytes,
    sha256,
    durationSec,
    blockSize: BLOCK_SIZE,
    blockCount,
    path: audioBlobPath(interviewId, uploadId, ext),
    openedAt: deps.now().toISOString(),
  };
  const kept = sessionsOf(doc)
    .filter((s) => s && s.uploadId !== uploadId)
    .sort((a, b) => String(a.openedAt).localeCompare(String(b.openedAt)))
    .slice(-(MAX_OPEN_SESSIONS - 1));
  return { session, audio: { ...(doc.provenance?.audio ?? {}), uploads: [...kept, session] } };
}

/**
 * An open request checked: its body, and the interview it names. Answers
 * `{ doc, value }`, or `{ refusal }`: the body's 400 or 422, the 404 for no
 * such interview, the 409 for one being deleted.
 */
async function checkOpen({ store }, request) {
  const parsed = parseOpenBody(await request.json().catch(() => null));
  if (parsed.error) {
    return { refusal: json(parsed.status ?? 400, { error: parsed.error, ...(parsed.code ? { code: parsed.code } : {}) }) };
  }
  const { interviewId } = parsed.value;
  const doc = await store.readDoc(CONTENT_CONTAINER, interviewId, interviewId);
  if (!doc || doc.type !== 'interview') return { refusal: json(404, { error: 'Interview not found' }) };
  if (isTombstoned(doc)) return { refusal: interviewDeleted() };
  return { doc, value: parsed.value };
}

/**
 * POST /api/cms/interviews/uploads — open a session on an interview the
 * caller may edit. 201 { uploadId, blockSize, blockCount }. Up to
 * MAX_OPEN_SESSIONS sessions stay open on a document; the oldest is
 * dropped when a new one would exceed that.
 */
async function openUpload(deps, request, context) {
  const auth = await deps.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  const oid = ownerOf(auth);

  try {
    const found = await checkOpen(deps, request);
    if (found.refusal) return found.refusal;

    const { session, audio } = openSession(deps, found.doc, oid, found.value);
    await writeProvenance(deps, found.doc, audio);

    context.log?.(`interviewUploadOpen: opened (${session.bytes} B, ${session.blockCount} blocks)`);
    return json(201, { uploadId: session.uploadId, blockSize: BLOCK_SIZE, blockCount: session.blockCount });
  } catch (error) {
    if (error?.code === 412) return json(409, { error: 'The interview changed while the upload was opened; try again' });
    // Code or status only: a Storage or Cosmos message carries the request URL, which names the blob.
    context.error(`interviewUploadOpen failed (${error?.code ?? error?.statusCode ?? 'n/a'})`);
    return json(500, { error: 'Failed to open the upload' });
  }
}

/**
 * A block request checked before its body is read: the index, the
 * Content-Length, the caller's open session and the block's exact length.
 * Answers `{ session, index, expected }` or `{ refusal }`.
 */
async function checkBlock(deps, request, uploadId, oid) {
  const rawIndex = String(request.params?.index ?? '');
  if (!INDEX_PATTERN.test(rawIndex)) return { refusal: json(400, { error: 'Block index must be a whole number' }) };
  const index = Number.parseInt(rawIndex, 10);
  const contentLength = readContentLength(request);
  if (contentLength === null || Number.isNaN(contentLength)) {
    return { refusal: json(411, { error: 'Content-Length is required on a block' }) };
  }
  if (contentLength > BLOCK_SIZE) {
    return { refusal: json(413, { error: `A block is at most ${BLOCK_SIZE} bytes` }) };
  }
  const found = await findSession(deps, uploadId, oid);
  const missing = sessionRefusal(found);
  return missing ? { refusal: missing } : blockLength(found.session, index, contentLength);
}

/** The block's exact length in this session, or the 400 for an index past it or a length that is not that. */
function blockLength(session, index, contentLength) {
  if (index >= session.blockCount) {
    return { refusal: json(400, { error: `Block index must be below ${session.blockCount}` }) };
  }
  const expected = blockLengthFor(session.bytes, index, session.blockSize);
  if (contentLength !== expected) {
    return { refusal: json(400, { error: `Block ${index} must be exactly ${expected} bytes` }) };
  }
  return { session, index, expected };
}

/** Read the block's bytes and stage it; the 400 when the body is not the length it declared. */
async function stageBlock({ storage }, request, context, { session, index, expected }) {
  const bytes = Buffer.from(await request.arrayBuffer());
  if (bytes.length !== expected) {
    return json(400, { error: `Block ${index} must be exactly ${expected} bytes` });
  }
  await storage.stageBlock(INTERVIEWS_AUDIO_CONTAINER, session.path, blockIdFor(index), bytes);
  context.log?.(`interviewUploadBlock: block ${index} staged (${bytes.length} B)`);
  return json(200, { ok: true, index, bytes: bytes.length });
}

/**
 * PUT /api/cms/interviews/uploads/{uploadId}/blocks/{index} — one raw
 * block. `Content-Length` is required and must be the block's exact
 * length before the body is read; the index must be within the session.
 * 200 { ok, index, bytes }; the same index again overwrites the block.
 */
async function putBlock(deps, request, context) {
  const auth = await deps.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  const oid = ownerOf(auth);
  const uploadId = String(request.params?.uploadId || '');

  try {
    const block = await checkBlock(deps, request, uploadId, oid);
    if (block.refusal) return block.refusal;
    return await stageBlock(deps, request, context, block);
  } catch (error) {
    // Code or status only: a Storage or Cosmos message carries the request URL, which names the blob.
    context.error(`interviewUploadBlock failed (${error?.code ?? error?.statusCode ?? 'n/a'})`);
    return json(500, { error: 'Failed to store the block' });
  }
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ readDoc: Function, queryDocs: Function, patchDoc: Function }} deps.store
 * @param {{ stageBlock: Function, commitBlockList: Function, hashBlobSha256: Function, deleteBlob: Function }} deps.storage
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 */
export function createInterviewUploadHandlers({ guard, store, storage, now = () => new Date(), uuid = randomUUID }) {
  const deps = { guard, store, storage, now, uuid };
  return {
    openUpload: (request, context) => openUpload(deps, request, context),
    putBlock: (request, context) => putBlock(deps, request, context),
    completeUpload: (request, context) => completeUpload(deps, request, context),
  };
}
