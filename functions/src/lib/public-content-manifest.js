/**
 * The published corpus, projected to the fields the pre-render manifest keeps.
 *
 * ## Why this route exists (T-718)
 *
 * `scripts/build-content-manifest.mjs` used to query Cosmos directly from a
 * GitHub-hosted runner. That single workload is what held the `0.0.0.0`
 * sentinel open on the Cosmos firewall — the documented "accept connections
 * from within Azure datacenters" switch, which admits any workload in any Azure
 * tenant at the network layer.
 *
 * Every way of closing that while keeping the query in CI was worse than the
 * finding: the firewall has no narrower control-plane action than
 * `Microsoft.DocumentDb/databaseAccounts/*​/write`, which also sets
 * `disableLocalAuth`, and a per-run window cannot be isolated from the read
 * because separate jobs get separate runner IPs. See
 * `docs/decisions/0025-cosmos-firewall-datacenter-sentinel.md`.
 *
 * So the query moves in here, where it runs from the integration subnet the
 * Cosmos firewall already admits, and the runner fetches the result over HTTP
 * instead. CI stops needing Cosmos data-plane access at all.
 *
 * ## Why it is safe to serve anonymously
 *
 * It returns published documents only — asserted in the query rather than
 * filtered afterwards — projected to `ARTICLE_FIELDS`, an explicit allowlist.
 * Every one of those fields is already served by `public/content` and rendered
 * on the public article page. There is no field here the site does not already
 * publish, and no unpublished document can reach it.
 *
 * What it *is* is a bulk endpoint: one request instead of ~120. That is a
 * convenience difference rather than a confidentiality one, and it is the
 * reason the workflow reaches it through a per-run origin window rather than
 * over the public Cloudflare hostname.
 *
 * ## Why it does not rate-limit
 *
 * Deliberate, and it is what makes the origin window work. `anonymousKey()`
 * throws in production when a request did not arrive through Cloudflare — that
 * is the origin lock — so any route that rate-limits anonymously is
 * unreachable from a runner hitting the origin directly. `/api/health` is
 * reachable through `deploy-functions.yml`'s existing window for exactly this
 * reason. This route follows it.
 *
 * ## What else it carries
 *
 * `sections` — how many published items each `/<provider>/<section>` page has,
 * so the pre-render can leave an empty one out of `sitemap.xml` (issue #373).
 * It is computed here rather than in the builder because three of the five
 * sections read containers the builder cannot see; see
 * `public-section-counts.js`, which owns every rule.
 */
import {
  NEVER_PUBLIC_STATUSES,
  SQL_NOT_SOFT_DELETED,
  SQL_PUBLIC_CLAUSE,
} from './public-reads.js';
import { countSections } from './public-section-counts.js';

/**
 * The fields the manifest keeps, and therefore the only fields this returns.
 *
 * DUPLICATED from `scripts/build-content-manifest.mjs`, deliberately, and
 * `public-content-manifest.test.js` fails if the two drift. `functions/` and
 * `scripts/` are independent npm packages with no workspace between them, and
 * this repository already carries that trade for `terraform-source` — one copy
 * each side, a guard that reads the other, and a note saying change both.
 *
 * The consequence of drift is specific rather than cosmetic: a field added
 * there but not here is silently absent from every pre-rendered article, which
 * presents as a rendering bug in the static HTML and nowhere else.
 */
export const ARTICLE_FIELDS = Object.freeze([
  // identity and routing
  'id',
  'slug',
  'Slug',
  'cloudProvider',
  'Cloud Provider',
  // the body, in the shapes the template looks for
  'Content',
  'content',
  'blogDraft',
  'code',
  'codeLanguage',
  'codeSnippet',
  'terraformCode',
  // headings and summary
  'Title',
  'title',
  'Summary',
  'summary',
  'description',
  'excerpt',
  'keyTopics',
  // taxonomy. `type` is what the section pages select on (framework,
  // coder_corner); the manifest counts it per provider so the pre-render can
  // keep a section with nothing in it out of the sitemap (issue #373). No
  // quoted strings in this comment: the drift test parses this block as text.
  'type',
  'Category',
  'category',
  'Tags',
  'tags',
  'language',
  // attribution and dates
  'Author',
  'siteAuthor',
  'editorAuthor',
  'createdByName',
  'publishedByName',
  'Published At',
  'publishedAt',
  'publishedDate',
  'datePublished',
  'blogPublishedAt',
  'ReadTime',
  'readTime',
  // media
  'imageUrl',
  'heroImageUrl',
  'contentImageUrl',
  'altCoverImage',
  'altCoverImageVariants',
  'aiImageUrls',
  'aiImageVariants',
  // outbound links
  'url',
  'sourceUrl',
  'Source URL',
  'repoUrl',
  'CD Url',
]);

/**
 * Keep only the allowlisted fields, and only when present.
 *
 * Named rather than spread: a spread would carry every field the document
 * happens to hold, which is the whole thing this route must not do.
 */
export function projectArticle(item) {
  const out = {};
  for (const field of ARTICLE_FIELDS) {
    if (item?.[field] !== undefined) out[field] = item[field];
  }
  return out;
}

/**
 * Statuses the manifest never lists, whatever else a document says: archived
 * and rejected, which are off the site by definition, and the statuses
 * public-reads.js already never serves (NEVER_PUBLIC_STATUSES, the Drafts
 * stage).
 */
export const OFF_SITE_STATUSES = Object.freeze([
  'archived',
  'rejected',
  ...NEVER_PUBLIC_STATUSES,
]);

/**
 * `NOT IS_STRING` first: a document with no contentStatus, or a null one, is
 * not off the site on that account, and `IN` on a missing field is undefined
 * in Cosmos, which NOT would leave undefined and the WHERE would drop.
 */
const SQL_NOT_OFF_SITE =
  '(NOT IS_STRING(c.contentStatus) OR NOT (c.contentStatus IN ' +
  `(${OFF_SITE_STATUSES.map((s) => `"${s}"`).join(', ')})))`;

/**
 * The published-only predicate: the public API's own clauses, so the manifest
 * and the API agree by construction (AP-F13, #937), and nothing archived or
 * rejected. Asserted in the QUERY rather than filtered after, so an
 * unpublished article cannot reach a public URL through an oversight here.
 *
 * `SQL_PUBLIC_CLAUSE` and `SQL_NOT_SOFT_DELETED` are what the public list
 * route and the section counts query with, and they mirror isPublicDocument,
 * which the public detail route serves an article by. This predicate used to
 * be its own three words (`contentStatus = 'published' OR Status =
 * 'Published' OR status = 'published'`), and they disagreed with the API both
 * ways: a document archived from Live Pages that still carried a lowercase
 * `status: 'published'`, a soft-deleted one, or one saying only `Status:
 * 'Published'` was pre-rendered and listed in the sitemap while the API
 * answered 404 for it, and a live document in any other status was served
 * but never pre-rendered. A pre-rendered page is the article's whole body in
 * static HTML, so the first of those is the one that mattered.
 *
 * Narrower than the API by archived and rejected and by nothing else (the
 * API refuses drafting too). The archive and reject appliers
 * (cms/content-status.js) write `Live: false` and retire the legacy `Status`
 * word, so a page taken down since then fails `SQL_PUBLIC_CLAUSE` already;
 * an older one archived or rejected under a legacy `Status: 'Live'`, or
 * still flagged `Live: true`, does not, and is kept out here by its status.
 */
export const PUBLISHED_PREDICATE = `${SQL_PUBLIC_CLAUSE} AND ${SQL_NOT_SOFT_DELETED} AND ${SQL_NOT_OFF_SITE}`;

/**
 * PROJECTED IN SQL, not just in JavaScript.
 *
 * The first version selected `*` and relied on `projectArticle` to drop the
 * rest. That was correct and wasteful: Cosmos returned whole documents —
 * article bodies and every internal field — across the wire for a daily bulk
 * read, and the allowlist was enforced only after they had already arrived in
 * the app's memory. Projecting here means the fields never leave the database.
 *
 * `c["Published At"]`-style bracket quoting is what handles the spaced and
 * cased names in the list (`Published At`, `Cloud Provider`, `Source URL`,
 * `CD Url`); `public-reads.js` builds LIST_PROJECTION the same way, which is
 * the proven form in this repository rather than one invented here.
 *
 * Built FROM `ARTICLE_FIELDS` rather than written out, so the projection and
 * the allowlist cannot disagree — a field added to one is in the other by
 * construction.
 *
 * `projectArticle` still runs on the result and is not redundant: it is what
 * holds if this query is ever edited back to `*`, and it costs one pass over
 * an object whose keys are already correct.
 */
const ARTICLE_PROJECTION = ARTICLE_FIELDS.map((field) => `c["${field}"]`).join(', ');

export const PUBLISHED_QUERY = `SELECT ${ARTICLE_PROJECTION} FROM c WHERE ${PUBLISHED_PREDICATE}`;

export function createPublicContentManifestHandlers({ store }) {
  return {
    /** GET /api/public/content-manifest */
    async getManifest(_request, context) {
      try {
        // Side by side: the corpus and the section counts read different
        // containers and neither waits on the other.
        //
        // ONE try/catch over both, so a failure counting sections fails the
        // whole route. That is deliberate. The alternative — answer 200 with
        // the corpus and no counts — is a quiet degradation whose visible
        // effect is thirty-three empty pages returning to the sitemap on the
        // next frontend deploy. A 500 fails `publish-content-manifest.yml`
        // loudly, leaves the committed manifest and its counts in place, and
        // is fixed by re-running.
        const [rows, sections] = await Promise.all([
          store.queryDocs('content', PUBLISHED_QUERY, []),
          countSections({ store }),
        ]);
        const items = (Array.isArray(rows) ? rows : []).map(projectArticle);
        return {
          status: 200,
          // `sections` is null when a counting read filled its window; the
          // builder treats anything but an object as "no counts from the
          // route" and falls back, which drops no route it would not have
          // dropped before.
          jsonBody: { success: true, items, count: items.length, sections },
          // The build reads this once a day and commits the result; a cached
          // copy would silently pre-render yesterday's corpus.
          headers: { 'Cache-Control': 'no-store' },
        };
      } catch (error) {
        context?.error?.('public content manifest failed', error);
        return { status: 500, jsonBody: { success: false, error: 'manifest_unavailable' } };
      }
    },
  };
}
