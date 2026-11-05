/**
 * The block upload's boundaries (ADR 0040 D1 and D11, #1565): what is
 * refused, in which order, what reaches Storage, and that nothing in a log
 * line names a file, a path or a hash.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

import {
  BLOCK_SIZE,
  MAX_BLOCK_COUNT,
  blockIdFor,
  blockLengthFor,
  createInterviewUploadHandlers,
  parseOpenBody,
} from './upload.js';
import { INTERVIEWS_AUDIO_CONTAINER, MAX_AUDIO_BYTES } from './storage.js';

const OWNER = '00000000-0000-0000-0000-000000000011';
const OTHER = '00000000-0000-0000-0000-000000000022';
const UPLOAD_ID = '11111111-2222-4333-8444-555555555555';
const FILE_NAME = 'secret-guest-name.mp3';

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

const makeRequest = ({ body, headers = {}, params = {}, bytes } = {}) => ({
  params,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  json: async () => {
    if (body === undefined) throw new SyntaxError('no body');
    return body;
  },
  arrayBuffer: vi.fn(async () => {
    const b = bytes ?? Buffer.alloc(0);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }),
});

const context = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });

const guardFor = (oid) => ({
  requireRole: vi.fn(async () => ({ user: { oid }, role: 'editor', error: null })),
});
const denyingGuard = (status) => ({
  requireRole: vi.fn(async () => ({ user: null, role: null, error: { status, body: '{}' } })),
});

/** A store over an in-memory `content` container with ETags that move on write. */
const makeStore = (docs) => {
  const content = { ...docs };
  return {
    content,
    readDoc: vi.fn(async (container, id) => (container === 'content' ? content[id] ?? null : null)),
    queryDocs: vi.fn(async (container, query, parameters) => {
      const uploadId = parameters.find((p) => p.name === '@uploadId').value;
      return Object.values(content).filter(
        (d) =>
          d.type === 'interview' &&
          (d.provenance?.audio?.upload?.uploadId === uploadId || d.provenance?.audio?.uploadId === uploadId)
      );
    }),
    patchDoc: vi.fn(async (container, id, updates, options) => {
      const current = content[id];
      if (!current) throw Object.assign(new Error('missing'), { code: 404 });
      if (options?.ifMatch && options.ifMatch !== current._etag) {
        throw Object.assign(new Error('changed'), { code: 412 });
      }
      const next = { ...current, ...updates, _etag: `"${Number(current._etag.replace(/"/g, '')) + 1}"` };
      content[id] = next;
      return next;
    }),
  };
};

const makeStorage = () => ({
  stageBlock: vi.fn(async () => {}),
  commitBlockList: vi.fn(async () => ({ url: 'https://x/c/audio/int-1.mp3', contentLength: 0 })),
  hashBlobSha256: vi.fn(async () => null),
  deleteBlob: vi.fn(async () => {}),
});

const openBody = (overrides = {}) => ({
  interviewId: 'int-1',
  fileName: FILE_NAME,
  contentType: 'audio/mpeg',
  bytes: BLOCK_SIZE + 10,
  sha256: 'a'.repeat(64),
  ...overrides,
});

const sessionDoc = (overrides = {}) => ({
  id: 'int-1',
  type: 'interview',
  _etag: '"1"',
  provenance: {
    audio: {
      upload: {
        uploadId: UPLOAD_ID,
        ownerOid: OWNER,
        status: 'open',
        contentType: 'audio/mpeg',
        ext: 'mp3',
        bytes: BLOCK_SIZE + 10,
        sha256: 'a'.repeat(64),
        blockSize: BLOCK_SIZE,
        blockCount: 2,
        path: 'audio/int-1.mp3',
        openedAt: '2026-11-05T00:00:00.000Z',
        ...overrides,
      },
    },
  },
});

/** Every string every log method was handed, joined. */
const allLogText = (ctx) =>
  [...ctx.log.mock.calls, ...ctx.warn.mock.calls, ...ctx.error.mock.calls].map((c) => String(c[0])).join('\n');

describe('block arithmetic', () => {
  it('mints same-length base64 ids in index order, and bounds the count at the cap', () => {
    expect(blockIdFor(0)).toBe(Buffer.from('000000').toString('base64'));
    expect(blockIdFor(124)).toBe(Buffer.from('000124').toString('base64'));
    expect(blockIdFor(0).length).toBe(blockIdFor(124).length);
    expect(MAX_BLOCK_COUNT).toBe(125);
    expect(Math.ceil(MAX_AUDIO_BYTES / BLOCK_SIZE)).toBe(MAX_BLOCK_COUNT);
  });

  it('gives every block but the last the full size, and the last the remainder', () => {
    expect(blockLengthFor(BLOCK_SIZE + 10, 0)).toBe(BLOCK_SIZE);
    expect(blockLengthFor(BLOCK_SIZE + 10, 1)).toBe(10);
    expect(blockLengthFor(BLOCK_SIZE, 0)).toBe(BLOCK_SIZE);
    expect(blockLengthFor(1, 0)).toBe(1);
  });
});

describe('parseOpenBody', () => {
  it('accepts the three types with their alias spellings and canonicalises them', () => {
    expect(parseOpenBody(openBody({ contentType: 'audio/mp3' })).value.contentType).toBe('audio/mpeg');
    expect(parseOpenBody(openBody({ contentType: 'audio/x-m4a', fileName: 'a.m4a' })).value).toMatchObject({
      contentType: 'audio/mp4',
      ext: 'm4a',
    });
    expect(parseOpenBody(openBody({ contentType: 'audio/x-wav; charset=x', fileName: 'A.WAV' })).value).toMatchObject({
      contentType: 'audio/wav',
      ext: 'wav',
    });
  });

  it.each([
    ['audio/mpeg', 'audio/mpeg', 'mp3'],
    ['audio/mp3', 'audio/mpeg', 'mp3'],
    ['audio/mp4', 'audio/mp4', 'm4a'],
    ['audio/x-m4a', 'audio/mp4', 'm4a'],
    ['audio/m4a', 'audio/mp4', 'm4a'],
    ['audio/aac', 'audio/mp4', 'm4a'],
    ['audio/wav', 'audio/wav', 'wav'],
    ['audio/x-wav', 'audio/wav', 'wav'],
    ['audio/wave', 'audio/wav', 'wav'],
    ['audio/vnd.wave', 'audio/wav', 'wav'],
  ])('folds %s to %s before the type and extension checks (ADR 0040 D1)', (alias, canonical, ext) => {
    const parsed = parseOpenBody(openBody({ contentType: alias.toUpperCase(), fileName: `guest.${ext}` }));
    expect(parsed.value).toMatchObject({ contentType: canonical, ext });
    // The extension is checked against the canonical type, so a wrong one is refused on every spelling.
    const wrongExt = ext === 'mp3' ? 'wav' : 'mp3';
    expect(parseOpenBody(openBody({ contentType: alias, fileName: `guest.${wrongExt}` })).error).toMatch(/extension/);
  });

  it('refuses a bad type, a mismatched extension, an oversize or empty file and a bad hash', () => {
    expect(parseOpenBody(openBody({ contentType: 'video/mp4', fileName: 'a.mp4' })).error).toMatch(/Unsupported audio type/);
    expect(parseOpenBody(openBody({ fileName: 'a.wav' })).error).toMatch(/extension does not match/);
    expect(parseOpenBody(openBody({ bytes: MAX_AUDIO_BYTES + 1 })).error).toMatch(/500 MiB/);
    expect(parseOpenBody(openBody({ bytes: 0 })).error).toMatch(/at least 1/);
    expect(parseOpenBody(openBody({ bytes: 1.5 })).error).toMatch(/whole number/);
    expect(parseOpenBody(openBody({ sha256: 'xyz' })).error).toMatch(/sha256/);
    expect(parseOpenBody(openBody({ interviewId: '../x' })).error).toMatch(/interviewId/);
    expect(parseOpenBody(null).error).toMatch(/JSON object/);
  });

  it('accepts exactly the cap', () => {
    expect(parseOpenBody(openBody({ bytes: MAX_AUDIO_BYTES })).value.bytes).toBe(MAX_AUDIO_BYTES);
  });
});

describe('openUpload', () => {
  let store;
  let storage;
  let ctx;
  const handlers = (guard = guardFor(OWNER)) =>
    createInterviewUploadHandlers({
      guard,
      store,
      storage,
      now: () => new Date('2026-11-05T10:00:00.000Z'),
      uuid: () => UPLOAD_ID,
    });

  beforeEach(() => {
    store = makeStore({ 'int-1': { id: 'int-1', type: 'interview', _etag: '"1"' } });
    storage = makeStorage();
    ctx = context();
  });

  it('answers the guard refusal before reading the body', async () => {
    const request = makeRequest({ body: openBody() });
    request.json = vi.fn(request.json);
    const res = await handlers(denyingGuard(403)).openUpload(request, ctx);
    expect(res.status).toBe(403);
    expect(request.json).not.toHaveBeenCalled();
  });

  it('400s a bad type, an oversize file and a mismatched extension without touching the store', async () => {
    for (const body of [
      openBody({ contentType: 'text/html', fileName: 'a.html' }),
      openBody({ bytes: MAX_AUDIO_BYTES + 1 }),
      openBody({ fileName: 'a.m4a' }),
    ]) {
      const res = await handlers().openUpload(makeRequest({ body }), ctx);
      expect(res.status).toBe(400);
    }
    expect(store.readDoc).not.toHaveBeenCalled();
    expect(store.patchDoc).not.toHaveBeenCalled();
  });

  it('404s an interview that does not exist or is not an interview', async () => {
    store.content['blog-1'] = { id: 'blog-1', type: 'blog', _etag: '"1"' };
    expect((await handlers().openUpload(makeRequest({ body: openBody({ interviewId: 'nope' }) }), ctx)).status).toBe(404);
    expect((await handlers().openUpload(makeRequest({ body: openBody({ interviewId: 'blog-1' }) }), ctx)).status).toBe(404);
    expect(store.patchDoc).not.toHaveBeenCalled();
  });

  it('writes the session on a bare stub document under its ETag and answers the block plan', async () => {
    const res = await handlers().openUpload(makeRequest({ body: openBody() }), ctx);
    expect(res.status).toBe(201);
    expect(JSON.parse(res.body)).toEqual({ uploadId: UPLOAD_ID, blockSize: BLOCK_SIZE, blockCount: 2 });
    expect(store.patchDoc).toHaveBeenCalledWith(
      'content',
      'int-1',
      {
        provenance: {
          audio: {
            upload: {
              uploadId: UPLOAD_ID,
              ownerOid: OWNER,
              status: 'open',
              contentType: 'audio/mpeg',
              ext: 'mp3',
              bytes: BLOCK_SIZE + 10,
              sha256: 'a'.repeat(64),
              blockSize: BLOCK_SIZE,
              blockCount: 2,
              path: 'audio/int-1.mp3',
              openedAt: '2026-11-05T10:00:00.000Z',
            },
          },
        },
      },
      { ifMatch: '"1"' }
    );
    // The file name is neither stored nor logged.
    expect(JSON.stringify(store.content['int-1'])).not.toContain('secret-guest-name');
    expect(allLogText(ctx)).toContain(UPLOAD_ID);
    expect(allLogText(ctx)).toContain(`${BLOCK_SIZE + 10} B`);
    expect(allLogText(ctx)).not.toContain('secret-guest-name');
    expect(allLogText(ctx)).not.toContain('a'.repeat(64));
  });

  it('keeps the rest of provenance when a session is replaced', async () => {
    store.content['int-1'].provenance = { source: 'upload', audio: { path: 'audio/int-1.wav', upload: { uploadId: 'old' } } };
    await handlers().openUpload(makeRequest({ body: openBody() }), ctx);
    const written = store.patchDoc.mock.calls[0][2].provenance;
    expect(written.source).toBe('upload');
    expect(written.audio.path).toBe('audio/int-1.wav');
    expect(written.audio.upload.uploadId).toBe(UPLOAD_ID);
  });

  it('409s when the document moved under the write', async () => {
    store.patchDoc.mockRejectedValueOnce(Object.assign(new Error('changed'), { code: 412 }));
    const res = await handlers().openUpload(makeRequest({ body: openBody() }), ctx);
    expect(res.status).toBe(409);
  });

  it('500s with the safe sentence and a code-only log on any other failure', async () => {
    store.readDoc.mockRejectedValueOnce(Object.assign(new Error('cosmos said: secret-guest-name'), { code: 503 }));
    const res = await handlers().openUpload(makeRequest({ body: openBody() }), ctx);
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'Failed to open the upload' });
    expect(ctx.error).toHaveBeenCalledTimes(1);
    expect(ctx.error.mock.calls[0][0]).toMatch(/failed \(503\)/);
  });
});

describe('putBlock', () => {
  let store;
  let storage;
  let ctx;
  const handlers = (guard = guardFor(OWNER)) => createInterviewUploadHandlers({ guard, store, storage });
  const blockRequest = ({ index = '0', length = BLOCK_SIZE, bytes, uploadId = UPLOAD_ID, contentLength } = {}) =>
    makeRequest({
      params: { uploadId, index },
      headers: contentLength === null ? {} : { 'content-length': String(contentLength ?? length) },
      bytes: bytes ?? Buffer.alloc(length, 1),
    });

  beforeEach(() => {
    store = makeStore({ 'int-1': sessionDoc() });
    storage = makeStorage();
    ctx = context();
  });

  it('answers the guard refusal before anything else', async () => {
    const request = blockRequest();
    const res = await handlers(denyingGuard(401)).putBlock(request, ctx);
    expect(res.status).toBe(401);
    expect(store.queryDocs).not.toHaveBeenCalled();
    expect(request.arrayBuffer).not.toHaveBeenCalled();
  });

  it('requires Content-Length, and refuses one above a block, before looking the session up', async () => {
    expect((await handlers().putBlock(blockRequest({ contentLength: null }), ctx)).status).toBe(411);
    expect((await handlers().putBlock(blockRequest({ contentLength: 'abc' }), ctx)).status).toBe(411);
    expect((await handlers().putBlock(blockRequest({ contentLength: BLOCK_SIZE + 1 }), ctx)).status).toBe(413);
    expect(store.queryDocs).not.toHaveBeenCalled();
    expect(storage.stageBlock).not.toHaveBeenCalled();
  });

  it('404s an unknown upload id, a malformed one, and another admin’s session, without reading the body', async () => {
    const unknown = blockRequest({ uploadId: '99999999-2222-4333-8444-555555555555' });
    expect((await handlers().putBlock(unknown, ctx)).status).toBe(404);
    expect((await handlers().putBlock(blockRequest({ uploadId: 'not-a-uuid' }), ctx)).status).toBe(404);
    const foreign = blockRequest();
    expect((await handlers(guardFor(OTHER)).putBlock(foreign, ctx)).status).toBe(404);
    expect(unknown.arrayBuffer).not.toHaveBeenCalled();
    expect(foreign.arrayBuffer).not.toHaveBeenCalled();
    expect(storage.stageBlock).not.toHaveBeenCalled();
  });

  it('404s a session that is no longer open', async () => {
    store.content['int-1'] = sessionDoc({ status: 'complete' });
    expect((await handlers().putBlock(blockRequest(), ctx)).status).toBe(404);
  });

  it('400s an index out of range or malformed', async () => {
    expect((await handlers().putBlock(blockRequest({ index: '2', length: 10 }), ctx)).status).toBe(400);
    expect((await handlers().putBlock(blockRequest({ index: '-1' }), ctx)).status).toBe(400);
    expect((await handlers().putBlock(blockRequest({ index: '1.5' }), ctx)).status).toBe(400);
    expect(storage.stageBlock).not.toHaveBeenCalled();
  });

  it('400s a block whose Content-Length is not the exact expected length, before reading it', async () => {
    const short = blockRequest({ index: '0', length: BLOCK_SIZE - 1 });
    expect((await handlers().putBlock(short, ctx)).status).toBe(400);
    expect(short.arrayBuffer).not.toHaveBeenCalled();
    // The last block is the remainder (10), so a full block there is too long.
    const long = blockRequest({ index: '1', length: BLOCK_SIZE });
    expect((await handlers().putBlock(long, ctx)).status).toBe(400);
    expect(long.arrayBuffer).not.toHaveBeenCalled();
    expect(storage.stageBlock).not.toHaveBeenCalled();
  });

  it('400s a body whose real length disagrees with its Content-Length', async () => {
    const lying = blockRequest({ index: '1', contentLength: 10, bytes: Buffer.alloc(9) });
    expect((await handlers().putBlock(lying, ctx)).status).toBe(400);
    expect(storage.stageBlock).not.toHaveBeenCalled();
  });

  it('stages a full block and the last short block with padded ids, on the session’s path', async () => {
    const first = Buffer.alloc(BLOCK_SIZE, 7);
    const last = Buffer.alloc(10, 9);
    expect((await handlers().putBlock(blockRequest({ index: '0', bytes: first }), ctx)).status).toBe(200);
    const res = await handlers().putBlock(blockRequest({ index: '1', length: 10, bytes: last }), ctx);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, index: 1, bytes: 10 });
    expect(storage.stageBlock.mock.calls.map((c) => [c[0], c[1], c[2], c[3].length])).toEqual([
      [INTERVIEWS_AUDIO_CONTAINER, 'audio/int-1.mp3', blockIdFor(0), BLOCK_SIZE],
      [INTERVIEWS_AUDIO_CONTAINER, 'audio/int-1.mp3', blockIdFor(1), 10],
    ]);
    expect(allLogText(ctx)).toContain(`${UPLOAD_ID} block 1 staged (10 B)`);
    expect(allLogText(ctx)).not.toContain('audio/int-1');
    expect(allLogText(ctx)).not.toContain('a'.repeat(64));
  });

  it('500s with the safe sentence when Storage refuses', async () => {
    storage.stageBlock.mockRejectedValueOnce(Object.assign(new Error('boom audio/int-1.mp3'), { statusCode: 503 }));
    const res = await handlers().putBlock(blockRequest(), ctx);
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'Failed to store the block' });
  });
});

describe('completeUpload', () => {
  let store;
  let storage;
  let ctx;
  const content = Buffer.concat([Buffer.alloc(BLOCK_SIZE, 1), Buffer.alloc(10, 2)]);
  const digest = sha256(content);
  const handlers = (guard = guardFor(OWNER)) =>
    createInterviewUploadHandlers({ guard, store, storage, now: () => new Date('2026-11-05T11:00:00.000Z') });
  const completeRequest = (uploadId = UPLOAD_ID) => makeRequest({ params: { uploadId } });

  beforeEach(() => {
    store = makeStore({ 'int-1': sessionDoc({ sha256: digest }) });
    storage = makeStorage();
    storage.commitBlockList.mockResolvedValue({ url: 'https://x/c/audio/int-1.mp3', contentLength: content.length });
    storage.hashBlobSha256.mockResolvedValue(digest);
    ctx = context();
  });

  it('answers the guard refusal first', async () => {
    expect((await handlers(denyingGuard(403)).completeUpload(completeRequest(), ctx)).status).toBe(403);
    expect(store.queryDocs).not.toHaveBeenCalled();
  });

  it('404s an unknown id and another admin’s session', async () => {
    expect((await handlers().completeUpload(completeRequest('99999999-2222-4333-8444-555555555555'), ctx)).status).toBe(404);
    expect((await handlers(guardFor(OTHER)).completeUpload(completeRequest(), ctx)).status).toBe(404);
    expect(storage.commitBlockList).not.toHaveBeenCalled();
  });

  it('commits the padded ids in order with the declared type, writes provenance.audio and clears the session', async () => {
    const res = await handlers().completeUpload(completeRequest(), ctx);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, bytes: content.length, sha256: digest, contentType: 'audio/mpeg' });
    expect(storage.commitBlockList).toHaveBeenCalledWith(INTERVIEWS_AUDIO_CONTAINER, 'audio/int-1.mp3', [blockIdFor(0), blockIdFor(1)], {
      contentType: 'audio/mpeg',
      metadata: { source: 'interview-upload', uploadedBy: OWNER, interviewId: 'int-1' },
    });
    expect(storage.hashBlobSha256).toHaveBeenCalledWith(INTERVIEWS_AUDIO_CONTAINER, 'audio/int-1.mp3');
    expect(store.patchDoc).toHaveBeenCalledWith(
      'content',
      'int-1',
      {
        provenance: {
          source: 'upload',
          audio: {
            container: INTERVIEWS_AUDIO_CONTAINER,
            path: 'audio/int-1.mp3',
            bytes: content.length,
            sha256: digest,
            contentType: 'audio/mpeg',
            uploadedAt: '2026-11-05T11:00:00.000Z',
            uploadedBy: OWNER,
            uploadId: UPLOAD_ID,
          },
        },
      },
      { ifMatch: '"1"' }
    );
    expect(store.content['int-1'].provenance.audio.upload).toBeUndefined();
    expect(storage.deleteBlob).not.toHaveBeenCalled();
    expect(allLogText(ctx)).toContain(`${UPLOAD_ID} committed for int-1 (${content.length} B, 2 blocks)`);
    expect(allLogText(ctx)).not.toContain(digest);
    expect(allLogText(ctx)).not.toContain('audio/int-1');
  });

  it('409s a second completion and commits nothing again', async () => {
    expect((await handlers().completeUpload(completeRequest(), ctx)).status).toBe(200);
    storage.commitBlockList.mockClear();
    const res = await handlers().completeUpload(completeRequest(), ctx);
    expect(res.status).toBe(409);
    expect(storage.commitBlockList).not.toHaveBeenCalled();
    expect(store.patchDoc).toHaveBeenCalledTimes(1);
  });

  it('422s a size mismatch, deletes the blob and keeps the session', async () => {
    storage.commitBlockList.mockResolvedValueOnce({ url: 'u', contentLength: content.length - 1 });
    const res = await handlers().completeUpload(completeRequest(), ctx);
    expect(res.status).toBe(422);
    expect(JSON.parse(res.body).error).toMatch(/size/);
    expect(storage.deleteBlob).toHaveBeenCalledWith(INTERVIEWS_AUDIO_CONTAINER, 'audio/int-1.mp3');
    expect(storage.hashBlobSha256).not.toHaveBeenCalled();
    expect(store.patchDoc).not.toHaveBeenCalled();
    expect(store.content['int-1'].provenance.audio.upload.status).toBe('open');
  });

  it('422s a hash mismatch, deletes the blob and keeps the session', async () => {
    storage.hashBlobSha256.mockResolvedValueOnce('b'.repeat(64));
    const res = await handlers().completeUpload(completeRequest(), ctx);
    expect(res.status).toBe(422);
    expect(JSON.parse(res.body).error).toMatch(/SHA-256/);
    expect(storage.deleteBlob).toHaveBeenCalledWith(INTERVIEWS_AUDIO_CONTAINER, 'audio/int-1.mp3');
    expect(store.patchDoc).not.toHaveBeenCalled();
    expect(allLogText(ctx)).toContain('hash mismatch');
    expect(allLogText(ctx)).not.toContain('b'.repeat(64));
    expect(allLogText(ctx)).not.toContain(digest);
  });

  it('422s when Storage reports a block missing, leaving the session open to finish', async () => {
    storage.commitBlockList.mockRejectedValueOnce(Object.assign(new Error('InvalidBlockList'), { statusCode: 400, code: 'InvalidBlockList' }));
    const res = await handlers().completeUpload(completeRequest(), ctx);
    expect(res.status).toBe(422);
    expect(JSON.parse(res.body).error).toMatch(/missing blocks/);
    expect(storage.deleteBlob).not.toHaveBeenCalled();
    expect(store.content['int-1'].provenance.audio.upload.status).toBe('open');
  });

  it('a failed delete after a refusal is logged by status code and does not change the 422', async () => {
    storage.commitBlockList.mockResolvedValueOnce({ url: 'u', contentLength: 1 });
    storage.deleteBlob.mockRejectedValueOnce(Object.assign(new Error('nope audio/int-1.mp3'), { statusCode: 503 }));
    const res = await handlers().completeUpload(completeRequest(), ctx);
    expect(res.status).toBe(422);
    const warned = ctx.warn.mock.calls.map((c) => c[0]).join('\n');
    expect(warned).toMatch(/blob not deleted after a refused completion \(503\)/);
    expect(warned).not.toContain('audio/int-1');
  });

  it('removes a previous recording of another type after the new one is committed', async () => {
    store.content['int-1'].provenance.audio.path = 'audio/int-1.wav';
    const res = await handlers().completeUpload(completeRequest(), ctx);
    expect(res.status).toBe(200);
    expect(storage.deleteBlob).toHaveBeenCalledWith(INTERVIEWS_AUDIO_CONTAINER, 'audio/int-1.wav');
  });

  it('409s when the document moved under the write', async () => {
    store.patchDoc.mockRejectedValueOnce(Object.assign(new Error('changed'), { code: 412 }));
    expect((await handlers().completeUpload(completeRequest(), ctx)).status).toBe(409);
  });

  it('500s with the safe sentence and a code-only log on any other failure', async () => {
    storage.commitBlockList.mockRejectedValueOnce(Object.assign(new Error('storage said audio/int-1.mp3'), { statusCode: 503 }));
    const res = await handlers().completeUpload(completeRequest(), ctx);
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'Failed to complete the upload' });
    expect(ctx.error.mock.calls[0][0]).toMatch(/failed \(503\)/);
  });
});
