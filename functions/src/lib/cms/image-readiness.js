/**
 * image-readiness.js — whether a content item's images are ready to publish,
 * and the image prompt lineage recorded on it. Pure scoring logic, split out
 * of content-quality.js (which re-exports everything here) to keep each file
 * short. Nothing here touches storage, the network or process.env.
 */
import { getPublishContract } from './publish-contracts.js';

export const MIN_IMAGE_QUALITY_SCORE = 78;

/** The first value that is set (truthy), as trimmed text; '' when none is. */
const firstText = (...values) => String(values.find(Boolean) || '').trim();

export function buildImageReadinessReport(data = {}, publishTarget = null) {
  const contract = getPublishContract(
    publishTarget || data.publishTarget || data.type || data.contentType
  );
  const fields = imageFieldsOf(data);
  const issues = imageIssues(contract.imagery, fields);
  const score = imageScore(contract.imagery, fields, data);
  const { heroImageUrl, secondaryImageUrls, aiImageUrls, promptSet, promptName } = fields;
  return {
    score,
    ready: score >= MIN_IMAGE_QUALITY_SCORE && !issues.some((issue) => issue.includes('required')),
    threshold: MIN_IMAGE_QUALITY_SCORE,
    heroImageUrl,
    secondaryCount: secondaryImageUrls.length,
    aiSlots: Object.keys(aiImageUrls).filter((key) => aiImageUrls[key]),
    promptSet,
    promptName,
    issues,
  };
}

/** The image fields of a content item, each read from the first field name that is set. */
function imageFieldsOf(data) {
  return {
    heroImageUrl: firstText(data.heroImageUrl, data.altCoverImage, data.contentImageUrl, data.imageUrl),
    secondaryImageUrls: Array.isArray(data.secondaryImageUrls)
      ? data.secondaryImageUrls.filter(Boolean)
      : [],
    aiImageUrls:
      data.aiImageUrls && typeof data.aiImageUrls === 'object' ? data.aiImageUrls : {},
    promptSummary: firstText(data.summaryPrompt, data.imagePromptSeed, data.imageLineage?.summaryPrompt),
    promptDetails: firstText(data.detailsPrompt, data.imagePromptDetails, data.imageLineage?.detailsPrompt),
    promptSet: firstText(data.imagePromptSet, data.promptSet, data.imageLineage?.promptSet),
    promptName: firstText(data.imagePromptName, data.promptName, data.imageLineage?.promptName),
  };
}

const isNotHttps = (url) => Boolean(url) && !url.startsWith('https://');
const lacksPrompts = (fields) => !fields.promptSummary || !fields.promptDetails;
const lacksPromptName = (fields) => !fields.promptSet || !fields.promptName;

function imageIssues({ requireHero, requirePromptLineage }, fields) {
  const issues = [];
  if (requireHero && !fields.heroImageUrl) issues.push('Hero image is required.');
  if (isNotHttps(fields.heroImageUrl)) {
    issues.push('Hero image must use an https URL.');
  }
  if (requirePromptLineage && lacksPrompts(fields)) {
    issues.push('Image prompt summary and details are required for traceability.');
  }
  if (requirePromptLineage && lacksPromptName(fields)) {
    issues.push('Image prompt set and prompt name should be recorded.');
  }
  return issues;
}

function imageScore({ requireHero, requirePromptLineage }, fields, data) {
  let score = 100;
  if (requireHero) score -= heroPenalty(fields, data);
  if (isNotHttps(fields.heroImageUrl)) score -= 20;
  if (requirePromptLineage) {
    if (lacksPrompts(fields)) score -= 18;
    if (lacksPromptName(fields)) score -= 12;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

function heroPenalty(fields, data) {
  let penalty = 0;
  if (!fields.heroImageUrl) penalty += 35;
  if (fields.secondaryImageUrls.length === 0 && !fields.aiImageUrls.secondary1) penalty += 8;
  if (firstText(data.altText, data.imageAlt).length < 12) penalty += 7;
  return penalty;
}

export function normalizeSlotTemplates(slotTemplates = {}) {
  const keys = ['hero', 'secondary1', 'secondary2', 'secondary3'];
  return keys.reduce((acc, key) => {
    const value = String(slotTemplates?.[key] || '').trim();
    if (value) acc[key] = value;
    return acc;
  }, {});
}

export function buildImageLineage(data = {}) {
  return {
    promptSet: String(data.imagePromptSet || data.promptSet || '').trim(),
    promptName: String(data.imagePromptName || data.promptName || '').trim(),
    promptTemplateVersion: String(data.promptTemplateVersion || '').trim() || 'manual-create-v1',
    summaryPrompt: String(data.summaryPrompt || data.imagePromptSeed || '').trim(),
    detailsPrompt: String(data.detailsPrompt || data.imagePromptDetails || '').trim(),
    slotTemplates:
      data.slotTemplates && typeof data.slotTemplates === 'object'
        ? normalizeSlotTemplates(data.slotTemplates)
        : {},
  };
}
