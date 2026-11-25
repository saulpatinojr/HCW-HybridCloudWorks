/**
 * public-read-rules.js — what the public read routes share: which documents
 * are public, the provider labels, published dates, the field allowlists and
 * their SQL projections, and the feed helpers. The rules behind each are
 * described at the top of public-reads.js, which re-exports the public names
 * so callers and tests import what they always did.
 */

/** A JSON answer, cacheable for `cacheSeconds` when given. */
export const json = (status, body, cacheSeconds = 0) => ({
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

/** The five fields a published date may be stored under, first one set wins. */
const PUBLISHED_DATE_ALIASES = Object.freeze([
  'publishedDate',
  'datePublished',
  'Published At',
  'blogPublishedAt',
  'publishedAt',
]);

/** Published-date resolution across the five aliases (useCoderCornerData). */
export function resolvePublishedDateValue(doc = {}) {
  const candidate = PUBLISHED_DATE_ALIASES.map((field) => doc[field]).find(Boolean) || null;
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
export function sqlProjection(fields) {
  return fields.map((f) => `c["${f}"]`).join(', ');
}

export const LIST_DEFAULT_LIMIT = 60;
// Ceiling matches the widest client fetch window (useFrameworkData and
// useProviderLandingContent ask for 250 and filter by provider client-side —
// a smaller cap would silently hide older provider-specific documents).
export const LIST_MAX_LIMIT = 250;
// The in-memory sort window. Bounded so a runaway container can't OOM the
// handler. This used to be the failure threshold too: with no WHERE clause the
// window applied to ALL documents, and the file's own comment noted content is
// ~1k docs total — the bound and the count were the same number, past which
// published articles vanish arbitrarily. The public filter now runs in SQL
// (see listContent), so the window applies to the PUBLISHED subset of the
// requested type/provider, which moves the threshold far from the data
// (T-206).
export const FETCH_WINDOW = 1000;

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
export const LIST_PROJECTION = PUBLIC_CONTENT_LIST_FIELDS.map((f) => `c["${f}"]`).join(', ');

/**
 * The fields `isPublicDocument` reads. The detail query projects them so the
 * visibility filter can run, and the detail response leaves them out: no
 * detail template reads them, and a published page has no use for its own
 * workflow state. The preview adds `contentStatus` back for its banner.
 */
export const CONTENT_VISIBILITY_FIELDS = Object.freeze([
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
export const CONTENT_DETAIL_PROJECTION = sqlProjection([
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
export const FEED_CACHE_MAX_DOCS = 200;

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
export const LISTEN_AND_LEARN_SET_CONTAINER = 'listen_and_learn';
export const LISTEN_AND_LEARN_EPISODE_CONTAINER = 'listen_and_learn_episodes';
export const LISTEN_AND_LEARN_MAX_EPISODES = 50;

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
export const LISTEN_AND_LEARN_LIST_FIELDS = [
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
export const LISTEN_AND_LEARN_MAX_LISTED = 200;

/**
 * The allowlist as a SQL projection, so the transcript never leaves Cosmos
 * for this route — projecting in JS after `SELECT *` still paid to read and
 * ship the largest field on every row. The soft-delete markers ride along
 * because `isSoftDeleted` reads them before the JS allowlist drops them; the
 * sets projection carries only what the join uses. Same `c["…"]` quoting as
 * LIST_PROJECTION above.
 */
const SOFT_DELETE_MARKERS = ['softDeletedAt', 'softDeleteExpiresAt'];
export const LISTEN_AND_LEARN_LIST_PROJECTION = [...LISTEN_AND_LEARN_LIST_FIELDS, ...SOFT_DELETE_MARKERS]
  .map((f) => `c["${f}"]`)
  .join(', ');
export const LISTEN_AND_LEARN_SET_PROJECTION = ['id', 'certTitle', 'certSlug', ...SOFT_DELETE_MARKERS]
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
export const LISTEN_AND_LEARN_EPISODE_PROJECTION = sqlProjection([
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
export const PODCAST_PROJECTION = sqlProjection([
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
export const FEED_CACHE_PROJECTION = sqlProjection([...PUBLIC_FEED_CACHE_FIELDS, ...SOFT_DELETE_MARKERS]);

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
export const CERT_EVENTS_CONTAINER = 'certEvents';
export const CERT_EVENT_SOURCES_BY_PLATFORM = Object.freeze({ azure: Object.freeze(['skills-hub-rss']) });
export const CERT_EVENT_FIELDS = [
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
export const CERT_EVENTS_MAX_LISTED = 100;
export const CERT_EVENTS_CACHE_SECONDS = 3600;
export const CERT_EVENT_PROJECTION = [...CERT_EVENT_FIELDS, ...SOFT_DELETE_MARKERS]
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
export const PODCAST_FEEDS_CONFIG_CONTAINER = 'admin_config';
export const PODCAST_FEEDS_CONFIG_ID = 'podcast_feeds';
export const PODCAST_FEEDS_CONFIG_PARTITION = 'admin_config';

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
export function boundFeedItems(doc) {
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
export const CURATED_IMAGE_HIT_CACHE_SECONDS = 3600;
export const CURATED_IMAGE_MISS_CACHE_SECONDS = 60;

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
export const SLUG_CANDIDATES = 10;

// Containers the list endpoint may serve. 'blogs' is the legacy fallback the
// list hooks query when 'content' comes back empty — the browser read it
// directly under the old Firestore rules, so exposing it (public-filtered,
// internal fields stripped) grants nothing new.
export const LIST_SOURCES = new Set(['content', 'blogs']);
