/**
 * forge.js — the ContentForge pipeline: one ingested/inspected document in,
 * a graded, module-validated draft staged for publish (or routed to editing)
 * out.
 *
 * Ported from Site-Main `cms/forge.js` `runForgePipeline` and its seams
 * (088f458). Stages: dedupe against the published corpus → load config →
 * rotating format → compose prompt → generate → deterministic scrub,
 * banned-phrase check and module validation (with mechanical repair) →
 * versioned save → inline grade → status routing (`forge_ready` when the
 * grade clears the publish threshold and the draft is clean, otherwise
 * `editing`).
 *
 * Two behaviours preserved because they look like bugs:
 *   1. Dedupe fails open — a store hiccup never blocks generation.
 *   2. bumpForgeStats is best-effort — a failed counter never fails a run.
 *
 * One difference from upstream, stated: Firestore wrote the content update,
 * the version snapshot and the audit entry in one transaction. Cosmos cannot
 * span three containers, so they are written in that order (content first,
 * as content-update.js does); a failure after the first write leaves a
 * forged document without its version row, which the next save records.
 *
 * Not ported: `forgeScheduled` (the daily auto-forge timer, T-323),
 * `gradeContentItem` / `assignForgeImages` / the config endpoints — the
 * ContentForge admin page that calls them is a T-409 scoped port.
 */
import { randomUUID } from 'node:crypto';
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { findBannedPhrases, validateModules, MAX_MODULES } from '../cms/content-modules.js';
import { findRelatedPublished, buildRelatedReadingModule } from './related-posts.js';
import { lintSeo } from './seo-lint.js';
import {
  buildContentQualityReport,
  buildImageReadinessReport,
  ensureTldrSectionAtEnd,
} from '../cms/content-quality.js';
import { applyPublishTimeCoverTrigger } from '../cms/publish.js';
import { buildVoiceAndFormatBlock, pickNextFormat } from './voice.js';
import {
  buildForgeModuleInstruction,
  findSimilarTitle,
  repairModules,
  scrubDashes,
} from './forge-pipeline.js';

/** The source fields a forge run reads, alias-coalesced; `{ error }` when it cannot run. */
export function resolveForgeSource(contentId, data) {
  if (!data)
    return { error: { ok: false, httpStatus: 404, error: `Content ${contentId} not found` } };
  const sourceMarkdown = String(
    data.content || data.Content || data.postContent || data.blogDraft || ''
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

function actorName(actor) {
  return actor?.email || actor?.oid || actor?.uid || 'forge';
}

/**
 * The rolling day bucket as an integer, e.g. 2026-08-28 → 20260828.
 *
 * `incrementIf`'s predicate takes numeric bindings only — deliberately, so
 * nothing string-interpolates into SQL — and the budget claim has to compare
 * "is this still today?" server-side. Carried alongside the human-readable
 * `today.date`, which stays the field everything else reads.
 */
export function dayNumber(date) {
  return date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
}

/** Retries for the budget claim's rollover path; matches the submission quota. */
export const FORGE_BUDGET_ATTEMPTS = 3;

/** Apply dotted-path increments ('totals.forged': 1) to a plain object, in place. */
export function applyIncrements(target, increments = {}) {
  for (const [path, amount] of Object.entries(increments)) {
    const segments = path.split('.');
    let node = target;
    for (const segment of segments.slice(0, -1)) {
      if (!node[segment] || typeof node[segment] !== 'object') node[segment] = {};
      node = node[segment];
    }
    const last = segments[segments.length - 1];
    node[last] = (Number(node[last]) || 0) + amount;
  }
  return target;
}

/**
 * @param {object} deps
 * @param {{ readDoc: Function, queryDocs: Function, patchDoc: Function, upsertDoc: Function }} deps.store
 * @param {{ loadForgeProfile: Function, loadForgePrompts: Function }} deps.config
 * @param {{ generateDraft: Function }} deps.drafter
 * @param {{ gradeArticle: Function }} deps.grader
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 * @param {{ log?: Function, warn?: Function, error?: Function }} [deps.log]
 */
export function createForge({
  store,
  config,
  drafter,
  grader,
  now = () => new Date(),
  uuid = randomUUID,
  log = {},
  signal: defaultSignal,
}) {
  // Fails open: a store hiccup never blocks generation. One fetch serves two
  // consumers — the dedupe gate (titles) and the related-posts interlinker
  // (ids, topics and URLs), so the corpus is read once per run.
  async function fetchPublishedCorpus() {
    try {
      const rows = await store.queryDocs(
        'content',
        'SELECT TOP 300 c.id, c.Title, c.title, c.keyTopics, c.publishedUrl, c.publicUrl, c.curatedSubpagePath, c.slugPageUrl FROM c WHERE c.Live = true',
        []
      );
      return rows || [];
    } catch (err) {
      log.warn?.(`fetchPublishedCorpus failed (dedupe + interlinking skipped): ${err.message}`);
      return [];
    }
  }

  // Best-effort counters in admin_config/forge_stats (read-modify-write; the
  // same shape cms/publish.js bumps on publish). `today` is a single rolling
  // day bucket, reset on date change — the autoForge.dailyLimit enforcement
  // (lib/timers/forge-scheduled.js) reads it, and keeping only the current
  // day stops the document growing forever (T-607).
  /**
   * Claim one unit of the daily forge budget, atomically (T-761).
   *
   * This is the system's only AI-spend ceiling, and before this existed it was
   * enforced in one place — the scheduler — by reading `today.forged`,
   * computing `remaining` once, and then looping. Three things were wrong with
   * that. The ledger it trusted was written by `bumpForgeStats`, a
   * read-modify-write that swallows its own failures, so the count could be
   * silently low. `remaining` was computed before the loop, so a manual forge
   * running concurrently was never observed. And the count was incremented
   * *after* the model calls, so a run killed mid-flight spent tokens the
   * ledger never recorded.
   *
   * The claim happens before any model call and is a server-side
   * compare-and-increment, so concurrent callers serialize on the document and
   * exactly `limit` of them pass — the same primitive and the same two-path
   * shape as `enforceSubmissionQuota`, for the same reason.
   *
   * `enforce: false` still increments. That is the point: editor-initiated
   * forging is deliberately uncapped, but it must still be *counted*, or the
   * scheduler's ceiling is measured against a number that ignores half the
   * spending.
   *
   * @returns {Promise<{claimed: boolean, forgedToday?: number}>}
   */
  async function claimForgeBudget({ limit, enforce = false } = {}) {
    const date = now();
    const todayKey = date.toISOString().slice(0, 10);
    const day = dayNumber(date);
    const cap = Number.isFinite(limit) ? limit : Number.MAX_SAFE_INTEGER;

    for (let attempt = 0; attempt < FORGE_BUDGET_ATTEMPTS; attempt += 1) {
      try {
        const doc = await store.incrementIf('admin_config', 'forge_stats', {
          path: '/today/forged',
          value: 1,
          condition: enforce
            ? 'FROM c WHERE c.today.dateNum = @day AND c.today.forged < @limit'
            : 'FROM c WHERE c.today.dateNum = @day',
          conditionValues: { day, limit: cap },
          partitionKey: ADMIN_CONFIG_PARTITION,
        });
        return { claimed: true, forgedToday: Number(doc?.today?.forged) || 0 };
      } catch (err) {
        // 404: no stats document yet. 412: the predicate failed — either the
        // day rolled over or we are genuinely at the limit, and only a read
        // can tell which. Anything else is a real fault; a budget that fails
        // open on an unknown error is not a budget.
        if (err?.code !== 404 && err?.code !== 412) throw err;
      }

      const existing =
        (await store.readDoc('admin_config', 'forge_stats', ADMIN_CONFIG_PARTITION)) || null;
      const sameDay = Number(existing?.today?.dateNum) === day;
      const forgedToday = sameDay ? Number(existing?.today?.forged) || 0 : 0;

      if (sameDay && enforce && forgedToday >= cap) {
        return { claimed: false, forgedToday };
      }

      // Roll the bucket over (or create it) with this claim already counted.
      // The primitives have a loser — 412 on a concurrent replace, 409 on a
      // concurrent create — and the loser goes back around the loop, where the
      // winner's document now exists and the fast path applies.
      const today = { date: todayKey, dateNum: day, forged: 1 };
      try {
        if (existing) {
          await store.replaceDocIfMatch(
            'admin_config',
            { ...existing, today, updatedAt: date.toISOString() },
            { partitionKey: ADMIN_CONFIG_PARTITION }
          );
        } else {
          await store.createDoc('admin_config', {
            id: 'forge_stats',
            configScope: ADMIN_CONFIG_PARTITION,
            today,
            updatedAt: date.toISOString(),
          });
        }
        return { claimed: true, forgedToday: 1 };
      } catch (err) {
        if (err?.code !== 409 && err?.code !== 412) throw err;
      }
    }

    // Contention this sustained is not a normal condition. Refusing is the
    // safe direction for a spend ceiling: the next scheduled run retries.
    log.warn?.('claimForgeBudget: exhausted attempts under contention');
    return { claimed: false, forgedToday: cap };
  }

  async function bumpForgeStats(increments = {}) {
    try {
      const doc =
        (await store.readDoc('admin_config', 'forge_stats', ADMIN_CONFIG_PARTITION)) || {};
      const todayKey = now().toISOString().slice(0, 10);
      const today =
        doc.today?.date === todayKey ? { ...doc.today } : { date: todayKey, forged: 0 };
      const next = applyIncrements(
        { totals: { ...(doc.totals || {}) }, formats: structuredClone(doc.formats || {}), today },
        increments
      );
      next.updatedAt = now().toISOString();
      if (doc.id) {
        await store.patchDoc('admin_config', 'forge_stats', next, {
          partitionKey: ADMIN_CONFIG_PARTITION,
        });
      } else {
        await store.upsertDoc('admin_config', {
          id: 'forge_stats',
          configScope: ADMIN_CONFIG_PARTITION,
          ...next,
        });
      }
    } catch (err) {
      log.warn?.(`bumpForgeStats failed: ${err.message}`);
    }
  }

  async function saveForgeOutcome({
    contentId,
    actor,
    data,
    forged,
    format,
    prompts,
    grade,
    nextStatus,
    draft,
    artifacts,
    imagePack,
  }) {
    const stamp = now().toISOString();
    const by = actorName(actor);
    const update = {
      Title: forged.forgedTitle,
      Summary: forged.forgedSummary,
      blogDraft: forged.forgedContent,
      content: forged.forgedContent,
      keyTopics: Array.isArray(draft.keyTopics) ? draft.keyTopics.slice(0, 12) : [],
      // Series metadata (backlog #5): the published posts the appended
      // "Related reading" module links to; absent when nothing related.
      ...(Array.isArray(forged.relatedContentIds) && forged.relatedContentIds.length
        ? { relatedContentIds: forged.relatedContentIds }
        : {}),
      format: format?.key || null,
      contentStatus: nextStatus,
      Live: false,
      forgeMeta: artifacts.forgeMeta,
      forgeGrade: artifacts.forgeGrade,
      forgeImagePack: imagePack,
      contentQuality: artifacts.contentQuality,
      imageReadiness: artifacts.imageReadiness,
      imageQuality: artifacts.imageReadiness,
      blogEditedAt: stamp,
      updatedAt: stamp,
      updatedBy: by,
    };
    // Cover at forge_ready so the image pipeline fires at staging; the
    // publish-time call stays as the idempotent safety net. The notify flag
    // is boolean because the rising-edge claim requires one — contentStatus
    // itself is not a flag (lib/triggers/forge-ready-notify.js).
    if (nextStatus === 'forge_ready') {
      applyPublishTimeCoverTrigger(update, data);
      update.forgeReadyNotifyTrigger = true;
    }

    await store.patchDoc('content', contentId, update);
    await store.upsertDoc('content_versions', {
      id: uuid(),
      contentId,
      title: forged.forgedTitle,
      summary: forged.forgedSummary,
      draft: forged.forgedContent,
      versionCreatedAt: stamp,
      versionCreatedBy: by,
      versionReason: 'forge_generated',
    });
    await store.upsertDoc('admin_audit_logs', {
      id: uuid(),
      action: 'content_forged',
      userId: actor?.oid || actor?.uid || null,
      userEmail: actor?.email || null,
      timestamp: stamp,
      details: {
        contentId,
        formatKey: format?.key || null,
        overall: grade.overall,
        threshold: prompts.publishThreshold,
        nextStatus,
        moduleCount: forged.moduleReport.moduleCount,
        moduleIssues: forged.moduleReport.issues,
        moduleRepairs: forged.moduleRepairs,
        bannedPhraseHits: forged.bannedHits,
        imagePackSlots: imagePack.length,
      },
      userAgent: null,
      contentId,
      contentTitle: forged.forgedTitle,
      compliance: { schemaVersion: 1, detailsSanitized: true, identityVerified: true },
    });
  }

  /**
   * Forge one document. Resolves to `{ ok: true, result }` or
   * `{ ok: false, httpStatus, error, duplicateOf? }`; never throws for a
   * pipeline outcome, only for a store failure on the save.
   */
  async function runForgePipeline({ contentId, actor, budget, signal: callSignal }) {
    const activeSignal = callSignal || defaultSignal;
    if (activeSignal?.aborted) throw activeSignal.reason || new Error('aborted');
    const source = resolveForgeSource(
      contentId,
      await store.readDoc('content', contentId, contentId)
    );
    if (source.error) return source.error;
    const { data, sourceMarkdown, sourceUrl, cloudProvider, sourceTitle } = source;

    // 0. Dedupe against the published corpus before spending tokens
    const corpus = await fetchPublishedCorpus();
    const dupe = findSimilarTitle(
      sourceTitle,
      corpus.map((row) => row?.Title || row?.title || '').filter(Boolean)
    );
    if (dupe.similar) {
      await bumpForgeStats({ 'totals.skippedDuplicates': 1 });
      return {
        ok: false,
        httpStatus: 409,
        error: `Skipped as likely duplicate of published "${dupe.bestTitle}" (similarity ${Math.round(dupe.bestScore * 100)}%).`,
        duplicateOf: dupe.bestTitle,
      };
    }

    // 0b. Claim the day's budget before spending anything (T-761). After the
    // dedupe check deliberately — a document refused as a duplicate costs no
    // tokens, so charging it against the ceiling would under-serve the day.
    // Before every model call, equally deliberately: a run killed halfway
    // through has already spent, and a ceiling that only counts completed runs
    // is not counting the spend it exists to bound.
    const claim = await claimForgeBudget(budget);
    if (!claim.claimed) {
      return {
        ok: false,
        httpStatus: 429,
        error: `Daily forge budget reached (${claim.forgedToday}/${budget?.limit}). The next scheduled run will retry.`,
        budgetExhausted: true,
      };
    }

    // 1. Config + format rotation
    const [profile, prompts] = await Promise.all([
      config.loadForgeProfile(),
      config.loadForgePrompts(),
    ]);
    const format = await pickNextFormat(store, 'content', cloudProvider);

    // 2. Compose the forge prompt
    const voiceBlock = buildVoiceAndFormatBlock(cloudProvider, format, {
      masterPrompt: prompts.masterPrompt,
      extraBanned: prompts.extraBannedPhrases,
      styleRules: prompts.styleRules,
    });
    const wordSoupBlock = profile.wordSoup
      ? `\n\nOwner context (weave in perspective where genuinely relevant, never force it):\n${profile.wordSoup.slice(0, 3000)}`
      : '';
    const forgeInstruction = `${voiceBlock}\n\n${buildForgeModuleInstruction(format)}${wordSoupBlock}`;

    // 3. Generate
    const usageOut = [];
    let draft;
    try {
      draft = await drafter.generateDraft({
        url: sourceUrl || 'https://hybridcloudworks.com',
        cloudProvider,
        scrapedTitle: sourceTitle,
        description: data.Summary || data.summary || '',
        markdown: sourceMarkdown,
        // The composed block IS the authority for this draft, not an additive
        // admin note: passed as voiceBlock (with its format) it replaces the
        // drafter's own unconfigured copy instead of stacking under it.
        voiceBlock: forgeInstruction,
        format,
        usageOut,
        signal: activeSignal,
      });
    } catch (err) {
      log.error?.(`forge generation failed: ${err.message}`);
      return { ok: false, httpStatus: 502, error: `Generation failed: ${err.message}` };
    }
    if (draft?.aiError)
      return { ok: false, httpStatus: 502, error: `Generation failed: ${draft.aiError}` };

    // 4. Deterministic post-processing
    const forged = postProcessForgedDraft(draft, data, prompts);

    // 4b. Series interlinking (backlog #5): propose a "Related reading"
    // links module from the corpus fetched at step 0, plus series metadata.
    // Appended AFTER repair (a valid links module cannot break validity) and
    // BEFORE grading, so the grade judges what will actually publish; skipped
    // when the draft is already at the module cap. Only posts with a real
    // public URL qualify, so an empty corpus or URL-less rows are a no-op.
    const related = findRelatedPublished(corpus, {
      title: forged.forgedTitle,
      keyTopics: draft.keyTopics || data.keyTopics,
    });
    if (related.length && forged.moduleReport.moduleCount < MAX_MODULES) {
      forged.forgedContent = `${forged.forgedContent}\n\n${buildRelatedReadingModule(related)}`;
      forged.moduleReport = validateModules(forged.forgedContent);
      forged.relatedContentIds = related.map((entry) => entry.id);
    }

    // 5. Grade
    let grade;
    try {
      grade = await grader.gradeArticle(
        { title: forged.forgedTitle, summary: forged.forgedSummary, content: forged.forgedContent },
        profile,
        { usageOut, signal: activeSignal }
      );
    } catch (err) {
      log.error?.(`forge grading failed: ${err.message}`);
      grade = { overall: 0, subs: [], skippedLlm: true, note: `Grading failed: ${err.message}` };
    }

    const clean = forged.bannedHits.length === 0 && forged.moduleReport.valid;
    const nextStatus =
      grade.overall >= prompts.publishThreshold && clean ? 'forge_ready' : 'editing';
    const imagePack = buildForgeImagePack(draft, forged.moduleReport);
    const usageTotals = sumForgeUsage(usageOut);
    const artifacts = buildForgeArtifacts({
      data,
      draft,
      forged,
      format,
      prompts,
      grade,
      clean,
      usageTotals,
      actor,
      stamp: now().toISOString(),
    });

    // 6. Save + status routing + audit
    await saveForgeOutcome({
      contentId,
      actor,
      data,
      forged,
      format,
      prompts,
      grade,
      nextStatus,
      draft,
      artifacts,
      imagePack,
    });

    const statsFormatKey = format?.key || 'unknown';
    await bumpForgeStats({
      'totals.forged': 1,
      // NOT 'today.forged' — claimForgeBudget already counted this run before
      // the model calls. Incrementing here too would double-count, and worse,
      // would put the ceiling's ledger back in the hands of a best-effort
      // write that swallows its own failures (T-761).
      [`totals.${nextStatus === 'forge_ready' ? 'staged' : 'editing'}`]: 1,
      'totals.costUsd': usageTotals.costUsd,
      [`formats.${statsFormatKey}.forged`]: 1,
      [`formats.${statsFormatKey}.costUsd`]: usageTotals.costUsd,
      ...(nextStatus === 'forge_ready' ? { [`formats.${statsFormatKey}.staged`]: 1 } : {}),
    });

    return {
      ok: true,
      result: {
        success: true,
        contentId,
        status: nextStatus,
        overall: grade.overall,
        threshold: prompts.publishThreshold,
        formatKey: format?.key || null,
        moduleCount: forged.moduleReport.moduleCount,
        moduleIssues: forged.moduleReport.issues,
        moduleRepairs: forged.moduleRepairs,
        bannedPhraseHits: forged.bannedHits,
        imagePackSlots: imagePack.length,
        usage: usageTotals,
      },
    };
  }

  return { runForgePipeline, bumpForgeStats, fetchPublishedCorpus, claimForgeBudget };
}
