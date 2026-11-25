/**
 * insights-read-metrics.js — reading and checking a Mailing List metrics
 * request: the broadcast or issue it is about, the date window and the
 * granularity (insights-read.js holds the other readers).
 */
import { queryValue, readDate } from './insights-read.js';
import { ID_PATTERN, DEFAULT_METRICS_DAYS, DAY_MS, GRANULARITIES, json } from './insights-shared.js';
import { ISSUE_ID_PATTERN } from './issue.js';

/** `broadcast_id` or `issue_id`, at most one, each in its own shape. */
export function readMetricsIds(request) {
  const broadcastRaw = queryValue(request, 'broadcast_id');
  const issueRaw = queryValue(request, 'issue_id');
  if (broadcastRaw && issueRaw) return { error: 'Send broadcast_id or issue_id, not both' };
  if (broadcastRaw && !ID_PATTERN.test(broadcastRaw)) {
    return { error: 'broadcast_id is not a Resend id' };
  }
  if (issueRaw && !ISSUE_ID_PATTERN.test(issueRaw)) {
    return { error: 'issue_id must be issue-YYYY-MM-DD' };
  }
  return { broadcastRaw, issueRaw };
}

/** `start_date` and `end_date`, defaulted to the last DEFAULT_METRICS_DAYS days, in order. */
export function readMetricsWindow(request, now) {
  const start = readDate(request, 'start_date');
  if (start.error) return start;
  const end = readDate(request, 'end_date');
  if (end.error) return end;
  const endDate = end.value ?? now().toISOString();
  const startDate =
    start.value ?? new Date(Date.parse(endDate) - DEFAULT_METRICS_DAYS * DAY_MS).toISOString();
  if (Date.parse(startDate) > Date.parse(endDate)) {
    return { error: 'start_date must not be after end_date' };
  }
  return { startDate, endDate };
}

/** `granularity`, one of GRANULARITIES, daily when absent. */
export function readGranularity(request) {
  const granularity = queryValue(request, 'granularity') || 'daily';
  if (!GRANULARITIES.includes(granularity)) {
    return { error: `granularity must be one of ${GRANULARITIES.join(', ')}` };
  }
  return { granularity };
}

/** The whole metrics query, checked. */
export function readMetricsQuery(request, now) {
  const ids = readMetricsIds(request);
  if (ids.error) return ids;
  const window = readMetricsWindow(request, now);
  if (window.error) return window;
  const granularity = readGranularity(request);
  if (granularity.error) return granularity;
  return { ...ids, ...window, ...granularity };
}

/**
 * The broadcast the metrics are for: the `broadcast_id` as sent, or the
 * issue's recorded broadcast. `{ response }` when the issue is missing or
 * was never sent.
 */
export async function broadcastForQuery(store, { broadcastRaw, issueRaw }) {
  if (!issueRaw) return { broadcastId: broadcastRaw || undefined };
  const issue = await store.readDoc('newsletters', issueRaw, issueRaw);
  if (!issue || issue.kind !== 'weekly_issue' || issue.status === 'deleted') {
    return { response: json(404, { ok: false, error: 'Issue not found' }) };
  }
  if (typeof issue.broadcastId !== 'string' || !ID_PATTERN.test(issue.broadcastId)) {
    return {
      response: json(404, {
        ok: false,
        code: 'NO_BROADCAST',
        error: 'This issue has not been sent to Resend, so it has no metrics yet.',
      }),
    };
  }
  return { broadcastId: issue.broadcastId };
}

