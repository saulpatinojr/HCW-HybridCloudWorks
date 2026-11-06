/**
 * A pasted transcript (ADR 0040 D3, the last bullet): speaker lines kept as
 * turns, the 400,000-character cap, written as version 1 with no audio and
 * no Gemini call, and a content-free log line.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  MAX_TRANSCRIPT_CHARS,
  checkTranscriptText,
  parseSpeakerTurns,
  storeProvidedTranscript,
  transcriptDocument,
} from './transcript-text.js';

describe('parseSpeakerTurns', () => {
  it('keeps Speaker N: lines as turns, joins continuation lines, and ignores blank ones', () => {
    expect(
      parseSpeakerTurns('Speaker 1: Why landing zones?\n\nSpeaker 2: Because the estate\ngrew.\nSPEAKER_01: Right.')
    ).toEqual([
      { speaker: 'Speaker 1', text: 'Why landing zones?' },
      { speaker: 'Speaker 2', text: 'Because the estate grew.' },
      { speaker: 'SPEAKER_01', text: 'Right.' },
    ]);
  });

  it('reads a transcript with no labels as one turn of Speaker 1, and a URL-like line as text, not a label', () => {
    expect(parseSpeakerTurns('Just words.\nMore words.')).toEqual([{ speaker: 'Speaker 1', text: 'Just words. More words.' }]);
    expect(parseSpeakerTurns('Alex: see https://a.example: it works')).toEqual([{ speaker: 'Alex', text: 'see https://a.example: it works' }]);
    expect(parseSpeakerTurns('')).toEqual([]);
  });
});

describe('checkTranscriptText', () => {
  it('requires text under the cap the recording draft route uses', () => {
    expect(MAX_TRANSCRIPT_CHARS).toBe(400_000);
    expect(checkTranscriptText({})).toMatchObject({ ok: false, status: 400 });
    expect(checkTranscriptText({ text: '   ' })).toMatchObject({ ok: false, status: 400 });
    expect(checkTranscriptText({ text: 'x'.repeat(MAX_TRANSCRIPT_CHARS + 1) })).toMatchObject({ ok: false, status: 413 });
    expect(checkTranscriptText({ text: 'Speaker 1: hi' })).toEqual({ ok: true, text: 'Speaker 1: hi' });
  });
});

describe('transcriptDocument', () => {
  it('carries the segments and a plain "Speaker: text" rendering', () => {
    const doc = transcriptDocument({ version: 2, source: 'gemini', model: 'm', provider: 'gemini', windows: 1, segments: [{ speaker: 'Speaker 1', text: 'Hi' }] });
    expect(doc).toEqual({ version: 2, source: 'gemini', model: 'm', provider: 'gemini', windows: 1, segments: [{ speaker: 'Speaker 1', text: 'Hi' }], text: 'Speaker 1: Hi' });
    expect(transcriptDocument({ version: 1, source: 'provided', segments: [] })).toEqual({ version: 1, source: 'provided', segments: [], text: '' });
  });
});

describe('storeProvidedTranscript', () => {
  const makeStore = (doc) => ({ readDoc: vi.fn(async () => doc), patchDoc: vi.fn(async () => ({})) });

  it('writes v1 to the container, patches the document’s blocks whole, and logs counts only', async () => {
    const store = makeStore({ id: 'int-1', type: 'interview', provenance: { keep: true }, interview: { stage: 'uploading' } });
    const storage = { uploadBlob: vi.fn(async () => 'url') };
    const log = { log: vi.fn() };
    const text = 'Speaker 1: Why?\nSpeaker 2: Because Alex Example said so at https://secret.example/share';
    const report = await storeProvidedTranscript({ interviewId: 'int-1', text, store, storage, log, now: () => new Date('2026-11-05T10:00:00Z') });
    expect(report).toEqual({ interviewId: 'int-1', version: 1, segments: 2, chars: text.length });
    expect(storage.uploadBlob).toHaveBeenCalledWith('interviews-audio', 'transcripts/int-1/v1.json', expect.any(String), 'application/json');
    const written = JSON.parse(storage.uploadBlob.mock.calls[0][2]);
    expect(written).toMatchObject({ version: 1, source: 'provided', segments: [{ start: 0, end: 0, speaker: 'Speaker 1', text: 'Why?' }, expect.any(Object)] });
    expect(store.patchDoc).toHaveBeenCalledWith('content', 'int-1', {
      transcription: { version: 1, jobId: null, status: 'provided', transcribedAt: '2026-11-05T10:00:00.000Z' },
      provenance: { keep: true, source: 'transcript', transcription: { version: 1, source: 'provided', transcribedAt: '2026-11-05T10:00:00.000Z' } },
      interview: { stage: 'transcribed', error: null },
    });
    const line = log.log.mock.calls[0][0];
    expect(line).toBe(`interview transcript: int-1 v1 provided (2 turns, ${text.length} chars)`);
    expect(line).not.toContain('Alex');
    expect(line).not.toContain('secret.example');
  });

  it('writes the next version after the ones already made, so a Gemini transcript is never written over', async () => {
    const store = makeStore({ id: 'int-1', type: 'interview', transcription: { version: 3, status: 'done' } });
    const storage = { uploadBlob: vi.fn(async () => 'url') };
    const report = await storeProvidedTranscript({ interviewId: 'int-1', text: 'Speaker 1: hi', store, storage });
    expect(report.version).toBe(4);
    expect(storage.uploadBlob.mock.calls[0][1]).toBe('transcripts/int-1/v4.json');
    expect(store.patchDoc.mock.calls[0][2].transcription).toMatchObject({ version: 4, status: 'provided' });
  });

  it('refuses a document that is not an interview, and a transcript with no words, before writing anything', async () => {
    const storage = { uploadBlob: vi.fn() };
    await expect(storeProvidedTranscript({ interviewId: 'x', text: 'Speaker 1: hi', store: makeStore({ id: 'x', type: 'blog' }), storage })).rejects.toMatchObject({ code: 'INTERVIEW_NOT_FOUND', status: 404 });
    await expect(storeProvidedTranscript({ interviewId: 'x', text: 'Speaker 1: hi', store: makeStore(null), storage })).rejects.toMatchObject({ code: 'INTERVIEW_NOT_FOUND' });
    await expect(storeProvidedTranscript({ interviewId: 'x', text: '\n\n', store: makeStore({ id: 'x', type: 'interview' }), storage })).rejects.toMatchObject({ code: 'TRANSCRIPT_EMPTY', status: 400 });
    expect(storage.uploadBlob).not.toHaveBeenCalled();
  });
});
