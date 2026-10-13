/**
 * host-stats.js — the show's statistics, from Podbean, for the Recording
 * Hub's Stats tab (#1115, ADR 0029 §1c).
 *
 * Six reads of Podbean, each independent, over one window:
 *
 *   downloads  GET /v1/podcastStats/stats         date → downloads, summed
 *   countries  GET /v1/podcastStats/countries     country code → downloads
 *   platforms  GET /v1/podcastStats/platforms     platform → downloads
 *   sources    GET /v1/podcastStats/sources       app or directory → downloads
 *   retention  GET /v1/podcastStats/userRetention cohort → [{ listeners, retention }]
 *   audience   GET /v1/analytics/podcastAnalyticReports
 *              { followers, likes, comments, total_episode_length }
 *
 * The window is one of three ranges: `30d` and `90d` are daily (`period: 'd'`)
 * ending today; `12m` is monthly (`period: 'm'`) from the first of the month
 * eleven months ago, so twelve months inclusive of this one. Podbean clamps
 * today to yesterday itself. Retention takes no range (its cohorts are
 * monthly) and the audience counts are the show's totals; both are read with
 * every range because the tab shows them beside it.
 *
 * ## Independent, and recorded apart
 *
 * A sub-read that fails is `null` in its place and an entry under
 * `errors.<name>` in the publish job's recorded-error shape
 * (`toRecordedError`); the five others still answer. Nothing here throws for
 * Podbean, and the answer is 200 with whatever was read — a rate-limited
 * countries read must not blank the downloads chart beside it.
 *
 * ## Cached an hour, per range
 *
 * Statistics move slowly and Podbean's bucket does not: each range has its
 * own `admin_config` document, `podbean_host_stats_<range>`, served while
 * younger than `HOST_STATS_TTL_MS` unless the tab asks for a refresh, and a
 * refresh still serves it under `HOST_STATS_REFRESH_FLOOR_MS` (host-cache.js,
 * which also keys the document to the Podbean account). Six requests an hour
 * per range is nothing; six per render would not be.
 *
 * ## What is assumed and not measured
 *
 * The shapes above are Podbean's documented ones; none has been read live
 * (podbean.js's header says the same of the client). Two are passed through
 * as given rather than reshaped, because their keys are not fully specified:
 * the monthly download map's key format under `period: 'm'`, and retention's
 * cohort labels and whether `retention` is a fraction or a percentage. The
 * tab's view helpers are written to take either and say so.
 */
import { isoDay } from './host-reads.js';
import { readThroughCache } from './host-cache.js';
import { toRecordedError } from './host-publish.js';
import { ANALYTIC_REPORT_TYPES } from './podbean.js';

/** The ranges the route accepts, in the order the tab offers them. */
export const HOST_STATS_RANGES = Object.freeze(['30d', '90d', '12m']);
export const HOST_STATS_DEFAULT_RANGE = '30d';
/** How long a range's statistics are served before Podbean is read again. */
export const HOST_STATS_TTL_MS = 60 * 60_000;
/** How young a range's cached statistics must be for `?refresh=1` to serve them anyway. */
export const HOST_STATS_REFRESH_FLOOR_MS = 60_000;

/** The `admin_config` document a range is cached in. */
export function hostStatsConfigId(range) {
  return `podbean_host_stats_${range}`;
}

/** A range the route accepts, or null — never a default, so the handler can answer 400. */
export function parseRange(value) {
  const range = typeof value === 'string' ? value.trim() : '';
  return HOST_STATS_RANGES.includes(range) ? range : null;
}

/**
 * The window a range names, ending on `now`'s UTC day: `{ start, end, period }`.
 * `12m` starts on the first of the month eleven months back, so the twelve
 * monthly buckets are whole months and the current one is partial — which is
 * what a reader expects of "the last twelve months".
 */
export function windowForRange(range, now) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (range === '12m') {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
    return { start: isoDay(start), end: isoDay(end), period: 'm' };
  }
  const days = range === '90d' ? 90 : 30;
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  return { start: isoDay(start), end: isoDay(end), period: 'd' };
}

/** Run one Podbean read; `{ value }` or `{ error }` in the recorded shape, never a throw. */
async function settle(read) {
  try {
    return { value: await read() };
  } catch (error) {
    return { error: toRecordedError(error) };
  }
}

/** A name → count map as given, or `{}` for anything that is not an object. */
const asMap = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

/** Sum of a name → count map, ignoring anything that is not a finite number. */
export function sumCounts(map) {
  let total = 0;
  for (const value of Object.values(asMap(map))) {
    const n = Number(value);
    if (Number.isFinite(n)) total += n;
  }
  return total;
}

/** A number or null, never NaN and never a string. */
const num = (value) => {
  const n = Number(value);
  return value === null || value === undefined || value === '' || !Number.isFinite(n) ? null : n;
};

/** The analytic report as the tab names its fields. */
function toAudience(report) {
  const data = asMap(report);
  return {
    followers: num(data.followers),
    likes: num(data.likes),
    comments: num(data.comments),
    totalEpisodeLengthSeconds: num(data.total_episode_length),
  };
}

/**
 * The statistics, read live. Never throws for Podbean.
 *
 * @param {object} deps
 * @param {object} deps.client the Podbean client
 * @param {() => Date} [deps.now]
 * @param {string} deps.range one of HOST_STATS_RANGES
 */
export async function fetchHostStats({ client, now = () => new Date(), range }) {
  const at = now();
  const window = windowForRange(range, at);
  const [downloads, countries, platforms, sources, retention, audience] = await Promise.all([
    settle(() => client.getDownloadStats(window)),
    settle(() => client.getCountryStats(window)),
    settle(() => client.getPlatformStats(window)),
    settle(() => client.getSourceStats(window)),
    settle(() => client.getUserRetention({ period: 'm' })),
    settle(() => client.getAnalyticReports({ types: ANALYTIC_REPORT_TYPES })),
  ]);
  const errors = {};
  const take = (name, outcome, shape) => {
    if (outcome.error) {
      errors[name] = outcome.error;
      return null;
    }
    return shape(outcome.value);
  };
  return {
    fetchedAt: at.toISOString(),
    range,
    window,
    downloads: take('downloads', downloads, (value) => ({
      byPeriod: asMap(value),
      total: sumCounts(value),
    })),
    countries: take('countries', countries, asMap),
    platforms: take('platforms', platforms, asMap),
    sources: take('sources', sources, asMap),
    retention: take('retention', retention, asMap),
    audience: take('audience', audience, toAudience),
    errors,
  };
}

/** The fields a cached document serves. */
const STATS_FIELDS = Object.freeze([
  'fetchedAt',
  'accountKey',
  'range',
  'window',
  'downloads',
  'countries',
  'platforms',
  'sources',
  'retention',
  'audience',
  'errors',
]);

/**
 * The statistics for a range, from its cache while that is under an hour
 * old, else live and then cached.
 *
 * @param {object} deps
 * @param {object} deps.client the Podbean client
 * @param {{ readDoc: Function, upsertDoc: Function }} deps.store
 * @param {string} deps.range one of HOST_STATS_RANGES (validated by the caller)
 * @param {() => Date} [deps.now]
 * @param {boolean} [deps.refresh]
 * @param {number} [deps.ttlMs]
 * @param {number} [deps.refreshFloorMs]
 * @param {(line: string) => void} [deps.log] content-free lines only
 */
export function readHostStats({
  client,
  store,
  range,
  now = () => new Date(),
  refresh = false,
  ttlMs = HOST_STATS_TTL_MS,
  refreshFloorMs = HOST_STATS_REFRESH_FLOOR_MS,
  log,
}) {
  return readThroughCache({
    store,
    id: hostStatsConfigId(range),
    fields: STATS_FIELDS,
    accept: (cached) => cached.range === range,
    read: () => fetchHostStats({ client, now, range }),
    now,
    ttlMs,
    refresh,
    refreshFloorMs,
    accountKey: client?.accountKey || null,
    label: `podbean stats ${range}`,
    log,
  });
}
