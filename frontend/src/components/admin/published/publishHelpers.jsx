import React from 'react';
import { Loader2 } from 'lucide-react';
import { getCoverImageUrl } from '@/lib/blogUtils';
import { byNewest } from '@/lib/dateUtils';
import { ADMIN_ROUTES } from '@/config/admin';
import { getCanonicalContentType } from '@/lib/contentModel';

export const MIN_BODY_CHARS = 200;

export function getPrePublishFailures(item) {
  const failures = [];
  if (!getCoverImageUrl(item)) {
    failures.push('Hero image is missing — add one via the Images panel.');
  }
  if (!String(item.Title || item.title || '').trim()) {
    failures.push('Title is empty.');
  }
  if (!String(item.Summary || item.summary || '').trim()) {
    failures.push('Summary is empty.');
  }
  const body = String(item.blogDraft || item.Body || item.body || item.Content || '');
  if (body.trim().length <= MIN_BODY_CHARS) {
    failures.push(`Body is too short (needs more than ${MIN_BODY_CHARS} characters).`);
  }
  const slug =
    String(item.slug || item.Slug || '').trim() || String(item.curatedSubpagePath || '').trim();
  if (!slug) {
    failures.push('Slug is missing.');
  }
  return failures;
}

export function slugRowOverride(result = {}) {
  const override = {};
  const slug = typeof result.slug === 'string' ? result.slug.trim() : '';
  if (slug) {
    override.slug = slug;
    override.Slug = slug;
  }
  const path =
    typeof result.curatedSubpagePath === 'string' ? result.curatedSubpagePath.trim() : '';
  if (path) override.curatedSubpagePath = path;

  const url = typeof result.publicUrl === 'string' ? result.publicUrl.trim() : '';
  if (url) {
    override.slugPageUrl = url;
    override.publishedUrl = url;
    override.publicUrl = url;
  }
  return override;
}

export function getReviewPath(contentId) {
  return ADMIN_ROUTES.REVIEW.replace(':id', contentId);
}

export function getItemProvider(item) {
  return item['Cloud Provider'] || item.cloudProvider || 'Unknown';
}

export function getItemTypeLabel(item) {
  const type = getCanonicalContentType(item);
  switch (type) {
    case 'framework':
      return 'Framework';
    case 'architecture':
      return 'Architecture';
    case 'coder_corner':
      return 'Coder Corner';
    case 'news':
      return 'News / RSS';
    case 'blog':
    default:
      return 'Blog';
  }
}

export const PUBLISH_HELP = [
  'What arrives here: items approved in the Review Queue or sent from the Editor (Approved, Forge ready, or Published but not yet live).',
  'What to do: open Images to set the hero and order, check the slug, then Publish. The pre-publish checklist names anything missing before it goes out.',
  'Publishing writes the public page and sets Live; Unpublish takes a page back to Inspected. Schedule from the Calendar when it should go out later.',
  'Where it goes next: a live page appears on Live Pages with its URL, can be read aloud as a podcast transcript, and is picked up by the newsletter and social tools.',
];

export const sortByUpdatedAtDesc = byNewest('updatedAt');
export const sortByPublishedAtDesc = byNewest('blogPublishedAt');

export function findPublishMapping(result, contentId) {
  if (!Array.isArray(result?.mappings)) return null;
  return result.mappings.find((entry) => entry.contentId === contentId) || null;
}

export function getPublishWarnings(result, contentId) {
  if (!Array.isArray(result?.warnings)) return [];
  return result.warnings.filter((warning) => warning.contentId === contentId);
}

export function buildPublishDebug(item, result, mapping) {
  return {
    contentId: item.id,
    blogId: mapping?.blogId || null,
    reused: Boolean(mapping?.reused),
    landingProvider: mapping?.landingProvider || null,
    slug: mapping?.slug || null,
    curatedSubpagePath: mapping?.curatedSubpagePath || null,
    expectedPublicUrl: mapping?.expectedPublicUrl || null,
    sourceUrl: mapping?.sourceUrl || null,
    warnings: getPublishWarnings(result, item.id),
  };
}

export function getPublishErrorMessage(mapping) {
  if (!mapping) {
    return 'Publish completed without mapping diagnostics. Check Azure Function logs.';
  }

  if (!mapping.expectedPublicUrl) {
    return 'Publish completed but published URL is missing. Check landingProvider/slug mapping in publish response.';
  }

  if (mapping.sourceUrl && mapping.expectedPublicUrl === mapping.sourceUrl) {
    return 'Publish completed but published URL matches source URL. This indicates a mapping issue.';
  }

  return '';
}

export function getPublishButtonContent(isSubmitting, isLive) {
  if (isSubmitting) {
    return <Loader2 className="h-4 w-4 animate-spin" />;
  }

  return isLive ? 'Published' : 'Publish';
}
