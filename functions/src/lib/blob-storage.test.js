/**
 * Blob storage credential resolution.
 *
 * This file exists because of a gap, not a feature. `admin-uploads.test.js`
 * injects `{ uploadBlob: vi.fn() }`, so seven green tests reported that uploads
 * worked while the real module required STORAGE_CONNECTION_STRING — a setting
 * `infra/` has never produced — and therefore threw on every upload and every
 * gallery delete in a deployed app (T-104).
 *
 * The load-bearing assertions are therefore about configuration and credential
 * shape, the part no handler test can reach: that the module reads what
 * Terraform writes, and that no shared-key path survives.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  resolveBlobEndpoint,
  resolveAccountName,
  getBlobUrl,
  deleteBlob,
  headBlobForDelivery,
  parseContentRangeTotal,
  readBlobRangeForDelivery,
  resetBlobServiceForTests,
  uploadBlob,
  uploadBlobFromStream,
} from './blob-storage.js';
import { runAsJob } from './job-context.js';

const uploadSpy = vi.hoisted(() => vi.fn());
const downloadSpy = vi.hoisted(() => vi.fn());
const propertiesSpy = vi.hoisted(() => vi.fn());

// Only the service client is replaced. Everything else in the SDK — the SAS
// helpers this module imports at load time — stays real.
vi.mock('@azure/storage-blob', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    BlobServiceClient: class {
      getContainerClient() {
        return {
          getBlockBlobClient: (blobName) => ({
            url: `https://hcwmedia.blob.core.windows.net/c/${blobName}`,
            upload: uploadSpy,
          }),
          getBlobClient: () => ({
            download: downloadSpy,
            getProperties: propertiesSpy,
          }),
        };
      }
    },
  };
});

const MODULE_SOURCE = readFileSync(
  fileURLToPath(new URL('./blob-storage.js', import.meta.url)),
  'utf8'
);

// Comments explain what the module deliberately no longer does, and naming the
// retired settings there is the point. The guards below must read code only.
const MODULE_CODE = MODULE_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('resolveBlobEndpoint', () => {
  it('prefers STORAGE_BLOB_ENDPOINT, which is what Terraform sets', () => {
    expect(
      resolveBlobEndpoint({
        STORAGE_BLOB_ENDPOINT: 'https://hcwmedia.blob.core.windows.net/',
        STORAGE_ACCOUNT_NAME: 'ignored',
      })
    ).toBe('https://hcwmedia.blob.core.windows.net');
  });

  it('falls back to STORAGE_ACCOUNT_NAME', () => {
    expect(resolveBlobEndpoint({ STORAGE_ACCOUNT_NAME: 'hcwmedia' })).toBe(
      'https://hcwmedia.blob.core.windows.net'
    );
  });

  it('preserves a non-public-cloud suffix carried by the endpoint', () => {
    // The account-name fallback can only assume the public cloud. The endpoint
    // form is preferred precisely so sovereign clouds are not silently wrong.
    expect(
      resolveBlobEndpoint({
        STORAGE_BLOB_ENDPOINT: 'https://hcwmedia.blob.core.usgovcloudapi.net',
      })
    ).toBe('https://hcwmedia.blob.core.usgovcloudapi.net');
  });

  it('throws when neither setting is present', () => {
    expect(() => resolveBlobEndpoint({})).toThrow(/STORAGE_BLOB_ENDPOINT/);
  });

  it('does not accept a connection string as configuration', () => {
    expect(() =>
      resolveBlobEndpoint({
        STORAGE_CONNECTION_STRING:
          'DefaultEndpointsProtocol=https;AccountName=hcwmedia;AccountKey=deadbeef==;',
      })
    ).toThrow(/STORAGE_BLOB_ENDPOINT/);
  });
});

describe('resolveAccountName', () => {
  it('uses STORAGE_ACCOUNT_NAME when set', () => {
    expect(resolveAccountName({ STORAGE_ACCOUNT_NAME: 'hcwmedia' })).toBe('hcwmedia');
  });

  it('derives the account from the endpoint host', () => {
    expect(
      resolveAccountName({
        STORAGE_BLOB_ENDPOINT: 'https://hcwmedia.blob.core.windows.net',
      })
    ).toBe('hcwmedia');
  });

  it('throws when it can be derived from neither', () => {
    expect(() => resolveAccountName({})).toThrow(/STORAGE_ACCOUNT_NAME/);
  });
});

describe('getBlobUrl', () => {
  const original = { ...process.env };

  beforeEach(() => {
    resetBlobServiceForTests();
    process.env.STORAGE_BLOB_ENDPOINT = 'https://hcwmedia.blob.core.windows.net';
  });

  afterEach(() => {
    process.env = { ...original };
    resetBlobServiceForTests();
    vi.unstubAllEnvs();
  });

  it('composes from the configured endpoint rather than a hardcoded host', () => {
    expect(getBlobUrl('covers', 'post-1/cover.png')).toBe(
      'https://hcwmedia.blob.core.windows.net/covers/post-1/cover.png'
    );
  });

  it('follows the endpoint into another cloud', () => {
    process.env.STORAGE_BLOB_ENDPOINT = 'https://hcwmedia.blob.core.usgovcloudapi.net';
    expect(getBlobUrl('covers', 'a.png')).toBe(
      'https://hcwmedia.blob.core.usgovcloudapi.net/covers/a.png'
    );
  });
});

describe('uploadBlob overwrite conditions', () => {
  const original = { ...process.env };

  beforeEach(() => {
    uploadSpy.mockClear();
    resetBlobServiceForTests();
    process.env.STORAGE_BLOB_ENDPOINT = 'https://hcwmedia.blob.core.windows.net';
  });

  afterEach(() => {
    process.env = { ...original };
    resetBlobServiceForTests();
  });

  it('turns overwrite:false into If-None-Match: *', async () => {
    // The handler asking for the option is only half the fix; if this module
    // drops it, the caller-chosen path silently replaces a live asset and
    // admin-uploads.test.js still passes against its fake (T-307).
    await uploadBlob('covers', 'a/b.png', Buffer.from('x'), 'image/png', {}, { overwrite: false });
    expect(uploadSpy.mock.calls[0][2].conditions).toEqual({ ifNoneMatch: '*' });
  });

  it('sets no condition by default', async () => {
    // The AI-image and migration paths rewrite deterministic keys on purpose.
    await uploadBlob('covers', 'a/b.png', Buffer.from('x'), 'image/png');
    expect(uploadSpy.mock.calls[0][2].conditions).toBeUndefined();
  });

  it('sends the declared content type and the byte length', async () => {
    await uploadBlob('covers', 'a/b.png', Buffer.from('hello'), 'image/png');
    const [content, length, options] = uploadSpy.mock.calls[0];
    expect(content.toString()).toBe('hello');
    expect(length).toBe(5);
    expect(options.blobHTTPHeaders).toEqual({ blobContentType: 'image/png' });
  });
});

describe('a write a timed-out job starts is refused (#942 follow-up)', () => {
  const original = { ...process.env };

  beforeEach(() => {
    uploadSpy.mockClear();
    resetBlobServiceForTests();
    process.env.STORAGE_BLOB_ENDPOINT = 'https://hcwmedia.blob.core.windows.net';
  });

  afterEach(() => {
    process.env = { ...original };
    resetBlobServiceForTests();
  });

  it('refuses an upload or a delete that starts after the job’s signal fired, before Storage is reached', async () => {
    const job = new AbortController();
    job.abort(Object.assign(new Error('job timed out'), { code: 'JOB_TIMEOUT' }));
    await runAsJob(job.signal, async () => {
      await expect(uploadBlob('podcast', 'a.mp3', Buffer.from('x'), 'audio/mpeg')).rejects.toMatchObject({
        code: 'JOB_TIMEOUT',
      });
      await expect(
        uploadBlobFromStream('cosmos-export', 'a.gz', null, 4, 'application/gzip')
      ).rejects.toMatchObject({ code: 'JOB_TIMEOUT' });
      await expect(deleteBlob('podcast', 'a.mp3')).rejects.toMatchObject({ code: 'JOB_TIMEOUT' });
    });
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it('lets a job upload while its signal has not fired, and anything outside a job as before', async () => {
    const job = new AbortController();
    await runAsJob(job.signal, () => uploadBlob('podcast', 'a.mp3', Buffer.from('x'), 'audio/mpeg'));
    await uploadBlob('podcast', 'b.mp3', Buffer.from('y'), 'audio/mpeg');
    expect(uploadSpy).toHaveBeenCalledTimes(2);
  });
});

describe('parseContentRangeTotal', () => {
  it('reads the total from a ranged response', () => {
    expect(parseContentRangeTotal('bytes 0-99/1000')).toBe(1000);
    expect(parseContentRangeTotal('bytes */1000')).toBe(1000);
  });

  it('is null for an absent or malformed header, never zero', () => {
    expect(parseContentRangeTotal(undefined)).toBeNull();
    expect(parseContentRangeTotal('')).toBeNull();
    expect(parseContentRangeTotal('bytes 0-99/*')).toBeNull();
    expect(parseContentRangeTotal('items 0-99/1000')).toBeNull();
  });
});

describe('ranged delivery reads (#349)', () => {
  const original = { ...process.env };
  const FILE = Buffer.from('0123456789abcdef');

  /** A download response the way the SDK shapes it for `download(offset, count)`. */
  const rangedResponse = (start, end) => ({
    contentType: 'audio/mpeg',
    etag: '"0xR"',
    contentRange: `bytes ${start}-${end}/${FILE.length}`,
    contentLength: end - start + 1,
    readableStreamBody: (async function* () {
      yield FILE.subarray(start, end + 1);
    })(),
  });

  beforeEach(() => {
    downloadSpy.mockReset();
    propertiesSpy.mockReset();
    resetBlobServiceForTests();
    process.env.STORAGE_BLOB_ENDPOINT = 'https://hcwmedia.blob.core.windows.net';
  });

  afterEach(() => {
    process.env = { ...original };
    resetBlobServiceForTests();
  });

  it('asks the service for exactly the requested bytes, not the whole blob', async () => {
    downloadSpy.mockResolvedValueOnce(rangedResponse(4, 7));
    const out = await readBlobRangeForDelivery('listenandlearn', 'a/b/c.mp3', { start: 4, end: 7 });

    expect(downloadSpy).toHaveBeenCalledWith(4, 4);
    expect(out.body.toString()).toBe('4567');
    expect(out).toMatchObject({ start: 4, end: 7, totalLength: 16, contentType: 'audio/mpeg' });
    // The size came from Content-Range: a satisfiable range is one round trip.
    expect(propertiesSpy).not.toHaveBeenCalled();
  });

  it('reads the true size from properties when Content-Range is missing, at a non-zero start', async () => {
    // Guessing `start + body.length` here would say 8 for a 16-byte blob and
    // hand the client a Content-Range total that breaks every later seek.
    const response = rangedResponse(4, 7);
    delete response.contentRange;
    downloadSpy.mockResolvedValueOnce(response);
    propertiesSpy.mockResolvedValueOnce({
      contentLength: 16,
      etag: '"0xR"',
      contentType: 'audio/mpeg',
    });

    const out = await readBlobRangeForDelivery('listenandlearn', 'a/b/c.mp3', { start: 4, end: 7 });
    expect(out.totalLength).toBe(16);
    expect(out).toMatchObject({ start: 4, end: 7 });
    expect(propertiesSpy).toHaveBeenCalledTimes(1);
  });

  it('treats a malformed Content-Range the same way', async () => {
    downloadSpy.mockResolvedValueOnce({ ...rangedResponse(4, 7), contentRange: 'bytes 4-7/*' });
    propertiesSpy.mockResolvedValueOnce({
      contentLength: 16,
      etag: '"0xR"',
      contentType: 'audio/mpeg',
    });
    const out = await readBlobRangeForDelivery('listenandlearn', 'a/b/c.mp3', { start: 4, end: 7 });
    expect(out.totalLength).toBe(16);
    expect(propertiesSpy).toHaveBeenCalledTimes(1);
  });

  it('leaves the count open for a range with no end', async () => {
    downloadSpy.mockResolvedValueOnce(rangedResponse(12, 15));
    const out = await readBlobRangeForDelivery('listenandlearn', 'a/b/c.mp3', { start: 12 });

    expect(downloadSpy).toHaveBeenCalledWith(12, undefined);
    expect(out.body.toString()).toBe('cdef');
    expect(out.end).toBe(15);
  });

  it('derives the end from the bytes returned, so a clamped range is reported honestly', async () => {
    // Ask for 12-99 on a 16-byte blob: the service answers 12-15.
    downloadSpy.mockResolvedValueOnce(rangedResponse(12, 15));
    const out = await readBlobRangeForDelivery('listenandlearn', 'a/b/c.mp3', {
      start: 12,
      end: 99,
    });
    expect(out.end).toBe(15);
    expect(out.totalLength).toBe(16);
  });

  it('turns the service 416 into an unsatisfiable result carrying the size', async () => {
    downloadSpy.mockRejectedValueOnce(
      Object.assign(new Error('InvalidRange'), { statusCode: 416 })
    );
    propertiesSpy.mockResolvedValueOnce({
      contentLength: 16,
      etag: '"0xR"',
      contentType: 'audio/mpeg',
    });

    const out = await readBlobRangeForDelivery('listenandlearn', 'a/b/c.mp3', { start: 100 });
    expect(out).toEqual({ unsatisfiable: true, totalLength: 16 });
    // The size is fetched only on this path: a satisfiable range never pays
    // for a second round trip.
    expect(propertiesSpy).toHaveBeenCalledTimes(1);
  });

  it('is null for a missing blob and rethrows anything else', async () => {
    downloadSpy.mockRejectedValueOnce(Object.assign(new Error('nope'), { statusCode: 404 }));
    expect(await readBlobRangeForDelivery('listenandlearn', 'a/b/c.mp3', { start: 0 })).toBeNull();

    downloadSpy.mockRejectedValueOnce(Object.assign(new Error('denied'), { statusCode: 403 }));
    await expect(
      readBlobRangeForDelivery('listenandlearn', 'a/b/c.mp3', { start: 0 })
    ).rejects.toThrow('denied');
  });

  it('headBlobForDelivery reads properties only', async () => {
    propertiesSpy.mockResolvedValueOnce({
      contentLength: 16,
      etag: '"0xR"',
      contentType: 'audio/mpeg',
    });
    const out = await headBlobForDelivery('listenandlearn', 'a/b/c.mp3');
    expect(out).toEqual({ contentLength: 16, etag: '"0xR"', contentType: 'audio/mpeg' });
    expect(downloadSpy).not.toHaveBeenCalled();

    propertiesSpy.mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'BlobNotFound' }));
    expect(await headBlobForDelivery('listenandlearn', 'a/b/c.mp3')).toBeNull();
  });
});

describe('no shared-key credential path survives', () => {
  it('never reads a connection string or an account key', () => {
    // infra/ provisions neither, and adding either would put a storage key in
    // app settings — visible in the portal and in Terraform state.
    expect(MODULE_CODE).not.toContain('STORAGE_CONNECTION_STRING');
    expect(MODULE_CODE).not.toContain('STORAGE_ACCOUNT_KEY');
  });

  it('does not import StorageSharedKeyCredential or fromConnectionString', () => {
    expect(MODULE_CODE).not.toContain('StorageSharedKeyCredential');
    expect(MODULE_CODE).not.toContain('fromConnectionString');
  });

  it('authenticates with DefaultAzureCredential, as cosmos-client.js does', () => {
    expect(MODULE_CODE).toContain('DefaultAzureCredential');
  });

  it('signs SAS tokens with a user delegation key', () => {
    expect(MODULE_CODE).toContain('getUserDelegationKey');
  });
});
