/**
 * upload.js — a guest's recording reaches the private container in blocks
 * through the Function App (ADR 0040 D1, #1565).
 *
 *   browser → POST cms/interviews/uploads { interviewId, fileName, contentType, bytes, sha256 }
 *           → 201 { uploadId, blockSize, blockCount }; the session is written on the
 *             interview's content document at provenance.audio.upload
 *   browser → PUT cms/interviews/uploads/{uploadId}/blocks/{index}, one raw 4 MiB body each
 *           → Put Block on audio/<interviewId>.<ext>; re-sending an index overwrites it
 *   browser → POST cms/interviews/uploads/{uploadId}/complete
 *           → Put Block List in index order, size and SHA-256 checked against the
 *             declaration, provenance.audio written, the session cleared
 *
 * Why blocks and not one request: a request to the Function App cannot carry
 * more than about 210 MB on any plan, and base64 JSON costs about 2.5 times
 * the file in memory. Why not a direct browser write to Storage: the account
 * is closed to the internet (ADR 0031) and stays so. The ADR records both.
 *
 * What is checked, and where (ADR 0040 D11):
 *   - the type is one of three audio types, with the same alias spellings the
 *     podcast upload accepts, and the file's extension must agree with it;
 *   - the declared size is 1 to MAX_AUDIO_BYTES, and `Content-Length` is
 *     required on every block and must be exactly the block's expected length
 *     (a full block, or the remainder for the last one) before the body is read;
 *   - the block index is an integer within the session's block count;
 *   - a session belongs to the admin who opened it: a block or a completion
 *     from another oid answers 404, the same as an unknown id, so the route
 *     never says whether an upload exists;
 *   - at completion the committed size and the SHA-256 of what Storage holds
 *     must equal the declaration, or the blob is deleted and the answer is 422;
 *   - a second completion of the same upload answers 409 and changes nothing;
 *   - the content type is taken from the declaration the server validated,
 *     never from the body.
 *
 * Logs carry the upload id, the interview id, block indexes and byte counts.
 * Never a file name, a path with a name in it, or a hash. upload.test.js
 * asserts it.
 *
 * The session lives on the interview's own content document (the CMS slice's
 * document; a bare `{ type: 'interview' }` is enough for this module) so there
 * is no second container to keep in step. Every write to it is under the
 * document's ETag through `patchDoc`'s `ifMatch`, and `provenance` is written
 * as one merged object rather than a nested path, because a JSON-pointer `set`
 * on `/provenance/audio/upload` fails when `provenance` does not exist yet.
 */
import { randomUUID } from 'node:crypto';
import { AUDIO_TYPES, INTERVIEWS_AUDIO_CONTAINER, MAX_AUDIO_BYTES, audioBlobPath } from './storage.js';
import { isValidBlobPath } from '../blob-paths.js';

/** Bytes per block: the browser slices at this, and no request is larger. */
export const BLOCK_SIZE = 4 * 1024 * 1024;

/** The most blocks a file at the cap takes; bounds the index and the id width. */
export const MAX_BLOCK_COUNT = Math.ceil(MAX_AUDIO_BYTES / BLOCK_SIZE);

/** The content document's container, partitioned by `/id` like every item. */
export const CONTENT_CONTAINER = 'content';

/** Metadata `source` on the committed blob, so a listing says who wrote it. */
export const UPLOAD_SOURCE = 'interview-upload';

/** Interview ids become a blob path segment; one character class, bounded. */
const INTERVIEW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The spellings browsers send for each of the three types, folded to the
 * canonical type that is stored. The same list as the podcast upload
 * (lib/podcast/recording-upload.js), kept here so this module needs nothing
 * from the podcast's.
 */
const AUDIO_ALIASES = Object.freeze({
  'audio/mpeg': 'audio/mpeg',
  'audio/mp3': 'audio/mpeg',
  'audio/mp4': 'audio/mp4',
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/aac': 'audio/mp4',
  'audio/wav': 'audio/wav',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
});

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

function normalizeMediaType(value) {
  return String(value ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
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

  const contentType = AUDIO_ALIASES[normalizeMediaType(raw.contentType)];
  if (!contentType) {
    return { error: `Unsupported audio type; send an ${Object.values(AUDIO_TYPES).join(', ')} file` };
  }
  const ext = AUDIO_TYPES[contentType];
  if (extensionOf(raw.fileName) !== ext) {
    return { error: 'File extension does not match the declared audio type' };
  }

  const bytes = raw.bytes;
  if (!Number.isInteger(bytes) || bytes < 1) return { error: 'bytes must be a whole number of bytes, at least 1' };
  if (bytes > MAX_AUDIO_BYTES) {
    return { error: `File exceeds the ${Math.round(MAX_AUDIO_BYTES / 1024 / 1024)} MiB upload limit` };
  }

  const sha256 = typeof raw.sha256 === 'string' ? raw.sha256.trim().toLowerCase() : '';
  if (!SHA256_PATTERN.test(sha256)) return { error: 'sha256 must be the 64-character hex digest of the file' };

  const path = audioBlobPath(interviewId, ext);
  if (!isValidBlobPath(path)) return { error: 'interviewId is required' };

  return { value: { interviewId, contentType, ext, bytes, sha256 } };
}

/** The upload id the route carries: a v4 UUID this module minted, nothing else. */
const UPLOAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One or more digits, no sign, no decimals; the range check comes after. */
const INDEX_PATTERN = /^\d{1,4}$/;

function readContentLength(request) {
  const raw = request?.headers?.get?.('content-length');
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isInteger(parsed) && parsed >= 0 && String(parsed) === String(raw).trim() ? parsed : NaN;
}

/**
 * The document an open session, or a completed upload, with this id is on.
 * One indexed equality per call; the route carries no interview id, and a
 * caller-supplied interview id would be one more thing to check against the
 * session anyway.
 */
const FIND_QUERY =
  'SELECT TOP 1 * FROM c WHERE c.type = @type AND ' +
  '(c.provenance.audio.upload.uploadId = @uploadId OR c.provenance.audio.uploadId = @uploadId)';

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
   * open. Anything else — unknown id, another admin's session, a session
   * already completed — is `null` to the caller, except that a completed one
   * is reported so `completeUpload` can answer 409 rather than 404.
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
    const session = audio.upload && audio.upload.uploadId === uploadId ? audio.upload : null;
    if (session) {
      if (session.ownerOid !== oid || session.status !== 'open') return { doc: null, session: null, completed: false };
      return { doc, session, completed: false };
    }
    return { doc, session: null, completed: audio.uploadId === uploadId && audio.uploadedBy === oid };
  }

  /** Write `provenance` as one merged object under the document's ETag. */
  function writeProvenance(doc, audio, extra = {}) {
    const provenance = { ...(doc.provenance ?? {}), ...extra, audio };
    return store.patchDoc(CONTENT_CONTAINER, doc.id, { provenance }, { ifMatch: doc._etag });
  }

  /** Best effort: the caller is already answering a refusal. Status code only in the log. */
  async function discardBlob(path, context, label) {
    try {
      await storage.deleteBlob(INTERVIEWS_AUDIO_CONTAINER, path);
    } catch (err) {
      context.warn?.(`${label}: blob not deleted after a refused completion (${err?.code || err?.statusCode || 'error'})`);
    }
  }

  return {
    /**
     * POST /api/cms/interviews/uploads — open a session on an interview the
     * caller may edit. 201 { uploadId, blockSize, blockCount }. A session
     * already open on the document is replaced: the browser resumes by
     * re-sending the file (ADR 0040, consequences).
     */
    async openUpload(request, context) {
      const auth = await guard.requireRole(request, 'editor');
      if (auth.error) return auth.error;
      const oid = String(auth.user?.oid || auth.user?.sub || '');

      try {
        const parsed = parseOpenBody(await request.json().catch(() => null));
        if (parsed.error) return json(400, { error: parsed.error });
        const { interviewId, contentType, ext, bytes, sha256 } = parsed.value;

        const doc = await store.readDoc(CONTENT_CONTAINER, interviewId, interviewId);
        if (!doc || doc.type !== 'interview') return json(404, { error: 'Interview not found' });

        const blockCount = Math.ceil(bytes / BLOCK_SIZE);
        const session = {
          uploadId: uuid(),
          ownerOid: oid,
          status: 'open',
          contentType,
          ext,
          bytes,
          sha256,
          blockSize: BLOCK_SIZE,
          blockCount,
          path: audioBlobPath(interviewId, ext),
          openedAt: now().toISOString(),
        };
        const audio = { ...(doc.provenance?.audio ?? {}), upload: session };
        await writeProvenance(doc, audio);

        context.log?.(
          `interviewUploadOpen: ${session.uploadId} opened for ${interviewId} (${bytes} B, ${blockCount} blocks)`
        );
        return json(201, { uploadId: session.uploadId, blockSize: BLOCK_SIZE, blockCount });
      } catch (error) {
        if (error?.code === 412) return json(409, { error: 'The interview changed while the upload was opened; try again' });
        context.error(`interviewUploadOpen failed (${error?.code ?? error?.statusCode ?? 'n/a'}): ${error?.message || error}`);
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

        const { session } = await findSession(uploadId, oid);
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
        context.error(`interviewUploadBlock failed (${error?.code ?? error?.statusCode ?? 'n/a'}): ${error?.message || error}`);
        return json(500, { error: 'Failed to store the block' });
      }
    },

    /**
     * POST /api/cms/interviews/uploads/{uploadId}/complete — commit the blocks
     * in order, check size and SHA-256 against the declaration, write
     * provenance.audio and clear the session. 200 { ok, bytes, sha256,
     * contentType }; 422 with the blob deleted on a mismatch; 409 when the
     * upload was already completed.
     */
    async completeUpload(request, context) {
      const auth = await guard.requireRole(request, 'editor');
      if (auth.error) return auth.error;
      const oid = String(auth.user?.oid || auth.user?.sub || '');
      const uploadId = String(request.params?.uploadId || '');

      try {
        const { doc, session, completed } = await findSession(uploadId, oid);
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
          if (error?.code === 'InvalidBlockList' || error?.statusCode === 400) {
            context.warn?.(`interviewUploadComplete: ${uploadId} has missing blocks (${session.blockCount} expected)`);
            return json(422, { error: 'Not every block was uploaded; send the missing blocks and complete again' });
          }
          throw error;
        }

        if (committed.contentLength !== session.bytes) {
          await discardBlob(session.path, context, 'interviewUploadComplete');
          context.warn?.(
            `interviewUploadComplete: ${uploadId} size mismatch (${committed.contentLength} B stored, ${session.bytes} B declared)`
          );
          return json(422, { error: 'The uploaded size does not match the declared size; upload the file again' });
        }

        const digest = await storage.hashBlobSha256(INTERVIEWS_AUDIO_CONTAINER, session.path);
        if (digest !== session.sha256) {
          await discardBlob(session.path, context, 'interviewUploadComplete');
          context.warn?.(`interviewUploadComplete: ${uploadId} hash mismatch (${session.bytes} B)`);
          return json(422, { error: 'The uploaded file does not match its declared SHA-256; upload the file again' });
        }

        const previous = doc.provenance?.audio?.path;
        const audio = {
          container: INTERVIEWS_AUDIO_CONTAINER,
          path: session.path,
          bytes: session.bytes,
          sha256: session.sha256,
          contentType: session.contentType,
          uploadedAt: now().toISOString(),
          uploadedBy: oid,
          uploadId,
        };
        await writeProvenance(doc, audio, { source: 'upload' });

        // A recording of another type that was there before is now orphaned
        // under its own name; removed best-effort, the lifecycle rule is the
        // backstop.
        if (previous && previous !== session.path) await discardBlob(previous, context, 'interviewUploadComplete');

        context.log?.(
          `interviewUploadComplete: ${uploadId} committed for ${doc.id} (${session.bytes} B, ${session.blockCount} blocks)`
        );
        return json(200, { ok: true, bytes: session.bytes, sha256: session.sha256, contentType: session.contentType });
      } catch (error) {
        if (error?.code === 412) return json(409, { error: 'The interview changed while the upload was completed; try again' });
        context.error(`interviewUploadComplete failed (${error?.code ?? error?.statusCode ?? 'n/a'}): ${error?.message || error}`);
        return json(500, { error: 'Failed to complete the upload' });
      }
    },
  };
}
