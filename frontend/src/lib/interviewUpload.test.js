/**
 * The browser half of the interview upload (lib/interviewUpload.js, ADR 0040
 * D1 and D7): the file checks, the length read, the SHA-256 over 4 MiB slices
 * (never the whole file at once, never an empty fallback), the block plan,
 * three in flight, the per-block retry, the stop on INTERVIEW_DELETED, the
 * refusal of a recording over 9.5 hours before any request, and resuming a
 * failed upload on the same session.
 *
 * The audio types, aliases and limits are pinned against the server's own
 * file (functions/src/lib/interviews/storage.js and upload.js), so the two
 * halves cannot drift apart unnoticed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import {
  AUDIO_TYPES,
  AUDIO_TYPE_ALIASES,
  BLOCK_SIZE,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_SECONDS,
  UploadError,
  audioFileProblem,
  audioTypeOf,
  blockRange,
  canonicalAudioType,
  createAudioUpload,
  durationProblem,
  formatDuration,
  hashFile,
  isRetryable,
  readAudioDuration,
} from '@/lib/interviewUpload';

const here = path.dirname(fileURLToPath(import.meta.url));
const functionsLib = path.resolve(here, '../../../functions/src/lib/interviews');

/** A file stand-in over real bytes: `slice` and `arrayBuffer`, as a File has. */
function fakeFile(bytes, { name = 'talk.mp3', type = 'audio/mpeg', failSlice = -1 } = {}) {
  return {
    name,
    type,
    size: bytes.length,
    slice(start, end) {
      return {
        arrayBuffer: async () => {
          if (start === failSlice) throw new Error('disk gone');
          // A copy: a Node Buffer's slice is a view, and its .buffer is the whole pool.
          return new Uint8Array(bytes.subarray(start, end)).buffer;
        },
      };
    },
  };
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The pairs of a `{ 'a': 'b', ... }` block that follows `name` in a source file. */
function objectPairs(source, name) {
  const start = source.indexOf(name);
  const block = source.slice(start, source.indexOf('});', start));
  return Object.fromEntries(
    [...block.matchAll(/'([^']+)':\s*'([^']+)'/g)].map((m) => [m[1], m[2]])
  );
}

describe('the server’s rules, pinned', () => {
  const storage = fs.readFileSync(path.join(functionsLib, 'storage.js'), 'utf8');
  const upload = fs.readFileSync(path.join(functionsLib, 'upload.js'), 'utf8');

  it('uses the same three types and alias spellings as storage.js', () => {
    expect(objectPairs(storage, 'AUDIO_TYPES = Object.freeze({')).toEqual(AUDIO_TYPES);
    expect(objectPairs(storage, 'AUDIO_TYPE_ALIASES = Object.freeze({')).toEqual(
      AUDIO_TYPE_ALIASES
    );
  });

  it('uses the same size, length and block limits', () => {
    expect(storage).toMatch(/MAX_AUDIO_BYTES = 500 \* 1024 \* 1024;/);
    expect(MAX_AUDIO_BYTES).toBe(500 * 1024 * 1024);
    expect(storage).toMatch(
      new RegExp(
        `MAX_AUDIO_SECONDS = ${MAX_AUDIO_SECONDS.toLocaleString('en-US').replace(',', '_')};`
      )
    );
    expect(upload).toMatch(/BLOCK_SIZE = 4 \* 1024 \* 1024;/);
    expect(BLOCK_SIZE).toBe(4 * 1024 * 1024);
  });
});

describe('file checks', () => {
  it('folds every alias to its canonical type, and refuses anything else', () => {
    for (const [alias, canonical] of Object.entries(AUDIO_TYPE_ALIASES)) {
      expect(canonicalAudioType(alias)).toBe(canonical);
    }
    expect(canonicalAudioType('Audio/MPEG; charset=binary')).toBe('audio/mpeg');
    expect(canonicalAudioType('audio/ogg')).toBeNull();
    expect(canonicalAudioType(undefined)).toBeNull();
  });

  it('takes the type from the extension only when the browser gave none', () => {
    expect(audioTypeOf({ name: 'a.m4a', type: '' })).toBe('audio/mp4');
    expect(audioTypeOf({ name: 'a.m4a', type: 'audio/x-m4a' })).toBe('audio/mp4');
    expect(audioTypeOf({ name: 'a.mp3', type: 'video/mp4' })).toBeNull();
    expect(audioTypeOf({ name: 'notes.txt', type: '' })).toBeNull();
  });

  it('says what is wrong with a file in a sentence', () => {
    expect(audioFileProblem(null)).toMatch(/Choose a recording/);
    expect(audioFileProblem({ name: 'a.ogg', type: 'audio/ogg', size: 10 })).toMatch(
      /MP3, M4A or WAV/
    );
    expect(audioFileProblem({ name: 'a.wav', type: 'audio/mpeg', size: 10 })).toMatch(
      /end in \.mp3/
    );
    expect(audioFileProblem({ name: 'a.mp3', type: 'audio/mpeg', size: 0 })).toMatch(/empty/);
    expect(
      audioFileProblem({ name: 'a.mp3', type: 'audio/mpeg', size: MAX_AUDIO_BYTES + 1 })
    ).toMatch(/500 MB/);
    expect(audioFileProblem({ name: 'A.MP3', type: 'audio/mp3', size: MAX_AUDIO_BYTES })).toBe('');
  });

  it('accepts 9.5 hours exactly and refuses one second more, or a length it cannot read', () => {
    expect(durationProblem(MAX_AUDIO_SECONDS)).toBe('');
    expect(durationProblem(MAX_AUDIO_SECONDS + 1)).toMatch(/9 hours 30 minutes/);
    expect(durationProblem(null)).toMatch(/could not be read/);
    expect(durationProblem(Number.POSITIVE_INFINITY)).toMatch(/could not be read/);
    expect(durationProblem(0)).toMatch(/could not be read/);
  });

  it('writes a length the way the form shows it', () => {
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(750)).toBe('12 min 30 s');
    expect(formatDuration(3900)).toBe('1 h 05 min');
  });

  it('cuts the file into 4 MiB ranges with a short last one', () => {
    expect(blockRange(BLOCK_SIZE * 2 + 5, 0)).toEqual([0, BLOCK_SIZE]);
    expect(blockRange(BLOCK_SIZE * 2 + 5, 2)).toEqual([BLOCK_SIZE * 2, BLOCK_SIZE * 2 + 5]);
  });
});

describe('readAudioDuration', () => {
  function fakeAudio(behaviour) {
    const audio = { removeAttribute: vi.fn() };
    Object.defineProperty(audio, 'src', {
      set() {
        queueMicrotask(() => behaviour(audio));
      },
    });
    return audio;
  }

  it('resolves to the length the browser reads, and releases the object URL', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    const seconds = await readAudioDuration(fakeFile(new Uint8Array(4)), {
      createAudio: () =>
        fakeAudio((audio) => {
          audio.duration = 3725.5;
          audio.onloadedmetadata();
        }),
    });
    expect(seconds).toBe(3725.5);
    expect(revoke).toHaveBeenCalledWith('blob:x');
  });

  it('refuses a length that is not a positive number, an error and a timeout', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const file = fakeFile(new Uint8Array(4));
    const nan = readAudioDuration(file, {
      createAudio: () =>
        fakeAudio((audio) => {
          audio.duration = Number.NaN;
          audio.onloadedmetadata();
        }),
    });
    await expect(nan).rejects.toMatchObject({ code: 'DURATION_UNREADABLE' });
    const broken = readAudioDuration(file, {
      createAudio: () => fakeAudio((audio) => audio.onerror()),
    });
    await expect(broken).rejects.toMatchObject({ code: 'DURATION_UNREADABLE' });
    const silent = readAudioDuration(file, {
      createAudio: () => fakeAudio(() => {}),
      timeoutMs: 5,
    });
    await expect(silent).rejects.toBeInstanceOf(UploadError);
  });
});

describe('hashFile', () => {
  it('hashes a file of several slices to the digest of the whole', async () => {
    const bytes = randomBytes(BLOCK_SIZE * 2 + 12345);
    const progress = vi.fn();
    const hex = await hashFile(fakeFile(bytes), { onProgress: progress });
    expect(hex).toBe(sha(bytes));
    expect(progress).toHaveBeenCalledTimes(3);
    expect(progress).toHaveBeenLastCalledWith(bytes.length, bytes.length);
  });

  it('fails with HASH_FAILED when a slice cannot be read, never an empty digest', async () => {
    const bytes = randomBytes(BLOCK_SIZE + 10);
    await expect(hashFile(fakeFile(bytes, { failSlice: BLOCK_SIZE }))).rejects.toMatchObject({
      code: 'HASH_FAILED',
    });
  });

  it('stops when asked', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      hashFile(fakeFile(randomBytes(10)), { signal: controller.signal })
    ).rejects.toMatchObject({ code: 'ABORTED' });
  });
});

describe('isRetryable', () => {
  it('retries the network, 5xx and 429, and nothing else', () => {
    expect(isRetryable(new Error('Failed to fetch'))).toBe(true);
    expect(isRetryable({ status: 503 })).toBe(true);
    expect(isRetryable({ status: 429 })).toBe(true);
    expect(isRetryable({ status: 400 })).toBe(false);
    expect(isRetryable({ status: 404 })).toBe(false);
    expect(isRetryable({ status: 409, code: 'INTERVIEW_DELETED' })).toBe(false);
    expect(isRetryable({ code: 'INTERVIEW_DELETED' })).toBe(false);
  });
});

/** A fake API that answers the upload routes the way upload.js does. */
function fakeApi({ blockSize = BLOCK_SIZE, putFails = () => null } = {}) {
  const puts = [];
  let inFlight = 0;
  let peak = 0;
  const postJSON = vi.fn(async (route, body) => {
    if (route === 'cms/interviews/uploads') {
      return { uploadId: 'up-1', blockSize, blockCount: Math.ceil(body.bytes / BLOCK_SIZE) };
    }
    return { ok: true, bytes: 1 };
  });
  const putBytes = vi.fn(async (route, body) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    const index = Number(route.split('/').pop());
    puts.push({ index, bytes: body.byteLength });
    const failure = putFails(index, puts.filter((p) => p.index === index).length);
    if (failure) throw failure;
    return { ok: true, index };
  });
  return { postJSON, putBytes, wait: async () => {}, puts, peak: () => peak };
}

describe('createAudioUpload', () => {
  const bytes = randomBytes(BLOCK_SIZE * 4 + 777);
  const file = () => fakeFile(bytes);

  it('opens with the declared hash and length, sends every block three at a time, then completes', async () => {
    const api = fakeApi();
    const progress = vi.fn();
    const job = createAudioUpload({
      interviewId: 'int-1',
      file: file(),
      durationSec: 1800,
      onProgress: progress,
      deps: api,
    });
    const answer = await job.run();
    expect(answer).toEqual({ ok: true, bytes: 1 });
    expect(api.postJSON.mock.calls[0]).toEqual([
      'cms/interviews/uploads',
      {
        interviewId: 'int-1',
        fileName: 'talk.mp3',
        contentType: 'audio/mpeg',
        bytes: bytes.length,
        sha256: sha(bytes),
        durationSec: 1800,
      },
    ]);
    expect(api.puts.map((p) => p.index).sort()).toEqual([0, 1, 2, 3, 4]);
    expect(api.puts.find((p) => p.index === 4).bytes).toBe(777);
    expect(api.puts.find((p) => p.index === 0).bytes).toBe(BLOCK_SIZE);
    expect(api.peak()).toBeLessThanOrEqual(3);
    expect(api.peak()).toBeGreaterThan(1);
    expect(api.postJSON.mock.calls[1]).toEqual(['cms/interviews/uploads/up-1/complete', {}]);
    const phases = progress.mock.calls.map(([p]) => p.phase);
    expect(phases[0]).toBe('hashing');
    expect(phases).toContain('uploading');
    expect(phases.at(-1)).toBe('done');
    // A second run after success does nothing more.
    await job.run();
    expect(api.postJSON).toHaveBeenCalledTimes(2);
  });

  it('refuses a recording over 9.5 hours before any request', async () => {
    const api = fakeApi();
    const job = createAudioUpload({
      interviewId: 'int-1',
      file: file(),
      durationSec: MAX_AUDIO_SECONDS + 1,
      deps: api,
    });
    await expect(job.run()).rejects.toMatchObject({ code: 'TOO_LONG' });
    expect(api.postJSON).not.toHaveBeenCalled();
    expect(api.putBytes).not.toHaveBeenCalled();
  });

  it('re-sends a block that failed with a 503, alone, and then carries on', async () => {
    const api = fakeApi({
      putFails: (index, attempt) =>
        index === 2 && attempt === 1 ? Object.assign(new Error('busy'), { status: 503 }) : null,
    });
    const job = createAudioUpload({
      interviewId: 'int-1',
      file: file(),
      durationSec: 60,
      deps: api,
    });
    await job.run();
    expect(api.puts.filter((p) => p.index === 2)).toHaveLength(2);
    expect(api.puts.filter((p) => p.index === 1)).toHaveLength(1);
  });

  it('stops for good on INTERVIEW_DELETED, without a retry or a completion', async () => {
    const api = fakeApi({
      putFails: () => Object.assign(new Error('gone'), { status: 409, code: 'INTERVIEW_DELETED' }),
    });
    const job = createAudioUpload({
      interviewId: 'int-1',
      file: file(),
      durationSec: 60,
      deps: api,
    });
    const failure = await job.run().catch((error) => error);
    expect(failure).toBeInstanceOf(UploadError);
    expect(failure.code).toBe('INTERVIEW_DELETED');
    expect(failure.message).toMatch(/being deleted/);
    const perIndex = new Set(api.puts.map((p) => p.index));
    expect(api.puts.length).toBe(perIndex.size);
    expect(api.postJSON).toHaveBeenCalledTimes(1);
  });

  it('does not retry a refusal such as 400', async () => {
    const api = fakeApi({
      putFails: (index) =>
        index === 0 ? Object.assign(new Error('Block 0 must be exactly…'), { status: 400 }) : null,
    });
    const job = createAudioUpload({
      interviewId: 'int-1',
      file: file(),
      durationSec: 60,
      deps: api,
    });
    await expect(job.run()).rejects.toMatchObject({ status: 400 });
    expect(api.puts.filter((p) => p.index === 0)).toHaveLength(1);
  });

  it('resumes on the same session, sending only the blocks the server did not acknowledge', async () => {
    let broken = true;
    const api = fakeApi({
      putFails: (index) =>
        broken && index === 3 ? Object.assign(new Error('offline'), { status: 502 }) : null,
    });
    const job = createAudioUpload({
      interviewId: 'int-1',
      file: file(),
      durationSec: 60,
      deps: api,
    });
    await expect(job.run()).rejects.toMatchObject({ status: 502 });
    expect(api.puts.filter((p) => p.index === 3)).toHaveLength(3);
    expect(job.state.session.uploadId).toBe('up-1');
    const before = api.puts.length;
    broken = false;
    await job.run();
    const resent = api.puts.slice(before).map((p) => p.index);
    expect(resent).toEqual([3]);
    // One open, one completion: the session was kept.
    expect(api.postJSON.mock.calls.map(([route]) => route)).toEqual([
      'cms/interviews/uploads',
      'cms/interviews/uploads/up-1/complete',
    ]);
  });

  it('sends every block again after the server refuses the completion with 422', async () => {
    const api = fakeApi();
    let refuse = true;
    api.postJSON.mockImplementation(async (route, body) => {
      if (route === 'cms/interviews/uploads') {
        return {
          uploadId: 'up-1',
          blockSize: BLOCK_SIZE,
          blockCount: Math.ceil(body.bytes / BLOCK_SIZE),
        };
      }
      if (refuse) {
        refuse = false;
        throw Object.assign(new Error('The uploaded size does not match'), { status: 422 });
      }
      return { ok: true };
    });
    const job = createAudioUpload({
      interviewId: 'int-1',
      file: file(),
      durationSec: 60,
      deps: api,
    });
    await expect(job.run()).rejects.toMatchObject({ status: 422 });
    await job.run();
    expect(api.puts).toHaveLength(10);
  });

  it('refuses a session plan it does not understand', async () => {
    const api = fakeApi({ blockSize: 1024 });
    const job = createAudioUpload({
      interviewId: 'int-1',
      file: file(),
      durationSec: 60,
      deps: api,
    });
    await expect(job.run()).rejects.toMatchObject({ code: 'BAD_SESSION' });
    expect(api.putBytes).not.toHaveBeenCalled();
  });
});
