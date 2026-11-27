/**
 * health/probe-presenters.js — a stored probe result, and the pulse's
 * heartbeat, as the Health page reads them (probe-results.js stores them).
 * Field by field, never a spread of the document, so a field a future
 * writer adds cannot reach the page unreviewed. probe-results.js
 * re-exports these, so callers keep one import.
 */
import { normalizeStatus, PULSE_INTERVAL_MS, PULSE_LATE_AFTER_MS } from './status-model.js';

export const text = (value, max) => {
  const out = String(value ?? '').trim();
  return out ? out.slice(0, max) : '';
};
const isoOrNull = (value) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);

/**
 * Who checked, as the page may say it: the pulse, a scheduled timer (the daily
 * rate limit check, #1918), or else an admin. Never a person's name.
 */
const CHECKERS = Object.freeze(['pulse', 'timer']);
const checkerOf = (value) => (CHECKERS.includes(value) ? value : 'admin');

/**
 * One stored result as the page reads it, field by field — never a spread of
 * the document, so a field a future writer adds cannot reach the page
 * unreviewed, and `recordedBy` never does.
 */
export function presentResult(doc) {
  if (!doc || typeof doc !== 'object') return null;
  return {
    probeId: String(doc.probeId ?? ''),
    kind: typeof doc.kind === 'string' ? doc.kind : null,
    status: normalizeStatus(doc.status) ?? 'unknown',
    summary: typeof doc.summary === 'string' ? doc.summary : '',
    detail: typeof doc.detail === 'string' && doc.detail ? doc.detail : null,
    checkedAt: isoOrNull(doc.checkedAt),
    checkedBy: checkerOf(doc.checkedBy),
    durationMs: finiteOrNull(doc.durationMs),
    statusSince: isoOrNull(doc.statusSince),
    previousStatus: normalizeStatus(doc.previousStatus),
  };
}

/** The pulse's heartbeat as the page reads it, or null when it has never beaten. */
export function presentPulse(doc) {
  const lastBeatAt = isoOrNull(doc?.lastBeatAt);
  if (!lastBeatAt) return null;
  return {
    lastBeatAt,
    intervalMs: finiteOrNull(doc.intervalMs) ?? PULSE_INTERVAL_MS,
    lateAfterMs: finiteOrNull(doc.lateAfterMs) ?? PULSE_LATE_AFTER_MS,
    durationMs: finiteOrNull(doc.durationMs),
    checks: finiteOrNull(doc.checks),
    recorded: finiteOrNull(doc.recorded),
    failures: Array.isArray(doc.failures)
      ? doc.failures.slice(0, 20).map((row) => ({
          probeId: String(row?.probeId ?? ''),
          error: text(row?.error, 300),
        }))
      : [],
  };
}
