/**
 * public-read-audio.js — the podcast, feed, Listen & Learn and certification event reads. Each read takes the store and the
 * request; public-reads.js wires them into createPublicReadHandlers.
 */
import { errorFacts } from './http/error-response.js';
import {
  CERT_EVENTS_CACHE_SECONDS,
  CERT_EVENTS_CONTAINER,
  CERT_EVENTS_MAX_LISTED,
  CERT_EVENT_FIELDS,
  CERT_EVENT_PROJECTION,
  CERT_EVENT_SOURCES_BY_PLATFORM,
  FEED_CACHE_MAX_DOCS,
  FEED_CACHE_PROJECTION,
  FETCH_WINDOW,
  LISTEN_AND_LEARN_EPISODE_CONTAINER,
  LISTEN_AND_LEARN_EPISODE_PROJECTION,
  LISTEN_AND_LEARN_LIST_FIELDS,
  LISTEN_AND_LEARN_LIST_PROJECTION,
  LISTEN_AND_LEARN_MAX_EPISODES,
  LISTEN_AND_LEARN_MAX_LISTED,
  LISTEN_AND_LEARN_SET_CONTAINER,
  LISTEN_AND_LEARN_SET_PROJECTION,
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  MAIN_PODCAST_PROVIDER,
  PODCAST_FEEDS_CONFIG_CONTAINER,
  PODCAST_FEEDS_CONFIG_ID,
  PODCAST_FEEDS_CONFIG_PARTITION,
  PODCAST_PROJECTION,
  PROVIDER_ALIASES,
  PUBLIC_FEED_CACHE_FIELDS,
  PUBLIC_LISTEN_AND_LEARN_EPISODE_FIELDS,
  PUBLIC_LISTEN_AND_LEARN_SET_FIELDS,
  PUBLIC_PODCAST_FIELDS,
  boundFeedItems,
  isPodcastMediaRetired,
  isSoftDeleted,
  json,
  projectFields,
  resolveFeedUrlForProvider,
  resolveMainFeedUrl,
  resolvePublishedDateValue,
  servableListenAndLearnAudioUrl,
} from './public-read-rules.js';

/**
 * GET /api/public/podcasts?provider=&limit= (hooks/useAudioEpisodes.js)
 *
 * A provider's rows AND the site's show. The show is not a provider's
 * content, it is the site's, so it belongs on every provider's audio page
 * — which is also what stops those pages being empty when a provider has
 * no feed of its own. Each row carries its own `provider`, so the page can
 * tell the show from the provider's episodes without asking twice, and a
 * show episode appears exactly once in the list: `main` is a value
 * `c.provider` takes, not a second copy of a provider's row. Each row is
 * projected to PUBLIC_PODCAST_FIELDS, in SQL and in code.
 *
 * @param {object} request the Functions HTTP request
 * @param {object} context the invocation context, for error logging
 */
export async function listPodcasts(store, request, context) {
  try {
    // Lower-cased like every other public read in this module: the rows
    // and the feed config are both keyed by the canonical slug, so
    // `?provider=Azure` would otherwise answer 200 with an empty list and
    // a null feed URL — a wrong answer that looks like an empty section.
    const provider = String(request.query.get('provider') || '')
      .trim()
      .toLowerCase();
    const limit = Math.min(
      Math.max(Number(request.query.get('limit')) || LIST_DEFAULT_LIMIT, 1),
      LIST_MAX_LIMIT
    );

    let query = `SELECT TOP ${FETCH_WINDOW} ${PODCAST_PROJECTION} FROM c`;
    const parameters = [];
    if (provider) {
      // IN, not two round trips: one query over the same
      // `provider + publishedAt` index the equality used, and the rows
      // arrive already interleaved for the date sort below.
      query += ' WHERE c.provider IN (@provider, @mainProvider)';
      parameters.push(
        { name: '@provider', value: provider },
        { name: '@mainProvider', value: MAIN_PODCAST_PROVIDER }
      );
    }
    const rows = await store.queryDocs('podcasts', query, parameters);
    // Soft-delete only: podcasts have no publication workflow, so
    // isPublicDocument would reject every row. See isSoftDeleted.
    // Plus media that is known to be gone (isPodcastMediaRetired): an
    // episode whose file answers 404 is a player that plays nothing.
    const matching = rows
      .filter((doc) => !isSoftDeleted(doc) && !isPodcastMediaRetired(doc))
      .sort((a, b) => resolvePublishedDateValue(b) - resolvePublishedDateValue(a));
    const items = matching
      .slice(0, limit)
      .map((doc) => projectFields(doc, PUBLIC_PODCAST_FIELDS));

    // The provider's configured feed and the site's show (#349), for the
    // RSS subscribe button. One point read; a failure here degrades to
    // "no button", because the episode list is the page and the button is
    // not. Both are returned rather than one resolved value: which feed a
    // reader is offered is the page's decision, and `feedUrl` keeps
    // meaning the same thing it did — the feed THESE provider rows were
    // ingested from.
    let feedUrl = null;
    let mainFeedUrl = null;
    if (provider) {
      try {
        const config = await store.readDoc(
          PODCAST_FEEDS_CONFIG_CONTAINER,
          PODCAST_FEEDS_CONFIG_ID,
          PODCAST_FEEDS_CONFIG_PARTITION
        );
        feedUrl = resolveFeedUrlForProvider(config, provider);
        mainFeedUrl = resolveMainFeedUrl(config);
      } catch (error) {
        // Status or code only. A Cosmos SDK message can carry the
        // container, id and partition key of the request, and telemetry
        // here stays content-free.
        const code = error?.statusCode ?? error?.code ?? 'unknown';
        context.warn?.(`publicListPodcasts: feed config unreadable (${code})`);
      }
    }

    // Counted before the slice — see listContent above (T-407).
    return json(
      200,
      { success: true, items, total: matching.length, feedUrl, mainFeedUrl },
      300
    );
  } catch (error) {
    context.error('publicListPodcasts failed:', errorFacts(error));
    return json(500, { error: 'Failed to list podcasts' });
  }
}

/**
 * GET /api/public/feed?provider= — rss_cache docs for one provider
 * (useNewsData.js). Cache documents are trimmed to their newest items
 * (T-319) and otherwise returned as stored; the flatten/sort across feeds
 * stays client-side where it lives today. Until 2026-09-05 the response
 * also carried `insights` from `ai_insights` (T-765, retired). Each
 * document is projected to PUBLIC_FEED_CACHE_FIELDS, in SQL and in code.
 *
 * @param {object} request the Functions HTTP request
 * @param {object} context the invocation context, for error logging
 */
export async function getFeed(store, request, context) {
  try {
    const provider = String(request.query.get('provider') || '').trim();
    if (!provider) return json(400, { error: 'provider required' });

    // The query was unbounded on an anonymous endpoint, and queryDocs
    // calls .fetchAll() (T-203). rss_cache is TTL-bounded at seven
    // days and syncRssFeeds now enforces that bound, but a document count
    // is not an item count and the timer only rewrites feeds it still
    // fetches — a retired feed's document keeps whatever it last held. The
    // ceiling stays, and boundFeedItems below bounds the rest.
    const rssCache = await store.queryDocs(
      'rss_cache',
      `SELECT TOP ${FEED_CACHE_MAX_DOCS} ${FEED_CACHE_PROJECTION} FROM c WHERE c.provider = @provider`,
      [{ name: '@provider', value: provider }]
    );

    return json(
      200,
      {
        success: true,
        // Soft-delete applies; publication status does not (see
        // isSoftDeleted). T-319: each surviving document is trimmed to its
        // newest items so the response is bounded in articles, not just
        // in feeds.
        rssCache: rssCache
          .filter((doc) => !isSoftDeleted(doc))
          .map((doc) => boundFeedItems(projectFields(doc, PUBLIC_FEED_CACHE_FIELDS))),
      },
      120
    );
  } catch (error) {
    context.error('publicGetFeed failed:', errorFacts(error));
    return json(500, { error: 'Failed to get feed' });
  }
}

/**
 * GET /api/public/listen-and-learn?platform=&examCode= — the approved
 * episodes for one certification (components/education/ListenAndLearn.jsx).
 *
 * `status === 'published'` is the ONLY thing standing between a draft and a
 * visitor. These are AI-written summaries of a paid exam's objectives,
 * generated as drafts and approved one at a time in the admin portal, so
 * this filter is the whole review gate rather than a display preference —
 * which is why it is an equality test on an explicit value and not a
 * `!== 'draft'`. An episode whose status a future writer misspells stays
 * hidden, which is the safe direction.
 *
 * A set with no approved episodes returns `episodes: []` and a 200 rather
 * than a 404: the certification exists and the page renders its own
 * "nothing published yet" state, which is a different thing from a
 * certification that has never been generated.
 *
 * The set is projected to PUBLIC_LISTEN_AND_LEARN_SET_FIELDS and each
 * chapter to PUBLIC_LISTEN_AND_LEARN_EPISODE_FIELDS (in SQL and in code):
 * a published chapter whose regeneration failed stays published, and the
 * failure it records is for the admin card, not for a visitor.
 *
 * @param {object} request the Functions HTTP request
 * @param {object} context the invocation context, for error logging
 */
export async function getListenAndLearn(store, request, context) {
  try {
    const platform = String(request.query.get('platform') || '')
      .trim()
      .toLowerCase();
    const examCode = String(request.query.get('examCode') || '').trim();
    if (!platform || !examCode) {
      return json(400, { error: 'platform and examCode are required' });
    }

    const id = `${platform}_${examCode.toLowerCase()}`;
    const [set, episodes] = await Promise.all([
      store.readDoc(LISTEN_AND_LEARN_SET_CONTAINER, id, id),
      store.queryDocs(
        LISTEN_AND_LEARN_EPISODE_CONTAINER,
        `SELECT TOP ${LISTEN_AND_LEARN_MAX_EPISODES} ${LISTEN_AND_LEARN_EPISODE_PROJECTION} FROM c WHERE c.setId = @setId AND c.status = @status`,
        [
          { name: '@setId', value: id },
          { name: '@status', value: 'published' },
        ]
      ),
    ]);

    // A soft-deleted or archived book (ADR 0033 §4) is gone from the site
    // as a whole, whatever its chapters still say; its chapters are also
    // archived — status 'archived', which the SQL above excludes — so the
    // two reads agree.
    if (!set || isSoftDeleted(set) || set.archivedAt) return json(404, { error: 'Not found' });

    return json(
      200,
      {
        success: true,
        set: projectFields(set, PUBLIC_LISTEN_AND_LEARN_SET_FIELDS),
        // Study-guide order. Episodes are meant to be heard in the order
        // the exam presents the areas, which is neither the order a query
        // returns nor the order exam weighting would give.
        episodes: episodes
          .filter((doc) => !isSoftDeleted(doc))
          .map((doc) => ({
            ...projectFields(doc, PUBLIC_LISTEN_AND_LEARN_EPISODE_FIELDS),
            audioUrl: servableListenAndLearnAudioUrl(doc),
          }))
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
      },
      300
    );
  } catch (error) {
    context.error('publicGetListenAndLearn failed:', errorFacts(error));
    return json(500, { error: 'Failed to get Listen & Learn episodes' });
  }
}

/**
 * GET /api/public/listen-and-learn/episodes?platform= — every approved
 * episode with audio across a provider's certifications, newest first,
 * for the provider's podcast page (#349, hooks/useAudioEpisodes.js).
 *
 * Same gate as the per-certification read: `status === 'published'` as
 * an equality test in SQL, soft-deletes dropped afterwards. Two things
 * differ because this is a list for a player rather than a study page:
 * an episode without audio is omitted — a podcast row that plays nothing
 * is the defect #372 hid on the host side — and each row is projected to
 * the listing allowlist, joined to its set for the certification title
 * and slug the row links to.
 *
 * Newest by approval, not by study-guide order: this list interleaves
 * with feed episodes on a date-sorted page, and approval is the moment an
 * episode became public.
 */
export async function listListenAndLearnEpisodes(store, request, context) {
  try {
    const provider = String(request.query.get('platform') || '')
      .trim()
      .toLowerCase();
    if (!provider) return json(400, { error: 'platform is required' });

    // ORDER BY in SQL so that, above the cap, the rows kept are the newest
    // rather than an arbitrary subset the in-memory sort could not
    // recover. One field, not two: the container declares no composite
    // index (infra/cosmos-containers.json), which a two-key ORDER BY
    // needs. `approvedAt` is safe to order on where the header's rule 2
    // forbids the content aliases: setEpisodeStatus stamps it in the same
    // write that sets status to published, so no published row lacks it.
    // The in-memory sort below still applies the generatedAt fallback.
    const [episodes, sets] = await Promise.all([
      store.queryDocs(
        LISTEN_AND_LEARN_EPISODE_CONTAINER,
        `SELECT TOP ${LISTEN_AND_LEARN_MAX_LISTED} ${LISTEN_AND_LEARN_LIST_PROJECTION} FROM c WHERE c.provider = @provider AND c.status = @status ORDER BY c.approvedAt DESC`,
        [
          { name: '@provider', value: provider },
          { name: '@status', value: 'published' },
        ]
      ),
      store.queryDocs(
        LISTEN_AND_LEARN_SET_CONTAINER,
        `SELECT TOP ${LISTEN_AND_LEARN_MAX_LISTED} ${LISTEN_AND_LEARN_SET_PROJECTION} FROM c WHERE c.provider = @provider`,
        [{ name: '@provider', value: provider }]
      ),
    ]);

    const setsById = new Map(
      sets.filter((set) => !isSoftDeleted(set)).map((set) => [set.id, set])
    );

    const items = episodes
      .filter((doc) => !isSoftDeleted(doc) && servableListenAndLearnAudioUrl(doc))
      .map((doc) => {
        const row = {};
        for (const field of LISTEN_AND_LEARN_LIST_FIELDS) {
          if (doc[field] !== undefined) row[field] = doc[field];
        }
        const set = setsById.get(doc.setId);
        row.certTitle = set?.certTitle || null;
        row.certSlug = set?.certSlug || null;
        return row;
      })
      .sort(
        (a, b) =>
          resolvePublishedDateValue({ publishedAt: b.approvedAt || b.generatedAt }) -
          resolvePublishedDateValue({ publishedAt: a.approvedAt || a.generatedAt })
      );

    return json(200, { success: true, items, total: items.length }, 300);
  } catch (error) {
    context.error('publicListListenAndLearnEpisodes failed:', errorFacts(error));
    return json(500, { error: 'Failed to list Listen & Learn episodes' });
  }
}

/**
 * GET /api/public/cert-events?platform= — the certification lifecycle
 * events the Friday scraper has recorded for a platform, newest
 * publication first (#461 item 4; pages/azure/EducationPage.jsx merges
 * them over the hand-maintained timeline).
 *
 * `platform` must be one of the known provider keys, and is answered by
 * source: a known platform with no scraper feeding it gets an empty list
 * and no query, which is what "nothing has been scraped for this
 * provider" looks like to the page — the static timeline stays.
 */
export async function listCertEvents(store, request, context) {
  try {
    const platform = String(request.query.get('platform') || '')
      .trim()
      .toLowerCase();
    if (!platform) return json(400, { error: 'platform is required' });
    if (!Object.prototype.hasOwnProperty.call(PROVIDER_ALIASES, platform)) {
      return json(400, { error: 'platform is not a known provider' });
    }

    const sources = CERT_EVENT_SOURCES_BY_PLATFORM[platform] || [];
    if (sources.length === 0) {
      return json(200, { success: true, items: [], total: 0 }, CERT_EVENTS_CACHE_SECONDS);
    }

    const docs = await store.queryDocs(
      CERT_EVENTS_CONTAINER,
      `SELECT TOP ${CERT_EVENTS_MAX_LISTED} ${CERT_EVENT_PROJECTION} FROM c WHERE ARRAY_CONTAINS(@sources, c.source) ORDER BY c.pubDate DESC`,
      [{ name: '@sources', value: [...sources] }]
    );

    const items = docs
      .filter((doc) => !isSoftDeleted(doc))
      .map((doc) => {
        const row = {};
        for (const field of CERT_EVENT_FIELDS) {
          if (doc[field] !== undefined) row[field] = doc[field];
        }
        return row;
      })
      .sort(
        (a, b) =>
          resolvePublishedDateValue({ publishedAt: b.pubDate }) -
          resolvePublishedDateValue({ publishedAt: a.pubDate })
      );

    return json(200, { success: true, items, total: items.length }, CERT_EVENTS_CACHE_SECONDS);
  } catch (error) {
    context.error('publicListCertEvents failed:', errorFacts(error));
    return json(500, { error: 'Failed to list certification events' });
  }
}
