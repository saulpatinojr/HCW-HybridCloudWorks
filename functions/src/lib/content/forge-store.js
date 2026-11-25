/**
 * forge-store.js — what a forge run reads and writes beside the model calls:
 * the published corpus (for dedupe and interlinking), the best-effort
 * counters, the AI's suggested topic, and the forged draft with its version
 * and audit rows. Split out of forge.js (which re-exports applyIncrements);
 * the daily budget claim stays in forge.js.
 */
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { applyPublishTimeCoverTrigger } from '../cms/publish.js';
import { errorFacts } from '../http/error-response.js';
import { isArticleTopic } from '../cms/article-topics.js';
import { actorName } from './forge-artifacts.js';

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

// Fails open: a store hiccup never blocks generation. One fetch serves two
// consumers — the dedupe gate (titles) and the related-posts interlinker
// (ids, topics and URLs), so the corpus is read once per run.
export async function fetchPublishedCorpus({ store, log }) {
  try {
    const rows = await store.queryDocs(
      'content',
      'SELECT TOP 300 c.id, c.Title, c.title, c.keyTopics, c.publishedUrl, c.publicUrl, c.curatedSubpagePath, c.slugPageUrl FROM c WHERE c.Live = true',
      []
    );
    return rows || [];
  } catch (err) {
    log.warn?.(`fetchPublishedCorpus failed (dedupe + interlinking skipped): ${errorFacts(err)}`);
    return [];
  }
}

// Best-effort counters in admin_config/forge_stats (read-modify-write; the
// same shape cms/publish.js bumps on publish). `today` is a single rolling
// day bucket, reset on date change — the autoForge.dailyLimit enforcement
// (lib/timers/forge-scheduled.js) reads it, and keeping only the current
// day stops the document growing forever (T-607).
export async function bumpForgeStats({ store, now, log }, increments = {}) {
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
    log.warn?.(`bumpForgeStats failed: ${errorFacts(err)}`);
  }
}

/**
 * The AI's address topic (#1628), written on its own and guarded. The forge
 * read the document before a model run of minutes, so that read cannot say
 * whether an editor has picked a topic since. This reads again just before
 * the write and makes the write conditional on that read (`ifMatch`): an
 * editor's topic always wins, and a 412 (the document changed in between)
 * or 404 (it was deleted) skips the suggestion. A skipped suggestion costs
 * nothing: the publish step picks a topic from keywords. Never fails the
 * forge.
 */
async function saveSuggestedTopic({ store, log }, contentId, topic) {
  if (!isArticleTopic(topic)) return;
  try {
    const fresh = await store.readDoc('content', contentId, contentId);
    if (!fresh || isArticleTopic(fresh.topic)) return;
    await store.patchDoc('content', contentId, { topic }, { ifMatch: fresh._etag });
  } catch (err) {
    if (err?.code !== 412 && err?.code !== 404) {
      log.warn?.('forge: the suggested address topic was not saved');
    }
  }
}

/** Write the forged draft, its version row and its audit row. */
export async function saveForgeOutcome({ store, now, uuid, log }, {
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
  const update = forgeUpdate({ forged, draft, format, nextStatus, artifacts, imagePack, stamp, by });
  // Cover at forge_ready so the image pipeline fires at staging; the
  // publish-time call stays as the idempotent safety net. The notify flag
  // is boolean because the rising-edge claim requires one — contentStatus
  // itself is not a flag (lib/triggers/forge-ready-notify.js).
  if (nextStatus === 'forge_ready') {
    applyPublishTimeCoverTrigger(update, data);
    update.forgeReadyNotifyTrigger = true;
  }

  await store.patchDoc('content', contentId, update);
  await saveSuggestedTopic({ store, log }, contentId, draft.topic);
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
  await store.upsertDoc(
    'admin_audit_logs',
    forgeAuditRow({ id: uuid(), actor, stamp, contentId, format, grade, prompts, nextStatus, forged, imagePack })
  );
}

/** The content fields a forge run writes. */
function forgeUpdate({ forged, draft, format, nextStatus, artifacts, imagePack, stamp, by }) {
  return {
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
}

/** The audit row of one forge run: counts and names, never the draft's words. */
function forgeAuditRow({ id, actor, stamp, contentId, format, grade, prompts, nextStatus, forged, imagePack }) {
  return {
    id,
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
  };
}
