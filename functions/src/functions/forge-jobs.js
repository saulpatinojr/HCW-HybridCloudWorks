/**
 * forge-jobs.js — `forge-article`, the Blog Machine jobs and
 * `build-newsletter-issue` as platform jobs (T-322).
 *
 * Site-Main: `forgeArticle` (300 s / 1 GiB HTTP, also called in a sequential
 * bulk loop). It runs under the job worker's non-HTTP budget here. The weekly
 * newsletter builder shares this module because it uses the same drafter; it
 * replaced `generate-weekly-digest` (ADR 0030 §2a).
 */
import {
  readDoc,
  queryDocs,
  patchDoc,
  upsertDoc,
  incrementIf,
  replaceDocIfMatch,
  createDoc,
} from '../lib/cosmos-client.js';
import * as ai from '../lib/ai/router.js';
import { defaultForgeConfig } from '../lib/content/forge-config-default.js';
import { createDrafter } from '../lib/content/drafting.js';
import { createGrader } from '../lib/content/forge-grader.js';
import { createForge } from '../lib/content/forge.js';
import { createIssueBuilder } from '../lib/newsletter/issue.js';
import { scrapeArticle } from '../lib/content/scrape.js';
import {
  scrapeToSource,
  inferProviderFromUrl,
  buildUrlSourceDoc,
} from '../lib/content/draft-from-url.js';
import {
  applyBrief,
  normalizeBrief,
  recordQueueOutcome,
  runVoiceCalibration,
} from '../lib/content/forge-studio.js';
import { actorName } from '../lib/auth/actor-name.js';
import { createJobFailureOnComplete } from '../lib/job-failure-notify.js';
import { registerJobType } from '../lib/jobs.js';

export const FORGE_MAX_BATCH = 10;

/**
 * The store every job here hands to the forge. It carries EVERY method
 * forge.js calls, and forge-jobs.test.js asserts that by reading forge.js:
 * until ADR 0033 this object had four methods while `claimForgeBudget`
 * called `store.incrementIf`, `store.replaceDocIfMatch` and
 * `store.createDoc` — so every manual forge job threw a TypeError at the
 * budget claim, after the dedupe check and before any model call. The
 * calibration job's ETag-safe suggestions write uses the same two.
 */
export const forgeStore = Object.freeze({
  readDoc,
  queryDocs,
  patchDoc,
  upsertDoc,
  incrementIf,
  replaceDocIfMatch,
  createDoc,
});
const store = forgeStore;
// The process-wide loader, shared with Forge Studio so a config edit there
// clears the cache THIS worker reads (see forge-config-default.js).
const config = defaultForgeConfig;
// Failure-only Telegram ping for the autonomous content path (T-607) — the
// interactive Studio jobs (voice-calibration, weekly digest) stay silent, the
// owner is watching those in the UI.
const notifyOnFailure = createJobFailureOnComplete({ store });

/** `{ sourceContentId }` or `{ sourceContentIds: [...] }` (≤ FORGE_MAX_BATCH) → the ids to forge. */
export function resolveForgeTargets(payload = {}) {
  const ids = Array.isArray(payload.sourceContentIds)
    ? payload.sourceContentIds
    : payload.sourceContentId
      ? [payload.sourceContentId]
      : [];
  const clean = [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))];
  if (!clean.length) throw new Error('sourceContentId (or sourceContentIds) required');
  if (clean.length > FORGE_MAX_BATCH)
    throw new Error(`At most ${FORGE_MAX_BATCH} documents per forge job`);
  return clean;
}

registerJobType('forge-article', {
  // Same level as POST /api/forgeContent: forging stages a draft, never publishes.
  role: 'editor',
  description:
    'ContentForge: generate, scrub, validate, grade and stage a draft from an ingested or inspected document (forge_ready above the publish threshold, otherwise editing).',
  maxPayloadBytes: 2048,
  // Up to 10 documents × (generation + grading, each a long model call).
  timeoutMs: 28 * 60 * 1000,
  worker: async (payload, { context, job, signal }) => {
    const ids = resolveForgeTargets(payload);
    const forge = createForge({
      store,
      config,
      drafter: createDrafter({ store, ai, signal }),
      grader: createGrader({ ai, signal }),
      log: context,
      signal,
    });
    const actor = job?.requestedBy || {};
    const outcomes = [];
    for (const contentId of ids) {
      if (signal?.aborted) throw signal.reason || new Error('aborted');
      const outcome = await forge.runForgePipeline({ contentId, actor, signal });
      outcomes.push(
        outcome.ok
          ? outcome.result
          : {
              success: false,
              contentId,
              skipped: outcome.httpStatus === 409,
              error: outcome.error,
              duplicateOf: outcome.duplicateOf,
            }
      );
      context.log?.(
        `[forge-article] ${contentId} → ${outcome.ok ? outcome.result.status : outcome.error}`
      );
    }
    // A single-document job that did not forge is a failed job, as upstream's
    // HTTP status was; a batch reports per document.
    if (ids.length === 1 && !outcomes[0].success && !outcomes[0].skipped)
      throw new Error(outcomes[0].error);
    return ids.length === 1
      ? outcomes[0]
      : {
          total: ids.length,
          staged: outcomes.filter((o) => o.status === 'forge_ready').length,
          editing: outcomes.filter((o) => o.status === 'editing').length,
          skipped: outcomes.filter((o) => o.skipped).length,
          failed: outcomes.filter((o) => !o.success && !o.skipped).length,
          outcomes,
        };
  },
  onComplete: notifyOnFailure,
});

/**
 * The unattended half of "paste a URL" (Blog Machine T-602): scrape → source
 * document → the same pipeline `forge-article` runs. Split from the worker
 * for tests; the registered worker below wires the real dependencies.
 *
 * `brief` (with `kind`, `ideaOrigin`) is optional: the Forge Studio Queue
 * sends the entry's brief on the job so it lands on the document the job
 * creates (through the same applyBrief the Brief tab's route uses) before the
 * pipeline runs — a single-URL start still saves its brief from the page
 * afterwards, as before. A payload without a brief applies none.
 *
 * @param {{ url: string, provider?: string, brief?: object, kind?: string, ideaOrigin?: string, queueItemId?: string }} payload
 * @param {object} deps — { scrape, forge, store, now, uuid, log, actor, signal }
 */
export async function runForgeFromUrl(
  payload,
  { scrape, forge, store: docStore, now, uuid, log, actor, signal }
) {
  if (signal?.aborted) throw signal.reason || new Error('aborted');
  const source = await scrapeToSource(String(payload?.url || '').trim(), {
    scrape,
    log,
    signal,
  });
  const provider = String(payload?.provider || '').trim() || inferProviderFromUrl(source.url);
  const doc = buildUrlSourceDoc({ source, provider, now, uuid });
  await docStore.upsertDoc('content', doc);
  log.log?.(`[forge-from-url] ${source.url} → content/${doc.id} (${source.wordCount} words)`);

  // A brief on the job always has substance once the scraped URL is on it
  // (sourceUrl counts), so it is applied whenever one was sent.
  if (payload?.brief && typeof payload.brief === 'object') {
    await applyBrief(docStore, {
      doc,
      brief: normalizeBrief({ ...payload.brief, mode: 'url', sourceUrl: source.url }),
      kind: payload.kind || '',
      ideaOrigin: payload.ideaOrigin || 'imported-source',
      stamp: now().toISOString(),
      actor: actorName(actor, 'forge'),
    });
    log.log?.('[forge-from-url] brief applied from the job payload');
  }

  if (signal?.aborted) throw signal.reason || new Error('aborted');
  const outcome = await forge.runForgePipeline({ contentId: doc.id, actor, signal });
  log.log?.(`[forge-from-url] ${doc.id} → ${outcome.ok ? outcome.result.status : outcome.error}`);
  // A duplicate (409) is a legitimate answer — the URL's story is already
  // published — so it reports rather than fails, same as forge-article.
  if (!outcome.ok && outcome.httpStatus !== 409) throw new Error(outcome.error);
  return outcome.ok
    ? { ...outcome.result, sourceUrl: source.url }
    : {
        success: false,
        contentId: doc.id,
        skipped: true,
        sourceUrl: source.url,
        error: outcome.error,
        duplicateOf: outcome.duplicateOf,
      };
}

/**
 * After a forge-from-url job: the failure ping as before, and — when the
 * Forge Studio Queue started it (`payload.queueItemId`) — the outcome on the
 * queue entry, so the Queue tab shows forged/failed without a browser having
 * waited on the job.
 */
export async function forgeFromUrlComplete(info, hookCtx) {
  // The failure ping quotes the payload; with a brief on it that would send
  // the objective, audience and key message to Telegram. It gets the URL and
  // the queue entry id only — the type, id, status and error say the rest.
  const payload = info?.job?.payload || {};
  const redacted = {
    ...info,
    job: { ...info.job, payload: { url: payload.url, queueItemId: payload.queueItemId } },
  };
  await notifyOnFailure(redacted, hookCtx);
  const queueItemId = payload.queueItemId;
  if (!queueItemId) return;
  await recordQueueOutcome(
    store,
    { queueItemId, status: info.status, result: info.result, error: info.error },
    { now: hookCtx?.now || (() => new Date()) }
  );
}

registerJobType('forge-from-url', {
  // Scrape + forge; the result is staged, not live.
  role: 'editor',
  description:
    'Blog Machine: scrape a URL into a source content document, then run the forge pipeline on it — staged forge_ready above the publish threshold, otherwise editing. A brief on the payload (the Forge Studio Queue sends one) is saved onto the document first.',
  // A URL plus a full brief (2,000-character objective, audience and key
  // message, the lists): 4 KiB held only the URL.
  maxPayloadBytes: 16384,
  // One scrape plus the same generation + grading budget forge-article gets.
  timeoutMs: 28 * 60 * 1000,
  worker: async (payload, { context, job, signal }) =>
    runForgeFromUrl(payload, {
      scrape: scrapeArticle,
      forge: createForge({
        store,
        config,
        drafter: createDrafter({ store, ai, signal }),
        grader: createGrader({ ai, signal }),
        log: context,
        signal,
      }),
      store,
      now: () => new Date(),
      uuid: () => crypto.randomUUID(),
      log: context,
      actor: job?.requestedBy || {},
      signal,
    }),
  onComplete: forgeFromUrlComplete,
});

registerJobType('voice-calibration', {
  // Writes suggestions only; accept/dismiss is a separate editor action.
  role: 'editor',
  description:
    'Blog Machine: read the owner’s recent published posts and write SUGGESTED voice-profile additions to forge_profile.suggestions — accept/dismiss happens in Forge Studio, never automatically.',
  maxPayloadBytes: 256,
  timeoutMs: 10 * 60 * 1000,
  worker: (payload, { context, signal }) => runVoiceCalibration(payload || {}, { store, ai, log: context, signal }),
});

registerJobType('build-newsletter-issue', {
  // Builds a DRAFT issue; sending is the publisher-level approval (ADR 0030 §2a).
  // Replaces generate-weekly-digest, whose drafts carried no links and landed
  // in a container nothing read.
  role: 'editor',
  description:
    "Build this week's newsletter issue as a draft from the sections, item limits, window and intro chosen in Newsletter settings -> Content ({ days } overrides the saved window, clamped 1-31): new articles, certification news, study and podcast episodes, plus an AI-written intro when it is on. Never sends.",
  maxPayloadBytes: 256,
  timeoutMs: 10 * 60 * 1000,
  // Only `days` is passed through: `keep`/`keptBy` belong to the Monday timer
  // (#504), and a job payload is caller-supplied, so it must not set who a
  // draft was saved by. Saving from the page goes through saveNewsletter.
  worker: (payload, { context, signal }) =>
    createIssueBuilder({
      store,
      drafter: createDrafter({ store, ai, signal }),
      log: context,
      signal,
    }).build({ days: payload?.days, signal }),
});
