/**
 * Build the content manifest the frontend pre-renders article pages from.
 *
 * WHY A MANIFEST AND NOT A FETCH. `scripts/prerender.mjs` renders listing and
 * landing routes but deliberately skips every `/:provider/blog/:slug`, because
 * those pages need their article at render time and the build cannot get it:
 * CI reaches the public API through Cloudflare, which answers a GitHub runner
 * with a managed challenge (#175). Making the build depend on that would make
 * every deploy depend on a permanent bot-protection exception — a trade already
 * rejected on that issue.
 *
 * So the data comes the other way. This runs in a workflow that holds Azure
 * federated credentials, reads Cosmos directly with data-plane RBAC, and writes
 * a plain JSON file into the repository. The frontend build then needs no
 * credentials at all: it reads a file. That is the whole point — the frontend
 * deploy has `contents: read` and a Static Web Apps token, and should keep
 * having exactly that.
 *
 * The manifest is committed rather than passed as an artifact so a build is
 * reproducible from a checkout alone, and so a diff shows what changed about
 * the published set.
 *
 * KEYS MATCH `usePublicData`. Each entry is stored under the key that hook uses
 * for the same query — `article:<slug>`, `interview:<slug>`,
 * `architecture:<slug>` — so seeding is a lookup rather than a translation.
 * See frontend/src/hooks/prerenderData.js.
 *
 * PUBLISHED CONTENT ONLY. Drafts, scheduled and rejected items are excluded by
 * the query, not filtered afterwards: pre-rendering an unpublished article
 * would put it on a public URL at HTTP 200 and in the sitemap.
 *
 * Env:
 *   FUNCTION_ORIGIN   required — the Function App's own hostname, reached
 *                     through a per-run IP window. NOT the Cloudflare host.
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// The public detail route's allowlist, imported rather than copied: the one
// list both sides project a design to (#1628). The module imports nothing.
import { PUBLIC_CONTENT_DETAIL_FIELDS } from '../functions/src/lib/public-reads.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
// NOT under public/. Vite copies public/ verbatim into dist, so a manifest
// there would be deployed and served — half a megabyte of article bodies that
// no visitor ever requests, because the browser gets its data from the API.
// This is build input only; scripts/prerender.mjs reads it from disk.
const OUT_PATH = join(ROOT, 'frontend', 'data', 'content-manifest.json');

/**
 * Providers with a `/:provider/blog/:slug` route. Mirrors VALID_PROVIDERS in
 * frontend/src/context/ProviderContext.jsx, which the test holds it to: a
 * provider missing here gets no article pages pre-rendered and no local
 * section counts. Docker since #776, when its blog detail route arrived.
 */
export const PROVIDERS = Object.freeze([
  'azure',
  'aws',
  'gcp',
  'github',
  'terraform',
  'finops',
  'vmware',
  'ansible',
  'docker',
]);

/**
 * Fetch the published corpus from the Function App's origin (T-718).
 *
 * THIS USED TO QUERY COSMOS DIRECTLY, and that one workload is what held the
 * `0.0.0.0` sentinel open on the Cosmos firewall — the switch admitting any
 * workload in any Azure tenant at the network layer. Moving the query into the
 * app, which runs inside the subnet the firewall already admits, is what let
 * that close. See docs/decisions/0025-cosmos-firewall-datacenter-sentinel.md.
 *
 * THE ORIGIN HOSTNAME, NOT THE CLOUDFLARE ONE. A GitHub runner asking the
 * public host is served Cloudflare's Bot Fight Mode interstitial and a 403
 * (#175, and the reason ADR 0024 exists). The workflow opens a per-run App
 * Service IP allow rule for its own address instead and asks the origin
 * directly — the same window deploy-functions.yml already uses to probe
 * /api/health.
 *
 * No credential of any kind: the route is anonymous, and reaching it is the
 * authorization. That is why the window closes in an always() step.
 */
/**
 * What a non-OK status from the manifest route actually means.
 *
 * SEPARATED AND EXPORTED so the wording is asserted rather than trusted. The
 * previous version said a 403 meant the origin window and "anything else is the
 * app itself", and on 2026-08-31 that sent the investigation at a Function App
 * that was entirely healthy.
 *
 * 403 — the per-run origin allow rule is shut or has not propagated, so the
 * runner's address is not admitted. Re-running is the answer.
 *
 * 404 — THE HOST ANSWERED. It is up; this route is not on the revision it is
 * running. That is a deploy that has not happened, not an outage, and the two
 * look nothing alike once said out loud. It happened exactly this way: the
 * route arrived with #277 at 2026-08-30 02:45 UTC, the last Deploy Functions
 * run was 01:21 UTC on a commit that predates it, and the nightly job failed on
 * 08-30 and 08-31 while Monitor Functions Registered reported 121 registered
 * functions and a clean bill of health. That monitor was not wrong — the
 * functions it counted were the pre-#277 set, and counting cannot see a missing
 * one. `deploy-functions.yml` is workflow_dispatch only, so merging a route
 * never deploys it.
 */
export function describeFetchFailure(status, url) {
  if (status === 403) {
    return (
      `${url} answered 403. The per-run origin window is closed or has not propagated, so this ` +
      "runner's address is not admitted to the origin. Re-run rather than widening anything."
    );
  }
  if (status === 404) {
    return (
      `${url} answered 404. The HOST answered, so it is up — this ROUTE is not on the revision ` +
      'it is running, which is a deploy that has not happened rather than an outage. Check that ' +
      'Deploy Functions has run on a commit containing ' +
      'functions/src/functions/public-content-manifest.js: ' +
      'https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/deploy-functions.yml'
    );
  }
  return (
    `${url} answered ${status}. Neither 403 (the origin window) nor 404 (a route missing from ` +
    'the deployed revision), so this is the app itself.'
  );
}

async function fetchPublished() {
  const origin = process.env.FUNCTION_ORIGIN;
  if (!origin) {
    throw new Error(
      'FUNCTION_ORIGIN is not set. Expected the Function App origin hostname, e.g. ' +
        'https://func-site-prod-cus-01.azurewebsites.net — NOT the Cloudflare host, which ' +
        'answers datacenter clients with a bot interstitial.'
    );
  }

  const url = `${origin.replace(/\/+$/, '')}/api/public/content-manifest`;

  // TIMED OUT, and the reason is the firewall rather than politeness. The
  // workflow opens a per-run origin allow rule and closes it in an always()
  // step — but always() runs when the STEP ends, and a fetch with no timeout
  // does not end. A DNS or TLS stall would hold this open until the job's own
  // timeout, leaving a dead runner's address admitted to the origin for as long
  // as it took. A bounded failure closes the window on schedule.
  //
  // Two minutes because the response is the whole published corpus — hundreds
  // of kilobytes of article bodies — not a health check.
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) }).catch((error) => {
    if (error?.name === 'TimeoutError') {
      throw new Error(
        `${url} did not respond within 120s. The origin window is closed by the always() step ` +
          'regardless; re-run rather than widening the timeout unless the corpus has genuinely ' +
          'outgrown it.'
      );
    }
    throw error;
  });
  if (!response.ok) throw new Error(describeFetchFailure(response.status, url));

  const body = await response.json();
  if (!body?.success || !Array.isArray(body.items)) {
    throw new Error(`${url} returned an unexpected body: ${JSON.stringify(body).slice(0, 200)}`);
  }
  // `sections` is optional: a deployed revision that predates it simply does
  // not send one, and `buildManifest` then counts what it can itself. So are
  // `interviews` (ADR 0040): a revision without them pre-renders none. And
  // `designs` (#1628): a revision without them still sends its designs among
  // the articles, so null (not []) tells `buildManifest` to keep them there.
  // Present but not a list is refused: a revision that sends the field has
  // already taken designs out of `items`, so treating it as absent would
  // drop every design while the log said they were among the articles.
  if (body.designs !== undefined && !Array.isArray(body.designs)) {
    throw new Error(`${url} returned designs that are not a list: ${JSON.stringify(body.designs).slice(0, 200)}`);
  }
  return {
    items: body.items,
    sections: body.sections,
    interviews: Array.isArray(body.interviews) ? body.interviews : [],
    designs: Array.isArray(body.designs) ? body.designs : null,
  };
}

/** The provider segment an article's URL lives under. */
function providerOf(item) {
  const raw = String(item.cloudProvider || item['Cloud Provider'] || '')
    .toLowerCase()
    .trim();
  return PROVIDERS.includes(raw) ? raw : null;
}

function slugOf(item) {
  return String(item.slug || item.Slug || '').trim();
}

/**
 * The address of every page the build writes (articles, interviews and
 * designs): lowercase words joined by single hyphens. The slug becomes a folder of the built site, so a slash, a
 * dot or anything else that could change that folder never reaches it.
 * One pattern for all three, so they cannot drift apart. It matches `SLUG` in
 * functions/src/lib/interviews/schema.js, which the test holds it to.
 */
export const STRICT_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Articles follow STRICT_SLUG too since 2026-11-12 (#1628): the 23 live
 * articles were renamed to `<topic>-<id>` addresses, the last mixed-case ones
 * among them. Kept as its own name because callers and tests import it.
 */
export const ARTICLE_SLUG = STRICT_SLUG;

/**
 * The fields the article page renders. Everything else is dropped.
 *
 * A manifest is build input, not a database dump. The first version stored whole
 * documents and came to 3.0 MB for 24 articles, because a content document
 * carries FIVE near-duplicate renderings of the same body — `contentHtml` alone
 * was 1.97 MB, 65% of the file — plus `analysisPrompt`, the prompt used to
 * generate the article, which no reader ever sees. Projecting to what
 * `BlogDetailTemplate` actually reads removes about three quarters of it.
 *
 * `content-manifest.test.mjs` scans the template for `article.<field>` and fails
 * when one is missing here, so a field added to the page cannot silently render
 * blank in the pre-rendered HTML while working in the browser — which is the
 * worst version of this bug, since only a crawler would see it.
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

/** Keep only the rendered fields, and only when present. */
function project(item) {
  const out = {};
  for (const field of ARTICLE_FIELDS) {
    if (item[field] !== undefined) out[field] = item[field];
  }
  return out;
}

/**
 * The fields the interview page renders (ADR 0040, D6): exactly the public
 * detail route's allowlist, PUBLIC_INTERVIEW_DETAIL_FIELDS in
 * functions/src/lib/public-reads.js. DUPLICATED there as INTERVIEW_FIELDS in
 * public-content-manifest.js, and `public-content-manifest.test.js` fails if
 * the two drift, for the same reason ARTICLE_FIELDS is pinned. The first
 * seven are the list route's fields, which the list page and the Azure
 * landing card read; keep them first.
 */
export const INTERVIEW_FIELDS = Object.freeze([
  'slug',
  'title',
  'subtitle',
  'date',
  'guest',
  'tags',
  'publishedAt',
  'bio',
  'image',
  'qa',
  'related',
  'updatedAt',
]);

/** The list route's projection: what a card and the landing page read. */
export const INTERVIEW_LIST_FIELDS = Object.freeze(INTERVIEW_FIELDS.slice(0, 7));

/** The interview list page, Azure only (App.jsx: any other provider is a 404). */
export const INTERVIEWS_ROUTE = '/azure/interviews';

const isInterviewItem = (item) => String(item?.type || '').toLowerCase() === 'interview';

function projectInterviewTo(item, fields) {
  const out = {};
  for (const field of fields) {
    if (item[field] !== undefined) out[field] = item[field];
  }
  return out;
}

/** Newest interview first by its own date; the same day keeps a steady order by slug. */
const byInterviewDateDesc = (a, b) =>
  String(b.date || '').localeCompare(String(a.date || '')) ||
  String(a.slug || '').localeCompare(String(b.slug || ''));

/**
 * The interview routes and seeds (ADR 0040, D6), onto `routes`, `data` and
 * `skipped`. KEYS MATCH `usePublicData` as for articles: `interviews:list`
 * is the list page's and the landing card's query, `interview:<slug>` the
 * page's. The list route is listed only once there is an interview: an
 * empty list page would be thin content in the sitemap.
 */
function addInterviews(interviews, { routes, data, skipped }) {
  const kept = [];
  const seen = new Set();
  for (const item of interviews) {
    const slug = slugOf(item);
    if (!slug || !STRICT_SLUG.test(slug)) {
      skipped.push(`interview ${item?.id || '(no id)'}: no usable slug`);
      continue;
    }
    if (seen.has(slug)) {
      skipped.push(`interview ${slug}: duplicate slug; first occurrence kept`);
      continue;
    }
    seen.add(slug);
    kept.push(item);
  }
  if (kept.length === 0) return;
  kept.sort(byInterviewDateDesc);
  routes.push(INTERVIEWS_ROUTE);
  data['interviews:list'] = kept.map((item) => projectInterviewTo(item, INTERVIEW_LIST_FIELDS));
  for (const item of kept) {
    routes.push(`${INTERVIEWS_ROUTE}/${item.slug}`);
    data[`interview:${item.slug}`] = projectInterviewTo(item, INTERVIEW_FIELDS);
  }
}

/**
 * Providers with a design page, `/<provider>/architecture-designs/<slug>`.
 * Mirrors ProviderArchitectureDispatcher in frontend/src/App.jsx, which the
 * test holds it to: any other provider's design address is the app's 404
 * page, so a design there gets no page built.
 */
export const DESIGN_PROVIDERS = Object.freeze(['aws', 'azure', 'gcp', 'finops', 'vmware']);

const isDesignItem = (item) => String(item?.type || '').toLowerCase() === 'architecture';

/**
 * The design routes and seeds (#1628), onto `routes`, `data` and `skipped`.
 * `architecture:<slug>` is the key ArchitectureDetailTemplate reads, as
 * `usePublicData` keys it.
 *
 * PROJECTED TO WHAT `public/content` ANSWERS, PUBLIC_CONTENT_DETAIL_FIELDS,
 * the same list the route projects to (DESIGN_FIELDS in
 * functions/src/lib/public-content-manifest.js), imported rather than
 * copied. The route's projection is the boundary; this one is the second
 * layer, as `project` is for articles, so a field a route regression let
 * through still never reaches the committed manifest. Not narrower than
 * that list: a page built from a seed does not fetch again in the browser,
 * so a narrower seed would show readers less than the live page does.
 *
 * A design whose address repeats one of the built-in designs
 * (frontend/src/data/architectures.js) is still listed: the pre-render drops
 * the repeated route, and the seed is the API's copy, which the page lays
 * over the built-in one exactly as it does in the browser.
 */
/** Keep only the public detail fields, and only when present. */
function projectDesign(item) {
  const out = {};
  for (const field of PUBLIC_CONTENT_DETAIL_FIELDS) {
    if (item[field] !== undefined) out[field] = item[field];
  }
  return out;
}

function addDesigns(designs, { routes, data, skipped }) {
  for (const item of designs) {
    const slug = slugOf(item);
    if (!slug || !STRICT_SLUG.test(slug)) {
      skipped.push(`design ${item?.id || '(no id)'}: no usable slug`);
      continue;
    }
    const provider = providerOf(item);
    if (!provider || !DESIGN_PROVIDERS.includes(provider)) {
      const named = item.cloudProvider || item['Cloud Provider'] || 'unset';
      skipped.push(`design ${slug}: no design page for provider (${named})`);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(data, `architecture:${slug}`)) {
      // One key per slug, whatever the provider: the page reads
      // `architecture:<slug>`. First one in wins, as for articles.
      skipped.push(`design ${slug}: duplicate slug (item ${item.id}); first occurrence kept`);
      continue;
    }
    routes.push(`/${provider}/architecture-designs/${slug}`);
    data[`architecture:${slug}`] = projectDesign(item);
  }
}

/**
 * Sections countable from the corpus this script is handed, keyed by the `type`
 * their page selects on.
 *
 * THIS IS THE FALLBACK PATH, not the main one, and it is approximate. The
 * manifest route counts every countable section across every container a
 * section page reads (functions/src/lib/public-section-counts.js) and
 * `buildManifest` prefers its answer. What is below runs only when the deployed
 * revision predates that field, so that merging the route and deploying it can
 * happen in either order without the five frameworks pages returning to the
 * sitemap in between.
 *
 * Approximate in a specific, measured way. `useFrameworkData` does NOT read the
 * `content` container alone: like useBlogData and useCoderCornerData it falls
 * back to the legacy `blogs` container when `content` yields nothing for a
 * provider, and this script is handed `content` only. That gap is survivable
 * rather than harmless — on 2026-09-07 `blogs` held five published documents,
 * all `type: blog` and all slug-duplicates of `content` documents, so it puts
 * nothing on any page and no framework in any count. `coder-corner` and `code`
 * are still absent here despite reading the same two containers, because their
 * pages had nothing in `content` at all, so this path's zero for them would
 * rest entirely on a container it cannot see.
 *
 * `architecture-designs` joins on the same terms and with a stronger claim than
 * frameworks has. The AWS and Azure architecture pages do fall back to `blogs`,
 * so this path's view of them is the same approximation as above — but a zero
 * counted here only drops a route whose `architecture-blueprints.js` is also
 * empty (`sitemapRoutes` in frontend/scripts/prerender.mjs), and the one
 * provider whose module is empty is VMware, whose page reads `content` and
 * nothing else. For the only route this count can act on, the corpus this
 * script is handed IS the corpus the page reads.
 */
export const SECTION_TYPES = Object.freeze({
  frameworks: 'framework',
  'architecture-designs': 'architecture',
});

/**
 * Published items per provider per section, so the pre-render can leave a
 * section page with nothing in it out of the sitemap (issue #373).
 *
 * Returns null when no item carries a non-empty string `type` — the deployed
 * manifest route predates the field, or the corpus carries the field but no
 * value — so a consumer cannot mistake "unknown" for "zero". A `null` or empty
 * `type` counts as absent for the same reason.
 * `_unattributed` counts items of the section's type that name no recognised
 * provider; the frameworks page infers a provider from titles and URLs as a
 * last resort, so while that count is non-zero no provider's zero is trusted.
 */
const hasType = (item) => typeof item?.type === 'string' && item.type.trim() !== '';

export function sectionCounts(items) {
  if (!items.some(hasType)) return null;
  const sections = {};
  for (const provider of [...PROVIDERS, '_unattributed']) {
    sections[provider] = Object.fromEntries(Object.keys(SECTION_TYPES).map((s) => [s, 0]));
  }
  for (const item of items) {
    if (!hasType(item)) continue;
    const type = item.type.trim().toLowerCase();
    for (const [section, wanted] of Object.entries(SECTION_TYPES)) {
      if (type !== wanted) continue;
      sections[providerOf(item) || '_unattributed'][section] += 1;
    }
  }
  return sections;
}

/**
 * A `sections` map the route sent, or null when it sent nothing usable.
 *
 * Anything that is not a plain object is treated as absent rather than
 * repaired: the consumer reads `sections[provider][section]`, and a value that
 * is not that shape must not be allowed to answer `undefined` and be mistaken
 * for a section this build simply has no count for.
 */
function serverSections(sections) {
  if (!sections || typeof sections !== 'object' || Array.isArray(sections)) return null;
  return sections;
}

/**
 * The run-log line saying where the section counts came from — or that there
 * are none.
 *
 * THREE OUTCOMES, NOT TWO, and the third is the one worth a function. The
 * first version of this line printed "counted frameworks locally" whenever the
 * route sent nothing, but `sectionCounts()` returns null when no item carries a
 * `type` at all, and then nothing was counted: `manifest.sections` is null and
 * the pre-render drops no route. That is a plausible state during exactly the
 * upgrade window this message exists to narrate — an older deployed revision
 * that sends neither `sections` nor `type` — so the message would have claimed
 * a count that did not happen, in the one situation someone reads it.
 *
 * Worth asserting rather than trusting, for the same reason
 * `describeFetchFailure` is: nobody watches this run, they read the line it
 * leaves behind, and a wrong line sends them somewhere else.
 *
 * The per-provider figure is read off whichever provider the map happens to
 * carry first rather than off `azure` by name, so a map that never mentions
 * Azure still reports its real width.
 *
 * @param {object|null} sections the counts that ended up on the manifest
 * @param {boolean} fromRoute whether the route supplied them
 */
export function describeSectionCounts(sections, fromRoute) {
  if (fromRoute) {
    const providers = Object.keys(sections || {});
    const width = providers.length ? Object.keys(sections[providers[0]] || {}).length : 0;
    return `sections: from the route — ${width} per provider, across every container a section page reads`;
  }
  if (sections) {
    return 'sections: route sent none — counted frameworks locally from the corpus; deploy Functions for the rest';
  }
  return 'sections: none — the route sent none and no item carries a type, so no section page leaves the sitemap this build';
}

/**
 * @param {object[]} items the published articles
 * @param {object|null} sectionsFromRoute the route's section counts
 * @param {object[]} interviews the published interviews
 * @param {object[]|null} designs the published designs; null when the
 *   deployed route predates them and still sends them among `items`
 */
export function buildManifest(items, sectionsFromRoute = null, interviews = [], designs = null) {
  const routes = [];
  const data = {};
  const skipped = [];
  // The route's counts win. They see every container a section page reads;
  // sectionCounts() sees only the `content` corpus, so it can speak for
  // frameworks and nothing else.
  //
  // The fallback counts the designs too: a route that sends them apart has
  // taken them out of `items`, and counting `items` alone would put every
  // provider's architecture-designs at 0 and drop /vmware/architecture-designs
  // from the sitemap whenever the route sent no counts.
  const sections =
    serverSections(sectionsFromRoute) ??
    sectionCounts(Array.isArray(designs) ? [...items, ...designs] : items);

  for (const item of items) {
    const slug = slugOf(item);
    const provider = providerOf(item);
    if (isInterviewItem(item)) {
      // An interview is not an article: the route leaves them out of
      // `items` and sends them as `interviews`; a revision that still sends
      // one here must not put it at /<provider>/blog/<slug>.
      skipped.push(`${slug || item.id}: an interview, not an article`);
      continue;
    }
    if (designs !== null && isDesignItem(item)) {
      // The route sends designs on their own; a copy among the articles
      // must not also put the design at /<provider>/blog/<slug>.
      skipped.push(`${slug || item.id}: a design, sent with the designs`);
      continue;
    }
    if (!slug) {
      skipped.push(`${item.id}: no slug`);
      continue;
    }
    if (!ARTICLE_SLUG.test(slug)) {
      // Named by id, not by the slug: the slug is the part that is wrong.
      skipped.push(`${item.id}: slug is not a safe address`);
      continue;
    }
    if (!provider) {
      // Without a provider there is no URL to pre-render it at. With no file
      // of its own, any address for it answers 404 since #1613, though the
      // app still shows it to a reader in the browser.
      skipped.push(`${slug}: no recognised provider (${item.cloudProvider || 'unset'})`);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(data, `article:${slug}`)) {
      // Two published items with one slug — a re-ingested article, usually.
      // The route is one URL either way; listing it twice made the sitemap
      // repeat it (three times, on 2026-09-06: issue #373) and the pre-render
      // write the same file three times. First one in wins, the rest are
      // named here so the duplicate is visible in the run log.
      skipped.push(`${slug}: duplicate slug (item ${item.id}); first occurrence kept`);
      continue;
    }
    routes.push(`/${provider}/blog/${slug}`);
    data[`article:${slug}`] = project(item);
  }

  addInterviews(Array.isArray(interviews) ? interviews : [], { routes, data, skipped });
  if (Array.isArray(designs)) addDesigns(designs, { routes, data, skipped });

  return { generatedAt: null, routes, data, skipped, sections };
}

async function main() {
  // Published only, and still asserted in the QUERY rather than filtered after
  // — the query just lives in the app now
  // (functions/src/lib/public-content-manifest.js), where it is pinned by an
  // exact-match test for that reason.
  const { items: resources, sections, interviews, designs } = await fetchPublished();

  const manifest = buildManifest(resources, sections, interviews, designs);
  manifest.generatedAt = new Date().toISOString();

  mkdirSync(dirname(OUT_PATH), { recursive: true });

  // Compare ignoring the timestamp, so an unchanged corpus does not produce a
  // commit whose only content is the time it ran.
  // Trailing newline so the committed file satisfies .editorconfig's
  // insert_final_newline. It is part of `next` rather than appended at the
  // write, so the unchanged-corpus comparison below sees the same bytes it
  // writes and does not report a diff on every run (#588).
  const next = `${JSON.stringify(manifest, null, 2)}\n`;
  // Read straight through instead of existsSync-then-read. The check-then-use
  // pair is a race the single read does not have, and a file that disappeared
  // between the two calls is the same "no previous manifest" outcome as one
  // that was never there.
  let previous = null;
  try {
    previous = readFileSync(OUT_PATH, 'utf8');
  } catch {
    previous = null;
  }
  if (previous !== null) {
    const strip = (text) => text.replace(/"generatedAt": "[^"]*"/, '"generatedAt": ""');
    if (strip(previous) === strip(next)) {
      console.log(`[content-manifest] unchanged — ${manifest.routes.length} routes`);
      return;
    }
  }

  writeFileSync(OUT_PATH, next);
  console.log(
    `[content-manifest] ${manifest.routes.length} routes, ${resources.length} published items, ${interviews.length} published interviews, ` +
      (designs === null ? 'designs among the items (route predates them)' : `${designs.length} published designs`)
  );
  console.log(`  ${describeSectionCounts(manifest.sections, serverSections(sections) !== null)}`);
  for (const reason of manifest.skipped) console.log(`  skipped ${reason}`);
}

// pathToFileURL, not `new URL(`file://${argv[1]}`)`: a Windows `C:\...` argv[1]
// parses to a URL with host `C` that never matches import.meta.url, so the
// build would exit 0 without writing the manifest. Same fix as
// check-deploy-drift.mjs.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly || process.env.FORCE_RUN === '1') {
  main().catch((error) => {
    console.error(`[content-manifest] FAILED: ${error?.message || error}`);
    process.exit(1);
  });
}
