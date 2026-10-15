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

const json = (status, body, cacheSeconds = 0) => ({
  status,
  headers: {
    'Content-Type': 'application/json',
    ...(cacheSeconds > 0 ? { 'Cache-Control': `public, max-age=${cacheSeconds}` } : {}),
  },
  body: JSON.stringify(body),
});

/**
 * The labels a document's provider field may carry, per provider key. It
 * began as a mirror of the frontend's useCoderCornerData.js, whose copy moved
 * here; its keys are now the providers the public API knows, and must match
 * VALID_PROVIDERS in frontend/src/context/ProviderContext.jsx
 * (public-section-counts.test.js holds the list). Docker since #776: without
 * it `?provider=docker` fell back to `['docker', 'DOCKER']` and missed
 * `Docker`, and `listCertEvents` answered 400 for `platform=docker`.
 */
export const PROVIDER_ALIASES = {
  aws: ['AWS', 'Aws', 'aws'],
  azure: ['Azure', 'azure'],
  gcp: ['GCP', 'Gcp', 'gcp', 'Google Cloud'],
  finops: ['FinOps', 'Finops', 'finops'],
  github: ['Github', 'GitHub', 'github'],
  terraform: ['Terraform', 'terraform'],
  vmware: ['VMware', 'Vmware', 'vmware'],
  ansible: ['Ansible', 'ansible'],
  docker: ['Docker', 'docker'],
};

/**
 * Mirrors isPublicDocument in useCoderCornerData.js, plus the normalized
 * 'published' status the new state machine writes (the frontend's
 * 'published_blog' set predates it — both must pass or freshly published
 * documents disappear from public pages).
 */
const PUBLIC_STATUSES = new Set([
  'published',
  'published_blog',
  'published_news',
  'published_both',
]);

/**
 * Statuses that are never public, whatever else a document says.
 *
 * `drafting` is the Drafts stage (lib/cms/content-status.js
 * DRAFTS_STAGE_STATUS; a literal here because content-status imports this
 * module's provider registry through content-update-validation, and the cycle
 * would run before either finished loading). A draft is written Live false
 * and Status 'Draft' and no Drafts route can change either, so it already
 * fails every disjunct below; this makes the answer not depend on that.
 * drafts.test.js holds the literal to the constant.
 */
export const NEVER_PUBLIC_STATUSES = Object.freeze(new Set(['drafting']));

export function isPublicDocument(doc = {}) {
  if (!doc) return false;
  if (isSoftDeleted(doc)) return false;
  if (NEVER_PUBLIC_STATUSES.has(String(doc.contentStatus || ''))) return false;
  return (
    doc.Live === true ||
    doc.Status === 'Live' ||
    PUBLIC_STATUSES.has(String(doc.contentStatus || ''))
  );
}

/**
 * The half of `isPublicDocument` that applies to every collection.
 *
 * `isPublicDocument` combines two independent questions: has this document been
 * deleted, and has it been published. Only the first is universal. Publication
 * status is the *editorial content* model — `Live`, `Status`, `contentStatus` —
 * and three of the collections served anonymously have no editorial workflow at
 * all:
 *
 *   - `rss_cache` is a fetch cache, refilled by a scheduled job with a 7-day
 *     TTL (`infra/cosmos-containers.json`). Its documents are `{provider,
 *     feedName, items[]}`.
 *   - `podcasts` is indexed on `provider + publishedAt`, with no status field.
 *   - `ai_insights` was read here until 2026-09-05 (T-765): nothing in this
 *     repository ever wrote it, so the panel it fed was retired and the
 *     query with it. The container and its migrated documents remain until
 *     the owner drops them in an apply of their own.
 *
 * T-202 prescribed `.filter(isPublicDocument)` on the podcasts and feed
 * handlers. Applied literally it would have returned `false` for **every**
 * document in all three, silently emptying the podcasts page, the news feed and
 * the (since retired) insights panel — the same shape of failure as T-101, arrived at through a
 * security fix. The contract the module header states ("the server must
 * filter") is honoured by applying the part that is actually meaningful.
 *
 * If a publication workflow is ever added to one of these collections, the
 * corresponding handler should move to `isPublicDocument`.
 */
export function isSoftDeleted(doc = {}) {
  return Boolean(doc?.softDeletedAt || doc?.softDeleteExpiresAt);
}

/**
 * Media hosts the show has left, each with the moment it left (#372).
 *
 * PodBean's CDN answered 404 for every stored episode from 2026-09-05, after
 * the show left it; the rows stayed in `podcasts` because #348 only stopped
 * the timer from polling the feed. A row whose file is gone is a player that
 * plays nothing, so the public list hides it. The rows themselves are kept,
 * and a row marked `mediaUnavailableAt` by any future liveness check is
 * hidden the same way.
 *
 * A HOST AND A MOMENT, NOT A HOST ALONE. This was a bare host list until
 * 2026-10-13, when the show moved from RSS.com back to Podbean: every current
 * episode's file is on mcdn.podbean.com again, so the bare list hid the whole
 * show, and the public list showed one stale RSS.com upload instead of three
 * episodes. What separates a dead row from a live one on the same host is
 * whether the current feed still carries it. fetchPodcastFeeds upserts every
 * episode it reads, with a fresh `updatedAt`, every two hours. So a row on a
 * host the show has left is hidden only when nothing has refreshed it since
 * the show left. A row the current feed carries is refreshed within two hours
 * and shows, whatever its host. A row on a host the show still uses is never
 * hidden here: a stalled timer must not empty the page.
 */
/**
 * A hostname as the retired-host lists spell it: lower case, with the
 * trailing dot of a fully qualified form removed. `new URL` keeps that dot,
 * so `mcdn.podbean.com.` would otherwise miss the entry for the same host
 * (CodeRabbit on #1121).
 */
const retiredHostKey = (hostname) => String(hostname).toLowerCase().replace(/\.$/, '');

export const RETIRED_PODCAST_MEDIA_HOSTS = Object.freeze([
  // Podbean's first tenure ended 2026-09-05. The show returned on 2026-10-13,
  // so a Podbean row last refreshed before the return is from the first one.
  Object.freeze({ host: 'mcdn.podbean.com', leftAt: '2026-10-13T00:00:00.000Z' }),
  Object.freeze({ host: 'feed.podbean.com', leftAt: '2026-10-13T00:00:00.000Z' }),
  // RSS.com's feed answered 301 to Podbean from 2026-10-13 about 05:50 UTC.
  Object.freeze({ host: 'media.rss.com', leftAt: '2026-10-13T06:00:00.000Z' }),
  Object.freeze({ host: 'content.rss.com', leftAt: '2026-10-13T06:00:00.000Z' }),
]);

/**
 * Whether the public podcast list (and the section counts that mirror it)
 * should hide this episode because its file is not, or is no longer, the
 * show's: a liveness check marked it (`mediaUnavailableAt`), or its media is
 * on a host in RETIRED_PODCAST_MEDIA_HOSTS and nothing has refreshed it since
 * the show left that host.
 *
 * @param {{ mediaUrl?: string, updatedAt?: string, mediaUnavailableAt?: string }} [doc]
 *   A `podcasts` row, or the projection of one that carries these fields.
 * @returns {boolean} true to hide the row; false for any row on a host the show
 *   has not left, and for a row with no media URL or one that does not parse.
 */
export function isPodcastMediaRetired(doc = {}) {
  if (doc.mediaUnavailableAt) return true;
  const url = String(doc.mediaUrl || '');
  if (!url) return false;
  let hostname;
  try {
    hostname = retiredHostKey(new URL(url).hostname);
  } catch {
    return false;
  }
  const retired = RETIRED_PODCAST_MEDIA_HOSTS.find((entry) => entry.host === hostname);
  if (!retired) return false;
  // No refresh time at all means nothing has refreshed it: hide it.
  const refreshed = Date.parse(doc.updatedAt || '');
  return !(refreshed >= Date.parse(retired.leftAt));
}

/**
 * Hosts Listen & Learn audio used to be served from and no longer is (#1119).
 * The pre-Azure site kept episode MP3s in Firebase Storage; every such file
 * answered 404 on 2026-10-13, while the rows still named them, so the audio
 * page rendered three players that played nothing. Listen & Learn audio is
 * served through `GET /api/public/media/…` (ADR 0029), so a row on one of
 * these hosts is a dead player until its chapter is regenerated (Admin →
 * Listen & Learn → Regenerate), and the public reads treat it as having no
 * audio: the list and the counts omit it, and the per-certification read
 * blanks `audioUrl` so the page shows the chapter without a player.
 */
export const RETIRED_LISTEN_AND_LEARN_AUDIO_HOSTS = Object.freeze([
  'storage.googleapis.com',
  'firebasestorage.googleapis.com',
]);

/** The `audioUrl` the public reads hand out: the row's, or '' when its host is retired. */
export function servableListenAndLearnAudioUrl(doc = {}) {
  const url = typeof doc?.audioUrl === 'string' ? doc.audioUrl : '';
  if (!url) return '';
  let hostname;
  try {
    hostname = retiredHostKey(new URL(url, 'https://www.hybridcloudworks.com').hostname);
  } catch {
    return '';
  }
  return RETIRED_LISTEN_AND_LEARN_AUDIO_HOSTS.includes(hostname) ? '' : url;
}

/** Published-date resolution across the five aliases (useCoderCornerData). */
export function resolvePublishedDateValue(doc = {}) {
  const candidate =
    doc.publishedDate ||
    doc.datePublished ||
    doc['Published At'] ||
    doc.blogPublishedAt ||
    doc.publishedAt ||
    null;
  if (!candidate) return 0;
  const parsed = candidate?.toDate ? candidate.toDate() : new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

/**
 * Internal fields stripped from a published snapshot (getSnapshot) as defence
 * in depth behind its publish-time sanitizers. No other read relies on this
 * list: each answers with its own allowlist (`projectFields`) — see header.
 */
const INTERNAL_FIELDS = [
  'reviewNotes',
  'reviewedBy',
  'createdBy',
  'updatedBy',
  'contentQuality',
  'imageQuality',
  'imageReadiness',
  'imageLineage',
  'forgeMeta',
  'critiqueVerdict',
  'critiqueGenericityScore',
  'critiqueSpecificityScore',
  'critiqueIssues',
];

/**
 * A snapshot document or item without the denylisted fields and Cosmos
 * system properties. Defence in depth for getSnapshot only — see INTERNAL_FIELDS.
 *
 * @param {object} doc
 * @returns {object} a shallow copy without INTERNAL_FIELDS or `_`-prefixed keys
 */
export function stripInternalFields(doc) {
  const out = { ...doc };
  for (const field of INTERNAL_FIELDS) delete out[field];
  // Cosmos system properties are meaningless to the browser.
  for (const key of Object.keys(out)) {
    if (key.startsWith('_')) delete out[key];
  }
  return out;
}

/**
 * Copy the named fields a document holds, and nothing else: the boundary
 * between a stored document and an anonymous response.
 *
 * Named rather than spread, so a field a writer adds later stays off the
 * public API until someone lists it. Only own properties are read, and an
 * undefined field is omitted rather than padded, so the projection of an
 * older document has the shape it always had.
 *
 * @param {object|null|undefined} doc a stored document, or a projected row of one
 * @param {readonly string[]} fields the allowlist
 * @returns {object} a new object holding the listed fields `doc` defines
 */
export function projectFields(doc, fields) {
  const out = {};
  if (!doc || typeof doc !== 'object') return out;
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(doc, field) && doc[field] !== undefined) {
      out[field] = doc[field];
    }
  }
  return out;
}

/**
 * An allowlist as a Cosmos SQL projection, `c["…"]`-quoted so spaced and
 * cased names (`Published At`, `CD Url`) survive. A function declaration so
 * the module-level constants below can use it before this line runs.
 *
 * @param {readonly string[]} fields
 * @returns {string} e.g. `c["id"], c["Published At"]`
 */
function sqlProjection(fields) {
  return fields.map((f) => `c["${f}"]`).join(', ');
}

const LIST_DEFAULT_LIMIT = 60;
// Ceiling matches the widest client fetch window (useFrameworkData and
// useProviderLandingContent ask for 250 and filter by provider client-side —
// a smaller cap would silently hide older provider-specific documents).
const LIST_MAX_LIMIT = 250;
// The in-memory sort window. Bounded so a runaway container can't OOM the
// handler. This used to be the failure threshold too: with no WHERE clause the
// window applied to ALL documents, and the file's own comment noted content is
// ~1k docs total — the bound and the count were the same number, past which
// published articles vanish arbitrarily. The public filter now runs in SQL
// (see listContent), so the window applies to the PUBLISHED subset of the
// requested type/provider, which moves the threshold far from the data
// (T-206).
const FETCH_WINDOW = 1000;

/**
 * The SQL half of the public filter (T-206), mirroring
 * `isPublicDocument` — which STILL runs on every row afterwards. Two layers on
 * purpose, with an asymmetry that matters:
 *
 *  - The SQL layer exists so `TOP ${FETCH_WINDOW}` counts published documents,
 *    not all documents. It is deliberately written WIDE: where JS truthiness
 *    and SQL comparison could disagree (a soft-delete marker holding '', 0 or
 *    false is NOT deleted to `isSoftDeleted`), the SQL admits the row and lets
 *    the JS filter decide. Erring wide costs a few rows of window; erring
 *    narrow silently drops a published article, which is this finding's
 *    defect reintroduced through its own fix.
 *  - The JS layer stays the authority. If the two ever disagree, the response
 *    is what `isPublicDocument` says, and the SQL only affects which rows made
 *    the window.
 *
 * PUBLIC_STATUSES is inlined as literals rather than parameterized because the
 * values are this module's own constants, not caller input.
 */
/**
 * EXPORTED so `public-section-counts.js` can ask the same question of the same
 * containers. Those counts decide whether a section page is advertised in
 * `sitemap.xml` (issue #373), and a count taken through a different filter than
 * the page's own would be a number about a different set of documents — the
 * failure being that a page showing articles is dropped from the sitemap
 * because something else called them unpublished.
 */
export const SQL_PUBLIC_CLAUSE =
  '(c.Live = true OR c.Status = "Live" OR c.contentStatus IN ' +
  `(${[...PUBLIC_STATUSES].map((s) => `"${s}"`).join(', ')}))`;

/** A marker counts as set only when it holds a JS-truthy value — see above. */
const sqlNotTruthy = (field) =>
  `(NOT IS_DEFINED(c.${field}) OR IS_NULL(c.${field}) OR c.${field} = "" OR c.${field} = false OR c.${field} = 0)`;

export const SQL_NOT_SOFT_DELETED = `${sqlNotTruthy('softDeletedAt')} AND ${sqlNotTruthy('softDeleteExpiresAt')}`;

/**
 * What the public LIST endpoint returns per document (T-206).
 *
 * This replaces `SELECT *`, which transferred whole documents — body fields
 * included — at ~20 KB average, making one anonymous list request the dominant
 * RU line (~12–24k RU against a 5,000 RU/s serverless budget: two concurrent
 * page loads were enough for 429s).
 *
 * The list is NOT guessed and NOT copied from the admin projection
 * (cms-content.js ADMIN_CONTENT_SNAPSHOT_FIELDS): it is the union of every
 * field the public list consumers actually read, from a file-by-file audit of
 * useCoderCornerData / useBlogData / useFrameworkData /
 * useProviderLandingContent, the five provider ArchitecturePages, SocialHubPage
 * and LivePagesPage, following items through every spread and normalizer.
 * A missing field here silently renders blank on a public page, so
 * public-reads.test.js pins the audited requirements against this list —
 * removing an entry fails a test naming the consumer that needs it.
 *
 * Of the nine heavy body fields, exactly ONE is read by a list consumer:
 * `explanation`, a third-priority excerpt fallback in useCoderCornerData
 * (:41, :53). `content`/`Content`/`postContent`/`blogDraft`/`overviewHtml`/
 * `codeSnippet`/`commandExample`/`sidebarContent` are read only by DETAIL
 * consumers (blogUtils normalizeContentFields), so this projection must stay
 * scoped to listContent — getContent answers PUBLIC_CONTENT_DETAIL_FIELDS
 * below, which adds them.
 */
export const PUBLIC_CONTENT_LIST_FIELDS = [
  // identity / typing
  'id',
  'type',
  'contentType',
  'publishTarget',
  'targetLandingZone',
  // titles and copy (excerpt fallbacks included — see header for explanation)
  'Title',
  'title',
  'name',
  'Summary',
  'summary',
  'description',
  'excerpt',
  'explanation',
  // slugs, categorisation, tags
  'slug',
  'Slug',
  'category',
  'Category',
  'primaryCategory',
  'complexity',
  'Complexity',
  'technicalLevel',
  'TechnicalLevel',
  'level',
  'tags',
  'Tags',
  'keyTopics',
  'featured',
  'Featured',
  // visibility — what isPublicDocument and the workflow badges read
  'Live',
  'Status',
  'contentStatus',
  'softDeletedAt',
  'softDeleteExpiresAt',
  // provider spellings
  'Cloud Provider',
  'cloudProvider',
  'provider',
  'Provider',
  'primaryProvider',
  // the five published-date aliases plus recency fields
  'publishedDate',
  'datePublished',
  'Published At',
  'blogPublishedAt',
  'publishedAt',
  'updatedAt',
  'createdAt',
  // links
  'slugPageUrl',
  'expectedPublicUrl',
  'publishedUrl',
  'publicUrl',
  'blogUrl',
  'curatedSubpagePath',
  'sourceUrl',
  'url',
  'CD Url',
  'Source URL',
  'link',
  'docLink',
  // reading stats and attribution
  'readTime',
  'ReadTime',
  'wordCount',
  'WordCount',
  'words',
  'editorAuthor',
  'siteAuthor',
  'publishedByName',
  'createdByName',
  // imagery
  'contentImageUrl',
  'altCoverImage',
  'altCoverImageVariants',
  'imageUrl',
  'ImageUrl',
  'coverImage',
  'thumbnail',
  // coder corner cards
  'language',
  'stack',
  'repoUrl',
  'icon',
  'categoryColor',
  // architecture cards
  'costColor',
  'cost',
  'costAnalysis',
  'rpo',
  'RPO',
  'rto',
  'RTO',
  'waf',
  'wellArchitectedScore',
  // framework pages (arrays project whole; element fields ride along)
  'frameworkConcepts',
  'frameworkNodes',
  'frameworkPillars',
  'keyPillars',
  'pillars',
  'officialSources',
  'frameworkSourceUrls',
  'sourceUrls',
  'architectureRecommendation',
  'recommendation',
  'summaryRecommendation',
  // Not the framework builder's generation prompts (`framework*Prompt`): they
  // are admin-side inputs, no public page renders them, and the review board
  // and the builder read them through the editor-gated cms routes.
  // cross-document identity (LivePages delete path, SocialHub dedup)
  'sourceContentId',
  'publishedContentId',
  'publishedBlogId',
  'blogId',
];

/** `c["Cover Image"]`-style quoting handles spaced and cased names. */
const LIST_PROJECTION = PUBLIC_CONTENT_LIST_FIELDS.map((f) => `c["${f}"]`).join(', ');

/**
 * The fields `isPublicDocument` reads. The detail query projects them so the
 * visibility filter can run, and the detail response leaves them out: no
 * detail template reads them, and a published page has no use for its own
 * workflow state. The preview adds `contentStatus` back for its banner.
 */
const CONTENT_VISIBILITY_FIELDS = Object.freeze([
  'Live',
  'Status',
  'contentStatus',
  'softDeletedAt',
  'softDeleteExpiresAt',
]);

/**
 * What the public DETAIL endpoint returns per document (getContent), and the
 * base of the signed preview (public-preview.js PUBLIC_PREVIEW_FIELDS).
 *
 * Two parts. First, the list projection less the visibility markers: those
 * fields are already public for every document this endpoint can return, so
 * the detail never answers with less than the list did for the same article.
 * Second, the fields only a detail page reads, from a file-by-file audit of
 * the three detail templates — BlogDetailTemplate (also the preview's body),
 * ArchitectureDetailTemplate (with MiniLandingFrame, WafAssessment,
 * ContextSidebar), FrameworkDetailTemplate — and the pre-render manifest
 * (public-content-manifest.js ARTICLE_FIELDS), whose items seed the
 * pre-rendered article.
 *
 * public-reads.allowlist.test.js pins this against the templates' source and
 * against ARTICLE_FIELDS: a template that starts reading a new field fails
 * there until the field is listed here. Object and array fields project
 * whole; their element fields ride along, as in the list projection.
 */
export const PUBLIC_CONTENT_DETAIL_FIELDS = Object.freeze([
  ...new Set([
    ...PUBLIC_CONTENT_LIST_FIELDS.filter((f) => !CONTENT_VISIBILITY_FIELDS.includes(f)),
    // bodies — BlogDetailTemplate post.body, FrameworkDetailTemplate and
    // ArchitectureDetailTemplate overview, ContextSidebar
    'Content',
    'content',
    'blogDraft',
    'postContent',
    'overviewHtml',
    'overview',
    'sidebarContent',
    // code — BlogDetailTemplate CoderCornerSnippet, the Implementation tabs
    'code',
    'codeSnippet',
    'codeLanguage',
    'terraformCode',
    'commandExample',
    // imagery — BlogDetailTemplate hero and its responsive variants
    'heroImageUrl',
    'aiImageUrls',
    'aiImageVariants',
    // attribution — the pre-render manifest keeps it
    'Author',
    // architecture blueprint — ArchitectureDetailTemplate and MiniLandingFrame
    'promise',
    'outcome',
    'diagramUrl',
    'diagramXml',
    'hotspots',
    'topology',
    'howItWorks',
    'keyServices',
    'services',
    'practices',
    'technicalSpecs',
    'whenNotToUse',
    'finopsCostTraps',
    'deploymentSteps',
    'estimatedCost',
    'interactiveLabId',
    'ecosystemPartnerValidation',
    'landingZonePreset',
    'demoUrl',
    'relatedArchitectures',
    // framework — FrameworkDetailTemplate radar and Pillars tab
    'maturityScores',
    'patterns',
  ]),
]);

/** The detail query's projection: the response allowlist plus what the visibility filter reads. */
const CONTENT_DETAIL_PROJECTION = sqlProjection([
  ...PUBLIC_CONTENT_DETAIL_FIELDS,
  ...CONTENT_VISIBILITY_FIELDS,
]);

/**
 * Document ceilings for the feed endpoint (T-203).
 *
 * These are runaway guards, NOT page sizes, and the distinction is the whole
 * of why they are not smaller. T-203 suggested sizing them to "what
 * useNewsData.js renders", which is 30 — but 30 is the count of *items* the
 * client keeps after flattening every `cache.items[]` array together and
 * sorting by `pubDate`. One `rss_cache` document is one FEED, holding many
 * items. `TOP 30` would therefore bound feeds, not articles, and a provider
 * with more feeds than the ceiling would lose whole feeds' worth of recent
 * news.
 *
 * Worse, it would lose an *arbitrary* set of them: there is no ORDER BY here,
 * and there deliberately is not. Rule 2 in the module header forbids ordering
 * on a field that may be absent, because Cosmos drops documents missing the
 * sort key — and `lastFetched` / `generatedAt` are only in the containers'
 * composite indexes, which does not guarantee presence. So `TOP N` returns an
 * arbitrary N, which is acceptable precisely because N is set above the
 * realistic document count: the arbitrary case only arises once a container
 * has already run away, which is the case being defended against.
 *
 * Do not tighten these to a render count.
 */
const FEED_CACHE_MAX_DOCS = 200;

/**
 * Items served per `rss_cache` document (T-319).
 *
 * FEED_CACHE_MAX_DOCS bounds the number of feeds; this bounds the number of
 * articles inside each one, which is the other half of the same runaway. One
 * document holds a whole feed, so a hundred bounded documents can still be an
 * unbounded anonymous response — and `items[]` is the part of the document
 * that grows with the world rather than with the site.
 *
 * The value equals the ingest writer's own cap (MAX_CACHE_ITEMS_PER_FEED in
 * rss/feeds.js), so a document written by the current writer is served whole
 * and this trim only engages on one that is not: a document written before
 * that cap existed, or one an unusually large feed produced. The two constants
 * are deliberately not shared by import — this module has no imports so the
 * anonymous read path cannot be broken by an ingest-side change — and
 * public-reads.test.js asserts they agree so the pair cannot silently drift.
 */
const FEED_CACHE_MAX_ITEMS_PER_DOC = 20;

/**
 * Listen & Learn containers and the per-set episode ceiling.
 *
 * Named here rather than imported from listen-and-learn/publish.js because
 * this module deliberately has no imports (see the getFeed ceiling note): the
 * anonymous read path must not be breakable by a change on the generation
 * side. public-reads.test.js asserts the names agree.
 *
 * Eight areas is the largest real study guide, so fifty is a runaway guard
 * rather than a page size.
 */
const LISTEN_AND_LEARN_SET_CONTAINER = 'listen_and_learn';
const LISTEN_AND_LEARN_EPISODE_CONTAINER = 'listen_and_learn_episodes';
const LISTEN_AND_LEARN_MAX_EPISODES = 50;

/**
 * The provider-wide episode list (#349) is a *listing*, so it carries what a
 * player and a list row need and nothing else. The per-certification read
 * adds the transcript, takeaways and videos because its page renders them
 * (PUBLIC_LISTEN_AND_LEARN_EPISODE_FIELDS below); the podcast page renders
 * none of those, and a transcript is the largest field on the document by an
 * order of magnitude. Allowlisted rather
 * than denylisted so a field added to the writer later is withheld here
 * until someone decides it belongs on an anonymous list.
 *
 * Two such decisions, recorded (#433, 2026-09-09). `kind` IS listed: a
 * listener-facing page may label a source-grounded episode as one, and a
 * row that cannot say what it was built from cannot be labelled honestly.
 * It is passed through as stored — absent on every episode written before
 * #433, which are all guide episodes (listen-and-learn/publish.js
 * `episodeKindOf` is the rule) — so rows for those episodes are exactly what
 * they were. `sources` is NOT listed: the URLs a source episode was built
 * from belong on a citation page beside the transcript, and no listener-facing
 * page renders one yet; until it exists they stay off the anonymous list.
 * The per-certification read keeps carrying `sources`, as it always has, for
 * the same reason it carries the transcript.
 *
 * Twenty sets of up to eight areas is far more than exists; the cap is a
 * runaway guard on a cross-partition query, not a page size.
 */
const LISTEN_AND_LEARN_LIST_FIELDS = [
  'id',
  'setId',
  'provider',
  'examCode',
  'areaSlug',
  'areaName',
  'kind',
  'order',
  'weightLabel',
  'title',
  'summary',
  'audioUrl',
  'audioBytes',
  'durationSeconds',
  'approvedAt',
  'generatedAt',
];
const LISTEN_AND_LEARN_MAX_LISTED = 200;

/**
 * The allowlist as a SQL projection, so the transcript never leaves Cosmos
 * for this route — projecting in JS after `SELECT *` still paid to read and
 * ship the largest field on every row. The soft-delete markers ride along
 * because `isSoftDeleted` reads them before the JS allowlist drops them; the
 * sets projection carries only what the join uses. Same `c["…"]` quoting as
 * LIST_PROJECTION above.
 */
const SOFT_DELETE_MARKERS = ['softDeletedAt', 'softDeleteExpiresAt'];
const LISTEN_AND_LEARN_LIST_PROJECTION = [...LISTEN_AND_LEARN_LIST_FIELDS, ...SOFT_DELETE_MARKERS]
  .map((f) => `c["${f}"]`)
  .join(', ');
const LISTEN_AND_LEARN_SET_PROJECTION = ['id', 'certTitle', 'certSlug', ...SOFT_DELETE_MARKERS]
  .map((f) => `c["${f}"]`)
  .join(', ');

/**
 * What the per-certification read (getListenAndLearn) returns per chapter:
 * the listing allowlist plus what the study page renders beside the player —
 * ListenAndLearn.jsx reads `keyTakeaways`, `videos` and `transcript`, and
 * EpisodePlaylist.jsx reads the listing fields. `sources` is kept because this
 * read has always carried it (see the note above).
 *
 * Everything else on a chapter is operational and stays off: a regeneration
 * failure kept on a chapter that stays published (`lastError`, `error`,
 * `audioError`), the take's provenance and cost (`speechProvider`,
 * `speechModel`, `audioPath`, `versions[]`), the approver and editors, and
 * the text a chapter was spoken from. public-reads.allowlist.test.js pins the
 * list against both components' source.
 */
export const PUBLIC_LISTEN_AND_LEARN_EPISODE_FIELDS = Object.freeze([
  ...LISTEN_AND_LEARN_LIST_FIELDS,
  'keyTakeaways',
  'transcript',
  'videos',
  'sources',
]);
const LISTEN_AND_LEARN_EPISODE_PROJECTION = sqlProjection([
  ...PUBLIC_LISTEN_AND_LEARN_EPISODE_FIELDS,
  ...SOFT_DELETE_MARKERS,
]);

/**
 * What the per-certification read returns of the set (book or course): its
 * public identity and the Audio Library fields an operator sets for display
 * (listen-and-learn/library.js). No current page reads `set`, so this keeps
 * the response's shape without its operational fields — the voice and its
 * provider, the run's actor, the guide's area slugs.
 */
export const PUBLIC_LISTEN_AND_LEARN_SET_FIELDS = Object.freeze([
  'id',
  'provider',
  'examCode',
  'kind',
  'certSlug',
  'certTitle',
  'title',
  'author',
  'description',
  'coverImageUrl',
  'tags',
  'studyGuideUrl',
  'studyGuideTitle',
  'areaCount',
]);

/**
 * What the podcast list returns per `podcasts` row: the episode shape the
 * ingest writes (timers/podcasts.js `buildPodcastEpisode`, every field of it
 * from the show's public feed) plus `createdAt`, and the `pubDate`/`date`
 * spellings the Recording Hub's episode list falls back to. Consumers:
 * lib/audioEpisodes.js `normalizeHostEpisode` and
 * components/admin/recording-hub/EpisodesTab.jsx.
 */
export const PUBLIC_PODCAST_FIELDS = Object.freeze([
  'id',
  'provider',
  'title',
  'description',
  'longDescription',
  'mediaUrl',
  'mimeType',
  'length',
  'duration',
  'image',
  'link',
  'guid',
  'publishedAt',
  'pubDate',
  'date',
  'updatedAt',
  'createdAt',
]);

/**
 * The podcast query's projection: the response allowlist plus what the
 * filters and the sort read and the response does not carry — the soft-delete
 * markers, `mediaUnavailableAt` (isPodcastMediaRetired) and the other
 * published-date aliases (resolvePublishedDateValue).
 */
const PODCAST_PROJECTION = sqlProjection([
  ...PUBLIC_PODCAST_FIELDS,
  ...SOFT_DELETE_MARKERS,
  'mediaUnavailableAt',
  'publishedDate',
  'datePublished',
  'Published At',
  'blogPublishedAt',
]);

/**
 * What the feed read returns per `rss_cache` document: the shape the ingest
 * writes (rss/ingest.js `cacheFeed`), every field of it feed metadata or the
 * feed's own items. useNewsData reads `items` and `feedName`.
 */
export const PUBLIC_FEED_CACHE_FIELDS = Object.freeze([
  'id',
  'provider',
  'feedName',
  'feedUrl',
  'items',
  'itemCount',
  'lastFetched',
  'refreshedAt',
]);
const FEED_CACHE_PROJECTION = sqlProjection([...PUBLIC_FEED_CACHE_FIELDS, ...SOFT_DELETE_MARKERS]);

/**
 * Certification lifecycle events (#461 item 4). Written by the Friday Skills
 * Hub RSS scraper (timers/skills-hub.js `buildCertEvent`): one document per
 * feed item that matched a lifecycle pattern, id derived from the feed guid,
 * `pubDate` stamped on every row (the scraper substitutes its own clock when
 * the feed omits one), `source: 'skills-hub-rss'`. Until this route existed
 * nothing read the container, and the Azure timeline was a static array
 * whose comment said otherwise.
 *
 * The documents carry no provider field — the one writer is Microsoft's
 * feed — so the platform query is answered by SOURCE: each platform names
 * the scraper sources that feed it, and a platform with none listed answers
 * an empty list without a query. A second scraper registers here by adding
 * its `source` value under its platform. Names copied rather than imported
 * for the reason the Listen & Learn names above are: this module has no
 * imports, and public-reads.test.js asserts the copies agree with the writer.
 *
 * `ORDER BY c.pubDate DESC` is safe where the header's rule 2 forbids the
 * content aliases: the writer stamps `pubDate` on every document, so no row
 * is dropped by the sort. Allowlisted projection, for the same reason as the
 * episode list: `createdAt` is the scraper's clock and stays off the list.
 */
const CERT_EVENTS_CONTAINER = 'certEvents';
const CERT_EVENT_SOURCES_BY_PLATFORM = Object.freeze({ azure: Object.freeze(['skills-hub-rss']) });
const CERT_EVENT_FIELDS = [
  'id',
  'type',
  'certCodes',
  'title',
  'summary',
  'link',
  'pubDate',
  'mentionedDates',
  'source',
];
const CERT_EVENTS_MAX_LISTED = 100;
const CERT_EVENTS_CACHE_SECONDS = 3600;
const CERT_EVENT_PROJECTION = [...CERT_EVENT_FIELDS, ...SOFT_DELETE_MARKERS]
  .map((f) => `c["${f}"]`)
  .join(', ');

/**
 * Where the podcast timer reads its feed list (`fetchPodcastFeeds`, #348):
 * `admin_config/podcast_feeds`, shape
 * `{ mainFeedUrl, feeds: [{ provider, url }] }`. The public podcasts list
 * exposes the matching provider's URL as `feedUrl`, and the site's own show as
 * `mainFeedUrl`, so the page's RSS subscribe button and the timer's ingest
 * cannot name two different feeds (#349). Copied here for the same reason as
 * the container names above — this module has no imports — and
 * public-reads.test.js asserts the copies agree with timers/podcasts.js and
 * cosmos-client.js.
 */
const PODCAST_FEEDS_CONFIG_CONTAINER = 'admin_config';
const PODCAST_FEEDS_CONFIG_ID = 'podcast_feeds';
const PODCAST_FEEDS_CONFIG_PARTITION = 'admin_config';

/**
 * The `provider` the site's own show is filed under — a fourth copy of a name
 * this module may not import, asserted equal to `MAIN_FEED_PROVIDER` in
 * timers/podcasts.js by public-reads.test.js.
 *
 * It is exported because the SQL below and `public-section-counts.js` both
 * match on it: those rows are the site's show, they belong on every provider's
 * audio page, and a page they appear on must not be counted as empty.
 */
export const MAIN_PODCAST_PROVIDER = 'main';

/**
 * The configured feed URL for one provider, or null. Only an https URL is
 * ever returned: the document is editor-written, but the value lands in an
 * anonymous response as a link, and the timer applies the same test before
 * it will fetch a row (`isValidFeedEntry`).
 */
export function resolveFeedUrlForProvider(doc, provider) {
  const feeds = Array.isArray(doc?.feeds) ? doc.feeds : [];
  const row = feeds.find(
    (entry) =>
      entry &&
      entry.provider === provider &&
      typeof entry.url === 'string' &&
      /^https:\/\//.test(entry.url)
  );
  return row ? row.url : null;
}

/**
 * The site's show, or null. Same https-only rule as the provider rows above,
 * for the same reason: it is published to anonymous readers as a link.
 */
export function resolveMainFeedUrl(doc) {
  const url = typeof doc?.mainFeedUrl === 'string' ? doc.mainFeedUrl.trim() : '';
  return /^https:\/\//.test(url) ? url : null;
}

/**
 * Newest-first by `pubDate`, with undated items last in their stored order.
 *
 * Undated items sort to the tail rather than to "now": an item with no date is
 * the one we know least about, and treating a missing date as current would
 * let a malformed feed evict every dated article. Comparing for equality
 * before subtracting keeps two undated items at 0 rather than at `-Infinity -
 * -Infinity`, which is NaN — the sort is stable, so 0 preserves feed order.
 */
function feedItemTime(item) {
  const parsed = Date.parse(item?.pubDate ?? '');
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/**
 * Bound one `rss_cache` document's `items[]`, keeping the newest.
 *
 * Documents whose `items` is absent or not an array are returned untouched:
 * there is no array to bound, and inventing an empty one would turn a
 * malformed document into a plausible-looking empty feed.
 *
 * `itemCount` is rewritten alongside a trim because the writer's invariant is
 * `itemCount === items.length`; leaving the stored count would tell a client
 * there are items in the response that are not.
 */
function boundFeedItems(doc) {
  const items = doc?.items;
  if (!Array.isArray(items) || items.length <= FEED_CACHE_MAX_ITEMS_PER_DOC) return doc;

  const newest = [...items]
    .sort((a, b) => {
      const at = feedItemTime(a);
      const bt = feedItemTime(b);
      return at === bt ? 0 : bt - at;
    })
    .slice(0, FEED_CACHE_MAX_ITEMS_PER_DOC);

  return { ...doc, items: newest, itemCount: newest.length };
}

/**
 * A curated article's image changes only when someone regenerates it, so a HIT
 * is cached hard — and this is the endpoint a news page hits up to twelve times
 * per load, which is the other reason.
 *
 * A MISS is not, and the asymmetry is the point. Caching "there is no image"
 * for an hour means that after an admin generates one, visitors and any CDN in
 * front of them keep being told there is none until the hour is out — turning
 * "no image yet" into "no image for an hour", which is a slower version of the
 * bug this endpoint exists to fix. A minute still absorbs reloads without
 * making a freshly generated image wait.
 */
const CURATED_IMAGE_HIT_CACHE_SECONDS = 3600;
const CURATED_IMAGE_MISS_CACHE_SECONDS = 60;

/**
 * Ids the batched curated-image read will answer for in one request (T-739).
 *
 * The news grid asks for twelve. 50 leaves room for a longer grid without
 * making this an amplifier: an unbounded `ids` list on an anonymous endpoint
 * means one request can cost as many reads as the caller names, which is the
 * shape of the fan-out T-711 removed from the ops-health probe.
 */
export const CURATED_IMAGE_BATCH_MAX = 50;

/**
 * How many same-slug documents the detail lookup considers.
 *
 * Slugs are meant to be unique, so this is normally 1 row. It is >1 because
 * they are not *enforced* unique, and the previous `SELECT TOP 1` with no
 * `ORDER BY` picked arbitrarily among duplicates and only then asked whether
 * the winner was public — so a published article could 404 forever because an
 * unpublished draft shared its slug (T-305).
 *
 * `ORDER BY c._ts DESC` is safe here for a reason that does not generalize:
 * `_ts` is a system property Cosmos writes on every document, so the
 * "never ORDER BY on a possibly-missing field" rule — which silently drops
 * documents lacking the sort key — does not apply. No composite index is
 * needed; a filter plus a single-property ORDER BY runs on the range index
 * that `/*` already provides, at a slightly higher RU cost that a
 * near-unique predicate makes irrelevant.
 */
const SLUG_CANDIDATES = 10;

// Containers the list endpoint may serve. 'blogs' is the legacy fallback the
// list hooks query when 'content' comes back empty — the browser read it
// directly under the old Firestore rules, so exposing it (public-filtered,
// internal fields stripped) grants nothing new.
const LIST_SOURCES = new Set(['content', 'blogs']);

/**
 * @param {object} deps
 * @param {{ queryDocs: Function, readDoc: Function }} deps.store
 */
export function createPublicReadHandlers({ store }) {
  return {
    /**
     * GET /api/public/content?type=&provider=&limit=&offset=&source=
     * Returns each document projected to PUBLIC_CONTENT_LIST_FIELDS — in SQL,
     * and again in code — which is far more than card fields
     * (frameworkConcepts, featured, altCoverImageVariants, curatedSubpagePath,
     * costAnalysis, …) because the list consumers read them.
     *
     * @param {object} request the Functions HTTP request
     * @param {object} context the invocation context, for error logging
     */
    async listContent(request, context) {
      try {
        const type = String(request.query.get('type') || '')
          .trim()
          .toLowerCase();
        const provider = String(request.query.get('provider') || '')
          .trim()
          .toLowerCase();
        const requestedSource = String(request.query.get('source') || 'content').trim();
        if (!LIST_SOURCES.has(requestedSource)) {
          return json(400, { error: 'Invalid source' });
        }
        const limit = Math.min(
          Math.max(Number(request.query.get('limit')) || LIST_DEFAULT_LIMIT, 1),
          LIST_MAX_LIMIT
        );
        const offset = Math.max(Number(request.query.get('offset')) || 0, 0);

        // The public filter runs in SQL so the TOP window counts published
        // documents rather than all documents, and the projection replaces
        // `SELECT *` so a list request stops transferring article bodies —
        // both halves of T-206. `isPublicDocument` still re-filters
        // every row below; see SQL_PUBLIC_CLAUSE for why both layers exist.
        const clauses = [SQL_PUBLIC_CLAUSE, SQL_NOT_SOFT_DELETED];
        const parameters = [];
        if (type) {
          clauses.push('LOWER(c.type) = @type');
          parameters.push({ name: '@type', value: type });
        }
        if (provider) {
          const labels = PROVIDER_ALIASES[provider] || [provider, provider.toUpperCase()];
          clauses.push(
            '(ARRAY_CONTAINS(@providers, c["Cloud Provider"]) OR ARRAY_CONTAINS(@providers, c["cloudProvider"]))'
          );
          parameters.push({ name: '@providers', value: labels });
        }
        // T-206 step 3, behind a flag so deploy order is safe in either
        // direction. With PUBLIC_LIST_SQL_ORDER=1 the window becomes the
        // NEWEST N documents instead of an arbitrary N — the last part of the
        // finding. `cp_sortDate` is a COMPUTED property (defined on every
        // document, '' when no date alias is present), which is what makes
        // this exempt from rule 2's "never ORDER BY a possibly-missing field":
        // it cannot be missing.
        //
        // Three preconditions, all three required, learned the hard way on
        // 2026-08-21 when the flag went live and every list call failed with
        // "The index path corresponding to the specified order-by item is
        // excluded": (1) apply-computed-sortdate.mjs --inspect clean;
        // (2) the property exists, which the Terraform apply now guarantees
        // (azapi_update_resource.cosmos_computed_properties, #816); (3) `/cp_sortDate/?` is
        // an INCLUDED PATH in the container's indexing policy — computed
        // properties are not covered by the `/*` wildcard (Cosmos docs), and an
        // ORDER BY on an unindexed property is an error, not a slow query.
        // infra/cosmos-containers.json carries the path for content and blogs.
        // The in-memory sort below stays either way — it is the authority on
        // order exactly as isPublicDocument is on visibility.
        const orderBy =
          process.env.PUBLIC_LIST_SQL_ORDER === '1' ? ' ORDER BY c.cp_sortDate DESC' : '';
        const query = `SELECT TOP ${FETCH_WINDOW} ${LIST_PROJECTION} FROM c WHERE ${clauses.join(' AND ')}${orderBy}`;

        const rows = await store.queryDocs(requestedSource, query, parameters);
        const matching = rows
          .filter(isPublicDocument)
          .sort((a, b) => resolvePublishedDateValue(b) - resolvePublishedDateValue(a));
        const items = matching
          .slice(offset, offset + limit)
          .map((doc) => projectFields(doc, PUBLIC_CONTENT_LIST_FIELDS));

        // `total` is the number of matching documents, not the size of this
        // page — it was measured after the slice, so it always equalled
        // `items.length` and any paginating consumer would have concluded there
        // was exactly one page (T-407).
        //
        // It is still bounded by FETCH_WINDOW, so on a collection larger than
        // that it under-reports. That is a smaller lie than the page size and
        // it is the honest one available without a second COUNT query; a
        // consumer that needs an exact total needs the cursor API tracked in
        // T-206.
        return json(200, { success: true, items, total: matching.length }, 300);
      } catch (error) {
        context.error('publicListContent failed:', error);
        return json(500, { error: 'Failed to list content' });
      }
    },

    /**
     * GET /api/public/content/{slugOrId} — id, then slug/Slug in content,
     * then the same three lookups in legacy blogs: the fallback chain the
     * detail templates run client-side today, folded server-side.
     *
     * The item is projected to PUBLIC_CONTENT_DETAIL_FIELDS: in SQL for the
     * slug lookups, and in code for both paths, since a point read by id
     * always returns the whole document.
     *
     * @param {object} request the Functions HTTP request
     * @param {object} context the invocation context, for error logging
     */
    async getContent(request, context) {
      try {
        const slugOrId = String(request.params.slugOrId || '').trim();
        if (!slugOrId) return json(400, { error: 'slugOrId required' });

        for (const container of ['content', 'blogs']) {
          const byId = await store.readDoc(container, slugOrId, slugOrId);
          if (byId && isPublicDocument(byId)) {
            return json(
              200,
              {
                success: true,
                item: projectFields(byId, PUBLIC_CONTENT_DETAIL_FIELDS),
                source: container,
              },
              300
            );
          }
          for (const field of ['slug', 'Slug']) {
            const rows = await store.queryDocs(
              container,
              `SELECT TOP ${SLUG_CANDIDATES} ${CONTENT_DETAIL_PROJECTION} FROM c WHERE c["${field}"] = @slug ORDER BY c._ts DESC`,
              [{ name: '@slug', value: slugOrId }]
            );
            // `find`, not `rows[0] && isPublicDocument(...)`. Filtering after
            // taking one row meant a published article 404'd whenever an
            // unpublished document happened to share its slug and win the
            // arbitrary pick (T-305).
            const match = rows.find(isPublicDocument);
            if (match) {
              return json(
                200,
                {
                  success: true,
                  item: projectFields(match, PUBLIC_CONTENT_DETAIL_FIELDS),
                  source: container,
                },
                300
              );
            }
          }
        }
        // Non-public and missing answer identically — see header rule 1.
        return json(404, { error: 'Content not found' });
      } catch (error) {
        context.error('publicGetContent failed:', error);
        return json(500, { error: 'Failed to get content' });
      }
    },

    /**
     * GET /api/public/curated-image/{articleId} — the cached hero image for a
     * curated news article.
     *
     * This exists because the public news pages were calling an EDITOR-gated
     * endpoint. #63 moved the cache lookup off an anonymous Firestore read onto
     * `getJSON('cms/images/curated/...')`, which runs through `acquireApiToken`
     * and throws without an MSAL account — so on `/{provider}/news`, an
     * anonymous visitor's lookups all failed and no curated imagery rendered
     * where cached images used to (T-210).
     *
     * **Only `imageUrl` is returned, never the document.** The admin endpoint
     * answers with the whole thing, and the whole thing is not public: a
     * `curated_article_images` document also carries `storagePath` (an internal
     * blob path) and the prompt metadata the gallery writes — `promptSet`,
     * `promptName`, `promptTemplateVersion`, `theme`, `style`. That is
     * editorial IP and internal layout, and none of it is needed to render an
     * `<img>`.
     *
     * Archived images are withheld, which the finding did not ask for. It is a
     * deliberate hardening in the same direction as the module's other filters:
     * `archived` is set by an admin explicitly retiring an image, and the only
     * thing this can do is stop a retired image appearing on a public page.
     *
     * Absence answers 200 with `imageUrl: null`, not 404. The caller's question
     * is "is there a cached image?", and "no" is a successful answer to it —
     * matching the admin endpoint, whose `item: null` the hook already treats
     * as "not cached" rather than as an error.
     */
    async getCuratedImage(request, context) {
      try {
        const id = String(request.params.id || '').trim();
        if (!id) return json(400, { error: 'articleId required' });

        const doc = await store.readDoc('curated_article_images', id, id);
        // Trimmed, so a whitespace-only value is uncached rather than being
        // handed to the browser as an `<img src>` that resolves to the page
        // itself.
        const stored = typeof doc?.imageUrl === 'string' ? doc.imageUrl.trim() : '';
        const imageUrl = doc && doc.archived !== true && stored ? stored : null;

        return json(
          200,
          { success: true, imageUrl },
          imageUrl ? CURATED_IMAGE_HIT_CACHE_SECONDS : CURATED_IMAGE_MISS_CACHE_SECONDS
        );
      } catch (error) {
        context.error('publicGetCuratedImage failed:', error);
        return json(500, { error: 'Failed to get curated image' });
      }
    },

    /**
     * GET /api/public/curated-images?ids=a,b,c — the same lookup as
     * `getCuratedImage`, for a whole grid in one round trip (T-739).
     *
     * The news grid rendered twelve cards and issued twelve
     * `public/curated-image/{id}` requests, on a route that had already
     * fetched the feed. Twelve round trips before any cover appeared.
     *
     * **Every disclosure rule of the single-id route applies here unchanged**,
     * and that is the property to protect if this is ever edited: only
     * `imageUrl` is returned, never the document — a `curated_article_images`
     * row also carries `storagePath` and the gallery's prompt metadata
     * (`promptSet`, `promptName`, `promptTemplateVersion`, `theme`, `style`),
     * which is editorial IP and internal layout. Archived images are withheld,
     * and a whitespace-only value is treated as uncached rather than handed to
     * a browser as an `<img src>` that resolves to the page itself.
     * `public-reads.curated-images.test.js` asserts the two routes agree, so a
     * change to one that is not made to the other fails.
     *
     * Absence is a null entry, not an omission and not a 404: the caller's
     * question is "which of these have covers?", and "this one does not" is a
     * successful answer that the client needs in order to stop asking.
     *
     * Bounded at `CURATED_IMAGE_BATCH_MAX`. An unbounded `ids` list on an
     * anonymous endpoint is a point-read amplifier — one request costing as
     * many reads as the caller cares to name — which is the shape of the
     * fan-out T-711 removed from the ops-health probe.
     */
    async getCuratedImages(request, context) {
      try {
        const raw = String(request.query?.get?.('ids') ?? '').trim();
        if (!raw) return json(400, { error: 'ids required' });

        const ids = [
          ...new Set(
            raw
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean)
          ),
        ];
        if (ids.length === 0) return json(400, { error: 'ids required' });
        if (ids.length > CURATED_IMAGE_BATCH_MAX) {
          return json(400, { error: `At most ${CURATED_IMAGE_BATCH_MAX} ids per request` });
        }

        // One query rather than N point reads — the same shape T-711 applied
        // to the orphan probe. `images` is keyed by id so a caller can tell
        // "no cover" from "not asked about".
        const rows = await store.queryDocs(
          'curated_article_images',
          'SELECT c.id, c.imageUrl, c.archived FROM c WHERE ARRAY_CONTAINS(@ids, c.id)',
          [{ name: '@ids', value: ids }]
        );

        const byId = new Map((rows || []).map((row) => [row.id, row]));
        const images = {};
        let anyHit = false;
        for (const id of ids) {
          const doc = byId.get(id);
          const stored = typeof doc?.imageUrl === 'string' ? doc.imageUrl.trim() : '';
          const imageUrl = doc && doc.archived !== true && stored ? stored : null;
          images[id] = imageUrl;
          if (imageUrl) anyHit = true;
        }

        // The shorter miss TTL when nothing was found, so a grid whose covers
        // are still generating is not pinned to the long hit TTL.
        return json(
          200,
          { success: true, images },
          anyHit ? CURATED_IMAGE_HIT_CACHE_SECONDS : CURATED_IMAGE_MISS_CACHE_SECONDS
        );
      } catch (error) {
        context.error('publicGetCuratedImages failed:', error);
        return json(500, { error: 'Failed to get curated images' });
      }
    },

    /**
     * GET /api/public/snapshots/{id} — the build-time projections that
     * PublishSnapshotButton writes. Allowlisted to the two snapshots public
     * pages consume; this endpoint must not become a generic container read.
     */
    async getSnapshot(request, context) {
      const PUBLIC_SNAPSHOTS = new Set(['certifications', 'speakerevents']);
      try {
        const id = String(request.params.id || '').trim();
        if (!PUBLIC_SNAPSHOTS.has(id)) return json(404, { error: 'Snapshot not found' });
        const doc = await store.readDoc('_snapshots', id, id);
        if (!doc) return json(404, { error: 'Snapshot not found' });

        // Defence in depth. The publish-side sanitizers
        // (lib/snapshots-publish.js) are the real boundary — they decide which
        // fields exist in the stored snapshot at all. But stripInternalFields
        // used to be applied to the wrapper only, so `createdBy` and
        // `updatedBy` inside items[] were never reached, and a collection with
        // no sanitizer leaked wholesale (T-201).
        //
        // Descending here means a future snapshot collection added without a
        // sanitizer still cannot publish admin emails. It is not a substitute
        // for the sanitizer: a missing one still leaks every non-internal
        // field, and display:false rows.
        const snapshot = stripInternalFields(doc);
        if (Array.isArray(snapshot.items)) {
          snapshot.items = snapshot.items.map((item) =>
            item && typeof item === 'object' && !Array.isArray(item)
              ? stripInternalFields(item)
              : item
          );
        }
        return json(200, { success: true, snapshot }, 600);
      } catch (error) {
        context.error('publicGetSnapshot failed:', error);
        return json(500, { error: 'Failed to get snapshot' });
      }
    },

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
    async listPodcasts(request, context) {
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
        context.error('publicListPodcasts failed:', error);
        return json(500, { error: 'Failed to list podcasts' });
      }
    },

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
    async getFeed(request, context) {
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
        context.error('publicGetFeed failed:', error);
        return json(500, { error: 'Failed to get feed' });
      }
    },

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
    async getListenAndLearn(request, context) {
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
        context.error('publicGetListenAndLearn failed:', error);
        return json(500, { error: 'Failed to get Listen & Learn episodes' });
      }
    },

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
    async listListenAndLearnEpisodes(request, context) {
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
        context.error('publicListListenAndLearnEpisodes failed:', error);
        return json(500, { error: 'Failed to list Listen & Learn episodes' });
      }
    },

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
    async listCertEvents(request, context) {
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
        context.error('publicListCertEvents failed:', error);
        return json(500, { error: 'Failed to list certification events' });
      }
    },
  };
}
