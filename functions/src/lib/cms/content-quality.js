/**
 * Content quality, image readiness, and TL;DR shaping — pure scoring logic.
 * (Image readiness itself is in image-readiness.js, re-exported here.)
 *
 * Ported from Site-Main cms/core/content-quality.js, which its own header
 * describes as "logic that survives the Azure migration unchanged … at cutover
 * this file needs a CommonJS-to-ESM conversion and nothing else." That is what
 * this is: the conversion, plus the two internal `require`s re-pointed at the
 * modules already ported here (content-modules for the module/banned-phrase
 * primitives, publish-contracts for the per-type rubric).
 *
 * Nothing here touches Cosmos, the storage account, Key Vault, process.env, or
 * an HTTP request/response. `cheerio` is the only third-party import and is used
 * purely to strip HTML for a word count.
 */
import * as cheerio from 'cheerio';
import {
  validateModules,
  findBannedPhrases,
  scanBannedPhrases,
} from './content-modules.js';
import {
  getPublishContract,
  getContractBody,
  getMissingContractFields,
} from './publish-contracts.js';

export const MIN_ARTICLE_WORDS_FOR_PUBLISH = 650;
export const MIN_CONTENT_QUALITY_SCORE = 82;
export const PLACEHOLDER_TLDR_TEXT = 'Add the final takeaway summary here.';

// Image readiness is in image-readiness.js; re-exported so callers keep one door.
export {
  MIN_IMAGE_QUALITY_SCORE,
  buildImageLineage,
  buildImageReadinessReport,
  normalizeSlotTemplates,
} from './image-readiness.js';

export function getHeadingMatch(line = '') {
  const match = String(line).match(/^(#{1,6})\s+(.+?)\s*$/);
  if (!match) return null;
  return { level: match[1].length, title: match[2].trim() };
}

export function moveTldrSectionToEnd(markdown = '') {
  const source = String(markdown || '');
  if (!source.trim()) return source;

  const lines = source.split('\n');
  let startIndex = -1;
  let headingLevel = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const heading = getHeadingMatch(lines[index]);
    if (heading && /^tl;?dr\b/i.test(heading.title)) {
      startIndex = index;
      headingLevel = heading.level;
      break;
    }
  }

  if (startIndex < 0) return source;

  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const heading = getHeadingMatch(lines[index]);
    if (heading && heading.level <= headingLevel) {
      endIndex = index;
      break;
    }
  }

  const before = lines.slice(0, startIndex).join('\n').trimEnd();
  const section = lines.slice(startIndex, endIndex).join('\n').trim();
  const after = lines.slice(endIndex).join('\n').trim();

  if (!section) return source;

  return [before, after, section].filter(Boolean).join('\n\n').trim();
}

export function ensureTldrSectionAtEnd(markdown = '') {
  const source = String(markdown || '').trim();
  if (!source) return '';
  return moveTldrSectionToEnd(source);
}

export function normalizeContentBodyFields(data = {}) {
  const normalized = { ...data };
  ['Content', 'content', 'postContent', 'blogDraft'].forEach((key) => {
    if (typeof normalized[key] === 'string') {
      normalized[key] = ensureTldrSectionAtEnd(normalized[key]);
    }
  });
  return normalized;
}

/** The first value that is set (truthy), as trimmed text; '' when none is. */
const firstText = (...values) => String(values.find(Boolean) || '').trim();

export function getPrimaryContentBody(data = {}) {
  return firstText(data.postContent, data.blogDraft, data.content, data.Content);
}

export function countWords(value = '') {
  const withoutModules = String(value || '').replace(
    /<module\s+type="[^"]+"(?:\s+align="[^"]*")?\s*>[\s\S]*?<\/module>/g,
    ' '
  );
  return cheerio.load(withoutModules, null, false).text().split(/\s+/).filter(Boolean).length;
}

export function countHeadings(markdown = '') {
  return String(markdown || '')
    .split('\n')
    .filter((line) => /^#{2,4}\s+\S/.test(line.trim())).length;
}

export function hasPlaceholderContent(markdown = '') {
  const source = String(markdown || '').toLowerCase();
  return (
    source.includes(PLACEHOLDER_TLDR_TEXT.toLowerCase()) ||
    source.includes('[insert ') ||
    source.includes('todo:') ||
    source.includes('lorem ipsum')
  );
}

export function computeContentQualityScore({
  wordCount,
  headingCount,
  moduleCount,
  bannedPhraseHits = [],
  placeholderContent = false,
  critique = null,
  // Defaults reproduce the blog rubric for callers that score without a
  // contract, so an unqualified call behaves exactly as it did before.
  rubric = { minWords: MIN_ARTICLE_WORDS_FOR_PUBLISH, minHeadings: 3, minModules: 2 },
}) {
  let score = 100;
  if (wordCount < rubric.minWords) score -= 20;
  if (rubric.minHeadings > 0 && headingCount < rubric.minHeadings) score -= 10;
  if (rubric.minModules > 0 && moduleCount < rubric.minModules) score -= 12;
  if (bannedPhraseHits.length > 0) score -= Math.min(24, bannedPhraseHits.length * 8);
  if (placeholderContent) score -= 30;
  if (critique?.genericityScore >= 7) score -= 18;
  if (critique?.specificityScore <= 3) score -= 18;
  if (critique?.verdict === 'revise') score -= 12;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function buildContentQualityReport(data = {}, critique = null, publishTarget = null) {
  const contract = getPublishContract(
    publishTarget || data.publishTarget || data.type || data.contentType
  );
  const { minWords, minHeadings, minModules } = contract.rubric;
  const content = getContractBody(data, contract) || getPrimaryContentBody(data);
  const moduleReport = validateModules(content);
  const deterministicBannedHits = [
    ...new Set([
      ...scanBannedPhrases(`${data.Title || data.title || ''}\n${content}`),
      ...findBannedPhrases(content),
    ]),
  ];
  const wordCount = countWords(content);
  const headingCount = countHeadings(content);
  const placeholderContent = hasPlaceholderContent(content);
  const issues = [];

  const missingFields = getMissingContractFields(data, contract);

  if (wordCount < minWords) {
    issues.push(`${contract.label} is too thin (${wordCount} words; minimum ${minWords}).`);
  }
  if (minHeadings > 0 && headingCount < minHeadings) {
    issues.push(
      `${contract.label} needs more structure (${headingCount} section headings found; minimum ${minHeadings}).`
    );
  }
  if (minModules > 0 && moduleReport.moduleCount < minModules) {
    issues.push(
      `${contract.label} needs at least ${minModules} inline modules; found ${moduleReport.moduleCount}.`
    );
  }
  missingFields.forEach((label) => {
    issues.push(`${contract.label} is missing ${label}.`);
  });
  if (!moduleReport.valid) {
    issues.push(...moduleReport.issues.map((issue) => `Module issue: ${issue}`));
  }
  if (deterministicBannedHits.length > 0) {
    issues.push(`Remove AI-sounding phrase(s): ${deterministicBannedHits.join(', ')}.`);
  }
  if (placeholderContent) {
    issues.push('Remove placeholder content before saving or publishing.');
  }
  if (critique?.issues?.length) {
    issues.push(...critique.issues.map((issue) => `Editorial critique: ${issue}`));
  }

  const score = computeContentQualityScore({
    wordCount,
    headingCount,
    moduleCount: moduleReport.moduleCount,
    bannedPhraseHits: deterministicBannedHits,
    placeholderContent,
    critique,
    rubric: contract.rubric,
  });

  return {
    score,
    publishTarget: contract.target,
    contractLabel: contract.label,
    missingFields,
    ready: score >= MIN_CONTENT_QUALITY_SCORE && issues.length === 0,
    threshold: MIN_CONTENT_QUALITY_SCORE,
    wordCount,
    headingCount,
    moduleCount: moduleReport.moduleCount,
    moduleIssues: moduleReport.issues,
    bannedPhraseHits: deterministicBannedHits,
    placeholderContent,
    critique: critique
      ? {
          verdict: critique.verdict || null,
          genericityScore: critique.genericityScore ?? null,
          specificityScore: critique.specificityScore ?? null,
          issues: Array.isArray(critique.issues) ? critique.issues : [],
          error: critique.error || null,
        }
      : null,
    issues: issues.slice(0, 12),
  };
}
