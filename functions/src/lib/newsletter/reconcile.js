/**
 * reconcile.js — move an approved issue to where Resend says it is (ADR 0033
 * Amplify slice).
 *
 * Approval writes `scheduled` and a `broadcastId`, and until 2026-10-03
 * nothing ever wrote `sent`: only a send-now approval stamped `sentAt`, so a
 * scheduled issue stayed `scheduled` forever, its metrics never appeared and
 * the calendar showed a send that had long gone out. This reads
 * `GET /broadcasts/{id}` and writes what it finds:
 *
 *   sent        → status `sent`, `sentAt` from Resend (or now)
 *   scheduled   → `scheduledAt` refreshed from Resend when it moved
 *   queued      → still scheduled; `broadcastStatus: 'queued'` so the page can say so
 *   canceled    → status `failed`, `lastError` says Resend canceled it
 *   HTTP 404    → status `failed`, `lastError` says Resend no longer has it
 *   anything else (5xx, no answer) → no write; the reason is returned
 *
 * Every write is ETag-conditional on the issue as read, so a reconcile that
 * races a reschedule or a cancel loses quietly and the next read tries again.
 * It is run lazily — on the list for overdue scheduled issues, on a read of a
 * scheduled issue, and on demand from the hub — rather than by a timer: the
 * timer catalogue is Terraform-owned, and a read that fixes itself needs no
 * schedule.
 */

import { errorCode } from '../http/error-response.js';

/** A `failed` issue reads as one whose send is over without a send. */
export const FAILED_STATUS = 'failed';

/** `value` as an ISO instant when it parses as a date, else `fallback`. */
const isoOr = (value, fallback) =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value))
    ? new Date(value).toISOString()
    : fallback;

/** Resend answered 404: the broadcast was deleted there, or never created. */
const missingPatch = (issue, nowIso) => ({
  status: FAILED_STATUS,
  broadcastStatus: 'missing',
  lastError: `Resend no longer has broadcast ${issue.broadcastId}: it was deleted there, or never created. Retry to approve it again.`,
  reconciledAt: nowIso,
});

const sentPatch = (issue, data, broadcastStatus, nowIso) => ({
  status: 'sent',
  sentAt: isoOr(data.sent_at, nowIso),
  broadcastStatus,
  lastError: null,
  reconciledAt: nowIso,
});

const canceledPatch = (issue, data, broadcastStatus, nowIso) => ({
  status: FAILED_STATUS,
  broadcastStatus: 'canceled',
  lastError:
    'Resend reports this broadcast was canceled while queued, so some or all subscribers did not get it. It cannot be sent again from Resend; retry here to approve a fresh send.',
  reconciledAt: nowIso,
});

/** Still waiting at Resend: note its status, a moved time, and that a `sending` claim is settled. */
const waitingPatch = (issue, data, broadcastStatus, nowIso) => {
  const patch = { broadcastStatus, reconciledAt: nowIso };
  const scheduledAt = isoOr(data.scheduled_at, null);
  if (scheduledAt && scheduledAt !== issue.scheduledAt) patch.scheduledAt = scheduledAt;
  if (issue.status === 'sending') patch.status = 'scheduled';
  return patch;
};

/**
 * Resend's broadcast statuses, lower-cased, to the patch each implies. Both
 * spellings of canceled have been seen; a status not listed means no write.
 */
const PATCH_BY_BROADCAST_STATUS = Object.freeze({
  sent: sentPatch,
  canceled: canceledPatch,
  cancelled: canceledPatch,
  scheduled: waitingPatch,
  queued: waitingPatch,
});

/**
 * The patch a Resend answer implies for `issue`, or null for no change.
 *
 * @param {object} issue the stored issue (status scheduled or sending, with broadcastId)
 * @param {{ ok: boolean, status: number, data: any }} result GET /broadcasts/{id}
 * @param {Date} now
 */
export function mapBroadcastToIssue(issue, result, now) {
  const nowIso = now.toISOString();
  if (!result) return null;
  if (!result.ok) return result.status === 404 ? missingPatch(issue, nowIso) : null;
  const data = result.data || {};
  const broadcastStatus = String(data.status || '').toLowerCase();
  const patchFor = Object.hasOwn(PATCH_BY_BROADCAST_STATUS, broadcastStatus)
    ? PATCH_BY_BROADCAST_STATUS[broadcastStatus]
    : null;
  return patchFor ? patchFor(issue, data, broadcastStatus, nowIso) : null;
}

/** Issues the reconcile reads: approved ones that Resend holds. */
export const reconcilable = (issue) =>
  Boolean(issue?.broadcastId) && (issue.status === 'scheduled' || issue.status === 'sending');

/** A scheduled issue whose time has passed and still says scheduled. */
export const overdue = (issue, now) =>
  issue?.status === 'scheduled' &&
  typeof issue.scheduledAt === 'string' &&
  Date.parse(issue.scheduledAt) <= now.getTime();

/**
 * Reconcile one stored issue. Resolves `{ changed, issue, reason? }`: the
 * issue as stored after the write (or as read when nothing changed), and
 * `reason` when Resend could not be read.
 */
export async function reconcileIssue({ store, client, issue, now = () => new Date(), log }) {
  if (!reconcilable(issue)) return { changed: false, issue };
  const result = await client.getBroadcast(issue.broadcastId);
  const patch = mapBroadcastToIssue(issue, result, now());
  if (!patch) {
    const reason = result?.ok
      ? `Resend reports status "${result.data?.status ?? 'unknown'}"`
      : `Resend answered HTTP ${result?.status ?? 0}`;
    return { changed: false, issue, reason };
  }
  const next = { ...issue, ...patch, updatedAt: now().toISOString() };
  try {
    const written = await store.replaceDocIfMatch('newsletters', next);
    log?.log?.(`[newsletter] reconciled an issue to ${next.status}`);
    return { changed: true, issue: written ?? next };
  } catch (error) {
    // Someone wrote first (a cancel, a reschedule): their version stands and
    // the next read reconciles again from it.
    if (error?.code === 412) return { changed: false, issue, reason: 'changed meanwhile' };
    throw error;
  }
}

/**
 * Reconcile the issues worth asking Resend about, at most `limit` per call so
 * a list read never pays for more than a handful of Resend calls.
 *
 * @param {object} args
 * @param {object[]} args.issues full issue documents
 * @param {boolean} [args.all] every reconcilable issue, not only overdue ones
 * @returns {Promise<{ reconciled: number, changed: string[], warnings: string[] }>}
 */
export async function reconcileIssues({
  store,
  client,
  issues,
  now = () => new Date(),
  all = false,
  limit = 5,
  log,
}) {
  const at = now();
  const wanted = (issues || [])
    .filter((issue) => reconcilable(issue) && (all || overdue(issue, at)))
    .slice(0, limit);
  const changed = [];
  const warnings = [];
  for (const issue of wanted) {
    try {
      const outcome = await reconcileIssue({ store, client, issue, now, log });
      if (outcome.changed) changed.push(issue.id);
      else if (outcome.reason) warnings.push(`${issue.id}: ${outcome.reason}`);
    } catch (error) {
      log?.warn?.(`[newsletter] reconcile failed: ${error?.name ?? 'Error'}`);
      // The page shows these: the failure's code, never its sentence (#945).
      warnings.push(`${issue.id}: the reconcile failed (${errorCode(error)})`);
    }
  }
  return { reconciled: wanted.length, changed, warnings };
}
