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
import { validateModules, MAX_MODULES } from '../cms/content-modules.js';
import { findRelatedPublished, buildRelatedReadingModule } from './related-posts.js';
import { buildVoiceAndFormatBlock, pickNextFormat } from './voice.js';
import { recordedFailure } from '../http/error-response.js';
import { buildForgeModuleInstruction, findSimilarTitle } from './forge-pipeline.js';
import {
  buildForgeArtifacts,
  buildForgeImagePack,
  postProcessForgedDraft,
  resolveForgeSource,
  sumForgeUsage,
} from './forge-artifacts.js';
import { bumpForgeStats, fetchPublishedCorpus, saveForgeOutcome } from './forge-store.js';

// The pure steps are in forge-artifacts.js and the corpus, counters and save
// in forge-store.js; re-exported here so callers keep one door.
export {
  buildForgeArtifacts,
  buildForgeImagePack,
  postProcessForgedDraft,
  resolveForgeSource,
  sumForgeUsage,
} from './forge-artifacts.js';
export { applyIncrements } from './forge-store.js';

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
async function claimForgeBudget({ store, now, log }, { limit, enforce = false } = {}) {
  const date = now();
  const claim = {
    todayKey: date.toISOString().slice(0, 10),
    day: dayNumber(date),
    cap: Number.isFinite(limit) ? limit : Number.MAX_SAFE_INTEGER,
    enforce,
    date,
  };

  for (let attempt = 0; attempt < FORGE_BUDGET_ATTEMPTS; attempt += 1) {
    const fast = await claimInPlace(store, claim);
    if (fast) return fast;
    const rolled = await claimByRollover(store, claim);
    if (rolled) return rolled;
  }

  // Contention this sustained is not a normal condition. Refusing is the
  // safe direction for a spend ceiling: the next scheduled run retries.
  log.warn?.('claimForgeBudget: exhausted attempts under contention');
  return { claimed: false, forgedToday: claim.cap };
}

/**
 * The fast path: a server-side compare-and-increment of today's count. Null
 * when the predicate failed or there is no stats document yet, so a read
 * must decide.
 */
async function claimInPlace(store, { day, cap, enforce }) {
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
    return null;
  }
}

/**
 * The slow path: read, refuse at the limit, else roll the day's bucket over
 * (or create it) with this claim already counted. Null when another writer
 * won the race, so the caller goes round again.
 */
async function claimByRollover(store, { todayKey, day, cap, enforce, date }) {
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
    return null;
  }
}

/**
 * Why a run stops before any model call: the draft looks like a duplicate of
 * a published one, or the day's budget is spent. Null when it may go on.
 */
async function preflightRefusal(ctx, { sourceTitle, corpus, budget }) {
  // 0. Dedupe against the published corpus before spending tokens
  const dupe = findSimilarTitle(
    sourceTitle,
    corpus.map((row) => row?.Title || row?.title || '').filter(Boolean)
  );
  if (dupe.similar) {
    await bumpForgeStats(ctx, { 'totals.skippedDuplicates': 1 });
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
  const claim = await claimForgeBudget(ctx, budget);
  if (claim.claimed) return null;
  return {
    ok: false,
    httpStatus: 429,
    error: `Daily forge budget reached (${claim.forgedToday}/${budget?.limit}). The next scheduled run will retry.`,
    budgetExhausted: true,
  };
}

/** The composed voice, format and module block, with the owner's context when there is one. */
function forgeInstructionFor({ cloudProvider, format, prompts, profile }) {
  const voiceBlock = buildVoiceAndFormatBlock(cloudProvider, format, {
    masterPrompt: prompts.masterPrompt,
    extraBanned: prompts.extraBannedPhrases,
    styleRules: prompts.styleRules,
  });
  const wordSoupBlock = profile.wordSoup
    ? `\n\nOwner context (weave in perspective where genuinely relevant, never force it):\n${profile.wordSoup.slice(0, 3000)}`
    : '';
  return `${voiceBlock}\n\n${buildForgeModuleInstruction(format)}${wordSoupBlock}`;
}

/**
 * 4b. Series interlinking (backlog #5): propose a "Related reading"
 * links module from the corpus fetched at step 0, plus series metadata.
 * Appended AFTER repair (a valid links module cannot break validity) and
 * BEFORE grading, so the grade judges what will actually publish; skipped
 * when the draft is already at the module cap. Only posts with a real
 * public URL qualify, so an empty corpus or URL-less rows are a no-op.
 */
function addRelatedReading(forged, corpus, keyTopics) {
  const related = findRelatedPublished(corpus, { title: forged.forgedTitle, keyTopics });
  if (!related.length || forged.moduleReport.moduleCount >= MAX_MODULES) return;
  forged.forgedContent = `${forged.forgedContent}\n\n${buildRelatedReadingModule(related)}`;
  forged.moduleReport = validateModules(forged.forgedContent);
  forged.relatedContentIds = related.map((entry) => entry.id);
}

/** The run's counters, after the save. */
function forgeStatsIncrements(nextStatus, statsFormatKey, usageTotals) {
  const staged = nextStatus === 'forge_ready';
  return {
    'totals.forged': 1,
    // NOT 'today.forged' — claimForgeBudget already counted this run before
    // the model calls. Incrementing here too would double-count, and worse,
    // would put the ceiling's ledger back in the hands of a best-effort
    // write that swallows its own failures (T-761).
    [`totals.${staged ? 'staged' : 'editing'}`]: 1,
    'totals.costUsd': usageTotals.costUsd,
    [`formats.${statsFormatKey}.forged`]: 1,
    [`formats.${statsFormatKey}.costUsd`]: usageTotals.costUsd,
    ...(staged ? { [`formats.${statsFormatKey}.staged`]: 1 } : {}),
  };
}

/** What a finished run answers. */
function forgeResult({ contentId, nextStatus, grade, prompts, format, forged, imagePack, usageTotals }) {
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

/**
 * Forge one document. Resolves to `{ ok: true, result }` or
 * `{ ok: false, httpStatus, error, duplicateOf? }`; never throws for a
 * pipeline outcome, only for a store failure on the save.
 */
async function runForgePipeline(ctx, { contentId, actor, budget, signal: callSignal }) {
  const { store, config, drafter, grader, now, log } = ctx;
  const activeSignal = callSignal || ctx.defaultSignal;
  if (activeSignal?.aborted) throw activeSignal.reason || new Error('aborted');
  const source = resolveForgeSource(
    contentId,
    await store.readDoc('content', contentId, contentId)
  );
  if (source.error) return source.error;
  const { data, sourceMarkdown, sourceUrl, cloudProvider, sourceTitle } = source;

  const corpus = await fetchPublishedCorpus(ctx);
  const refusal = await preflightRefusal(ctx, { sourceTitle, corpus, budget });
  if (refusal) return refusal;

  // 1. Config + format rotation
  const [profile, prompts] = await Promise.all([
    config.loadForgeProfile(),
    config.loadForgePrompts(),
  ]);
  const format = await pickNextFormat(store, 'content', cloudProvider);

  // 2. Compose the forge prompt
  const forgeInstruction = forgeInstructionFor({ cloudProvider, format, prompts, profile });

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
    // The outcome is stored as the job's result and error and shown on the
    // Forge pages: the router's sentence, or a fixed one with the code and
    // the reference of the content-free log line (#945).
    return { ok: false, httpStatus: 502, error: recordedFailure(log, 'Generation failed.', err) };
  }
  if (draft?.aiError)
    return { ok: false, httpStatus: 502, error: `Generation failed: ${draft.aiError}` };

  // 4. Deterministic post-processing, then 4b, related reading
  const forged = postProcessForgedDraft(draft, data, prompts);
  addRelatedReading(forged, corpus, draft.keyTopics || data.keyTopics);

  // 5. Grade
  let grade;
  try {
    grade = await grader.gradeArticle(
      { title: forged.forgedTitle, summary: forged.forgedSummary, content: forged.forgedContent },
      profile,
      { usageOut, signal: activeSignal }
    );
  } catch (err) {
    grade = {
      overall: 0,
      subs: [],
      skippedLlm: true,
      note: recordedFailure(log, 'Grading failed.', err),
    };
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
  await saveForgeOutcome(ctx, {
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

  await bumpForgeStats(ctx, forgeStatsIncrements(nextStatus, format?.key || 'unknown', usageTotals));

  return forgeResult({ contentId, nextStatus, grade, prompts, format, forged, imagePack, usageTotals });
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
  const ctx = { store, config, drafter, grader, now, uuid, log, defaultSignal };
  return {
    runForgePipeline: (job) => runForgePipeline(ctx, job),
    bumpForgeStats: (increments) => bumpForgeStats(ctx, increments),
    fetchPublishedCorpus: () => fetchPublishedCorpus(ctx),
    claimForgeBudget: (budget) => claimForgeBudget(ctx, budget),
  };
}
