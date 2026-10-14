/**
 * Where the home page's numbers and lists come from (2026-09-29).
 *
 * EVERY VALUE HERE IS READ, NONE IS TYPED. The home page carried a stat row
 * (24+ blueprints, 104+ articles, 22+ modules, 99.9% uptime), a "Latest from
 * the providers" list of ten sample headlines stamped "2 HRS AGO", and a
 * design carousel whose Azure, Google Cloud and FinOps cards opened
 * "Architecture Not Found". None of it was derived from anything. What
 * replaced it:
 *
 *   - Blueprints: the `staticBlueprints` every `pages/<provider>/
 *     architecture-blueprints.js` exports, which is the array each
 *     architecture page renders and the one the pre-renderer counts for the
 *     sitemap. The carousel shows those same blueprints.
 *   - Articles, and the latest list: the published content the blog pages
 *     read, from `GET public/content` in the browser (see LatestArticles).
 *   - Modules and uptime: gone. The Terraform modules page lists six cards,
 *     not 22, and the availability probe reports to monitoring the visitor
 *     cannot see, so there is no figure the page could truthfully show.
 */
import { routes } from '@/lib/routeFactory';
import { normalizeContentFields, stripHtmlTags } from '@/lib/blogUtils';
import { getCanonicalContentType, getContentPublicPath } from '@/lib/contentModel';
import { canonicalizeProvider } from '@/lib/providers';
import { toMillis } from '@/lib/dateUtils';

// Eager: the counts are needed for the first render, which the pre-renderer
// captures. Each module is plain data, a few kilobytes in all.
const BLUEPRINT_MODULES = import.meta.glob('/src/pages/*/architecture-blueprints.js', {
  eager: true,
  import: 'staticBlueprints',
});

/** `{ aws: [...], azure: [...], ... }`, providers in path order. */
export const BLUEPRINTS_BY_PROVIDER = Object.freeze(
  Object.fromEntries(
    Object.entries(BLUEPRINT_MODULES)
      .map(([file, blueprints]) => [file.split('/').at(-2), blueprints || []])
      .sort(([a], [b]) => a.localeCompare(b))
  )
);

/** How many reference blueprints the architecture pages show, all providers together. */
export const BLUEPRINT_COUNT = Object.values(BLUEPRINTS_BY_PROVIDER).reduce(
  (sum, blueprints) => sum + blueprints.length,
  0
);

/**
 * The carousel's cards: every blueprint, one provider after another, so any
 * four in a row come from different providers while each has blueprints left.
 *
 * A blueprint with a `slug` has a page of its own (AWS's six, which
 * `data/architectures.js` backs); the rest open their provider's architecture
 * page, which is where they are shown. Nothing links to a page that is not
 * there.
 */
export function blueprintCards(byProvider = BLUEPRINTS_BY_PROVIDER) {
  const lists = Object.entries(byProvider).filter(([, blueprints]) => blueprints.length > 0);
  const longest = Math.max(0, ...lists.map(([, blueprints]) => blueprints.length));
  const cards = [];
  for (let index = 0; index < longest; index += 1) {
    for (const [provider, blueprints] of lists) {
      const blueprint = blueprints[index];
      if (!blueprint) continue;
      const page = routes.architectureDesigns(provider);
      cards.push({
        key: `${provider}:${blueprint.slug || blueprint.id || blueprint.title}`,
        provider,
        title: blueprint.title,
        category: blueprint.category,
        icon: blueprint.icon,
        to: blueprint.slug ? `${page}/${blueprint.slug}` : page,
      });
    }
  }
  return cards;
}

/** How many published items the home page asks for, and shows at most. */
export const LATEST_LIMIT = 6;

const TYPE_LABELS = Object.freeze({
  blog: 'Article',
  news: 'News',
  framework: 'Framework',
  architecture: 'Architecture',
  coder_corner: 'Code',
});

/** The same field order the blog list reads a published date from (useBlogData). */
function publishedMillis(doc) {
  for (const value of [
    doc.publishedDate,
    doc.datePublished,
    doc['Published At'],
    doc.blogPublishedAt,
    doc.publishedAt,
  ]) {
    const ms = toMillis(value);
    if (ms) return ms;
  }
  return 0;
}

/** "Jun 8, 2026". Fixed locale and zone, so every visitor reads the same day. */
export function formatPublishedDate(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Strips redundant "[In preview] Public Preview:" or "[Launched] Generally Available:" duplication.
 */
export function cleanFeedTitle(rawTitle) {
  if (!rawTitle) return '';
  return rawTitle
    .replace(/^\[In preview\]\s*(Public Preview:\s*)?/i, 'Public Preview: ')
    .replace(/^\[Launched\]\s*(Generally Available:\s*)?/i, 'GA: ')
    .trim();
}

/**
 * Truncates summary cleanly at the last complete word before maxLength.
 */
export function truncateAtWordBoundary(text, maxLength = 175) {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) return clean;
  const sliced = clean.slice(0, maxLength);
  return `${sliced.replace(/\s+\S*$/, '')}…`;
}

/**
 * Published documents, newest first as the server sends them, reduced to what
 * a card shows. A document with no page to open (no provider or no slug) or no
 * title is left out rather than shown as a dead card, and a page listed twice
 * is shown once. Multi-cloud diversity is preserved by capping any single provider
 * at maxPerProvider before backfilling.
 */
export function toLatestItems(docs = [], limit = LATEST_LIMIT, maxPerProvider = 2) {
  const seen = new Set();
  const candidates = [];
  for (const raw of docs || []) {
    const doc = normalizeContentFields(raw);
    const path = getContentPublicPath(raw);
    const rawTitle = stripHtmlTags(doc?.title || '').trim();
    if (!path || !rawTitle || seen.has(path)) continue;
    seen.add(path);
    const published = publishedMillis(raw);
    const rawSummary = stripHtmlTags(doc.summary || '').trim();
    candidates.push({
      path,
      title: cleanFeedTitle(rawTitle),
      summary: truncateAtWordBoundary(rawSummary, 175),
      provider: canonicalizeProvider(doc.cloudProvider),
      typeLabel: TYPE_LABELS[getCanonicalContentType(raw)] || 'Article',
      publishedIso: published ? new Date(published).toISOString() : '',
      publishedLabel: formatPublishedDate(published),
    });
  }

  // Pass 1: balanced selection up to limit, capping each provider at maxPerProvider
  const items = [];
  const providerCounts = {};
  const remaining = [];

  for (const item of candidates) {
    if (items.length >= limit) break;
    const count = providerCounts[item.provider] || 0;
    if (count < maxPerProvider) {
      items.push(item);
      providerCounts[item.provider] = count + 1;
    } else {
      remaining.push(item);
    }
  }

  // Pass 2: if fewer than limit, backfill from remaining candidates
  for (const item of remaining) {
    if (items.length >= limit) break;
    items.push(item);
  }

  return items;
}
