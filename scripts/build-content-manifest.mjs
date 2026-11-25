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
import { ARTICLE_SLUG, providerOf, slugOf, STRICT_SLUG } from './lib/content-manifest-items.mjs';
import { fetchPublished } from './lib/content-manifest-fetch.mjs';
import { addDesigns, isDesignItem } from './lib/content-manifest-designs.mjs';
import { describeSectionCounts, sectionCounts, serverSections } from './lib/content-manifest-sections.mjs';
// The field lists, imported from functions/ rather than copied, so the
// manifest and the route that serves it keep exactly the same fields (#1845;
// designs did the same in #1628). Neither import needs functions/'s packages.
import { ARTICLE_FIELDS } from '../functions/src/lib/public-article-fields.js';
import { PUBLIC_INTERVIEW_DETAIL_FIELDS } from '../functions/src/lib/public-read-interviews.js';
// The parts below now live in their own files; they are exported from here too, so callers keep their imports.
export { PROVIDERS, STRICT_SLUG, ARTICLE_SLUG } from './lib/content-manifest-items.mjs';
export { describeFetchFailure } from './lib/content-manifest-fetch.mjs';
export { DESIGN_PROVIDERS } from './lib/content-manifest-designs.mjs';
export { SECTION_TYPES, sectionCounts, describeSectionCounts } from './lib/content-manifest-sections.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
// NOT under public/. Vite copies public/ verbatim into dist, so a manifest
// there would be deployed and served — half a megabyte of article bodies that
// no visitor ever requests, because the browser gets its data from the API.
// This is build input only; scripts/prerender.mjs reads it from disk.
const OUT_PATH = join(ROOT, 'frontend', 'data', 'content-manifest.json');

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
 * The list itself is functions/src/lib/public-article-fields.js, the one the
 * manifest route projects with too; it is re-exported here for callers.
 *
 * `content-manifest.test.mjs` scans the template for `article.<field>` and fails
 * when one is missing here, so a field added to the page cannot silently render
 * blank in the pre-rendered HTML while working in the browser — which is the
 * worst version of this bug, since only a crawler would see it.
 */
export { ARTICLE_FIELDS };

/** Keep only the rendered fields, and only when present. */
export function project(item) {
  const out = {};
  for (const field of ARTICLE_FIELDS) {
    if (item[field] !== undefined) out[field] = item[field];
  }
  return out;
}

/**
 * The fields the interview page renders (ADR 0040, D6): exactly the public
 * detail route's allowlist, PUBLIC_INTERVIEW_DETAIL_FIELDS in
 * functions/src/lib/public-read-interviews.js, imported rather than copied
 * (#1845). The first seven are the list route's fields, which the list page
 * and the Azure landing card read; that file keeps them first.
 */
export const INTERVIEW_FIELDS = PUBLIC_INTERVIEW_DETAIL_FIELDS;

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
 * Why an item gets no article page, in the order they are checked; each
 * returns the run-log line, or nothing when it does not apply.
 */
const ARTICLE_SKIPS = [
  // An interview is not an article: the route leaves them out of
  // `items` and sends them as `interviews`; a revision that still sends
  // one here must not put it at /<provider>/blog/<slug>.
  ({ item, slug }) => isInterviewItem(item) && `${slug || item.id}: an interview, not an article`,
  // The route sends designs on their own; a copy among the articles
  // must not also put the design at /<provider>/blog/<slug>.
  ({ item, slug, designs }) => designs !== null && isDesignItem(item) && `${slug || item.id}: a design, sent with the designs`,
  ({ item, slug }) => !slug && `${item.id}: no slug`,
  // Named by id, not by the slug: the slug is the part that is wrong.
  ({ item, slug }) => !ARTICLE_SLUG.test(slug) && `${item.id}: slug is not a safe address`,
  // Without a provider there is no URL to pre-render it at. With no file
  // of its own, any address for it answers 404 since #1613, though the
  // app still shows it to a reader in the browser.
  ({ item, slug, provider }) => !provider && `${slug}: no recognised provider (${item.cloudProvider || 'unset'})`,
  // Two published items with one slug — a re-ingested article, usually.
  // The route is one URL either way; listing it twice made the sitemap
  // repeat it (three times, on 2026-09-06: issue #373) and the pre-render
  // write the same file three times. First one in wins, the rest are
  // named here so the duplicate is visible in the run log.
  ({ item, slug, data }) =>
    Object.prototype.hasOwnProperty.call(data, `article:${slug}`) && `${slug}: duplicate slug (item ${item.id}); first occurrence kept`,
];

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
    const article = { item, slug: slugOf(item), provider: providerOf(item), designs, data };
    const skip = ARTICLE_SKIPS.map((check) => check(article)).find(Boolean);
    if (skip) {
      skipped.push(skip);
      continue;
    }
    routes.push(`/${article.provider}/blog/${article.slug}`);
    data[`article:${article.slug}`] = project(item);
  }

  addInterviews(Array.isArray(interviews) ? interviews : [], { routes, data, skipped });
  if (Array.isArray(designs)) addDesigns(designs, { routes, data, skipped });

  return { generatedAt: null, routes, data, skipped, sections };
}

export async function main() {
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
