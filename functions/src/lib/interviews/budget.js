/**
 * budget.js — the one monthly ceiling the interview jobs share (ADR 0040
 * D3, #1565; design review round two).
 *
 * `INTERVIEW_TRANSCRIPTION_MONTHLY_USD` (default 10) bounds what the
 * interviews spend on models in a calendar month (UTC): the transcription
 * windows (`ai:recordingTranscript`) and the drafting passes
 * (`ai:interviewDrafting`), both read from the `ai_usage` ledger the router
 * and the transcription job write. Each job checks the month's figure plus
 * its own running spend plus the next request's estimate before that
 * request is sent, and refuses with BUDGET_EXCEEDED when it would cross
 * the line. The figure is re-read as a job goes along so two jobs running
 * at once see each other's rows.
 */
import { USAGE_CONTAINER, featureSource, totalCostUsd } from '../ai/usage.js';
import { readSetting } from '../http/read-setting.js';
import { JobFailedError } from '../jobs.js';

export const CEILING_SETTING = 'INTERVIEW_TRANSCRIPTION_MONTHLY_USD';
export const CEILING_DEFAULT_USD = 10;

/** The tasks the ceiling covers, by their usage source. */
export const CEILING_SOURCES = Object.freeze([featureSource('recordingTranscript'), featureSource('interviewDrafting')]);

/** The monthly ceiling in USD: the setting when it is a positive number, else the default. */
export function monthlyCeilingUsd(env = process.env) {
  const value = Number(readSetting(env, CEILING_SETTING));
  return Number.isFinite(value) && value > 0 ? value : CEILING_DEFAULT_USD;
}

/** The month's spend on the interview tasks, from `ai_usage`, since the first of the month (UTC). */
export async function monthInterviewSpend({ store, now = () => new Date() }) {
  const start = new Date(now());
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const since = start.toISOString();
  const rows = await store.queryDocs(
    USAGE_CONTAINER,
    'SELECT c.estimatedCostUsd FROM c WHERE c.source IN (@transcribe, @draft) AND c.timestamp >= @since',
    [
      { name: '@transcribe', value: CEILING_SOURCES[0] },
      { name: '@draft', value: CEILING_SOURCES[1] },
      { name: '@since', value: since },
    ]
  );
  return { since, costUsd: totalCostUsd(rows) };
}

/**
 * The refusal when a request would cross the ceiling: the figures in the
 * sentence are the month's and the job's, rounded, never a document's
 * content.
 */
export function budgetExceeded({ what, usedUsd, ceiling, since, costUsd }) {
  return new JobFailedError(
    `${what} paused: $${usedUsd.toFixed(2)} of the $${ceiling} monthly interview ceiling is used since ${since.slice(0, 10)}, and this request would cost about $${costUsd.toFixed(2)}. Raise ${CEILING_SETTING} or wait for the first of the month.`,
    { code: 'BUDGET_EXCEEDED', status: 429 }
  );
}
