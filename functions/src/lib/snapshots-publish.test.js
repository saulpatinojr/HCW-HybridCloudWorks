/**
 * publishSnapshot — the sanitizer IS the security boundary: hidden certs and
 * non-whitelisted fields must never reach the public _snapshots docs.
 */
import { describe, it, expect, vi } from 'vitest';
import { blobNameFromUrl, isImageBlobName } from './timers/cert-image-cleanup.js';
import {
  createSnapshotPublishHandlers,
  sanitizeCertification,
  sanitizeSpeakerEvent,
  serializeValue,
} from './snapshots-publish.js';

const context = { log: vi.fn(), error: vi.fn() };
const guardAs = (role) => ({
  requireRole: vi.fn(async () => ({ user: { oid: 'u1' }, role, error: null })),
});
const makeRequest = () => ({ headers: { get: () => null }, json: async () => ({}) });
const NOW = new Date('2026-08-07T06:30:00.000Z');

describe('sanitizeCertification', () => {
  it('drops hidden certs entirely', () => {
    expect(sanitizeCertification({ id: 'x', name: 'Secret', display: false })).toBeNull();
    expect(sanitizeCertification({ id: 'x', name: 'Unset' })).toBeNull();
  });

  it('whitelists fields — internal ones never pass through', () => {
    const out = sanitizeCertification({
      id: 'c1',
      name: 'AZ-104',
      issuer: 'Microsoft',
      display: true,
      description: 'INTERNAL NOTES',
      learnUrl: 'https://internal',
      _updatedAt: 'stamp',
      verifyUrl: 'https://verify',
    });
    expect(out).toMatchObject({
      id: 'c1',
      name: 'AZ-104',
      verifyUrl: 'https://verify',
      display: true,
    });
    expect(out).not.toHaveProperty('featured');
    expect(
      sanitizeCertification({ id: 'c2', name: 'F', display: true, featured: true }).featured
    ).toBe(true);
    expect(out).not.toHaveProperty('description');
    expect(out).not.toHaveProperty('learnUrl');
    expect(out).not.toHaveProperty('_updatedAt');
  });

  it('serializeValue flattens geo-points to public field names', () => {
    expect(serializeValue({ latitude: 1.5, longitude: 2.5 })).toEqual({
      latitude: 1.5,
      longitude: 2.5,
    });
    expect(serializeValue({ toDate: () => new Date('2026-01-01T00:00:00Z') })).toBe(
      '2026-01-01T00:00:00.000Z'
    );
  });
});

describe('sanitizeCertification: the badge URL it publishes', () => {
  const DEAD =
    'https://firebasestorage.googleapis.com/v0/b/b.appspot.com/o/certifications%2Fc1%2Fimages%2Fold.png?alt=media';

  it("prefers the editor's imageUrl over a legacy credentialImage", () => {
    const out = sanitizeCertification({
      id: 'c1',
      display: true,
      imageUrl: '/api/public/media/certifications/c1/images/new.png',
      credentialImage: DEAD,
    });
    expect(out.credentialImage).toBe('/api/public/media/certifications/c1/images/new.png');
  });

  it('keeps a live credentialImage when imageUrl is legacy, and the first defined when every candidate is legacy', () => {
    expect(
      sanitizeCertification({ id: 'c1', display: true, imageUrl: DEAD, credentialImage: 'https://images.credly.com/x.png' })
        .credentialImage
    ).toBe('https://images.credly.com/x.png');
    expect(sanitizeCertification({ id: 'c1', display: true, imageUrl: DEAD, credentialImage: DEAD }).credentialImage).toBe(DEAD);
    expect(sanitizeCertification({ id: 'c1', display: true })).not.toHaveProperty('credentialImage');
  });
});

describe('sanitizeSpeakerEvent', () => {
  const full = (over = {}) => ({
    id: 'ev1',
    name: 'A Conference Talk',
    date: '2026-09-01T00:00:00.000Z',
    location: 'Austin, TX',
    description: 'About things',
    eventUrl: 'https://conf.test',
    presentationUrl: 'https://slides.test',
    eventImageUrl: 'https://img.test/a.png',
    sessionizeId: 12345,
    display: true,
    // The leak this sanitizer exists to stop — upsertSpeakerEvent stamps both
    // with the admin's email address.
    createdBy: 'admin@hybridcloudworks.com',
    updatedBy: 'other-admin@hybridcloudworks.com',
    // No write-side field allowlist, so an editor can add anything.
    internalNotes: 'client paid 5k, do not publish',
    ...over,
  });

  it('publishes a hidden Sessionize-backed row as a tombstone and nothing more', () => {
    // The widget needs the join key to hide what Sessionize still lists
    // (ADR 0033, Spotlight slice); every other field stays private.
    expect(sanitizeSpeakerEvent(full({ display: false }))).toEqual({
      id: 'ev1',
      sessionizeId: 12345,
      display: false,
    });
    expect(
      sanitizeSpeakerEvent(full({ display: false, sessionizeId: undefined, eventId: 77 }))
    ).toEqual({ id: 'ev1', sessionizeId: 77, display: false });
  });

  it('drops a hidden manual entry entirely — nothing public to hide', () => {
    expect(sanitizeSpeakerEvent(full({ display: false, sessionizeId: undefined }))).toBeNull();
  });

  it('carries the mirrored images, the status and the sessions when present', () => {
    const out = sanitizeSpeakerEvent(
      full({
        images: [{ downloadURL: '/api/public/media/speakerevents/ev1/a.png', path: 'private' }],
        status: 'delivered',
        sessions: [
          { title: 'Keynote', slidesUrl: 'https://s', internal: 'x' },
          { abstract: 'no title' },
        ],
      })
    );
    expect(out.images).toEqual([{ downloadURL: '/api/public/media/speakerevents/ev1/a.png' }]);
    expect(out.status).toBe('delivered');
    expect(out.sessions).toEqual([{ title: 'Keynote', slidesUrl: 'https://s' }]);
  });

  it('fails closed when display is unset', () => {
    const { display, ...noFlag } = full();
    expect(display).toBe(true); // guard against the fixture drifting
    expect(sanitizeSpeakerEvent(noFlag)).toBeNull();
  });

  it('never emits admin email addresses', () => {
    const out = sanitizeSpeakerEvent(full());
    expect(out).not.toHaveProperty('createdBy');
    expect(out).not.toHaveProperty('updatedBy');
    expect(JSON.stringify(out)).not.toContain('@hybridcloudworks.com');
  });

  it('drops any field an editor adds that is not on the allowlist', () => {
    const out = sanitizeSpeakerEvent(full());
    expect(out).not.toHaveProperty('internalNotes');
    expect(JSON.stringify(out)).not.toContain('do not publish');
  });

  it('emits exactly the fields the widget renders', () => {
    // Derived from mergeWithFirestore and the manual-entry path in
    // CustomSessionizeWidget.jsx. Growing this list publishes a new field to
    // anonymous callers, so the assertion is exact rather than a superset.
    expect(Object.keys(sanitizeSpeakerEvent(full())).sort()).toEqual([
      'date',
      'description',
      'display',
      'eventImageUrl',
      'eventUrl',
      'id',
      'location',
      'name',
      'presentationUrl',
      'sessionizeId',
    ]);
  });

  it('accepts the legacy casing and naming variants', () => {
    const out = sanitizeSpeakerEvent({
      id: 'ev2',
      Title: 'Legacy Talk',
      Location: 'Remote',
      website: 'https://legacy.test',
      display: true,
    });
    expect(out).toMatchObject({
      name: 'Legacy Talk',
      location: 'Remote',
      eventUrl: 'https://legacy.test',
    });
  });

  it('flattens a GeoPoint location into plain lat/long', () => {
    const out = sanitizeSpeakerEvent({
      id: 'ev3',
      name: 'Geo',
      display: true,
      location_coords: { latitude: 30.26, longitude: -97.74 },
    });
    expect(out.location_coords).toEqual({ latitude: 30.26, longitude: -97.74 });
  });

  it('omits absent optional fields rather than emitting nulls', () => {
    const out = sanitizeSpeakerEvent({ id: 'ev4', name: 'Minimal', display: true });
    expect(out).toEqual({ id: 'ev4', name: 'Minimal', display: true });
  });
});

describe('publishSnapshot handler', () => {
  it('sanitizes both collections and counts what survived', async () => {
    // This test previously asserted "raw speakerevents" — it encoded the leak
    // T-201 describes, and passing was not evidence of anything good.
    const store = {
      queryDocs: vi.fn(async (container) =>
        container === 'certifications'
          ? [
              { id: 'visible', name: 'A', display: true, description: 'hidden field' },
              { id: 'hidden', name: 'B', display: false },
            ]
          : [
              { id: 'ev1', title: 'Talk', display: true, createdBy: 'admin@example.com' },
              { id: 'ev2', title: 'Hidden Talk', display: false },
              { id: 'ev3', title: 'No Flag' },
            ]
      ),
      upsertDoc: vi.fn(async (_c, d) => d),
    };
    const h = createSnapshotPublishHandlers({ guard: guardAs('editor'), store, now: () => NOW });
    const body = JSON.parse((await h.publishSnapshot(makeRequest(), context)).body);
    expect(body).toMatchObject({
      certifications: 1,
      speakerevents: 1,
      generatedAt: NOW.toISOString(),
    });

    const certSnap = store.upsertDoc.mock.calls.find(([, d]) => d.id === 'certifications')[1];
    expect(certSnap.items).toHaveLength(1);
    expect(certSnap.items[0].id).toBe('visible');
    expect(certSnap.items[0]).not.toHaveProperty('description');

    const evSnap = store.upsertDoc.mock.calls.find(([, d]) => d.id === 'speakerevents')[1];
    expect(evSnap.items.map((i) => i.id)).toEqual(['ev1']);
    expect(evSnap.items[0]).not.toHaveProperty('createdBy');
    expect(JSON.stringify(evSnap)).not.toContain('admin@example.com');

    expect(store.upsertDoc.mock.calls.every(([c]) => c === '_snapshots')).toBe(true);
    expect(evSnap.publishedAt).toBe(NOW.toISOString());
    expect(evSnap).not.toHaveProperty('meta');
  });

  it('copies the speaker id and profile from admin_settings into the speakerevents snapshot', async () => {
    const store = {
      queryDocs: vi.fn(async () => []),
      readDoc: vi.fn(async (container, id) =>
        container === 'admin_settings' && id === 'integrations'
          ? {
              sessionizeSpeakerId: ' abc123 ',
              speakerProfile: {
                name: 'Speaker',
                bio: 'Talks about clouds',
                headshotUrl: 'https://img/h.png',
                links: [{ label: 'Site', url: 'https://site' }, { url: 'javascript:x' }],
              },
              resendApiKey: 'never',
            }
          : null
      ),
      upsertDoc: vi.fn(async (_c, d) => d),
    };
    const h = createSnapshotPublishHandlers({ guard: guardAs('editor'), store, now: () => NOW });
    await h.publishSnapshot(makeRequest(), context);
    const evSnap = store.upsertDoc.mock.calls.find(([, d]) => d.id === 'speakerevents')[1];
    expect(evSnap.meta).toEqual({
      speakerId: 'abc123',
      speakerProfile: {
        name: 'Speaker',
        bio: 'Talks about clouds',
        headshotUrl: 'https://img/h.png',
        links: [{ label: 'Site', url: 'https://site' }],
      },
    });
    expect(JSON.stringify(evSnap)).not.toContain('never');
    const certSnap = store.upsertDoc.mock.calls.find(([, d]) => d.id === 'certifications')[1];
    expect(certSnap).not.toHaveProperty('meta');
  });

  it('every snapshot collection has a sanitizer', async () => {
    // The gap T-201 came from was a collection in SNAPSHOT_COLLECTIONS with no
    // SANITIZERS entry, which published raw rows. Adding a collection without
    // one now fails here rather than in production.
    const seen = [];
    const store = {
      queryDocs: vi.fn(async (container) => {
        seen.push(container);
        return [{ id: 'x', name: 'n', secretField: 'leak', display: true }];
      }),
      upsertDoc: vi.fn(async (_c, d) => d),
    };
    const h = createSnapshotPublishHandlers({ guard: guardAs('editor'), store, now: () => NOW });
    await h.publishSnapshot(makeRequest(), context);

    expect(seen.length).toBeGreaterThan(0);
    for (const [, doc] of store.upsertDoc.mock.calls) {
      for (const item of doc.items) {
        expect(item).not.toHaveProperty('secretField');
      }
    }
  });

  it('denies without store calls', async () => {
    const store = { queryDocs: vi.fn(), upsertDoc: vi.fn() };
    const deny = {
      requireRole: vi.fn(async () => ({
        user: null,
        role: null,
        error: { status: 403, body: '{}' },
      })),
    };
    const h = createSnapshotPublishHandlers({ guard: deny, store, now: () => NOW });
    expect((await h.publishSnapshot(makeRequest(), context)).status).toBe(403);
    expect(store.queryDocs).not.toHaveBeenCalled();
  });
});

describe('the timer entry point', () => {
  it('exposes publishSnapshots, the name schedulers.js hands the re-verify timer', async () => {
    const store = { queryDocs: vi.fn(async () => []), upsertDoc: vi.fn(async (_c, d) => d) };
    const h = createSnapshotPublishHandlers({ guard: guardAs('editor'), store, now: () => NOW });
    expect(typeof h.publishSnapshots).toBe('function');
    const out = await h.publishSnapshots(['certifications']);
    expect(out).toMatchObject({ results: { certifications: 0 }, generatedAt: NOW.toISOString() });
    expect(store.upsertDoc).toHaveBeenCalledTimes(1);
  });
});

describe('legacy badge references (#868)', () => {
  const FIREBASE = (path) =>
    `https://firebasestorage.googleapis.com/v0/b/b.appspot.com/o/${encodeURIComponent(`certifications/${path}`)}?alt=media`;
  const rows = () => [
    {
      id: 'cert-example',
      name: 'Example Certification',
      display: true,
      _etag: 'etag-1',
      credentialImage: FIREBASE('cert-example/images/badge-image.png'),
      image: [{ downloadURL: FIREBASE('cert-example/images/badge-image.png') }],
    },
    {
      id: 'gone',
      name: 'Gone',
      display: true,
      credentialImage: FIREBASE('gone/images/badge-1.png'),
    },
    { id: 'fine', name: 'Fine', display: true, imageUrl: 'https://images.credly.com/x.png' },
  ];
  const makeStore = () => ({
    queryDocs: vi.fn(async (container) => (container === 'certifications' ? rows() : [])),
    upsertDoc: vi.fn(async (_c, d) => d),
    patchDoc: vi.fn(async (_c, id, changes) => ({ id, ...changes })),
    readDoc: vi.fn(async (_c, id) => rows().find((r) => r.id === id) || null),
  });
  const conflict = () => Object.assign(new Error('precondition failed'), { code: 412 });
  const storage = {
    headBlobForDelivery: vi.fn(async (_c, path) =>
      path === 'cert-example/images/badge-image.png' ? { contentType: 'image/png' } : null
    ),
  };
  const MEDIA = '/api/public/media/certifications/cert-example/images/badge-image.png';

  it('publishes the media URL for a badge whose blob exists, persists it, and names the missing one', async () => {
    const store = makeStore();
    const h = createSnapshotPublishHandlers({ guard: guardAs('editor'), store, storage, now: () => NOW });
    const body = JSON.parse((await h.publishSnapshot(makeRequest(), context)).body);
    expect(body.legacyBadges).toEqual({ repointed: 1, missing: ['Gone: gone/images/badge-1.png'] });

    const snap = store.upsertDoc.mock.calls.find(([, d]) => d.id === 'certifications')[1];
    const cert = snap.items.find((i) => i.id === 'cert-example');
    expect(cert.credentialImage).toBe(MEDIA);
    expect(cert.image[0].downloadURL).toBe(MEDIA);
    expect(JSON.stringify(cert)).not.toContain('firebasestorage');
    // The missing one is left exactly as stored: the page already skips it.
    const gone = snap.items.find((i) => i.id === 'gone');
    expect(gone.credentialImage).toContain('firebasestorage');

    // One conditional write per row, on the ETag the row was queried with.
    expect(store.patchDoc).toHaveBeenCalledTimes(1);
    expect(store.patchDoc).toHaveBeenCalledWith(
      'certifications',
      'cert-example',
      { imageUrl: MEDIA, credentialImage: MEDIA, image: [{ downloadURL: MEDIA }] },
      { ifMatch: 'etag-1' }
    );
    expect(storage.headBlobForDelivery).toHaveBeenCalledWith('certifications', 'cert-example/images/badge-image.png');
  });

  it('the persisted URL is a reference the nightly cleanup recognises, so the badge is never a deletion candidate', async () => {
    const store = makeStore();
    await createSnapshotPublishHandlers({ guard: guardAs('editor'), store, storage, now: () => NOW }).publishSnapshots();
    const [, , changes] = store.patchDoc.mock.calls[0];
    for (const url of [changes.imageUrl, changes.credentialImage, changes.image[0].downloadURL]) {
      const name = blobNameFromUrl(url);
      expect(name).toBe('cert-example/images/badge-image.png');
      expect(isImageBlobName(name)).toBe(true);
    }
  });

  it('on a 412 re-reads the row, decides again from what is stored now, and writes once more on the fresh ETag', async () => {
    const store = makeStore();
    const edited = {
      ...rows()[0],
      _etag: 'etag-2',
      imageUrl: '/api/public/media/certifications/cert-example/images/badge-1759600000000.png',
    };
    store.readDoc = vi.fn(async () => edited);
    store.patchDoc = vi.fn(async () => {
      throw conflict();
    });
    const h = createSnapshotPublishHandlers({ guard: guardAs('editor'), store, storage, now: () => NOW });
    const body = JSON.parse((await h.publishSnapshot(makeRequest(), context)).body);
    // The editor chose a new badge meanwhile: nothing to re-point, nothing written twice.
    expect(store.patchDoc).toHaveBeenCalledTimes(1);
    expect(body.legacyBadges.repointed).toBe(0);
    const snap = store.upsertDoc.mock.calls.find(([, d]) => d.id === 'certifications')[1];
    const cert = snap.items.find((i) => i.id === 'cert-example');
    // The fresh row is what is published, and its selected badge is the plain URL.
    expect(cert.credentialImage).toBe('/api/public/media/certifications/cert-example/images/badge-1759600000000.png');
  });

  it('a 412 on a row that still needs the rewrite writes it once more on the fresh ETag; a second 412 publishes the fresh row as stored', async () => {
    const store = makeStore();
    const fresh = { ...rows()[0], _etag: 'etag-2', name: 'Example Certification (renamed)' };
    store.readDoc = vi.fn(async () => fresh);
    let calls = 0;
    store.patchDoc = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw conflict();
      return {};
    });
    const h = createSnapshotPublishHandlers({ guard: guardAs('editor'), store, storage, now: () => NOW });
    let body = JSON.parse((await h.publishSnapshot(makeRequest(), context)).body);
    expect(store.patchDoc.mock.calls.map(([, , , opts]) => opts)).toEqual([
      { ifMatch: 'etag-1' },
      { ifMatch: 'etag-2' },
    ]);
    expect(body.legacyBadges.repointed).toBe(1);
    let snap = store.upsertDoc.mock.calls.find(([, d]) => d.id === 'certifications')[1];
    expect(snap.items.find((i) => i.id === 'cert-example')).toMatchObject({ name: 'Example Certification (renamed)', credentialImage: MEDIA });

    // Twice: give up on the write, publish the fresh row exactly as stored, say so.
    const log = { warn: vi.fn() };
    const store2 = makeStore();
    store2.readDoc = vi.fn(async () => fresh);
    store2.patchDoc = vi.fn(async () => {
      throw conflict();
    });
    body = JSON.parse(
      (await createSnapshotPublishHandlers({ guard: guardAs('editor'), store: store2, storage, now: () => NOW, log }).publishSnapshot(makeRequest(), context)).body
    );
    expect(body.legacyBadges.repointed).toBe(0);
    snap = store2.upsertDoc.mock.calls.find(([, d]) => d.id === 'certifications')[1];
    expect(snap.items.find((i) => i.id === 'cert-example').credentialImage).toContain('firebasestorage');
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('changed twice'));
  });

  it('an edited row keeps its selected badge: imageUrl wins over a legacy credentialImage and the old upload is not revived', async () => {
    const store = makeStore();
    const selected = '/api/public/media/certifications/cert-example/images/badge-1759600000000.png';
    store.queryDocs = vi.fn(async (container) =>
      container === 'certifications' ? [{ ...rows()[0], imageUrl: selected }] : []
    );
    const h = createSnapshotPublishHandlers({ guard: guardAs('editor'), store, storage, now: () => NOW });
    await h.publishSnapshot(makeRequest(), context);
    expect(store.patchDoc).not.toHaveBeenCalled();
    const snap = store.upsertDoc.mock.calls.find(([, d]) => d.id === 'certifications')[1];
    const cert = snap.items.find((i) => i.id === 'cert-example');
    expect(cert.credentialImage).toBe(selected);
    // The old upload object is published as it was: dead, and skipped by the page.
    expect(cert.image[0].downloadURL).toContain('firebasestorage');
  });

  it('asks blob storage once per distinct path, never for a non-legacy URL', async () => {
    const store = makeStore();
    storage.headBlobForDelivery.mockClear();
    await createSnapshotPublishHandlers({ guard: guardAs('editor'), store, storage, now: () => NOW }).publishSnapshots();
    expect(storage.headBlobForDelivery.mock.calls.map(([, p]) => p).sort()).toEqual([
      'cert-example/images/badge-image.png',
      'gone/images/badge-1.png',
    ]);
  });

  it('with no blob storage wired, leaves every reference as stored and reports nothing', async () => {
    const store = makeStore();
    const h = createSnapshotPublishHandlers({ guard: guardAs('editor'), store, now: () => NOW });
    const body = JSON.parse((await h.publishSnapshot(makeRequest(), context)).body);
    expect(body).not.toHaveProperty('legacyBadges');
    expect(store.patchDoc).not.toHaveBeenCalled();
  });

  it('a persist failure is logged and the publish still carries the re-pointed URL', async () => {
    const store = makeStore();
    store.patchDoc = vi.fn(async () => {
      throw new Error('cosmos down');
    });
    const log = { warn: vi.fn() };
    const h = createSnapshotPublishHandlers({ guard: guardAs('editor'), store, storage, now: () => NOW, log });
    const body = JSON.parse((await h.publishSnapshot(makeRequest(), context)).body);
    expect(body.legacyBadges.repointed).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('could not persist'));
    const snap = store.upsertDoc.mock.calls.find(([, d]) => d.id === 'certifications')[1];
    expect(snap.items.find((i) => i.id === 'cert-example').credentialImage).toBe(MEDIA);
  });
});
