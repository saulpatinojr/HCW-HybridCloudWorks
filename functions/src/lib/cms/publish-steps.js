/**
 * publish-steps.js — the smaller steps of the publish pipeline in publish.js:
 * the metadata check, the resolved target and provider, the cover trigger,
 * and how one item's outcome is added to a batch's results. Re-exported by
 * publish.js.
 */
import { normalizePublishTarget, SUPPORTED_PUBLISH_TARGETS } from './publish-targets.js';
import { resolvePreferredPublishedDate, toValidDate } from './content-status.js';
import { normalizeProviderName } from './content-update-validation.js';

/** The first truthy value, or the last one when none is: what `a || b || c` gives. */
export function firstTruthy(values) {
  return values.find(Boolean) ?? values[values.length - 1];
}

export function getPublicSectionForPublishTarget(publishTarget) {
  switch (normalizePublishTarget(publishTarget)) {
    case 'framework':
      return 'frameworks';
    case 'architecture':
      return 'architecture-designs';
    case 'coder_corner':
      return 'code';
    case 'interview':
      return 'interviews';
    case 'blog':
    default:
      return 'blog';
  }
}

const isValidDateValue = (value) => {
  if (!value) return true;
  return toValidDate(value) !== null;
};

export function validatePublishMetadata({ contentData = {}, publishTarget, cloudProvider, slug }) {
  const errors = [];
  if (!SUPPORTED_PUBLISH_TARGETS.has(normalizePublishTarget(publishTarget))) {
    errors.push(`Invalid publishTarget: ${publishTarget}`);
  }
  if (!normalizeProviderName(cloudProvider)) {
    errors.push('Missing or invalid cloud provider');
  }
  if (!slug || typeof slug !== 'string' || !slug.trim()) {
    errors.push('Missing slug for publish path');
  }
  if (
    !isValidDateValue(
      contentData.publishedDate ||
        contentData.datePublished ||
        contentData['Published At'] ||
        contentData.publishedAt
    )
  ) {
    errors.push('Invalid Published At timestamp');
  }
  if (!isValidDateValue(contentData.scheduledPublishDate)) {
    errors.push('Invalid scheduledPublishDate timestamp');
  }
  return errors;
}

export function resolvePublishContext(contentData, params) {
  const effectivePublishTarget = normalizePublishTarget(
    params.publishTarget,
    contentData.publishTarget || contentData.type
  );
  const inferredProvider =
    normalizeProviderName(params.cloudProvider) ||
    normalizeProviderName(
      firstTruthy([
        contentData?.['Cloud Provider'],
        contentData?.cloudProvider,
        contentData?.provider,
        contentData?.Provider,
      ])
    );
  return {
    effectivePublishTarget,
    persistedPublishedDate: resolvePreferredPublishedDate(contentData),
    curatedSection: getPublicSectionForPublishTarget(effectivePublishTarget),
    inferredProvider,
    resolvedLandingProvider:
      normalizeProviderName(params.landingProvider) ||
      normalizeProviderName(contentData?.landingProvider) ||
      inferredProvider,
  };
}

/** R1 — fire cover generation at publish when no cover exists (source :1366). */
export function applyPublishTimeCoverTrigger(contentUpdate, contentData) {
  const hasExistingCover = [
    contentData.altCoverImage,
    contentData['Cover Image'],
    contentData.contentImageUrl,
    contentData.aiImageUrls?.hero,
    contentData.heroImageUrl,
    contentData.coverImage,
  ].some(Boolean);
  const alreadyTriggered = contentData.altCoverImageTrigger === true;
  if (hasExistingCover || alreadyTriggered) return;
  contentUpdate.altCoverImageTrigger = true;
  if (!Array.isArray(contentData.aiImageTargets) || contentData.aiImageTargets.length === 0) {
    contentUpdate.aiImageTargets = ['hero'];
  }
}

function buildPublishMappingEntry(contentId, r, reused) {
  return {
    contentId,
    blogId: r.blogId,
    reused,
    slug: r.slug || null,
    curatedSubpagePath: r.curatedSubpagePath || null,
    expectedPublicUrl: r.expectedPublicUrl || null,
    sourceUrl: r.sourceUrl || null,
    landingProvider: r.landingProvider || null,
  };
}

export function accumulatePublishResult(results, contentId, r) {
  if (r.error) {
    // `code` rides along when the refusal has a name the page keys on
    // (CONSENT_REQUIRED, INVALID_INTERVIEW: lib/interviews/publish-gate.js).
    results.errors.push({ contentId, error: r.error, ...(r.code ? { code: r.code } : {}) });
    return;
  }
  // Distinct from `reused`: nothing was written and there is no mapping to
  // report. Counted as skipped rather than published, because falling through
  // to the tail of this function would report a publish that did not happen.
  if (r.skipped) {
    results.skipped += 1;
    results.warnings.push({ contentId, warning: r.reason || 'Skipped' });
    return;
  }
  if (r.warning) {
    results.warnings.push({ contentId, warning: r.warning });
  }
  if (r.reused) {
    results.skipped += 1;
    results.mappings.push(buildPublishMappingEntry(contentId, r, true));
    if (!r.expectedPublicUrl) {
      results.warnings.push({
        contentId,
        warning: 'Published via existing mapping but expectedPublicUrl is missing.',
      });
    }
    return;
  }
  results.published += 1;
  results.mappings.push(buildPublishMappingEntry(contentId, r, false));
  if (!r.expectedPublicUrl) {
    results.warnings.push({
      contentId,
      warning: 'Publish completed but expectedPublicUrl is missing from mapping.',
    });
  }
}
