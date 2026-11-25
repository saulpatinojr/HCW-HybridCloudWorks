import { toMillis } from '@/lib/dateUtils';
import { postJSON } from '@/lib/api';
import { ensureTldrSectionAtEnd } from '@/lib/contentDraft';
import { firstField } from '@/components/shared/firstField';

// Pure helpers for useEditorState: reading the fields of a content document,
// which may use either the old or the new spelling of each field.

const PROVIDER_ALIASES = {
  amazon: 'aws',
  'amazon web services': 'aws',
  google: 'gcp',
  'google cloud': 'gcp',
  microsoft: 'azure',
};

function normalizeProvider(value = '') {
  const key = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
  return PROVIDER_ALIASES[key] || key.replace(/\s+/g, '');
}

const PROVIDER_FIELDS = ['Cloud Provider', 'cloudProvider', 'provider', 'Provider'];

export function getEditedAtMs(data = {}) {
  return toMillis(data.blogEditedAt);
}

function getEditorAuthor(data = {}) {
  return firstField(
    data,
    ['editorAuthor', 'siteAuthor', 'publishedByName', 'createdByName'],
    'Hybrid Cloud Works'
  );
}

function getDraftFromDoc(data = {}) {
  return ensureTldrSectionAtEnd(
    firstField(data, ['blogDraft', 'content', 'Content', 'postContent'], '')
  );
}

export function getBaselineDraftFromDoc(data = {}) {
  return ensureTldrSectionAtEnd(firstField(data, ['content', 'Content', 'postContent'], ''));
}

const SEGMENT_BY_TARGET = {
  framework: 'frameworks',
  architecture: 'architecture-designs',
  coder_corner: 'code',
  interview: 'interviews',
  news: 'news',
  rss: 'news',
};

export function getDestinationUrl(docData = {}) {
  const explicitUrl = firstField(
    docData,
    ['slugPageUrl', 'publishedUrl', 'blogUrl', 'publicUrl'],
    ''
  );
  if (explicitUrl) return explicitUrl;

  const provider = normalizeProvider(firstField(docData, PROVIDER_FIELDS, ''));
  const slug = docData.slug || docData.Slug || '';
  if (!provider || !slug) return null;

  const target = String(docData.publishTarget || docData.type || '').toLowerCase();
  const segment = SEGMENT_BY_TARGET[target] || 'blog';
  return `https://hybridcloudworks.com/${provider}/${segment}/${slug}`;
}

export function resolveBlogProvider(blog = {}) {
  return normalizeProvider(firstField(blog, PROVIDER_FIELDS, ''));
}

export async function requestAiDraft({ blog, draft, instruction }) {
  const sourceUrl = String(blog?.sourceUrl || blog?.url || '').trim();
  if (!sourceUrl) throw new Error('Missing source URL for AI generation.');
  const response = await postJSON('generateArticleDraft', {
    url: sourceUrl,
    cloudProvider: resolveBlogProvider(blog),
    draftText: draft,
    instructions: instruction,
  });
  return response?.draft || {};
}

export const INITIAL_FIELDS = {
  title: '',
  authorName: 'Hybrid Cloud Works',
  publishedDate: '',
  draft: '',
  summary: '',
  tags: '',
  sidebarContent: '',
};

const DATE_FIELDS = [
  'publishedDate',
  'datePublished',
  'Published At',
  'blogPublishedAt',
  'publishedAt',
];

// The document's publish date as YYYY-MM-DD, or today when it has none.
function publishedDateFromDoc(data) {
  let publishedDate = '';
  const rawDate = firstField(data, DATE_FIELDS, undefined);
  if (rawDate) {
    const dateObj = rawDate?.toDate?.() || rawDate;
    if (dateObj instanceof Date) {
      [publishedDate] = dateObj.toISOString().split('T');
    }
  }
  if (!publishedDate) {
    [publishedDate] = new Date().toISOString().split('T');
  }
  return publishedDate;
}

export function fieldsFromDoc(data) {
  if (!data) return INITIAL_FIELDS;
  return {
    title: data.Title || data.title || '',
    authorName: getEditorAuthor(data),
    publishedDate: publishedDateFromDoc(data),
    draft: getDraftFromDoc(data),
    summary: data.Summary || data.summary || '',
    tags: (data.Tags || data.keyTopics || []).join(', '),
    sidebarContent: data.sidebarContent || '',
  };
}

// `published` is the canonical spelling, `published_*` the Firestore-era
// one (ADR 0033 §1): either means the article has been published and a
// save republishes it rather than re-entering the queue.
export function isLiveDoc(blog) {
  const status = String(blog?.contentStatus || '');
  return blog?.Live === true || status === 'published' || status.startsWith('published_');
}

function scrapedCandidate(item, index) {
  return {
    id: firstField(item, ['url', 'src', 'stored', 'original'], `scraped-${index}`),
    // Prefer the archived Storage URL when present (published path);
    // fall back to the original source URL for drafts that haven't been
    // archived yet (F2 — archive deferred to publish-time).
    imageUrl: firstField(item, ['stored', 'url', 'src'], item.original),
    label: item.alt || `Scraped ${index + 1}`,
    source: 'scraped',
  };
}

// The images the editor offers to attach: scraped from the source first,
// then generated, then curated; at most 36, each with a URL.
export function buildImageCandidates(blog, curatedImages, generatedGalleryImages) {
  const curated = (curatedImages || []).map((item) => ({
    id: item.articleId || item.id,
    imageUrl: item.imageUrl,
    label: item.articleId || item.id || 'Curated image',
    source: 'gallery',
  }));

  const generated = (generatedGalleryImages || []).map((item) => ({
    id: item.id,
    imageUrl: item.imageUrl,
    label: firstField(item, ['title', 'articleId', 'id'], 'Generated image'),
    source: 'gallery',
  }));

  const scraped = (blog?.scrapedImages || []).map(scrapedCandidate);

  return [...scraped, ...generated, ...curated].filter((item) => item.imageUrl).slice(0, 36);
}

export function toOrderedImages(orderedImageUrls) {
  return orderedImageUrls.map((url, index) => ({
    id: `${index}-${url}`,
    url,
    label: index === 0 ? 'Hero' : `Secondary ${index}`,
    sourceLabel: 'Selected',
  }));
}

// The message shown when saving failed, and whether it was an edit conflict.
export function saveFailure(err) {
  const message = String(err?.message || '');
  if (message.includes('EDIT_CONFLICT')) {
    return {
      conflict: true,
      message: 'Save blocked: this document changed remotely. Refresh and reconcile changes.',
    };
  }
  if (message.includes('not found')) {
    return { conflict: false, message: 'Save failed: document no longer exists.' };
  }
  return { conflict: false, message: `Save failed: ${err.message}` };
}

export function isSaveShortcut(e) {
  return (e.ctrlKey || e.metaKey) && e.key === 's';
}
