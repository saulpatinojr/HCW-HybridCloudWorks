/**
 * Import-from-URL's pure parts (PR #841 split of gallery-images.js): the
 * refusals, the guarded fetch's status mapping, the file name and the blob
 * path. The route itself stays pinned in gallery-images.test.js.
 */
import { describe, it, expect, vi } from 'vitest';
import { fetchForImport, importBlobPath, importFileName, importRefusal } from './import.js';
import { FetchRefusedError } from '../http/guarded-fetch.js';

describe('importRefusal', () => {
  it('refuses a non-http(s) URL before looking at the route', () => {
    expect(importRefusal('ftp://x/y.png', { uploadBlob: vi.fn() })).toEqual({
      ok: false,
      status: 400,
      error: 'url must be http(s)',
    });
  });

  it('answers 503 when the route has no blob upload', () => {
    expect(importRefusal('https://x/y.png', {})).toMatchObject({ status: 503 });
    expect(importRefusal('https://x/y.png', { uploadBlob: vi.fn() })).toBeNull();
  });
});

describe('fetchForImport', () => {
  it("maps a thrown fetch to 422 by its code, never the socket's sentence (#945)", async () => {
    const fetchImage = vi.fn(async (url) => {
      throw Object.assign(new Error(`timed out reading ${url}`), { code: 'FETCH_TIMEOUT' });
    });
    const result = await fetchForImport(fetchImage, 'https://example.test/a.png');
    expect(result).toEqual({
      ok: false,
      status: 422,
      error: 'Could not fetch image: the request failed (FETCH_TIMEOUT)',
    });
  });

  it("keeps the guard's own refusal, with the URL redacted", async () => {
    const url = 'https://example.test/a.png';
    const fetchImage = vi.fn(async () => {
      throw new FetchRefusedError(`Only https is fetched here: ${url}`);
    });
    expect(await fetchForImport(fetchImage, url)).toEqual({
      ok: false,
      status: 422,
      error: 'Could not fetch image: Only https is fetched here: [url]',
    });
  });

  it('maps a refused fetch to 415 and passes bytes through otherwise', async () => {
    const refused = await fetchForImport(
      async () => ({ refused: true, reason: 'not an image' }),
      'https://x/y'
    );
    expect(refused).toEqual({ ok: false, status: 415, error: 'not an image' });
    const buffer = Buffer.from('png');
    const ok = await fetchForImport(
      async () => ({ buffer, contentType: 'image/png' }),
      'https://x/y'
    );
    expect(ok).toEqual({ ok: true, buffer, contentType: 'image/png' });
  });
});

describe('importFileName and importBlobPath', () => {
  it('reads the last path segment without its extension, decoded', () => {
    expect(importFileName('https://cdn.test/a/b/My%20Diagram.PNG?x=1')).toBe('My Diagram');
    expect(importFileName('not a url')).toBe('');
    expect(importFileName('https://cdn.test/')).toBe('');
  });

  it('stamps and slugs the blob path under image-gallery/imports', () => {
    expect(importBlobPath('Hello, World!', 'png', '2026-10-03T12:34:56.789Z')).toBe(
      'image-gallery/imports/20261003123456-hello-world.png'
    );
    expect(importBlobPath('***', 'jpg', '2026-10-03T12:34:56.789Z')).toBe(
      'image-gallery/imports/20261003123456-import.jpg'
    );
  });
});
