/**
 * podcast-episode.js — one podcast feed item as the `podcasts` document the
 * `fetchPodcastFeeds` timer (podcasts.js) writes for it. Pure functions;
 * podcasts.js exports them again, so callers keep importing from there.
 */

export function normalizePodcastId(guid, title) {
  return String(guid || title || '')
    .toLowerCase()
    .replace(/https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

/** `mediaUrl` / `mimeType` / `fileLength` from `enclosure`, then `media:content`. */
export function extractPodcastMediaFields(item) {
  if (item.enclosure && item.enclosure.url) {
    return {
      mediaUrl: item.enclosure.url,
      mimeType: item.enclosure.type || null,
      fileLength: item.enclosure.length || null,
    };
  }
  if (item['media:content']) {
    const mc = item['media:content'];
    return {
      mediaUrl: mc.$?.url || mc.url || null,
      mimeType: mc.$?.type || mc.type || null,
      fileLength: mc.$?.fileSize || mc.fileSize || null,
    };
  }
  return { mediaUrl: null, mimeType: null, fileLength: null };
}

/** Where an episode's image may be, in the order they are tried. */
const IMAGE_READERS = [
  (item) => item.itunes?.image?.href,
  (item) => typeof item.itunes?.image === 'string' && item.itunes.image,
  (item) => item.image?.url,
  (item) => item['itunes:image']?.href,
];

export function extractPodcastImage(item) {
  for (const read of IMAGE_READERS) {
    const image = read(item);
    if (image) return image;
  }
  return null;
}

export function parsePodcastPublishedDate(item) {
  const raw = item.isoDate || item.pubDate;
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function buildPodcastEpisode(provider, item, now) {
  const guid = item.guid || item.id || item.link || item.title;
  const publishedAt = parsePodcastPublishedDate(item);
  const { mediaUrl, mimeType, fileLength } = extractPodcastMediaFields(item);
  return {
    id: normalizePodcastId(guid, item.title),
    provider,
    title: item.title || '',
    description: item.contentSnippet || item.summary || '',
    longDescription: item['content:encoded'] || item.content || '',
    mediaUrl,
    mimeType,
    length: fileLength,
    duration: item.itunes?.duration || item['itunes:duration'] || null,
    image: extractPodcastImage(item),
    link: item.link || null,
    guid: guid || null,
    publishedAt: publishedAt ? publishedAt.toISOString() : null,
    updatedAt: now.toISOString(),
  };
}
