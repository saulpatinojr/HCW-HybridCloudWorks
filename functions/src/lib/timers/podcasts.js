/**
 * podcasts.js — `fetchPodcastFeeds`, every 2 hours: podcast RSS feeds into
 * `podcasts`, one document per episode, upserted by a normalized id.
 *
 * Ported from Site-Main index.js (088f458). `publishedAt` is an ISO string
 * here (the public list sorts on it — public-reads.js listPodcasts).
 *
 * Which feeds (#348): `admin_config/podcast_feeds`, shape
 * `{ mainFeedUrl, feeds: [{ provider, url }] }`, read on every run so a new
 * host is a document write rather than a deploy. `PODCAST_FEEDS` below is the
 * fallback when the document is absent. It is empty on purpose: the one feed
 * it used to hold, PodBean's, returned HTTP 410 Gone from 2026-09-05 and the
 * timer errored on every firing for as long as the constant named it. The next
 * host (issue #349) is seeded into the document, not written back here.
 *
 * `mainFeedUrl` is the site's own show (#349 follow-up): one feed that belongs
 * to hybridcloudworks.com rather than to any provider. It is a SEPARATE FIELD
 * rather than a row in `feeds` for two reasons. A document written before it
 * existed still reads correctly — `feeds` is untouched and a revision that
 * predates this code ignores the new key rather than fetching it as a provider
 * — and a provider row can never be mistaken for it, or it for one, because
 * they are not the same kind of value: `feeds` is keyed by provider and the
 * show has no provider.
 *
 * Inside a run, though, it IS one: `resolvePodcastFeeds` returns it as an
 * ordinary entry under the reserved provider `main`, so the ingest loop, the
 * dedupe, the 410 handling and the summary all work on it unchanged, and the
 * episodes it writes carry `provider: 'main'`. See MAIN_FEED_PROVIDER.
 */
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { errorFacts, errorCode } from '../http/error-response.js';

export const PODCAST_FEEDS = Object.freeze([]);

export const PODCAST_FEEDS_CONFIG_ID = 'podcast_feeds';

/**
 * The `provider` an episode of the site's own show is filed under.
 *
 * A reserved value rather than an absent provider, because every consumer of
 * `podcasts` already keys on the field: the container's composite index is
 * `provider + publishedAt`, the public list filters `c.provider = @provider`
 * in SQL, and `public-section-counts.js` reads the same field. A row with no
 * provider would be fetched by no query and counted by nothing — invisible in
 * exactly the way the eight empty audio pages were. A reserved value keeps
 * every one of those paths working and makes the row say what it is.
 *
 * `main` is not a provider slug and cannot become one: `PODCAST_PROVIDERS` in
 * platform-settings.js lists the eight, `normalizePodcastFeeds` refuses it as
 * a provider row, and the read side matches it by name (public-reads.js
 * MAIN_PODCAST_PROVIDER, asserted equal to this one by public-reads.test.js).
 */
export const MAIN_FEED_PROVIDER = 'main';

/** The production parser, with the podcast custom fields. Lazy so tests never load rss-parser. */
export async function createPodcastParser() {
  const { default: RssParser } = await import('rss-parser');
  return new RssParser({
    timeout: 20000,
    headers: { 'User-Agent': 'Mozilla/5.0 HybridCloudWorks-Bot/1.0' },
    customFields: {
      item: [
        'enclosure',
        ['itunes:duration', 'itunes:duration'],
        ['itunes:image', 'itunes:image'],
        ['media:content', 'media:content'],
      ],
    },
  });
}

/**
 * rss-parser surfaces a non-2xx as `Error("Status code 410")`. 410 is the
 * host saying the feed is gone for good, so retrying it every two hours is
 * not a transient failure to page on — it is configuration that needs a
 * human. The run reports it at Warning (visible, not an Error alert) and
 * moves on. Exported so the test pins the exact shape it matches.
 */
export function isFeedGoneError(err) {
  return /\bStatus code 410\b|^410$/.test(String(err?.message || err).trim());
}

/** A usable feed row: a provider slug and an https URL, nothing else assumed. */
export function isValidFeedEntry(entry) {
  return (
    !!entry &&
    typeof entry.provider === 'string' &&
    /^[a-z0-9-]+$/.test(entry.provider) &&
    typeof entry.url === 'string' &&
    /^https:\/\//.test(entry.url)
  );
}

/**
 * One feed per provider: the summary is keyed by provider, so a second row for
 * the same provider would be fetched, processed and then overwritten in the
 * summary — extra work and a misleading log line. First valid row wins.
 */
export function dedupeFeedsByProvider(feeds) {
  const seen = new Set();
  return feeds.filter((entry) => {
    if (seen.has(entry.provider)) return false;
    seen.add(entry.provider);
    return true;
  });
}

/**
 * The site's own show as a feed entry, or null when the document names none.
 *
 * Validated by `isValidFeedEntry`, the same test every provider row passes, so
 * a main feed this returns is a feed the run will fetch and a URL the public
 * list is willing to publish as a subscribe link.
 */
export function resolveMainFeedEntry(doc) {
  const url = typeof doc?.mainFeedUrl === 'string' ? doc.mainFeedUrl.trim() : '';
  const entry = { provider: MAIN_FEED_PROVIDER, url };
  return isValidFeedEntry(entry) ? entry : null;
}

/**
 * The feed list for this run: `admin_config/podcast_feeds` when it exists and
 * carries either a `feeds` array (invalid rows dropped, one per provider) or a
 * usable `mainFeedUrl`, else `fallback`. Returns `{ feeds, source }` so the
 * summary line can say which one ran.
 *
 * The main feed leads the list, which is not cosmetic: `dedupeFeedsByProvider`
 * keeps the FIRST row for a provider, so a hand-seeded `{ provider: 'main' }`
 * row left in `feeds` cannot displace the field the admin page writes. The
 * page refuses to create that row (normalizePodcastFeeds), but this document
 * was seedable by hand before the page existed.
 *
 * A document carrying ONLY `mainFeedUrl` counts as configured. Anything the
 * admin page writes carries `feeds` too, even empty — this is for the
 * hand-seeded case, where falling through to `fallback` would silently ingest
 * nothing while the document plainly names a feed.
 */
export async function resolvePodcastFeeds(store, fallback = PODCAST_FEEDS) {
  const doc = await store.readDoc('admin_config', PODCAST_FEEDS_CONFIG_ID, ADMIN_CONFIG_PARTITION);
  const main = resolveMainFeedEntry(doc);
  const rows = Array.isArray(doc?.feeds) ? doc.feeds.filter(isValidFeedEntry) : null;
  if (main || rows) {
    return {
      feeds: dedupeFeedsByProvider([...(main ? [main] : []), ...(rows ?? [])]),
      source: 'admin_config',
    };
  }
  return { feeds: [...fallback], source: 'default' };
}

export function normalizePodcastId(guid, title) {
  return String(guid || title || '')
    .toLowerCase()
    .replace(/https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

/** `mediaUrl` / `mimeType` / `fileLength` from `enclosure`, then `media:content`. */
export function extractPodcastMediaFields(item) {
  if (item.enclosure && item.enclosure.url) {
    return {
      mediaUrl: item.enclosure.url,
      mimeType: item.enclosure.type || null,
      fileLength: item.enclosure.length || null,
    };
  }
  if (item['media:content']) {
    const mc = item['media:content'];
    return {
      mediaUrl: (mc.$ && mc.$.url) || mc.url || null,
      mimeType: (mc.$ && mc.$.type) || mc.type || null,
      fileLength: (mc.$ && mc.$.fileSize) || mc.fileSize || null,
    };
  }
  return { mediaUrl: null, mimeType: null, fileLength: null };
}

export function extractPodcastImage(item) {
  return (
    (item.itunes && item.itunes.image && item.itunes.image.href) ||
    (item.itunes && typeof item.itunes.image === 'string' && item.itunes.image) ||
    (item.image && item.image.url) ||
    (item['itunes:image'] && item['itunes:image'].href) ||
    null
  );
}

export function parsePodcastPublishedDate(item) {
  const raw = item.isoDate || item.pubDate;
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function buildPodcastEpisode(provider, item, now) {
  const guid = item.guid || item.id || item.link || item.title;
  const publishedAt = parsePodcastPublishedDate(item);
  const { mediaUrl, mimeType, fileLength } = extractPodcastMediaFields(item);
  return {
    id: normalizePodcastId(guid, item.title),
    provider,
    title: item.title || '',
    description: item.contentSnippet || item.summary || '',
    longDescription: item['content:encoded'] || item.content || '',
    mediaUrl,
    mimeType,
    length: fileLength,
    duration: (item.itunes && item.itunes.duration) || item['itunes:duration'] || null,
    image: extractPodcastImage(item),
    link: item.link || null,
    guid: guid || null,
    publishedAt: publishedAt ? publishedAt.toISOString() : null,
    updatedAt: now.toISOString(),
  };
}

/**
 * @param {object} deps
 * @param {{ readDoc: Function, upsertDoc: Function }} deps.store
 * @param {{ parseURL: (url: string) => Promise<{items?: object[]}> }} deps.parser
 * @param {Array<{provider: string, url: string}>} [deps.feeds] Pinned list; when
 *   omitted the run resolves it from `admin_config/podcast_feeds` (see above).
 */
export function createPodcastIngest({ store, parser, feeds, now = () => new Date(), log = {} }) {
  async function processFeed(provider, feedUrl) {
    const feed = await parser.parseURL(feedUrl);
    const results = { processed: 0, errors: [] };
    const items = feed.items || [];
    for (const [index, item] of items.entries()) {
      try {
        const episode = buildPodcastEpisode(provider, item, now());
        const existing = await store.readDoc('podcasts', episode.id, episode.id);
        await store.upsertDoc('podcasts', {
          ...(existing || {}),
          ...episode,
          createdAt: existing?.createdAt || episode.updatedAt,
        });
        results.processed += 1;
      } catch (err) {
        // Position, not title, for the same reason as the Warning below: this
        // array is JSON-stringified into the summary line.
        results.errors.push({ position: index + 1, error: errorCode(err) });
        // Warning, not Information: host.json gates `Function` at Warning
        // (#321), so anything logged below this level never reaches the
        // workspace. The witness for this timer is a fresh `updatedAt`; when
        // that is missing, this line is what says the run happened at all.
        // Position, not title: the title is third-party text and the trace
        // stays content-free. The feed itself is named by its provider —
        // one URL per provider in the feed list.
        log.warn?.(
          `[fetchPodcastFeeds] ${provider}: episode ${index + 1} of ${items.length} failed: ${errorFacts(err)}`
        );
      }
    }
    if (results.processed === 0 && results.errors.length === 0) {
      log.warn?.(`[fetchPodcastFeeds] ${provider}: feed returned no items`);
    }
    return results;
  }

  async function run() {
    const resolved = feeds ? { feeds, source: 'pinned' } : await resolvePodcastFeeds(store);
    if (resolved.feeds.length === 0) {
      // Warning, so the empty state is distinguishable from a timer that never
      // fired — the same reason the empty-feed case above is a Warning.
      log.warn?.(
        `[fetchPodcastFeeds] no feeds configured (source: ${resolved.source}) — seed admin_config/${PODCAST_FEEDS_CONFIG_ID} as { mainFeedUrl, feeds: [{ provider, url }] }`
      );
      return {};
    }
    const summary = {};
    for (const cfg of resolved.feeds) {
      try {
        summary[cfg.provider] = await processFeed(cfg.provider, cfg.url);
      } catch (err) {
        if (isFeedGoneError(err)) {
          summary[cfg.provider] = { processed: 0, skipped: 'gone' };
          log.warn?.(
            `[fetchPodcastFeeds] ${cfg.provider}: feed gone (410) — remove it from admin_config/${PODCAST_FEEDS_CONFIG_ID} or replace the URL`
          );
          continue;
        }
        summary[cfg.provider] = { processed: 0, error: errorCode(err) };
        log.error?.(`[fetchPodcastFeeds] ${cfg.provider}: feed failed: ${errorFacts(err)}`);
      }
    }
    log.log?.(`[fetchPodcastFeeds] (${resolved.source}) ${JSON.stringify(summary)}`);
    return summary;
  }
  return { run, processFeed };
}
