import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { ChangeFeedMode, StatusCodes } from '@azure/cosmos';

import {
  createCosmosReader,
  createExportBlobStore,
  UPLOAD_BUFFER_BYTES,
} from './cosmos-export-edges.js';

/** A container whose query and change feed hand back scripted responses. */
function fakeContainer({ pages = [], feed = [] }) {
  const seen = { query: [], changeFeed: [] };
  return {
    seen,
    items: {
      query: (sql, opts) => {
        seen.query.push({ sql, opts });
        let i = 0;
        return {
          hasMoreResults: () => i < pages.length,
          fetchNext: async () => ({ resources: pages[i++] }),
        };
      },
      getChangeFeedIterator: (opts) => {
        seen.changeFeed.push(opts);
        let i = 0;
        return {
          hasMoreResults: true,
          readNext: async () => feed[i++],
        };
      },
    },
  };
}

describe('createCosmosReader', () => {
  it('queryPages walks fetchNext until the iterator is exhausted and skips empty pages', async () => {
    const container = fakeContainer({ pages: [[{ id: 1 }], [], [{ id: 2 }, { id: 3 }]] });
    const reader = createCosmosReader({ getContainer: () => container });
    const out = [];
    for await (const page of reader.queryPages('content', 'SELECT * FROM c', { maxItemCount: 2 }))
      out.push(page);
    expect(out).toEqual([[{ id: 1 }], [{ id: 2 }, { id: 3 }]]);
    expect(container.seen.query).toEqual([{ sql: 'SELECT * FROM c', opts: { maxItemCount: 2 } }]);
  });

  it('changeFeedPages resumes from the continuation in latest-version mode and stops on 304, yielding its token', async () => {
    const container = fakeContainer({
      feed: [
        { statusCode: 200, result: [{ id: 'a' }], continuationToken: 't1' },
        { statusCode: StatusCodes.NotModified, result: [], continuationToken: 't2' },
        { statusCode: 200, result: [{ id: 'never' }], continuationToken: 't3' },
      ],
    });
    const reader = createCosmosReader({ getContainer: () => container });
    const out = [];
    for await (const page of reader.changeFeedPages(
      'blogs',
      { continuation: 'tok-0' },
      { maxItemCount: 7 }
    ))
      out.push(page);
    expect(out).toEqual([
      { items: [{ id: 'a' }], continuationToken: 't1' },
      { items: [], continuationToken: 't2' },
    ]);
    const [opts] = container.seen.changeFeed;
    expect(opts.maxItemCount).toBe(7);
    expect(opts.changeFeedMode).toBe(ChangeFeedMode.LatestVersion);
    // ChangeFeedStartFrom.Continuation carries the token it was built from.
    expect(JSON.stringify(opts.changeFeedStartFrom)).toContain('tok-0');
  });

  it('an empty 200 page does not end the feed: only 304 does, and the last token is the one kept', async () => {
    // The pull model can answer an empty 200 while more changes remain
    // (Copilot review on #394, Microsoft Learn change-feed-pull-model).
    const container = fakeContainer({
      feed: [
        { statusCode: 200, result: [{ id: 'a' }], continuationToken: 't1' },
        { statusCode: 200, result: [], continuationToken: 't2' },
        { statusCode: 200, result: [{ id: 'b' }, { id: 'c' }], continuationToken: 't3' },
        { statusCode: StatusCodes.NotModified, result: [], continuationToken: 't4' },
        { statusCode: 200, result: [{ id: 'never' }], continuationToken: 't5' },
      ],
    });
    const reader = createCosmosReader({ getContainer: () => container });
    const pages = [];
    for await (const page of reader.changeFeedPages(
      'blogs',
      { continuation: 'tok-0' },
      { maxItemCount: 2 }
    ))
      pages.push(page);
    expect(pages.flatMap((p) => p.items.map((d) => d.id))).toEqual(['a', 'b', 'c']);
    expect(pages.map((p) => p.continuationToken)).toEqual(['t1', 't2', 't3', 't4']);
    expect(pages[pages.length - 1].continuationToken).toBe('t4');
  });

  it('changeFeedPages with no continuation starts from the beginning', async () => {
    const container = fakeContainer({
      feed: [{ statusCode: StatusCodes.NotModified, result: [], continuationToken: 't' }],
    });
    const reader = createCosmosReader({ getContainer: () => container });
    const out = [];
    for await (const page of reader.changeFeedPages(
      'blogs',
      { continuation: null },
      { maxItemCount: 1 }
    ))
      out.push(page);
    expect(out).toEqual([{ items: [], continuationToken: 't' }]);
    expect(JSON.stringify(container.seen.changeFeed[0].changeFeedStartFrom)).not.toContain('tok');
  });

  it('changeFeedCheckpoint reads once from Now() and returns the token', async () => {
    const container = fakeContainer({
      feed: [{ statusCode: StatusCodes.NotModified, result: [], continuationToken: 'now-tok' }],
    });
    const reader = createCosmosReader({ getContainer: () => container });
    expect(await reader.changeFeedCheckpoint('content')).toBe('now-tok');
    expect(container.seen.changeFeed[0].maxItemCount).toBe(1);
  });
});

describe('createExportBlobStore', () => {
  function fakeStorage(existing = {}) {
    const blobs = new Map(Object.entries(existing));
    return {
      blobs,
      uploadBlobFromStream: vi.fn(async () => 'https://x/y'),
      uploadBlob: vi.fn(async (_c, name, body, _ct, _meta, { overwrite } = {}) => {
        if (overwrite === false && blobs.has(name)) {
          throw Object.assign(new Error('BlobAlreadyExists'), {
            statusCode: 409,
            code: 'BlobAlreadyExists',
          });
        }
        blobs.set(name, body);
        return 'https://x/y';
      }),
      readBlobForDelivery: vi.fn(async (_c, name) =>
        blobs.has(name) ? { body: blobs.get(name) } : null
      ),
      listBlobs: vi.fn(async (_c, prefix) =>
        [...blobs.keys()].filter((n) => n.startsWith(prefix)).map((name) => ({ name }))
      ),
    };
  }

  it('uploads the gzip stream to the cosmos-export container at the requested tier', async () => {
    const storage = fakeStorage();
    const store = createExportBlobStore({ storage });
    const stream = Readable.from(['x']);
    await store.uploadGzipStream('full/2026-09-13/content.ndjson.gz', stream, {
      tier: 'Cool',
      metadata: { runId: 'r' },
    });
    expect(storage.uploadBlobFromStream).toHaveBeenCalledWith(
      'cosmos-export',
      'full/2026-09-13/content.ndjson.gz',
      stream,
      UPLOAD_BUFFER_BYTES,
      'application/gzip',
      { tier: 'Cool', metadata: { runId: 'r' } }
    );
  });

  it('putJson returns false on BlobAlreadyExists only when overwrite is off; readJson returns null when absent', async () => {
    const storage = fakeStorage();
    const store = createExportBlobStore({ storage });
    expect(await store.putJson('a.json', { n: 1 }, { overwrite: false })).toBe(true);
    expect(await store.putJson('a.json', { n: 2 }, { overwrite: false })).toBe(false);
    expect(await store.readJson('a.json')).toEqual({ n: 1 });
    expect(await store.putJson('a.json', { n: 3 })).toBe(true);
    expect(await store.readJson('a.json')).toEqual({ n: 3 });
    expect(await store.readJson('missing.json')).toBeNull();
    expect(storage.uploadBlob.mock.calls[0][3]).toBe('application/json');
  });

  it('putJson rethrows anything that is not the exists conflict', async () => {
    const storage = fakeStorage();
    storage.uploadBlob = vi.fn(async () => {
      throw Object.assign(new Error('AuthorizationPermissionMismatch'), { statusCode: 403 });
    });
    const store = createExportBlobStore({ storage });
    await expect(store.putJson('a.json', {}, { overwrite: false })).rejects.toThrow(
      /AuthorizationPermissionMismatch/
    );
  });

  it('listNames lists by prefix in the export container', async () => {
    const storage = fakeStorage({
      'full/2026-09-13/a.marker.json': '{}',
      'delta/2026-09-14/b.marker.json': '{}',
    });
    const store = createExportBlobStore({ storage });
    expect(await store.listNames('full/2026-09-13/')).toEqual(['full/2026-09-13/a.marker.json']);
    expect(storage.listBlobs).toHaveBeenCalledWith('cosmos-export', 'full/2026-09-13/');
  });

  it('routes state/ blobs to cosmos-export-state by default while run blobs stay in cosmos-export (PLAT-8, #968)', async () => {
    const storage = fakeStorage();
    const store = createExportBlobStore({ storage });
    await store.putJson('state/content.json', { token: 't1' });
    expect(storage.uploadBlob).toHaveBeenCalledWith(
      'cosmos-export-state',
      'state/content.json',
      expect.any(Buffer),
      'application/json',
      {},
      { overwrite: true }
    );

    await store.readJson('state/content.json');
    expect(storage.readBlobForDelivery).toHaveBeenCalledWith('cosmos-export-state', 'state/content.json');

    await store.putJson('full/2026-09-13/manifest.json', { runId: '2026-09-13' });
    expect(storage.uploadBlob).toHaveBeenCalledWith(
      'cosmos-export',
      'full/2026-09-13/manifest.json',
      expect.any(Buffer),
      'application/json',
      {},
      { overwrite: true }
    );
  });

  it('allows overriding stateContainer explicitly', async () => {
    const storage = fakeStorage();
    const store = createExportBlobStore({ storage, stateContainer: 'custom-state-container' });
    await store.putJson('state/content.json', { token: 't1' });
    expect(storage.uploadBlob).toHaveBeenCalledWith(
      'custom-state-container',
      'state/content.json',
      expect.any(Buffer),
      'application/json',
      {},
      { overwrite: true }
    );
  });
});
