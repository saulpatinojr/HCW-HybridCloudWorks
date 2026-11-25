/**
 * The verdicts the Health page reads from the ops digest's timed blocks: the
 * scheduled publisher, the content agent's key and the nightly export. Each
 * is shared by a Checks probe (probeEvaluators.js) and an Overview card
 * (signals.jsx), so the two always agree; each also has a twin in the health
 * pulse on the server, held equal by statusParity.test.js. Moved out of
 * probeEvaluators.js, which re-exports them, when that file grew too long.
 */
import { toMillis } from '@/lib/dateUtils';
import { ago, plural, result, stamp } from './probeKit';

/** The scheduled publisher's cadence: `publishScheduledContent` runs every fifteen minutes. */
export const PUBLISHER_INTERVAL_MS = 15 * 60 * 1000;
/** Three missed runs (lib/status.js MISSED_BEATS): the scheduler has stopped. */
export const PUBLISHER_LATE_AFTER_MS = 3 * PUBLISHER_INTERVAL_MS;

/** `ago` for any shape of time a digest has held (`toMillis` answers 0 for none). */
export const agoOf = (value, now = Date.now()) => {
  const ms = toMillis(value);
  return ms > 0 ? ago(new Date(ms).toISOString(), now) : null;
};

/** The scheduler has written no run: idle, unless the watchdog says items are overdue. */
function idleSchedulerVerdict(overdue, when, checkedAt) {
  if (overdue > 0) {
    return result(
      'degraded',
      `${plural(overdue, 'scheduled item')} overdue and the scheduler has written no run.${when}`,
      { checkedAt }
    );
  }
  return result('unknown', `No scheduler run is recorded in the latest digest.${when}`, {
    checkedAt,
  });
}

/**
 * The scheduler's last run, judged first by its heartbeat — it records every
 * run, so three missed fifteen-minute runs mean it has stopped — then by its
 * status and the watchdog's overdue count.
 */
function schedulerRunVerdict(ops, overdue, when, checkedAt, now) {
  const counts = `${ops.published ?? 0} published, ${ops.skipped ?? 0} skipped, ${ops.failed ?? 0} failed of ${ops.due ?? 0} due.`;
  const lastRun = toMillis(ops.lastRunAt);
  if (lastRun > 0 && now - lastRun > PUBLISHER_LATE_AFTER_MS) {
    return result(
      'offline',
      `The scheduler has missed its 15-minute runs: the last one was ${agoOf(ops.lastRunAt, now)}. ${counts}`,
      { checkedAt }
    );
  }
  if (ops.status === 'failed') {
    return result('critical', `The last run failed. ${counts}${when}`, { checkedAt });
  }
  if (ops.status === 'degraded' || overdue > 0) {
    const overdueNote = overdue > 0 ? `${plural(overdue, 'item')} overdue. ` : '';
    return result('degraded', `${overdueNote}${counts}${when}`, { checkedAt });
  }
  return result('healthy', `${counts}${when}`, { checkedAt });
}

/**
 * The scheduled publisher's verdict from a digest: the probe's, and the
 * Publishing Operations card's status on Overview, so the two agree.
 */
export function scheduledPublishingVerdict(digest, checkedAt, now = Date.now()) {
  const ops = digest?.publishingOps;
  const watchdog = digest?.publishingWatchdog;
  const overdue = Number(watchdog?.overdueScheduledCount) || 0;
  const lastRun = ops?.lastRunAt || watchdog?.lastRunAt;
  const when = lastRun ? ` Last activity ${agoOf(lastRun, now) ?? 'at an unknown time'}.` : '';
  return ops
    ? schedulerRunVerdict(ops, overdue, when, checkedAt, now)
    : idleSchedulerVerdict(overdue, when, checkedAt);
}

/** "last used 40 min ago" or "never used". */
const keyUsage = (key, now) =>
  key.lastUsedAt ? `last used ${agoOf(key.lastUsedAt, now) ?? 'at an unknown time'}` : 'never used';

/** "2 refusals in the last day", "200 refusals or more …", or that they could not be counted. */
const refusalsText = (denials) =>
  denials.unavailable
    ? 'its refusals could not be counted'
    : `${plural(denials.total ?? 0, 'refusal')}${denials.bounded ? ' or more' : ''} in the last day`;

/** Refusals with a key that can still be used are worth a look. */
const refusalsStatus = (denials) => ((denials.total ?? 0) > 0 ? 'degraded' : 'healthy');

/**
 * The key record could not be read (not known), or there is no key yet (a
 * fact, not a fault). Null when there is a key to judge.
 */
function noUsableKeyRecord(key, label, extra) {
  if (key.unavailable) {
    return result(
      'unknown',
      `${label}'s key record could not be read, so its state is not known.`,
      extra
    );
  }
  if (!key.present) {
    return result('healthy', `${label} has no key yet: nothing can call as it.`, extra);
  }
  return null;
}

/**
 * The content agent (Koda, ADR 0037 and 0038) from the snapshot's `agent`
 * block: the same words as the pulse's checkContentAgent, so the Overview
 * card and the Checks probe never disagree. No key is a fact, not a fault; a
 * key record the read could not reach is unknown, not "no key"; refusals
 * with a live key are worth a look; refusals the read could not count are
 * unknown, never zero.
 */
export function contentAgentVerdict(agent, now = Date.now()) {
  if (!agent) return result('unknown', 'This snapshot carries no content-agent block.');
  const key = agent.key || {};
  const denials = agent.denials || {};
  const label = agent.label || 'The content agent';
  const extra = { checkedAt: agent.lastCheckedAt ?? stamp() };
  const noKey = noUsableKeyRecord(key, label, extra);
  if (noKey) return noKey;
  const used = keyUsage(key, now);
  const refusals = refusalsText(denials);
  const state = key.active ? 'active' : 'revoked';
  if (denials.unavailable) {
    return result('unknown', `${label}'s key is ${state}, ${used}; ${refusals}.`, extra);
  }
  if (!key.active) {
    return result(
      refusalsStatus(denials),
      `${label}'s key is revoked, ${used}; ${refusals}.`,
      extra
    );
  }
  const off = Array.isArray(agent.sectionsOff) ? agent.sectionsOff.length : 0;
  const switches = off > 0 ? ` ${plural(off, 'switch')} off.` : '';
  return result(
    refusalsStatus(denials),
    `${label}'s key is active, ${used}; ${refusals}.${switches}`,
    extra
  );
}

/**
 * The nightly export is due every 24 hours at 03:00 UTC; two hours of grace
 * for a slow run, then the newest completed run is late (#1409). The pulse
 * keeps the same number (pulse-checks.js EXPORT_STALE_AFTER_MS).
 */
export const EXPORT_STALE_AFTER_MS = 26 * 60 * 60 * 1000;

/** "delta/2026-11-03" — the run as its blob prefix names it. */
const runLabel = (run) => `${run.mode}/${run.runId}`;

/**
 * The watched container's sentence: its record count and partition key when
 * the export has it, that it is missing when not, nothing when the manifest
 * names no watched container.
 */
const watchedWords = (watched) => {
  if (!watched) return '';
  if (!watched.present) return ` ${watched.container} is not in it.`;
  return ` ${watched.container}: ${plural(watched.docs ?? 0, 'record')}, partition key ${watched.partitionKey}.`;
};

/** "2 authored containers are missing: a, b" — the containers the export should have had. */
const missingWords = (missing) =>
  `${plural(missing.length, 'authored container')} ${missing.length === 1 ? 'is' : 'are'} missing: ${missing.join(', ')}`;

/** No manifest completed in the window; name the newest run's progress when there is one. */
const noCompletedRun = (backups, extra) => {
  const days = backups.lookbackDays ?? 7;
  const newest = Array.isArray(backups.runs) ? backups.runs[0] : null;
  const progress = newest
    ? ` The newest run, ${runLabel(newest)}, has ${plural(newest.markers ?? 0, 'container marker')}${newest.expectedCount ? ` of ${newest.expectedCount}` : ''} and no manifest.`
    : '';
  return result(
    'critical',
    `No completed export manifest in the last ${plural(days, 'day')}.${progress}`,
    extra
  );
};

/**
 * Did last night's Cosmos export run, and did it cover every authored
 * container (#1409)? From the snapshot's `backups` block, which the
 * functions worker reads from the private cosmos-export container. The same
 * verdict and sentence as the pulse's checkNightlyExport: not known when the
 * manifests could not be read; critical when no run completed in the window,
 * the newest one is older than 26 h, or an authored container is missing;
 * healthy otherwise, naming `brain_records` and its partition key.
 */
export function nightlyExportVerdict(backups, now = Date.now()) {
  if (!backups) return result('unknown', 'This snapshot carries no backups block.');
  const extra = { checkedAt: backups.lastCheckedAt ?? backups.checkedAt ?? stamp() };
  if (backups.unavailable) {
    return result(
      'unknown',
      "The export's run manifests could not be read, so last night's export is not known.",
      extra
    );
  }
  const last = backups.lastCompleted;
  if (!last) return noCompletedRun(backups, extra);
  return completedRunVerdict(last, extra, now);
}

/**
 * The newest completed export: late when it finished more than 26 h ago,
 * critical when an authored container is missing, healthy otherwise.
 */
function completedRunVerdict(last, extra, now) {
  const finished = ago(last.completedAt, now) ?? 'at an unknown time';
  const ageMs = now - Date.parse(last.completedAt ?? '');
  const missing = Array.isArray(last.authored?.missing) ? last.authored.missing : [];
  const { watched } = last;
  const tail = watchedWords(watched);
  if (!Number.isFinite(ageMs) || ageMs > EXPORT_STALE_AFTER_MS) {
    return result(
      'critical',
      `The newest completed export, ${runLabel(last)}, finished ${finished}; a run is due every 24 h.${tail}`,
      extra
    );
  }
  if (missing.length > 0) {
    return result(
      'critical',
      `Export ${runLabel(last)} completed ${finished} with ${plural(last.containerCount ?? 0, 'container')}, but ${missingWords(missing)}.${tail}`,
      extra
    );
  }
  return result(
    'healthy',
    `Export ${runLabel(last)} completed ${finished}: ${plural(last.containerCount ?? 0, 'container')}, every authored container present (${last.authored?.present ?? 0} of ${last.authored?.expected ?? 0}).${tail}`,
    extra
  );
}
