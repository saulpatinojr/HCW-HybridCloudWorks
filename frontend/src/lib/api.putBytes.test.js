/**
 * putBytes — the raw-body PUT the interview upload sends each 4 MiB block
 * with (ADR 0040, D7). Pinned: the bearer is the acquired token whatever a
 * caller passes, the body goes as bytes with `application/octet-stream`, a
 * failure throws the same Error authedFetch does (status and code kept, so
 * the upload can tell INTERVIEW_DELETED from a 503), there is exactly one
 * attempt, and a stopped upload says so instead of "timed out".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const acquireApiToken = vi.fn();
vi.mock('@/lib/entraAuth', () => ({ acquireApiToken: (...args) => acquireApiToken(...args) }));
vi.mock('@/lib/functionsBase', () => ({
  requireFunctionsBase: () => 'https://api.example.test/api',
  getFunctionsBase: () => 'https://api.example.test/api',
}));

beforeEach(() => {
  acquireApiToken.mockReset().mockResolvedValue('acquired-here');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, index: 0 }) }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('putBytes', () => {
  it('PUTs the bytes with the acquired bearer and an octet-stream type, never a caller’s', async () => {
    const { putBytes } = await import('@/lib/api');
    const body = new Uint8Array([1, 2, 3]).buffer;
    const answer = await putBytes('cms/interviews/uploads/u1/blocks/0', body, {
      headers: {
        Authorization: 'Bearer planted',
        'content-type': 'text/plain',
        'Content-Length': '999',
        'X-Trace': 'kept',
      },
    });
    expect(answer).toEqual({ ok: true, index: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [[url, init]] = fetch.mock.calls;
    expect(url).toBe('https://api.example.test/api/cms/interviews/uploads/u1/blocks/0');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(body);
    expect(init.headers).toEqual({
      'X-Trace': 'kept',
      'Content-Type': 'application/octet-stream',
      Authorization: 'Bearer acquired-here',
    });
  });

  it('throws the API’s sentence with its status and code, after one attempt', async () => {
    fetch.mockResolvedValue({
      ok: false,
      status: 409,
      headers: { get: () => null },
      json: async () => ({ error: 'This interview is being deleted.', code: 'INTERVIEW_DELETED' }),
    });
    const { putBytes } = await import('@/lib/api');
    const failure = await putBytes('cms/interviews/uploads/u1/blocks/3', new ArrayBuffer(4)).catch(
      (error) => error
    );
    expect(failure.message).toBe('This interview is being deleted.');
    expect(failure.status).toBe(409);
    expect(failure.code).toBe('INTERVIEW_DELETED');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('answers {} when a success has no JSON body', async () => {
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('no body');
      },
    });
    const { putBytes } = await import('@/lib/api');
    await expect(
      putBytes('cms/interviews/uploads/u1/blocks/0', new ArrayBuffer(1))
    ).resolves.toEqual({});
  });

  it('says the upload was stopped when the caller aborts, and timed out when the clock does', async () => {
    const abortable = () =>
      vi.fn(
        (url, init) =>
          new Promise((resolve, reject) => {
            init.signal.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            );
          })
      );
    const { putBytes, PUT_BYTES_TIMEOUT_MS } = await import('@/lib/api');

    vi.stubGlobal('fetch', abortable());
    const controller = new AbortController();
    const stopped = putBytes('cms/interviews/uploads/u1/blocks/0', new ArrayBuffer(1), {
      signal: controller.signal,
    }).catch((error) => error);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    controller.abort();
    expect(await stopped).toMatchObject({ code: 'ABORTED', message: 'The upload was stopped.' });

    vi.useFakeTimers();
    vi.stubGlobal('fetch', abortable());
    const timedOut = putBytes('cms/interviews/uploads/u1/blocks/1', new ArrayBuffer(1)).catch(
      (error) => error
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(PUT_BYTES_TIMEOUT_MS + 1);
    expect((await timedOut).message).toMatch(/timed out after 60s/);
  });

  it('gives a completion the long timeout and other routes the default', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (url, init) =>
          new Promise((resolve, reject) => {
            init.signal.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            );
          })
      )
    );
    const { postJSON } = await import('@/lib/api');
    const completion = postJSON('cms/interviews/uploads/u1/complete', {}).catch((e) => e);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(60_000);
    const ordinary = postJSON('cms/interviews', {}).catch((e) => e);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(20_001);
    expect((await ordinary).message).toMatch(/timed out after 20s/);
    await vi.advanceTimersByTimeAsync(200_000);
    expect((await completion).message).toMatch(/timed out after 200s/);
  });
});
