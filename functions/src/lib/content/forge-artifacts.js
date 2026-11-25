/**
 * forge-artifacts.js — the pure steps of a forge run: the source fields it
 * reads, the deterministic post-processing of a draft, the image pack, the
 * usage totals and the reports stamped beside the draft. Split out of
 * forge.js, which re-exports them.
 */
import { findBannedPhrases, validateModules } from '../cms/content-modules.js';
import { lintSeo } from './seo-lint.js';
import {
  buildContentQualityReport,
  buildImageReadinessReport,
  ensureTldrSectionAtEnd,
} from '../cms/content-quality.js';
import { repairModules, scrubDashes } from './forge-pipeline.js';

/** The source fields a forge run reads, alias-coalesced; `{ error }` when it cannot run. */
export function resolveForgeSource(contentId, data) {
  if (!data)
    return { error: { ok: false, httpStatus: 404, error: `Content ${contentId} not found` } };
  const sourceMarkdown = String(
    [data.content, data.Content, data.postContent, data.blogDraft].find(Boolean) || ''
  );
  if (!sourceMarkdown.trim()) {
    return {
      error: { ok: false, httpStatus: 400, error: 'Source content is empty; ingest it first.' },
    };
  }
  return {
    data,
    sourceMarkdown,
    sourceUrl: String(data.sourceUrl || data.url || '').trim(),
    cloudProvider: data['Cloud Provider'] || data.cloudProvider || null,
    sourceTitle: data.Title || data.title || 'Untitled',
  };
}

/**
 * Deterministic post-processing of a generated draft: dash scrub, TL;DR,
 * banned-phrase scan, module validation with mechanical repair. Pure.
 */
export function postProcessForgedDraft(draft, data, prompts) {
  let forgedContent = String(draft.postContent || '');
  if (prompts.styleRules.noEmDash) forgedContent = scrubDashes(forgedContent);
  forgedContent = ensureTldrSectionAtEnd(forgedContent);

  const bannedHits = findBannedPhrases(forgedContent, prompts.extraBannedPhrases);
  let moduleReport = validateModules(forgedContent);
  let moduleRepairs = [];
  if (!moduleReport.valid) {
    const repaired = repairModules(forgedContent);
    if (repaired.repairs.length) {
      forgedContent = repaired.markdown;
      moduleRepairs = repaired.repairs;
      moduleReport = validateModules(forgedContent);
    }
  }
  const forgedTitle = prompts.styleRules.noEmDash
    ? scrubDashes(String(draft.title || data.Title || data.title || ''))
    : String(draft.title || '');
  const forgedSummary = prompts.styleRules.noEmDash
    ? scrubDashes(String(draft.summary || ''))
    : String(draft.summary || '');

  return { forgedContent, forgedTitle, forgedSummary, bannedHits, moduleReport, moduleRepairs };
}

/** Cover slot (when the draft carries prompts) plus one slot per picture-module prompt. */
export function buildForgeImagePack(draft, moduleReport) {
  return [
    ...(draft.summaryPrompt || draft.detailsPrompt
      ? [
          {
            slot: 'cover',
            prompt: [draft.summaryPrompt, draft.detailsPrompt].filter(Boolean).join(' '),
            status: 'pending',
          },
        ]
      : []),
    ...moduleReport.picturePrompts.map((prompt, index) => ({
      slot: `module:${index}`,
      prompt,
      status: 'pending',
    })),
  ];
}

/** Sum the usage records the router collected across generation + grading calls. */
export function sumForgeUsage(usageOut) {
  const totals = usageOut.reduce(
    (acc, entry) => ({
      calls: acc.calls + 1,
      promptTokens: acc.promptTokens + (entry.promptTokens || 0),
      completionTokens: acc.completionTokens + (entry.completionTokens || 0),
      costUsd: acc.costUsd + (entry.costUsd || 0),
    }),
    { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 }
  );
  totals.costUsd = parseFloat(totals.costUsd.toFixed(6));
  return totals;
}

/**
 * Everything a forge run stamps beside the draft: run metadata, the grade
 * record, and the two publish-gate reports built from the forged fields.
 */
export function buildForgeArtifacts({
  data,
  draft,
  forged,
  format,
  prompts,
  grade,
  clean,
  usageTotals,
  actor,
  stamp,
}) {
  const forgeMeta = {
    formatKey: format?.key || null,
    promptVersion: prompts.version,
    moduleCount: forged.moduleReport.moduleCount,
    moduleIssues: forged.moduleReport.issues,
    moduleRepairs: forged.moduleRepairs,
    bannedPhraseHits: forged.bannedHits,
    usage: usageTotals,
    forgedAt: stamp,
    forgedBy: actorName(actor),
  };
  const forgeGrade = {
    overall: grade.overall,
    subs: grade.subs,
    threshold: prompts.publishThreshold,
    skippedLlm: grade.skippedLlm === true,
    gradedAt: stamp,
    gradedBy: 'forge_pipeline',
    promptVersion: prompts.version,
    // Advisory only (backlog #6): surfaced in the preview banner and the
    // forge_ready note; never moves the overall or the staging decision.
    seo: lintSeo({
      title: forged.forgedTitle,
      summary: forged.forgedSummary,
      content: forged.forgedContent,
      keyTopics: draft.keyTopics || data.keyTopics,
    }),
  };
  const contentQuality = buildContentQualityReport(
    {
      ...data,
      Title: forged.forgedTitle,
      title: forged.forgedTitle,
      content: forged.forgedContent,
      postContent: forged.forgedContent,
    },
    {
      verdict: clean && grade.overall >= prompts.publishThreshold ? 'pass' : 'revise',
      genericityScore: null,
      specificityScore: null,
      issues: [
        ...(forged.moduleReport.issues || []),
        ...(forged.bannedHits.length ? [`Banned phrases: ${forged.bannedHits.join(', ')}`] : []),
        ...(grade.overall < prompts.publishThreshold
          ? [`Forge grade ${grade.overall}% is below threshold ${prompts.publishThreshold}%.`]
          : []),
      ],
    }
  );
  const imageReadiness = buildImageReadinessReport({
    ...data,
    summaryPrompt: draft.summaryPrompt || '',
    detailsPrompt: draft.detailsPrompt || '',
    imagePromptSet: data.imageLineage?.promptSet || '',
    imagePromptName: data.imageLineage?.promptName || '',
  });
  return { forgeMeta, forgeGrade, contentQuality, imageReadiness };
}

/** Who a forge run is recorded as. */
export function actorName(actor) {
  return actor?.email || actor?.oid || actor?.uid || 'forge';
}
