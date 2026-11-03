/**
 * The Decision Center's sources outside `content` (#1013, #1014). One
 * source per kind of waiting decision, each a bounded and ordered read:
 *
 *   podcast-transcripts  pipelines   draft transcripts awaiting approval
 *   listen-and-learn     pipelines   chapters not published or archived
 *   newsletters          pipelines   issues to keep (Newsletter tab) or
 *                                    approve (Drafts tab), and rejected ones
 *   social               pipelines   captions never queued, failed posts,
 *                                    and posts Publer refused an edit for
 *   forge-queue          pipelines   Forge Studio Queue entries that failed
 *   workflow-alerts      governance  open workflow alerts (not acknowledged)
 *   unresolved-secrets   governance  Key Vault references that did not resolve
 *   cost                 governance  cost warnings: a budget past 75 %, credits
 *                                    running out, a renewal due (lib/cost)
 *   reminders            other       reminders due today or overdue
 *   ambassador           other       application deadlines within two weeks
 *                                    or past, on an application still open
 *
 * `role` is the role the source's own list route asks for. The Decision
 * Center answers a viewer (the dashboard's role), so an editor-only source is
 * left out of a viewer's answer rather than handed to them through a side
 * door; the answer says it was left out.
 *
 * A container that is not provisioned yet reads as nothing waiting, as the
 * Calendar's collectors treat it.
 */
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { isContainerMissing } from '../calendar/collectors.js';
import { getWorkflowAlertStatus } from '../ops-health.js';
import { unresolvedSecretNames } from '../secrets-health.js';
import { REMINDERS_CONFIG_ID, dateOnly, daysUntil, readStoredReminders } from '../reminders/settings.js';
import { STATUS as PODCAST_STATUS, TRANSCRIPT_CONTAINER } from '../podcast/store.js';
import { EPISODE_CONTAINER, STATUS as CHAPTER_STATUS } from '../listen-and-learn/publish.js';
import { isSoftDeleted } from '../listen-and-learn/handlers-shared.js';
import { CONTAINER as AMBASSADOR_CONTAINER } from '../ambassador/model.js';
import { QUEUE_DOC_TYPE } from '../content/forge-studio/queue.js';
import { decisionItem, fromTs, text } from './items.js';
import { readLedger } from '../cost/ledger-store.js';
import { buildSummary, readSnapshot } from '../cost/snapshot.js';
import { notable } from '../cost/signals.js';
import { COST_ALERTS_HREF } from './links.js';
import {
  FORGE_QUEUE_HREF,
  SOCIAL_QUEUE_HREF,
  UNRESOLVED_SECRETS_HREF,
  alertHref,
  ambassadorHref,
  chapterHref,
  newsletterIssueHref,
  reminderHref,
  socialComposeHref,
  transcriptHref,
} from './links.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rows from a container that may not exist yet: none, rather than an error. */
async function rowsOrNone(read) {
  try {
    return (await read()) || [];
  } catch (error) {
    if (isContainerMissing(error)) return [];
    throw error;
  }
}

/** A source over one windowed read: `limit` rows, each made an item (or null to skip). */
function windowSource({ id, label, category, role = 'editor', limit, read, toItem }) {
  return Object.freeze({
    id,
    label,
    category,
    role,
    async collect(ctx) {
      const rows = await rowsOrNone(() => read(ctx, limit));
      const items = rows.map((row) => toItem(row, ctx)).filter(Boolean);
      return { items, truncated: rows.length >= limit };
    },
  });
}

// ── podcast transcripts ──────────────────────────────────────────────────────

/** Every transcript document carries `generatedAt` (podcast/handlers.js LIST_QUERY orders by it). */
const podcastTranscripts = windowSource({
  id: 'podcast-transcripts',
  label: 'Podcast transcripts awaiting approval',
  category: 'pipelines',
  limit: 50,
  read: ({ store }, limit) =>
    store.queryDocs(
      TRANSCRIPT_CONTAINER,
      `SELECT TOP ${limit} c.id, c.title, c.status, c.generatedAt, c.sourceKind, c.sourceTitle, c.audioError FROM c WHERE c.status = @status ORDER BY c.generatedAt DESC`,
      [{ name: '@status', value: PODCAST_STATUS.draft }]
    ),
  toItem: (row) =>
    decisionItem({
      id: `transcript:${row.id}`,
      category: 'pipelines',
      kind: 'transcript',
      title: row.title || row.sourceTitle || row.id,
      stage: 'approval',
      status: row.status,
      waitingSince: row.generatedAt,
      priority: row.audioError ? 'high' : 'normal',
      href: transcriptHref(row.id),
      source: { collection: TRANSCRIPT_CONTAINER, id: row.id },
      detail: row.audioError ? `Audio failed: ${row.audioError}` : row.sourceTitle || row.sourceKind,
    }),
});

// ── Listen & Learn ───────────────────────────────────────────────────────────

/** A chapter is on the Review tab until it is published or archived (SetEpisodesTab.jsx). */
const listenAndLearn = windowSource({
  id: 'listen-and-learn',
  label: 'Listen & Learn chapters awaiting review',
  category: 'pipelines',
  limit: 50,
  read: ({ store }, limit) =>
    store.queryDocs(
      EPISODE_CONTAINER,
      `SELECT TOP ${limit} c.id, c.setId, c.provider, c.examCode, c.title, c.areaName, c.status, c.generatedAt, c.updatedAt, c.lastError, c.audioError, c.softDeletedAt, c.softDeleteExpiresAt, c._ts FROM c WHERE NOT ARRAY_CONTAINS(@settled, c.status) ORDER BY c._ts DESC`,
      [{ name: '@settled', value: [CHAPTER_STATUS.published, CHAPTER_STATUS.archived] }]
    ),
  toItem: (row) => {
    if (isSoftDeleted(row)) return null;
    const failed = row.status === CHAPTER_STATUS.failed;
    const problem = row.lastError || row.audioError;
    return decisionItem({
      id: `chapter:${row.setId}/${row.id}`,
      category: 'pipelines',
      kind: 'chapter',
      title: row.title || row.areaName || row.id,
      stage: failed ? 'retry' : 'review',
      status: row.status || CHAPTER_STATUS.draft,
      waitingSince: row.updatedAt || row.generatedAt || fromTs(row._ts),
      priority: failed ? 'high' : 'normal',
      href: chapterHref(row),
      source: { collection: EPISODE_CONTAINER, id: row.id, setId: row.setId || null },
      detail: [row.examCode, problem ? text(problem, 160) : ''].filter(Boolean).join(' · '),
    });
  },
});

// ── newsletter ───────────────────────────────────────────────────────────────

/**
 * Where an issue waits (components/admin/newsletter/issuesModel.js IN_VIEW): a
 * kept draft is approved on Drafts; an unkept draft or a rejected issue is
 * kept or deleted on the Newsletter tab.
 */
function newsletterPlace(row) {
  if (row.status === 'draft' && row.savedAt) {
    return { tab: 'drafts', stage: 'approval', since: row.savedAt };
  }
  if (row.status === 'rejected') {
    return { tab: 'newsletter', stage: 'rejected', since: row.rejectedAt || row.updatedAt };
  }
  return { tab: 'newsletter', stage: 'keep', since: row.createdAt };
}

/**
 * Ordered by `_ts`, the last write, not `createdAt` (review of #1021): an
 * issue waits from `savedAt` or `rejectedAt` as often as from `createdAt`,
 * and a keep or a reject is a write, so an issue just kept or rejected is in
 * the window however old it is. The items are sorted by waiting time after.
 */
const newsletters = windowSource({
  id: 'newsletters',
  label: 'Newsletter issues awaiting a decision',
  category: 'pipelines',
  limit: 25,
  read: ({ store }, limit) =>
    store.queryDocs(
      'newsletters',
      `SELECT TOP ${limit} c.id, c.status, c.subject, c.savedAt, c.createdAt, c.updatedAt, c.rejectedAt, c.periodStart, c.periodEnd FROM c WHERE c.kind = 'weekly_issue' AND (c.status = 'draft' OR c.status = 'rejected') ORDER BY c._ts DESC`,
      []
    ),
  toItem: (row) => {
    const place = newsletterPlace(row);
    return decisionItem({
      id: `newsletter:${row.id}`,
      category: 'pipelines',
      kind: 'newsletter',
      title: row.subject || `Issue ${String(row.id).replace('issue-', '')}`,
      stage: place.stage,
      status: row.status,
      waitingSince: place.since || row.createdAt,
      href: newsletterIssueHref(row.id, place.tab),
      source: { collection: 'newsletters', id: row.id },
      detail: row.periodStart && row.periodEnd ? `${row.periodStart} to ${row.periodEnd}` : '',
    });
  },
});

// ── social ───────────────────────────────────────────────────────────────────

/**
 * What a social post is waiting on. A draft is a caption the auto-poster wrote
 * while Publer was not configured (triggers/social-caption-trigger.js); a
 * failed one never went out. Both are composed again for their article. A
 * sync failure is a scheduled post Publer refused an edit for, which the
 * Queue tab shows as "Sync failed".
 */
function socialPlace(row) {
  if (row.status === 'draft') return { stage: 'compose', href: socialComposeHref(row.contentId) };
  if (row.status === 'failed') return { stage: 'retry', href: socialComposeHref(row.contentId) };
  return { stage: 'sync failed', href: SOCIAL_QUEUE_HREF };
}

const social = windowSource({
  id: 'social',
  label: 'Social posts needing attention',
  category: 'pipelines',
  limit: 50,
  read: ({ store }, limit) =>
    store.queryDocs(
      'social_posts',
      `SELECT TOP ${limit} c.id, c.caption, c.status, c.syncStatus, c.syncError, c.contentId, c.createdAt, c._ts FROM c WHERE c.status = 'draft' OR c.status = 'failed' OR (c.syncStatus = 'failed' AND c.status != 'published') ORDER BY c._ts DESC`,
      []
    ),
  toItem: (row) => {
    const place = socialPlace(row);
    return decisionItem({
      id: `social:${row.id}`,
      category: 'pipelines',
      kind: 'social',
      title: row.caption || 'Social post',
      stage: place.stage,
      status: row.syncStatus === 'failed' ? 'sync_failed' : row.status,
      waitingSince: row.createdAt || fromTs(row._ts),
      priority: row.status === 'draft' ? 'normal' : 'high',
      href: place.href,
      source: { collection: 'social_posts', id: row.id, contentId: row.contentId || null },
      detail: row.syncError || '',
    });
  },
});

// ── Forge Studio Queue ───────────────────────────────────────────────────────

/** A failed entry waits for Save again or removal (content/forge-studio/queue.js). */
const forgeQueue = windowSource({
  id: 'forge-queue',
  label: 'Forge Studio Queue entries that failed',
  category: 'pipelines',
  limit: 50,
  read: ({ store }, limit) =>
    store.queryDocs(
      'admin_config',
      `SELECT TOP ${limit} c.id, c.url, c.title, c.status, c.error, c.updatedAt, c._ts FROM c WHERE c.docType = @docType AND c.status = 'failed' ORDER BY c._ts DESC`,
      [{ name: '@docType', value: QUEUE_DOC_TYPE }],
      { partitionKey: ADMIN_CONFIG_PARTITION }
    ),
  toItem: (row) =>
    decisionItem({
      id: `forge-queue:${row.id}`,
      category: 'pipelines',
      kind: 'forge_queue',
      title: row.title || row.url,
      stage: 'retry',
      status: row.status,
      waitingSince: row.updatedAt || fromTs(row._ts),
      priority: 'high',
      href: FORGE_QUEUE_HREF,
      source: { collection: 'admin_config', id: row.id },
      detail: row.error || '',
    }),
});

// ── governance ───────────────────────────────────────────────────────────────

/** The words an alert type is stored as, for a reader. */
const humanize = (value) => text(String(value || 'workflow alert').replace(/_/g, ' '));

/**
 * Open alerts: the status the Health Hub's Alerts tab files them under (no
 * status, or `open`). Acknowledging one moves it to `acknowledged`.
 */
const workflowAlerts = windowSource({
  id: 'workflow-alerts',
  label: 'Open workflow alerts',
  category: 'governance',
  role: 'viewer',
  limit: 50,
  read: ({ store }, limit) =>
    store.queryDocs(
      'workflow_alerts',
      `SELECT TOP ${limit} c.id, c.alertType, c.source, c.severity, c.status, c.active, c.message, c.firstSeenAt, c.updatedAt, c._ts FROM c WHERE NOT IS_DEFINED(c.status) OR IS_NULL(c.status) OR c.status = 'open' ORDER BY c._ts DESC`,
      []
    ),
  toItem: (row) => {
    if (getWorkflowAlertStatus(row) !== 'open') return null;
    return decisionItem({
      id: `alert:${row.id}`,
      category: 'governance',
      kind: 'alert',
      title: humanize(row.alertType),
      stage: 'acknowledge',
      status: 'open',
      waitingSince: row.firstSeenAt || row.updatedAt || fromTs(row._ts),
      priority: row.severity === 'critical' ? 'high' : 'normal',
      href: alertHref(row.id),
      source: { collection: 'workflow_alerts', id: row.id },
      detail: [row.source, row.message].filter(Boolean).join(' · '),
    });
  },
});

/**
 * Key Vault references this worker could not resolve (secrets-health.js). The
 * names are what the Health Hub's Overview already shows its viewers; the
 * anonymous /api/health gets the count only.
 */
const unresolvedSecrets = Object.freeze({
  id: 'unresolved-secrets',
  label: 'Key Vault references not resolving',
  category: 'governance',
  role: 'viewer',
  async collect({ env }) {
    const items = unresolvedSecretNames(env).map((name) =>
      decisionItem({
        id: `secret:${name}`,
        category: 'governance',
        kind: 'secret',
        title: `${name} is not resolving its Key Vault reference`,
        stage: 'configure',
        status: 'unresolved',
        href: UNRESOLVED_SECRETS_HREF,
        source: { collection: 'app_settings', id: name },
        detail: 'The feature that reads it is switched off until the reference resolves.',
      })
    );
    return { items, truncated: false };
  },
});

// ── cost ─────────────────────────────────────────────────────────────────────

/**
 * The Cost page's warning and critical signals (ADR 0039), from the stored
 * snapshot and the ledger: two point reads, nothing live. Editor, like the
 * page: what the platform costs is not a viewer's read.
 */
const cost = Object.freeze({
  id: 'cost',
  label: 'Cost warnings',
  category: 'governance',
  role: 'editor',
  async collect({ store, now }) {
    const [snapshot, ledger] = await Promise.all([readSnapshot(store), readLedger(store)]);
    const at = now();
    const summary = buildSummary({ snapshot, ledger, now: at });
    const items = notable(summary.signals).map((signal) =>
      decisionItem({
        id: `cost:${signal.id}`,
        category: 'governance',
        kind: 'cost',
        title: signal.title,
        stage: 'review',
        status: signal.severity,
        waitingSince: snapshot?.notified?.[signal.id] || summary.readAt || at,
        priority: signal.severity === 'critical' ? 'high' : 'normal',
        href: signal.href || COST_ALERTS_HREF,
        source: { collection: 'admin_config', id: 'cost_snapshot', signal: signal.id },
        detail: signal.detail,
      })
    );
    return { items, truncated: false };
  },
});

// ── reminders ────────────────────────────────────────────────────────────────

/** Due today or overdue and not done: the reminders the daily Telegram check is saying now. */
const reminders = Object.freeze({
  id: 'reminders',
  label: 'Reminders due or overdue',
  category: 'other',
  role: 'editor',
  async collect({ store, now }) {
    const doc = await store.readDoc('admin_config', REMINDERS_CONFIG_ID, ADMIN_CONFIG_PARTITION);
    const today = dateOnly(now());
    const items = readStoredReminders(doc)
      .reminders.map((reminder) => ({ reminder, days: daysUntil(reminder.dueDate, today) }))
      .filter(({ reminder, days }) => !reminder.done && days !== null && days <= 0)
      .map(({ reminder, days }) =>
        decisionItem({
          id: `reminder:${reminder.id}`,
          category: 'other',
          kind: 'reminder',
          title: reminder.title,
          stage: days < 0 ? 'overdue' : 'due',
          status: days < 0 ? 'overdue' : 'due',
          waitingSince: `${reminder.dueDate}T00:00:00.000Z`,
          priority: days < 0 ? 'high' : 'normal',
          href: reminderHref(reminder.id),
          source: { collection: 'admin_config', id: REMINDERS_CONFIG_ID, reminderId: reminder.id },
          detail: reminder.notes,
        })
      );
    return { items, truncated: false };
  },
});

// ── ambassador ───────────────────────────────────────────────────────────────

/** How far ahead an ambassador deadline starts to need a decision. */
export const AMBASSADOR_HORIZON_DAYS = 14;

/** Each deadline field, the statuses it still matters in, and its verb. */
const AMBASSADOR_DEADLINES = Object.freeze([
  { field: 'submissionDeadline', verb: 'Submit', statuses: ['interested', 'preparing', 'ready'] },
  { field: 'renewalDate', verb: 'Renew', statuses: ['accepted', 'active', 'renewal_due'] },
  { field: 'expirationDate', verb: 'Expires', statuses: ['accepted', 'active', 'renewal_due'] },
]);
const OPEN_APPLICATION_STATUSES = [...new Set(AMBASSADOR_DEADLINES.flatMap((d) => d.statuses))];

function ambassadorItems(row, { horizon, todayMs }) {
  return AMBASSADOR_DEADLINES.filter(
    ({ field, statuses }) =>
      statuses.includes(row.status) && typeof row[field] === 'string' && row[field].slice(0, 10) <= horizon
  ).map(({ field, verb }) => {
    const due = row[field].slice(0, 10);
    const dueMs = Date.parse(`${due}T00:00:00.000Z`);
    const name = row.programName || row.title || row.programId || 'Ambassador application';
    const days = Math.round((dueMs - todayMs) / DAY_MS);
    return decisionItem({
      id: `ambassador:${row.id}:${field}`,
      category: 'other',
      kind: 'ambassador',
      title: `${verb}: ${name}`,
      stage: 'deadline',
      status: row.status,
      // It became a decision when it came inside the horizon, not on the day
      // itself: a deadline next week must not sort as the newest arrival.
      waitingSince: new Date(dueMs - AMBASSADOR_HORIZON_DAYS * DAY_MS).toISOString(),
      priority: days <= 3 ? 'high' : 'normal',
      href: ambassadorHref(row.id),
      source: { collection: AMBASSADOR_CONTAINER, id: row.id, deadline: field },
      detail: days < 0 ? `${-days} days past` : `Due ${due}`,
    });
  });
}

const ambassador = Object.freeze({
  id: 'ambassador',
  label: 'Ambassador deadlines',
  category: 'other',
  role: 'editor',
  async collect({ store, now }) {
    const todayMs = Date.parse(`${dateOnly(now())}T00:00:00.000Z`);
    const horizon = dateOnly(new Date(todayMs + AMBASSADOR_HORIZON_DAYS * DAY_MS));
    const limit = 50;
    const rows = await rowsOrNone(() =>
      store.queryDocs(
        AMBASSADOR_CONTAINER,
        `SELECT TOP ${limit} c.id, c.title, c.programName, c.programId, c.status, c.submissionDeadline, c.renewalDate, c.expirationDate FROM c WHERE c.docType = 'application' AND ARRAY_CONTAINS(@open, c.status) AND ((IS_STRING(c.submissionDeadline) AND c.submissionDeadline < @after) OR (IS_STRING(c.renewalDate) AND c.renewalDate < @after) OR (IS_STRING(c.expirationDate) AND c.expirationDate < @after)) ORDER BY c._ts DESC`,
        [
          { name: '@open', value: OPEN_APPLICATION_STATUSES },
          // Exclusive bound, the day after the horizon: an ISO instant on the
          // horizon day sorts after the bare day and must still be in.
          { name: '@after', value: dateOnly(new Date(todayMs + (AMBASSADOR_HORIZON_DAYS + 1) * DAY_MS)) },
        ]
      )
    );
    const items = rows.flatMap((row) => ambassadorItems(row, { horizon, todayMs }));
    return { items, truncated: rows.length >= limit };
  },
});

export const OTHER_SOURCES = Object.freeze([
  podcastTranscripts,
  listenAndLearn,
  newsletters,
  social,
  forgeQueue,
  workflowAlerts,
  unresolvedSecrets,
  cost,
  reminders,
  ambassador,
]);
