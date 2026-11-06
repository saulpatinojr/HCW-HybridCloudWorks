/**
 * The audio URL job (ADR 0040 D2) with a fake fetch stream and a stubbed
 * blob client: the URL's shape at the route, the host allow-list, the
 * three audio types under every alias, octet-stream by extension, the
 * cap and the deadline on the wire (a partial blob deleted), the guard's
 * refusal, the hash and byte count recorded, and a log line that never
 * carries the URL.
 */
import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import {
  ACCEPTED_EXTENSIONS,
  AUDIO_TYPE_ALIASES,
  FETCH_TIMEOUT_MS,
  MAX_URL_CHARS,
  allowedHostSuffixes,
  canonicalAudioType,
  checkAudioUrl,
  fetchAudioToContainer,
  hostAllowed,
  parseFetchPayload,
  resolveAudioType,
  typeForExtension,
} from './fetch-audio.js';
import { MAX_AUDIO_BYTES } from './storage.js';

const URL_OK = 'https://files.example/share/guest-voice.mp3?dl=1';

describe('checkAudioUrl and parseFetchPayload', () => {
  it('accepts an https URL with a public host and refuses the rest with a sentence', () => {
    expect(checkAudioUrl(URL_OK)).toEqual({ ok: true, url: URL_OK });
    expect(checkAudioUrl('')).toMatchObject({ ok: false, error: 'url is required.' });
    expect(checkAudioUrl('http://files.example/a.mp3')).toMatchObject({ ok: false, error: 'Only an https:// URL is fetched.' });
    expect(checkAudioUrl('https://localhost/a.mp3')).toMatchObject({ ok: false, error: 'The URL must name a public host.' });
    expect(checkAudioUrl('https://[::1]/a.mp3')).toMatchObject({ ok: false });
    expect(checkAudioUrl('https://user:pw@files.example/a.mp3')).toMatchObject({ ok: false, error: 'A URL with credentials is not fetched.' });
    expect(checkAudioUrl('not a url')).toMatchObject({ ok: false, error: 'The URL could not be read.' });
    expect(checkAudioUrl(`https://files.example/${'a'.repeat(MAX_URL_CHARS)}`)).toMatchObject({ ok: false, error: expect.stringMatching(/longer than/) });
    expect(checkAudioUrl(42)).toMatchObject({ ok: false });
  });

  it('parses the job payload with the same rule', () => {
    expect(parseFetchPayload({ interviewId: 'int-1', sourceUrl: URL_OK })).toEqual({ value: { interviewId: 'int-1', sourceUrl: URL_OK } });
    expect(parseFetchPayload({ interviewId: '', sourceUrl: URL_OK })).toEqual({ error: 'interviewId is required.' });
    expect(parseFetchPayload({ interviewId: '../x', sourceUrl: URL_OK })).toEqual({ error: 'interviewId is required.' });
    expect(parseFetchPayload({ interviewId: 'int-1', sourceUrl: 'http://x.example/a.mp3' })).toEqual({ error: 'Only an https:// URL is fetched.' });
    expect(parseFetchPayload(null)).toEqual({ error: 'interviewId is required.' });
  });
});

describe('the host allow-list', () => {
  it('is empty by default (any public host) and narrows to suffixes when set', () => {
    expect(allowedHostSuffixes({})).toEqual([]);
    expect(allowedHostSuffixes({ INTERVIEW_AUDIO_URL_HOSTS: ' Dropbox.com, .plaud.ai ,, ' })).toEqual(['dropbox.com', 'plaud.ai']);
    expect(allowedHostSuffixes({ INTERVIEW_AUDIO_URL_HOSTS: '@Microsoft.KeyVault(SecretUri=x)' })).toEqual([]);
    expect(hostAllowed('files.example', [])).toBe(true);
    expect(hostAllowed('www.dropbox.com', ['dropbox.com'])).toBe(true);
    expect(hostAllowed('dropbox.com', ['dropbox.com'])).toBe(true);
    expect(hostAllowed('notdropbox.com', ['dropbox.com'])).toBe(false);
    expect(hostAllowed('dropbox.com.evil.example', ['dropbox.com'])).toBe(false);
  });
});

describe('the audio types', () => {
  it('normalises every alias to the canonical type before any check, and reads octet-stream by extension', () => {
    for (const [canonical, aliases] of Object.entries(AUDIO_TYPE_ALIASES)) {
      for (const alias of aliases) expect(canonicalAudioType(`${alias.toUpperCase()}; charset=x`), alias).toBe(canonical);
    }
    expect(canonicalAudioType('audio/x-m4a')).toBe('audio/mp4');
    expect(canonicalAudioType('audio/mp3')).toBe('audio/mpeg');
    expect(canonicalAudioType('text/html')).toBeNull();
    expect(typeForExtension('MP3')).toBe('audio/mpeg');
    expect(typeForExtension('exe')).toBeNull();
    expect(ACCEPTED_EXTENSIONS).toEqual(['mp3', 'm4a', 'wav']);
    const headers = (type) => ({ headers: { get: (k) => (k === 'content-type' ? type : null) } });
    expect(resolveAudioType(headers('audio/x-m4a'), 'https://a.example/x')).toBe('audio/mp4');
    expect(resolveAudioType(headers('application/octet-stream'), 'https://a.example/dl/x.WAV?a=1')).toBe('audio/wav');
    expect(resolveAudioType(headers('application/octet-stream'), 'https://a.example/dl/x')).toBeNull();
    expect(resolveAudioType(headers('text/html'), 'https://a.example/x.mp3')).toBeNull();
  });
});

describe('fetchAudioToContainer', () => {
  const makeStore = (doc = { id: 'int-1', type: 'interview', provenance: { keep: 1 }, interview: { stage: 'uploading', fetchJobId: 'j1' } }) => ({
    readDoc: vi.fn(async () => doc),
    patchDoc: vi.fn(async () => ({})),
  });
  /** A blob client that drains the stream it is handed, as the SDK does. */
  const makeStorage = () => {
    const uploaded = {};
    return {
      uploaded,
      uploadBlobFromStream: vi.fn(async (container, path, stream) => {
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        uploaded[`${container}/${path}`] = Buffer.concat(chunks);
        return 'url';
      }),
      deleteBlob: vi.fn(async () => {}),
    };
  };
  const fetched = (chunks, { type = 'audio/mpeg', url = 'https://files.example/final/guest-voice.mp3' } = {}) => ({
    response: { status: 200, headers: { get: (k) => (k === 'content-type' ? type : null) } },
    stream: Readable.from(chunks.map((c) => Buffer.from(c))),
    bytesRead: () => 0,
    url,
  });

  it('streams the body into the container under the canonical type, records bytes, sha256 and the URL on the document, and logs counts only', async () => {
    const store = makeStore();
    const storage = makeStorage();
    const log = { log: vi.fn() };
    const fetchStream = vi.fn(async () => fetched(['abc', 'def'], { type: 'audio/x-m4a; codecs=mp4a' }));
    const report = await fetchAudioToContainer({
      interviewId: 'int-1',
      sourceUrl: URL_OK,
      store,
      storage,
      fetchStream,
      env: {},
      log,
      now: () => new Date('2026-11-05T10:00:00Z'),
      uploadId: 'job-7',
    });
    expect(report).toEqual({ interviewId: 'int-1', bytes: 6, contentType: 'audio/mp4', path: 'audio/int-1/job-7.m4a' });
    expect(storage.uploaded['interviews-audio/audio/int-1/job-7.m4a'].toString()).toBe('abcdef');
    expect(storage.uploadBlobFromStream.mock.calls[0].slice(3)).toEqual([4 * 1024 * 1024, 'audio/mp4']);
    expect(fetchStream).toHaveBeenCalledWith(URL_OK, {
      httpsOnly: true,
      maxRedirects: 5,
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: MAX_AUDIO_BYTES,
      allowHost: expect.any(Function),
      allowedTypes: [...Object.values(AUDIO_TYPE_ALIASES).flat(), 'application/octet-stream'],
      allowedExtensions: ['mp3', 'm4a', 'wav'],
      signal: null,
    });
    expect(store.patchDoc).toHaveBeenNthCalledWith(1, 'content', 'int-1', { interview: { stage: 'fetching', error: null, fetchJobId: 'j1' } });
    expect(store.patchDoc).toHaveBeenNthCalledWith(2, 'content', 'int-1', {
      provenance: {
        keep: 1,
        source: 'url',
        audio: {
          container: 'interviews-audio',
          path: 'audio/int-1/job-7.m4a',
          bytes: 6,
          sha256: createHash('sha256').update('abcdef').digest('hex'),
          contentType: 'audio/mp4',
          durationSec: null,
          uploadedAt: '2026-11-05T10:00:00.000Z',
          sourceUrl: URL_OK,
          superseded: [],
        },
      },
      interview: { stage: 'fetched', error: null, fetchJobId: 'j1' },
    });
    expect(log.log).toHaveBeenCalledTimes(1);
    const line = log.log.mock.calls[0][0];
    expect(line).toMatch(/^interview-fetch-audio: int-1 6 B audio\/mp4 in \d+ ms$/);
    expect(line).not.toContain('files.example');
    expect(line).not.toContain('guest-voice');
  });

  it('writes each fetch to its own blob and lists the recording it replaces under superseded', async () => {
    const previous = { container: 'interviews-audio', path: 'audio/int-1/job-1.mp3', bytes: 9, uploadedAt: '2026-11-01T00:00:00.000Z', superseded: [{ container: 'interviews-audio', path: 'audio/int-1/job-0.mp3', uploadedAt: null }] };
    const store = makeStore({ id: 'int-1', type: 'interview', provenance: { source: 'upload', audio: previous }, interview: {} });
    const storage = makeStorage();
    await fetchAudioToContainer({ interviewId: 'int-1', sourceUrl: URL_OK, store, storage, fetchStream: vi.fn(async () => fetched(['x'])), env: {}, uploadId: 'job-7' });
    const audio = store.patchDoc.mock.calls[1][2].provenance.audio;
    expect(audio.path).toBe('audio/int-1/job-7.mp3');
    expect(audio.superseded).toEqual([
      { container: 'interviews-audio', path: 'audio/int-1/job-1.mp3', uploadedAt: '2026-11-01T00:00:00.000Z' },
      { container: 'interviews-audio', path: 'audio/int-1/job-0.mp3', uploadedAt: null },
    ]);
    expect(storage.deleteBlob).not.toHaveBeenCalled();
  });

  it('takes octet-stream by the final URL’s extension, after redirects', async () => {
    const storage = makeStorage();
    const fetchStream = vi.fn(async () => fetched(['x'], { type: 'application/octet-stream', url: 'https://cdn.example/dl/file.wav' }));
    const report = await fetchAudioToContainer({ interviewId: 'int-1', sourceUrl: URL_OK, store: makeStore(), storage, fetchStream, env: {}, uploadId: 'job-7' });
    expect(report).toMatchObject({ contentType: 'audio/wav', path: 'audio/int-1/job-7.wav' });
  });

  it('refuses a document that is not an interview, and a host outside the allow-list, before fetching', async () => {
    const fetchStream = vi.fn();
    await expect(fetchAudioToContainer({ interviewId: 'x', sourceUrl: URL_OK, store: makeStore({ id: 'x', type: 'blog' }), storage: makeStorage(), fetchStream, env: {} })).rejects.toMatchObject({ code: 'INTERVIEW_NOT_FOUND' });
    await expect(
      fetchAudioToContainer({ interviewId: 'int-1', sourceUrl: URL_OK, store: makeStore(), storage: makeStorage(), fetchStream, env: { INTERVIEW_AUDIO_URL_HOSTS: 'dropbox.com' } })
    ).rejects.toMatchObject({ code: 'HOST_NOT_ALLOWED', status: 422 });
    expect(fetchStream).not.toHaveBeenCalled();
  });

  it('turns the guard’s refusals into stored sentences by code, never by the guard’s words', async () => {
    const cases = [
      [{ code: 'URL_REFUSED', refused: true, message: 'Private IP access denied: 10.0.0.5' }, 'URL_REFUSED', 422, /not one this site will fetch/],
      [{ code: 'BODY_TOO_LARGE', message: 'Response body exceeds 524288000 bytes' }, 'BODY_TOO_LARGE', 502, /larger than 500 MiB/],
      [{ code: 'FETCH_TIMEOUT', message: 'timeout after 600000 ms' }, 'FETCH_TIMEOUT', 502, /10 minutes/],
      [{ code: 'UNSUPPORTED_TYPE', message: 'Unsupported content type: text/html' }, 'UNSUPPORTED_TYPE', 422, /mp3, m4a or wav/],
      [{ code: 'FETCH_STATUS', status: 404, message: 'HTTP 404' }, 'FETCH_STATUS', 502, /not a 2xx/],
      [{ message: 'socket hang up at 10.0.0.5' }, 'FETCH_FAILED', 502, /^The download failed\.$/],
    ];
    for (const [thrown, code, status, sentence] of cases) {
      const fetchStream = vi.fn(async () => {
        throw Object.assign(new Error(thrown.message), thrown);
      });
      const error = await fetchAudioToContainer({ interviewId: 'int-1', sourceUrl: URL_OK, store: makeStore(), storage: makeStorage(), fetchStream, env: {}, uploadId: 'job-7' }).catch((e) => e);
      expect(error, code).toMatchObject({ code, status });
      expect(error.message, code).toMatch(sentence);
      expect(error.message, code).not.toContain('10.0.0.5');
    }
  });

  it('refuses a type the response does not declare as audio and destroys the stream', async () => {
    const stream = Readable.from([Buffer.from('x')]);
    const destroy = vi.spyOn(stream, 'destroy');
    const fetchStream = vi.fn(async () => ({ ...fetched(['x'], { type: 'text/html' }), stream }));
    const storage = makeStorage();
    await expect(fetchAudioToContainer({ interviewId: 'int-1', sourceUrl: URL_OK, store: makeStore(), storage, fetchStream, env: {}, uploadId: 'job-7' })).rejects.toMatchObject({ code: 'UNSUPPORTED_TYPE', status: 415 });
    expect(destroy).toHaveBeenCalled();
    expect(storage.uploadBlobFromStream).not.toHaveBeenCalled();
  });

  it('a stream that fails on the wire (the cap, the deadline) fails the upload and deletes the partial blob', async () => {
    const broken = new Readable({
      read() {
        this.push(Buffer.from('partial'));
        this.destroy(Object.assign(new Error('Response body exceeds 10 bytes'), { code: 'BODY_TOO_LARGE' }));
      },
    });
    const storage = makeStorage();
    const fetchStream = vi.fn(async () => ({ ...fetched([]), stream: broken }));
    await expect(fetchAudioToContainer({ interviewId: 'int-1', sourceUrl: URL_OK, store: makeStore(), storage, fetchStream, env: {}, uploadId: 'job-7' })).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
    expect(storage.deleteBlob).toHaveBeenCalledWith('interviews-audio', 'audio/int-1/job-7.mp3');
  });

  it('an upload the blob client refuses is reported with its partial blob deleted, and an empty body is refused', async () => {
    const storage = makeStorage();
    storage.uploadBlobFromStream = vi.fn(async () => {
      throw Object.assign(new Error('Server busy; secret-path'), { statusCode: 503 });
    });
    await expect(fetchAudioToContainer({ interviewId: 'int-1', sourceUrl: URL_OK, store: makeStore(), storage, fetchStream: vi.fn(async () => fetched(['x'])), env: {}, uploadId: 'job-7' })).rejects.toMatchObject({
      code: 'FETCH_FAILED',
      message: 'The download failed.',
    });
    expect(storage.deleteBlob).toHaveBeenCalledTimes(1);
    const empty = makeStorage();
    await expect(fetchAudioToContainer({ interviewId: 'int-1', sourceUrl: URL_OK, store: makeStore(), storage: empty, fetchStream: vi.fn(async () => fetched([])), env: {}, uploadId: 'job-7' })).rejects.toMatchObject({ code: 'AUDIO_EMPTY' });
    expect(empty.deleteBlob).toHaveBeenCalledTimes(1);
  });
});

describe('fetchAudioToContainer, after the review', () => {
  const makeStore = (doc = { id: 'int-1', type: 'interview', provenance: {}, interview: { stage: 'uploading' } }) => ({
    readDoc: vi.fn(async () => doc),
    patchDoc: vi.fn(async () => ({})),
  });
  const storage = () => ({ uploadBlobFromStream: vi.fn(), deleteBlob: vi.fn(async () => {}) });

  it('hands the guard a host rule built from the setting, applied on every hop by the guard', async () => {
    const fetchStream = vi.fn(async () => {
      throw Object.assign(new Error('Host is not on the allowed list: cdn.example'), { code: 'HOST_NOT_ALLOWED', refused: true });
    });
    const error = await fetchAudioToContainer({ interviewId: 'int-1', sourceUrl: 'https://www.dropbox.com/s/x.mp3', store: makeStore(), storage: storage(), fetchStream, env: { INTERVIEW_AUDIO_URL_HOSTS: 'dropbox.com' } }).catch((e) => e);
    expect(error).toMatchObject({ code: 'HOST_NOT_ALLOWED', status: 422 });
    expect(error.message).toMatch(/redirect from it/);
    expect(error.message).not.toContain('cdn.example');
    const { allowHost } = fetchStream.mock.calls[0][1];
    expect(allowHost('www.dropbox.com')).toBe(true);
    expect(allowHost('cdn.example')).toBe(false);
  });

  it('records every failure on the document in its own words, with the stage failed', async () => {
    const store = makeStore();
    const fetchStream = vi.fn(async () => {
      throw Object.assign(new Error('timeout after 600000 ms'), { code: 'FETCH_TIMEOUT' });
    });
    await expect(fetchAudioToContainer({ interviewId: 'int-1', sourceUrl: URL_OK, store, storage: storage(), fetchStream, env: {} })).rejects.toMatchObject({ code: 'FETCH_TIMEOUT' });
    expect(store.patchDoc.mock.calls.at(-1)[2]).toEqual({ interview: { stage: 'failed', error: 'The download did not finish within 10 minutes.' } });
    const refused = makeStore();
    await expect(fetchAudioToContainer({ interviewId: 'int-1', sourceUrl: URL_OK, store: refused, storage: storage(), fetchStream: vi.fn(), env: { INTERVIEW_AUDIO_URL_HOSTS: 'dropbox.com' } })).rejects.toMatchObject({ code: 'HOST_NOT_ALLOWED' });
    expect(refused.patchDoc.mock.calls.at(-1)[2].interview.stage).toBe('failed');
  });
});

describe('cleanup that fails', () => {
  it('a partial blob whose delete also fails still reports the download’s own failure', async () => {
    const store = { readDoc: vi.fn(async () => ({ id: 'int-1', type: 'interview' })), patchDoc: vi.fn(async () => ({})) };
    const storage = {
      uploadBlobFromStream: vi.fn(async () => {
        throw Object.assign(new Error('busy'), { statusCode: 503 });
      }),
      deleteBlob: vi.fn(async () => {
        throw new Error('also busy');
      }),
    };
    const fetchStream = vi.fn(async () => ({
      response: { status: 200, headers: { get: () => 'audio/mpeg' } },
      stream: (await import('node:stream')).Readable.from([Buffer.from('x')]),
      url: 'https://files.example/a.mp3',
    }));
    await expect(fetchAudioToContainer({ interviewId: 'int-1', sourceUrl: URL_OK, store, storage, fetchStream, env: {} })).rejects.toMatchObject({ code: 'FETCH_FAILED' });
    expect(storage.deleteBlob).toHaveBeenCalledTimes(1);
  });
});
