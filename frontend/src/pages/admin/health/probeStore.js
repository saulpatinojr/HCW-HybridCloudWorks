/**
 * The Health Hub's stored results, as the browser reads and writes them
 * (#1011). The server side is functions/src/lib/health/probe-results.js:
 * one document per probe in Cosmos, written by whoever ran the probe — this
 * browser after a Test, or the server's health pulse every five minutes — and
 * read by every Health page on load.
 *
 * The server is the record. sessionStorage holds the last read only so a
 * reload paints the cards at once instead of flashing "Not tested yet"
 * before the read lands; it is replaced by the server's answer every time,
 * and a browser without storage simply waits for that answer.
 */
import { getJSON, sendJSON } from '@/lib/api';
import { toSystemStatus } from '@/lib/status';

export const PROBE_RESULTS_ROUTE = 'cms/health/probe-results';
export const RESULTS_CACHE_KEY = 'contentforge.health.results.v2';

/** Who checked, as the server presents it: the pulse, a scheduled timer, or else an admin. */
const CHECKERS = Object.freeze(['pulse', 'timer']);

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const isoOrNull = (value) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;

/** One stored result, in the shared words, whatever words it was stored in. */
export function normalizeStored(probeId, record) {
  if (!isObject(record)) return null;
  return {
    probeId,
    status: toSystemStatus(record.status).id,
    summary: typeof record.summary === 'string' ? record.summary : '',
    detail: typeof record.detail === 'string' && record.detail ? record.detail : undefined,
    checkedAt: isoOrNull(record.checkedAt),
    checkedBy: CHECKERS.includes(record.checkedBy) ? record.checkedBy : 'admin',
    durationMs: Number.isFinite(record.durationMs) ? record.durationMs : null,
    statusSince: isoOrNull(record.statusSince),
    previousStatus: record.previousStatus ? toSystemStatus(record.previousStatus).id : null,
    stored: true,
  };
}

/** The pulse's heartbeat, or null when it has never reported. */
export function normalizePulse(pulse) {
  const lastBeatAt = isoOrNull(pulse?.lastBeatAt);
  if (!lastBeatAt) return null;
  const number = (value) => (Number.isFinite(value) ? value : null);
  return {
    lastBeatAt,
    intervalMs: number(pulse.intervalMs),
    lateAfterMs: number(pulse.lateAfterMs),
    durationMs: number(pulse.durationMs),
    checks: number(pulse.checks),
    recorded: number(pulse.recorded),
    failures: Array.isArray(pulse.failures) ? pulse.failures : [],
  };
}

/** A GET answer (or a cached copy of one) as `{ results, pulse }`. */
export function normalizeAnswer(answer) {
  const results = {};
  if (isObject(answer?.results)) {
    for (const [probeId, record] of Object.entries(answer.results)) {
      const normalized = normalizeStored(probeId, record);
      if (normalized) results[probeId] = normalized;
    }
  }
  return { results, pulse: normalizePulse(answer?.pulse) };
}

/** Every stored result and the pulse, from the server. */
export async function readProbeResults() {
  return normalizeAnswer(await getJSON(PROBE_RESULTS_ROUTE));
}

/**
 * Record one result. The server stamps the time and decides the kind; the
 * body is what the person who ran the probe already saw. Resolves to the
 * stored result, or null when it was not stored — a viewer cannot record a
 * probe that needs an editor, and the result stays on screen regardless.
 */
export async function recordProbeResult(probeId, result, durationMs) {
  try {
    const answer = await sendJSON(PROBE_RESULTS_ROUTE, 'PUT', {
      probeId,
      status: toSystemStatus(result?.status).id,
      summary: String(result?.summary ?? '').slice(0, 500) || 'No summary.',
      ...(result?.detail ? { detail: String(result.detail).slice(0, 2000) } : {}),
      ...(Number.isFinite(durationMs) ? { durationMs: Math.round(durationMs) } : {}),
    });
    return normalizeStored(probeId, answer?.result);
  } catch {
    return null;
  }
}

export function readCache() {
  try {
    const raw = window.sessionStorage?.getItem(RESULTS_CACHE_KEY);
    return raw ? normalizeAnswer(JSON.parse(raw)) : { results: {}, pulse: null };
  } catch {
    return { results: {}, pulse: null };
  }
}

export function writeCache(answer) {
  try {
    window.sessionStorage?.setItem(RESULTS_CACHE_KEY, JSON.stringify(answer));
  } catch {
    // A fast first paint is a convenience, never a requirement.
  }
}

/** The later of two results by `checkedAt`; one with no time loses to one with a time. */
export function newestResult(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  const ta = Date.parse(a.checkedAt ?? '');
  const tb = Date.parse(b.checkedAt ?? '');
  if (!Number.isFinite(ta)) return Number.isFinite(tb) ? b : a;
  if (!Number.isFinite(tb)) return a;
  return tb > ta ? b : a;
}
