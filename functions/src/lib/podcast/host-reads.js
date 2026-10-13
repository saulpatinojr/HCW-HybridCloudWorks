/**
 * host-reads.js — what Podbean says about the episodes this hub published
 * (#1115, ADR 0029 §1c).
 *
 * The Distribution tab used to show only what the publish job RECORDED: an
 * episode id and the status Podbean answered at the moment of the create.
 * Everything since — the owner unpublishing an episode on Podbean, a draft
 * going live, how many times it was downloaded — was invisible from the hub.
 * This module joins the hub's own records with Podbean's, read live:
 *
 *   podcast_transcripts  every document with `host.podbean.episodeId` set,
 *                        newest generation first (one bounded query)
 *   GET /v1/podcast      the show (title, logo, website)
 *   GET /v1/episodes     one page of the newest 100 — the show has three today
 *                        and this is built for about a hundred
 *   GET /v1/podcastStats/stats?episode_id=…
 *                        the last `days` days of downloads, per episode, newest
 *                        first and AT MOST `HOST_OVERVIEW_STATS_CAP` of them
 *
 * The join is by episode id. A transcript whose episode is in the page gets
 * Podbean's title, status, permalink and publish time; one whose episode is
 * not (deleted on Podbean, or past the page) keeps the record's permalink and
 * carries `error: { code: 'NOT_LISTED' }`. An episode in the page that no
 * transcript names — the three the owner published by hand before this path
 * existed — is a row too, with `transcriptId: null`, so the tab shows the
 * whole show and not only what this hub sent.
 *
 * ## Never throws for Podbean
 *
 * A Podbean call that fails is recorded where it failed — `errors.show`,
 * `errors.episodes`, or `error` on the one row whose downloads could not be
 * read — in the `{ status, code, message, retryable }` shape the publish job
 * records (`toRecordedError`), and the overview still returns with what was
 * read. A listing that fails leaves every transcript row with that error and
 * reads no statistics: a 429 on the listing is a 429 on all twenty reads. A
 * failure of OUR store is thrown; that is the handler's 500.
 *
 * ## Cached fifteen minutes
 *
 * Podbean's bucket is 60 requests refilling at two a second, this read makes
 * up to 22 of them, and the hub re-renders the Distribution tab on every
 * transcript reload. So the overview is stored in `admin_config` as
 * `podbean_host_overview` with its `fetchedAt`, and served from there while
 * it is younger than `HOST_OVERVIEW_TTL_MS` unless the caller asks for a
 * refresh. A cache that cannot be read or written is logged (content-free)
 * and the live read is returned regardless — the cache is a courtesy to the
 * rate bucket, never a dependency.
 *
 * Logs name counts and error codes only: an episode title is the owner's
 * content, and the token never reaches this file (podbean.js scrubs it).
 */
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { toRecordedError } from './host-publish.js';
import { TRANSCRIPT_CONTAINER } from './store.js';

/** The `admin_config` document the overview is cached in. */
export const HOST_OVERVIEW_CONFIG_ID = 'podbean_host_overview';
/** How long a cached overview is served before Podbean is read again. */
export const HOST_OVERVIEW_TTL_MS = 15 * 60_000;
/** Per-episode statistics reads per overview; the newest episodes get them. */
export const HOST_OVERVIEW_STATS_CAP = 20;
/** The one episode page read; Podbean's maximum `limit`. */
export const HOST_OVERVIEW_EPISODE_PAGE = 100;
/** The download window, in days ending today (Podbean clamps today to yesterday). */
export const HOST_OVERVIEW_DAYS = 30;

/** A ceiling on the transcript rows, not a page size; the catalogue is tens. */
const MAX_PUBLISHED = 200;

/**
 * Every transcript that names a Podbean episode, newest generation first.
 * `IS_STRING` rather than `IS_DEFINED`: a record that was reset carries
 * `episodeId: null`, and null is not an episode.
 */
export const PUBLISHED_QUERY =
  `SELECT TOP ${MAX_PUBLISHED} c.id, c.title, c.host, c.generatedAt FROM c ` +
  'WHERE IS_STRING(c.host.podbean.episodeId) ORDER BY c.generatedAt DESC';

/** `YYYY-MM-DD` in UTC. */
export function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

/** The window of `days` days ending on `now`'s day: `{ start, end }`. */
export function windowEnding(now, days) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  return { start: isoDay(start), end: isoDay(end) };
}

/** A Podbean unix-seconds stamp as ISO, or null for anything that is not one. */
function publishTimeOf(episode) {
  const seconds = Number(episode?.publish_time);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

/** A string field or null, never undefined and never another type. */
const str = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** Run one Podbean read; `{ value }` or `{ error }` in the recorded shape, never a throw. */
async function settle(read) {
  try {
    return { value: await read() };
  } catch (error) {
    return { error: toRecordedError(error) };
  }
}

/** The show as the hub shows it: four fields, no description. */
function toShow(answer) {
  const podcast = answer?.podcast;
  if (!podcast || typeof podcast !== 'object') return null;
  return {
    id: str(String(podcast.id ?? '')),
    title: str(podcast.title),
    logo: str(podcast.logo),
    website: str(podcast.website),
  };
}

/** One overview row from a transcript and, when listed, its live episode. */
function rowForTranscript(transcript, live, listingError) {
  const record = transcript.host.podbean;
  const episodeId = String(record.episodeId);
  let error = null;
  if (listingError) {
    error = listingError;
  } else if (!live) {
    error = {
      status: null,
      code: 'NOT_LISTED',
      message: `Podbean's newest ${HOST_OVERVIEW_EPISODE_PAGE} episodes do not include this one; it may have been deleted there.`,
      retryable: false,
    };
  }
  return {
    transcriptId: transcript.id,
    episodeId,
    title: str(live?.title) ?? str(transcript.title),
    hostStatus: str(live?.status) ?? (live ? null : str(record.hostStatus)),
    permalinkUrl: str(live?.permalink_url) ?? str(record.permalinkUrl),
    publishTime: publishTimeOf(live) ?? str(record.publishedAt),
    downloads: null,
    error,
  };
}

/** One overview row for a listed episode no transcript names. */
function rowForUnmatched(live) {
  return {
    transcriptId: null,
    episodeId: String(live.id),
    title: str(live.title),
    hostStatus: str(live.status),
    permalinkUrl: str(live.permalink_url),
    publishTime: publishTimeOf(live),
    downloads: null,
    error: null,
  };
}

/** Newest publish first; rows without a publish time after every row with one. */
function byPublishTimeDesc(a, b) {
  if (a.publishTime === b.publishTime) return 0;
  if (a.publishTime === null) return 1;
  if (b.publishTime === null) return -1;
  return a.publishTime < b.publishTime ? 1 : -1;
}

/** The rows, joined and ordered, before any statistics are read. */
function joinRows(transcripts, listing) {
  const listed = Array.isArray(listing.value?.episodes) ? listing.value.episodes : [];
  const byId = new Map(listed.filter((e) => e && e.id != null).map((e) => [String(e.id), e]));
  const claimed = new Set();
  const rows = [];
  for (const transcript of transcripts) {
    const episodeId = String(transcript.host.podbean.episodeId);
    claimed.add(episodeId);
    rows.push(rowForTranscript(transcript, byId.get(episodeId), listing.error ?? null));
  }
  for (const [id, live] of byId) {
    if (!claimed.has(id)) rows.push(rowForUnmatched(live));
  }
  return rows.sort(byPublishTimeDesc);
}

/** Sum of a date → downloads map, ignoring anything that is not a finite number. */
export function totalDownloads(byDay) {
  if (!byDay || typeof byDay !== 'object') return 0;
  let total = 0;
  for (const value of Object.values(byDay)) {
    const n = Number(value);
    if (Number.isFinite(n)) total += n;
  }
  return total;
}

/**
 * Read the download window for the first `cap` rows that can take one, in
 * place. Parallel: at most `cap` requests against a bucket of 60, and the
 * handler's deadline is the HTTP one. Returns how many eligible rows were
 * left unread by the cap.
 */
async function readDownloads(rows, { client, range, cap }) {
  const eligible = rows.filter((row) => row.error === null);
  const chosen = eligible.slice(0, cap);
  await Promise.all(
    chosen.map(async (row) => {
      const outcome = await settle(() =>
        client.getDownloadStats({ ...range, period: 'd', episodeId: row.episodeId })
      );
      if (outcome.error) {
        row.error = outcome.error;
      } else {
        const byDay = outcome.value && typeof outcome.value === 'object' ? outcome.value : {};
        row.downloads = { total: totalDownloads(byDay), byDay };
      }
    })
  );
  return eligible.length - chosen.length;
}

/**
 * The overview, read live. Throws only for a failure of our own store.
 *
 * @param {object} deps
 * @param {{ getPodcast: Function, listEpisodes: Function, getDownloadStats: Function }} deps.client
 * @param {{ queryDocs: Function }} deps.store
 * @param {() => Date} [deps.now]
 * @param {number} [deps.days]
 * @param {number} [deps.statsCap]
 */
export async function fetchHostOverview({
  client,
  store,
  now = () => new Date(),
  days = HOST_OVERVIEW_DAYS,
  statsCap = HOST_OVERVIEW_STATS_CAP,
}) {
  const at = now();
  const range = windowEnding(at, days);
  const [transcripts, show, listing] = await Promise.all([
    store.queryDocs(TRANSCRIPT_CONTAINER, PUBLISHED_QUERY, []),
    settle(() => client.getPodcast()),
    settle(() => client.listEpisodes({ offset: 0, limit: HOST_OVERVIEW_EPISODE_PAGE })),
  ]);
  const rows = joinRows(Array.isArray(transcripts) ? transcripts : [], listing);
  const errors = {};
  if (show.error) errors.show = show.error;
  if (listing.error) errors.episodes = listing.error;
  // A listing that failed left every row carrying its error, so nothing is
  // eligible and this reads nothing — the point when the failure was a 429.
  const downloadsCapped = await readDownloads(rows, { client, range, cap: statsCap });
  return {
    fetchedAt: at.toISOString(),
    days,
    range,
    show: show.error ? null : toShow(show.value),
    episodes: rows,
    downloadsCapped,
    errors,
  };
}

/** The fields a cached document serves; Cosmos's system fields and the partition never leave. */
const OVERVIEW_FIELDS = Object.freeze([
  'fetchedAt',
  'days',
  'range',
  'show',
  'episodes',
  'downloadsCapped',
  'errors',
]);

function toOverview(doc) {
  if (!doc || typeof doc !== 'object' || typeof doc.fetchedAt !== 'string') return null;
  if (!Array.isArray(doc.episodes)) return null;
  return Object.fromEntries(OVERVIEW_FIELDS.map((field) => [field, doc[field] ?? null]));
}

/** Whether a cached overview still stands: same window, and younger than the TTL. */
export function isFresh(cached, { now, ttlMs, days }) {
  if (!cached || cached.days !== days) return false;
  const age = now.getTime() - Date.parse(cached.fetchedAt);
  return Number.isFinite(age) && age >= 0 && age < ttlMs;
}

/**
 * The overview, from the cache while it is fresh, else live and then cached.
 *
 * @param {object} deps
 * @param {object} deps.client the Podbean client
 * @param {{ queryDocs: Function, readDoc: Function, upsertDoc: Function }} deps.store
 * @param {() => Date} [deps.now]
 * @param {boolean} [deps.refresh] skip the cache (the hub's Refresh button)
 * @param {number} [deps.days]
 * @param {number} [deps.ttlMs]
 * @param {(line: string) => void} [deps.log] content-free lines only
 * @returns {Promise<object>} the overview with `cached: true | false`
 */
export async function readHostOverview({
  client,
  store,
  now = () => new Date(),
  refresh = false,
  days = HOST_OVERVIEW_DAYS,
  ttlMs = HOST_OVERVIEW_TTL_MS,
  log,
}) {
  if (!refresh) {
    let cached = null;
    try {
      cached = toOverview(
        await store.readDoc('admin_config', HOST_OVERVIEW_CONFIG_ID, ADMIN_CONFIG_PARTITION)
      );
    } catch (error) {
      log?.(`podbean overview: cache read failed (${error?.code || 'UNEXPECTED'}); reading live`);
    }
    if (isFresh(cached, { now: now(), ttlMs, days })) return { ...cached, cached: true };
  }

  const live = await fetchHostOverview({ client, store, now, days });
  try {
    await store.upsertDoc('admin_config', {
      id: HOST_OVERVIEW_CONFIG_ID,
      configScope: ADMIN_CONFIG_PARTITION,
      ...live,
    });
  } catch (error) {
    log?.(`podbean overview: cache write failed (${error?.code || 'UNEXPECTED'}); serving live`);
  }
  return { ...live, cached: false };
}
