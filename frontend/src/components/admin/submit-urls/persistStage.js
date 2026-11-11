/**
 * Stage 4's persist machinery: the create payload and the two ways to save.
 *
 * Module-level functions over a state bag, as imageStage.js and draftStage.js
 * are (#634). This is the only stage that writes anything durable — Stages 2
 * and 3 are entirely in memory — which is the reason its payload builder is
 * pure and separately testable rather than inlined in a click handler.
 *
 * Behaviour here is deliberately identical to the inline handlers it replaces.
 */
import { ADMIN_ROUTES } from '@/config/admin';
import { postJSON } from '@/lib/api';
import { isArticleTopic } from '@/lib/articleTopics';
import { ensureTldrSectionAtEnd } from '@/lib/contentDraft';
import { getPublishTargetForType, getPublicSectionForTarget } from '@/lib/contentModel';

import { buildPreviewImageSelection } from './imageStage';
import { isValidHttpUrl } from './draftStage';

/** Split a textarea of URLs or seeds on newlines, commas or semicolons. */
export function parseLineItems(value = '') {
  return String(value)
    .split(/\n|,|;/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getEditorPath(contentId) {
  return ADMIN_ROUTES.EDITOR.replace(':id', contentId);
}

export function getQueueReviewPath(contentId) {
  return `${ADMIN_ROUTES.REVIEW.replace(':id', contentId)}?source=content`;
}

/**
 * The framework-only half of the payload, or nothing.
 *
 * Spread into the payload below, so a non-framework draft carries none of
 * these keys at all rather than carrying them empty.
 */
function frameworkFields({
  contentType,
  frameworkSourceUrls,
  frameworkKnowledgePrompt,
  frameworkDiagramPrompt,
  frameworkImagePrompt,
  frameworkConceptSeeds,
}) {
  if (contentType !== 'framework') return {};
  const parsedFrameworkSources = parseLineItems(frameworkSourceUrls).filter(isValidHttpUrl);
  return {
    frameworkSourceUrls: parsedFrameworkSources,
    officialSources: parsedFrameworkSources,
    frameworkKnowledgePrompt: frameworkKnowledgePrompt.trim(),
    frameworkDiagramPrompt: frameworkDiagramPrompt.trim(),
    frameworkImagePrompt: frameworkImagePrompt.trim(),
    frameworkConceptSeeds: parseLineItems(frameworkConceptSeeds),
  };
}

/** The image half, spread in so an absent hero contributes no keys. */
function imageFields({ heroImageUrl, secondaryImageUrls, aiImageUrls }) {
  return {
    ...(heroImageUrl && {
      heroImageUrl,
      contentImageUrl: heroImageUrl,
      altCoverImage: heroImageUrl,
    }),
    ...(secondaryImageUrls.length > 0 && { secondaryImageUrls }),
    aiImageUrls,
  };
}

/** The provider half, including the landing zone a blog provider implies. */
function providerFields({ provider, blogLandingProvider, publishTarget }) {
  return {
    cloudProvider: provider || null,
    ...(provider && { 'Cloud Provider': provider }),
    ...(blogLandingProvider && {
      landingProvider: blogLandingProvider,
      targetLandingZone: `/${blogLandingProvider.toLowerCase()}/${getPublicSectionForTarget(publishTarget)}`,
    }),
  };
}

/**
 * The createContentItem body.
 *
 * The duplicated casings (`Title` and `title`, `Content`/`content`/
 * `postContent`) are the stored schema's, not a mistake here: the collection
 * is read by both the older capitalised readers and the newer lowercase ones.
 * Pure, so the whole shape can be asserted without a network stub.
 */
export function buildContentCreatePayload({
  sourceUrl,
  sourceUrls,
  provider,
  blogLandingProvider,
  draftTitle,
  title,
  draftSummary,
  draftContent,
  draftTopics,
  draftTopic,
  summaryPrompt,
  detailsPrompt,
  publishedDate,
  heroImageUrl,
  secondaryImageUrls,
  aiImageUrls,
  contentType,
  kind,
  ideaOrigin,
  frameworkSourceUrls,
  frameworkKnowledgePrompt,
  frameworkDiagramPrompt,
  frameworkImagePrompt,
  frameworkConceptSeeds,
}) {
  const normalizedContent = ensureTldrSectionAtEnd(draftContent || '');
  const publishTarget = getPublishTargetForType(contentType);
  const resolvedTitle = draftTitle || title || '';
  const trimmedSource = sourceUrl.trim();

  return {
    url: trimmedSource,
    sourceUrl: trimmedSource,
    kbArticleUrls: Array.isArray(sourceUrls) ? sourceUrls : [],
    'CD Url': trimmedSource,
    source: 'manual_url',
    contentStatus: 'inspected',
    inspectTrigger: false,
    storageCollection: 'content',
    type: contentType,
    publishTarget,
    // The classification (ADR 0033 §4), only when Stage 1 set one; absent, the
    // server derives it from `type` and `source` at read time.
    ...(kind && { kind }),
    ...(ideaOrigin && { ideaOrigin }),
    ...providerFields({ provider, blogLandingProvider, publishTarget }),
    Title: resolvedTitle,
    title: resolvedTitle,
    Summary: draftSummary || '',
    summary: draftSummary || '',
    Content: normalizedContent,
    content: normalizedContent,
    postContent: normalizedContent,
    keyTopics: draftTopics,
    // The address topic (#1628), only when it is one of the list; absent,
    // the server picks one at publish.
    ...(isArticleTopic(draftTopic) && { topic: draftTopic }),
    imagePromptSeed: summaryPrompt,
    imagePromptDetails: detailsPrompt,
    summaryPrompt,
    detailsPrompt,
    ...(publishedDate && { 'Published At': new Date(publishedDate) }),
    ...imageFields({ heroImageUrl, secondaryImageUrls, aiImageUrls }),
    ...frameworkFields({
      contentType,
      frameworkSourceUrls,
      frameworkKnowledgePrompt,
      frameworkDiagramPrompt,
      frameworkImagePrompt,
      frameworkConceptSeeds,
    }),
    // Saving is not publishing. Both gates stay shut until a human opens them.
    Live: false,
    approvedForBlog: false,
  };
}

/**
 * Write the draft to the content collection and return its id, or null.
 *
 * Null on every failure path, including the readiness gate, because both
 * callers below branch on it: a falsy id must not produce a success message or
 * navigate away.
 */
export async function persistContentItem(state) {
  if (!state.canPreview || !state.readinessComplete) return null;

  const { heroImageUrl, secondaryImageUrls, aiImageUrls } = buildPreviewImageSelection({
    slotUrls: state.slotUrls,
    selectedUploaded: state.selectedUploaded,
    generatedImages: state.generatedImages,
    selectedGenerated: state.selectedGenerated,
  });

  try {
    const payload = buildContentCreatePayload({
      sourceUrl: state.kbArticleUrls[0] || state.sourceUrl,
      sourceUrls: state.kbArticleUrls,
      provider: state.resolvedProvider,
      blogLandingProvider: state.resolvedBlogLandingProvider,
      draftTitle: state.draftTitle,
      title: state.title,
      draftSummary: state.draftSummary,
      draftContent: state.draftContent,
      draftTopics: state.draftTopics,
      draftTopic: state.draftTopic,
      summaryPrompt: state.summaryPrompt,
      detailsPrompt: state.detailsPrompt,
      publishedDate: state.publishedDate,
      heroImageUrl,
      secondaryImageUrls,
      aiImageUrls,
      contentType: state.contentType,
      kind: state.kind,
      ideaOrigin: state.ideaOrigin,
      frameworkSourceUrls: state.frameworkSourceUrls,
      frameworkKnowledgePrompt: state.frameworkKnowledgePrompt,
      frameworkDiagramPrompt: state.frameworkDiagramPrompt,
      frameworkImagePrompt: state.frameworkImagePrompt,
      frameworkConceptSeeds: state.frameworkConceptSeeds,
    });

    const response = await postJSON('createContentItem', { data: payload });
    const contentId = response?.contentId || '';
    state.setSavedContentId(contentId);
    return contentId;
  } catch (err) {
    state.setError(err.message || 'Failed to save preview to content collection.');
    return null;
  }
}

/** Save and stay. */
export async function savePreview(state, event) {
  event.preventDefault();
  if (!state.canPreview || !state.readinessComplete) return;

  state.setPreviewSaving(true);
  state.setError('');
  state.setResult(null);
  try {
    const contentId = await persistContentItem(state);
    if (contentId) {
      state.setResult({ stage: 4, message: 'Draft saved to content collection.', contentId });
    }
  } finally {
    state.setPreviewSaving(false);
  }
}

/**
 * Save and open the editor.
 *
 * No success message: the navigation is the confirmation, and a result banner
 * on a page being left would only flash.
 */
export async function createAndOpenEditor(state) {
  if (!state.canPreview || !state.readinessComplete) return;

  state.setCreateAndOpenSaving(true);
  state.setError('');
  state.setResult(null);
  try {
    const contentId = await persistContentItem(state);
    if (contentId) {
      state.navigate(getEditorPath(contentId));
    }
  } finally {
    state.setCreateAndOpenSaving(false);
  }
}
