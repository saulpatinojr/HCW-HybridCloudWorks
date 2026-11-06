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
import {
  AUDIO_TYPES,
  INTERVIEWS_AUDIO_CONTAINER,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_SECONDS,
  audioBlobPath,
  canonicalAudioType,
} from './storage.js';
import { isValidBlobPath } from '../blob-paths.js';

/** Bytes per block: the browser slices at this, and no request is larger. */
export const BLOCK_SIZE = 4 * 1024 * 1024;

/** The most blocks a file at the cap takes; bounds the index and the id width. */
export const MAX_BLOCK_COUNT = Math.ceil(MAX_AUDIO_BYTES / BLOCK_SIZE);

/** The content document's container, partitioned by `/id` like every item. */
export const CONTENT_CONTAINER = 'content';

/** Metadata `source` on the committed blob, so a listing says who wrote it. */
export const UPLOAD_SOURCE = 'interview-upload';

/**
 * Open sessions a document keeps at once. A browser that lost its tab opens
 * a new one and the oldest falls off; the blocks it staged are dropped by
 * Storage a week after the last Put Block.
 */
export const MAX_OPEN_SESSIONS = 4;

/** Interview ids become a blob path segment; one character class, bounded. */
const INTERVIEW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** The upload id the route carries: a v4 UUID this module minted, nothing else. */
const UPLOAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One or more digits, no sign, no decimals; the range check comes after. */
const INDEX_PATTERN = /^\d{1,4}$/;

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * The block id Storage sees for an index: base64 of the zero-padded index,
 * so every id of one blob has the same length (a Put Block List rule) and
 * sorts in content order. Six digits leaves room well past MAX_BLOCK_COUNT.
 *
 * @param {number} index
 * @returns {string}
 */
export function blockIdFor(index) {
  return Buffer.from(String(index).padStart(6, '0'), 'ascii').toString('base64');
}

/**
 * How long block `index` of a `bytes`-long file must be: a full block, or
 * the remainder for the last one. The declared size fixes every length, so a
 * block that is short or long is refused before it is staged.
 *
 * @param {number} bytes
 * @param {number} index
 * @param {number} [blockSize]
 * @returns {number}
 */
export function blockLengthFor(bytes, index, blockSize = BLOCK_SIZE) {
  const count = Math.ceil(bytes / blockSize);
  return index < count - 1 ? blockSize : bytes - (count - 1) * blockSize;
}

function extensionOf(fileName) {
  const segment = String(fileName || '')
    .split(/[\\/]/)
    .pop();
  const dot = segment.lastIndexOf('.');
  if (dot <= 0 || dot === segment.length - 1) return '';
  return segment.slice(dot + 1).toLowerCase();
}

/**
 * Validate the body that opens an upload.
 *
 * @param {unknown} body
 * @returns {{ error: string } | { value: { interviewId: string, contentType: string, ext: string, bytes: number, sha256: string } }}
 *   `error` is a sentence written here, never an error's message.
 */
export function parseOpenBody(body) {
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!raw) return { error: 'Body must be a JSON object' };

  const interviewId = typeof raw.interviewId === 'string' ? raw.interviewId.trim() : '';
  if (!INTERVIEW_ID_PATTERN.test(interviewId)) return { error: 'interviewId is required' };

  // Alias spellings (audio/mp3, audio/x-m4a, ...) fold to the canonical type
  // before the type and extension checks (ADR 0040 D1). Strings only: an
  // object whose toString is null would throw inside String() and turn a bad
  // body into a 500.
  const contentType = typeof raw.contentType === 'string' ? canonicalAudioType(raw.contentType) : null;
  if (!contentType) {
    return { error: `Unsupported audio type; send an ${Object.values(AUDIO_TYPES).join(', ')} file` };
  }
  const ext = AUDIO_TYPES[contentType];
  if (typeof raw.fileName !== 'string' || extensionOf(raw.fileName) !== ext) {
    return { error: 'File extension does not match the declared audio type' };
  }

  const bytes = raw.bytes;
  if (!Number.isInteger(bytes) || bytes < 1) return { error: 'bytes must be a whole number of bytes, at least 1' };
  if (bytes > MAX_AUDIO_BYTES) {
    return { error: `File exceeds the ${Math.round(MAX_AUDIO_BYTES / 1024 / 1024)} MiB upload limit` };
  }

  const sha256 = typeof raw.sha256 === 'string' ? raw.sha256.trim().toLowerCase() : '';
  if (!SHA256_PATTERN.test(sha256)) return { error: 'sha256 must be the 64-character hex digest of the file' };

  // The browser reads the duration from the file's metadata; a file whose
  // duration cannot be read is refused, and one longer than Gemini takes in
  // one prompt (MAX_AUDIO_SECONDS) is refused with TOO_LONG before a byte is
  // stored. Both are 422: the request is well formed, the file is not fit.
  const durationSec = raw.durationSec;
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= 0) {
    return {
      error: 'durationSec is required: the length of the recording in seconds',
      code: 'DURATION_REQUIRED',
      status: 422,
    };
  }
  if (durationSec > MAX_AUDIO_SECONDS) {
    return {
      error: `The recording is longer than ${MAX_AUDIO_SECONDS} seconds (9.5 hours), the most one transcription can take`,
      code: 'TOO_LONG',
      status: 422,
    };
  }

  return { value: { interviewId, contentType, ext, bytes, sha256, durationSec } };
}

/**
 * Whether a session read back from the document is one this module wrote.
 *
 * The session is trusted at use, and the document it sits on can be edited
 * through the generic content update route by the same role, so every field
 * the block and complete paths rely on is re-derived here from the document
 * id, the session's own id and the three constants rather than taken on
 * faith: a session whose path, type, extension, size or block plan is not
 * exactly what `openUpload` would have minted is treated as absent (404).
 * Exported for its test.
 *
 * @param {{ id: string }} doc
 * @param {object} session
 * @returns {boolean}
 */
export function isSoundSession(doc, session) {
  if (!session || typeof session !== 'object') return false;
  const { uploadId, contentType, ext, bytes, blockSize, blockCount, path, durationSec } = session;
  if (!INTERVIEW_ID_PATTERN.test(String(doc?.id || ''))) return false;
  if (!UPLOAD_ID_PATTERN.test(String(uploadId || ''))) return false;
  if (canonicalAudioType(contentType) !== contentType || AUDIO_TYPES[contentType] !== ext) return false;
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > MAX_AUDIO_BYTES) return false;
  if (typeof durationSec !== 'number' || !(durationSec > 0) || durationSec > MAX_AUDIO_SECONDS) return false;
  if (blockSize !== BLOCK_SIZE || blockCount !== Math.ceil(bytes / BLOCK_SIZE)) return false;
  if (path !== audioBlobPath(doc.id, uploadId, ext) || !isValidBlobPath(path)) return false;
  return SHA256_PATTERN.test(String(session.sha256 || ''));
}

/**
 * Whether a blob path is one this module could have minted for this
 * interview: `audio/<interviewId>/<uploadId>.<ext>` with a UUID and one of
 * the three extensions. Used before a path read back from the document is
 * carried into `superseded`. Exported for its test.
 *
 * @param {string} interviewId
 * @param {unknown} path
 * @returns {boolean}
 */
export function ownsAudioPath(interviewId, path) {
  if (typeof path !== 'string' || !INTERVIEW_ID_PATTERN.test(String(interviewId || ''))) return false;
  const prefix = `audio/${interviewId}/`;
  if (!path.startsWith(prefix) || !isValidBlobPath(path)) return false;
  const rest = path.slice(prefix.length);
  const dot = rest.lastIndexOf('.');
  if (dot <= 0) return false;
  const uploadId = rest.slice(0, dot);
  const ext = rest.slice(dot + 1);
  return UPLOAD_ID_PATTERN.test(uploadId) && Object.values(AUDIO_TYPES).includes(ext);
}

function readContentLength(request) {
  const raw = request?.headers?.get?.('content-length');
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isInteger(parsed) && parsed >= 0 && String(parsed) === String(raw).trim() ? parsed : NaN;
}

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

/**
 * Whether the interview's deletion has started. The delete hook (slice C)
 * first writes `provenance.audio.deletedAt` under the document's ETag, then
 * sweeps the interview's whole `audio/<interviewId>/` prefix (ADR 0040 D10).
 * Every route here refuses a tombstoned document with 409 INTERVIEW_DELETED
 * before it stores anything, and a completion that read the document before
 * the tombstone loses its ETag write and deletes the blob it committed.
 *
 * @param {object|null|undefined} doc
 * @returns {boolean}
 */
export function isTombstoned(doc) {
  const at = doc?.provenance?.audio?.deletedAt;
  return typeof at === 'string' ? at.length > 0 : Boolean(at);
}

/** The 409 every route answers once the interview's deletion has started. */
const interviewDeleted = () =>
  json(409, { error: 'This interview is being deleted; the upload was not kept', code: 'INTERVIEW_DELETED' });

const sessionsOf = (doc) => {
  const list = doc?.provenance?.audio?.uploads;
  return Array.isArray(list) ? list : [];
};

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ readDoc: Function, queryDocs: Function, patchDoc: Function }} deps.store
 * @param {{ stageBlock: Function, commitBlockList: Function, hashBlobSha256: Function, deleteBlob: Function }} deps.storage
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 */
export function createInterviewUploadHandlers({ guard, store, storage, now = () => new Date(), uuid = randomUUID }) {
  /**
   * Find the session for an upload id that the caller owns and that is still
   * open. Anything else — unknown id, another admin's session, a forged
   * session, an upload already completed — is `null` to the caller, except
   * that a completed one is reported so `completeUpload` can answer 409
   * rather than 404.
   */
  async function findSession(uploadId, oid) {
    if (!UPLOAD_ID_PATTERN.test(String(uploadId || ''))) return { doc: null, session: null, completed: false };
    const rows = await store.queryDocs(CONTENT_CONTAINER, FIND_QUERY, [
      { name: '@type', value: 'interview' },
      { name: '@uploadId', value: uploadId },
    ]);
    const doc = Array.isArray(rows) ? rows[0] : null;
    if (!doc) return { doc: null, session: null, completed: false };
    const audio = doc.provenance?.audio ?? {};
    const session = sessionsOf(doc).find((s) => s && s.uploadId === uploadId) ?? null;
    if (session) {
      if (session.ownerOid !== oid || session.status !== 'open' || !isSoundSession(doc, session)) {
        return { doc: null, session: null, completed: false };
      }
      // Reported only to the session's own admin; anyone else still gets 404.
      if (isTombstoned(doc)) return { doc, session: null, completed: false, deleted: true };
      return { doc, session, completed: false };
    }
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
  async function deletedSinceRead(doc) {
    const fresh = await store.readDoc(CONTENT_CONTAINER, doc.id, doc.id);
    return !fresh || isTombstoned(fresh);
  }

  /** Write `provenance` as one merged object under the document's ETag. */
  function writeProvenance(doc, audio, extra = {}) {
    const provenance = { ...(doc.provenance ?? {}), ...extra, audio };
    return store.patchDoc(CONTENT_CONTAINER, doc.id, { provenance }, { ifMatch: doc._etag });
  }

  /** Best effort: the caller is already answering. Status code only in the log. */
  async function discardBlob(path, context, label, why) {
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

  return {
    /**
     * POST /api/cms/interviews/uploads — open a session on an interview the
     * caller may edit. 201 { uploadId, blockSize, blockCount }. Up to
     * MAX_OPEN_SESSIONS sessions stay open on a document; the oldest is
     * dropped when a new one would exceed that.
     */
    async openUpload(request, context) {
      const auth = await guard.requireRole(request, 'editor');
      if (auth.error) return auth.error;
      const oid = String(auth.user?.oid || auth.user?.sub || '');

      try {
        const parsed = parseOpenBody(await request.json().catch(() => null));
        if (parsed.error) {
          return json(parsed.status ?? 400, { error: parsed.error, ...(parsed.code ? { code: parsed.code } : {}) });
        }
        const { interviewId, contentType, ext, bytes, sha256, durationSec } = parsed.value;

        const doc = await store.readDoc(CONTENT_CONTAINER, interviewId, interviewId);
        if (!doc || doc.type !== 'interview') return json(404, { error: 'Interview not found' });
        if (isTombstoned(doc)) return interviewDeleted();

        const uploadId = uuid();
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
          openedAt: now().toISOString(),
        };
        const kept = sessionsOf(doc)
          .filter((s) => s && s.uploadId !== uploadId)
          .sort((a, b) => String(a.openedAt).localeCompare(String(b.openedAt)))
          .slice(-(MAX_OPEN_SESSIONS - 1));
        const audio = { ...(doc.provenance?.audio ?? {}), uploads: [...kept, session] };
        await writeProvenance(doc, audio);

        context.log?.(`interviewUploadOpen: ${uploadId} opened for ${interviewId} (${bytes} B, ${blockCount} blocks)`);
        return json(201, { uploadId, blockSize: BLOCK_SIZE, blockCount });
      } catch (error) {
        if (error?.code === 412) return json(409, { error: 'The interview changed while the upload was opened; try again' });
        // Code or status only: a Storage or Cosmos message carries the request URL, which names the blob.
        context.error(`interviewUploadOpen failed (${error?.code ?? error?.statusCode ?? 'n/a'})`);
        return json(500, { error: 'Failed to open the upload' });
      }
    },

    /**
     * PUT /api/cms/interviews/uploads/{uploadId}/blocks/{index} — one raw
     * block. `Content-Length` is required and must be the block's exact
     * length before the body is read; the index must be within the session.
     * 200 { ok, index, bytes }; the same index again overwrites the block.
     */
    async putBlock(request, context) {
      const auth = await guard.requireRole(request, 'editor');
      if (auth.error) return auth.error;
      const oid = String(auth.user?.oid || auth.user?.sub || '');
      const uploadId = String(request.params?.uploadId || '');
      const rawIndex = String(request.params?.index ?? '');

      try {
        if (!INDEX_PATTERN.test(rawIndex)) return json(400, { error: 'Block index must be a whole number' });
        const index = Number.parseInt(rawIndex, 10);

        const contentLength = readContentLength(request);
        if (contentLength === null || Number.isNaN(contentLength)) {
          return json(411, { error: 'Content-Length is required on a block' });
        }
        if (contentLength > BLOCK_SIZE) {
          return json(413, { error: `A block is at most ${BLOCK_SIZE} bytes` });
        }

        const { session, deleted } = await findSession(uploadId, oid);
        if (deleted) return interviewDeleted();
        if (!session) return json(404, { error: 'Upload not found' });

        if (index >= session.blockCount) {
          return json(400, { error: `Block index must be below ${session.blockCount}` });
        }
        const expected = blockLengthFor(session.bytes, index, session.blockSize);
        if (contentLength !== expected) {
          return json(400, { error: `Block ${index} must be exactly ${expected} bytes` });
        }

        const bytes = Buffer.from(await request.arrayBuffer());
        if (bytes.length !== expected) {
          return json(400, { error: `Block ${index} must be exactly ${expected} bytes` });
        }

        await storage.stageBlock(INTERVIEWS_AUDIO_CONTAINER, session.path, blockIdFor(index), bytes);
        context.log?.(`interviewUploadBlock: ${uploadId} block ${index} staged (${bytes.length} B)`);
        return json(200, { ok: true, index, bytes: bytes.length });
      } catch (error) {
        // Code or status only: a Storage or Cosmos message carries the request URL, which names the blob.
        context.error(`interviewUploadBlock failed (${error?.code ?? error?.statusCode ?? 'n/a'})`);
        return json(500, { error: 'Failed to store the block' });
      }
    },

    /**
     * POST /api/cms/interviews/uploads/{uploadId}/complete — commit the blocks
     * in order, check size and SHA-256 against the declaration, point
     * provenance.audio at the new blob, drop the session and remove the
     * recording the document pointed at before. 200 { ok, bytes, sha256,
     * contentType }; 422 with the session's blob deleted on a mismatch; 409
     * when the upload was already completed.
     */
    async completeUpload(request, context) {
      const auth = await guard.requireRole(request, 'editor');
      if (auth.error) return auth.error;
      const oid = String(auth.user?.oid || auth.user?.sub || '');
      const uploadId = String(request.params?.uploadId || '');

      try {
        const { doc, session, completed, deleted } = await findSession(uploadId, oid);
        // A tombstone read before the commit: nothing is committed.
        if (deleted) return interviewDeleted();
        if (completed) return json(409, { error: 'This upload was already completed' });
        if (!session) return json(404, { error: 'Upload not found' });

        const blockIds = Array.from({ length: session.blockCount }, (_, i) => blockIdFor(i));
        let committed;
        try {
          committed = await storage.commitBlockList(INTERVIEWS_AUDIO_CONTAINER, session.path, blockIds, {
            contentType: session.contentType,
            metadata: { source: UPLOAD_SOURCE, uploadedBy: oid, interviewId: doc.id },
          });
        } catch (error) {
          if (error?.code === 'InvalidBlockList') {
            context.warn?.(`interviewUploadComplete: ${uploadId} has missing blocks (${session.blockCount} expected)`);
            return json(422, { error: 'Not every block was uploaded; send the missing blocks and complete again' });
          }
          throw error;
        }

        // A mismatch deletes this session's blob and nothing else: the
        // recording the document already points at has its own name and is
        // untouched. The session stays open for the retry.
        //
        // Fenced against a second completion of the same session: before the
        // blob is deleted, the session's refusal count is written under the
        // document ETag this completion read. If another completion wrote
        // the document in between (it published this very blob after a
        // retry re-staged the blocks), that write answers 412, the outer
        // catch maps it to 409, and nothing is deleted; and once this write
        // has landed, the other completion's publish fails the same way, so
        // a blob is never deleted after it was published.
        const refuse = async (sentence, line) => {
          const fenced = sessionsOf(doc).map((s) =>
            s && s.uploadId === uploadId
              ? { ...s, refusals: (Number.isInteger(s.refusals) ? s.refusals : 0) + 1, lastRefusedAt: now().toISOString() }
              : s
          );
          try {
            await writeProvenance(doc, { ...(doc.provenance?.audio ?? {}), uploads: fenced });
          } catch (error) {
            if (error?.code !== 412 || !(await deletedSinceRead(doc))) throw error;
            await discardBlob(session.path, context, 'interviewUploadComplete', 'after the interview was deleted');
            context.warn?.(`interviewUploadComplete: ${uploadId} refused; the interview's deletion started meanwhile`);
            return interviewDeleted();
          }
          await discardBlob(session.path, context, 'interviewUploadComplete', 'after a refused completion');
          context.warn?.(line);
          return json(422, { error: sentence });
        };

        if (committed.contentLength !== session.bytes) {
          return await refuse(
            'The uploaded size does not match the declared size; upload the file again',
            `interviewUploadComplete: ${uploadId} size mismatch (${committed.contentLength} B stored, ${session.bytes} B declared)`
          );
        }

        const digest = await storage.hashBlobSha256(INTERVIEWS_AUDIO_CONTAINER, session.path);
        if (digest !== session.sha256) {
          return await refuse(
            'The uploaded file does not match its declared SHA-256; upload the file again',
            `interviewUploadComplete: ${uploadId} hash mismatch (${session.bytes} B)`
          );
        }

        // The pointer moves. The recording the document pointed at until now
        // is recorded under `superseded` rather than deleted here: slice C's
        // delete helper (deleteBlobWithVersions, which is why the identity
        // holds Storage Blob Data Owner on this container, infra/storage.tf)
        // sweeps that list when the interview or its recording is deleted,
        // and the lifecycle rule expires every blob under audio/ regardless.
        // Only a path this module could have minted for this interview is
        // carried forward: the document is editable through the generic
        // content update route by the same role, and a planted path would
        // otherwise reach slice C's sweeper as something to delete.
        const before = doc.provenance?.audio ?? {};
        const superseded = (Array.isArray(before.superseded) ? before.superseded : []).filter((p) =>
          ownsAudioPath(doc.id, p)
        );
        if (
          before.path &&
          before.path !== session.path &&
          ownsAudioPath(doc.id, before.path) &&
          !superseded.includes(before.path)
        ) {
          superseded.push(before.path);
        }
        const uploads = sessionsOf(doc).filter((s) => s && s.uploadId !== uploadId);
        const audio = {
          container: INTERVIEWS_AUDIO_CONTAINER,
          path: session.path,
          bytes: session.bytes,
          sha256: session.sha256,
          contentType: session.contentType,
          durationSec: session.durationSec,
          uploadedAt: now().toISOString(),
          uploadedBy: oid,
          uploadId,
          superseded,
          ...(uploads.length > 0 ? { uploads } : {}),
        };
        try {
          await writeProvenance(doc, audio, { source: 'upload' });
        } catch (error) {
          // The pointer write lost its ETag. If the interview's deletion
          // started after this completion read the document, the blob just
          // committed is deleted here, since the delete hook may already have
          // listed the prefix; any other writer leaves it for the retry.
          if (error?.code === 412 && (await deletedSinceRead(doc))) {
            await discardBlob(session.path, context, 'interviewUploadComplete', 'after the interview was deleted');
            context.warn?.(`interviewUploadComplete: ${uploadId} committed; the interview's deletion started meanwhile, blob removed`);
            return interviewDeleted();
          }
          throw error;
        }

        context.log?.(
          `interviewUploadComplete: ${uploadId} committed for ${doc.id} (${session.bytes} B, ${session.blockCount} blocks)`
        );
        return json(200, { ok: true, bytes: session.bytes, sha256: session.sha256, contentType: session.contentType });
      } catch (error) {
        if (error?.code === 412) return json(409, { error: 'The interview changed while the upload was completed; try again' });
        // Code or status only: a Storage or Cosmos message carries the request URL, which names the blob.
        context.error(`interviewUploadComplete failed (${error?.code ?? error?.statusCode ?? 'n/a'})`);
        return json(500, { error: 'Failed to complete the upload' });
      }
    },
  };
}
