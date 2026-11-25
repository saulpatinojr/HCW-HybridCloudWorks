/**
 * ops-health-snapshot.js — the Health page's snapshot, built from one round
 * of reads (source buildOpsHealthSnapshot, query-for-query). ops-health.js
 * caches it and serves it behind the role guard.
 */
import { readConfigStamp } from './auth/http-route.js';
import { ADMIN_CONFIG_PARTITION } from './cosmos-client.js';
import { splitUnresolved, unresolvedSecretNames } from './secrets-health.js';
import { KEY_RECORD_ID } from './agent-content/keys.js';
import { backupsUnavailable } from './backup/backup-status.js';
import {
  AGENT_DENIALS_BOUND,
  AGENT_DENIAL_ACTION,
  AGENT_WINDOW_MS,
  IMAGES_PROBE_BOUND,
  STAGED_NOT_LIVE,
  UNDATED_STAGED_BOUND,
  agentSummary,
  countOrphanedImages,
  forgeSummary,
  getWorkflowAlertStatus,
  jobsSummary,
  toHoursSince,
  toMillis,
} from './ops-health-summaries.js';

export async function buildOpsHealthSnapshot({ store, now, env, backups }) {
  const count = async (where, params = []) => {
    const rows = await store.queryDocs(
      'content',
      `SELECT VALUE COUNT(1) FROM c WHERE ${where}`,
      params
    );
    return Number(rows[0]) || 0;
  };

  const nowDate = now();
  const digestDate = nowDate.toISOString().slice(0, 10);
  const nowMs = nowDate.getTime();
  const breachCutoffIso = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
  const agentSinceIso = new Date(nowMs - AGENT_WINDOW_MS).toISOString();

  const needsReviewIn = {
    name: '@nrStatuses',
    value: ['draft', 'ingested', 'inspected'],
  };
  const stagedIn = {
    name: '@stagedStatuses',
    value: ['approved', 'published'],
  };
  const stagedParams = [stagedIn, { name: '@now', value: nowDate.toISOString() }];

  const [
    publishedCount,
    publishedSlim,
    rssCount,
    queueBreachCount,
    stagedRows,
    undatedStagedRows,
    stagedWaitingCount,
    digestDoc,
    latestDigestRows,
    alertRows,
    generatedImages,
    notifyState,
    forgeStats,
    failedJobRows,
    agentKeyRead,
    agentDenialRows,
    jobStatusRows,
    backupReading,
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
    // The oldest Approved or Published item that is not live yet, by its
    // last edit (#1512). This used to be TOP 50 in no order, filtered for
    // Live afterwards; most published items are live, so the sample was
    // mostly discarded and the "oldest" was whichever old item happened to
    // be in it. The filter and the order are now in the query, and the
    // content container's `/*` range index serves the ORDER BY.
    //
    // `IS_STRING(c.updatedAt)` keeps the ORDER BY on a field every row has,
    // the rule public-reads.js states and scheduled-publish.js follows. An
    // item with a missing or null `updatedAt` would otherwise be able to
    // sort first and show the tile as 0 h. Such an item is still in the
    // count below, so the count is every item waiting and the age is the
    // oldest dated one.
    store.queryDocs(
      'content',
      `SELECT TOP 1 c.id, c["contentStatus"], c["updatedAt"] FROM c WHERE ${STAGED_NOT_LIVE} AND IS_STRING(c.updatedAt) AND c.updatedAt > '' ORDER BY c.updatedAt ASC`,
      stagedParams
    ),
    // The items the ordered read cannot see: no string `updatedAt`, which
    // is what a migrated item with a Firestore-style time looks like. The
    // first deploy of #1513 showed "0h" over "1 waiting" for exactly this
    // (#1516). An empty string counts as no time here, and is kept out of
    // the ordered read, where it would sort first and hide the real oldest.
    // Their age comes from the first field that holds a readable time:
    // updatedAt, reviewedAt, fetchedAt (the order the tile used before
    // #1513), then publishedAt.
    store.queryDocs(
      'content',
      `SELECT TOP ${UNDATED_STAGED_BOUND} c.id, c["updatedAt"], c["reviewedAt"], c["fetchedAt"], c["publishedAt"] FROM c WHERE ${STAGED_NOT_LIVE} AND (NOT IS_STRING(c.updatedAt) OR c.updatedAt = '')`,
      stagedParams
    ),
    count(STAGED_NOT_LIVE, stagedParams),
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
    // A failed read is null, not an empty list: the card must not report
    // "no failed jobs" because it could not look (#1491).
    store
      .queryDocs(
        'jobs',
        'SELECT TOP 50 c.id, c["type"], c["status"], c["error"], c["createdAt"], c["finishedAt"] FROM c WHERE c.status = \'failed\'',
        []
      )
      .catch(() => null),
    // The content agent's key record (agent-content/keys.js): read for its
    // state only; the hash never leaves the store and the hint stays on
    // the Koda tab, which is super_admin. readDoc answers null for a
    // missing record; a failed read is kept apart from that, so the card
    // can say "could not read" instead of "no key".
    store
      .readDoc('admin_config', KEY_RECORD_ID, ADMIN_CONFIG_PARTITION)
      .then((record) => ({ record: record || null, unavailable: false }))
      .catch(() => ({ record: null, unavailable: true })),
    // Its refusals in the last day, by reason, newest first. The rows
    // carry `action` and `timestamp` (auth/denial-audit.js), the two paths
    // the audit container indexes, so this is an index seek, not a scan,
    // and the order is served by the same index. Null when it fails, so
    // the card says so.
    store
      .queryDocs(
        'admin_audit_logs',
        `SELECT TOP ${AGENT_DENIALS_BOUND} c.reason, c.timestamp FROM c WHERE c.action = @action AND c.timestamp >= @since ORDER BY c.timestamp DESC`,
        [
          { name: '@action', value: AGENT_DENIAL_ACTION },
          { name: '@since', value: agentSinceIso },
        ]
      )
      .catch(() => null),
    // The last day's jobs by status; status and createdAt are indexed.
    store
      .queryDocs(
        'jobs',
        'SELECT c.status, COUNT(1) AS n FROM c WHERE c.createdAt >= @since GROUP BY c.status',
        [{ name: '@since', value: agentSinceIso }]
      )
      .catch(() => null),
    // The nightly export's newest run manifests, read from the private
    // cosmos-export container by the worker's own identity (#1409). The
    // reader keeps its own ten-minute cache, so this costs the blob reads
    // once per ten minutes, not once per snapshot. A failed read is null,
    // so the block says the export's state is not known rather than
    // "no export".
    backups ? backups.read().catch(() => null) : Promise.resolve(null),
  ]);
  const lastCheckedAt = nowDate.toISOString();

  const alerts = [...alertRows]
    .sort((a, b) => toMillis(b.updatedAt) - toMillis(a.updatedAt))
    .slice(0, 20);

  const failedJobsUnavailable = !Array.isArray(failedJobRows);
  const failedJobs = [...(failedJobRows || [])]
    .sort((a, b) => toMillis(b.finishedAt || b.createdAt) - toMillis(a.finishedAt || a.createdAt))
    .slice(0, 10);

  const readiness = readinessOf(env, { publishedCount, publishedSlim, rssCount, lastCheckedAt });

  const digestData = digestDoc || latestDigestRows[0] || null;

  const waitingCount = Number(stagedWaitingCount) || 0;
  const oldestStagedHours = oldestStagedHoursOf({ stagedRows, undatedStagedRows, waitingCount, nowMs });
  const { openAlertHours, publishFailureCount } = alertSignals(alerts, nowMs);

  const orphanedGeneratedImages = await countOrphanedImages(store, generatedImages);

  const operationalSignals = {
    queueBreachCount,
    oldestStagedHours,
    stagedWaitingCount: waitingCount,
    openAlertAgeHours: openAlertHours.length > 0 ? Math.max(...openAlertHours) : 0,
    publishFailureCount,
    orphanedGeneratedImages,
    failedJobs,
    failedJobsUnavailable,
    jobs24h: jobsSummary(jobStatusRows, agentSinceIso),
    lastSchedulerSuccessAt: lastSchedulerSuccessOf(digestData),
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
    agent: agentSummary({
      record: agentKeyRead.record,
      keyUnavailable: agentKeyRead.unavailable,
      denialRows: agentDenialRows,
      sinceIso: agentSinceIso,
      lastCheckedAt,
    }),
    // `checkedAt` inside the block is when the blobs were read, which can
    // be up to ten minutes before this snapshot; `lastCheckedAt` is this
    // snapshot's, like every other block.
    backups: { ...(backupReading || backupsUnavailable(lastCheckedAt)), lastCheckedAt },
    telegramNotifyState: { ...(notifyState || {}), lastCheckedAt },
  };
}

/**
 * Whether this worker is configured, and the published-content counts the
 * readiness block shows beside it.
 */
function readinessOf(env, { publishedCount, publishedSlim, rssCount, lastCheckedAt }) {
  const missingSlugCount = publishedSlim.filter((d) => !d.slug && !d.Slug).length;
  // `functionsConfigured` used to be the literal `true` — a placeholder the
  // page rendered as "Functions URL Ready" whatever the worker's state
  // (ADR 0033 §1 Platform). It is now derived: the runtime configuration
  // stamp reached this process (T-513), and every Key Vault reference in
  // its environment resolved (T-720). The names are the authenticated
  // surface's to show — /api/health gives anonymous callers the count only.
  //
  // Since #1512 a reference that is unresolved ON PURPOSE (on the list in
  // expected-unresolved.js, with its reason) no longer makes the worker
  // "not configured": the page and the pulse name it as expected, and only
  // a name off that list is Critical. `unresolvedSecrets` still lists every
  // name, so a reader that knows nothing of the split sees what it always did.
  const configStamp = readConfigStamp(env);
  const unresolvedSecrets = unresolvedSecretNames(env);
  const { expected: expectedUnresolved, unexpected: unexpectedUnresolved } =
    splitUnresolved(unresolvedSecrets);
  const readiness = {
    functionsConfigured: configStamp.generation !== 'unset' && unexpectedUnresolved.length === 0,
    configGeneration: configStamp.generation,
    configWriter: configStamp.writer,
    unresolvedSecrets,
    expectedUnresolved,
    unexpectedUnresolved,
    publishedItems: publishedCount,
    missingSlugCount,
    rssSources: rssCount,
    lastCheckedAt,
  };
  return readiness;
}

/** The age in hours of the oldest item waiting to go live; null when items wait but none carries a time. */
function oldestStagedHoursOf({ stagedRows, undatedStagedRows, waitingCount, nowMs }) {
  const stagedHours = [
    ...(stagedRows || []).map((item) => toHoursSince(item.updatedAt, nowMs)),
    ...(undatedStagedRows || []).map((item) =>
      toHoursSince(
        ['updatedAt', 'reviewedAt', 'fetchedAt', 'publishedAt']
          .map((field) => item[field])
          .find((value) => toMillis(value) > 0),
        nowMs
      )
    ),
  ].filter((value) => value !== null);
  // Items are waiting but none carries a time at all: say so (null), never 0 h.
  let oldestStagedHours = 0;
  if (stagedHours.length > 0) oldestStagedHours = Math.max(...stagedHours);
  else if (waitingCount > 0) oldestStagedHours = null;
  return oldestStagedHours;
}

/** The open alerts' ages in hours, and how many open alerts are scheduled-publish failures. */
function alertSignals(alerts, nowMs) {
  const openAlerts = alerts.filter((alert) => getWorkflowAlertStatus(alert) !== 'resolved');
  const openAlertHours = openAlerts
    .map((alert) => toHoursSince(alert.updatedAt || alert.firstSeenAt, nowMs))
    .filter((value) => value !== null);
  const publishFailureCount = alerts.filter(
    (alert) =>
      alert.alertType === 'scheduled_publish_failures' &&
      getWorkflowAlertStatus(alert) !== 'resolved'
  ).length;
  return { openAlertHours, publishFailureCount };
}

/** When the scheduler last ran successfully, from the day's digest. */
function lastSchedulerSuccessOf(digestData) {
  return digestData?.publishingOps?.status === 'success'
    ? (digestData?.publishingOps?.lastRunAt ?? null)
    : null;
}
