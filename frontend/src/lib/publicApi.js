/**
 * Anonymous public API client — plain fetch against the Azure Functions
 * public endpoints (routes in functions/src/functions/public-reads.js).
 *
 * No auth and no MSAL on purpose: these are the reads the browser used to
 * make directly against Firestore under public security rules. The server
 * now owns the public filter (drafts and soft-deleted documents never appear
 * in responses) and strips internal review/audit fields, so consumers can
 * render what they receive without re-checking visibility.
 */
import { requireFunctionsBase } from '@/lib/functionsBase';

/**
 * Rows requested when a caller wants "the published corpus" (T-716).
 *
 * The three hooks that do this asked for 200, 250 and 150 — three DIFFERENT
 * urls for one intent, which defeats any sharing between them. One constant
 * means one url, so the dedupe below actually applies; 250 is the largest of
 * the previous values, so no caller loses rows.
 */
export const PUBLIC_CORPUS_LIMIT = 250;

/**
 * In-flight and recently-resolved GETs, keyed by full path+query (T-716).
 *
 * Three hooks — useBlogData, useProviderLandingContent and useFrameworkData —
 * each request the published corpus under its own `usePublicData` cache key,
 * and `usePublicData` holds state per hook instance, so identical requests were
 * never shared. Walking /aws -> /aws/blog -> /aws/frameworks downloaded the
 * whole corpus three times, bodies included.
 *
 * Deduplicating at the request layer fixes it for every caller at once and
 * changes no filtering semantics, which matters here: the client-side provider
 * matching includes text inference the server does not perform, so pushing the
 * filter server-side would silently drop posts (see T-738).
 *
 * The TTL is deliberately short. This is a read-through convenience for one
 * navigation session, not a cache with an invalidation story: published content
 * changes rarely, and 30 seconds is far below the window in which a visitor
 * would notice.
 */
const PUBLIC_GET_TTL_MS = 30_000;
const publicGetCache = new Map();

/** Exposed for tests; also the honest escape hatch if a caller needs freshness. */
export function clearPublicGetCache() {
  publicGetCache.clear();
}

/** One uncached GET: the JSON body, null for a 404, a thrown Error otherwise. */
async function fetchPublicJSON(pathAndQuery) {
  const base = requireFunctionsBase(pathAndQuery);
  const res = await fetch(`${base}/${pathAndQuery}`, {
    headers: { Accept: 'application/json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error || `Public API request failed with HTTP ${res.status}`);
  }
  return res.json();
}

async function publicGet(pathAndQuery) {
  const cached = publicGetCache.get(pathAndQuery);
  // A pending entry is reused regardless of age: two components mounting in the
  // same tick must share one request, which is the concurrent half of the bug.
  if (cached && (cached.pending || Date.now() - cached.at < PUBLIC_GET_TTL_MS)) {
    return cached.promise;
  }

  const promise = fetchPublicJSON(pathAndQuery);

  const entry = { promise, pending: true, at: Date.now() };
  publicGetCache.set(pathAndQuery, entry);
  try {
    const body = await promise;
    entry.pending = false;
    entry.at = Date.now();
    return body;
  } catch (err) {
    // A failure must not be cached: the next caller has to be able to retry.
    publicGetCache.delete(pathAndQuery);
    throw err;
  }
}

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
 * GET public/cloud-tools/pricing?region= — the cached price comparison for one
 * region (#613, Phase 1): `{ region, regions, refreshedAt, ttlMinutes,
 * ageMinutes, stale, counts, services }`, where each service carries one row
 * per provider that answered and a provider missing from `rows` is
 * "unavailable". Read by /tools/comparison and by the Integrations Hub's
 * "Cloud pricing cache" card.
 *
 * Throws on failure like `fetchPublicSnapshot`, so the page can show the
 * server's sentence — an unknown region is a 400 with one. A cache that has
 * never been filled is NOT a failure: the server answers 200 with
 * `refreshedAt: null` and no services, and the page renders that as its own
 * state. Returns null only when the route itself is missing (404).
 *
 * `fresh` is the same escape hatch `fetchPublicSnapshot` has, and it exists
 * for the same reason: the route answers with `Cache-Control: max-age=900`,
 * so after "Refresh now" the card would otherwise read the browser's copy
 * from before the refresh for up to fifteen minutes. The throwaway query
 * value defeats that cache and this module's; the route ignores it.
 *
 * @param {string} [region]
 * @param {{ fresh?: boolean }} [options]
 * @returns {Promise<object|null>}
 */
export async function fetchCloudPricing(region = 'us-east-1', { fresh = false } = {}) {
  const params = new URLSearchParams({ region: String(region || 'us-east-1') });
  if (fresh) params.set('fresh', String(Date.now()));
  const path = `public/cloud-tools/pricing?${params}`;
  const body = fresh ? await fetchPublicJSON(path) : await publicGet(path);
  if (!body) return null;
  if (!body.pricing || typeof body.pricing !== 'object') {
    throw new Error('Pricing response carried no pricing object');
  }
  return body.pricing;
}

/**
 * GET public/cloud-tools/price-changes?region= — what moved in the cached
 * prices of one region over the last week and month (#613, Phase 3):
 * `{ region, asOf, windows: { '7d': { since, sampleDay, items }, '30d': {…} },
 * sampleDays }`, each item `{ serviceId, label, provider, unit, sku, from,
 * to, deltaPct }` sorted by the size of the move. Until the daily refresh has
 * written more than one sample there is no history: the server answers 200
 * with `asOf: null` and empty windows, and the page renders that as its own
 * state. Returns null only when the route itself is missing (404); throws
 * with the server's sentence otherwise, as `fetchCloudPricing` does.
 *
 * @param {string} [region]
 * @returns {Promise<object|null>}
 */
export async function fetchPriceChanges(region = 'us-east-1') {
  const params = new URLSearchParams({ region: String(region || 'us-east-1') });
  const body = await publicGet(`public/cloud-tools/price-changes?${params}`);
  if (!body) return null;
  if (!body.changes || typeof body.changes !== 'object') {
    throw new Error('Price-changes response carried no changes object');
  }
  return body.changes;
}

/**
 * POST public/cloud-tools/explain — two paragraphs from the AI provider about
 * a scenario's numbers (#613, Phase 3). The body is the computed comparison
 * the page already shows: `{ region, scenarioId, scenarioLabel, extras,
 * egressGb, results: [{ provider, total, base, segments, unavailable }] }`;
 * the server caps it at 8 KB and answers `{ text, generatedAt, cached }`.
 *
 * Never cached here and never deduplicated: it is a POST the reader asked for
 * by pressing a button, and the server owns both the per-client quota (429,
 * five an hour) and the "paused" and "unavailable" states (503). The thrown
 * Error carries `status` and the response's `code`, and
 * pages/tools/explain/ExplainControl.jsx picks the visitor's sentence from
 * those; the server's own text is never shown.
 *
 * @param {object} body
 * @returns {Promise<{ text: string, generatedAt: string, cached: boolean }>}
 */
export async function requestPricingExplanation(body) {
  return postExplanation(body);
}

/**
 * POST public/cloud-tools/explain with `kind: "landing-zone"` — two
 * paragraphs about one component of a landing zone build (#670, Phase 4 of
 * #657). The body is what the server's `kinds/landingZone.js` validates:
 * `{ kind, componentId, selected, options, teaches }`, built by
 * pages/tools/landingZone/LzExplainButton.jsx from the page's own state and
 * catalogue text. Same route, same quota, same responses and the same error
 * mapping as `requestPricingExplanation`; the `kind` in the body is what
 * tells the two apart.
 *
 * @param {object} body
 * @returns {Promise<{ text: string, generatedAt: string, cached: boolean }>}
 */
export async function requestLandingZoneExplanation(body) {
  return postExplanation(body);
}

/** The one call both explanation kinds make; the body carries the kind. */
async function postExplanation(body) {
  const base = requireFunctionsBase('public/cloud-tools/explain');
  const res = await fetch(`${base}/public/cloud-tools/explain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `Explanation request failed with HTTP ${res.status}`);
    error.status = res.status;
    error.code = typeof data.code === 'string' ? data.code : null;
    throw error;
  }
  if (!data.explanation || typeof data.explanation.text !== 'string') {
    throw new Error('Explanation response carried no text');
  }
  return data.explanation;
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

/**
 * A labs status body has a boolean `configured` or it is not one. The two
 * routes below answer `{ configured: false }` when the thing they describe
 * has not been provisioned, so the flag is the one field a caller can rely
 * on; a body without it is a different route wearing the same path.
 */
function requireConfiguredFlag(body, what) {
  if (!body || typeof body !== 'object' || typeof body.configured !== 'boolean') {
    throw new Error(`${what} response carried no configured flag`);
  }
  return body;
}

/**
 * GET public/labs/estate — the live view of the Hybrid Lab host (#664):
 * `{ configured: false }` until the resource group exists, otherwise
 * `{ configured: true, arc: { status, statusSince, agentVersion, osName },
 * policy: { compliant, nonCompliant, notApplicable } | null,
 * agent: { online, queued, lastHeartbeatAt } | null,
 * coder: { reachable, running, max } | null, asOf }`. `statusSince` is when
 * Arc's status last changed, not a heartbeat; `agent.lastHeartbeatAt` is the
 * job runner's, null unless it is online (#1009). Read through the
 * Function App's managed identity and cached a minute server-side; the
 * browser never talks to Azure.
 *
 * Returns null only when the route itself is missing (404), which the card
 * renders as its own sentence rather than as "not provisioned" — the two are
 * different facts. Throws with the server's sentence otherwise, like
 * `fetchCloudPricing`.
 *
 * @returns {Promise<object|null>}
 */
export async function fetchLabsEstate() {
  const body = await publicGet('public/labs/estate');
  if (!body) return null;
  return requireConfiguredFlag(body, 'Labs estate');
}

/**
 * GET public/labs/coder-status — Coder's state through the server-side proxy
 * (#680): `{ configured: false }` without a `CODER_URL`, otherwise
 * `{ configured: true, reachable, templates: [{ name, activeVersion }],
 * capacity: { running, max }, asOf }`. `reachable: false` is a cached
 * failure and means the card must say "unreachable", not show numbers.
 *
 * Same null-on-404 and throw-otherwise contract as `fetchLabsEstate`.
 *
 * @returns {Promise<object|null>}
 */
export async function fetchCoderStatus() {
  const body = await publicGet('public/labs/coder-status');
  if (!body) return null;
  return requireConfiguredFlag(body, 'Coder status');
}

/**
 * GET public/addons/{id}/status — one AddOn's state through the server-side
 * proxy (ADR 0035 decision 4): `{ configured: false }` while its
 * `ADDON_<ID>_URL` setting is unset, otherwise `{ configured: true,
 * reachable, version, edition, capabilities, asOf }`. The pane at
 * `/tools/<id>` opens only on `configured` and `reachable` both true.
 *
 * Same null-on-404 and throw-otherwise contract as `fetchCoderStatus`; an
 * id the registry does not name answers 404, so it reads as null.
 *
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function fetchAddonStatus(id) {
  const body = await publicGet(`public/addons/${encodeURIComponent(id)}/status`);
  if (!body) return null;
  return requireConfiguredFlag(body, 'Add-on status');
}

/**
 * GET public/labs/submit — whether the lab would take a public job now
 * (#672): `{ configured, open, code, reason, bounds }`. `open` is false while
 * public submission is switched off (`code: 'PUBLIC_SUBMISSION_CLOSED'`),
 * while no lab agent is online, while the queue is full, and when the server
 * could not tell; the Validate on the lab button maps `code` to its own line
 * (labValidateRules.js) and never shows `reason`. Through the same short-lived GET cache
 * as the other public reads, so a page that mounts twice asks once.
 *
 * Returns null only when the route itself is missing (404); throws when the
 * body carries no boolean `open`, so a caller can never read "open" out of
 * a response that did not say it.
 *
 * @returns {Promise<{ configured: boolean, open: boolean, code: string|null, reason: string|null, bounds?: object }|null>}
 */
export async function fetchLabSubmissionStatus() {
  const body = await publicGet('public/labs/submit');
  if (!body) return null;
  const checked = requireConfiguredFlag(body, 'Lab submission status');
  if (typeof checked.open !== 'boolean') {
    throw new Error('Lab submission status response carried no open flag');
  }
  return checked;
}

/**
 * A failed lab call as an Error carrying the server's status and code; the page words it from the code.
 * The message is the server's `error`, or its `reason` (the visitor session routes answer a
 * refusal with a sentence for the visitor in `reason`, #1464), and only then the HTTP status.
 */
async function labError(res, what) {
  const data = await res.json().catch(() => ({}));
  const sentence = [data.error, data.reason].find(
    (value) => typeof value === 'string' && value.trim()
  );
  const error = new Error(sentence || `${what} failed with HTTP ${res.status}`);
  error.status = res.status;
  error.code = typeof data.code === 'string' ? data.code : null;
  return error;
}

/**
 * POST public/labs/submit — queue one `terraform-validate` job on the lab
 * (#672). The body is `{ type: 'terraform-validate', payload, payloadEncoding
 * }`, built by lib/landingZone/labPayload.js from the builder's own files;
 * the server caps the payload at 64 KB and owns every other bound (two an
 * hour per visitor, fifty a day, the queue ceiling, the switch). Resolves to
 * `{ jobId, type, status }`; throws with `status` and `code` so the button
 * can say which bound refused it. Never cached and never retried here.
 *
 * @param {{ type: string, payload: string, payloadEncoding: string }} body
 * @returns {Promise<{ ok: true, jobId: string, type: string, status: string }>}
 */
export async function submitLabValidation(body) {
  const base = requireFunctionsBase('public/labs/submit');
  const res = await fetch(`${base}/public/labs/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await labError(res, 'Lab submission');
  const data = await res.json();
  if (typeof data.jobId !== 'string' || !data.jobId) {
    throw new Error('Lab submission response carried no job id');
  }
  return data;
}

/**
 * GET public/labs/job?jobId= — one public job's status and visitor report
 * (#672): `{ id, type, status, exitCode, report, createdAt, claimedAt,
 * finishedAt }`, `report` null until the job ends (never the job's raw
 * output; labValidateRules.js `visitorReport` reads it).
 * Uncached, because the point of the call is to see the status move. A job
 * the server does not know, or no longer keeps (a day after it finished), is
 * a 404 and throws like any other refusal.
 *
 * @param {string} jobId
 * @returns {Promise<object>}
 */
export async function fetchPublicLabJob(jobId) {
  const path = `public/labs/job?${new URLSearchParams({ jobId })}`;
  const base = requireFunctionsBase(path);
  const res = await fetch(`${base}/${path}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw await labError(res, 'Lab job read');
  const data = await res.json();
  if (!data.job || typeof data.job.status !== 'string') {
    throw new Error('Lab job response carried no job');
  }
  return data.job;
}

/**
 * GET public/labs/visitor-session — check if visitor lab sessions are configured/open,
 * active session for this client, and bounds (#1016).
 *
 * @returns {Promise<{ configured: boolean, open: boolean, code: string, reason: string, session?: object|null, bounds?: object }|null>}
 */
export async function fetchVisitorSessionStatus() {
  const base = requireFunctionsBase('public/labs/visitor-session');
  const res = await fetch(`${base}/public/labs/visitor-session`, {
    headers: { Accept: 'application/json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw await labError(res, 'Visitor session status');
  const data = await res.json();
  return requireConfiguredFlag(data, 'Visitor session status');
}

/**
 * POST public/labs/visitor-session — request an ephemeral visitor lab session (#1016).
 * A refusal throws with `status`, `code` and the server's sentence as the message: 409
 * `VISITOR_START_IN_PROGRESS` (a start of this visitor is still being set up, so wait and read
 * the status again), 429 `TURNSTILE_RATE_LIMITED` or `VISITOR_RATE_LIMITED`, 503
 * `LAB_CAPACITY_REACHED`, and so on.
 *
 * @param {{ labId: string, turnstileToken: string }} body
 * @returns {Promise<{ ok: true, sessionId: string, labId: string, accessUrl: string, expiresAt: string }>}
 */
export async function startVisitorSession(body) {
  const base = requireFunctionsBase('public/labs/visitor-session');
  const res = await fetch(`${base}/public/labs/visitor-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await labError(res, 'Start visitor session');
  const data = await res.json();
  if (typeof data.sessionId !== 'string' || !data.sessionId) {
    throw new Error('Visitor session response carried no session id');
  }
  return data;
}

/**
 * DELETE public/labs/visitor-session?sessionId=... — stop/terminate a visitor lab session (#1016).
 * The answer is `{ ok, status: 'ended', cleanup }`: `cleanup` says whether the lab is gone
 * (`done`), will be removed by a later try (`pending`), or needs a person (`failed`). The visitor
 * is done with the session in every case (#1403, item 7).
 *
 * @param {string} sessionId
 * @returns {Promise<{ ok: boolean, status: string, cleanup?: 'done' | 'pending' | 'failed' }>}
 */
export async function stopVisitorSession(sessionId) {
  const path = `public/labs/visitor-session?${new URLSearchParams({ sessionId })}`;
  const base = requireFunctionsBase(path);
  const res = await fetch(`${base}/${path}`, {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw await labError(res, 'Stop visitor session');
  return res.json();
}
