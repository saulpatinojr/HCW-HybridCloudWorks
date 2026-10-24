/**
 * One reading of the Linkie API, shared by the Linkie Hub page.
 *
 * ===========================================================================
 * WHY THIS MODULE EXISTS
 * ===========================================================================
 * The Linkie Hub's Links and Analytics tabs called four endpoints that do not
 * exist: `/links`, `/links/:id` and `/analytics`. Neither tab could ever have
 * worked. The only reason they failed loudly rather than silently is the
 * allowlist on `linkieProxy` (functions/src/functions/integrations-http.js),
 * which answered `/links is not an allowed Linkie endpoint`.
 *
 * The allowlist was right. Linkie has no top-level link or analytics
 * resource — links are page-scoped POSTS and analytics is traffic-stats:
 *
 *   GET    /pages                                     the pages this key owns
 *   GET    /pages/:pageId/posts                       the links on one page
 *   POST   /pages/:pageId/posts                       body is an ARRAY of posts
 *   PATCH  /pages/:pageId/posts/:postId               `url` is the only field
 *   DELETE /pages/:pageId/posts/:postId
 *   GET    /analytics/traffic-stats?page_id=…
 *
 * LINKIE RENAMED PROFILES TO PAGES IN OCTOBER 2026. Until then these were
 * `/profiles`, `/profiles/:profileId/posts` and `?link_in_bio_id=`, and the
 * key scopes were `profiles:read` and `profiles:write` (now `pages:read` and
 * `pages:write`; a key with only the old scopes answers 403 "Insufficient
 * scope" and has to be created again). The list answers `data.pages`, and a
 * page's picture is `avatar_url`, not `profile_image_url` (nothing here reads
 * either). Source, read 2026-10-23: https://linkie.bio/docs/api-reference/pages
 * and its posts and analytics pages. This module still says "profile" in its
 * function and variable names, as it always has: a profile here is what Linkie
 * now calls a page.
 *
 * The set above was first taken from Site-Main — the system this repository
 * was migrated from, which had been calling this API in production since
 * before the migration — and sent from `src/pages/admin/LinkiePage.jsx`
 * through `functions/cms/proxies.js`. The same source is what commit 21d1424c
 * took this repository's base URL and allowlist from, after an earlier version
 * guessed `https://api.linkie.bio` from an env-var name and was wrong.
 *
 * ===========================================================================
 * THE ENVELOPE, WHICH IS NOT SITE-MAIN'S
 * ===========================================================================
 * Site-Main's proxy returns the upstream body directly. THIS repository's
 * proxy wraps it: `{ ok, status, data }`, at HTTP 200 for every outcome
 * (functions/src/lib/integrations/rest-proxy.js). So a reader ported straight
 * across is one level short, and — worse — a Linkie 401 arrives as a RESOLVED
 * promise that a `.catch()` never sees. That is #397 exactly, one integration
 * over: the Social Hub rendered a Publer authentication failure as an empty
 * workspace because it tested the envelope with `Array.isArray`.
 *
 * `unwrapLinkie` is the one place that reads the envelope, and
 * `readLinkieBody` is what a write path calls so a refused key raises instead
 * of passing for success.
 *
 * Since #430, both of those functions are thin wrappers: their implementation
 * moved to `lib/integrationEnvelope.js`. Klaviyo was the third integration
 * caught by this envelope, so the reading was promoted into a shared module
 * rather than written a third time. The names here stay, because they are what
 * this module's callers and tests already use, and because
 * `describeLinkieFailure` has to name Linkie in the sentence an operator
 * reads.
 */
import {
  INTEGRATION_NOT_CONFIGURED,
  describeProxyFailure,
  readProxyBody,
  unwrapProxy,
} from '@/lib/integrationEnvelope';

/** The proxy's code for "a required app setting is missing, so Linkie was never called". */
export const LINKIE_NOT_CONFIGURED = INTEGRATION_NOT_CONFIGURED;

/**
 * Linkie's post `provider` enum, carried over from Site-Main's LinkiePage,
 * which cites linkie.bio/docs/api-reference/posts. There is no generic
 * "blog"/"website" member, so `wordpress` is the closest fit for our own
 * published articles — Site-Main reached the same conclusion and has been
 * pushing content under it.
 */
export const LINKIE_PROVIDERS = Object.freeze([
  'wordpress',
  'facebook',
  'instagram',
  'twitter',
  'linkedin',
  'pinterest',
  'youtube',
  'tiktok',
  'google',
  'telegram',
  'mastodon',
  'threads',
  'bluesky',
]);

/** Linkie's `post_type` enum, from the same source. */
export const LINKIE_POST_TYPES = Object.freeze([
  'article',
  'link',
  'text',
  'photo',
  'gif',
  'video',
  'carousel',
  'poll',
]);

/** Post types whose whole content IS the caption, so an empty one is meaningless. */
export const TEXT_REQUIRED_POST_TYPES = Object.freeze(['text', 'poll']);

/**
 * The key a post's image lives under, on the way in and on the way out.
 *
 * `thumbnail_url`, confirmed 2026-09-15 (#501) from a real Linkie post
 * response the owner supplied: `data.thumbnail_url` holds the post image as
 * an https CDN URL beside `url`, `provider`, `account_name`, `text` and
 * `post_type` — the same snake_case keys `buildPostPayload` already sends. The
 * earlier `thumbnail` was a guess made while Linkie's docs were unreadable.
 *
 * It is only sent when an image was actually chosen — see `buildPostPayload`.
 */
export const LINKIE_POST_IMAGE_FIELD = 'thumbnail_url';

/** What a post pushed from our own CMS is attributed to. */
export const DEFAULT_ACCOUNT_NAME = 'HybridCloudWorks';
export const CONTENT_PUSH_PROVIDER = 'wordpress';
export const CONTENT_PUSH_POST_TYPE = 'article';

/** The blank Add-a-Post form. */
export const EMPTY_POST_FORM = Object.freeze({
  url: '',
  provider: LINKIE_PROVIDERS[0],
  accountName: DEFAULT_ACCOUNT_NAME,
  postType: CONTENT_PUSH_POST_TYPE,
  text: '',
  imageUrl: '',
});

/**
 * The exact paths the page sends, in the shape `linkieProxy`'s allowlist
 * matches. Every id is encoded: the proxy's `assertSafePath` rejects `..`,
 * backslashes and control characters, and the allowlist patterns are
 * `[^/]+`, so a stray separator has to fail here rather than widen the match.
 *
 * @type {Readonly<Record<string, (...args: string[]) => string>>}
 */
export const linkiePaths = Object.freeze({
  pages: () => '/pages',
  posts: (pageId) => `/pages/${encodeURIComponent(pageId)}/posts`,
  post: (pageId, postId) =>
    `/pages/${encodeURIComponent(pageId)}/posts/${encodeURIComponent(postId)}`,
  // The allowlist is checked against the path WITHOUT its query string, so the
  // parameter is free — but it is required by Linkie, and omitting it is how
  // this endpoint returns nothing useful rather than an error.
  trafficStats: (pageId) => `/analytics/traffic-stats?page_id=${encodeURIComponent(pageId)}`,
});

/**
 * Read the linkieProxy envelope (functions/src/lib/integrations/rest-proxy.js).
 *
 * THE PROXY ANSWERS 200 FOR EVERY OUTCOME, so the HTTP status of the call the
 * browser made says nothing and `ok` is the only signal. Four envelopes, kept
 * distinct on purpose:
 *
 *   `{ ok: true, status, data }`      Linkie answered 2xx; `data` is its body.
 *   `{ ok: false, code:
 *      'INTEGRATION_NOT_CONFIGURED',
 *      error }`                       LINKIE_API_KEY is unset, so Linkie was
 *                                     never called. Not a fault — the
 *                                     Connections page renders it as
 *                                     "not connected".
 *   `{ ok: false, status, data }`     Linkie answered non-2xx — 401 on a bad
 *                                     key, 403, 429, 5xx. `status` is
 *                                     Linkie's, not ours.
 *   `{ ok: false, error }`            the proxy's own fetch threw.
 *
 * A bare body is accepted too, so a caller that already unwrapped is not
 * punished.
 *
 * @param {unknown} response - whatever `postJSON('linkieProxy', …)` resolved to
 * @returns {{ body: unknown, notConfigured: boolean, failed: boolean,
 *             status: number | null, reason: string }}
 */
export const unwrapLinkie = unwrapProxy;

/**
 * The failure in one line. Prefers the upstream status, because "Linkie
 * answered 401" is the sentence that tells an operator their key is wrong.
 *
 * @param {{ status?: number | null, reason?: string }} failure
 * @returns {string}
 */
export function describeLinkieFailure(failure = {}) {
  return describeProxyFailure('Linkie', failure);
}

/**
 * The body, or a throw — for the write paths, where "not ok" must not pass for
 * success. Creating, editing and deleting a post all resolve through the proxy
 * whatever Linkie says, so without this a 401 shows a green "Added to Linkie"
 * toast and the list quietly reloads unchanged.
 *
 * @param {unknown} response
 * @returns {unknown} the upstream body
 * @throws {Error} when the integration is unconfigured or the call failed
 */
export function readLinkieBody(response) {
  return readProxyBody('Linkie', response);
}

/**
 * The pages this API key owns (Linkie's own word since October 2026; this
 * module's functions still call them profiles).
 *
 * Linkie nests them as `{ data: { pages: [...] } }`, so through this
 * repository's envelope the full path is `response.data.data.pages`. The other
 * depths are tolerated so a caller that already unwrapped, or a Linkie release
 * that flattens the wrapper, still reads. The old `profiles` key is not read:
 * the old endpoint is not called any more, and a body that still carries it
 * would be an answer from the wrong endpoint, which should read as empty and
 * say so, not as a list.
 *
 * `_id` is the only field this module depends on; it is what every
 * page-scoped path is built from.
 *
 * @param {unknown} response
 * @returns {Array<{ _id: string }>}
 */
export function extractProfiles(response) {
  const { body } = unwrapLinkie(response);
  const list = [body?.data?.pages, body?.pages, body?.data, body].find(Array.isArray) ?? [];
  return list.filter((profile) => profile && typeof profile === 'object' && profile._id);
}

/**
 * Which profile the page acts on.
 *
 * `/profiles` is plural and every posts path is profile-scoped, so this has to
 * be an answer rather than an assumption. Site-Main takes `[0]` unconditionally
 * — fine for a single-profile account, wrong the moment there are two, because
 * the operator gets whichever Linkie happened to list first with no way to say
 * otherwise. So: honour an explicit choice when one is given (the page keeps it
 * in the URL, and shows a picker whenever more than one profile came back),
 * fall back to the first, and return null rather than a partial object when
 * there is nothing to pick.
 *
 * @param {Array<{ _id: string }>} profiles
 * @param {string} [preferredId] - the operator's choice, if they made one
 * @returns {{ _id: string } | null}
 */
export function selectProfile(profiles, preferredId) {
  const list = Array.isArray(profiles)
    ? profiles.filter((profile) => profile && typeof profile === 'object' && profile._id)
    : [];
  if (list.length === 0) return null;
  if (preferredId) {
    const chosen = list.find((profile) => String(profile._id) === String(preferredId));
    if (chosen) return chosen;
  }
  return list[0];
}

/**
 * A profile's name for the picker.
 *
 * Only `_id` is proven — it is the one field Site-Main reads. The friendlier
 * names are tolerated, not relied on: if none is present the id is shown,
 * which is still enough to tell two profiles apart.
 *
 * @param {{ _id?: string, username?: string, name?: string, title?: string, slug?: string }} profile
 * @returns {string}
 */
export function profileLabel(profile) {
  if (!profile) return '';
  const named = [profile.username, profile.name, profile.title, profile.slug].find(
    (value) => typeof value === 'string' && value.trim()
  );
  return named ? named.trim() : String(profile._id ?? '');
}

/**
 * The posts on a profile — Linkie's links.
 *
 * Site-Main reads a bare array or `{ data: [...] }` off the raw body, so
 * through this repository's envelope the array sits at `response.data.data`.
 *
 * @param {unknown} response
 * @returns {Array<object>}
 */
export function extractPosts(response) {
  const { body } = unwrapLinkie(response);
  const list = [body, body?.data, body?.posts].find(Array.isArray) ?? [];
  return list.filter((post) => post && typeof post === 'object');
}

/**
 * One post, in the shape Linkie accepts.
 *
 * Note what is NOT here: the old form collected a **Title** and a **URL**, and
 * a Linkie post has no title. Its nearest field is `text`, the caption — so
 * that is where a title goes, and calling it Title in the UI was part of what
 * made a non-existent endpoint look plausible. `text` is omitted entirely when
 * blank rather than sent empty.
 *
 * `imageUrl`, when set, is sent under `LINKIE_POST_IMAGE_FIELD`
 * (`thumbnail_url`).
 *
 * @param {{ url?: string, provider?: string, accountName?: string,
 *           postType?: string, text?: string, imageUrl?: string }} fields
 * @returns {{ url: string, provider: string, account_name: string,
 *             post_type: string, text?: string } & Record<string, string>}
 *   plus, only when an image was chosen, `thumbnail_url`.
 */
export function buildPostPayload({ url, provider, accountName, postType, text, imageUrl } = {}) {
  const payload = {
    url: String(url ?? '').trim(),
    provider: String(provider ?? '').trim(),
    account_name: String(accountName ?? '').trim(),
    post_type: String(postType ?? '').trim(),
  };
  const caption = String(text ?? '').trim();
  if (caption) payload.text = caption;
  // Absent, not empty, when there is no image — so a post without one is
  // byte-identical to what was sent before #501, and Linkie keeps deriving
  // its own thumbnail for it.
  const image = String(imageUrl ?? '').trim();
  if (image) payload[LINKIE_POST_IMAGE_FIELD] = image;
  return payload;
}

/**
 * `POST /profiles/:id/posts` takes an ARRAY, not a single post — Site-Main's
 * wrapper is `ltCreatePosts(profileId, posts)` and is called with one-element
 * arrays. Sending the bare object is the kind of mistake that returns 400 with
 * a message about the wrong field, so the array lives here rather than at each
 * call site.
 *
 * @param {object} post
 * @returns {Array<object>}
 */
export function createPostsBody(post) {
  return [post];
}

/**
 * The Push Published Content mapping: one of our own published pages as a
 * Linkie post. The article's title becomes the caption, for the reason above.
 *
 * The cover image, when the item has a public one, rides along as `imageUrl`.
 *
 * @param {{ title?: string, url?: string, imageUrl?: string }} item
 * @returns {{ url: string, provider: string, account_name: string,
 *             post_type: string, text?: string } & Record<string, string>}
 *   plus, only when an image was chosen, `thumbnail_url`.
 */
export function contentItemPostPayload({ title, url, imageUrl } = {}) {
  return buildPostPayload({
    url,
    provider: CONTENT_PUSH_PROVIDER,
    accountName: DEFAULT_ACCOUNT_NAME,
    postType: CONTENT_PUSH_POST_TYPE,
    text: title,
    imageUrl,
  });
}

const isHttpsUrl = (value) => typeof value === 'string' && /^https:\/\/\S+$/i.test(value.trim());

/**
 * A post's image URL from `thumbnail_url`, or '' when it has none.
 *
 * Non-https values are rejected rather than rendered: an `http:` thumbnail is
 * mixed content on an https admin page, and a `javascript:` or `data:` value
 * has no business in an `<img src>` built from a third party's response.
 *
 * @param {unknown} post
 * @returns {string}
 */
export function extractPostImage(post) {
  if (!post || typeof post !== 'object') return '';
  const value = post[LINKIE_POST_IMAGE_FIELD];
  return isHttpsUrl(value) ? value.trim() : '';
}

/** The public container a Linkie post image is uploaded to. */
export const LINKIE_IMAGE_CONTAINER = 'covers';

/**
 * Where an uploaded Linkie post image is stored inside `covers`.
 *
 * `covers`, not `content` (which the Image Gallery uploads to): `content` is
 * PRIVATE — the upload route returns an empty `url` for it — and Linkie's
 * servers have to fetch this image anonymously. `covers` is in both
 * `UPLOAD_CONTAINERS` and `PUBLIC_MEDIA_CONTAINERS` (functions/src/lib/
 * blob-paths.js). Timestamped and randomised because the route refuses to
 * overwrite an existing blob.
 *
 * @param {string} extension - from `PUBLIC_IMAGE_EXTENSIONS`, never the filename
 * @param {{ now?: number, random?: string }} [seed] - injectable for tests
 * @returns {string}
 */
export function linkieImagePath(extension, { now = Date.now(), random } = {}) {
  const id = random ?? Math.random().toString(36).slice(2, 10);
  return `linkie/${now}-${id}.${extension}`;
}

/**
 * An image URL in the only form Linkie can use: absolute and https.
 *
 * Stored and uploaded images are usually SITE-RELATIVE
 * (`/api/public/media/covers/…`, from `mediaUrlFor`). `resolveMediaUrl` makes
 * that absolute when the Functions base is cross-origin — production's is
 * `https://api-azure.hybridcloudworks.com/api` — and leaves it relative when
 * the base is `/api`, in which case the page's own origin serves it. Anything
 * that still is not https (an empty private-container URL, an http origin in
 * local dev) returns '' so the caller can say so instead of sending Linkie a
 * URL it cannot fetch.
 *
 * @param {string} url
 * @param {{ resolve: (url: string) => string, origin?: string }} deps
 * @returns {string}
 */
export function toPublicImageUrl(url, { resolve, origin = '' }) {
  let value = resolve(String(url ?? '').trim());
  if (value.startsWith('/') && !value.startsWith('//') && origin) {
    value = `${origin.replace(/\/+$/, '')}${value}`;
  }
  return isHttpsUrl(value) ? value : '';
}

/**
 * Why the Add-a-Post form cannot be submitted yet, or '' when it can.
 *
 * @param {{ url?: string, accountName?: string, postType?: string, text?: string }} form
 * @returns {string}
 */
export function validatePostForm(form) {
  if (!String(form?.url ?? '').trim()) return 'A URL is required';
  if (!String(form?.accountName ?? '').trim()) return 'An account name is required';
  if (TEXT_REQUIRED_POST_TYPES.includes(form?.postType) && !String(form?.text ?? '').trim()) {
    return 'Text is required for this post type';
  }
  return '';
}

/**
 * The traffic-stats summary object.
 *
 * @param {unknown} response
 * @returns {object}
 */
export function extractTrafficStats(response) {
  const { body } = unwrapLinkie(response);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  const inner = body.data;
  return inner && typeof inner === 'object' && !Array.isArray(inner) ? inner : body;
}

/**
 * The cards the Analytics tab shows, from the field names Site-Main reads off
 * this endpoint. A metric Linkie did not return is dropped rather than shown
 * as a blank or a zero it never claimed — an absent `unique_clicks` and a
 * genuine zero are different facts.
 *
 * @param {object} summary
 * @returns {Array<{ label: string, value: string | number }>}
 */
export function trafficStatCards(summary) {
  const stats = summary && typeof summary === 'object' ? summary : {};
  const bounce = stats.bounce_rate;
  return [
    { label: 'Total Visitors', value: stats.total_visitors },
    { label: 'Unique Visitors', value: stats.unique_visitors },
    { label: 'Unique Clicks', value: stats.unique_clicks },
    {
      label: 'Bounce Rate',
      value: bounce === null || bounce === undefined ? undefined : `${bounce}%`,
    },
    { label: 'Subscribers', value: stats.total_subscribers },
  ].filter((card) => card.value !== undefined && card.value !== null);
}

/**
 * What the Links tab may show, given the profile and the in-flight state.
 *
 * NO PROFILE MEANS NO POSTS, not "the last profile's posts". `loading` is
 * false when there is no `profileId` — there is nothing in flight to wait for
 * — so a naive `loading ? [] : result.posts` lets the previously resolved
 * profile's list survive the profile going away. The tab then shows rows for
 * a profile it no longer has, while every write is gated, which is worse than
 * showing nothing: it implies the data is current and the buttons are broken.
 *
 * The Analytics tab expresses the same rule as an early return when
 * `profileId` is null. This is that rule, for a tab that has rows to suppress
 * rather than a whole panel. Caught in review on PR #429.
 *
 * @param {{ profileId: string|null, loading: boolean, result: { posts?: object[], error?: string } }} args
 */
export function visibleLinksState({ profileId, loading, result }) {
  if (!profileId || loading) return { posts: [], error: '' };
  return { posts: result?.posts || [], error: result?.error || '' };
}
