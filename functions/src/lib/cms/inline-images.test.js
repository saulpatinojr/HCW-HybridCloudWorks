import { describe, it, expect, vi } from 'vitest';

import {
  BODY_FIELDS,
  INLINE_IMAGE_CONTAINER,
  buildInlineImageUpdate,
  createInlineImageRehoster,
  findInlineImageUrls,
  inlineBlobPath,
  isOwnMediaUrl,
  resolveBodyFields,
  rewriteBody,
  scrubUrls,
  sourceOf,
} from './inline-images.js';

const UPSTREAM_A = 'https://devblogs.microsoft.com/foundry/wp-content/uploads/a.png?w=600&sig=abc';
const UPSTREAM_B = 'https://cdn.example.org/diagram.webp';

const BODY = [
  '<p>Intro</p>',
  `<img src="${UPSTREAM_A}" alt="Rubric" width="600">`,
  `Some markdown ![Diagram](${UPSTREAM_B} "Architecture")`,
  `<img alt="again" src='${UPSTREAM_A}'>`,
  '![own](/api/public/media/covers/c1/cover.png)',
  '![site](https://hybridcloudworks.com/icons/hcw-logo.png)',
  '![relative](/images/local.png)',
  '<img src="data:image/png;base64,AAAA">',
].join('\n');

describe('findInlineImageUrls', () => {
  it('returns each external image once, HTML and markdown, in first-seen order', () => {
    expect(findInlineImageUrls(BODY)).toEqual([UPSTREAM_A, UPSTREAM_B]);
  });

  it('ignores the site itself, relative paths and data URIs', () => {
    expect(findInlineImageUrls('![x](/api/public/media/covers/a/b.png)')).toEqual([]);
    expect(findInlineImageUrls('<img src="https://www.hybridcloudworks.com/x.png">')).toEqual([]);
    expect(findInlineImageUrls('<img src="/local.png">')).toEqual([]);
    expect(findInlineImageUrls('<img src="data:image/gif;base64,R0lGOD">')).toEqual([]);
    expect(findInlineImageUrls('')).toEqual([]);
    expect(findInlineImageUrls(null)).toEqual([]);
  });

  it('isOwnMediaUrl recognises the media path and both site hosts only', () => {
    expect(isOwnMediaUrl('/api/public/media/covers/x.png')).toBe(true);
    expect(isOwnMediaUrl('https://hybridcloudworks.com/a.png')).toBe(true);
    expect(isOwnMediaUrl('https://hybridcloudworks.com.evil.example/a.png')).toBe(false);
    expect(isOwnMediaUrl(UPSTREAM_A)).toBe(false);
    expect(isOwnMediaUrl(42)).toBe(false);
  });
});

describe('resolveBodyFields', () => {
  it('lists every non-empty body field in the page precedence: blogDraft, Content, content', () => {
    expect(BODY_FIELDS).toEqual(['blogDraft', 'Content', 'content']);
    expect(resolveBodyFields({ content: 'c', Content: 'C', blogDraft: 'd' })).toEqual([
      'blogDraft',
      'Content',
      'content',
    ]);
    expect(resolveBodyFields({ content: 'c', Content: 'C' })).toEqual(['Content', 'content']);
    expect(resolveBodyFields({ blogDraft: '   ', content: 'c' })).toEqual(['content']);
    expect(resolveBodyFields({ content: 42 })).toEqual([]);
    expect(resolveBodyFields({})).toEqual([]);
  });
});

describe('inlineBlobPath and rewriteBody', () => {
  it('names the blob by article and a hash of the URL, with the MIME extension', () => {
    const p = inlineBlobPath('c1', UPSTREAM_A, 'image/webp');
    expect(p).toMatch(/^c1\/inline\/[0-9a-f]{16}\.webp$/);
    expect(inlineBlobPath('c1', UPSTREAM_A, 'image/webp')).toBe(p);
    expect(inlineBlobPath('c1', UPSTREAM_B, 'image/webp')).not.toBe(p);
    expect(inlineBlobPath('c2', UPSTREAM_A, 'image/webp')).not.toBe(p);
    // #415: this used to default to `.png`, which is how a video would have
    // been stored under a name claiming to be an image.
    expect(() => inlineBlobPath('c1', UPSTREAM_A, 'application/octet-stream')).toThrow(
      'No stored extension for media type application/octet-stream'
    );
    expect(() => inlineBlobPath('c1', UPSTREAM_A, 'video/mp4')).toThrow(
      'No stored extension for media type video/mp4'
    );
  });

  it('replaces every occurrence and touches nothing else', () => {
    const out = rewriteBody(BODY, [
      { from: UPSTREAM_A, to: '/api/public/media/covers/c1/inline/x.png' },
    ]);
    expect(out).not.toContain(UPSTREAM_A);
    expect(out.match(/\/api\/public\/media\/covers\/c1\/inline\/x\.png/g)).toHaveLength(2);
    expect(out).toContain(UPSTREAM_B);
    expect(rewriteBody(BODY, [])).toBe(BODY);
  });

  it('rewrites the longer of two prefix-related URLs first, so neither is mangled', () => {
    // Copilot review of #389: `…/img.png` is a prefix of `…/img.png?size=2`.
    const short = 'https://x.example/img.png';
    const long = 'https://x.example/img.png?size=2';
    const body = `<img src="${short}"> <img src="${long}">`;
    const out = rewriteBody(body, [
      { from: short, to: '/api/public/media/covers/c1/inline/s.png' },
      { from: long, to: '/api/public/media/covers/c1/inline/l.png' },
    ]);
    expect(out).toBe(
      '<img src="/api/public/media/covers/c1/inline/s.png"> <img src="/api/public/media/covers/c1/inline/l.png">'
    );
  });
});

describe('createInlineImageRehoster', () => {
  const png = { buffer: Buffer.from('png-bytes'), contentType: 'image/png' };

  it('fetches, stores and rewrites the ones that work, and leaves the one that fails', async () => {
    const fetchImage = vi.fn(async (url) => {
      if (url === UPSTREAM_B) throw new Error('HTTP 403 fetching ' + url);
      return png;
    });
    const storage = { uploadBlob: vi.fn(async () => undefined) };
    const log = { warn: vi.fn() };
    const { rehost } = createInlineImageRehoster({ storage, fetchImage, log });

    const result = await rehost({ contentId: 'c1', bodies: { content: BODY } });

    expect(fetchImage).toHaveBeenCalledTimes(2);
    expect(storage.uploadBlob).toHaveBeenCalledTimes(1);
    const [container, blobPath, buffer, contentType, metadata] = storage.uploadBlob.mock.calls[0];
    expect(container).toBe(INLINE_IMAGE_CONTAINER);
    expect(blobPath).toBe(inlineBlobPath('c1', UPSTREAM_A, 'image/png'));
    expect(buffer).toBe(png.buffer);
    expect(contentType).toBe('image/png');
    // Provenance keeps origin and path; the query string (a size or a signature) is dropped.
    expect(metadata).toEqual({
      sourceUrl: 'https://devblogs.microsoft.com/foundry/wp-content/uploads/a.png',
    });

    expect(result.rewritten).toEqual([
      { from: UPSTREAM_A, to: `/api/public/media/covers/${blobPath}` },
    ]);
    expect(result.failed).toEqual([{ url: UPSTREAM_B, reason: 'HTTP 403 fetching ' + UPSTREAM_B }]);
    expect(result.bodies.content).not.toContain(UPSTREAM_A);
    expect(result.bodies.content).toContain(`![Diagram](${UPSTREAM_B} "Architecture")`);
    // The warning names the host, never the URL or the body.
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toContain('cdn.example.org');
    expect(log.warn.mock.calls[0][0]).not.toContain('/diagram.webp');
  });

  it('stores nothing for a video, leaves its URL in the body, and re-hosts the rest (#415)', async () => {
    // The fetcher refuses by returning, not by throwing: the response arrived
    // and was read, it is simply not an image this site can serve.
    const fetchImage = vi.fn(async (url) =>
      url === UPSTREAM_B
        ? {
            refused: 'not-an-image',
            contentType: 'video/mp4',
            reason: 'Content-Type video/mp4 is not an image',
          }
        : png
    );
    const storage = { uploadBlob: vi.fn(async () => undefined) };
    const log = { warn: vi.fn() };
    const { rehost } = createInlineImageRehoster({ storage, fetchImage, log });

    const result = await rehost({ contentId: 'c1', bodies: { content: BODY } });

    // Nothing written for the video — not under a `.png`, not under any name.
    expect(fetchImage).toHaveBeenCalledTimes(2);
    expect(storage.uploadBlob).toHaveBeenCalledTimes(1);
    expect(storage.uploadBlob.mock.calls[0][1]).toBe(inlineBlobPath('c1', UPSTREAM_A, 'image/png'));

    // The video's URL survives the rewrite exactly as the body had it.
    expect(result.bodies.content).toContain(`![Diagram](${UPSTREAM_B} "Architecture")`);
    expect(result.failed).toEqual([
      { url: UPSTREAM_B, reason: 'Content-Type video/mp4 is not an image' },
    ]);
    // …and the article's other image still came across.
    expect(result.rewritten).toEqual([
      { from: UPSTREAM_A, to: `/api/public/media/covers/${storage.uploadBlob.mock.calls[0][1]}` },
    ]);
    expect(result.bodies.content).not.toContain(UPSTREAM_A);

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toBe(
      '[inlineImages] could not re-host an image from cdn.example.org: Content-Type video/mp4 is not an image'
    );
  });

  it('counts an upload failure as a failed image, not a thrown publish', async () => {
    const fetchImage = vi.fn(async () => png);
    const storage = {
      uploadBlob: vi.fn(async () => {
        throw new Error('403 on blob');
      }),
    };
    const { rehost } = createInlineImageRehoster({ storage, fetchImage });
    const result = await rehost({
      contentId: 'c1',
      bodies: { Content: `<img src="${UPSTREAM_A}">` },
    });
    expect(result.rewritten).toEqual([]);
    expect(result.failed).toEqual([{ url: UPSTREAM_A, reason: '403 on blob' }]);
    expect(result.bodies).toEqual({ Content: `<img src="${UPSTREAM_A}">` });
  });

  it('does nothing for a body with no external images', async () => {
    const fetchImage = vi.fn();
    const storage = { uploadBlob: vi.fn() };
    const { rehost } = createInlineImageRehoster({ storage, fetchImage });
    const result = await rehost({
      contentId: 'c1',
      bodies: { content: '<p>text</p> ![x](/local.png)' },
    });
    expect(fetchImage).not.toHaveBeenCalled();
    expect(result).toEqual({
      bodies: { content: '<p>text</p> ![x](/local.png)' },
      rewritten: [],
      failed: [],
    });
  });

  it('fetches a URL shared by two fields once and rewrites it in both', async () => {
    // The audited article of 2026-09-06: an RSS stub in `Content`, the real
    // body with its images in `content`.
    const fetchImage = vi.fn(async () => png);
    const storage = { uploadBlob: vi.fn(async () => undefined) };
    const { rehost } = createInlineImageRehoster({ storage, fetchImage });
    const result = await rehost({
      contentId: 'c1',
      bodies: {
        Content: `<p>stub</p><img src="${UPSTREAM_A}">`,
        content: `![a](${UPSTREAM_A}) ![b](${UPSTREAM_B})`,
      },
    });
    expect(fetchImage).toHaveBeenCalledTimes(2);
    expect(storage.uploadBlob).toHaveBeenCalledTimes(2);
    expect(result.rewritten).toHaveLength(2);
    expect(result.bodies.Content).not.toContain(UPSTREAM_A);
    expect(result.bodies.content).not.toContain(UPSTREAM_A);
    expect(result.bodies.content).not.toContain(UPSTREAM_B);
  });

  it('fetches at most `concurrency` images at once and reports them in body order', async () => {
    const urls = Array.from({ length: 7 }, (_, i) => `https://cdn.example.org/${i}.png`);
    let inFlight = 0;
    let peak = 0;
    const fetchImage = vi.fn(async (url) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Later URLs resolve sooner, so completion order differs from body order.
      await new Promise((r) => setTimeout(r, 10 - Number(url.match(/(\d)\.png$/)[1])));
      inFlight -= 1;
      return png;
    });
    const storage = { uploadBlob: vi.fn(async () => undefined) };
    const { rehost } = createInlineImageRehoster({ storage, fetchImage, concurrency: 3 });
    const body = urls.map((u) => `![](${u})`).join(' ');
    const result = await rehost({ contentId: 'c1', bodies: { content: body } });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
    expect(result.rewritten.map((r) => r.from)).toEqual(urls);
    expect(result.failed).toEqual([]);
  });
});

describe('buildInlineImageUpdate', () => {
  const nowIso = '2026-09-06T23:00:00.000Z';

  it('returns the rewritten body field and a summary the editor can read', async () => {
    const rehost = vi.fn(async ({ bodies }) => ({
      bodies: Object.fromEntries(
        Object.entries(bodies).map(([f, b]) => [
          f,
          b.replace(UPSTREAM_A, '/api/public/media/covers/c1/inline/x.png'),
        ])
      ),
      rewritten: [{ from: UPSTREAM_A, to: '/api/public/media/covers/c1/inline/x.png' }],
      failed: [{ url: UPSTREAM_B, reason: 'HTTP 403' }],
    }));
    const contentData = {
      Content: `<img src="${UPSTREAM_A}"> ![d](${UPSTREAM_B})`,
      content: 'older, no images',
    };
    const update = await buildInlineImageUpdate({ contentData, contentId: 'c1', rehost, nowIso });
    // Only the fields that carry an external image are sent and written back.
    expect(rehost).toHaveBeenCalledWith({
      contentId: 'c1',
      bodies: { Content: contentData.Content },
    });
    expect(update.Content).toBe(
      `<img src="/api/public/media/covers/c1/inline/x.png"> ![d](${UPSTREAM_B})`
    );
    expect(update.content).toBeUndefined();
    expect(update.inlineImages).toEqual({
      fields: ['Content'],
      rewritten: 1,
      failed: 1,
      failedUrls: [UPSTREAM_B],
      at: nowIso,
    });
  });

  it('is null when there is no body, no rehoster, or nothing external in the body', async () => {
    const rehost = vi.fn();
    expect(
      await buildInlineImageUpdate({ contentData: {}, contentId: 'c1', rehost, nowIso })
    ).toBeNull();
    expect(
      await buildInlineImageUpdate({
        contentData: { content: '<p>x</p>' },
        contentId: 'c1',
        rehost,
        nowIso,
      })
    ).toBeNull();
    expect(
      await buildInlineImageUpdate({
        contentData: { content: `<img src="${UPSTREAM_A}">` },
        contentId: 'c1',
        rehost: null,
        nowIso,
      })
    ).toBeNull();
    expect(rehost).not.toHaveBeenCalled();
  });

  it('does not rewrite the field when nothing changed, but still records the failures', async () => {
    const body = `<img src="${UPSTREAM_A}">`;
    const rehost = vi.fn(async () => ({
      bodies: { blogDraft: body },
      rewritten: [],
      // UPSTREAM_A carries a query string; the summary must not.
      failed: [{ url: UPSTREAM_A, reason: 'timeout' }],
    }));
    const update = await buildInlineImageUpdate({
      contentData: { blogDraft: body },
      contentId: 'c1',
      rehost,
      nowIso,
    });
    expect(update.blogDraft).toBeUndefined();
    expect(update.inlineImages.failed).toBe(1);
    expect(update.inlineImages.failedUrls).toEqual([
      'https://devblogs.microsoft.com/foundry/wp-content/uploads/a.png',
    ]);
  });

  it('swallows a rehoster that throws whole and publishes the body untouched', async () => {
    const log = { warn: vi.fn() };
    const rehost = vi.fn(async () => {
      throw new Error(`storage account unreachable while fetching ${UPSTREAM_A}`);
    });
    const update = await buildInlineImageUpdate({
      contentData: { content: `<img src="${UPSTREAM_A}">` },
      contentId: 'c1',
      rehost,
      nowIso,
      log,
    });
    expect(update).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
    // The whole-step warning names the error's class, never its message (#1794).
    expect(log.warn.mock.calls[0][0]).toMatch(/re-hosting skipped: name=Error\b/);
    expect(log.warn.mock.calls[0][0]).not.toContain('storage account unreachable');
    expect(log.warn.mock.calls[0][0]).not.toContain('devblogs.microsoft.com');
  });
});

describe('sourceOf', () => {
  it('keeps origin and path and drops query and fragment', () => {
    expect(sourceOf('https://h.example/a/b.png?x=1#frag')).toBe('https://h.example/a/b.png');
    expect(sourceOf('not a url')).toBe('not a url');
  });
});

describe('scrubUrls', () => {
  it('replaces every http(s) URL and leaves the rest of the message', () => {
    expect(scrubUrls(`HTTP 403 fetching ${UPSTREAM_A} then ${UPSTREAM_B}`)).toBe(
      'HTTP 403 fetching [url] then [url]'
    );
    expect(scrubUrls('Request timed out')).toBe('Request timed out');
    expect(scrubUrls(null)).toBe('');
  });
});
