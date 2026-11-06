/**
 * `downloadBlobStream` (ADR 0040 D3): a recording of up to 500 MiB is read
 * as a stream with its size and type, never buffered, and a missing blob is
 * a throw. Its own file beside blob-storage.test.js so the two slices that
 * add to that file (A: stageBlock and commitBlockList; B: this) do not meet
 * on the same lines.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';

const downloadSpy = vi.hoisted(() => vi.fn());
const blobClientSpy = vi.hoisted(() => vi.fn());

vi.mock('@azure/storage-blob', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    BlobServiceClient: class {
      getContainerClient() {
        return {
          getBlobClient: (blobName) => {
            blobClientSpy(blobName);
            return { download: downloadSpy };
          },
        };
      }
    },
  };
});

const { downloadBlobStream, resetBlobServiceForTests } = await import('./blob-storage.js');

describe('downloadBlobStream', () => {
  const original = { ...process.env };
  beforeEach(() => {
    resetBlobServiceForTests();
    process.env.STORAGE_BLOB_ENDPOINT = 'https://hcwmedia.blob.core.windows.net';
    downloadSpy.mockReset();
    blobClientSpy.mockReset();
  });
  afterEach(() => {
    process.env = { ...original };
    resetBlobServiceForTests();
  });

  it('answers the SDK’s body stream with the size and type, reading from offset 0 of the named blob', async () => {
    const body = Readable.from([Buffer.from('abc')]);
    downloadSpy.mockResolvedValueOnce({ readableStreamBody: body, contentLength: '6', contentType: 'audio/mpeg' });
    const result = await downloadBlobStream('interviews-audio', 'audio/int-1.mp3');
    expect(result).toEqual({ stream: body, contentLength: 6, contentType: 'audio/mpeg' });
    expect(blobClientSpy).toHaveBeenCalledWith('audio/int-1.mp3');
    expect(downloadSpy).toHaveBeenCalledWith(0);
  });

  it('defaults a missing type to octet-stream and a missing length to 0', async () => {
    downloadSpy.mockResolvedValueOnce({ readableStreamBody: Readable.from([]) });
    await expect(downloadBlobStream('interviews-audio', 'audio/x.mp3')).resolves.toMatchObject({ contentLength: 0, contentType: 'application/octet-stream' });
  });

  it('a missing blob is a throw, not a null: the document named it', async () => {
    downloadSpy.mockRejectedValueOnce(Object.assign(new Error('BlobNotFound'), { statusCode: 404, code: 'BlobNotFound' }));
    await expect(downloadBlobStream('interviews-audio', 'audio/missing.mp3')).rejects.toMatchObject({ code: 'BlobNotFound' });
  });
});
