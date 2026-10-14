/**
 * feeds.js — the RSS ingest's data and pure helpers.
 *
 * Ported from Site-Main `functions/index.js` (PROVIDER_FEEDS through
 * buildHomepageFeedsDocument, commit 088f458) with the I/O taken out: every
 * function here is pure so the ingest (`./ingest.js`) is a thin loop over
 * them and the behaviour is testable without a feed or a database.
 *
 * Two representation changes, both deliberate and both already the convention
 * in this codebase:
 *   - timestamps are ISO strings, not Firestore Timestamps (the migration
 *     transform writes ISO; the readers handle both);
 *   - a new content document carries `id` (Cosmos has no auto-id) — the
 *     caller supplies the uuid, the same way content-create.js does.
 */
import { load as loadHtml } from 'cheerio';

/** One entry per provider key the public news pages know (NewsPage.jsx). */
export const PROVIDER_FEEDS = Object.freeze({
  azure: [
    { name: 'Azure Blog', url: 'https://azure.microsoft.com/en-us/blog/feed/' },
    // 'Azure Updates' (azurecomcdn.azureedge.net) was removed 2026-07: the CDN
    // endpoint is dead (redirects to a favicon). Its official replacement is
    // the 'Microsoft Azure Updates API' releasecommunications feed below.
    // 'Microsoft Partner Blog' was removed 2026-07: Microsoft retired its RSS
    // endpoint — /blog/feed/ now 403s for bots and serves plain HTML to
    // browsers, and no alternate feed URL exists.
    {
      name: 'Microsoft Azure Updates API',
      url: 'https://www.microsoft.com/releasecommunications/api/v2/azure/rss',
    },
    {
      name: 'Microsoft 365 Roadmap',
      url: 'https://www.microsoft.com/releasecommunications/api/v2/m365/rss',
    },
    {
      name: 'Azure Migration Blog',
      url: 'https://techcommunity.microsoft.com/t5/s/gxcuf89792/rss/board?board.id=AzureMigrationBlog',
    },
    {
      name: 'Azure Arc Blog',
      url: 'https://techcommunity.microsoft.com/t5/s/gxcuf89792/rss/board?board.id=AzureArcBlog',
    },
    { name: 'Microsoft Foundry Blog', url: 'https://devblogs.microsoft.com/foundry/feed/' },
    {
      name: 'Microsoft Learn Skills Hub',
      url: 'https://techcommunity.microsoft.com/t5/s/gxcuf89792/rss/board?board.id=skills-hub-blog',
    },
  ],
  aws: [
    { name: 'AWS Blog', url: 'https://aws.amazon.com/blogs/aws/feed/' },
    { name: 'AWS Whats New', url: 'https://aws.amazon.com/about-aws/whats-new/recent/feed/' },
    { name: 'AWS APN Partner Network', url: 'https://aws.amazon.com/blogs/apn/feed/' },
  ],
  gcp: [
    // cloud.google.com/blog/... "feed" paths stopped serving XML (they return
    // the blog's HTML shell); cloudblog.withgoogle.com hosts the real RSS.
    { name: 'Google Cloud Blog', url: 'https://cloudblog.withgoogle.com/rss/' },
    { name: 'GCP Release Notes', url: 'https://cloud.google.com/feeds/gcp-release-notes.xml' },
    { name: 'Google Cloud Partners', url: 'https://cloudblog.withgoogle.com/topics/partners/rss/' },
  ],
  github: [
    { name: 'GitHub Blog', url: 'https://github.blog/feed/' },
    { name: 'GitHub Changelog', url: 'https://github.blog/changelog/feed/' },
    { name: 'GitHub Developer Skills', url: 'https://github.blog/developer-skills/github/feed/' },
    { name: 'GitHub Copilot', url: 'https://github.blog/ai-and-ml/github-copilot/feed/' },
  ],
  terraform: [
    { name: 'HashiCorp Blog', url: 'https://www.hashicorp.com/blog/feed.xml' },
    // TF Weekly (weekly.tf) has no RSS feed.
  ],
  ansible: [
    // ansible.com/blog/rss.xml now redirects to an HTML page on redhat.com;
    // the Ansible content lives in Red Hat's per-channel blog feed.
    {
      name: 'Ansible Blog',
      url: 'https://www.redhat.com/en/rss/blog/channel/red-hat-ansible-automation',
    },
  ],
  vmware: [{ name: 'VMware Blogs', url: 'https://blogs.vmware.com/feed/' }],
  finops: [{ name: 'FinOps Foundation', url: 'https://www.finops.org/feed/' }],
  // #777. docker.com/blog/feed/ redirects here; the final URL, so the ingest
  // does not depend on the parser following a redirect. Read 2026-09-29 with
  // this module's parser and User-Agent: RSS 2.0, 10 items, newest 2026-09-24.
  docker: [{ name: 'Docker Blog', url: 'https://www.docker.com/feed/' }],
});

export const PROVIDERS = Object.freeze(Object.keys(PROVIDER_FEEDS));

export const PROVIDER_DISPLAY_NAMES = Object.freeze({
  azure: 'Microsoft Azure',
  aws: 'AWS',
  gcp: 'Google Cloud',
  github: 'GitHub',
  terraform: 'Terraform',
  ansible: 'Ansible',
  vmware: 'VMware',
  finops: 'FinOps',
  docker: 'Docker',
});

/** Items kept per feed in rss_cache — the write-time cap T-319 asked for. */
export const MAX_CACHE_ITEMS_PER_FEED = 20;
/** New content drafts created per feed per run. */
export const MAX_NEW_CONTENT_PER_FEED = 10;

const CATEGORY_MATCHERS = [
  { category: 'Security', terms: ['security', 'vulnerability', 'compliance'] },
  { category: 'AI/ML', terms: ['ai', 'machine learning', 'openai', 'copilot'] },
  { category: 'Containers', terms: ['kubernetes', 'container', 'docker', 'aks', 'eks', 'gke'] },
  { category: 'Serverless', terms: ['serverless', 'lambda', 'functions'] },
  { category: 'Database', terms: ['database', 'sql', 'cosmos', 'dynamo'] },
  { category: 'Networking', terms: ['network', 'vpc', 'cdn', 'dns'] },
  { category: 'Cost', terms: ['cost', 'pricing', 'finops', 'budget'] },
  { category: 'DevOps', terms: ['devops', 'ci/cd', 'pipeline', 'deploy'] },
  { category: 'Preview', terms: ['preview', 'beta'] },
  { category: 'GA', terms: ['generally available', 'ga '] },
];

/** HTML → text, whitespace-collapsed. */
export function plainText(html) {
  return loadHtml(String(html ?? ''), null, false)
    .text()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Truncate to `maxLength` on a word boundary, after stripping markup. */
export function truncateText(text, maxLength = 200) {
  if (!text) return '';
  const cleaned = plainText(text);
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.substring(0, maxLength).replace(/\s\S*$/, '')}...`;
}

/**
 * Strips redundant "[In preview] Public Preview:" or "[Launched] Generally Available:" duplication.
 */
export function cleanFeedTitle(rawTitle) {
  if (!rawTitle) return '';
  return String(rawTitle)
    .replace(/^\[In preview\]\s*(Public Preview:\s*)?/i, 'Public Preview: ')
    .replace(/^\[Launched\]\s*(Generally Available:\s*)?/i, 'GA: ')
    .trim();
}

/** "N min" at 200 words a minute, never under one. */
export function estimateReadTime(content) {
  if (!content) return '3 min';
  const wordCount = plainText(content).split(/\s+/).filter(Boolean).length;
  return `${Math.max(1, Math.ceil(wordCount / 200))} min`;
}

export function generateSlug(title) {
  return String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .substring(0, 60);
}

/**
 * Feed <category> entries aren't always plain strings: when the tag carries
 * attributes (e.g. GitHub Changelog's <category domain="changelog-type">),
 * xml2js parses it as a null-prototype object ({_: 'text', $: {attrs}}) that
 * throws "Cannot convert object to primitive value" on string coercion.
 * Normalize every shape down to a plain string array.
 */
export function normalizeCategories(categories) {
  return (Array.isArray(categories) ? categories : [])
    .map((c) => {
      if (typeof c === 'string') return c;
      if (c && typeof c === 'object') return c._ || c.$?.term || '';
      return '';
    })
    .map((c) => c.trim())
    .filter(Boolean);
}

export function categorizeItem(item) {
  const text =
    `${item.title || ''} ${item.contentSnippet || ''} ${normalizeCategories(item.categories).join(' ')}`.toLowerCase();
  const matched = CATEGORY_MATCHERS.find(({ terms }) => terms.some((term) => text.includes(term)));
  return matched ? matched.category : 'Update';
}

/** rss_cache document id for a provider + feed. */
export function cacheDocId(provider, feed) {
  return `${provider}_${String(feed.name).toLowerCase().replace(/\s+/g, '_')}`;
}

/**
 * The compact item shape the public feed and the homepage read.
 *
 * The cap keeps the NEWEST `max` items, not the first `max` (T-319).
 * Feed order is conventionally newest-first but nothing enforces it, and the
 * two readers of this array both sort by `pubDate` — buildHomepageFeedItems
 * below and useNewsData.js in the browser — so a feed that publishes in any
 * other order would have had its recent articles dropped here and then never
 * shown, with the cache looking full the whole time.
 *
 * Undated items sort last and are therefore dropped first: `Date.parse('')`
 * is NaN, and a missing date cannot be assumed to mean "now" without letting
 * one malformed item evict a dated one. When no item carries a date the
 * comparison is 0 throughout and the stable sort leaves feed order intact,
 * which is the previous behavior.
 */
export function buildCacheItems(items, feed, max = MAX_CACHE_ITEMS_PER_FEED) {
  const time = (item) => {
    const parsed = Date.parse(item?.pubDate || item?.isoDate || '');
    return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
  };
  return [...(items || [])]
    .sort((a, b) => {
      const at = time(a);
      const bt = time(b);
      // Equality first: two undated items would otherwise compare
      // `-Infinity - -Infinity`, which is NaN.
      return at === bt ? 0 : bt - at;
    })
    .slice(0, max)
    .map((item) => ({
      title: cleanFeedTitle(item.title || 'Untitled'),
      link: item.link || '',
      pubDate: item.pubDate || item.isoDate || '',
      summary: truncateText(item.contentSnippet || item.content || ''),
      category: categorizeItem(item),
      author: item.creator || item.author || feed.name,
    }));
}

/**
 * The content document for an RSS-ingested item — a Draft, `ingested`, not
 * Live, flagged for inspection. Field names are the site's (capitalised
 * legacy keys), which is what the migrated documents and every reader use.
 */
export function buildRssContentDoc({
  item,
  sourceUrl,
  title,
  summary,
  provider,
  feed,
  dedupFields,
  now,
  uuid,
}) {
  const stamp = now.toISOString();
  const bodyText = item.content || item.contentSnippet || '';
  const published = item.isoDate ? new Date(item.isoDate) : null;
  return {
    id: uuid(),
    ...dedupFields,
    'Created At': stamp,
    Author: item.creator || item.author || feed.name,
    'Cloud Provider': provider.charAt(0).toUpperCase() + provider.slice(1),
    Title: cleanFeedTitle(title),
    Content: bodyText,
    'CD Url': sourceUrl,
    Summary: summary,
    Slug: generateSlug(cleanFeedTitle(title)),
    Live: false,
    // Only set the article date when the feed actually provides one; a
    // "now" fallback would make fetch time masquerade as the publish date and
    // block the inspection-time date extraction.
    ...(published &&
      !Number.isNaN(published.getTime()) && { 'Published At': published.toISOString() }),
    Status: 'Draft',
    Tags: normalizeCategories(item.categories),
    source: 'rss',
    sourceTrustLevel: 'trusted',
    trustedSource: true,
    sourceUrl,
    sourceFeed: feed.url,
    storageCollection: 'content',
    category: categorizeItem(item),
    approvedForNews: false,
    contentStatus: 'ingested',
    inspectTrigger: true,
    aiSummary: '',
    aiTags: [],
    readTime: estimateReadTime(bodyText),
    contentImageUrl: item.enclosure?.url || '',
    fetchedAt: stamp,
    updatedAt: stamp,
  };
}

/**
 * A one-line plain-English reason for a feed failure, from the raw
 * "provider/feed: detail" string the ingest records.
 */
export function describeFeedError(rawError) {
  const match = /^([^/]+)\/([^:]+):\s*([\s\S]*)$/.exec(rawError);
  const provider = match ? PROVIDER_DISPLAY_NAMES[match[1]] || match[1] : '';
  const feedName = match ? match[2] : '';
  const detail = match ? match[3] : rawError;

  let reason;
  if (/TLS validation failed|UNABLE_TO_GET_ISSUER_CERT|CERT_HAS_EXPIRED/i.test(detail)) {
    reason =
      "their site's security certificate couldn't be verified, so we skipped it to stay safe";
  } else if (
    /Non-whitespace before first tag|Invalid character|Unexpected (end|close tag)|not well-formed|Unencoded/i.test(
      detail
    )
  ) {
    reason = "their feed sent back badly formatted data we couldn't read";
  } else if (/Status code (403|401)/i.test(detail)) {
    reason = 'their site refused the request (it may block automated readers)';
  } else if (/Status code 404/i.test(detail)) {
    reason = 'the feed address no longer exists';
  } else if (/Status code 5\d\d/i.test(detail)) {
    reason = 'their site had a server error';
  } else if (/timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN/i.test(detail)) {
    reason = "we couldn't reach their site in time";
  } else {
    reason = `we hit an unexpected problem (${truncateText(detail, 80)})`;
  }
  const label = feedName ? `${feedName}${provider ? ` (${provider})` : ''}` : provider || 'A feed';
  return `${label}: ${reason}.`;
}

/**
 * The homepage aggregate: the two newest items per provider, interleaved
 * round-robin across providers, ten in all — so the list alternates across
 * clouds rather than leading with whichever feed published most recently.
 *
 * @param {Record<string, object[]>} cacheDocsByProvider rss_cache documents
 * @param {object} [opts]
 * @returns {object[]}
 */
export function buildHomepageFeedItems(
  cacheDocsByProvider,
  { maxPerProvider = 2, total = 10 } = {}
) {
  const perProvider = {};
  for (const provider of PROVIDERS) {
    const all = [];
    for (const doc of cacheDocsByProvider[provider] || []) {
      for (const item of doc.items || []) {
        all.push({
          provider,
          title: cleanFeedTitle(item.title || 'Untitled'),
          description: truncateText(item.summary || '', 180),
          link: item.link || '',
          category: item.category || 'Update',
          pubDate: item.pubDate || '',
          feedName: doc.feedName || '',
        });
      }
    }
    perProvider[provider] = all
      .filter((item) => Boolean(item.link))
      .sort((a, b) => (Date.parse(b.pubDate) || 0) - (Date.parse(a.pubDate) || 0))
      .slice(0, maxPerProvider);
  }

  const items = [];
  for (let pass = 0; pass < maxPerProvider && items.length < total; pass += 1) {
    for (const provider of PROVIDERS) {
      if (items.length >= total) break;
      const candidate = perProvider[provider]?.[pass];
      if (candidate) items.push({ ...candidate, id: `${provider}-${pass}` });
    }
  }
  return items;
}
