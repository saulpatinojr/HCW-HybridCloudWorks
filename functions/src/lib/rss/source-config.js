/** Runtime blog sources. Built-in identities/trust stay server owned; overrides
 * live per source in the existing admin_settings container. */
import { createHash } from 'node:crypto';
import { PROVIDER_FEEDS, PROVIDERS, cacheDocId } from './feeds.js';
import { BLOG_SCRAPE_SOURCES } from '../timers/blog-listings.js';

export const SOURCE_KIND = 'blog_source';
export const sourceId = (kind, url) =>
  `blog-source-${createHash('sha256').update(`${kind}:${url}`).digest('hex').slice(0, 24)}`;
export const DEFAULT_BLOG_SOURCES = Object.freeze(
  [
    ...Object.entries(PROVIDER_FEEDS).flatMap(([provider, feeds]) =>
      feeds.map((feed) => ({
        ...feed,
        provider,
        kind: 'rss',
        cacheId: cacheDocId(provider, feed),
      }))
    ),
    ...BLOG_SCRAPE_SOURCES.map((source) => ({ ...source, kind: 'listing' })),
  ].map((source) => ({
    ...source,
    id: sourceId(source.kind, source.url),
    official: true,
    enabled: true,
    fallbackImageUrl: '',
    maxItems: source.kind === 'rss' ? 10 : 20,
  }))
);

export async function loadBlogSources(store) {
  const overrides = await store.queryDocs(
    'admin_settings',
    'SELECT * FROM c WHERE c.settingKind = @kind',
    [{ name: '@kind', value: SOURCE_KIND }]
  );
  const byId = new Map(overrides.map((doc) => [doc.id, doc]));
  const result = DEFAULT_BLOG_SOURCES.map((seed) => {
    const saved = byId.get(seed.id);
    byId.delete(seed.id);
    return {
      ...seed,
      ...saved,
      id: seed.id,
      builtIn: true,
      official: !saved || new URL(saved.url).hostname === new URL(seed.url).hostname,
      kind: seed.kind,
      provider: seed.provider,
      cacheId: seed.cacheId,
    };
  });
  // Stored custom sources cannot gain the official-source trust of the seeds.
  for (const doc of byId.values())
    result.push({ ...doc, cacheId: doc.id, builtIn: false, official: false });
  return result;
}

export function groupRssSources(sources) {
  const feeds = Object.fromEntries(PROVIDERS.map((provider) => [provider, []]));
  for (const source of sources) {
    if (source.enabled && source.kind === 'rss' && feeds[source.provider])
      feeds[source.provider].push(source);
  }
  return feeds;
}

export function validateSource(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new Error('Source settings required.');
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 120) throw new Error('Name must contain 1–120 characters.');
  if (!PROVIDERS.includes(body.provider)) throw new Error('Choose a supported provider.');
  if (!['rss', 'listing'].includes(body.kind)) throw new Error('Choose RSS or blog listing.');
  if (typeof body.enabled !== 'boolean') throw new Error('Enabled must be true or false.');
  const maxItems = Number(body.maxItems);
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 20)
    throw new Error('Article limit must be between 1 and 20.');
  const url = publicHttpsUrl(body.url);
  const fallbackImageUrl = body.fallbackImageUrl ? publicImageUrl(body.fallbackImageUrl) : '';
  return {
    name,
    provider: body.provider,
    kind: body.kind,
    enabled: body.enabled,
    url,
    fallbackImageUrl,
    maxItems,
  };
}

export function publicHttpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2048)
    throw new Error('Enter a public HTTPS URL.');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter a public HTTPS URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port)
    throw new Error('Use an HTTPS URL without credentials, port or fragment.');
  return url.href;
}

export function publicImageUrl(value) {
  // Gallery images use the application's public media route.
  if (
    typeof value === 'string' &&
    /^\/api\/public\/media\/(covers|blogs|certifications)\/[\w./%-]+$/.test(value) &&
    !value.includes('..')
  )
    return value;
  return publicHttpsUrl(value);
}

/** Apply a default only after source extraction has had a chance to find images. */
export function blogImageDefaults(doc, scrapedImages = [], env = process.env) {
  const imagePresent = (value) =>
    typeof value === 'string'
      ? Boolean(value.trim())
      : Array.isArray(value)
        ? value.some((item) => item?.downloadURL)
        : Boolean(value?.downloadURL);
  const hasCover = [
    doc.altCoverImage,
    doc.coverImage,
    doc['Cover Image'],
    doc.aiImageUrls?.hero,
  ].some(imagePresent);
  if (hasCover || imagePresent(doc.contentImageUrl)) return {};
  const articleImage = scrapedImages.find((image) => image.url || image.original);
  let image = articleImage?.original || articleImage?.url || doc.blogFallbackImageUrl;
  // Settings keep portable gallery paths; publishing requires a public HTTPS hero.
  if (image?.startsWith('/api/public/media/') && env.PUBLIC_API_ORIGIN?.startsWith('https://')) {
    image = new URL(image, env.PUBLIC_API_ORIGIN).href;
  }
  return image
    ? {
        contentImageUrl: image,
        coverImage: image,
        blogImageOrigin: articleImage ? 'article' : 'source-default',
      }
    : {};
}
