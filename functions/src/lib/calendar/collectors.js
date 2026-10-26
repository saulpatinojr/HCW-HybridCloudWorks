/**
 * Calendar collectors (ADR 0033 §4). Each source is ONE collector — a small
 * function over the store that answers calendar items for a window — so
 * adding a source is adding a collector to COLLECTORS and nothing else.
 *
 * The `ambassador` container may not be provisioned yet (ADR 0033 §6 item
 * 4); its collector treats "container not found" as "nothing there".
 */
import { collectAlerts } from '../calendar-alerts/collector.js';
import {
  PER_SOURCE_LIMIT,
  dayParams,
  item,
  itemsPerDate,
  rowsInWindow,
  text,
  windowParams,
} from './items.js';

// ── content ──────────────────────────────────────────────────────────────────

const CONTENT_FIELDS =
  'c.id, c.Title, c.title, c.contentStatus, c.Live, c.scheduledPublishDate, c.publishedAt, c.type, c.publishTarget, c["Cloud Provider"], c.cloudProvider, c.publishError, c.scheduledPublishError';

/**
 * Where a content item opens from the calendar: its page on the Review Queue.
 */
const contentHref = (row) => `/admin/review-queue/${encodeURIComponent(row.id)}?source=content`;
const contentMeta = (row) => ({
  provider: row['Cloud Provider'] || row.cloudProvider || null,
  publishTarget: row.publishTarget || row.type || null,
});

/** What the item says went wrong, when something did. */
function scheduleError(error, overdue) {
  if (error) return text(error, 300);
  return overdue ? 'The scheduled time passed and the content is not live.' : null;
}

function scheduledContentItem(row, when) {
  const error = row.publishError || row.scheduledPublishError || null;
  // A schedule still in the past with the content not live: the publisher
  // ran (or should have) and the item did not go out.
  const overdue = Date.parse(when.iso) < Date.now() - 20 * 60 * 1000;
  return item({
    id: `content:${row.id}`,
    kind: 'content',
    title: row.Title || row.title,
    start: when.iso,
    allDay: when.allDay,
    status: error || overdue ? 'failed' : 'scheduled',
    href: contentHref(row),
    sourceId: row.id,
    sourceCollection: 'content',
    meta: {
      contentStatus: String(row.contentStatus || ''),
      ...contentMeta(row),
      error: scheduleError(error, overdue),
    },
  });
}

function publishedContentItem(row, when) {
  return item({
    id: `content:${row.id}:published`,
    kind: 'content',
    title: row.Title || row.title,
    start: when.iso,
    allDay: when.allDay,
    status: 'published',
    href: contentHref(row),
    sourceId: row.id,
    sourceCollection: 'content',
    meta: { contentStatus: String(row.contentStatus || 'published'), ...contentMeta(row) },
  });
}

const isDropped = (row) => ['rejected', 'archived'].includes(String(row.contentStatus || ''));

/** Content due to publish in the window, plus what went live in it. */
export async function collectContentSchedules({ store, from, to }) {
  const params = windowParams(from, to);
  const [scheduled, published] = await Promise.all([
    store.queryDocs(
      'content',
      `SELECT TOP ${PER_SOURCE_LIMIT} ${CONTENT_FIELDS} FROM c WHERE IS_STRING(c.scheduledPublishDate) AND c.scheduledPublishDate >= @from AND c.scheduledPublishDate < @to AND (NOT IS_DEFINED(c.Live) OR c.Live != true)`,
      params
    ),
    store.queryDocs(
      'content',
      `SELECT TOP ${PER_SOURCE_LIMIT} ${CONTENT_FIELDS} FROM c WHERE c.Live = true AND IS_STRING(c.publishedAt) AND c.publishedAt >= @from AND c.publishedAt < @to`,
      params
    ),
  ]);
  const window = { from, to };
  const pending = rowsInWindow(scheduled, window, (row) => row.scheduledPublishDate)
    .filter(({ row }) => !isDropped(row))
    .map(({ row, when }) => scheduledContentItem(row, when));
  const live = rowsInWindow(published, window, (row) => row.publishedAt).map(({ row, when }) =>
    publishedContentItem(row, when)
  );
  return [...pending, ...live];
}

// ── newsletter ───────────────────────────────────────────────────────────────

/** Newsletter issues by when they send (scheduled) or sent. */
export async function collectNewsletterIssues({ store, from, to }) {
  const rows = await store.queryDocs(
    'newsletters',
    `SELECT TOP ${PER_SOURCE_LIMIT} c.id, c.status, c.subject, c.scheduledAt, c.sentAt, c.lastError, c.broadcastId FROM c WHERE c.kind = 'weekly_issue' AND c.status != 'deleted' AND ((IS_STRING(c.sentAt) AND c.sentAt >= @from AND c.sentAt < @to) OR (IS_STRING(c.scheduledAt) AND c.scheduledAt >= @from AND c.scheduledAt < @to))`,
    windowParams(from, to)
  );
  const kept = (rows || []).filter((row) => !['draft', 'rejected'].includes(row.status));
  const sendsAt = (row) => (row.status === 'sent' ? row.sentAt : row.scheduledAt || row.sentAt);
  return rowsInWindow(kept, { from, to }, sendsAt).map(({ row, when }) =>
    item({
      id: `newsletter:${row.id}`,
      kind: 'newsletter',
      title: row.subject || row.id,
      start: when.iso,
      status: row.status,
      href: `/admin/newsletter-hub?tab=published&issue=${encodeURIComponent(row.id)}`,
      sourceId: row.id,
      sourceCollection: 'newsletters',
      meta: {
        error: row.lastError ? text(row.lastError, 300) : null,
        broadcastId: row.broadcastId || null,
      },
    })
  );
}

// ── social ───────────────────────────────────────────────────────────────────

/** Social posts by scheduled time, every status, the status carried. */
export async function collectSocialPosts({ store, from, to }) {
  const rows = await store.queryDocs(
    'social_posts',
    `SELECT TOP ${PER_SOURCE_LIMIT} c.id, c.caption, c.status, c.scheduledAt, c.platforms, c.accountIds, c.contentId, c.url, c.syncStatus, c.syncError, c.publerPostIds FROM c WHERE IS_STRING(c.scheduledAt) AND c.scheduledAt >= @from AND c.scheduledAt < @to`,
    windowParams(from, to)
  );
  return rowsInWindow(rows, { from, to }, (row) => row.scheduledAt).map(({ row, when }) => {
    const failed = row.status === 'failed' || row.syncStatus === 'failed';
    return item({
      id: `social:${row.id}`,
      kind: 'social',
      title: row.caption || 'Social post',
      start: when.iso,
      status: failed ? 'failed' : row.status || 'scheduled',
      href: '/admin/social-hub?tab=queue',
      sourceId: row.id,
      sourceCollection: 'social_posts',
      meta: {
        platforms: Array.isArray(row.platforms) ? row.platforms : [],
        accountIds: Array.isArray(row.accountIds) ? row.accountIds : [],
        contentId: row.contentId || null,
        url: row.url || null,
        caption: text(row.caption, 2000),
        error: row.syncError ? text(row.syncError, 300) : null,
        publerPostIds: Array.isArray(row.publerPostIds) ? row.publerPostIds : [],
      },
    });
  });
}

// ── speaking ─────────────────────────────────────────────────────────────────

/**
 * One speaking date as a calendar item, the talk or its CFP deadline, opening
 * the Speaking page.
 */
function speakingItem(row, when, field) {
  const title = row.eventName || row.name || 'Speaking event';
  const common = {
    kind: 'speaking',
    start: when.iso,
    allDay: when.allDay,
    href: '/admin/speaking',
    sourceId: row.id,
    sourceCollection: 'speakerevents',
  };
  if (field === 'cfpDeadline') {
    return item({
      ...common,
      id: `speaking:${row.id}:cfp`,
      title: `CFP deadline: ${title}`,
      status: 'deadline',
      meta: { deadline: 'cfp' },
    });
  }
  return item({
    ...common,
    id: `speaking:${row.id}`,
    title,
    status: row.status || (row.display === false ? 'hidden' : 'scheduled'),
    meta: { location: row.location || null },
  });
}

/** Speaking events by date, and their CFP deadlines when recorded. */
export async function collectSpeakingEvents({ store, from, to }) {
  const rows = await store.queryDocs(
    'speakerevents',
    `SELECT TOP ${PER_SOURCE_LIMIT} c.id, c.eventName, c.name, c.date, c.cfpDeadline, c.status, c.location, c.display FROM c WHERE (IS_STRING(c.date) AND c.date >= @fromDay AND c.date < @toDay) OR (IS_STRING(c.cfpDeadline) AND c.cfpDeadline >= @fromDay AND c.cfpDeadline < @toDay)`,
    dayParams(from, to)
  );
  return itemsPerDate(rows, { from, to }, ['date', 'cfpDeadline'], speakingItem);
}

// ── certifications ───────────────────────────────────────────────────────────

/** The two certification dates: the id suffix, the title verb and the deadline name. */
const CERT_DEADLINES = {
  expDate: { suffix: 'expires', verb: 'Expires', deadline: 'expiration' },
  renewalDate: { suffix: 'renewal', verb: 'Renew', deadline: 'renewal' },
};

function certificationItem(row, when, field) {
  const { suffix, verb, deadline } = CERT_DEADLINES[field];
  return item({
    id: `certification:${row.id}:${suffix}`,
    kind: 'certification',
    title: `${verb}: ${row.name || 'Certification'}`,
    start: when.iso,
    allDay: when.allDay,
    status: 'deadline',
    href: '/admin/certifications?tab=renewals',
    sourceId: row.id,
    sourceCollection: 'certifications',
    meta: { issuer: row.issuer || null, deadline },
  });
}

/** Certification expirations and renewal dates. */
export async function collectCertifications({ store, from, to }) {
  const rows = await store.queryDocs(
    'certifications',
    `SELECT TOP ${PER_SOURCE_LIMIT} c.id, c.name, c.issuer, c.expDate, c.renewalDate FROM c WHERE (IS_STRING(c.expDate) AND c.expDate >= @fromDay AND c.expDate < @toDay) OR (IS_STRING(c.renewalDate) AND c.renewalDate >= @fromDay AND c.renewalDate < @toDay)`,
    dayParams(from, to)
  );
  return itemsPerDate(rows, { from, to }, Object.keys(CERT_DEADLINES), certificationItem);
}

// ── ambassador ───────────────────────────────────────────────────────────────

/** A thrown Cosmos error that means the container is not there. */
export const isContainerMissing = (error) =>
  error?.code === 404 ||
  error?.statusCode === 404 ||
  /NotFound|Resource Not Found|does not exist/i.test(String(error?.message ?? ''));

const AMBASSADOR_DEADLINES = {
  submissionDeadline: 'Submit',
  renewalDate: 'Renew',
  expirationDate: 'Expires',
};

function ambassadorItem(row, when, field) {
  const name = row.programName || row.title || row.programId || 'Ambassador application';
  return item({
    id: `ambassador:${row.id}:${field}`,
    kind: 'ambassador',
    title: `${AMBASSADOR_DEADLINES[field]}: ${name}`,
    start: when.iso,
    allDay: when.allDay,
    status: 'deadline',
    href: '/admin/ambassador',
    sourceId: row.id,
    sourceCollection: 'ambassador',
    meta: { deadline: field, applicationStatus: row.status || null },
  });
}

/** Ambassador application deadlines; nothing until the container is provisioned. */
export async function collectAmbassadorDeadlines({ store, from, to }) {
  let rows;
  try {
    rows = await store.queryDocs(
      'ambassador',
      `SELECT TOP ${PER_SOURCE_LIMIT} c.id, c.programName, c.programId, c.title, c.status, c.submissionDeadline, c.renewalDate, c.expirationDate FROM c WHERE c.docType = 'application' AND ((IS_STRING(c.submissionDeadline) AND c.submissionDeadline >= @fromDay AND c.submissionDeadline < @toDay) OR (IS_STRING(c.renewalDate) AND c.renewalDate >= @fromDay AND c.renewalDate < @toDay) OR (IS_STRING(c.expirationDate) AND c.expirationDate >= @fromDay AND c.expirationDate < @toDay))`,
      dayParams(from, to)
    );
  } catch (error) {
    if (isContainerMissing(error)) return [];
    throw error;
  }
  return itemsPerDate(rows, { from, to }, Object.keys(AMBASSADOR_DEADLINES), ambassadorItem);
}

// ── audio ────────────────────────────────────────────────────────────────────

/** Listen & Learn episodes by the day they were approved for the site. */
export async function collectListenAndLearnReleases({ store, from, to }) {
  const rows = await store.queryDocs(
    'listen_and_learn_episodes',
    `SELECT TOP ${PER_SOURCE_LIMIT} c.id, c.title, c.provider, c.setId, c.status, c.approvedAt FROM c WHERE IS_STRING(c.approvedAt) AND c.approvedAt >= @from AND c.approvedAt < @to`,
    windowParams(from, to)
  );
  return rowsInWindow(rows, { from, to }, (row) => row.approvedAt).map(({ row, when }) =>
    item({
      id: `audio:${row.id}`,
      kind: 'audio',
      title: row.title || 'Listen & Learn episode',
      start: when.iso,
      status: row.status === 'published' ? 'published' : row.status || 'draft',
      href: '/admin/listen-and-learn',
      sourceId: row.id,
      sourceCollection: 'listen_and_learn_episodes',
      meta: { provider: row.provider || null, setId: row.setId || null },
    })
  );
}

/** Every source, by name. The read runs all of them; a failure names its key. */
export const COLLECTORS = Object.freeze({
  content: collectContentSchedules,
  newsletter: collectNewsletterIssues,
  social: collectSocialPosts,
  speaking: collectSpeakingEvents,
  certification: collectCertifications,
  ambassador: collectAmbassadorDeadlines,
  audio: collectListenAndLearnReleases,
  // The owner's own dated alerts (lib/calendar-alerts); read-only, like every source.
  alert: collectAlerts,
});
