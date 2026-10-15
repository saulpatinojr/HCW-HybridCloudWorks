import { describe, it, expect, vi } from 'vitest';
import { markerForFields, shouldProcessValue, PROCESS_REASONS } from './value-marker.js';
import {
  evaluateRisingEdgeClaim,
  claimRisingEdge,
  releaseRisingEdgeClaim,
  SKIP_REASONS,
  CLAIM_REASONS,
} from './rising-edge-claim.js';
import { evaluateActivationNotice } from './activation-notice.js';
import {
  fetchImage,
  imageExtensionFor,
  isExternalUrlString,
  isPrivateIp,
  normalizeMediaType,
  requireImageExtension,
  validateFetchUrl,
} from './fetch-image.js';
import { buildCoverSvg, wrapText, brandingFor } from './cover-svg.js';
import { createImageMirror, downloadUrlFor } from './image-mirror.js';
import {
  classifyContentBucket,
  buildDashboardStatsDeltas,
  applyDeltas,
  createDashboardStatsMaintainer,
  rederiveMarkers,
} from './dashboard-stats.js';
import {
  CoverGenerationError,
  createAiCoverGenerator,
  pickDefaultHero,
  createReplicateClient,
  resolveAiCoverTargets,
} from './ai-cover.js';
import { createFeedHandlers, unpublishFromPubler, buildPublerUpdateBody } from './handlers.js';
import { createNotifier } from '../notify.js';

const NOW = new Date('2026-08-21T12:00:00.000Z');
const now = () => NOW;

function memStore(containers = {}) {
  const data = Object.fromEntries(
    Object.entries(containers).map(([k, v]) => [k, new Map(v.map((d) => [d.id, d]))])
  );
  const get = (c) => (data[c] ||= new Map());
  return {
    data,
    readDoc: vi.fn(async (c, id) => get(c).get(id) || null),
    upsertDoc: vi.fn(async (c, doc) => {
      get(c).set(doc.id, doc);
      return doc;
    }),
    patchDoc: vi.fn(async (c, id, u) => {
      const next = { ...(get(c).get(id) || { id }), ...u };
      get(c).set(id, next);
      return next;
    }),
    replaceDocIfMatch: vi.fn(async (c, doc) => {
      const cur = get(c).get(doc.id);
      if (cur && cur._etag !== doc._etag) {
        const e = new Error('412');
        e.code = 412;
        throw e;
      }
      const next = { ...doc, _etag: `${doc._etag || 'e'}+` };
      get(c).set(doc.id, next);
      return next;
    }),
    deleteDoc: vi.fn(async (c, id) => {
      get(c).delete(id);
    }),
    queryDocs: vi.fn(async () => []),
  };
}

describe('pure decisions', () => {
  it('value marker: two-tier, reads live only on disagreement', async () => {
    const m = markerForFields({ caption: 'a', accountIds: ['x', 'y'] }, ['caption', 'accountIds']);
    expect(m).toHaveLength(32);
    expect(
      markerForFields({ caption: 'a', accountIds: ['y', 'x'] }, ['caption', 'accountIds'])
    ).not.toBe(m);
    const live = vi.fn(async () => 'u');
    expect(
      await shouldProcessValue({ value: 'u', snapshotMarker: 'u', readLiveMarker: live })
    ).toEqual({ process: false, reason: PROCESS_REASONS.UNCHANGED_IN_EVENT });
    expect(live).not.toHaveBeenCalled();
    expect(
      (await shouldProcessValue({ value: 'u', snapshotMarker: 'old', readLiveMarker: live })).reason
    ).toBe(PROCESS_REASONS.UNCHANGED_IN_LIVE_STATE);
    expect(
      (await shouldProcessValue({ value: 'v', snapshotMarker: 'old', readLiveMarker: live }))
        .process
    ).toBe(true);
  });

  it('rising-edge claim: flag, duplicate event, fresh vs stale vs undated claims', () => {
    const spec = {
      flagField: 'f',
      claimField: 'c',
      claimedAtField: 'at',
      eventId: 'e1',
      now: NOW.getTime(),
    };
    expect(evaluateRisingEdgeClaim(null, spec).reason).toBe(SKIP_REASONS.DOCUMENT_MISSING);
    expect(evaluateRisingEdgeClaim({ f: false }, spec).reason).toBe(SKIP_REASONS.FLAG_NOT_SET);
    expect(evaluateRisingEdgeClaim({ f: true }, spec)).toEqual({
      claim: true,
      reason: CLAIM_REASONS.CLAIMED,
    });
    expect(evaluateRisingEdgeClaim({ f: true, c: 'e1' }, spec).reason).toBe(
      SKIP_REASONS.ALREADY_RUN_BY_THIS_EVENT
    );
    expect(
      evaluateRisingEdgeClaim(
        { f: true, c: 'e0', at: new Date(NOW.getTime() - 60000).toISOString() },
        spec
      ).reason
    ).toBe(SKIP_REASONS.CLAIMED_BY_ANOTHER_RUN);
    expect(
      evaluateRisingEdgeClaim(
        { f: true, c: 'e0', at: new Date(NOW.getTime() - 16 * 60000).toISOString() },
        spec
      ).reason
    ).toBe(CLAIM_REASONS.RECLAIMED_STALE);
    expect(evaluateRisingEdgeClaim({ f: true, c: 'e0' }, spec).reason).toBe(
      SKIP_REASONS.CLAIM_TIMESTAMP_UNREADABLE
    );
    expect(releaseRisingEdgeClaim(spec)).toEqual({ c: null, at: null });
  });

  it('claimRisingEdge writes the claim with an etag replace and retries on 412', async () => {
    const store = memStore({ content: [{ id: 'c1', altCoverImageTrigger: true, _etag: 'e' }] });
    store.replaceDocIfMatch.mockImplementationOnce(async () => {
      const e = new Error('412');
      e.code = 412;
      throw e;
    });
    const r = await claimRisingEdge(store, 'content', 'c1', {
      flagField: 'altCoverImageTrigger',
      claimField: 'runId',
      claimedAtField: 'runAt',
      eventId: 'ev',
      now,
    });
    expect(r.claim).toBe(true);
    expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(2);
    expect(store.data.content.get('c1')).toMatchObject({ runId: 'ev', runAt: NOW.toISOString() });
  });

  it('activation notice', () => {
    expect(evaluateActivationNotice(null).send).toBe(false);
    expect(evaluateActivationNotice({ active: false }).send).toBe(false);
    expect(evaluateActivationNotice({ active: true, activationNotifiedAt: '2026' }).send).toBe(
      false
    );
    expect(evaluateActivationNotice({ active: true, activationNotifiedAt: null }).send).toBe(true);
  });
});

describe('fetch-image', () => {
  it('refuses private targets, non-http, Firebase URLs; follows redirects with re-validation', async () => {
    expect(isPrivateIp('10.1.2.3')).toBe(true);
    expect(isPrivateIp('172.31.0.1')).toBe(true);
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    await expect(
      validateFetchUrl('ftp://x', { resolve: async () => ({ address: '1.1.1.1' }) })
    ).rejects.toThrow('Invalid protocol');
    await expect(
      validateFetchUrl('https://internal.test', {
        resolve: async () => ({ address: '192.168.1.1' }),
      })
    ).rejects.toThrow('Private IP');
    expect(isExternalUrlString('https://firebasestorage.googleapis.com/v0/b/x/o/y')).toBe(false);
    expect(isExternalUrlString('https://cdn.test/a.png')).toBe(true);
    expect(isExternalUrlString([{ downloadURL: 'x' }])).toBe(false);
    const fetch = vi.fn(async (url) =>
      url === 'https://a.test/img'
        ? { status: 302, headers: new Map([['location', '/real.png']]) }
        : {
            status: 200,
            headers: new Map([['content-type', 'image/png; charset=binary']]),
            arrayBuffer: async () => new Uint8Array([1, 2]).buffer,
          }
    );
    const r = await fetchImage('https://a.test/img', {
      fetch,
      resolve: async () => ({ address: '1.1.1.1' }),
    });
    expect(r.contentType).toBe('image/png');
    expect(r.buffer.length).toBe(2);
    expect(fetch.mock.calls[1][0]).toBe('https://a.test/real.png');
    const bad = vi.fn(async () => ({ status: 404, headers: new Map() }));
    await expect(
      fetchImage('https://a.test/x', { fetch: bad, resolve: async () => ({ address: '1.1.1.1' }) })
    ).rejects.toThrow('HTTP 404');
  });

  it('refuses a video response and never reads its body (#415)', async () => {
    const arrayBuffer = vi.fn(async () => new Uint8Array([0, 0, 0, 32]).buffer);
    const fetch = vi.fn(async () => ({
      status: 200,
      headers: new Map([
        ['content-type', 'video/mp4'],
        ['content-length', '5500000'],
      ]),
      arrayBuffer,
    }));
    const result = await fetchImage('https://cdn.test/RUBRIC-EVALUATOR.mp4', {
      fetch,
      resolve: async () => ({ address: '1.1.1.1' }),
    });
    expect(result).toEqual({
      refused: 'not-an-image',
      contentType: 'video/mp4',
      reason: 'Content-Type video/mp4 is not an image',
    });
    // The gate is on the headers, so the 5.5 MB body is never pulled.
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(result.buffer).toBeUndefined();
  });

  it('refuses an image type it cannot name and a response that declared none', async () => {
    const respondWith = (headers) =>
      vi.fn(async () => ({
        status: 200,
        headers: new Map(headers),
        arrayBuffer: async () => new Uint8Array([1]).buffer,
      }));
    const resolve = async () => ({ address: '1.1.1.1' });
    expect(
      await fetchImage('https://cdn.test/scan.tiff', {
        fetch: respondWith([['content-type', 'image/tiff']]),
        resolve,
      })
    ).toEqual({
      refused: 'unsupported-image-type',
      contentType: 'image/tiff',
      reason: 'image type image/tiff is not one this site stores',
    });
    // No Content-Type header at all: nothing was measured, and the old
    // `|| 'image/png'` default is exactly the mislabel #415 is about.
    expect(
      await fetchImage('https://cdn.test/mystery', { fetch: respondWith([]), resolve })
    ).toEqual({
      refused: 'no-media-type',
      contentType: '',
      reason: 'the response declared no Content-Type',
    });
  });

  it('normalizes the measured type and derives every stored extension from it', async () => {
    expect(normalizeMediaType('IMAGE/PNG; charset=binary')).toBe('image/png');
    expect(normalizeMediaType('  image/webp  ')).toBe('image/webp');
    expect(normalizeMediaType(null)).toBe('');
    expect(imageExtensionFor('IMAGE/JPEG')).toBe('jpg');
    expect(imageExtensionFor('image/svg+xml')).toBe('svg');
    expect(imageExtensionFor('video/mp4')).toBe(null);
    expect(imageExtensionFor('image/tiff')).toBe(null);
    expect(requireImageExtension('image/avif')).toBe('avif');
    expect(() => requireImageExtension('video/mp4')).toThrow(
      'No stored extension for media type video/mp4'
    );
    expect(() => requireImageExtension('')).toThrow('No stored extension for media type (none)');
    const fetch = vi.fn(async () => ({
      status: 200,
      headers: new Map([['content-type', 'IMAGE/WEBP; charset=binary']]),
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }));
    const ok = await fetchImage('https://cdn.test/a.webp', {
      fetch,
      resolve: async () => ({ address: '1.1.1.1' }),
    });
    expect(ok.contentType).toBe('image/webp');
    expect(ok.refused).toBeUndefined();
    expect(ok.buffer.length).toBe(3);
  });
});

describe('cover svg + image mirror', () => {
  it('wraps titles, escapes XML, brands by provider', () => {
    expect(wrapText('one two three four five six seven eight nine ten eleven twelve', 12)).toEqual([
      'one two',
      'three four',
      'five six',
    ]);
    expect(wrapText('')).toEqual(['Untitled']);
    const svg = buildCoverSvg('aws', 'Cut <costs> & "win"', 'Cost');
    expect(svg).toContain('Cut &lt;costs&gt; &amp; &quot;win&quot;');
    expect(svg).toContain('#ff9900');
    expect(brandingFor('VMware').label).toBe('VMWARE');
    expect(brandingFor('nope').label).toBe('AZURE');
  });

  it('mirrors a new external URL once, writes the Rowy field + marker, keeps speakerevents private', async () => {
    const store = memStore({
      blogs: [{ id: 'b1', contentImageUrl: 'https://cdn.test/c.jpg' }],
      speakerevents: [{ id: 's1', eventImageUrl: 'https://cdn.test/e.svg' }],
    });
    const storage = { uploadBlob: vi.fn(async () => 'https://blob/x') };
    const fetchImage = vi.fn(async (url) => ({
      buffer: Buffer.from('img'),
      contentType: url.endsWith('.svg') ? 'image/svg+xml' : 'image/jpeg',
    }));
    const mirror = createImageMirror({ store, storage, fetchImage });
    expect(await mirror.mirror('blogs', store.data.blogs.get('b1'))).toEqual({
      mirrored: true,
      reason: 'mirrored',
    });
    expect(storage.uploadBlob).toHaveBeenCalledWith(
      'blogs',
      'b1/images/cover.jpg',
      expect.any(Buffer),
      'image/jpeg',
      { sourceUrl: 'https://cdn.test/c.jpg' }
    );
    expect(store.data.blogs.get('b1')).toMatchObject({
      contentImageSourceUrl: 'https://cdn.test/c.jpg',
      'Cover Image': [
        {
          downloadURL: '/api/public/media/blogs/b1/images/cover.jpg',
          name: 'cover.jpg',
          type: 'image/jpeg',
          size: 3,
          ref: 'b1/images/cover.jpg',
        },
      ],
    });
    expect((await mirror.mirror('blogs', store.data.blogs.get('b1'))).reason).toBe(
      'unchanged_in_event'
    );
    expect(
      (await mirror.mirror('blogs', { id: 'b1', contentImageUrl: 'https://cdn.test/c.jpg' })).reason
    ).toBe('unchanged_in_live_state');
    await mirror.mirror('speakerevents', store.data.speakerevents.get('s1'));
    expect(store.data.speakerevents.get('s1').images[0]).toMatchObject({
      downloadURL: 'https://cdn.test/e.svg',
      ref: 's1/images/event-image.svg',
    });
    expect(downloadUrlFor('certifications', 'c/images/b.png', 'https://src')).toBe(
      '/api/public/media/certifications/c/images/b.png'
    );
    fetchImage.mockRejectedValueOnce(new Error('HTTP 403'));
    expect(
      (await mirror.mirror('blogs', { id: 'b2', contentImageUrl: 'https://cdn.test/z.png' })).reason
    ).toBe('error: HTTP 403');
    expect(store.data.blogs.get('b2')).toBeUndefined(); // no marker on failure
  });

  it('refuses a cover the fetcher says is not an image, storing no blob and no marker (#415)', async () => {
    // The #413 path on this side: the curated feed put a real 5.3 MB
    // `video/mp4` in `contentImageUrl` once already.
    const store = memStore({ blogs: [{ id: 'b1', contentImageUrl: 'https://cdn.test/clip.mp4' }] });
    const storage = { uploadBlob: vi.fn(async () => 'https://blob/x') };
    const fetchImage = vi.fn(async () => ({
      refused: 'not-an-image',
      contentType: 'video/mp4',
      reason: 'Content-Type video/mp4 is not an image',
    }));
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const mirror = createImageMirror({ store, storage, fetchImage, log });
    expect(await mirror.mirror('blogs', store.data.blogs.get('b1'))).toEqual({
      mirrored: false,
      reason: 'refused: not-an-image',
    });
    expect(storage.uploadBlob).not.toHaveBeenCalled();
    expect(store.patchDoc).not.toHaveBeenCalled();
    expect(store.data.blogs.get('b1').contentImageSourceUrl).toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toBe(
      '[blogCoverImage] Refused blogs/b1: Content-Type video/mp4 is not an image'
    );
    // No marker, so an editor who swaps the video for a picture gets it
    // mirrored on the next write.
    expect(await mirror.mirror('blogs', store.data.blogs.get('b1'))).toEqual({
      mirrored: false,
      reason: 'refused: not-an-image',
    });
    expect(fetchImage).toHaveBeenCalledTimes(2);
  });

  it('generates a template SVG cover only for a titled blog with no image source and no cover', async () => {
    const store = memStore({
      blogs: [{ id: 'b1', Title: 'T', 'Cloud Provider': 'Aws', category: 'Cost' }],
    });
    const storage = { uploadBlob: vi.fn(async () => 'u') };
    const mirror = createImageMirror({ store, storage, fetchImage: vi.fn() });
    expect(await mirror.generateTemplateCover(store.data.blogs.get('b1'))).toEqual({
      generated: true,
      reason: 'generated',
    });
    expect(storage.uploadBlob.mock.calls[0].slice(0, 2)).toEqual([
      'blogs',
      'b1/images/generated-cover.svg',
    ]);
    expect(storage.uploadBlob.mock.calls[0][3]).toBe('image/svg+xml');
    expect(store.data.blogs.get('b1')).toMatchObject({
      generatedCover: true,
      'Cover Image': [{ downloadURL: '/api/public/media/blogs/b1/images/generated-cover.svg' }],
    });
    expect((await mirror.generateTemplateCover(store.data.blogs.get('b1'))).reason).toBe(
      'has_cover'
    );
    expect(
      (await mirror.generateTemplateCover({ id: 'x', Title: 'T', contentImageUrl: 'https://i' }))
        .reason
    ).toBe('has_content_image_url');
    expect((await mirror.generateTemplateCover({ id: 'x' })).reason).toBe('no_title');
  });
});

describe('dashboard stats', () => {
  it('classifies like the snapshot summary and diffs positions', () => {
    expect(classifyContentBucket({ contentStatus: 'rejected' })).toBe('rejected');
    expect(classifyContentBucket({ contentStatus: 'archived' })).toBeNull();
    expect(classifyContentBucket({ Live: true, contentStatus: 'published' })).toBe('published');
    expect(classifyContentBucket({ contentStatus: 'ingested' })).toBe('needsReview');
    // Sent to review from Drafts: a decision waiting, not the Editor's work (#1014).
    expect(classifyContentBucket({ contentStatus: 'in_review' })).toBe('needsReview');
    expect(classifyContentBucket({ contentStatus: 'approved' })).toBe('inProgress');
    expect(
      buildDashboardStatsDeltas(
        { exists: true, bucket: 'needsReview', type: 'blog' },
        { exists: true, bucket: 'published', type: 'blog' }
      )
    ).toEqual({ 'blog.needsReview': -1, 'blog.published': 1 });
    expect(
      buildDashboardStatsDeltas(null, { exists: true, bucket: 'rejected', type: 'blog' })
    ).toEqual({ totalDocs: 1, rejected: 1 });
    expect(
      buildDashboardStatsDeltas({ exists: true, bucket: 'inProgress', type: 'news' }, null)
    ).toEqual({ totalDocs: -1, 'news.inProgress': -1, 'news.total': -1 });
    expect(applyDeltas({ blog: { total: 1 } }, { 'blog.total': -2, totalDocs: 1 })).toEqual({
      blog: { total: 0 },
      totalDocs: 1,
    });
  });

  it('moves counters via the marker, idempotently, and handles deletes', async () => {
    const store = memStore();
    const m = createDashboardStatsMaintainer({ store, now });
    const doc = { id: 'c1', contentStatus: 'ingested', type: 'blog' };
    expect(await m.applyTransition({ contentId: 'c1', afterData: doc })).toEqual({
      totalDocs: 1,
      'blog.needsReview': 1,
      'blog.total': 1,
    });
    expect(store.data.content_stats_markers.get('c1')).toMatchObject({
      bucket: 'needsReview',
      type: 'blog',
    });
    expect(store.data.system.get('dashboard_stats_v1')).toMatchObject({
      totalDocs: 1,
      blog: { needsReview: 1, total: 1 },
    });
    expect(await m.applyTransition({ contentId: 'c1', afterData: doc })).toEqual({}); // redelivery
    expect(await m.applyTransition({ contentId: 'c1', afterData: { ...doc, Live: true } })).toEqual(
      { 'blog.needsReview': -1, 'blog.published': 1 }
    );
    expect(await m.applyTransition({ contentId: 'c1', afterData: null })).toEqual({
      totalDocs: -1,
      'blog.published': -1,
      'blog.total': -1,
    });
    expect(store.data.content_stats_markers.get('c1')).toBeUndefined();
    expect(store.data.system.get('dashboard_stats_v1')).toMatchObject({
      totalDocs: 0,
      blog: { needsReview: 0, published: 0, total: 0 },
    });
  });

  describe('rederiveMarkers (the Recount half the counters cannot do)', () => {
    /** memStore plus the two writes a Recount uses and a marker query. */
    function recountStore(markers) {
      const store = memStore({ content_stats_markers: markers });
      store.queryDocs = vi.fn(async (c) => [...(store.data[c]?.values() || [])]);
      store.createDoc = vi.fn(async (c, doc) => {
        if (store.data[c]?.has(doc.id)) {
          const e = new Error('409');
          e.code = 409;
          throw e;
        }
        store.data[c].set(doc.id, { ...doc, _etag: 'new' });
        return doc;
      });
      return store;
    }

    it('moves a marker written under the old bucket rule, creates a missing one, and leaves a current one', async () => {
      const store = recountStore([
        { id: 'sent', bucket: 'inProgress', type: 'blog', _etag: 'a' }, // in_review, pre-2026-10-08
        { id: 'same', bucket: 'needsReview', type: 'blog', _etag: 'b' },
      ]);
      const items = [
        { id: 'sent', contentStatus: 'in_review', type: 'blog' },
        { id: 'same', contentStatus: 'ingested', type: 'blog' },
        { id: 'never-marked', contentStatus: 'approved', type: 'framework' },
      ];

      const tally = await rederiveMarkers({ store, items, now });

      expect(tally).toEqual({ checked: 3, created: 1, rewritten: 1, skipped: 0 });
      const markers = store.data.content_stats_markers;
      expect(markers.get('sent')).toMatchObject({ bucket: 'needsReview', type: 'blog' });
      expect(markers.get('never-marked')).toMatchObject({ bucket: 'inProgress', type: 'framework' });
      expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(1);
      expect(store.queryDocs.mock.calls[0][1]).toMatch(/^SELECT TOP \d+ \* FROM c$/);
    });

    it('so the next change moves the counters from the right bucket', async () => {
      const store = recountStore([{ id: 'sent', bucket: 'inProgress', type: 'blog', _etag: 'a' }]);
      await rederiveMarkers({ store, items: [{ id: 'sent', contentStatus: 'in_review', type: 'blog' }], now });
      store.data.system = new Map([
        ['dashboard_stats_v1', { id: 'dashboard_stats_v1', blog: { needsReview: 1, total: 1 } }],
      ]);

      const deltas = await createDashboardStatsMaintainer({ store, now }).applyTransition({
        contentId: 'sent',
        afterData: { id: 'sent', contentStatus: 'approved', type: 'blog' },
      });

      expect(deltas).toEqual({ 'blog.needsReview': -1, 'blog.inProgress': 1 });
    });

    it('leaves a marker the change feed moved or created meanwhile, and rethrows anything else', async () => {
      const store = recountStore([{ id: 'raced', bucket: 'inProgress', type: 'blog', _etag: 'a' }]);
      store.replaceDocIfMatch.mockRejectedValueOnce(Object.assign(new Error('412'), { code: 412 }));
      store.createDoc.mockRejectedValueOnce(Object.assign(new Error('409'), { statusCode: 409 }));
      const items = [
        { id: 'raced', contentStatus: 'in_review', type: 'blog' },
        { id: 'fresh', contentStatus: 'ingested', type: 'blog' },
      ];
      expect(await rederiveMarkers({ store, items, now })).toEqual({
        checked: 2,
        created: 0,
        rewritten: 0,
        skipped: 2,
      });

      store.createDoc.mockRejectedValueOnce(Object.assign(new Error('throttled'), { code: 429 }));
      await expect(
        rederiveMarkers({ store, items: [{ id: 'other', contentStatus: 'ingested' }], now })
      ).rejects.toThrow('throttled');
    });
  });
});

describe('AI cover', () => {
  it('replicate client: not configured, retries 429, polls until succeeded', async () => {
    expect(createReplicateClient({ env: {} }).configured).toBe(false);
    await expect(createReplicateClient({ env: {} }).generate('p')).rejects.toThrow(
      'REPLICATE_API_KEY'
    );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'p1', status: 'processing', urls: { get: 'https://r/p1' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'p1', status: 'succeeded', output: ['https://img/1.png'] }),
      });
    const client = createReplicateClient({
      env: { REPLICATE_API_KEY: 'k' },
      fetch,
      sleep: async () => {},
    });
    expect(await client.generate('p')).toBe('https://img/1.png');
    expect(fetch.mock.calls[0][0]).toBe(
      'https://api.replicate.com/v1/models/google/imagen-4-fast/predictions'
    );
    expect(resolveAiCoverTargets({ aiImageTargets: ['hero', 'a', 'b', 'c', 'd'] })).toHaveLength(4);
  });

  it('claims, generates per target, persists images, releases the claim; releases on failure too', async () => {
    const store = memStore({
      content: [
        {
          id: 'c1',
          altCoverImageTrigger: true,
          Title: 'T',
          'Cloud Provider': 'AWS',
          aiImageTargets: ['hero', 'card'],
          _etag: 'e',
        },
      ],
    });
    const storage = { uploadBlob: vi.fn(async () => 'u') };
    const replicate = { generate: vi.fn(async () => 'https://img/x.png') };
    const fetchImage = vi.fn(async () => ({
      buffer: Buffer.from('png'),
      contentType: 'image/png',
    }));
    let n = 0;
    const gen = createAiCoverGenerator({
      store,
      storage,
      replicate,
      fetchImage,
      now,
      uuid: () => `g${++n}`,
    });
    const r = await gen.run('c1', 'ev1');
    // No set is assigned to this document, so the built-in prompt applies.
    expect(r).toEqual({
      ran: true,
      reason: 'generated',
      targets: ['hero', 'card'],
      promptSource: 'builtin',
    });
    expect(replicate.generate).toHaveBeenCalledTimes(2);
    expect(replicate.generate.mock.calls[0][0]).toMatch(/Lego minifigure[\s\S]*Image slot: hero/);
    // Stamped paths (ADR 0033 §6.2): a regeneration writes beside, not over.
    const stamp = now().toISOString().replace(/[-:TZ]/g, '').replace(/\..*$/, '');
    const hero = `/api/public/media/covers/c1-ai-hero-${stamp}.png`;
    const card = `/api/public/media/covers/c1-ai-card-${stamp}.png`;
    expect(storage.uploadBlob.mock.calls.map((c) => c[1])).toEqual([
      `c1-ai-hero-${stamp}.png`,
      `c1-ai-card-${stamp}.png`,
    ]);
    const doc = store.data.content.get('c1');
    expect(doc).toMatchObject({
      altCoverImageTrigger: false,
      altCoverImageRunId: null,
      altCoverImage: hero,
      aiImageUrls: { hero, card },
      altCoverImageError: null,
    });
    expect(doc.aiImageHistory.hero).toEqual([hero]);
    expect(store.data.generated_content_images.size).toBe(2);
    expect((await gen.run('c1', 'ev1')).reason).toBe(SKIP_REASONS.FLAG_NOT_SET);

    store.data.content.set('c2', { id: 'c2', altCoverImageTrigger: true, _etag: 'e' });
    replicate.generate.mockRejectedValueOnce(
      new CoverGenerationError('Replicate HTTP 503', { status: 503 })
    );
    expect((await gen.run('c2', 'ev2')).reason).toBe('error: Replicate HTTP 503');
    expect(store.data.content.get('c2')).toMatchObject({
      altCoverImageTrigger: false,
      altCoverImageRunId: null,
      altCoverImageError: 'Replicate HTTP 503',
    });
  });

  it('fails the slot rather than storing a generation that is not an image (#415)', async () => {
    const store = memStore({
      content: [{ id: 'c1', altCoverImageTrigger: true, aiImageTargets: ['hero'], _etag: 'e' }],
    });
    const storage = { uploadBlob: vi.fn(async () => 'u') };
    const gen = createAiCoverGenerator({
      store,
      storage,
      replicate: { generate: vi.fn(async () => 'https://img/x') },
      fetchImage: vi.fn(async () => ({
        refused: 'not-an-image',
        contentType: 'video/mp4',
        reason: 'Content-Type video/mp4 is not an image',
      })),
      now,
      uuid: () => 'g1',
    });
    expect((await gen.run('c1', 'ev1')).reason).toBe(
      'error: Generated hero cover refused: Content-Type video/mp4 is not an image'
    );
    expect(storage.uploadBlob).not.toHaveBeenCalled();
    expect(store.data.content.get('c1')).toMatchObject({
      altCoverImageTrigger: false,
      altCoverImageError: 'Generated hero cover refused: Content-Type video/mp4 is not an image',
    });
    expect(store.data.generated_content_images).toBeUndefined();
  });

  it('assigns the curated default hero on failure when a mapping exists (T-606)', async () => {
    const store = memStore({
      content: [
        { id: 'c3', altCoverImageTrigger: true, 'Cloud Provider': 'AWS', _etag: 'e' },
        // Already has a cover: the default must not overwrite it.
        {
          id: 'c4',
          altCoverImageTrigger: true,
          contentImageUrl: '/api/public/media/covers/manual.png',
          _etag: 'e',
        },
      ],
      admin_config: [
        {
          id: 'default_heroes',
          heroes: {
            AWS: '/api/public/media/covers/default-aws.png',
            Multi: '/api/public/media/covers/default-multi.png',
          },
        },
      ],
    });
    const replicate = { generate: vi.fn(async () => Promise.reject(new Error('boom'))) };
    const gen = createAiCoverGenerator({
      store,
      storage: { uploadBlob: vi.fn() },
      replicate,
      fetchImage: vi.fn(),
      now,
      uuid: () => 'g1',
    });

    expect((await gen.run('c3', 'ev3')).reason).toBe('error_with_default_hero: boom');
    expect(store.data.content.get('c3')).toMatchObject({
      altCoverImageTrigger: false,
      altCoverImage: '/api/public/media/covers/default-aws.png',
      contentImageUrl: '/api/public/media/covers/default-aws.png',
      altCoverImageError: expect.stringMatching(
        /^fallback: default hero \(The cover could not be generated \(Error; reference [\w.:-]+\)\.\)$/
      ),
    });

    expect((await gen.run('c4', 'ev4')).reason).toBe('error: boom');
    expect(store.data.content.get('c4')).toMatchObject({
      contentImageUrl: '/api/public/media/covers/manual.png',
      altCoverImageError: expect.stringMatching(
        /^The cover could not be generated \(Error; reference [\w.:-]+\)\.$/
      ),
    });
    expect(store.data.content.get('c4').altCoverImage).toBeUndefined();
  });

  it('pickDefaultHero: case-insensitive keys, Google Cloud → GCP, Multi catch-all', () => {
    const heroes = { AWS: '/aws.png', gcp: '/gcp.png', Multi: '/multi.png' };
    expect(pickDefaultHero(heroes, 'aws')).toBe('/aws.png');
    expect(pickDefaultHero(heroes, 'AWS')).toBe('/aws.png');
    expect(pickDefaultHero(heroes, 'Google Cloud')).toBe('/gcp.png');
    expect(pickDefaultHero(heroes, 'vmware')).toBe('/multi.png');
    expect(pickDefaultHero(heroes, '')).toBe('/multi.png');
    expect(pickDefaultHero({}, 'aws')).toBe(null);
    expect(pickDefaultHero(undefined, 'aws')).toBe(null);
  });
});

describe('feed handlers', () => {
  function deps(store) {
    return {
      store,
      mirror: {
        mirror: vi.fn(async () => ({ mirrored: false, reason: 'not_external_url' })),
        generateTemplateCover: vi.fn(async () => ({ generated: false, reason: 'no_title' })),
      },
      inspector: { executeInspection: vi.fn(async () => ({ contentStatus: 'inspected' })) },
      aiCover: { run: vi.fn(async () => ({ ran: true, reason: 'generated' })) },
      forgeReadyNotify: { run: vi.fn(async () => ({ ran: true, reason: 'sent' })) },
      socialCaption: { run: vi.fn(async () => ({ ran: true, reason: 'queued_to_publer' })) },
      dashboardStats: { applyTransition: vi.fn(async () => ({})) },
      notifier: { notifyTelegram: vi.fn(async () => ({ sent: true })) },
      publer: { configured: true, request: vi.fn(async () => ({})) },
      now,
    };
  }

  it('blogs: mirror, template cover, and the claimed slug page', async () => {
    const store = memStore({
      blogs: [
        {
          id: 'b1',
          Title: 'Hello World',
          createSlugPageTrigger: true,
          'Cloud Provider': 'AWS',
          _etag: 'e',
        },
      ],
    });
    const d = deps(store);
    const h = createFeedHandlers(d);
    const [r] = await h.blogs([store.data.blogs.get('b1')], {});
    expect(r).toMatchObject({ mirrored: 'not_external_url', cover: 'no_title', slug: 'created' });
    expect(store.data.blogs.get('b1')).toMatchObject({
      slug: 'hello-world-b1',
      curatedSubpagePath: '/aws/blog/hello-world-b1',
      createSlugPageTrigger: false,
      createSlugPageRunId: null,
      curatedSubpage: true,
    });
    const [again] = await h.blogs([store.data.blogs.get('b1')], {});
    expect(again.slug).toBe(SKIP_REASONS.FLAG_NOT_SET);
  });

  it('content: inspect on flag (recording errors), AI cover on flag, counters always', async () => {
    const store = memStore({
      content: [
        {
          id: 'c1',
          inspectTrigger: true,
          altCoverImageTrigger: true,
          forgeReadyNotifyTrigger: true,
          socialCaptionTrigger: true,
          url: 'https://s',
        },
      ],
    });
    const d = deps(store);
    const h = createFeedHandlers(d);
    const ctx = { error: vi.fn() };
    expect(await h.content([store.data.content.get('c1'), { id: 'c2' }], ctx)).toEqual([
      {
        id: 'c1',
        inspected: 'inspected',
        aiCover: 'generated',
        forgeReadyNotify: 'sent',
        socialCaption: 'queued_to_publer',
        statsMoved: false,
      },
      { id: 'c2', statsMoved: false },
    ]);
    expect(d.dashboardStats.applyTransition).toHaveBeenCalledTimes(2);
    expect(d.forgeReadyNotify.run).toHaveBeenCalledTimes(1);
    d.inspector.executeInspection.mockRejectedValueOnce(new Error('Status code 403'));
    const [r] = await h.content([{ id: 'c3', inspectTrigger: true }], ctx);
    expect(r.inspected).toBe('error');
    expect(store.data.content.get('c3')).toMatchObject({
      inspectTrigger: false,
      inspectError: expect.stringMatching(/^The inspection failed \(Error; reference [\w.:-]+\)\.$/),
      inspectErrorAt: NOW.toISOString(),
    });
  });

  it('workflow alerts: announces once per activation, stamps after a successful send only', async () => {
    const store = memStore({
      workflow_alerts: [
        {
          id: 'a1',
          active: true,
          alertType: 'link_rot_detected',
          severity: 'warning',
          brokenCount: 2,
          _etag: 'e',
        },
      ],
    });
    const d = deps(store);
    const h = createFeedHandlers(d);
    expect((await h.workflowAlerts([store.data.workflow_alerts.get('a1')], {}))[0]).toEqual({
      id: 'a1',
      sent: true,
      reason: 'sent',
    });
    expect(d.notifier.notifyTelegram.mock.calls[0][0]).toMatchObject({
      title: 'Workflow alert: link_rot_detected',
      severity: 'warning',
    });
    expect(JSON.parse(d.notifier.notifyTelegram.mock.calls[0][0].message)).toEqual({
      severity: 'warning',
      brokenCount: 2,
    });
    expect(store.data.workflow_alerts.get('a1').activationNotifiedAt).toBe(NOW.toISOString());
    expect((await h.workflowAlerts([store.data.workflow_alerts.get('a1')], {}))[0].reason).toBe(
      'snapshot'
    );
    d.notifier.notifyTelegram.mockResolvedValueOnce({ sent: false, reason: 'not_configured' });
    store.data.workflow_alerts.set('a2', { id: 'a2', active: true });
    expect((await h.workflowAlerts([store.data.workflow_alerts.get('a2')], {}))[0]).toEqual({
      id: 'a2',
      sent: false,
      reason: 'not_configured',
    });
    expect(store.data.workflow_alerts.get('a2').activationNotifiedAt).toBeUndefined();
  });

  it('social posts: pushes calendar edits once, skips Publer-origin, records failures; unpublish on delete', async () => {
    const store = memStore({
      social_posts: [
        {
          id: 's1',
          caption: 'hi',
          url: 'https://u',
          scheduledAt: '2026-09-01T10:00:00Z',
          publerPostIds: ['p1'],
          publerActivePostIds: ['p1', 'p2'],
        },
        { id: 's2', caption: 'x', publerPostIds: ['p9'], syncOrigin: 'publer' },
        { id: 's3', caption: 'y' },
      ],
    });
    const d = deps(store);
    const h = createFeedHandlers(d);
    const rs = await h.socialPosts([...store.data.social_posts.values()], { error: vi.fn() });
    expect(rs.map((r) => r.reason)).toEqual(['pushed', 'origin_publer', 'no_publer_ids']);
    expect(d.publer.request.mock.calls.map((c) => c[0])).toEqual(['/posts/p1', '/posts/p2']);
    expect(d.publer.request.mock.calls[0][2]).toEqual({
      post: { text: 'hi\n\nhttps://u', scheduled_at: '2026-09-01T10:00:00.000Z' },
    });
    expect(store.data.social_posts.get('s1')).toMatchObject({
      syncStatus: 'synced',
      syncOrigin: 'calendar',
      syncError: null,
    });
    expect((await h.socialPosts([store.data.social_posts.get('s1')], {}))[0].reason).toBe(
      'unchanged_in_event'
    );
    d.publer.request.mockRejectedValueOnce(new Error('Publer PUT failed'));
    store.data.social_posts.set('s4', { id: 's4', caption: 'z', publerPostIds: ['p4'] });
    expect(
      (await h.socialPosts([store.data.social_posts.get('s4')], { error: vi.fn() }))[0].reason
    ).toBe('error');
    expect(store.data.social_posts.get('s4')).toMatchObject({
      syncStatus: 'failed',
      syncOrigin: 'system',
      syncError: expect.stringMatching(
        /^The post could not be synced to Publer \(Error; reference [\w.:-]+\)\.$/
      ),
    });
    expect(() => buildPublerUpdateBody({})).toThrow(/caption or URL/);

    // One documented bulk delete for every id, and `deleted_ids` is the only
    // proof a post is gone (#463 item 2).
    d.publer.deletePosts = vi.fn(async (ids) => ({
      deletedIds: ids.map(String),
      missingIds: [],
    }));
    expect(await unpublishFromPubler(d.publer, { publerPostIds: ['p1', 'p2'] })).toEqual({
      attempted: 2,
      removed: 2,
    });
    expect(d.publer.deletePosts).toHaveBeenCalledWith(['p1', 'p2']);

    // A post Publer declined to delete is NOT removed. Counting it as removed
    // leaves a post scheduled to publish with nothing on the calendar saying so.
    const warn = vi.fn();
    d.publer.deletePosts = vi.fn(async () => ({ deletedIds: ['p1'], missingIds: ['p2'] }));
    expect(
      await unpublishFromPubler(d.publer, { publerPostIds: ['p1', 'p2'] }, { warn })
    ).toEqual({ attempted: 2, removed: 1 });
    expect(warn.mock.calls[0][0]).toMatch(/did not delete 1 of 2/);
    // Counts, never the ids: traces stay content-free (Copilot review of
    // 200a532f; `timers/content-cleanup.js` states the same rule).
    expect(warn.mock.calls[0][0]).not.toMatch(/p2/);

    // Best-effort: a thrown delete is warned, never propagated.
    d.publer.deletePosts = vi.fn(async () => {
      throw new Error('Publer is having a day');
    });
    expect(await unpublishFromPubler(d.publer, { publerPostIds: ['p1'] }, { warn })).toEqual({
      attempted: 1,
      removed: 0,
    });

    expect(await unpublishFromPubler({ configured: false }, { publerPostIds: ['p1'] })).toEqual({
      attempted: 0,
      removed: 0,
    });
  });

  // T-731. The budget's whole job is to stop an invocation that cannot finish,
  // without losing the documents it did not reach. Both halves are asserted:
  // the throw (which is what leaves the lease unadvanced) and the guaranteed
  // first document (which is what stops an over-budget singleton retrying
  // forever).
  describe('per-invocation work budget', () => {
    const threeDocs = () =>
      memStore({
        content: [
          { id: 'c1', inspectTrigger: true, _etag: 'e1' },
          { id: 'c2', inspectTrigger: true, _etag: 'e2' },
          { id: 'c3', inspectTrigger: true, _etag: 'e3' },
        ],
      });

    it('throws rather than returning, so the lease does not advance past unprocessed documents', async () => {
      const store = threeDocs();
      // Elapsed time jumps past the budget after the first document.
      let ticks = 0;
      const d = {
        ...deps(store),
        feedBudgetMs: 1000,
        monotonic: () => (ticks++ === 0 ? 0 : 5000),
      };
      const h = createFeedHandlers(d);
      const docs = ['c1', 'c2', 'c3'].map((id) => store.data.content.get(id));

      await expect(h.content(docs, { error: vi.fn() })).rejects.toMatchObject({
        code: 'FEED_BUDGET_EXHAUSTED',
        done: 1,
        total: 3,
      });

      // Exactly one document was worked. A silent `return` here would have
      // reported success and let the processor checkpoint past c2 and c3,
      // whose triggers would then never fire again — the feed only redelivers
      // on a subsequent write.
      expect(d.inspector.executeInspection).toHaveBeenCalledTimes(1);
    });

    it('always processes at least one document, however small the budget', async () => {
      const store = threeDocs();
      const d = { ...deps(store), feedBudgetMs: 0, monotonic: () => 1_000_000 };
      const h = createFeedHandlers(d);
      const docs = ['c1', 'c2', 'c3'].map((id) => store.data.content.get(id));

      // Budget already blown before the loop starts. Forward progress is still
      // required, or a document heavier than the budget would redeliver
      // forever and the feed would never drain.
      await expect(h.content(docs, { error: vi.fn() })).rejects.toMatchObject({ done: 1 });
      expect(d.inspector.executeInspection).toHaveBeenCalledTimes(1);
    });

    it('does not interfere with a batch that fits', async () => {
      const store = threeDocs();
      const d = { ...deps(store), monotonic: () => 0 };
      const h = createFeedHandlers(d);
      const docs = ['c1', 'c2', 'c3'].map((id) => store.data.content.get(id));

      const results = await h.content(docs, { error: vi.fn() });
      expect(results).toHaveLength(3);
      expect(d.inspector.executeInspection).toHaveBeenCalledTimes(3);
    });
  });
});

describe('notifier', () => {
  it('skips when unconfigured, honours the per-source cooldown, stamps state after a send', async () => {
    const store = memStore({
      system: [
        {
          id: 'notify_state',
          checkLiveLinks: { lastNotifiedAt: new Date(NOW.getTime() - 60000).toISOString() },
        },
      ],
    });
    const fetch = vi.fn(async () => ({ ok: true }));
    expect(
      await createNotifier({ store, env: {}, fetch, now }).notifyTelegram({
        title: 't',
        message: 'm',
      })
    ).toEqual({ sent: false, reason: 'not_configured' });
    const n = createNotifier({
      store,
      env: { TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '1' },
      fetch,
      now,
    });
    expect(await n.notifyTelegram({ title: 't', message: 'm', source: 'checkLiveLinks' })).toEqual({
      sent: false,
      reason: 'cooldown',
    });
    expect(
      await n.notifyTelegram({
        title: 't',
        message: 'm',
        severity: 'critical',
        source: 'workflow_alerts',
      })
    ).toEqual({ sent: true });
    expect(fetch.mock.calls[0][0]).toBe('https://api.telegram.org/bottok/sendMessage');
    expect(JSON.parse(fetch.mock.calls[0][1].body).text).toMatch(
      /^🔴 t\n\nm\n\nReported by the workflow alert monitor\.$/
    );
    expect(store.data.system.get('notify_state').workflow_alerts.lastNotifiedAt).toBe(
      NOW.toISOString()
    );
  });
});
