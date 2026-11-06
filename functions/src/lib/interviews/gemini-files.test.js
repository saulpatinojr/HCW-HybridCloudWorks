/**
 * The Gemini Files API client with a fake fetch (ADR 0040 D3): the two-step
 * resumable upload and the ACTIVE poll, the window call's retry classes,
 * the per-attempt budget hook, the shape check on the answer, the delete,
 * and the one property every case shares: the key is in a header and
 * nowhere else.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import {
  ACTIVE_POLL_LIMIT,
  GEMINI_API_BASE,
  MAX_RESPONSE_BYTES,
  UPLOAD_TIMEOUT_MS,
  WINDOW_TIMEOUT_MS,
  isGeminiUrl,
  RETRY_WAITS_MS,
  WINDOW_ATTEMPTS,
  clock,
  deleteFromGemini,
  geminiApiKey,
  parseWindowResult,
  transcribeWindow,
  uploadToGemini,
  windowPrompt,
} from './gemini-files.js';

const KEY = 'test-key-never-logged';
const noSleep = vi.fn(async () => {});
beforeEach(() => noSleep.mockClear());
const reply = (status, json = null, headers = {}) => ({
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => (json === null ? '' : JSON.stringify(json)),
});
const answer = (json, usage = { promptTokenCount: 115_200, candidatesTokenCount: 900 }) =>
  reply(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }], usageMetadata: usage });

/** The key appears only as the x-goog-api-key header of each request. */
function expectKeyOnlyInHeaders(fetch) {
  for (const [url, init] of fetch.mock.calls) {
    expect(url).not.toContain(KEY);
    expect(init.headers['x-goog-api-key']).toBe(KEY);
    expect(String(init.body ?? '')).not.toContain(KEY);
  }
}

describe('geminiApiKey', () => {
  it('reads the router’s setting and refuses an unseeded or unresolved one with a storable sentence', () => {
    expect(geminiApiKey({ GEMINI_API_KEY: ` ${KEY} ` })).toBe(KEY);
    for (const env of [{}, { GEMINI_API_KEY: '' }, { GEMINI_API_KEY: '@Microsoft.KeyVault(SecretUri=https://kv.example/secrets/x)' }]) {
      expect(() => geminiApiKey(env)).toThrow(expect.objectContaining({ code: 'GEMINI_NOT_CONFIGURED', status: 503 }));
    }
  });
});

describe('windowPrompt', () => {
  it('is fixed text with the window as MM:SS and the JSON shape, and carries no caller text', () => {
    expect(clock(0)).toBe('00:00');
    expect(clock(3599)).toBe('59:59');
    expect(clock(3600)).toBe('60:00');
    const prompt = windowPrompt({ startSec: 1200, endSec: 2400 });
    expect(prompt).toContain('from 20:00 to 40:00');
    expect(prompt).toContain('"endOfAudio"');
    expect(prompt).toContain('"speaker"');
  });
});

describe('uploadToGemini', () => {
  it('starts the resumable upload, streams the bytes to the upload URL, and returns the file once ACTIVE', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(reply(200, {}, { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/session' }))
      .mockResolvedValueOnce(reply(200, { file: { name: 'files/abc', uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc', state: 'PROCESSING', mimeType: 'audio/mpeg' } }))
      .mockResolvedValueOnce(reply(200, { name: 'files/abc', state: 'ACTIVE' }));
    const stream = Readable.from([Buffer.from('abc'), Buffer.from('def')]);
    const file = await uploadToGemini({ stream, bytes: 6, mimeType: 'audio/mpeg', apiKey: KEY, fetch, sleep: noSleep });
    expect(file).toEqual({ name: 'files/abc', uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc', mimeType: 'audio/mpeg' });
    expect(fetch).toHaveBeenCalledTimes(3);
    const [startUrl, start] = fetch.mock.calls[0];
    expect(startUrl).toBe(`${GEMINI_API_BASE}/upload/v1beta/files`);
    expect(start.headers).toMatchObject({
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': '6',
      'X-Goog-Upload-Header-Content-Type': 'audio/mpeg',
    });
    expect(start.body).toBe('{"file":{}}');
    const [uploadUrl, upload] = fetch.mock.calls[1];
    expect(uploadUrl).toBe('https://generativelanguage.googleapis.com/upload/session');
    expect(upload.headers).toMatchObject({ 'Content-Length': '6', 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' });
    expect(upload.duplex).toBe('half');
    expect(typeof upload.body.getReader).toBe('function');
    expect(fetch.mock.calls[2][0]).toBe(`${GEMINI_API_BASE}/v1beta/files/abc`);
    expect(noSleep).toHaveBeenCalled();
    expectKeyOnlyInHeaders(fetch);
  });

  it('refuses before uploading when the length is missing, and reports a start or upload failure by status only', async () => {
    const fetch = vi.fn(async () => reply(500));
    await expect(uploadToGemini({ stream: Readable.from([]), bytes: 0, mimeType: 'audio/mpeg', apiKey: KEY, fetch })).rejects.toMatchObject({ code: 'AUDIO_EMPTY' });
    expect(fetch).not.toHaveBeenCalled();
    await expect(uploadToGemini({ stream: Readable.from(['x']), bytes: 1, mimeType: 'audio/mpeg', apiKey: KEY, fetch })).rejects.toMatchObject({
      code: 'GEMINI_HTTP_500',
      status: 500,
      message: 'Gemini answered HTTP 500 to the upload start.',
    });
    const noUrl = vi.fn(async () => reply(200, {}));
    await expect(uploadToGemini({ stream: Readable.from(['x']), bytes: 1, mimeType: 'audio/mpeg', apiKey: KEY, fetch: noUrl })).rejects.toMatchObject({ code: 'GEMINI_NO_UPLOAD_URL' });
    const noFile = vi
      .fn()
      .mockResolvedValueOnce(reply(200, {}, { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/s' }))
      .mockResolvedValueOnce(reply(200, { file: {} }));
    await expect(uploadToGemini({ stream: Readable.from(['x']), bytes: 1, mimeType: 'audio/mpeg', apiKey: KEY, fetch: noFile })).rejects.toMatchObject({ code: 'GEMINI_NO_FILE' });
  });

  it('gives up on a file that never becomes ACTIVE, and on one that FAILED, without Gemini’s words', async () => {
    const stuck = vi.fn(async (url) =>
      url.endsWith('/upload/v1beta/files')
        ? reply(200, {}, { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/s' })
        : reply(200, url === 'https://generativelanguage.googleapis.com/upload/s' ? { file: { name: 'files/x', uri: 'https://generativelanguage.googleapis.com/v1beta/files/x', state: 'PROCESSING' } } : { state: 'PROCESSING' })
    );
    await expect(uploadToGemini({ stream: Readable.from(['x']), bytes: 1, mimeType: 'audio/mpeg', apiKey: KEY, fetch: stuck, sleep: noSleep })).rejects.toMatchObject({ code: 'GEMINI_FILE_NOT_ACTIVE' });
    expect(stuck).toHaveBeenCalledTimes(2 + ACTIVE_POLL_LIMIT);
    const failed = vi
      .fn()
      .mockResolvedValueOnce(reply(200, {}, { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/s' }))
      .mockResolvedValueOnce(reply(200, { file: { name: 'files/x', uri: 'https://generativelanguage.googleapis.com/v1beta/files/x', state: 'FAILED', error: { message: 'secret details' } } }));
    await expect(uploadToGemini({ stream: Readable.from(['x']), bytes: 1, mimeType: 'audio/mpeg', apiKey: KEY, fetch: failed })).rejects.toMatchObject({
      code: 'GEMINI_FILE_NOT_ACTIVE',
      message: expect.not.stringContaining('secret'),
    });
  });

  it('reports a hung upload as a timeout and a network failure as unreachable, and honours the caller’s abort', async () => {
    const hung = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))));
    const parent = new AbortController();
    const pending = uploadToGemini({ stream: Readable.from(['x']), bytes: 1, mimeType: 'audio/mpeg', apiKey: KEY, fetch: hung, signal: parent.signal });
    parent.abort(new Error('job timed out'));
    await expect(pending).rejects.toThrow('job timed out');
    const down = vi.fn(async () => {
      throw new Error('ECONNRESET at 10.0.0.5');
    });
    await expect(uploadToGemini({ stream: Readable.from(['x']), bytes: 1, mimeType: 'audio/mpeg', apiKey: KEY, fetch: down })).rejects.toMatchObject({
      code: 'GEMINI_UNREACHABLE',
      retryable: true,
      message: 'Gemini could not be reached.',
    });
  });
});

describe('deleteFromGemini', () => {
  it('deletes by name, treats 404 as gone, and reports any other status', async () => {
    const fetch = vi.fn(async () => reply(200, {}));
    expect(await deleteFromGemini({ name: 'files/abc', apiKey: KEY, fetch })).toBe(true);
    expect(fetch.mock.calls[0][0]).toBe(`${GEMINI_API_BASE}/v1beta/files/abc`);
    expect(fetch.mock.calls[0][1].method).toBe('DELETE');
    expect(await deleteFromGemini({ name: 'files/abc', apiKey: KEY, fetch: vi.fn(async () => reply(404)) })).toBe(true);
    expect(await deleteFromGemini({ name: '', apiKey: KEY, fetch })).toBe(false);
    await expect(deleteFromGemini({ name: 'files/abc', apiKey: KEY, fetch: vi.fn(async () => reply(403)) })).rejects.toMatchObject({ code: 'GEMINI_HTTP_403' });
    expectKeyOnlyInHeaders(fetch);
  });
});

describe('parseWindowResult', () => {
  it('keeps well-formed segments, defaults a missing speaker, drops empty text, and bounds lengths', () => {
    expect(
      parseWindowResult({
        segments: [
          { start: 0, end: 4.5, speaker: 'Speaker 1', text: ' Hello ' },
          { start: -1, end: 'x', text: 'No speaker' },
          { start: 1, end: 2, speaker: 'Speaker 2', text: '' },
          'junk',
        ],
        endOfAudio: 'true',
      })
    ).toEqual({
      segments: [
        { start: 0, end: 4.5, speaker: 'Speaker 1', text: 'Hello' },
        { start: 0, end: 0, speaker: 'Speaker 1', text: 'No speaker' },
      ],
      endOfAudio: false,
    });
    expect(parseWindowResult({ segments: [], endOfAudio: true })).toEqual({ segments: [], endOfAudio: true });
  });

  it('refuses anything that is not the shape', () => {
    for (const raw of [null, [], 'x', { endOfAudio: true }, { segments: 'x' }, { segments: Array.from({ length: 2001 }, () => ({ text: 'a' })) }]) {
      expect(() => parseWindowResult(raw)).toThrow(expect.objectContaining({ code: 'TRANSCRIPT_SHAPE' }));
    }
  });
});

describe('transcribeWindow', () => {
  const args = { fileUri: 'https://generativelanguage.googleapis.com/v1beta/files/abc', mimeType: 'audio/mpeg', model: 'gemini-3.6-flash', startSec: 0, endSec: 3600, apiKey: KEY, sleep: noSleep };

  it('sends the file and the fixed prompt as JSON, and returns the parsed segments with the usage', async () => {
    const fetch = vi.fn(async () => answer({ segments: [{ start: 0, end: 2, speaker: 'Speaker 1', text: 'Hi' }], endOfAudio: true }));
    const result = await transcribeWindow({ ...args, fetch });
    expect(result).toEqual({
      segments: [{ start: 0, end: 2, speaker: 'Speaker 1', text: 'Hi' }],
      endOfAudio: true,
      usage: { promptTokens: 115_200, completionTokens: 900 },
      attempts: 1,
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${GEMINI_API_BASE}/v1beta/models/gemini-3.6-flash:generateContent`);
    const body = JSON.parse(init.body);
    expect(body.contents[0].parts[0]).toEqual({ fileData: { fileUri: 'https://generativelanguage.googleapis.com/v1beta/files/abc', mimeType: 'audio/mpeg' } });
    expect(body.contents[0].parts[1].text).toContain('from 00:00 to 60:00');
    expect(body.generationConfig).toEqual({ responseMimeType: 'application/json', temperature: 0 });
    expectKeyOnlyInHeaders(fetch);
  });

  it('retries 429 and 5xx with the router’s waits and a budget check before every attempt; 403 fails at once', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(reply(429, { error: { message: 'quota words' } }))
      .mockResolvedValueOnce(reply(503))
      .mockResolvedValueOnce(answer({ segments: [], endOfAudio: true }));
    const assertBudget = vi.fn();
    const result = await transcribeWindow({ ...args, fetch, assertBudget });
    expect(result.attempts).toBe(3);
    expect(assertBudget.mock.calls.map(([info]) => info.attempt)).toEqual([1, 2, 3]);
    expect(noSleep.mock.calls.map(([ms]) => ms)).toEqual([...RETRY_WAITS_MS]);

    const forbidden = vi.fn(async () => reply(403, { error: { message: 'key words' } }));
    await expect(transcribeWindow({ ...args, fetch: forbidden })).rejects.toMatchObject({
      code: 'GEMINI_HTTP_403',
      status: 403,
      message: 'Gemini answered HTTP 403 to the transcription.',
    });
    expect(forbidden).toHaveBeenCalledTimes(1);
    for (const status of [400, 401]) {
      await expect(transcribeWindow({ ...args, fetch: vi.fn(async () => reply(status)) })).rejects.toMatchObject({ code: `GEMINI_HTTP_${status}` });
    }
  });

  it('gives up after three retryable failures with the last one', async () => {
    const fetch = vi.fn(async () => reply(500));
    await expect(transcribeWindow({ ...args, fetch })).rejects.toMatchObject({ code: 'GEMINI_HTTP_500', retryable: true });
    expect(fetch).toHaveBeenCalledTimes(WINDOW_ATTEMPTS);
  });

  it('a budget refusal before an attempt ends the call without that request', async () => {
    const fetch = vi.fn(async () => reply(503));
    const assertBudget = vi.fn(({ attempt }) => {
      if (attempt === 2) throw Object.assign(new Error('paused'), { code: 'BUDGET_EXCEEDED' });
    });
    await expect(transcribeWindow({ ...args, fetch, assertBudget })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses an answer that is not JSON or not the shape, and never retries it', async () => {
    const prose = vi.fn(async () => reply(200, { candidates: [{ content: { parts: [{ text: 'Sorry, I cannot.' }] } }] }));
    await expect(transcribeWindow({ ...args, fetch: prose })).rejects.toMatchObject({ code: 'TRANSCRIPT_SHAPE' });
    expect(prose).toHaveBeenCalledTimes(1);
    const wrong = vi.fn(async () => answer({ transcript: 'flat text' }));
    await expect(transcribeWindow({ ...args, fetch: wrong })).rejects.toMatchObject({ code: 'TRANSCRIPT_SHAPE' });
    const fenced = vi.fn(async () => reply(200, { candidates: [{ content: { parts: [{ text: '```json\n{"segments":[],"endOfAudio":true}\n```' }] } }] }));
    await expect(transcribeWindow({ ...args, fetch: fenced })).resolves.toMatchObject({ endOfAudio: true, usage: { promptTokens: 0, completionTokens: 0 } });
  });

  it('counts thinking tokens in the completion count, as the router does', async () => {
    const fetch = vi.fn(async () => answer({ segments: [], endOfAudio: true }, { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 7 }));
    await expect(transcribeWindow({ ...args, fetch })).resolves.toMatchObject({ usage: { promptTokens: 10, completionTokens: 12 } });
  });
});

describe('what the key is sent to, and what is read back', () => {
  const start = (uploadUrl) => reply(200, {}, { 'x-goog-upload-url': uploadUrl });

  it('refuses an upload URL that is not on Gemini’s host, before any byte or the key is sent there', async () => {
    for (const url of ['https://upload.example/session', 'http://generativelanguage.googleapis.com/upload/x', 'https://generativelanguage.googleapis.com.evil.example/x']) {
      const fetch = vi.fn(async () => start(url));
      await expect(uploadToGemini({ stream: Readable.from(['x']), bytes: 1, mimeType: 'audio/mpeg', apiKey: KEY, fetch })).rejects.toMatchObject({ code: 'GEMINI_NO_UPLOAD_URL' });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    expect(isGeminiUrl('https://generativelanguage.googleapis.com/v1beta/files/a')).toBe(true);
    expect(isGeminiUrl('not a url')).toBe(false);
  });

  it('refuses a file record whose name or uri is not Gemini’s shape, and never deletes by such a name', async () => {
    for (const file of [
      { name: 'files/../x', uri: 'https://generativelanguage.googleapis.com/v1beta/files/x' },
      { name: 'other/x', uri: 'https://generativelanguage.googleapis.com/v1beta/files/x' },
      { name: 'files/x', uri: 'https://files.example/x' },
    ]) {
      const fetch = vi.fn().mockResolvedValueOnce(start('https://generativelanguage.googleapis.com/upload/s')).mockResolvedValueOnce(reply(200, { file }));
      await expect(uploadToGemini({ stream: Readable.from(['x']), bytes: 1, mimeType: 'audio/mpeg', apiKey: KEY, fetch })).rejects.toMatchObject({ code: 'GEMINI_NO_FILE' });
    }
    const fetch = vi.fn(async () => reply(200, {}));
    expect(await deleteFromGemini({ name: 'files/../x', apiKey: KEY, fetch })).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads at most MAX_RESPONSE_BYTES of an answer, by the declared length and by what arrives', async () => {
    const declared = vi.fn(async () => reply(200, {}, { 'content-length': String(MAX_RESPONSE_BYTES + 1) }));
    await expect(deleteFromGemini({ name: 'files/x', apiKey: KEY, fetch: declared })).rejects.toMatchObject({ code: 'GEMINI_RESPONSE_TOO_LARGE' });
    const huge = vi.fn(async () => ({ status: 200, headers: { get: () => null }, text: async () => 'x'.repeat(MAX_RESPONSE_BYTES + 1) }));
    await expect(deleteFromGemini({ name: 'files/x', apiKey: KEY, fetch: huge })).rejects.toMatchObject({ code: 'GEMINI_RESPONSE_TOO_LARGE' });
  });

  it('streams the bytes to the upload URL with the declared Content-Length', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(start('https://generativelanguage.googleapis.com/upload/session'))
      .mockResolvedValueOnce(reply(200, { file: { name: 'files/abc', uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc', state: 'ACTIVE' } }));
    await uploadToGemini({ stream: Readable.from([Buffer.from('abc'), Buffer.from('def')]), bytes: 6, mimeType: 'audio/mpeg', apiKey: KEY, fetch });
    const [, upload] = fetch.mock.calls[1];
    expect(upload.headers['Content-Length']).toBe('6');
    const reader = upload.body.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    expect(Buffer.concat(chunks).toString()).toBe('abcdef');
  });
});

describe('the per-request deadline', () => {
  const hung = () =>
    vi.fn((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))));

  it('a window that never answers is a retryable GEMINI_TIMEOUT, retried up to the attempt limit', async () => {
    vi.useFakeTimers();
    try {
      const fetch = hung();
      const pending = transcribeWindow({ fileUri: 'https://generativelanguage.googleapis.com/v1beta/files/abc', mimeType: 'audio/mpeg', model: 'm', startSec: 0, endSec: 60, apiKey: KEY, fetch, sleep: async () => {} });
      const settled = pending.catch((e) => e);
      for (let i = 0; i < WINDOW_ATTEMPTS; i += 1) await vi.advanceTimersByTimeAsync(WINDOW_TIMEOUT_MS + 1);
      await expect(settled).resolves.toMatchObject({ code: 'GEMINI_TIMEOUT', status: 408, retryable: true });
      expect(fetch).toHaveBeenCalledTimes(WINDOW_ATTEMPTS);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an upload that never finishes is a GEMINI_TIMEOUT after the upload deadline', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn().mockResolvedValueOnce(reply(200, {}, { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/s' })).mockImplementationOnce(hung());
      const settled = uploadToGemini({ stream: Readable.from(['x']), bytes: 1, mimeType: 'audio/mpeg', apiKey: KEY, fetch }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(UPLOAD_TIMEOUT_MS + 1);
      await expect(settled).resolves.toMatchObject({ code: 'GEMINI_TIMEOUT' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the real waits', () => {
  it('uploadToGemini and transcribeWindow wait with their own timers when no sleeper is given', async () => {
    vi.useFakeTimers();
    try {
      const upload = vi
        .fn()
        .mockResolvedValueOnce(reply(200, {}, { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/s' }))
        .mockResolvedValueOnce(reply(200, { file: { name: 'files/abc', uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc', state: 'PROCESSING' } }))
        .mockResolvedValueOnce(reply(200, { state: 'ACTIVE' }));
      const uploaded = uploadToGemini({ stream: Readable.from(['x']), bytes: 1, mimeType: 'audio/mpeg', apiKey: KEY, fetch: upload });
      await vi.advanceTimersByTimeAsync(2001);
      await expect(uploaded).resolves.toMatchObject({ name: 'files/abc' });
      const window = vi.fn().mockResolvedValueOnce(reply(503)).mockResolvedValueOnce(answer({ segments: [], endOfAudio: true }));
      const done = transcribeWindow({ fileUri: 'https://generativelanguage.googleapis.com/v1beta/files/abc', mimeType: 'audio/mpeg', model: 'm', startSec: 0, endSec: 60, apiKey: KEY, fetch: window });
      await vi.advanceTimersByTimeAsync(RETRY_WAITS_MS[0] + 1);
      await expect(done).resolves.toMatchObject({ attempts: 2 });
    } finally {
      vi.useRealTimers();
    }
  });
});
