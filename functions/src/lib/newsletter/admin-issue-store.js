/**
 * admin-issue-store.js — the newsletter issue routes' limits, and reading,
 * summarising, versioning and writing an issue document (admin-handlers.js
 * says what the routes do, and exports the limits again).
 */
import { resolveSendTime } from './schedule.js';
import { parseFromAddress, checkSendingDomain } from './sender.js';
import { json, errorMeta } from './admin-responses.js';
import { ISSUE_ID_PATTERN } from './issue.js';
import { overdue, reconcileIssues } from './reconcile.js';

export const MAX_CUSTOM_NOTE_LENGTH = 2000;
export const MAX_SUBJECT_LENGTH = 120;
export const MAX_PREHEADER_LENGTH = 150;
/** One test email per issue per this long. */
export const TEST_SEND_INTERVAL_MS = 60 * 1000;

export const EDITABLE_FIELDS = ['customNote', 'subject', 'preheader', 'sections', 'sendAt', 'etag'];
export const LIST_LIMIT = 50;
export const PUBLISHED_LIMIT = 100;
/** How many versions an issue remembers (ADR 0033): the last ten saves. */
export const MAX_VERSIONS = 10;
/** Overdue scheduled issues a list read asks Resend about, at most. */
export const LIST_RECONCILE_LIMIT = 5;

/** Only these can be deleted: anything else was approved, and Resend has it (a failed one no longer does). */
export const DELETABLE = new Set(['draft', 'rejected', 'failed']);
/** A draft, or an issue stuck in `sending` once Resend's Broadcasts list has been checked. */
export const REJECTABLE = new Set(['draft', 'sending']);

/** What the preview footer shows before an address is set, so it is obvious. */
export const ADDRESS_NOT_SET = '[Postal address not set — add it in Newsletter settings before approving]';

/** Stored fields the page may see. The issue holds nothing private, but a list is a projection. */
export const SUMMARY_FIELDS = [
  'id',
  'status',
  'subject',
  'periodStart',
  'periodEnd',
  'itemCount',
  'createdAt',
  'updatedAt',
  'approvedAt',
  'scheduledAt',
  'sentAt',
  'rejectedAt',
  'savedAt',
  'lastError',
  'sendAt',
  'broadcastStatus',
  'reconciledAt',
  'canceledAt',
  'duplicatedFrom',
];

/** The list reads only what it shows, not every issue's sections. */
export const SUMMARY_PROJECTION = SUMMARY_FIELDS.map((field) => `c.${field}`).join(', ');

export const pick = (doc, fields) =>
  Object.fromEntries(fields.filter((f) => doc[f] !== undefined).map((f) => [f, doc[f]]));

/** A list row: the summary plus the etag, so a card can be deleted without opening it. */
export const summarise = (row) => ({
  ...pick(row, SUMMARY_FIELDS),
  etag: row._etag ?? null,
});

/**
 * The `?month=YYYY-MM` window, padded a day each side: the calendar places an
 * issue by the viewer's local date, which can fall in the neighbouring UTC
 * month. The page drops what is outside the month it shows.
 */
export function monthWindow(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  const day = 24 * 60 * 60 * 1000;
  return {
    from: new Date(Date.UTC(year, monthNumber - 1, 1) - day).toISOString(),
    to: new Date(Date.UTC(year, monthNumber, 1) + day).toISOString(),
  };
}

/**
 * When an issue approved (or looked at) at `at` goes out: the issue's own
 * `sendAt` when it is set and still ahead, else the settings slot. An
 * override already in the past is reported, not silently honoured, because
 * Resend refuses a past `scheduled_at`.
 */
export function planFor(issue, settings, at) {
  const override = typeof issue?.sendAt === 'string' ? Date.parse(issue.sendAt) : NaN;
  if (Number.isFinite(override) && override > at.getTime()) {
    return {
      sendNow: false,
      scheduledAt: new Date(override).toISOString(),
      override: true,
    };
  }
  const plan = resolveSendTime(at, settings);
  return Number.isFinite(override) ? { ...plan, overrideExpired: true } : plan;
}

/** The last saved versions, newest first, with the one being replaced in front. */
export function pushVersion(issue, by, at) {
  const snapshot = {
    at,
    by,
    subject: issue.subject ?? '',
    preheader: issue.preheader ?? '',
    customNote: issue.customNote ?? '',
    sections: issue.sections ?? [],
    itemCount: issue.itemCount ?? 0,
  };
  const existing = Array.isArray(issue.versions) ? issue.versions : [];
  return [snapshot, ...existing].slice(0, MAX_VERSIONS);
}

/** A version as the page lists it: no sections, which can be large. */
export const summariseVersion = (version) => ({
  at: version.at,
  by: version.by ?? null,
  subject: version.subject ?? '',
  preheader: version.preheader ?? '',
  itemCount:
    version.itemCount ??
    (version.sections || []).reduce((sum, s) => sum + (s.items?.length || 0), 0),
  sectionCount: (version.sections || []).length,
});

/**
 * The AI time budget of the two routes that wait on the drafter: regenerate
 * the intro, and suggest subject lines. It is counted from the moment the
 * handler starts, so the reads before the model call spend from it.
 *
 * Neither route has an entry in the client's timeout table (frontend
 * lib/api.js), so both get its 20 s default. 14 s leaves room for the write
 * and the render that follow a regenerated intro, and for the trip to the
 * browser. Inside it, a slow first provider fails over rather than
 * outliving the page (router.js header, SYNCHRONOUS CALLS HAVE A TIME
 * BUDGET). sync-budgets.test.js pins it against the client default.
 */
export const NEWSLETTER_AI_BUDGET_MS = 14_000;

/**
 * The From address to store for a trimmed `raw` (PUT newsletter-sender): ''
 * returns to the default; anything else must parse and sit on a sending
 * domain — the default's, or one Resend lists as verified. `{ error }` is
 * the 400 to return.
 */
export async function resolveSender(raw, client) {
  if (!raw) return { from: '' };
  const parsed = parseFromAddress(raw);
  if (!parsed) {
    return {
      error: json(400, {
        ok: false,
        error: 'from must be an email address, optionally as "Name <address>"',
      }),
    };
  }
  const domain = await checkSendingDomain(parsed.domain, client);
  if (!domain.ok) {
    return { error: json(400, { ok: false, code: 'DOMAIN_NOT_SENDING', error: domain.reason }) };
  }
  return { from: parsed.from };
}

/** The issue the path names, or null: not an id, not found, not an issue, or deleted. */
export async function readIssueDoc(store, request) {
  const id = String(request.params?.id ?? '');
  if (!ISSUE_ID_PATTERN.test(id)) return null;
  const doc = await store.readDoc('newsletters', id, id);
  return doc?.kind === 'weekly_issue' && doc.status !== 'deleted' ? doc : null;
}

/**
 * An ETag-conditional write of an issue: `{ doc }` as stored (the document
 * passed, when the store returns nothing), or `{ conflict: true }` when the
 * issue changed since it was read (412). Any other failure throws.
 */
export async function replaceIssueIfMatch(store, doc) {
  try {
    return { doc: (await store.replaceDocIfMatch('newsletters', doc)) ?? doc };
  } catch (error) {
    if (error?.code === 412) return { conflict: true };
    throw error;
  }
}

/**
 * The list's lazy reconcile: full documents for the overdue scheduled rows,
 * asked of Resend, and the rows replaced by what came back. Silent without
 * a key. Never throws: a list must not fail because Resend did.
 */
export async function reconcileOverdueRows({ store, now, clientOrNull }, rows, context) {
  const client = clientOrNull();
  const at = now();
  const candidates = (rows || [])
    .filter((row) => overdue(row, at) && row.broadcastId !== null)
    .slice(0, LIST_RECONCILE_LIMIT);
  if (!client || candidates.length === 0) return { rows, warnings: [] };
  try {
    const issues = (
      await Promise.all(candidates.map((row) => store.readDoc('newsletters', row.id, row.id)))
    ).filter(Boolean);
    const outcome = await reconcileIssues({
      store,
      client,
      issues,
      now,
      all: true,
      limit: LIST_RECONCILE_LIMIT,
      log: context,
    });
    if (outcome.changed.length === 0) return { rows, warnings: outcome.warnings };
    const refreshed = await Promise.all(
      outcome.changed.map((id) => store.readDoc('newsletters', id, id))
    );
    const byId = new Map(refreshed.filter(Boolean).map((doc) => [doc.id, doc]));
    return {
      rows: rows.map((row) => (byId.has(row.id) ? byId.get(row.id) : row)),
      warnings: outcome.warnings,
    };
  } catch (error) {
    context.warn?.(`listNewsletters reconcile skipped: ${errorMeta(error)}`);
    return { rows, warnings: [] };
  }
}

