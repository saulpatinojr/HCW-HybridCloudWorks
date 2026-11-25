/**
 * Anonymous public API client — plain fetch against the Azure Functions
 * public endpoints (routes in functions/src/functions/public-reads.js).
 *
 * No auth and no MSAL on purpose: these are the reads the browser used to
 * make directly against Firestore under public security rules. The server
 * now owns the public filter (drafts and soft-deleted documents never appear
 * in responses) and strips internal review/audit fields, so consumers can
 * render what they receive without re-checking visibility.
 *
 * The shared GET and its cache, the cloud tools calls and the lab calls live
 * in three sibling files (publicApiGet.js, publicApiCloudTools.js,
 * publicApiLabs.js). They are re-exported here, so callers keep importing
 * from '@/lib/publicApi'.
 */
import { requireFunctionsBase } from '@/lib/functionsBase';
import { fetchPublicJSON, publicGet } from './publicApiGet';

export { clearPublicGetCache } from './publicApiGet';
export {
  fetchCloudPricing,
  fetchPriceChanges,
  requestPricingExplanation,
  requestLandingZoneExplanation,
} from './publicApiCloudTools';
export {
  fetchLabsEstate,
  fetchCoderStatus,
  fetchAddonStatus,
  fetchLabSubmissionStatus,
  submitLabValidation,
  fetchPublicLabJob,
  fetchVisitorSessionStatus,
  startVisitorSession,
  stopVisitorSession,
} from './publicApiLabs';

/**
 * Rows requested when a caller wants "the published corpus" (T-716).
 *
 * The three hooks that do this asked for 200, 250 and 150 — three DIFFERENT
 * urls for one intent, which defeats any sharing between them. One constant
 * means one url, so the dedupe below actually applies; 250 is the largest of
 * the previous values, so no caller loses rows. The dedupe is `publicGet`'s
 * cache, in publicApiGet.js.
 */
export const PUBLIC_CORPUS_LIMIT = 250;

/**
 * GET public/content — published documents, newest first.
 * @param {object} [options]
 * @param {string} [options.type] - canonical content type (e.g. 'architecture')
 * @param {string} [options.provider] - provider key; the server expands the
 *   spelling aliases ('gcp' matches 'Google Cloud', etc.)
 * @param {number} [options.limit]
 * @param {number} [options.offset]
 * @param {string} [options.source] - 'blogs' for the legacy fallback container
 * @returns {Promise<object[]>} published documents, each projected by the
 *   server to an allowlist of fields (PUBLIC_CONTENT_LIST_FIELDS in
 *   functions/src/lib/public-reads.js); a field not on it is never sent
 */
export async function fetchPublicContentList(options = {}) {
  return (await fetchPublicContentPage(options)).items;
}

/**
 * GET public/content, keeping the count beside the rows: `{ items, total }`.
 *
 * `total` is how many published documents match, not how many came back
 * (T-407), counted over the server's newest-1,000 window, so it is exact for
 * any corpus smaller than that. The home page shows it as its article count.
 * It is null when the response carries none: the page size is not a count,
 * and passing it off as one is the kind of number the home page just lost.
 * Same options, same url and so the same shared request as
 * `fetchPublicContentList`.
 */
export async function fetchPublicContentPage({ type, provider, limit, offset, source } = {}) {
  const params = new URLSearchParams();
  if (type) params.set('type', type);
  if (provider) params.set('provider', provider);
  if (limit) params.set('limit', String(limit));
  if (offset) params.set('offset', String(offset));
  if (source) params.set('source', source);
  const qs = params.toString();
  const body = await publicGet(`public/content${qs ? `?${qs}` : ''}`);
  const items = body?.items || [];
  return { items, total: Number.isInteger(body?.total) ? body.total : null };
}

/**
 * GET public/content/{slugOrId} — the server folds the whole client-side
 * fallback chain (id → slug → Slug, content then legacy blogs) and 404s
 * anything non-public. Returns null when not found. The item is projected to
 * an allowlist (PUBLIC_CONTENT_DETAIL_FIELDS in functions/src/lib/
 * public-reads.js), so a field a detail template starts reading must be added
 * there first.
 */
export async function fetchPublicContentItem(slugOrId) {
  if (!slugOrId) return null;
  const body = await publicGet(`public/content/${encodeURIComponent(slugOrId)}`);
  return body?.item || null;
}

/**
 * GET public/interviews — every published interview, newest first, each
 * projected by the server to PUBLIC_INTERVIEW_LIST_FIELDS (slug, title,
 * subtitle, date, guest, tags, publishedAt), never the consent record or the
 * recording (ADR 0040, D6). Read by /azure/interviews and the Azure landing
 * page's Interviews card under the `interviews:list` key; an empty list means
 * there is none yet. Through the shared GET cache, so the two ask once.
 *
 * @returns {Promise<object[]>}
 */
export async function fetchPublicInterviews() {
  const body = await publicGet('public/interviews');
  return Array.isArray(body?.items) ? body.items : [];
}

/**
 * GET public/interviews/{slug} — one published interview, projected to
 * PUBLIC_INTERVIEW_DETAIL_FIELDS (the list fields plus bio, image, qa,
 * related, updatedAt). Null when there is none or it is not public: the
 * server answers the same 404 for both. The page runs the item through
 * `normalizeInterview` (lib/interviews.js) before rendering it.
 *
 * @param {string} slug
 * @returns {Promise<object|null>}
 */
export async function fetchPublicInterview(slug) {
  if (!slug) return null;
  const body = await publicGet(`public/interviews/${encodeURIComponent(slug)}`);
  return body?.item || null;
}

/**
 * GET public/preview/{contentId}?t={token} — the signed staging preview
 * (T-606). The HMAC token is the whole authorization; the server answers an
 * identical 404 for anything invalid, so null covers bad token, expiry and
 * missing document alike.
 */
export async function fetchPreviewContentItem(contentId, token) {
  if (!contentId || !token) return null;
  const body = await publicGet(
    `public/preview/${encodeURIComponent(contentId)}?t=${encodeURIComponent(token)}`
  );
  return body?.item || null;
}

/**
 * GET public/snapshots/{id} — items from a build-time snapshot document
 * ('certifications' | 'speakerevents'). Returns [] when missing or on error,
 * matching the quiet-fallback contract of loadPublicDataSnapshot.
 */
export async function fetchPublicSnapshotItems(id) {
  try {
    const body = await publicGet(`public/snapshots/${encodeURIComponent(id)}`);
    const items = body?.snapshot?.items;
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

/**
 * GET public/snapshots/{id} as a whole — `{ generatedAt, items }` — for the
 * Certifications Hub's Publishing tab, which has to say when the snapshot was
 * written and compare it with the admin rows. Unlike fetchPublicSnapshotItems
 * it throws on failure (the tab shows the error) and returns null when no
 * snapshot has been published. `fresh` bypasses this module's cache entirely
 * (never read, never written, so repeated fresh reads cannot grow it) and adds
 * a throwaway query value so an HTTP cache cannot answer with the copy from
 * before a publish either; the route ignores the value.
 */
export async function fetchPublicSnapshot(id, { fresh = false } = {}) {
  const path = `public/snapshots/${encodeURIComponent(id)}`;
  const body = fresh ? await fetchPublicJSON(`${path}?fresh=${Date.now()}`) : await publicGet(path);
  const snapshot = body?.snapshot;
  if (!snapshot) return null;
  return {
    generatedAt: typeof snapshot.generatedAt === 'string' ? snapshot.generatedAt : null,
    items: Array.isArray(snapshot.items) ? snapshot.items : [],
  };
}

/**
 * GET public/newsletter/signup-config — where the newsletter signup box shows
 * and its heading and blurb (#557): `{ placement, heading, blurb }`. The
 * server answers its defaults rather than failing, so a throw here is a
 * network or configuration problem; hooks/useNewsletterSignupConfig.js turns
 * it into the built-in defaults.
 */
export async function fetchNewsletterSignupConfig() {
  return publicGet('public/newsletter/signup-config');
}

/**
 * POST public/submissions — anonymous content submission. The server owns
 * validation, document composition, and the per-client hourly quota (429),
 * replacing the pages' direct addDoc writes into the content collection.
 * Resolves to { ok, id }.
 *
 * The submission pages show the thrown message, so it is always a visitor's
 * sentence (owner direction 2026-09-28): the server's own words only for a
 * 400, which names the form field at fault; the hourly limit in plain words
 * for a 429; and "please try again" for everything else, a build with no API
 * base and a network failure included. Never an HTTP status, and never
 * requireFunctionsBase's message, which names the deployment.
 */
export const SUBMISSION_FAILED = 'Submission failed. Please try again.';
export const SUBMISSION_LIMITED =
  "You've reached the limit for submissions for now. Try again in about an hour.";

export async function submitPublicContent(body) {
  let res;
  try {
    const base = requireFunctionsBase('public/submissions');
    res = await fetch(`${base}/public/submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    console.error('Public submission could not be sent:', error);
    throw new Error(SUBMISSION_FAILED);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 429) throw new Error(SUBMISSION_LIMITED);
    const fieldError = res.status === 400 && typeof data.error === 'string' ? data.error : '';
    throw new Error(fieldError || SUBMISSION_FAILED);
  }
  return data;
}

/**
 * GET public/podcasts — a provider's host-ingested episodes and the site's
 * own show, plus the feeds they were ingested from (#349).
 *
 * `feedUrl` is the provider's row in `admin_config/podcast_feeds` and
 * `mainFeedUrl` is the site's show in the same document — the one the ingest
 * timer reads — so the RSS subscribe button and the list it sits beside
 * cannot name two different feeds. Either is null until the owner seeds it.
 *
 * @returns {Promise<{items: object[], feedUrl: string|null, mainFeedUrl: string|null}>}
 */
export async function fetchPublicPodcastListing({ provider, limit } = {}) {
  const params = new URLSearchParams();
  if (provider) params.set('provider', provider);
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  const body = await publicGet(`public/podcasts${qs ? `?${qs}` : ''}`);
  return {
    items: body?.items || [],
    feedUrl: body?.feedUrl || null,
    mainFeedUrl: body?.mainFeedUrl || null,
  };
}

/** GET public/podcasts — episodes only. Kept for callers that never needed the feed. */
export async function fetchPublicPodcasts(options = {}) {
  return (await fetchPublicPodcastListing(options)).items;
}

/**
 * GET public/listen-and-learn/episodes — every approved Listen & Learn
 * episode with audio across a provider's certifications, newest first, for
 * the provider's podcast page (#349).
 *
 * The same `status === 'published'` gate as `fetchPublicListenAndLearn`,
 * applied server-side; rows are a listing projection (no transcript, no
 * videos) joined to their certification's title and slug.
 *
 * @param {{platform: string}} params
 * @returns {Promise<object[]>}
 */
export async function fetchPublicListenAndLearnEpisodes({ platform } = {}) {
  if (!platform) return [];
  const params = new URLSearchParams({ platform });
  const body = await publicGet(`public/listen-and-learn/episodes?${params}`);
  return body?.items || [];
}

/**
 * GET public/cert-events?platform= — the certification lifecycle events the
 * Friday Skills Hub scraper has recorded for a provider, newest first, for
 * the education timeline (#461 item 4; lib/certEvents.js merges them over
 * the static entries). Empty when nothing has been scraped for the provider.
 */
export async function fetchPublicCertEvents({ platform } = {}) {
  if (!platform) return [];
  const params = new URLSearchParams({ platform });
  const body = await publicGet(`public/cert-events?${params}`);
  return body?.items || [];
}

/**
 * GET public/feed — rss_cache documents for one provider, in a single round
 * trip (the old code ran two Firestore queries; the second, `ai_insights`,
 * fed a panel retired on 2026-09-05 — T-765).
 */
export async function fetchPublicFeed(provider) {
  const body = await publicGet(`public/feed?provider=${encodeURIComponent(provider)}`);
  return {
    rssCache: body?.rssCache || [],
  };
}

/**
 * GET public/curated-image/{articleId} — the cached hero image for a curated
 * news article, or null when none has been generated.
 *
 * Anonymous on purpose. The equivalent admin route is editor-gated, and the
 * news pages that need this are public, so calling that one made every
 * anonymous visitor's lookup throw at token acquisition and left the grid with
 * no imagery (T-210). The server returns only the URL — never the
 * document, which carries an internal blob path and prompt metadata.
 */
export async function fetchPublicCuratedImage(articleId) {
  if (!articleId) return null;
  const body = await publicGet(`public/curated-image/${encodeURIComponent(articleId)}`);
  return body?.imageUrl || null;
}

/**
 * Ids per batched curated-image request. Must not exceed the server's
 * `CURATED_IMAGE_BATCH_MAX`, which answers 400 above it.
 */
export const CURATED_IMAGE_BATCH_SIZE = 50;

/**
 * GET public/curated-images — covers for a whole grid in one round trip (T-739).
 *
 * The news grid issued one `public/curated-image/{id}` per card: twelve extra
 * round trips before any cover appeared, on a route that had already fetched
 * the feed.
 *
 * Returns a plain `{ id: url|null }` map covering every id asked for, so a
 * caller can tell "no cover" from "not asked about". A failed request resolves
 * to all-null rather than throwing: a missing cover is a degraded card, not a
 * broken page, which is the same contract `fetchPublicCuratedImage` has.
 *
 * @param {string[]} articleIds
 * @returns {Promise<Record<string, string|null>>}
 */
export async function fetchPublicCuratedImages(articleIds) {
  const ids = [...new Set((articleIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (ids.length === 0) return {};

  const result = Object.fromEntries(ids.map((id) => [id, null]));

  // Chunked so a longer grid cannot trip the server's cap. Sequential rather
  // than parallel: the point of this function is to stop hammering the API,
  // and a grid large enough to need two chunks is not latency-critical.
  for (let i = 0; i < ids.length; i += CURATED_IMAGE_BATCH_SIZE) {
    const chunk = ids.slice(i, i + CURATED_IMAGE_BATCH_SIZE);
    try {
      const body = await publicGet(
        `public/curated-images?ids=${chunk.map(encodeURIComponent).join(',')}`
      );
      for (const [id, url] of Object.entries(body?.images || {})) {
        if (id in result) result[id] = url || null;
      }
    } catch {
      // Leave this chunk null. Covers are decoration; the grid still renders.
    }
  }

  return result;
}

/**
 * GET public/listen-and-learn — the approved episodes of one certification.
 *
 * The server filters to `status === 'published'`, which is the whole review
 * gate: episodes are AI-written summaries of a paid exam's objectives,
 * generated as drafts and approved one at a time in the admin portal. There is
 * deliberately no way to ask this endpoint for anything else.
 *
 * Returns `null` for a certification that has never been generated, which the
 * page renders differently from a generated set with nothing approved yet —
 * that comes back with an empty `episodes` array.
 *
 * @param {{platform: string, examCode: string}} params
 * @returns {Promise<{set: object, episodes: object[]}|null>}
 */
export async function fetchPublicListenAndLearn({ platform, examCode } = {}) {
  if (!platform || !examCode) return null;
  const params = new URLSearchParams({ platform, examCode });
  const body = await publicGet(`public/listen-and-learn?${params}`);
  if (!body) return null;
  return { set: body.set || null, episodes: body.episodes || [] };
}
