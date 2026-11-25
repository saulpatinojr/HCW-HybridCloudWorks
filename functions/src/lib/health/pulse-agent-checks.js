/**
 * pulse-agent-checks.js — two of the health pulse's snapshot checks
 * (pulse-checks.js has the rest and the header that explains them): the
 * content agent's key and refusals, and last night's export. pulse-checks.js
 * re-exports both, so callers keep one import.
 */
import { MINUTE_MS, ago, plural, result, toMillis } from './pulse-words.js';

/**
 * The content agent (Koda): its key and the day's refusals, from the
 * snapshot's `agent` block. No key is a fact, not a fault (the agent is not
 * set up); a key record the read could not reach is unknown, not "no key";
 * a revoked key with recent refusals is degraded, because something is
 * still calling with it; denials the read could not count are unknown.
 */
export function checkContentAgent(snapshot, now) {
  const agent = snapshot?.agent;
  if (!agent) return result('unknown', 'This snapshot carries no content-agent block.');
  const key = agent.key || {};
  const label = agent.label || 'The content agent';
  if (key.unavailable) {
    return result('unknown', `${label}'s key record could not be read, so its state is not known.`);
  }
  if (!key.present) return result('healthy', `${label} has no key yet: nothing can call as it.`);
  return keyVerdict(agent, key, label, now);
}

/** A key that is there: unknown when its refusals could not be counted, else degraded while it is being refused. */
function keyVerdict(agent, key, label, now) {
  const denials = agent.denials || {};
  const used = key.lastUsedAt ? `last used ${ago(key.lastUsedAt, now) ?? 'at an unknown time'}` : 'never used';
  if (denials.unavailable) {
    return result(
      'unknown',
      `${label}'s key is ${key.active ? 'active' : 'revoked'}, ${used}; its refusals could not be counted.`
    );
  }
  const refusals = `${plural(denials.total ?? 0, 'refusal')}${denials.bounded ? ' or more' : ''} in the last day`;
  const status = (denials.total ?? 0) > 0 ? 'degraded' : 'healthy';
  if (!key.active) return result(status, `${label}'s key is revoked, ${used}; ${refusals}.`);
  const off = Array.isArray(agent.sectionsOff) ? agent.sectionsOff.length : 0;
  const switches = off > 0 ? ` ${plural(off, 'switch')} off.` : '';
  return result(status, `${label}'s key is active, ${used}; ${refusals}.${switches}`);
}

/**
 * The nightly export is due every 24 hours at 03:00 UTC; two hours of grace
 * for a slow run, then the newest completed run is late (#1409).
 */
export const EXPORT_STALE_AFTER_MS = 26 * 60 * MINUTE_MS;

/** "delta/2026-11-03" — the run as its blob prefix names it. */
const runLabel = (run) => `${run.mode}/${run.runId}`;

/**
 * Did last night's export run, and did it cover every authored container
 * (#1409)? From the snapshot's `backups` block (backup/backup-status.js):
 * not known when the manifests could not be read; critical when no completed
 * run is in the window, the newest one is older than EXPORT_STALE_AFTER_MS,
 * or an authored container is missing from it; healthy otherwise, naming
 * `brain_records` and its partition key, which is what the ticket asks.
 */
export function checkNightlyExport(snapshot, now) {
  const backups = snapshot?.backups;
  if (!backups) return result('unknown', 'This snapshot carries no backups block.');
  if (backups.unavailable) {
    return result(
      'unknown',
      "The export's run manifests could not be read, so last night's export is not known."
    );
  }
  return backups.lastCompleted ? completedRunVerdict(backups.lastCompleted, now) : noCompletedRun(backups);
}

/** No completed run in the window: critical, saying how far the newest run got. */
function noCompletedRun(backups) {
  const days = backups.lookbackDays ?? 7;
  const newest = Array.isArray(backups.runs) ? backups.runs[0] : null;
  const progress = newest
    ? ` The newest run, ${runLabel(newest)}, has ${plural(newest.markers ?? 0, 'container marker')}${newest.expectedCount ? ` of ${newest.expectedCount}` : ''} and no manifest.`
    : '';
  return result('critical', `No completed export manifest in the last ${plural(days, 'day')}.${progress}`);
}

/** What the run says about the watched container (`brain_records`), or nothing. */
function watchedWordsOf(watched) {
  if (!watched) return '';
  return watched.present
    ? ` ${watched.container}: ${plural(watched.docs ?? 0, 'record')}, partition key ${watched.partitionKey}.`
    : ` ${watched.container} is not in it.`;
}

/** The newest completed run: critical when it is late or an authored container is missing from it. */
function completedRunVerdict(last, now) {
  const finished = ago(last.completedAt, now) ?? 'at an unknown time';
  const ageMs = now - toMillis(last.completedAt);
  const missing = Array.isArray(last.authored?.missing) ? last.authored.missing : [];
  const watchedWords = watchedWordsOf(last.watched);
  if (!Number.isFinite(ageMs) || ageMs > EXPORT_STALE_AFTER_MS) {
    return result(
      'critical',
      `The newest completed export, ${runLabel(last)}, finished ${finished}; a run is due every 24 h.${watchedWords}`
    );
  }
  if (missing.length > 0) {
    return result(
      'critical',
      `Export ${runLabel(last)} completed ${finished} with ${plural(last.containerCount ?? 0, 'container')}, but ${plural(missing.length, 'authored container')} ${missing.length === 1 ? 'is' : 'are'} missing: ${missing.join(', ')}.${watchedWords}`
    );
  }
  return result(
    'healthy',
    `Export ${runLabel(last)} completed ${finished}: ${plural(last.containerCount ?? 0, 'container')}, every authored container present (${last.authored?.present ?? 0} of ${last.authored?.expected ?? 0}).${watchedWords}`
  );
}
