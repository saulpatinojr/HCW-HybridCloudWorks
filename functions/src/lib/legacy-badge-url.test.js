/**
 * legacy-badge-url.js — the string rewrite that gives a fifth of the
 * certification registry its badge back (#868): a Firebase or GCS object URL
 * for a `certifications/…` path becomes the media delivery URL, and nothing
 * else is touched.
 */
import { describe, it, expect } from 'vitest';
import {
  hasSelectedBadge,
  legacyBadgePath,
  legacyBadgePathsOf,
  repointAll,
  repointCertification,
  repointLegacyBadgeUrl,
} from './legacy-badge-url.js';

const FIREBASE =
  'https://firebasestorage.googleapis.com/v0/b/hybridcloudworks-61e8d.appspot.com/o/certifications%2F74GrtQFAFkhRgYWUTkf8%2Fimages%2Fbadge-image.png?alt=media';
const GCS =
  'https://storage.googleapis.com/hybridcloudworks-61e8d.appspot.com/certifications/74GrtQFAFkhRgYWUTkf8/images/badge-image.png';
const MEDIA = '/api/public/media/certifications/74GrtQFAFkhRgYWUTkf8/images/badge-image.png';

describe('legacyBadgePath', () => {
  it('reads the certifications path out of both Firebase shapes', () => {
    expect(legacyBadgePath(FIREBASE)).toBe('74GrtQFAFkhRgYWUTkf8/images/badge-image.png');
    expect(legacyBadgePath(GCS)).toBe('74GrtQFAFkhRgYWUTkf8/images/badge-image.png');
    expect(legacyBadgePath(`  ${FIREBASE}  `)).toBe('74GrtQFAFkhRgYWUTkf8/images/badge-image.png');
  });

  it('is null for anything that is not a legacy certifications object', () => {
    expect(legacyBadgePath('https://images.credly.com/size/340x340/images/x/image.png')).toBeNull();
    expect(legacyBadgePath(MEDIA)).toBeNull();
    expect(
      legacyBadgePath(
        'https://firebasestorage.googleapis.com/v0/b/b.appspot.com/o/blogs%2Fpost%2Fhero.png?alt=media'
      )
    ).toBeNull();
    expect(
      legacyBadgePath(
        'https://firebasestorage.googleapis.com/v0/b/b.appspot.com/o/certifications%2F..%2Fsecret.png?alt=media'
      )
    ).toBeNull();
    expect(legacyBadgePath('https://firebasestorage.googleapis.com/v0/b/b/o/%E0%A4%A?alt=media')).toBeNull();
    expect(legacyBadgePath(null)).toBeNull();
    expect(legacyBadgePath(42)).toBeNull();
  });
});

describe('repointLegacyBadgeUrl', () => {
  it('names the same path on the media route, encoded segment by segment', () => {
    expect(repointLegacyBadgeUrl(FIREBASE)).toBe(MEDIA);
    expect(repointLegacyBadgeUrl('https://example.com/x.png')).toBeNull();
  });
});

describe('legacyBadgePathsOf', () => {
  it('collects every field a legacy document may carry the badge in, once', () => {
    const doc = {
      imageUrl: FIREBASE,
      credentialImage: FIREBASE,
      image: [{ downloadURL: GCS }],
    };
    expect(legacyBadgePathsOf(doc)).toEqual(['74GrtQFAFkhRgYWUTkf8/images/badge-image.png']);
    expect(legacyBadgePathsOf({ imageUrl: MEDIA })).toEqual([]);
    expect(legacyBadgePathsOf({})).toEqual([]);
  });

  it("names nothing for an edited row: a live imageUrl is the editor's choice, old upload metadata stays history", () => {
    const edited = {
      imageUrl: '/api/public/media/certifications/c1/images/badge-1759600000000.png',
      credentialImage: FIREBASE,
      image: [{ downloadURL: FIREBASE }],
    };
    expect(hasSelectedBadge(edited)).toBe(true);
    expect(legacyBadgePathsOf(edited)).toEqual([]);
    expect(repointAll(edited, new Set(['74GrtQFAFkhRgYWUTkf8/images/badge-image.png']))).toEqual({
      doc: edited,
      changes: {},
      missing: [],
    });
    // A legacy or blank imageUrl is not a selection.
    expect(hasSelectedBadge({ imageUrl: FIREBASE })).toBe(false);
    expect(hasSelectedBadge({ imageUrl: '  ' })).toBe(false);
    expect(hasSelectedBadge({})).toBe(false);
  });
});

describe('repointCertification', () => {
  const path = '74GrtQFAFkhRgYWUTkf8/images/badge-image.png';

  it('sets imageUrl and rewrites the legacy fields that named the old URL', () => {
    const doc = {
      id: 'c1',
      name: 'Example Certification',
      credentialImage: FIREBASE,
      image: [{ downloadURL: FIREBASE, name: 'badge-image.png' }],
    };
    const { doc: out, changes } = repointCertification(doc, path);
    expect(changes).toEqual({
      imageUrl: MEDIA,
      credentialImage: MEDIA,
      image: [{ downloadURL: MEDIA, name: 'badge-image.png' }],
    });
    expect(out).toEqual({ ...doc, ...changes });
    expect(doc.credentialImage).toBe(FIREBASE);
  });

  it('leaves a field that names a different image alone', () => {
    const other = 'https://images.credly.com/x.png';
    const { changes } = repointCertification({ imageUrl: other, credentialImage: FIREBASE }, path);
    expect(changes).toEqual({ credentialImage: MEDIA });
  });

  it('returns the same object when nothing named the path', () => {
    const doc = { imageUrl: MEDIA };
    const out = repointCertification(doc, path);
    expect(out.doc).toBe(doc);
    expect(out.changes).toEqual({});
  });

  it('rewrites every alias that named the path and leaves a conflicting alias alone', () => {
    const credly = 'https://images.credly.com/x.png';
    // Only the old spelling is legacy: it is rewritten, the other is kept.
    expect(
      repointCertification({ image: [{ downloadUrl: FIREBASE, downloadURL: credly }] }, path).changes
    ).toEqual({ imageUrl: MEDIA, image: [{ downloadUrl: MEDIA, downloadURL: credly }] });
    // Both spellings legacy: both rewritten, so nothing is left for a later publish.
    const both = { credentialImage: FIREBASE, image: { downloadURL: FIREBASE, downloadUrl: GCS } };
    const once = repointCertification(both, path);
    expect(once.changes.image).toEqual({ downloadURL: MEDIA, downloadUrl: MEDIA });
    expect(legacyBadgePathsOf(once.doc)).toEqual([]);
    expect(repointCertification(once.doc, path).changes).toEqual({});
  });
});

describe('repointAll', () => {
  it('applies every confirmed path as one change set and lists the unconfirmed ones', () => {
    const other =
      'https://firebasestorage.googleapis.com/v0/b/b.appspot.com/o/certifications%2Fc2%2Fimages%2Fold.png?alt=media';
    const doc = { credentialImage: FIREBASE, image: [{ downloadURL: other }] };
    const out = repointAll(doc, new Set(['74GrtQFAFkhRgYWUTkf8/images/badge-image.png']));
    expect(out.changes).toEqual({ imageUrl: MEDIA, credentialImage: MEDIA });
    expect(out.missing).toEqual(['c2/images/old.png']);
    expect(out.doc.image).toEqual([{ downloadURL: other }]);
  });
});
