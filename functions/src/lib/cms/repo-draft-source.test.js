/**
 * The pinned GitHub fetch in repo-draft-source.js, which the lab-host drift
 * check and the delivery monitor read the public API through: two hosts, no
 * token, no redirects, one deadline over headers and body, a byte cap.
 *
 * The Drafts page's "Import from docs/content" used to share this source; it
 * was removed, so these tests call fetchPinned directly.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  GITHUB_FETCH_TIMEOUT_MS,
  MAX_API_BYTES,
  fetchPinned,
  isPinnedUrl,
} from './repo-draft-source.js';

const RAW_PREFIX =
  'https://raw.githubusercontent.com/saulpatinojr/HCW-HybridCloudWorks/main/docs/content/';
const API_PREFIX = 'https://api.github.com/repos/saulpatinojr/HCW-HybridCloudWorks/';
const COMMITS_URL = `${API_PREFIX}commits?sha=main&per_page=1`;
const FILE_URL = `${RAW_PREFIX}blog-sample-01-first-part.md`;
const OPTIONS = { accept: 'text/plain', maxBytes: 1024, timeoutMs: 50 };

function textResponse(body, { status = 200, headers = {}, url = '' } = {}) {
  const bytes = Buffer.from(body, 'utf8');
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: new Headers({ 'content-length': String(bytes.length), ...headers }),
    body: null,
    arrayBuffer: async () => bytes,
  };
}

describe('isPinnedUrl', () => {
  it.each([
    `${RAW_PREFIX}blog-sample-01-first-part.md`,
    `${API_PREFIX}contents/docs/content?ref=main`,
    `${API_PREFIX}commits?path=docs%2Fcontent%2Fblog-x.md&sha=main&per_page=1`,
  ])('admits %s', (url) => {
    expect(isPinnedUrl(url)).toBe(true);
  });

  it.each([
    [
      'another host',
      'https://evil.test/saulpatinojr/HCW-HybridCloudWorks/main/docs/content/blog-x.md',
    ],
    [
      'a look-alike suffix',
      'https://raw.githubusercontent.com.evil.test/saulpatinojr/HCW-HybridCloudWorks/main/docs/content/blog-x.md',
    ],
    [
      'userinfo before another host',
      'https://raw.githubusercontent.com@evil.test/saulpatinojr/HCW-HybridCloudWorks/main/docs/content/blog-x.md',
    ],
    [
      'userinfo on the right host',
      'https://user:pw@raw.githubusercontent.com/saulpatinojr/HCW-HybridCloudWorks/main/docs/content/blog-x.md',
    ],
    [
      'a port',
      'https://raw.githubusercontent.com:8443/saulpatinojr/HCW-HybridCloudWorks/main/docs/content/blog-x.md',
    ],
    [
      'plain http',
      'http://raw.githubusercontent.com/saulpatinojr/HCW-HybridCloudWorks/main/docs/content/blog-x.md',
    ],
    [
      'another repository',
      'https://raw.githubusercontent.com/someone/else/main/docs/content/blog-x.md',
    ],
    [
      'another branch',
      'https://raw.githubusercontent.com/saulpatinojr/HCW-HybridCloudWorks/dev/docs/content/blog-x.md',
    ],
    [
      'outside docs/content',
      'https://raw.githubusercontent.com/saulpatinojr/HCW-HybridCloudWorks/main/infra/main.tf',
    ],
    ['another repository on the API', 'https://api.github.com/repos/someone/else/contents/docs'],
    [
      'a GitHub page',
      'https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/docs/content/blog-x.md',
    ],
    ['not a URL', 'docs/content/blog-x.md'],
  ])('refuses %s', (_label, url) => {
    expect(isPinnedUrl(url)).toBe(false);
  });
});

describe('fetchPinned — two hosts, no redirects, a cap and a deadline', () => {
  it('asks only for a pinned URL, never follows a redirect and sends no credential', async () => {
    const fetchImpl = vi.fn(async (url) => textResponse('[]', { url }));
    const bytes = await fetchPinned(fetchImpl, COMMITS_URL, {
      ...OPTIONS,
      accept: 'application/vnd.github+json',
    });
    expect(bytes.toString('utf8')).toBe('[]');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(isPinnedUrl(url)).toBe(true);
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(init.headers).map((h) => h.toLowerCase())).not.toContain('authorization');
  });

  it('refuses a URL outside the two hosts before any request is made', async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchPinned(fetchImpl, 'https://evil.test/x', OPTIONS)
    ).rejects.toMatchObject({ code: 'HOST_NOT_ALLOWED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a 3xx even from a fetch that ignores redirect: error', async () => {
    const fetchImpl = vi.fn(async () =>
      textResponse('', { status: 302, headers: { location: 'https://evil.test/x' } })
    );
    await expect(fetchPinned(fetchImpl, FILE_URL, OPTIONS)).rejects.toMatchObject({
      code: 'REDIRECTED',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a response that says it came from another URL', async () => {
    const fetchImpl = vi.fn(async () => textResponse('x', { url: 'https://evil.test/x.md' }));
    await expect(fetchPinned(fetchImpl, FILE_URL, OPTIONS)).rejects.toMatchObject({
      code: 'REDIRECTED',
    });
  });

  it("names undici's redirect: 'error' rejection as a redirect", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
    });
    await expect(fetchPinned(fetchImpl, FILE_URL, OPTIONS)).rejects.toMatchObject({
      code: 'REDIRECTED',
    });
  });

  it('refuses a body over the cap, declared or streamed', async () => {
    const declared = vi.fn(async () =>
      textResponse('small', { headers: { 'content-length': String(OPTIONS.maxBytes + 1) } })
    );
    await expect(fetchPinned(declared, FILE_URL, OPTIONS)).rejects.toMatchObject({
      code: 'TOO_LARGE',
    });

    // No Content-Length, and a stream that keeps going: the cap is enforced
    // as the bytes arrive, and the stream is cancelled rather than drained.
    let pulled = 0;
    const cancel = vi.fn();
    const stream = new ReadableStream({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(512));
      },
      cancel,
    });
    const streamed = vi.fn(async () => ({
      ok: true,
      status: 200,
      url: '',
      headers: new Headers(),
      body: stream,
    }));
    await expect(fetchPinned(streamed, FILE_URL, OPTIONS)).rejects.toMatchObject({
      code: 'TOO_LARGE',
    });
    expect(cancel).toHaveBeenCalled();
    expect(pulled).toBeLessThan(OPTIONS.maxBytes / 512 + 3);
  });

  it('gives up at the deadline, including on a body that never finishes', async () => {
    expect(GITHUB_FETCH_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    expect(MAX_API_BYTES).toBeGreaterThan(0);
    const hung = vi.fn(
      (url, init) =>
        new Promise((_, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          );
        })
    );
    await expect(
      fetchPinned(hung, FILE_URL, { ...OPTIONS, timeoutMs: 20 })
    ).rejects.toMatchObject({ code: 'TIMEOUT' });

    const trickle = vi.fn(async (url, init) => ({
      ok: true,
      status: 200,
      url: '',
      headers: new Headers(),
      body: new ReadableStream({
        start(controller) {
          init.signal.addEventListener('abort', () =>
            controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          );
        },
      }),
    }));
    await expect(
      fetchPinned(trickle, FILE_URL, { ...OPTIONS, timeoutMs: 20 })
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('reports a used-up rate limit with its reset time, and a missing file as NOT_FOUND', async () => {
    const rateLimited = vi.fn(async () =>
      textResponse('{"message":"API rate limit exceeded"}', {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790000000' },
      })
    );
    await expect(fetchPinned(rateLimited, COMMITS_URL, OPTIONS)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      resetAt: '2026-09-21T14:13:20.000Z',
    });

    const missing = vi.fn(async () => textResponse('404: Not Found', { status: 404 }));
    await expect(fetchPinned(missing, FILE_URL, OPTIONS)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('reports any other non-2xx status with the status GitHub answered', async () => {
    const broken = vi.fn(async () => textResponse('nope', { status: 500 }));
    await expect(fetchPinned(broken, FILE_URL, OPTIONS)).rejects.toMatchObject({
      code: 'UPSTREAM_STATUS',
      upstreamStatus: 500,
    });
  });
});
