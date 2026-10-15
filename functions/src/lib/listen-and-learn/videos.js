/**
 * Discover the best YouTube videos for one skill area of a certification.
 *
 * These are surfaced on the site as curated "watch next" links beside each
 * Listen & Learn episode. They deliberately do NOT ground the episode audio:
 * a single outdated video demonstrating a retired portal flow would poison an
 * episode that reads as authoritative. Episodes are grounded on the official
 * study guide; videos are a companion, chosen and ranked, never trusted.
 *
 * Uses the YouTube Data API v3 with a `YOUTUBE_API_KEY` app setting. The key
 * is optional: without it `findVideosForAreas` records a per-area reason and
 * the episode still generates, because the audio is the feature and the
 * videos are the garnish (see generate.js).
 *
 * Quota: search.list costs 100 units and videos.list costs 1, so one
 * certification (~5 areas) costs ~505 of the default 10,000 units/day —
 * roughly 19 certifications per day. `estimateQuotaCost` makes that explicit
 * to callers so a bulk run can refuse rather than silently truncate.
 *
 * Ported from Site-Main `functions/listen-and-learn/videos.js` (088f458). The
 * ranking and quota model are unchanged; the module is ESM and the key arrives
 * as a parameter rather than a Firebase secret binding.
 */
import { AuthoredError, codeShaped, errorCode, storedFailure } from '../http/error-response.js';

const SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';
const VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos';

const SEARCH_UNITS = 100;
const VIDEOS_UNITS = 1;

/** Shorts and clip-farm uploads teach nothing; 3h+ is a full course, not a topic. */
export const MIN_DURATION_SECONDS = 180;
const MAX_DURATION_SECONDS = 3 * 60 * 60;

/** Below this, a video has had no scrutiny from anyone. */
export const MIN_VIEWS = 500;

/**
 * A video search that failed, in this module's sentence: the HTTP status and
 * the API's reason code, never the API's own message or a socket's (#945),
 * so the job result and the episode can store it as written.
 */
export class VideoSearchError extends AuthoredError {
  /**
   * @param {string} message - the sentence, written here
   * @param {{ status?: number|null }} [options]
   */
  constructor(message, { status = null } = {}) {
    super(message);
    this.status = status;
  }
}

/** ISO-8601 `PT1H2M10S` → seconds. Returns 0 for unparseable input. */
export function parseIsoDuration(iso) {
  const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(iso || ''));
  if (!match) return 0;
  const [, d, h, m, s] = match.map((v) => (v === undefined ? 0 : Number(v)));
  return d * 86400 + h * 3600 + m * 60 + s;
}

export function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${mm}:${String(s).padStart(2, '0')}`;
}

/**
 * Rank a candidate 0..1.
 *
 * Views are logarithmic — a 2M-view video is better than a 2k one, but not a
 * thousand times better, and raw view counts would otherwise let one popular
 * general video beat every focused tutorial. Engagement (likes per view)
 * separates videos people finished from videos people clicked. Recency matters
 * for cloud content specifically: portal UIs and service names churn, so a
 * two-year-old walkthrough is often actively wrong.
 */
export function scoreVideo(video, { nowMs }) {
  const views = Math.max(0, Number(video.viewCount) || 0);
  const likes = Math.max(0, Number(video.likeCount) || 0);

  const popularity = Math.min(1, Math.log10(views + 1) / 6); // 1M views ≈ 1.0
  const engagement = views > 0 ? Math.min(1, likes / views / 0.04) : 0; // 4% ≈ 1.0

  const ageDays = Math.max(0, (nowMs - new Date(video.publishedAt).getTime()) / 86400000);
  const recency = Math.max(0, 1 - ageDays / 1095); // linear decay over 3 years

  return Number((popularity * 0.4 + engagement * 0.25 + recency * 0.35).toFixed(4));
}

/** videos.list item → the flat shape the site and the ranker both consume. */
function toCandidate(item) {
  // Destructured once up front: repeating `item?.snippet?.x` for every field
  // adds a branch per access and pushes this past the complexity budget.
  const snippet = item?.snippet || {};
  const stats = item?.statistics || {};
  const durationSeconds = parseIsoDuration(item?.contentDetails?.duration);

  return {
    videoId: item.id,
    url: `https://www.youtube.com/watch?v=${item.id}`,
    title: snippet.title || '',
    channel: snippet.channelTitle || '',
    publishedAt: snippet.publishedAt || null,
    thumbnail: snippet.thumbnails?.medium?.url || null,
    viewCount: Number(stats.viewCount) || 0,
    likeCount: Number(stats.likeCount) || 0,
    durationSeconds,
    duration: formatDuration(durationSeconds),
  };
}

/**
 * One GET against the Data API: the parsed body, or a VideoSearchError whose
 * sentence names the status and the API's reason code, or the socket's code.
 * The API's message and the socket's text stay out of it (#945).
 *
 * @param {string} url - the endpoint
 * @param {Record<string, string>} params - the query
 * @param {{ fetchImpl: Function }} deps
 * @returns {Promise<object>}
 */
async function youtubeGet(url, params, { fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(`${url}?${new URLSearchParams(params)}`);
  } catch (err) {
    throw new VideoSearchError(`Failed to reach the YouTube Data API (${errorCode(err)}).`);
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = body?.error?.errors?.[0]?.reason;
    // quotaExceeded is the one worth naming explicitly — it is the failure a
    // bulk regeneration will actually hit, and it is not a bug to chase.
    const detail = reason === 'quotaExceeded' ? ' (daily quota exhausted)' : '';
    const reasonCode = codeShaped(reason);
    const code = reasonCode ? `: ${reasonCode}` : '';
    throw new VideoSearchError(`YouTube Data API HTTP ${response.status}${detail}${code}`, {
      status: response.status,
    });
  }
  return body;
}

/**
 * Search for videos covering `query`, then enrich with statistics so the
 * ranking has something real to work with (search.list alone returns no view
 * or like counts).
 */
export async function searchVideos(
  query,
  {
    apiKey,
    maxResults = 8,
    keep = 4,
    publishedWithinMonths = 30,
    nowMs = Date.now(),
    fetchImpl = fetch,
  } = {}
) {
  if (!apiKey) throw new VideoSearchError('YOUTUBE_API_KEY is not configured');
  if (!String(query || '').trim()) throw new VideoSearchError('query is required');

  const publishedAfter = new Date(nowMs - publishedWithinMonths * 30 * 86400000).toISOString();

  const search = await youtubeGet(
    SEARCH_URL,
    {
      key: apiKey,
      part: 'snippet',
      type: 'video',
      q: query,
      maxResults: String(maxResults),
      order: 'relevance',
      relevanceLanguage: 'en',
      // Duration is filtered below on the real value from contentDetails;
      // `any` here keeps a good 25-minute walkthrough from being excluded by
      // YouTube's own coarse buckets before it can be scored.
      videoDuration: 'any',
      videoEmbeddable: 'true',
      safeSearch: 'strict',
      publishedAfter,
    },
    { fetchImpl }
  );

  const ids = (search.items || []).map((item) => item?.id?.videoId).filter(Boolean);
  if (ids.length === 0) return [];

  const details = await youtubeGet(
    VIDEOS_URL,
    { key: apiKey, part: 'snippet,statistics,contentDetails', id: ids.join(',') },
    { fetchImpl }
  );

  const candidates = (details.items || [])
    .map(toCandidate)
    .filter(
      (v) =>
        v.publishedAt &&
        v.viewCount >= MIN_VIEWS &&
        v.durationSeconds >= MIN_DURATION_SECONDS &&
        v.durationSeconds <= MAX_DURATION_SECONDS
    )
    .map((v) => ({ ...v, score: scoreVideo(v, { nowMs }) }))
    .sort((a, b) => b.score - a.score);

  return candidates.slice(0, keep);
}

/**
 * One ranked video list per skill area.
 *
 * Videos are deduped across areas: the same "full AZ-104 course" ranks well
 * for every area, and repeating it five times would make the whole feature
 * look broken. First area to claim a video keeps it.
 */
export async function findVideosForAreas(
  areas,
  { examCode, apiKey, perArea = 3, ...options } = {}
) {
  const claimed = new Set();
  const results = [];

  for (const area of areas) {
    const query = `${examCode} ${area.subheadings[0] || area.name}`.trim();
    let videos = [];
    let failure = null;

    try {
      const found = await searchVideos(query, { apiKey, keep: perArea + 4, ...options });
      videos = found.filter((v) => !claimed.has(v.videoId)).slice(0, perArea);
      videos.forEach((v) => claimed.add(v.videoId));
    } catch (err) {
      // One area failing (or the quota running out mid-run) must not discard
      // the areas that already succeeded; the caller decides what to publish.
      // The job result stores the search's own sentence (#945).
      failure = storedFailure(err, 'The video search failed.');
    }

    results.push({ areaSlug: area.slug, query, videos, error: failure });
  }

  return results;
}

/** Quota units a `findVideosForAreas` run will consume, for pre-flight checks. */
export function estimateQuotaCost(areaCount) {
  return areaCount * (SEARCH_UNITS + VIDEOS_UNITS);
}
