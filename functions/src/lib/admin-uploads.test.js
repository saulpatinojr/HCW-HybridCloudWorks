/**
 * Admin uploads — the load-bearing assertions are the negative ones: an
 * unauthenticated or role-denied request must never reach storage, and the
 * blob path is attacker-influenced input that becomes a storage key.
 */
import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import { BADGE_SIZE, normalizeBadgeImage, withExtension } from './badge-image.js';
import {
  createAdminUploadHandlers,
  extensionOf,
  isValidBlobPath,
  MAX_BASE64_CHARS,
  MAX_REQUEST_BYTES,
  normalizeMediaType,
  UPLOAD_CONTAINERS,
} from './admin-uploads.js';

const context = { log: vi.fn(), error: vi.fn() };

const allowGuard = () => ({
  requireRole: vi.fn(async () => ({ user: { uid: 'u1' }, role: 'editor' })),
});
const denyGuard = () => ({
  requireRole: vi.fn(async () => ({
    error: { status: 403, body: JSON.stringify({ error: 'Forbidden' }) },
  })),
});

const makeRequest = ({ container = 'certifications', body = {}, contentLength } = {}) => ({
  method: 'POST',
  params: { container },
  headers: {
    get: (name) =>
      name.toLowerCase() === 'content-length' && contentLength !== undefined
        ? String(contentLength)
        : null,
  },
  json: async () => body,
});

// A real 1 × 1 PNG: `certifications` is a normalised container, so its
// uploads are decoded before they are stored and a fake payload is a 415.
const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const validBody = () => ({
  path: 'cert-1/images/badge-123.png',
  contentType: 'image/png',
  dataBase64: ONE_PIXEL_PNG,
});

describe('isValidBlobPath', () => {
  it('accepts the naming scheme the pages use', () => {
    expect(isValidBlobPath('cert-1/images/badge-1700000000.png')).toBe(true);
    expect(isValidBlobPath('a.png')).toBe(true);
  });

  it('rejects traversal, absolute, trailing-slash, and oversized paths', () => {
    expect(isValidBlobPath('../secrets')).toBe(false);
    expect(isValidBlobPath('a/../b.png')).toBe(false);
    expect(isValidBlobPath('/etc/passwd')).toBe(false);
    expect(isValidBlobPath('dir/')).toBe(false);
    expect(isValidBlobPath('')).toBe(false);
    expect(isValidBlobPath('a'.repeat(301))).toBe(false);
    expect(isValidBlobPath('with space.png')).toBe(false);
  });
});

describe('uploadFile', () => {
  it('uploads to the named container and returns a URL that will serve', async () => {
    const storage = { uploadBlob: vi.fn(async () => 'https://acct.blob/x/y.png') };
    const h = createAdminUploadHandlers({ guard: allowGuard(), storage });
    const res = await h.uploadFile(makeRequest({ body: validBody() }), context);
    const parsed = JSON.parse(res.body);

    // NOT the raw blob URL. The account is closed to the internet and
    // allow_nested_items_to_be_public overrides container access, so that URL
    // is dead (T-105). `url` is what pages persist into Cosmos.
    expect(parsed.url).toBe('/api/public/media/certifications/cert-1/images/badge-123.png');
    expect(parsed.blobUrl).toBe('https://acct.blob/x/y.png');

    const [container, path, buffer, contentType] = storage.uploadBlob.mock.calls[0];
    expect(container).toBe('certifications');
    expect(path).toBe('cert-1/images/badge-123.png');
    expect(Buffer.isBuffer(buffer)).toBe(true);
    // Stored normalised, not as sent: a BADGE_SIZE square PNG (badge-image.js).
    const meta = await sharp(buffer).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['png', BADGE_SIZE, BADGE_SIZE]);
    expect(contentType).toBe('image/png');
  });

  it('returns no URL for a container that is not publicly served', async () => {
    // A plausible-looking dead URL persisted into Cosmos is worse than none:
    // the page renders a broken image and nothing indicates why.
    const storage = { uploadBlob: vi.fn(async () => 'https://acct.blob/x/y.png') };
    const h = createAdminUploadHandlers({ guard: allowGuard(), storage });
    const res = await h.uploadFile(
      makeRequest({ container: 'content', body: validBody() }),
      context
    );
    const parsed = JSON.parse(res.body);

    expect(res.status).toBe(200);
    expect(parsed.url).toBe('');
    expect(parsed.blobUrl).toBe('https://acct.blob/x/y.png');
  });

  it('denial makes zero storage calls', async () => {
    const storage = { uploadBlob: vi.fn() };
    const h = createAdminUploadHandlers({ guard: denyGuard(), storage });
    const res = await h.uploadFile(makeRequest({ body: validBody() }), context);
    expect(res.status).toBe(403);
    expect(storage.uploadBlob).not.toHaveBeenCalled();
  });

  it('rejects containers outside the allowlist before reading the body', async () => {
    const storage = { uploadBlob: vi.fn() };
    const h = createAdminUploadHandlers({ guard: allowGuard(), storage });
    for (const container of ['admin_settings', '$root', 'certifications2']) {
      const res = await h.uploadFile(makeRequest({ container, body: validBody() }), context);
      expect(res.status).toBe(404);
    }
    expect(storage.uploadBlob).not.toHaveBeenCalled();
    expect(UPLOAD_CONTAINERS.has('certifications')).toBe(true);
  });

  it('rejects traversal paths and empty payloads', async () => {
    const storage = { uploadBlob: vi.fn() };
    const h = createAdminUploadHandlers({ guard: allowGuard(), storage });

    const badPath = await h.uploadFile(
      makeRequest({ body: { ...validBody(), path: 'a/../../b.png' } }),
      context
    );
    expect(badPath.status).toBe(400);

    const noData = await h.uploadFile(
      makeRequest({ body: { ...validBody(), dataBase64: '' } }),
      context
    );
    expect(noData.status).toBe(400);
    expect(storage.uploadBlob).not.toHaveBeenCalled();
  });

  it('enforces the decoded 15MB cap server-side', async () => {
    const storage = { uploadBlob: vi.fn() };
    const h = createAdminUploadHandlers({ guard: allowGuard(), storage });
    const big = Buffer.alloc(15 * 1024 * 1024 + 1).toString('base64');
    const res = await h.uploadFile(
      makeRequest({ body: { ...validBody(), dataBase64: big } }),
      context
    );
    expect(res.status).toBe(413);
    expect(storage.uploadBlob).not.toHaveBeenCalled();
  });

  it('refuses to overwrite an existing blob', async () => {
    const conflict = Object.assign(new Error('already exists'), { statusCode: 409 });
    const storage = {
      uploadBlob: vi.fn(async () => {
        throw conflict;
      }),
    };
    const h = createAdminUploadHandlers({ guard: allowGuard(), storage });
    const res = await h.uploadFile(makeRequest({ body: validBody() }), context);

    expect(res.status).toBe(409);
    // The condition has to be requested, or the service never raises the 409.
    const [, , , , options] = storage.uploadBlob.mock.calls[0];
    expect(options).toEqual({ overwrite: false });
    // A conflict is an ordinary outcome, not something to log as a failure.
    expect(context.error).not.toHaveBeenCalledWith('uploadFile failed:', conflict);
  });
});

describe('size checks happen before allocation (T-306)', () => {
  it('rejects on Content-Length without reading the body', async () => {
    const storage = { uploadBlob: vi.fn() };
    const json = vi.fn();
    const h = createAdminUploadHandlers({ guard: allowGuard(), storage });
    const request = { ...makeRequest({ contentLength: MAX_REQUEST_BYTES + 1 }), json };

    const res = await h.uploadFile(request, context);

    expect(res.status).toBe(413);
    expect(json).not.toHaveBeenCalled();
    expect(storage.uploadBlob).not.toHaveBeenCalled();
  });

  it('accepts a body at the Content-Length limit', async () => {
    const storage = { uploadBlob: vi.fn(async () => 'https://acct.blob/x/y.png') };
    const h = createAdminUploadHandlers({ guard: allowGuard(), storage });
    const res = await h.uploadFile(
      makeRequest({ body: validBody(), contentLength: MAX_REQUEST_BYTES }),
      context
    );
    expect(res.status).toBe(200);
  });

  it('proceeds when Content-Length is absent or unparseable', async () => {
    // Chunked requests carry no Content-Length. The header is an early reject,
    // never the limit, so its absence must not turn into a rejection either.
    const storage = { uploadBlob: vi.fn(async () => 'https://acct.blob/x/y.png') };
    const h = createAdminUploadHandlers({ guard: allowGuard(), storage });

    for (const contentLength of [undefined, 'not-a-number']) {
      const res = await h.uploadFile(makeRequest({ body: validBody(), contentLength }), context);
      expect(res.status).toBe(200);
    }
  });

  it('rejects on base64 length before decoding', async () => {
    const storage = { uploadBlob: vi.fn() };
    const h = createAdminUploadHandlers({ guard: allowGuard(), storage });

    // Not a decodable payload — 'A' repeated is valid base64 characters but the
    // point is that the request never gets far enough to find out.
    const dataBase64 = 'A'.repeat(MAX_BASE64_CHARS + 1);
    const res = await h.uploadFile(makeRequest({ body: { ...validBody(), dataBase64 } }), context);

    expect(res.status).toBe(413);
    expect(storage.uploadBlob).not.toHaveBeenCalled();
  });
});

describe('content-type allowlist (T-307)', () => {
  it('normalizes parameters and case off the declared type', () => {
    expect(normalizeMediaType('Image/PNG; charset=utf-8')).toBe('image/png');
    expect(normalizeMediaType(undefined)).toBe('');
  });

  it('reads the extension from the final path segment', () => {
    expect(extensionOf('a/b/badge-1.PNG')).toBe('png');
    expect(extensionOf('dir.with.dots/badge')).toBe('');
    expect(extensionOf('trailing.')).toBe('');
  });

  it('rejects a type outside the allowlist', async () => {
    const storage = { uploadBlob: vi.fn() };
    const h = createAdminUploadHandlers({ guard: allowGuard(), storage });

    for (const [path, contentType] of [
      ['evil.html', 'text/html'],
      ['evil.js', 'application/javascript'],
      ['badge-1.png', 'application/octet-stream'],
      ['badge-1.png', ''],
    ]) {
      const res = await h.uploadFile(
        makeRequest({ body: { ...validBody(), path, contentType } }),
        context
      );
      expect(res.status).toBe(415);
    }
    expect(storage.uploadBlob).not.toHaveBeenCalled();
  });

  it('rejects an extension that disagrees with the declared type', async () => {
    const storage = { uploadBlob: vi.fn() };
    const h = createAdminUploadHandlers({ guard: allowGuard(), storage });

    // The dangerous shape: an allowlisted type paired with a path that will be
    // read as something else by anything that trusts the filename.
    const res = await h.uploadFile(
      makeRequest({ body: { ...validBody(), path: 'evil.html', contentType: 'image/png' } }),
      context
    );
    expect(res.status).toBe(415);

    const noExt = await h.uploadFile(
      makeRequest({ body: { ...validBody(), path: 'badge', contentType: 'image/png' } }),
      context
    );
    expect(noExt.status).toBe(415);
    expect(storage.uploadBlob).not.toHaveBeenCalled();
  });

  it('accepts the types the pickers actually offer', async () => {
    const storage = { uploadBlob: vi.fn(async () => 'https://acct.blob/x/y.png') };
    const h = createAdminUploadHandlers({ guard: allowGuard(), storage });

    for (const [path, contentType] of [
      ['a/badge.png', 'image/png'],
      ['a/badge.JPG', 'image/jpeg'],
      ['a/badge.jpeg', 'image/jpeg'],
      ['a/badge.webp', 'image/webp'],
      ['a/badge.gif', 'image/gif'],
    ]) {
      const res = await h.uploadFile(
        makeRequest({ body: { ...validBody(), path, contentType } }),
        context
      );
      expect(res.status).toBe(200);
    }
  });

  it('allows SVG into a private container and refuses it in a public one', async () => {
    const storage = { uploadBlob: vi.fn(async () => 'https://acct.blob/x/y.svg') };
    const h = createAdminUploadHandlers({ guard: allowGuard(), storage });
    const body = { ...validBody(), path: 'submissions/a.svg', contentType: 'image/svg+xml' };

    // SubmitUrlsPage's picker offers SVG and uploads to `content`, which the
    // anonymous media route does not serve.
    const priv = await h.uploadFile(makeRequest({ container: 'content', body }), context);
    expect(priv.status).toBe(200);

    // `blogs` is served anonymously and stores uploads as sent, and an SVG is
    // a scriptable document in the storage origin. (`certifications` is also
    // public but NORMALISED — the SVG is rasterised and a PNG is stored — so
    // it accepts the type; the badge normalisation block below pins that.)
    const pub = await h.uploadFile(makeRequest({ container: 'blogs', body }), context);
    expect(pub.status).toBe(415);
  });

  it('stores the normalized type, not the raw header value', async () => {
    const storage = { uploadBlob: vi.fn(async () => 'https://acct.blob/x/y.png') };
    const h = createAdminUploadHandlers({ guard: allowGuard(), storage });
    await h.uploadFile(
      makeRequest({ body: { ...validBody(), contentType: 'Image/PNG; charset=utf-8' } }),
      context
    );
    expect(storage.uploadBlob.mock.calls[0][3]).toBe('image/png');
  });
});

describe('documents into private containers (owner request 2026-10-05)', () => {
  const pdfBody = (path = 'ambassador/app-1/1-agreement.pdf') => ({
    path,
    contentType: 'application/pdf',
    dataBase64: Buffer.from('%PDF-1.7 fake').toString('base64'),
  });

  it('accepts a PDF into speakerevents (private, where the Ambassador hub archives documents)', async () => {
    const storage = { uploadBlob: vi.fn(async () => 'https://acct.blob/x/y.pdf') };
    const h = createAdminUploadHandlers({ guard: allowGuard(), storage });
    const res = await h.uploadFile(makeRequest({ container: 'speakerevents', body: pdfBody() }), context);
    expect(res.status).toBe(200);
    const [, path, , contentType] = storage.uploadBlob.mock.calls[0];
    expect([path, contentType]).toEqual(['ambassador/app-1/1-agreement.pdf', 'application/pdf']);
    expect(JSON.parse(res.body).url).toBe('');
  });

  it('refuses the same PDF into a publicly served container', async () => {
    const storage = { uploadBlob: vi.fn() };
    const h = createAdminUploadHandlers({ guard: allowGuard(), storage });
    for (const container of ['blogs', 'certifications']) {
      const res = await h.uploadFile(
        makeRequest({ container, body: pdfBody('post-1/images/agreement.pdf') }),
        context
      );
      expect(res.status).toBe(415);
    }
    expect(storage.uploadBlob).not.toHaveBeenCalled();
  });

  it('still ties the extension to the declared document type', async () => {
    const storage = { uploadBlob: vi.fn() };
    const h = createAdminUploadHandlers({ guard: allowGuard(), storage });
    const res = await h.uploadFile(
      makeRequest({ container: 'speakerevents', body: pdfBody('ambassador/app-1/evil.html') }),
      context
    );
    expect(res.status).toBe(415);
    expect(storage.uploadBlob).not.toHaveBeenCalled();
  });
});

describe('badge normalisation (owner request 2026-10-05)', () => {
  const SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="#0ea5e9"/></svg>';
  const svgBody = (path = 'cert-1/images/badge-7.svg') => ({
    path,
    contentType: 'image/svg+xml',
    dataBase64: Buffer.from(SVG).toString('base64'),
  });

  it('accepts an SVG badge into certifications and stores it as a square PNG', async () => {
    const storage = { uploadBlob: vi.fn(async () => 'https://acct.blob/x/y.png') };
    const h = createAdminUploadHandlers({ guard: allowGuard(), storage });
    const res = await h.uploadFile(makeRequest({ body: svgBody() }), context);
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.path).toBe('cert-1/images/badge-7.png');
    expect(parsed.url).toBe('/api/public/media/certifications/cert-1/images/badge-7.png');

    const [, path, buffer, contentType] = storage.uploadBlob.mock.calls[0];
    expect(path).toBe('cert-1/images/badge-7.png');
    expect(contentType).toBe('image/png');
    const meta = await sharp(buffer).metadata();
    expect([meta.format, meta.width, meta.height, meta.hasAlpha]).toEqual([
      'png',
      BADGE_SIZE,
      BADGE_SIZE,
      true,
    ]);
    // Nothing scriptable was written: the bytes are a PNG, not the SVG text.
    expect(buffer.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it('still refuses an SVG into a public container that stores uploads as sent', async () => {
    const storage = { uploadBlob: vi.fn() };
    const h = createAdminUploadHandlers({ guard: allowGuard(), storage });
    const res = await h.uploadFile(
      makeRequest({ container: 'blogs', body: svgBody('post-1/images/hero.svg') }),
      context
    );
    expect(res.status).toBe(415);
    expect(storage.uploadBlob).not.toHaveBeenCalled();
  });

  it('answers 415 for bytes that are not a decodable image, and writes nothing', async () => {
    const storage = { uploadBlob: vi.fn() };
    const h = createAdminUploadHandlers({ guard: allowGuard(), storage });
    const res = await h.uploadFile(
      makeRequest({
        body: { ...validBody(), dataBase64: Buffer.from('fake-png-bytes').toString('base64') },
      }),
      context
    );
    expect(res.status).toBe(415);
    expect(JSON.parse(res.body).error).toMatch(/^Not a decodable image/);
    expect(storage.uploadBlob).not.toHaveBeenCalled();
  });

  it('re-encodes a JPEG badge as PNG and renames the stored path', async () => {
    const jpeg = await sharp({
      create: { width: 40, height: 10, channels: 3, background: { r: 200, g: 30, b: 30 } },
    })
      .jpeg()
      .toBuffer();
    const storage = { uploadBlob: vi.fn(async () => 'https://acct.blob/x/y.png') };
    const h = createAdminUploadHandlers({ guard: allowGuard(), storage });
    const res = await h.uploadFile(
      makeRequest({
        body: {
          path: 'cert-2/images/badge-9.jpg',
          contentType: 'image/jpeg',
          dataBase64: jpeg.toString('base64'),
        },
      }),
      context
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).path).toBe('cert-2/images/badge-9.png');
    const [, path, buffer, contentType] = storage.uploadBlob.mock.calls[0];
    expect([path, contentType]).toEqual(['cert-2/images/badge-9.png', 'image/png']);
    const meta = await sharp(buffer).metadata();
    // Contained, not stretched: the 4:1 image sits on a transparent square.
    expect([meta.width, meta.height, meta.hasAlpha]).toEqual([BADGE_SIZE, BADGE_SIZE, true]);
  });

  it('leaves a container that is not normalised byte for byte as sent', async () => {
    const storage = { uploadBlob: vi.fn(async () => 'https://acct.blob/x/y.png') };
    const h = createAdminUploadHandlers({ guard: allowGuard(), storage });
    const body = { ...validBody(), dataBase64: Buffer.from('fake-png-bytes').toString('base64') };
    const res = await h.uploadFile(makeRequest({ container: 'content', body }), context);
    expect(res.status).toBe(200);
    const [, path, buffer, contentType] = storage.uploadBlob.mock.calls[0];
    expect([path, buffer.toString(), contentType]).toEqual([
      'cert-1/images/badge-123.png',
      'fake-png-bytes',
      'image/png',
    ]);
  });

  it('normalizeBadgeImage refuses a type it cannot decode without touching sharp', async () => {
    const lib = vi.fn();
    const out = await normalizeBadgeImage(Buffer.from('x'), { contentType: 'text/html', sharp: lib });
    expect(out.error).toMatch(/Cannot normalise/);
    expect(lib).not.toHaveBeenCalled();
  });

  it('withExtension swaps or adds the extension on the final segment only', () => {
    expect(withExtension('a/b.c/badge-1.svg', 'png')).toBe('a/b.c/badge-1.png');
    expect(withExtension('a/badge', 'png')).toBe('a/badge.png');
    expect(withExtension('badge.PNG', 'png')).toBe('badge.png');
  });
});
