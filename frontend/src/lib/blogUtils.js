import { toDate } from '@/lib/dateUtils';

/**
 * Normalize inconsistent Firestore field names into a canonical shape.
 * Many documents use both Title/title, Summary/summary, etc.
 * Use this when reading content items to avoid cascading fallback chains.
 */
export const normalizeContentFields = (doc) => {
  if (!doc) return null;
  return {
    ...doc,
    title: doc.Title || doc.title || '',
    summary: doc.Summary || doc.summary || '',
    cloudProvider: doc['Cloud Provider'] || doc.cloudProvider || '',
    publishTarget: doc.publishTarget || doc.targetLandingZone || '',
    content: doc.content || doc.Content || doc.postContent || '',
    slug: doc.slug || doc.Slug || '',
  };
};

/**
 * Kept as a named export because several components import it; the
 * implementation now lives in lib/dateUtils.js so there is one of it
 * (T-304).
 */
export const normalizeFirestoreDate = (value) => toDate(value);

/**
 * Remove HTML tags from a string, applying the removal repeatedly until the
 * result is stable. A single pass of `<[^>]*>` is incomplete — overlapping
 * constructs such as `<scr<script>ipt>` leave a live tag behind — so we loop
 * to a fixed point. Used for plain-text previews and word counts.
 */
export const stripHtmlTags = (value) => {
  if (!value) return '';
  let prev;
  let out = String(value);
  do {
    prev = out;
    out = out.replace(/<[^>]*>/g, '');
  } while (out !== prev);
  return out;
};

// The URL inside a Cover Image field: the first upload of a list, the one
// upload of an object, or the field itself when it is already a URL.
const coverImageFieldUrl = (coverImage) => {
  if (Array.isArray(coverImage)) return coverImage[0]?.downloadURL || null;
  if (typeof coverImage === 'object') return coverImage.downloadURL || null;
  return coverImage;
};

export const getCoverImageUrl = (article) => {
  if (!article) return null;

  // Priority 0: AI-generated cover (altCoverImage field)
  if (article.altCoverImage && typeof article.altCoverImage === 'string') {
    return normalizePublicImageUrl(article.altCoverImage);
  }

  // Priority 1: Cover Image field (array or object)
  const coverImage = article.coverImage || article['Cover Image'];
  if (!coverImage) return null;
  return normalizePublicImageUrl(coverImageFieldUrl(coverImage));
};

/**
 * Extensions whose files a browser will never paint into an `<img>`.
 *
 * `ogg` is here beside `ogv` deliberately: the container carries audio as
 * often as video, and neither is an image, so an image slot is the wrong
 * place for it either way.
 */
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogv', 'ogg', 'mov', 'm4v', 'avi', 'mkv', 'm3u8']);

/** Resolves a relative reference so `isVideoUrl` can read a pathname from one. */
const RELATIVE_URL_BASE = 'https://relative.invalid';

/**
 * True when a URL points at video rather than an image (issue #374).
 *
 * WHY THIS EXISTS. The curated feed fills `contentImageUrl` from whatever
 * media the publisher led with, and sometimes that is an **`.mp4`**. The
 * published-pages audit re-run of 2026-09-07 found one: the
 * Microsoft Foundry observability article's cover was
 * `…/2026/06/RUBRIC-EVALUATOR.mp4`, a real 5.3 MB `video/mp4`. Every cover
 * slot renders an `<img>`, so the reader got one empty box and the
 * published-pages audit reported a broken image. Re-hosting the file (#374)
 * moves it to our own storage and changes nothing: a video in an `<img>` does
 * not render from any origin. The same feed will do this again, so the test
 * is on the media type, never on that one URL.
 *
 * The test reads the **path**, not the whole string, because a query string
 * or fragment otherwise defeats it in both directions: `…/clip.mp4?w=1200`
 * is still a video, and `…/photo.png?poster=clip.mp4` is still an image.
 */
const parseLooseUrl = (url) => {
  try {
    return new URL(url, RELATIVE_URL_BASE);
  } catch {
    return null;
  }
};

/** The lower-case extension of the last path segment, or '' when it has none. */
const fileExtension = (pathname) => {
  const filename = pathname.slice(pathname.lastIndexOf('/') + 1);
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
};

export const isVideoUrl = (value) => {
  if (typeof value !== 'string') return false;
  const url = value.trim();
  const parsed = url ? parseLooseUrl(url) : null;
  if (!parsed) return false;

  // A data: URI declares its own media type, which beats guessing at an
  // extension the payload does not have.
  if (parsed.protocol === 'data:') return /^video\//i.test(parsed.pathname);

  return VIDEO_EXTENSIONS.has(fileExtension(parsed.pathname));
};

/**
 * A URL pointing into the retired Firebase Storage bucket (#518).
 *
 * Both shapes are the same dead bucket: `storage.googleapis.com/<bucket>/…` is
 * the GCS form and `firebasestorage.googleapis.com/v0/b/<bucket>/o/…` is the
 * Firebase form of the identical object. Neither resolves — the project was
 * decommissioned with the migration to Azure.
 */
const isDeadFirebaseStorageUrl = (value) => {
  try {
    const { hostname } = new URL(value);
    return hostname === 'storage.googleapis.com' || hostname === 'firebasestorage.googleapis.com';
  } catch {
    // Not an absolute URL, so not one of these.
    return false;
  }
};

export const normalizePublicImageUrl = (value) => {
  const url = typeof value === 'string' ? value.trim() : '';
  if (!url) return null;

  // Not an image, so not an image URL. Returning null rather than the string
  // is what lets every caller's existing falsy branch do the right thing:
  // the hero is omitted, og:image and twitter:image are left off, and a card
  // falls back to its placeholder instead of showing an empty frame.
  if (isVideoUrl(url)) return null;

  // THE FIREBASE BUCKET IS GONE (#518).
  //
  // This used to rewrite `storage.googleapis.com/<bucket>/<path>` into the
  // `firebasestorage.../o/<enc>?alt=media` form, on the understanding that it
  // was preserving images for migrated content. Checked 2026-09-12: the bucket
  // root and all 28 asset URLs still referenced by the content manifest return
  // **404**, against live controls. So the rewrite turned one dead URL into
  // another dead URL, and five published articles rendered a broken frame with
  // `og:image` and `twitter:image` pointing at 404s — breaking link previews as
  // well as the page.
  //
  // Treating them as absent is what the rest of this function already does for
  // a video, and it is the right answer for the same reason: every caller's
  // falsy branch then omits the hero, drops the social tags, and falls a card
  // back to its placeholder. A missing image renders better than a broken one.
  //
  // Not a data migration. The rows still hold these URLs and are now inert;
  // this holds whether or not they are ever cleaned up, and covers any row that
  // is restored from an old backup.
  if (isDeadFirebaseStorageUrl(url)) return null;

  return url;
};

/**
 * The first candidate that is a usable image URL, normalized; null when none is.
 *
 * WHY A PICKER AND NOT A PLAIN `||` CHAIN. Every cover chain in the app puts
 * `contentImageUrl` — the feed-supplied field — at or near the front, and
 * `||` commits to it before `normalizePublicImageUrl` ever sees it. So a
 * video there does not merely fail to render, it *shadows* the fields behind
 * it: an article with an `.mp4` in `contentImageUrl` and a good AI cover in
 * `altCoverImage` would show nothing at all. Rejecting the video and
 * continuing down the chain is what the chain was always meant to do.
 */
export const pickPublicImageUrl = (...candidates) => {
  for (const candidate of candidates) {
    const normalized = normalizePublicImageUrl(candidate);
    if (normalized) return normalized;
  }
  return null;
};

export const formatPostDate = (date) => {
  const normalized = normalizeFirestoreDate(date);
  return normalized && !isNaN(normalized) ? normalized.toLocaleDateString() : '';
};
