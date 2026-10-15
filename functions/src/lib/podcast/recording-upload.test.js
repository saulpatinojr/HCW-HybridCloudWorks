/**
 * The upload → Plaud Embedded → recordings path: the media-type gate, the
 * payload shape the job accepts, the public URL it hands Plaud, and the
 * document it stores.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ACCEPTED_AUDIO_EXTENSIONS,
  EMBEDDED_SOURCE,
  MAX_AUDIO_UPLOAD_BYTES,
  UPLOAD_JOB_TYPE,
  checkAudioUpload,
  parseUploadPayload,
  publicAudioUrlFor,
  toRecordingDoc,
  transcribeUpload,
  uploadPathFor,
} from './recording-upload.js';
import { API_KEY_SETTING, CLIENT_ID_SETTING, PlaudEmbeddedNotConfiguredError } from './plaud-embedded.js';
import { RECORDINGS_CONTAINER } from './recording-generate.js';
import { isValidBlobPath } from '../blob-paths.js';

const NOW = '2026-09-08T12:00:00.000Z';
const env = {
  [CLIENT_ID_SETTING]: 'client-1',
  [API_KEY_SETTING]: 'key-1',
  PUBLIC_API_ORIGIN: 'https://api-azure.hybridcloudworks.com',
};

describe('checkAudioUpload', () => {
  it('accepts the three documented formats under every spelling browsers send', () => {
    expect(checkAudioUpload({ contentType: 'audio/mpeg', fileName: 'a.mp3' })).toEqual({
      ok: true,
      contentType: 'audio/mpeg',
      extension: 'mp3',
    });
    expect(checkAudioUpload({ contentType: 'audio/mp3', fileName: 'A.MP3' }).contentType).toBe('audio/mpeg');
    expect(checkAudioUpload({ contentType: 'audio/x-m4a; codecs=1', fileName: 'x.m4a' })).toEqual({
      ok: true,
      contentType: 'audio/mp4',
      extension: 'm4a',
    });
    expect(checkAudioUpload({ contentType: 'audio/x-wav', fileName: 'dir\\deep/x.wav' }).contentType).toBe(
      'audio/wav'
    );
    expect(ACCEPTED_AUDIO_EXTENSIONS).toEqual(['mp3', 'm4a', 'wav']);
  });

  it('refuses anything else, and a type whose extension disagrees', () => {
    expect(checkAudioUpload({ contentType: 'text/html', fileName: 'a.html' })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/Unsupported audio type/),
    });
    expect(checkAudioUpload({ contentType: 'audio/mpeg', fileName: 'a.wav' })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/extension does not match/),
    });
    expect(checkAudioUpload({ contentType: 'audio/mpeg', fileName: 'noext' }).ok).toBe(false);
  });
});

describe('upload paths and payloads', () => {
  it('mints uploads/<uuid>.<ext>, which the blob path rule accepts', () => {
    const path = uploadPathFor('0d5c3d3e-1f5a-4a1c-9f6d-2b3c4d5e6f70', 'mp3');
    expect(path).toBe('uploads/0d5c3d3e-1f5a-4a1c-9f6d-2b3c4d5e6f70.mp3');
    expect(isValidBlobPath(path)).toBe(true);
  });

  it('accepts only a minted path and a bounded title', () => {
    const good = { uploadPath: uploadPathFor('0d5c3d3e-1f5a-4a1c-9f6d-2b3c4d5e6f70', 'm4a'), title: ' Stand-up ' };
    expect(parseUploadPayload(good)).toEqual({
      value: { uploadPath: good.uploadPath, title: 'Stand-up' },
    });
    expect(parseUploadPayload({ title: 't' }).error).toBe('uploadPath is required');
    // Any other blob would make the job an oracle for that blob's existence.
    expect(parseUploadPayload({ uploadPath: 'article/foo.mp3', title: 't' }).error).toBe(
      'uploadPath is not an upload path'
    );
    expect(parseUploadPayload({ uploadPath: 'uploads/../x.mp3', title: 't' }).error).toBe(
      'uploadPath is not an upload path'
    );
    expect(parseUploadPayload({ uploadPath: good.uploadPath }).error).toBe('title is required');
    expect(parseUploadPayload({ uploadPath: good.uploadPath, title: 'x'.repeat(201) }).error).toMatch(
      /longer than 200/
    );
    expect(UPLOAD_JOB_TYPE).toBe('transcribe-recording-upload');
    expect(MAX_AUDIO_UPLOAD_BYTES).toBe(40 * 1024 * 1024);
  });

  it('builds the public media URL on PUBLIC_API_ORIGIN, and says so when it is unset', () => {
    expect(publicAudioUrlFor('uploads/u1.mp3', env)).toBe(
      'https://api-azure.hybridcloudworks.com/api/public/media/podcast/uploads/u1.mp3'
    );
    expect(publicAudioUrlFor('uploads/u1.mp3', { PUBLIC_API_ORIGIN: 'https://x.test/' })).toBe(
      'https://x.test/api/public/media/podcast/uploads/u1.mp3'
    );
    expect(() => publicAudioUrlFor('uploads/u1.mp3', {})).toThrow(/PUBLIC_API_ORIGIN is not set/);
    expect(() => publicAudioUrlFor('uploads/u1.mp3', { PUBLIC_API_ORIGIN: 'http://x.test' })).toThrow(
      /PUBLIC_API_ORIGIN/
    );
  });
});

describe('toRecordingDoc', () => {
  it('matches the shape POST cms/recordings writes, plus the structured segments', () => {
    const doc = toRecordingDoc({
      id: 'u1',
      title: 'Stand-up',
      uploadPath: 'uploads/u1.mp3',
      transcriptionId: 'task_exec_1',
      result: {
        segments: [
          { startMs: 0, endMs: 1000, text: 'Hello', speaker: 'Speaker 1' },
          { startMs: 1000, endMs: 2000, text: 'Hi', speaker: null },
        ],
        durationMs: 2000,
        language: 'en',
        text: 'Hello Hi',
      },
      now: NOW,
    });
    expect(doc).toEqual({
      id: 'u1',
      title: 'Stand-up',
      source: EMBEDDED_SOURCE,
      status: 'new',
      transcript: 'Speaker 1: Hello\nHi',
      segments: [
        { startMs: 0, endMs: 1000, text: 'Hello', speaker: 'Speaker 1' },
        { startMs: 1000, endMs: 2000, text: 'Hi', speaker: null },
      ],
      durationMs: 2000,
      language: 'en',
      transcriptionId: 'task_exec_1',
      uploadPath: 'uploads/u1.mp3',
      createdAt: NOW,
    });
  });
});

describe('transcribeUpload', () => {
  const uploadPath = uploadPathFor('0d5c3d3e-1f5a-4a1c-9f6d-2b3c4d5e6f70', 'mp3');
  const makeStore = () => {
    const docs = {};
    return { docs, upsertDoc: vi.fn(async (_c, doc) => (docs[doc.id] = doc)) };
  };

  it('creates with the public URL, waits, normalises and stores the recording', async () => {
    const store = makeStore();
    const createTranscription = vi.fn(async () => ({ transcriptionId: 'task_exec_1', status: 'PENDING' }));
    const waitForTranscription = vi.fn(async () => ({
      transcriptionId: 'task_exec_1',
      status: 'SUCCESS',
      data: {
        duration: 2,
        language: 'en',
        results: [{ start: 0, end: 1.5, text: 'Hello there', speaker_id: 'Speaker 1' }],
      },
    }));

    const report = await transcribeUpload({
      uploadPath,
      title: 'Stand-up',
      store,
      env,
      now: NOW,
      timeoutMs: 1000,
      deps: { createTranscription, waitForTranscription, uuid: () => 'rec-u1' },
    });

    expect(createTranscription).toHaveBeenCalledWith({
      fileUrl: `https://api-azure.hybridcloudworks.com/api/public/media/podcast/${uploadPath}`,
      env,
    });
    expect(waitForTranscription).toHaveBeenCalledWith({ transcriptionId: 'task_exec_1', env, timeoutMs: 1000 });
    expect(store.upsertDoc).toHaveBeenCalledWith(RECORDINGS_CONTAINER, expect.objectContaining({ id: 'rec-u1' }));
    expect(store.docs['rec-u1']).toMatchObject({
      source: EMBEDDED_SOURCE,
      title: 'Stand-up',
      transcript: 'Speaker 1: Hello there',
      durationMs: 2000,
      transcriptionId: 'task_exec_1',
      uploadPath,
    });
    expect(report).toEqual({
      id: 'rec-u1',
      transcriptionId: 'task_exec_1',
      segments: 1,
      durationMs: 2000,
      uploadDeleted: false,
    });
  });

  describe('the upload blob is deleted once Plaud is done with it', () => {
    const success = () =>
      vi.fn(async () => ({ transcriptionId: 't1', status: 'SUCCESS', data: { results: [] } }));
    const create = () => vi.fn(async () => ({ transcriptionId: 't1', status: 'PENDING' }));
    const failing = (code) =>
      vi.fn(async () => {
        throw Object.assign(new Error(`Plaud Embedded transcription t1 ended with status ${code}`), {
          code: `PLAUD_EMBEDDED_${code}`,
        });
      });

    it('on SUCCESS, after the wait and before the document is stored', async () => {
      const order = [];
      const store = { upsertDoc: vi.fn(async () => order.push('store')) };
      const storage = { deleteBlob: vi.fn(async () => order.push('delete')) };
      const report = await transcribeUpload({
        uploadPath,
        title: 't',
        store,
        storage,
        env,
        deps: { createTranscription: create(), waitForTranscription: success(), uuid: () => 'u' },
      });
      expect(storage.deleteBlob).toHaveBeenCalledWith('podcast', uploadPath);
      expect(order).toEqual(['delete', 'store']);
      expect(report.uploadDeleted).toBe(true);
    });

    it('on FAILURE and REVOKED, and when the submission itself failed', async () => {
      for (const wait of [failing('FAILURE'), failing('REVOKED')]) {
        const storage = { deleteBlob: vi.fn() };
        await expect(
          transcribeUpload({
            uploadPath,
            title: 't',
            store: makeStore(),
            storage,
            env,
            deps: { createTranscription: create(), waitForTranscription: wait },
          })
        ).rejects.toThrow(/ended with status/);
        expect(storage.deleteBlob).toHaveBeenCalledWith('podcast', uploadPath);
      }
      const storage = { deleteBlob: vi.fn() };
      await expect(
        transcribeUpload({
          uploadPath,
          title: 't',
          store: makeStore(),
          storage,
          env,
          deps: {
            createTranscription: vi.fn(async () => {
              throw new Error('HTTP 500');
            }),
          },
        })
      ).rejects.toThrow('HTTP 500');
      expect(storage.deleteBlob).toHaveBeenCalledTimes(1);
    });

    it('is kept on a poll timeout — Plaud may still be reading it; the lifecycle rule expires it', async () => {
      const storage = { deleteBlob: vi.fn() };
      await expect(
        transcribeUpload({
          uploadPath,
          title: 't',
          store: makeStore(),
          storage,
          env,
          deps: { createTranscription: create(), waitForTranscription: failing('TIMEOUT') },
        })
      ).rejects.toThrow(/TIMEOUT/);
      expect(storage.deleteBlob).not.toHaveBeenCalled();
    });

    it('a delete that fails is logged content-free and does not change the outcome', async () => {
      const storage = {
        deleteBlob: vi.fn(async () => {
          throw Object.assign(new Error('Server busy; secret-path-in-message'), { statusCode: 503 });
        }),
      };
      const log = { warn: vi.fn() };
      const store = makeStore();
      const report = await transcribeUpload({
        uploadPath,
        title: 't',
        store,
        storage,
        env,
        log,
        deps: { createTranscription: create(), waitForTranscription: success(), uuid: () => 'u' },
      });
      expect(report.uploadDeleted).toBe(false);
      expect(store.upsertDoc).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledTimes(1);
      const line = log.warn.mock.calls[0][0];
      expect(line).toMatch(/upload blob not deleted \(503\)/);
      expect(line).not.toContain(uploadPath);
      expect(line).not.toContain('secret-path');
    });

    it('does nothing without a storage seam, so the pure path still works', async () => {
      const report = await transcribeUpload({
        uploadPath,
        title: 't',
        store: makeStore(),
        env,
        deps: { createTranscription: create(), waitForTranscription: success(), uuid: () => 'u' },
      });
      expect(report.uploadDeleted).toBe(false);
    });
  });

  it('not configured → the plain sentence, and nothing is called or stored', async () => {
    const store = makeStore();
    const createTranscription = vi.fn();
    await expect(
      transcribeUpload({ uploadPath, title: 't', store, env: {}, deps: { createTranscription } })
    ).rejects.toThrow(PlaudEmbeddedNotConfiguredError);
    expect(createTranscription).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('a bad payload fails before anything is called', async () => {
    const createTranscription = vi.fn();
    await expect(
      transcribeUpload({ uploadPath: 'article/x.mp3', title: 't', store: makeStore(), env, deps: { createTranscription } })
    ).rejects.toThrow(/not an upload path/);
    expect(createTranscription).not.toHaveBeenCalled();
  });

  it('a failed transcription propagates by name and stores nothing', async () => {
    const store = makeStore();
    await expect(
      transcribeUpload({
        uploadPath,
        title: 't',
        store,
        env,
        deps: {
          createTranscription: vi.fn(async () => ({ transcriptionId: 't9', status: 'PENDING' })),
          waitForTranscription: vi.fn(async () => {
            throw new Error('Plaud Embedded transcription t9 ended with status FAILURE');
          }),
        },
      })
    ).rejects.toThrow(/t9 ended with status FAILURE/);
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });
});
