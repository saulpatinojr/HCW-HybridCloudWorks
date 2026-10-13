/**
 * The transcript document and its persistence.
 *
 * What is pinned: the id scheme (the hub and #434's Plaud path key on it),
 * that regeneration drops approval, that a failure record keeps a previous
 * good transcript, and that a missing container is explained rather than
 * reported as a bare 404.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  PODCAST_AUDIO_CONTAINER,
  STATUS,
  TRANSCRIPT_CONTAINER,
  TRANSCRIPT_LIST_FIELDS,
  articleKey,
  audioPath,
  markTranscriptFailed,
  resolveArticleProvider,
  saveTranscript,
  setTranscriptStatus,
  toTranscriptDoc,
  transcriptId,
  uploadTranscriptAudio,
} from './store.js';
import { isValidBlobPath } from '../blob-paths.js';

const NOW = '2026-09-08T12:00:00.000Z';

const article = (over = {}) => ({
  id: 'content-1',
  Title: 'Picking a state backend',
  slug: 'picking-a-state-backend',
  'Cloud Provider': 'Azure',
  contentStatus: 'published_blog',
  ...over,
});

const script = (over = {}) => ({
  title: 'State backends, spoken',
  summary: 'Why remote state matters.',
  keyTakeaways: ['Lock it', 'Shard it'],
  speakers: { a: 'Maya', b: 'Elena' },
  dialogue: [{ speaker: 'Maya', text: 'Hello' }],
  byteLength: 5,
  trimmedTurns: 0,
  truncated: false,
  ...over,
});

const audio = (over = {}) => ({
  url: '/api/public/media/podcast/article/picking-a-state-backend.mp3',
  path: 'article/picking-a-state-backend.mp3',
  bytes: 3,
  speechProvider: 'gemini',
  speechModel: 'gemini-2.5-flash-preview-tts',
  durationSeconds: 42,
  ...over,
});

/** In-memory Cosmos: one container keyed by id. */
function makeStore(seed = {}) {
  const docs = { [TRANSCRIPT_CONTAINER]: { ...seed } };
  return {
    docs,
    readDoc: vi.fn(async (container, id) => docs[container]?.[id] ?? null),
    upsertDoc: vi.fn(async (container, doc) => {
      docs[container][doc.id] = doc;
      return doc;
    }),
    patchDoc: vi.fn(async (container, id, updates) => {
      docs[container][id] = { ...(docs[container][id] || { id }), ...updates };
      return docs[container][id];
    }),
  };
}

describe('identity', () => {
  it('names the transcript after the article slug, under the article_ prefix', () => {
    // The Plaud path (#434) will use plaud_<recordingId>; the prefix is what
    // keeps the two apart in one container.
    expect(transcriptId(article())).toBe('article_picking-a-state-backend');
    expect(audioPath(article())).toBe('article/picking-a-state-backend.mp3');
  });

  it('falls back to the document id for a legacy article with no slug', () => {
    expect(articleKey(article({ slug: '', Slug: '' }))).toBe('content-1');
    expect(transcriptId(article({ slug: undefined }))).toBe('article_content-1');
  });

  it('refuses a key that could not be a blob path or a Cosmos id', () => {
    expect(() => articleKey({ id: 'a/b', slug: '../x' })).toThrow(/neither a slug nor an id/);
    expect(() => articleKey({})).toThrow(/neither a slug nor an id/);
  });

  it('produces a path the media route will accept', () => {
    expect(isValidBlobPath(audioPath(article()))).toBe(true);
  });

  it('resolves the provider from either spelling, lowercased, or null', () => {
    expect(resolveArticleProvider(article())).toBe('azure');
    expect(resolveArticleProvider({ cloudProvider: 'AWS' })).toBe('aws');
    // Null, not a refusal: nothing here lists by provider.
    expect(resolveArticleProvider({})).toBeNull();
    expect(resolveArticleProvider({ 'Cloud Provider': '  ' })).toBeNull();
  });
});

describe('toTranscriptDoc', () => {
  it('records the source, the script, the audio and its provenance, as a draft', () => {
    const doc = toTranscriptDoc({ article: article(), script: script(), audio: audio(), now: NOW });

    expect(doc).toMatchObject({
      id: 'article_picking-a-state-backend',
      sourceKind: 'article',
      sourceId: 'content-1',
      sourceSlug: 'picking-a-state-backend',
      sourceTitle: 'Picking a state backend',
      sourceProvider: 'azure',
      title: 'State backends, spoken',
      summary: 'Why remote state matters.',
      keyTakeaways: ['Lock it', 'Shard it'],
      transcript: [{ speaker: 'Maya', text: 'Hello' }],
      speakers: { a: 'Maya', b: 'Elena' },
      truncated: false,
      audioUrl: '/api/public/media/podcast/article/picking-a-state-backend.mp3',
      audioPath: 'article/picking-a-state-backend.mp3',
      audioBytes: 3,
      speechProvider: 'gemini',
      speechModel: 'gemini-2.5-flash-preview-tts',
      durationSeconds: 42,
      audioError: null,
      status: STATUS.draft,
      generatedAt: NOW,
      approvedAt: null,
      approvedBy: null,
      // Reserved for #437's Podbean publish record.
      host: null,
    });
  });

  it('stores an unknown provider as null rather than refusing', () => {
    const doc = toTranscriptDoc({
      article: article({ 'Cloud Provider': undefined }),
      script: script(),
      audio: audio(),
      now: NOW,
    });
    expect(doc.sourceProvider).toBeNull();
    expect(doc.status).toBe(STATUS.draft);
  });

  it('keeps the transcript and explains the missing audio when synthesis did not happen', () => {
    const doc = toTranscriptDoc({
      article: article(),
      script: script(),
      audio: { error: 'No speech provider configured' },
      now: NOW,
    });
    expect(doc.audioUrl).toBeNull();
    expect(doc.audioBytes).toBeNull();
    expect(doc.audioError).toBe('No speech provider configured');
    expect(doc.transcript).toHaveLength(1);
  });

  it('carries the truncation flag so the review knows it is looking at partial coverage', () => {
    const doc = toTranscriptDoc({
      article: article(),
      script: script({ truncated: true }),
      audio: audio(),
      now: NOW,
    });
    expect(doc.truncated).toBe(true);
  });

  it('the listing allowlist omits the transcript body and is a subset of the document', () => {
    const doc = toTranscriptDoc({ article: article(), script: script(), audio: audio(), now: NOW });
    expect(TRANSCRIPT_LIST_FIELDS).not.toContain('transcript');
    expect(TRANSCRIPT_LIST_FIELDS).not.toContain('keyTakeaways');
    for (const field of TRANSCRIPT_LIST_FIELDS) {
      // `error` is written only by markTranscriptFailed; everything else is on
      // every document.
      if (field === 'error') continue;
      expect(doc, `${field} is listed but not stored`).toHaveProperty(field);
    }
  });
});

describe('uploadTranscriptAudio', () => {
  it('writes to the podcast container and returns a site-relative media URL', async () => {
    const storage = { uploadBlob: vi.fn(async () => 'https://ignored') };
    const out = await uploadTranscriptAudio({
      storage,
      article: article(),
      audio: Buffer.from([1, 2, 3]),
      contentType: 'audio/mpeg',
    });

    expect(storage.uploadBlob).toHaveBeenCalledWith(
      PODCAST_AUDIO_CONTAINER,
      'article/picking-a-state-backend.mp3',
      expect.any(Buffer),
      'audio/mpeg',
      { sourceKind: 'article', sourceId: 'content-1', sourceSlug: 'picking-a-state-backend' }
    );
    expect(out).toEqual({
      path: 'article/picking-a-state-backend.mp3',
      url: '/api/public/media/podcast/article/picking-a-state-backend.mp3',
      bytes: 3,
    });
  });
});

describe('saveTranscript', () => {
  it('regeneration replaces the document wholesale, dropping the previous approval', async () => {
    const store = makeStore();
    await saveTranscript(store, { article: article(), script: script(), audio: audio(), now: NOW });
    await setTranscriptStatus(store, {
      id: 'article_picking-a-state-backend',
      status: STATUS.published,
      actorId: 'oid-1',
      now: NOW,
    });
    expect(store.docs[TRANSCRIPT_CONTAINER]['article_picking-a-state-backend'].approvedBy).toBe(
      'oid-1'
    );

    await saveTranscript(store, {
      article: article(),
      script: script({ title: 'Second take' }),
      audio: audio(),
      now: '2026-09-09T12:00:00.000Z',
    });

    const stored = store.docs[TRANSCRIPT_CONTAINER]['article_picking-a-state-backend'];
    expect(stored.title).toBe('Second take');
    expect(stored.status).toBe(STATUS.draft);
    expect(stored.approvedAt).toBeNull();
    expect(stored.approvedBy).toBeNull();
  });

  it('explains a 404 as the container not being provisioned yet, naming the fix', async () => {
    // Until the owner's Terraform apply creates podcast_transcripts, every
    // write here is a 404 — and "Resource Not Found" from a write reads as a
    // missing document, which sends someone to the wrong place.
    const store = makeStore({});
    store.upsertDoc = vi.fn(async () => {
      throw Object.assign(new Error('Entity with the specified id does not exist'), { code: 404 });
    });

    await expect(
      saveTranscript(store, { article: article(), script: script(), audio: audio(), now: NOW })
    ).rejects.toThrow(/podcast_transcripts.*not provisioned.*Terraform apply/s);
  });

  it('passes any other write failure through unchanged', async () => {
    const store = makeStore();
    store.upsertDoc = vi.fn(async () => {
      throw Object.assign(new Error('Request rate is large'), { code: 429 });
    });
    await expect(
      saveTranscript(store, { article: article(), script: script(), audio: audio(), now: NOW })
    ).rejects.toThrow('Request rate is large');
  });
});

describe('markTranscriptFailed', () => {
  it('keeps a previous good transcript and merely marks it failed', async () => {
    const store = makeStore();
    await saveTranscript(store, { article: article(), script: script(), audio: audio(), now: NOW });

    await markTranscriptFailed(store, {
      article: article(),
      error: 'model refused',
      now: '2026-09-09T12:00:00.000Z',
    });

    const stored = store.docs[TRANSCRIPT_CONTAINER]['article_picking-a-state-backend'];
    expect(stored.status).toBe(STATUS.failed);
    expect(stored.error).toBe('model refused');
    expect(stored.generatedAt).toBe('2026-09-09T12:00:00.000Z');
    // The working transcript and its audio survive the failed regeneration.
    expect(stored.transcript).toEqual([{ speaker: 'Maya', text: 'Hello' }]);
    expect(stored.audioUrl).toBe('/api/public/media/podcast/article/picking-a-state-backend.mp3');
  });

  it('writes a gap when nothing was stored before, and bounds the error text', async () => {
    const store = makeStore();
    await markTranscriptFailed(store, { article: article(), error: 'x'.repeat(900), now: NOW });

    const stored = store.docs[TRANSCRIPT_CONTAINER]['article_picking-a-state-backend'];
    expect(stored).toMatchObject({
      id: 'article_picking-a-state-backend',
      sourceKind: 'article',
      sourceId: 'content-1',
      sourceTitle: 'Picking a state backend',
      status: STATUS.failed,
      host: null,
    });
    expect(stored.error).toHaveLength(500);
  });
});

describe('setTranscriptStatus', () => {
  it('publishing stamps the approver and the time; returning to draft clears both', async () => {
    const store = makeStore();
    await setTranscriptStatus(store, { id: 'article_x', status: 'published', actorId: 'oid-1', now: NOW });
    expect(store.patchDoc).toHaveBeenCalledWith(
      TRANSCRIPT_CONTAINER,
      'article_x',
      { status: 'published', approvedAt: NOW, approvedBy: 'oid-1' },
      { partitionKey: 'article_x' }
    );

    await setTranscriptStatus(store, { id: 'article_x', status: 'draft', actorId: 'oid-1', now: NOW });
    expect(store.patchDoc.mock.calls[1][2]).toEqual({
      status: 'draft',
      approvedAt: null,
      approvedBy: null,
    });
  });

  it('refuses a status outside the enum before touching the store', async () => {
    const store = makeStore();
    await expect(
      setTranscriptStatus(store, { id: 'article_x', status: 'archived', now: NOW })
    ).rejects.toThrow(/Unknown transcript status "archived"/);
    expect(store.patchDoc).not.toHaveBeenCalled();
  });
});
