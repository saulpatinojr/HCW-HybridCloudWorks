/**
 * Ops-health RPCs — getOpsHealthSnapshot (the 10-query operations
 * aggregation, source buildOpsHealthSnapshot :6470-6597) and
 * updateWorkflowAlert (:5907-6037), acknowledge/resolve/reopen with the
 * audit row.
 *
 * Cosmos adaptations, each deliberate:
 *   - count() -> SELECT VALUE COUNT(1); where-in -> ARRAY_CONTAINS; the
 *     queue-breach cutoff compares c.fetchedAt < @cutoff as ISO strings
 *     (migrated timestamps are ISO; docs missing fetchedAt are excluded,
 *     matching the Firestore composite-index semantics).
 *   - "Latest digest ordered by document ID" survives directly: the digest
 *     id IS the YYYY-MM-DD date, and ORDER BY c.id works on every doc (the
 *     source comment records why ordering by the digestDate FIELD was a bug —
 *     most writers never set it and Firestore hid those docs).
 *   - Alerts/staged sort in memory on updatedAt (the missing-property
 *     ORDER BY trap, as everywhere in this port).
 *   - Orphan probes point-read content/{id} per generated image, exactly the
 *     source's exists() probe strategy, with the image fetch bounded.
 *   - workflow_alert 'reopen' writes explicit nulls (resolvedAt/By,
 *     resolutionNote), matching Firestore .update(null) semantics — patchDoc
 *     stores null; `undefined` deletion is NOT used here on purpose.
 */
import { randomUUID } from 'node:crypto';
import { readConfigStamp } from './auth/http-route.js';
import { ADMIN_CONFIG_PARTITION } from './cosmos-client.js';
import { unresolvedSecretNames } from './secrets-health.js';
import { errorResponse } from './http/error-response.js';

export const OPS_HEALTH_CACHE_TTL_MS = 30_000;

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

export function toHoursSince(value, nowMs) {
  const ts = toMillis(value);
  if (!ts) return null;
  return Math.max(0, Math.round(((nowMs - ts) / (1000 * 60 * 60)) * 10) / 10);
}

export function getWorkflowAlertStatus(alert = {}) {
  return alert.status || (alert.active === false ? 'resolved' : 'open');
}

/**
 * What each action writes onto a workflow_alert doc, beside the updatedAt /
 * updatedBy stamp every action carries (source :5907). The keys are the
 * actions updateWorkflowAlert accepts.
 */
const WORKFLOW_ALERT_ACTION_UPDATES = Object.freeze({
  acknowledge: ({ nowIso, actor }) => ({
    acknowledgedAt: nowIso,
    acknowledgedBy: actor,
    status: 'acknowledged',
  }),
  resolve: ({ nowIso, actor, normalizedResolutionNote, alertData }) => ({
    active: false,
    resolvedAt: nowIso,
    resolvedBy: actor,
    status: 'resolved',
    resolutionNote: normalizedResolutionNote,
    // Cleared on resolve so the alert's next activation announces again
    // (lib/triggers/activation-notice.js).
    activationNotifiedAt: null,
    // Resolving an alert nobody acknowledged acknowledges it in the same write.
    ...(alertData?.acknowledgedAt ? {} : { acknowledgedAt: nowIso, acknowledgedBy: actor }),
  }),
  reopen: () => ({
    active: true,
    status: 'open',
    resolvedAt: null,
    resolvedBy: null,
    resolutionNote: null,
    // Reopen must announce: cleared in the same write that sets active.
    activationNotifiedAt: null,
  }),
});

/** The actions updateWorkflowAlert accepts, as its 400 lists them. */
export const WORKFLOW_ALERT_ACTIONS = Object.freeze(Object.keys(WORKFLOW_ALERT_ACTION_UPDATES));

/** Per-action update payload for a workflow_alert doc (source :5907). */
export function buildWorkflowAlertUpdates(change) {
  const { action, nowIso, actor } = change;
  const forAction = Object.hasOwn(WORKFLOW_ALERT_ACTION_UPDATES, action)
    ? WORKFLOW_ALERT_ACTION_UPDATES[action](change)
    : {};
  return { updatedAt: nowIso, updatedBy: actor, ...forAction };
}

/**
 * The 400 an updateWorkflowAlert body earns before the alert is read, or
 * null: both ids present, an action from the table, and a resolution note
 * when resolving.
 */
export function alertUpdateRefusal({ alertId, action, normalizedResolutionNote }) {
  if (!alertId || !action) {
    return json(400, { error: 'alertId and action required' });
  }
  if (!WORKFLOW_ALERT_ACTIONS.includes(action)) {
    return json(400, {
      error: 'Invalid action',
      validActions: [...WORKFLOW_ALERT_ACTIONS],
    });
  }
  if (action === 'resolve' && !normalizedResolutionNote) {
    return json(400, {
      error: 'resolutionNote is required when resolving an alert',
    });
  }
  return null;
}

const IMAGES_PROBE_BOUND = 2000;
/**
 * Content ids per orphan-probe query (T-711). Bounded because a Cosmos query
 * carries its parameters in the request: one enormous ARRAY_CONTAINS would
 * trade 2000 small reads for one request too large to serve.
 */
const ORPHAN_PROBE_BATCH = 100;

/** An image's content id as a key, or '' when it has none. */
const contentIdOf = (image) => String(image?.contentId || '').trim();

/**
 * Orphan detection (T-711): how many generated images name a content
 * document that no longer exists, or none at all.
 *
 * This used to be `Promise.all(generatedImages.map(… readDoc …))` — an
 * unthrottled fan-out of up to IMAGES_PROBE_BOUND (2000) concurrent point
 * reads, purely to produce one count. Every /status, /queue, /alerts,
 * /digest and /ai reaches it, AND so does every free-form Telegram
 * message, so one chat message could exhaust the RU budget the anonymous
 * public list endpoints share and 429 the website.
 *
 * Two properties do the work. Images are keyed by contentId and a single
 * content document can carry up to four generated images, so deduplicating
 * removes most of the reads before any I/O. What remains is answered in
 * batches with ARRAY_CONTAINS instead of one request each: ~2000 point
 * reads become a handful of queries, and the count is identical.
 */
async function countOrphanedImages(store, generatedImages) {
  const idsToProbe = [...new Set(generatedImages.map(contentIdOf))].filter(Boolean);
  // An image with no contentId is an orphan by definition and needs no probe.
  const missingIdCount = generatedImages.filter((image) => !contentIdOf(image)).length;

  const existingIds = new Set();
  for (let i = 0; i < idsToProbe.length; i += ORPHAN_PROBE_BATCH) {
    const batch = idsToProbe.slice(i, i + ORPHAN_PROBE_BATCH);
    const rows = await store.queryDocs(
      'content',
      'SELECT c.id FROM c WHERE ARRAY_CONTAINS(@ids, c.id)',
      [{ name: '@ids', value: batch }]
    );
    for (const row of rows || []) existingIds.add(row.id);
  }
  return (
    missingIdCount +
    generatedImages.filter((image) => {
      const contentId = contentIdOf(image);
      return contentId && !existingIds.has(contentId);
    }).length
  );
}

/**
 * The autonomous forge's rolling day bucket (content/forge.js) as the Health
 * page shows it: when the forge last did anything, and how much today.
 */
function forgeSummary(forgeStats, lastCheckedAt) {
  return {
    updatedAt: forgeStats?.updatedAt ?? null,
    todayDate: forgeStats?.today?.date ?? null,
    forgedToday: Number(forgeStats?.today?.forged) || 0,
    lastCheckedAt,
  };
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ queryDocs: Function, readDoc: Function, upsertDoc: Function, patchDoc: Function }} deps.store
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 * @param {Record<string, unknown>} [deps.env] the worker's environment, read
 *   for the runtime configuration stamp and the unresolved Key Vault
 *   references (ADR 0033 §1 Platform)
 */
export function createOpsHealthHandlers({
  guard,
  store,
  now = () => new Date(),
  uuid = randomUUID,
  env = process.env,
}) {
  const count = async (where, params = []) => {
    const rows = await store.queryDocs(
      'content',
      `SELECT VALUE COUNT(1) FROM c WHERE ${where}`,
      params
    );
    return Number(rows[0]) || 0;
  };

  /** Source buildOpsHealthSnapshot, query-for-query. */
  async function buildSnapshot() {
    const nowDate = now();
    const digestDate = nowDate.toISOString().slice(0, 10);
    const nowMs = nowDate.getTime();
    const breachCutoffIso = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();

    const needsReviewIn = {
      name: '@nrStatuses',
      value: ['draft', 'ingested', 'inspected'],
    };
    const stagedIn = {
      name: '@stagedStatuses',
      value: ['approved', 'published'],
    };

    const [
      publishedCount,
      publishedSlim,
      rssCount,
      queueBreachCount,
      stagedRows,
      digestDoc,
      latestDigestRows,
      alertRows,
      generatedImages,
      notifyState,
      forgeStats,
    ] = await Promise.all([
      count("c.contentStatus = 'published'"),
      store.queryDocs(
        'content',
        `SELECT TOP 200 c.id, c["slug"], c["Slug"] FROM c WHERE c.contentStatus = 'published'`,
        []
      ),
      count("c.source = 'rss'"),
      count('ARRAY_CONTAINS(@nrStatuses, c.contentStatus) AND c.fetchedAt < @cutoff', [
        needsReviewIn,
        { name: '@cutoff', value: breachCutoffIso },
      ]),
      store.queryDocs(
        'content',
        'SELECT TOP 50 c.id, c["contentStatus"], c["Live"], c["updatedAt"], c["reviewedAt"], c["fetchedAt"] FROM c WHERE ARRAY_CONTAINS(@stagedStatuses, c.contentStatus)',
        [stagedIn]
      ),
      store.readDoc('workflow_digests', digestDate, digestDate),
      // The digest id IS the date — ORDER BY c.id is exactly the source fix.
      store.queryDocs('workflow_digests', 'SELECT TOP 1 * FROM c ORDER BY c.id DESC', []),
      store.queryDocs('workflow_alerts', 'SELECT TOP 100 * FROM c', []),
      store.queryDocs(
        'generated_content_images',
        `SELECT TOP ${IMAGES_PROBE_BOUND} c.id, c["contentId"], c["sourceCollection"] FROM c`,
        []
      ),
      store.readDoc('system', 'notify_state', 'notify_state'),
      // The autonomous forge's rolling day bucket (content/forge.js), so the
      // Health page can say when the forge last did anything (ADR 0033).
      store.readDoc('admin_config', 'forge_stats', ADMIN_CONFIG_PARTITION),
    ]);
    const lastCheckedAt = nowDate.toISOString();

    const alerts = [...alertRows]
      .sort((a, b) => toMillis(b.updatedAt) - toMillis(a.updatedAt))
      .slice(0, 20);

    const missingSlugCount = publishedSlim.filter((d) => !d.slug && !d.Slug).length;
    // `functionsConfigured` used to be the literal `true` — a placeholder the
    // page rendered as "Functions URL Ready" whatever the worker's state
    // (ADR 0033 §1 Platform). It is now derived: the runtime configuration
    // stamp reached this process (T-513), and every Key Vault reference in
    // its environment resolved (T-720). The names are the authenticated
    // surface's to show — /api/health gives anonymous callers the count only.
    const configStamp = readConfigStamp(env);
    const unresolvedSecrets = unresolvedSecretNames(env);
    const readiness = {
      functionsConfigured: configStamp.generation !== 'unset' && unresolvedSecrets.length === 0,
      configGeneration: configStamp.generation,
      configWriter: configStamp.writer,
      unresolvedSecrets,
      publishedItems: publishedCount,
      missingSlugCount,
      rssSources: rssCount,
      lastCheckedAt,
    };

    const digestData = digestDoc || latestDigestRows[0] || null;

    const stagedHours = stagedRows
      .filter((item) => item.Live !== true)
      .map((item) => toHoursSince(item.updatedAt || item.reviewedAt || item.fetchedAt, nowMs))
      .filter((value) => value !== null);
    const openAlerts = alerts.filter((alert) => getWorkflowAlertStatus(alert) !== 'resolved');
    const openAlertHours = openAlerts
      .map((alert) => toHoursSince(alert.updatedAt || alert.firstSeenAt, nowMs))
      .filter((value) => value !== null);
    const publishFailureCount = alerts.filter(
      (alert) =>
        alert.alertType === 'scheduled_publish_failures' &&
        getWorkflowAlertStatus(alert) !== 'resolved'
    ).length;

    const orphanedGeneratedImages = await countOrphanedImages(store, generatedImages);

    const operationalSignals = {
      queueBreachCount,
      oldestStagedHours: stagedHours.length > 0 ? Math.max(...stagedHours) : 0,
      openAlertAgeHours: openAlertHours.length > 0 ? Math.max(...openAlertHours) : 0,
      publishFailureCount,
      orphanedGeneratedImages,
      lastSchedulerSuccessAt:
        digestData?.publishingOps?.status === 'success'
          ? (digestData?.publishingOps?.lastRunAt ?? null)
          : null,
      lastCheckedAt,
    };

    // What the generated-images read already fetched, counted rather than
    // discarded: the only storage figure this snapshot can give cheaply. The
    // read is bounded, so `bounded` says when the count is a floor.
    const storage = {
      generatedImages: generatedImages.length,
      bounded: generatedImages.length >= IMAGES_PROBE_BOUND,
      lastCheckedAt,
    };

    return {
      success: true,
      generatedAt: lastCheckedAt,
      lastCheckedAt,
      readiness,
      digest: digestData ? { ...digestData, lastCheckedAt } : null,
      alerts,
      operationalSignals,
      storage,
      forge: forgeSummary(forgeStats, lastCheckedAt),
      telegramNotifyState: { ...(notifyState || {}), lastCheckedAt },
    };
  }

  let cachedSnapshot = null;
  let cachedSnapshotAt = 0;

  function invalidateCache() {
    cachedSnapshot = null;
    cachedSnapshotAt = 0;
  }

  async function getCachedSnapshot(forceRefresh = false) {
    const currentTime = now().getTime();
    if (!forceRefresh && cachedSnapshot && currentTime - cachedSnapshotAt < OPS_HEALTH_CACHE_TTL_MS) {
      return cachedSnapshot;
    }
    const fresh = await buildSnapshot();
    cachedSnapshot = fresh;
    cachedSnapshotAt = currentTime;
    return fresh;
  }

  return {
    /**
     * The snapshot itself, unguarded.
     *
     * `getOpsHealthSnapshot` is the HTTP face of this and checks a role first.
     * The Telegram bot (lib/telegram/bot.js) is not a user and carries no
     * token — it is authorized by the webhook secret and the chat id before it
     * ever gets here — so it needs the data without the role check. Exposing
     * the builder is the honest way to say that; the alternative is a fake
     * request object carrying a fake identity through requireRole.
     */
    buildSnapshot,
    getCachedSnapshot,
    invalidateCache,

    /** POST /api/getOpsHealthSnapshot */
    async getOpsHealthSnapshot(request, context) {
      const auth = await guard.requireRole(request, 'viewer');
      if (auth.error) return auth.error;
      try {
        const forceRefresh =
          request?.query?.get?.('refresh') === 'true' ||
          request?.query?.refresh === 'true';
        return json(200, await getCachedSnapshot(forceRefresh));
      } catch (error) {
        return errorResponse(
          context,
          'Failed to generate operations health snapshot',
          error,
          500,
          request
        );
      }
    },

    /** POST|PATCH /api/updateWorkflowAlert — acknowledge/resolve/reopen. */
    async updateWorkflowAlert(request, context) {
      const auth = await guard.requireRole(request, 'publisher');
      if (auth.error) return auth.error;

      try {
        const body = (await request.json().catch(() => null)) || {};
        const { alertId, action, resolutionNote = '' } = body;
        const normalizedResolutionNote = String(resolutionNote || '').trim();
        const refused = alertUpdateRefusal({ alertId, action, normalizedResolutionNote });
        if (refused) return refused;

        const alertData = await store.readDoc('workflow_alerts', alertId, alertId);
        if (!alertData) {
          return json(404, { error: `workflow_alert ${alertId} not found` });
        }

        const { user } = auth;
        const nowIso = now().toISOString();
        const actor = user.email || user.preferred_username || user.oid || 'admin';
        const updates = buildWorkflowAlertUpdates({
          action,
          nowIso,
          actor,
          normalizedResolutionNote,
          alertData,
        });

        await store.patchDoc('workflow_alerts', alertId, updates);

        await store.upsertDoc('audits', {
          id: uuid(),
          timestamp: nowIso,
          action: `workflow_alert_${action}`,
          resourceType: 'workflow_alert',
          resourceId: alertId,
          resourceTitle: alertData?.alertType || 'workflow_alert',
          userId: user.oid ?? user.sub ?? actor,
          userName: user.name || null,
          userEmail: user.email || null,
          changes: {
            before: {
              active: alertData?.active ?? true,
              status: alertData?.status || 'open',
            },
            after: updates,
            changedFields: Object.keys(updates),
            notes: normalizedResolutionNote,
          },
          ipAddress: null, // see content-update.js — no trustworthy source yet
          userAgent: request.headers?.get?.('user-agent') || null,
          metadata: {
            authMethod: 'entra_bearer_token',
            alertType: alertData?.alertType || null,
          },
          compliance: {
            dataClassification: 'internal',
            retentionMonths: 24,
            identityVerified: true,
          },
        });

        invalidateCache();
        return json(200, { success: true, alertId, action });
      } catch (error) {
        return errorResponse(context, 'Failed to update workflow alert', error, 500, request);
      }
    },
  };
}
