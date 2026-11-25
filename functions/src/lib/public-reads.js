/**
 * Public read endpoints — anonymous, cache-friendly replacements for the
 * browser's direct Firestore reads (api-surface.json rest.publicReads).
 *
 * These endpoints have no Site-Main backend source to port: the frontend read
 * Firestore directly and relied on security rules to scope what was visible.
 * The semantics here are derived from the consumers they replace —
 * useCoderCornerData.js (public filter, provider aliases), the detail
 * templates (content-then-legacy-blogs fallback, slug/Slug/id resolution),
 * usePodcastData.js, useNewsData.js, AboutPage/CustomSessionizeWidget
 * (_snapshots) — so the browser can swap fetch targets without behavior
 * change.
 *
 * Two rules every handler obeys:
 *   1. VISIBILITY FILTERED SERVER-SIDE. The browser used to apply
 *      isPublicDocument after Firestore rules; here the rules are gone, so the
 *      server is the only thing keeping drafts and soft-deleted docs out of
 *      anonymous responses. A non-public document 404s identically to a
 *      missing one.
 *
 *      Which filter depends on the collection, and this used to say
 *      "isPublicDocument" flatly, which was wrong in a way that mattered:
 *      `content` and `blogs` have an editorial workflow and use
 *      isPublicDocument; `podcasts` and `rss_cache` have none and use
 *      isSoftDeleted (so did `ai_insights`, plus `active`, until its panel
 *      was retired on 2026-09-05 — T-765). Applying
 *      isPublicDocument to the latter two rejects every document — see the
 *      note on isSoftDeleted. The invariant is that a handler filters, not
 *      that every handler filters identically.
 *   2. NO ORDER BY ON published-date fields in Cosmos SQL. The published
 *      date lives under five aliases and ORDER BY silently drops documents
 *      missing the property — a legacy doc with only 'Published At' would
 *      vanish. Handlers fetch a bounded window and sort in memory on the
 *      resolved date, exactly as the frontend does today.
 *
 * Every handler answers with an ALLOWLIST of fields, never a stored document.
 * Writers keep operational state on the same documents these routes serve —
 * a generation or inspection failure, a job id, an actor, a grade, the
 * provenance of an audio take — and a denylist had to name each of those to
 * keep it private, so every field a writer added later was public until
 * someone noticed. Each list below is derived from what the public pages
 * read, and public-reads.allowlist.test.js pins it against the frontend
 * source, so a field is public only when it is listed on purpose. Where the
 * read is a query, the list is also the SQL projection; the code filter runs
 * either way, so a point read and a query answer the same shape.
 *
 * The snapshot read is the exception: its sanitizers in
 * lib/snapshots-publish.js are the allowlist, applied when a snapshot is
 * published, and `stripInternalFields` stays here as defence in depth.
 */

import {
  getContent,
  getSnapshot,
  listContent,
} from './public-read-content.js';
import { getCuratedImage, getCuratedImages } from './public-read-images.js';
import {
  getFeed,
  getListenAndLearn,
  listCertEvents,
  listListenAndLearnEpisodes,
  listPodcasts,
} from './public-read-audio.js';
import { getInterview, listInterviews } from './public-read-interviews.js';

export {
  CONTENT_VISIBILITY_FIELDS,
  CURATED_IMAGE_BATCH_MAX,
  MAIN_PODCAST_PROVIDER,
  NEVER_PUBLIC_STATUSES,
  PROVIDER_ALIASES,
  PUBLIC_CONTENT_DETAIL_FIELDS,
  PUBLIC_CONTENT_LIST_FIELDS,
  PUBLIC_FEED_CACHE_FIELDS,
  PUBLIC_LISTEN_AND_LEARN_EPISODE_FIELDS,
  PUBLIC_LISTEN_AND_LEARN_SET_FIELDS,
  PUBLIC_PODCAST_FIELDS,
  RETIRED_LISTEN_AND_LEARN_AUDIO_HOSTS,
  RETIRED_PODCAST_MEDIA_HOSTS,
  SQL_NOT_SOFT_DELETED,
  SQL_PUBLIC_CLAUSE,
  isPodcastMediaRetired,
  isPublicDocument,
  isSoftDeleted,
  projectFields,
  resolveFeedUrlForProvider,
  resolveMainFeedUrl,
  resolvePublishedDateValue,
  servableListenAndLearnAudioUrl,
  stripInternalFields,
} from './public-read-rules.js';
export {
  PUBLIC_INTERVIEW_DETAIL_FIELDS,
  PUBLIC_INTERVIEW_LIST_FIELDS,
  projectInterview,
} from './public-read-interviews.js';

/**
 * @param {object} deps
 * @param {{ queryDocs: Function, readDoc: Function }} deps.store
 */
export function createPublicReadHandlers({ store }) {
  return {
    listContent: (request, context) => listContent(store, request, context),
    listInterviews: (request, context) => listInterviews(store, request, context),
    getInterview: (request, context) => getInterview(store, request, context),
    getContent: (request, context) => getContent(store, request, context),
    getCuratedImage: (request, context) => getCuratedImage(store, request, context),
    getCuratedImages: (request, context) => getCuratedImages(store, request, context),
    getSnapshot: (request, context) => getSnapshot(store, request, context),
    listPodcasts: (request, context) => listPodcasts(store, request, context),
    getFeed: (request, context) => getFeed(store, request, context),
    getListenAndLearn: (request, context) => getListenAndLearn(store, request, context),
    listListenAndLearnEpisodes: (request, context) => listListenAndLearnEpisodes(store, request, context),
    listCertEvents: (request, context) => listCertEvents(store, request, context),
  };
}
