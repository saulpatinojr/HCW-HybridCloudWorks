/**
 * The Stage-1-to-4 draft kept in sessionStorage, so a reload does not lose it.
 *
 * Read and write both live here (#634). They were split across a module-level
 * reader and an inline effect, which is how the two lists of fields drifted
 * out of sight of each other.
 *
 * Every read is defaulted, because the snapshot is whatever an older version of
 * this page happened to write — a missing field is normal, not a fault.
 */
import { isArticleTopic } from '@/lib/articleTopics';
import { ensureTldrSectionAtEnd } from '@/lib/contentDraft';

import { DEFAULT_DRAFT_INSTRUCTION_PROMPT } from './draftStage';
import { EMPTY_SLOT_IDS, EMPTY_SLOT_URLS } from './imageStage';

const BUILDER_SESSION_STORAGE_KEY = 'hcw-publish-ready-builder-draft';

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

export function readBuilderSnapshot() {
  try {
    const raw = window.sessionStorage.getItem(BUILDER_SESSION_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** The taxonomy (ADR 0033 §4); an older snapshot has neither, so a fresh page's defaults apply. */
function restoredTaxonomy(saved) {
  return {
    kind: saved.kind || 'article',
    ideaOrigin: saved.ideaOrigin || 'imported-source',
  };
}

function applyPrimaryBuilderSnapshot(saved, setters) {
  const {
    provider = '',
    blogLandingProvider = '',
    contentType = 'blog',
    title = '',
    publishedDate = '',
    sourceUrl = '',
    kbArticleUrls = [],
    kbDocumentUrl = '',
    kbDocumentUrls = [],
    draftInstructionPrompt = DEFAULT_DRAFT_INSTRUCTION_PROMPT,
    frameworkSourceUrls = '',
    frameworkKnowledgePrompt = '',
    frameworkDiagramPrompt = '',
    frameworkImagePrompt = '',
    frameworkConceptSeeds = '',
  } = saved;

  setters.setProvider(provider);
  setters.setTaxonomy?.(restoredTaxonomy(saved));
  setters.setBlogLandingProvider(blogLandingProvider);
  setters.setContentType(contentType);
  setters.setTitle(title);
  setters.setPublishedDate(publishedDate);
  setters.setSourceUrl(sourceUrl);
  setters.setKbArticleUrls(toArray(kbArticleUrls));
  setters.setKbDocumentUrl(kbDocumentUrl);
  setters.setKbDocumentUrls(toArray(kbDocumentUrls));
  setters.setDraftInstructionPrompt(draftInstructionPrompt);
  setters.setFrameworkSourceUrls(frameworkSourceUrls);
  setters.setFrameworkKnowledgePrompt(frameworkKnowledgePrompt);
  setters.setFrameworkDiagramPrompt(frameworkDiagramPrompt);
  setters.setFrameworkImagePrompt(frameworkImagePrompt);
  setters.setFrameworkConceptSeeds(frameworkConceptSeeds);
}

function applyDraftBuilderSnapshot(saved, setters) {
  const {
    draftTitle = '',
    draftSummary = '',
    draftContent = '',
    draftTopics = [],
    draftTopic = '',
    draftReady = false,
    summaryPrompt = '',
    detailsPrompt = '',
  } = saved;

  setters.setDraftTitle(draftTitle);
  setters.setDraftSummary(draftSummary);
  setters.setDraftContent(ensureTldrSectionAtEnd(draftContent));
  setters.setDraftTopics(toArray(draftTopics));
  setters.setDraftTopic?.(isArticleTopic(draftTopic) ? draftTopic : '');
  setters.setDraftReady(Boolean(draftReady));
  setters.setSummaryPrompt(summaryPrompt);
  setters.setDetailsPrompt(detailsPrompt);
}

function applyImageBuilderSnapshot(saved, setters) {
  const {
    generatedImages = {},
    generatedImageIds = {},
    selectedUploaded = {},
    selectedGenerated = {},
    aiTargets = {},
    slotUrls = {},
  } = saved;

  setters.setGeneratedImages({ ...EMPTY_SLOT_URLS, ...generatedImages });
  setters.setGeneratedImageIds({ ...EMPTY_SLOT_IDS, ...generatedImageIds });
  setters.setSelectedUploaded((prev) => ({ ...prev, ...selectedUploaded }));
  setters.setSelectedGenerated((prev) => ({ ...prev, ...selectedGenerated }));
  setters.setAiTargets((prev) => ({ ...prev, ...aiTargets }));
  setters.setSlotUrls({ ...EMPTY_SLOT_URLS, ...slotUrls });
}

export function applyBuilderSnapshot(saved, setters) {
  applyPrimaryBuilderSnapshot(saved, setters);
  applyDraftBuilderSnapshot(saved, setters);
  applyImageBuilderSnapshot(saved, setters);
}

/**
 * Persist the snapshot, ignoring storage failures.
 *
 * Private browsing and a full quota both throw here, and neither is worth
 * interrupting the operator for: the draft is still intact in memory, it just
 * will not survive a reload.
 */
export function writeBuilderSnapshot(snapshot) {
  try {
    window.sessionStorage.setItem(BUILDER_SESSION_STORAGE_KEY, JSON.stringify(snapshot));
    return true;
  } catch {
    return false;
  }
}

const REUSE_IMAGE_STORAGE_KEY = 'contentforge_reuse_image';

/**
 * The image another page asked this builder to reuse as the hero: the
 * `?reuseImage=` query wins, else the one the gallery left in localStorage,
 * which is consumed (removed) on read so it is used once. '' when neither.
 */
export function takeReuseImage(search) {
  const queryReuseImage = new URLSearchParams(search).get('reuseImage');
  let cachedReuseImage = '';
  try {
    cachedReuseImage = window.localStorage.getItem(REUSE_IMAGE_STORAGE_KEY) || '';
    window.localStorage.removeItem(REUSE_IMAGE_STORAGE_KEY);
  } catch {
    cachedReuseImage = '';
  }
  return queryReuseImage || cachedReuseImage;
}
