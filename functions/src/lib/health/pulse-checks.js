/**
 * pulse-checks.js — the checks the health pulse can make on its own, as pure
 * functions from what it read to one result each (#1010).
 *
 * Every check here answers a probe the Health Hub already shows, under the
 * same id, with the same verdict and the same sentence the page would give
 * from the same data. The snapshot checks repeat the frontend's evaluators
 * (frontend/src/pages/admin/health/probeEvaluators.js) and the lab and MCP
 * checks its runners (probeRunners.js); statusParity.test.js runs both on the
 * same fixtures and fails on any difference, so a card never flips between
 * two opinions as the page and the pulse take turns writing it.
 *
 * Two checks have no browser twin, because the browser's version spends
 * something the pulse must not spend every five minutes:
 *
 *   ai-providers  the browser asks every enabled provider one word; the pulse
 *                 reads what the last such Test (or the weekly probe) wrote
 *                 onto each provider document, and says how old that is.
 *   cosmos        the browser judges the snapshot it was handed; the pulse
 *                 judges whether it could build one at all.
 *
 * Each returns `{ status, summary, detail? }` in the shared vocabulary
 * (status-model.js). None throws on odd data: a block the snapshot lacks is
 * `unknown`, said as such.
 */
import { classifyFailure } from './status-model.js';
import { storedFailure } from '../http/error-response.js';
import { MINUTE_MS, ago, plural, result, toMillis } from './pulse-words.js';
import { checkContentAgent, checkNightlyExport } from './pulse-agent-checks.js';

export { ago, toMillis } from './pulse-words.js';
export { EXPORT_STALE_AFTER_MS, checkContentAgent, checkNightlyExport } from './pulse-agent-checks.js';
export {
  AI_TEST_STALE_AFTER_MS,
  aiProvidersVerdict,
  labAgentsFromRows,
  labAgentsVerdict,
  mcpServersVerdict,
} from './pulse-registry-checks.js';

/** The scheduled publisher's cadence: `publishScheduledContent` runs every fifteen minutes. */
export const PUBLISHER_INTERVAL_MS = 15 * MINUTE_MS;
/** Three missed runs, the heartbeat rule (status-model.js MISSED_BEATS). */
export const PUBLISHER_LATE_AFTER_MS = 3 * PUBLISHER_INTERVAL_MS;

// ── From the ops snapshot ────────────────────────────────────────────────────

export function checkCosmos() {
  return result('healthy', 'Cosmos DB answered the ten-query ops snapshot.');
}

/**
 * What the pulse records for Cosmos when the snapshot could not be built: a
 * sentence with the error's code, never the store's own words (#945), since
 * the Health view serves the stored result.
 *
 * @param {unknown} error - what building the snapshot threw
 * @returns {{ status: string, summary: string }}
 */
export function cosmosFailure(error) {
  return result(
    classifyFailure(error),
    storedFailure(error, 'The ops-health snapshot could not be read.')
  );
}

/**
 * The unresolved names split into on-purpose and not (#1512). A snapshot from
 * before the split carries only `unresolvedSecrets`; every name in it then
 * counts as unexpected, which is what the page said before.
 */
export function unresolvedSplit(readiness) {
  const all = Array.isArray(readiness?.unresolvedSecrets) ? readiness.unresolvedSecrets : [];
  if (!Array.isArray(readiness?.unexpectedUnresolved)) return { expected: [], unexpected: all };
  const expected = (Array.isArray(readiness.expectedUnresolved) ? readiness.expectedUnresolved : []).map(
    (entry) => (typeof entry === 'string' ? entry : entry?.name)
  );
  return { expected: expected.filter(Boolean), unexpected: readiness.unexpectedUnresolved };
}

/** "3 Key Vault references are unresolved on purpose, waiting on the owner: A, B, C" */
export function expectedPhrase(names) {
  return `${plural(names.length, 'Key Vault reference')} ${names.length === 1 ? 'is' : 'are'} unresolved on purpose, waiting on the owner: ${names.join(', ')}`;
}

/** " 2 more are unresolved on purpose." after a Critical sentence, or nothing. */
const alsoExpected = (names) =>
  names.length ? ` ${names.length} more ${names.length === 1 ? 'is' : 'are'} unresolved on purpose.` : '';

export function checkRuntimeConfig(snapshot) {
  const readiness = snapshot?.readiness;
  if (!readiness) return result('unknown', 'This snapshot carries no readiness block.');
  const { expected, unexpected } = unresolvedSplit(readiness);
  if (readiness.configGeneration === 'unset') {
    return result(
      'critical',
      'The runtime configuration stamp never reached this worker, so its app settings may be stale.'
    );
  }
  if (unexpected.length > 0) {
    return result(
      'critical',
      `${plural(unexpected.length, 'Key Vault reference')} did not resolve: ${unexpected.join(', ')}.${alsoExpected(expected)}`,
      { detail: `Generation ${readiness.configGeneration} by ${readiness.configWriter}.` }
    );
  }
  const generation = `Configuration generation ${readiness.configGeneration ?? 'unknown'} (${readiness.configWriter ?? 'unknown writer'})`;
  if (expected.length > 0) {
    return result('healthy', `${generation}; ${expectedPhrase(expected)}; every other one resolved.`);
  }
  return result('healthy', `${generation}; every Key Vault reference resolved.`);
}

export function checkUnresolvedSecrets(snapshot) {
  const names = snapshot?.readiness?.unresolvedSecrets;
  if (!Array.isArray(names)) return result('unknown', 'This snapshot carries no Key Vault count.');
  const { expected, unexpected } = unresolvedSplit(snapshot.readiness);
  if (unexpected.length > 0) {
    return result(
      'critical',
      `${plural(unexpected.length, 'Key Vault reference')} did not resolve: ${unexpected.join(', ')}.${alsoExpected(expected)}`
    );
  }
  if (expected.length > 0) {
    return result('healthy', `${expectedPhrase(expected)}; every other one resolved on the answering worker.`);
  }
  return result('healthy', 'Every Key Vault reference resolved on the answering worker.');
}

/** The scheduler has written no run: idle, unless the watchdog says items are overdue. */
function idleSchedulerVerdict(overdue, when) {
  if (overdue > 0) {
    return result(
      'degraded',
      `${plural(overdue, 'scheduled item')} overdue and the scheduler has written no run.${when}`
    );
  }
  return result('unknown', `No scheduler run is recorded in the latest digest.${when}`);
}

/** The scheduler's last run, judged by its heartbeat, its status and the watchdog's overdue count. */
function schedulerRunVerdict(ops, overdue, when, now) {
  const counts = `${ops.published ?? 0} published, ${ops.skipped ?? 0} skipped, ${ops.failed ?? 0} failed of ${ops.due ?? 0} due.`;
  const lastRun = toMillis(ops.lastRunAt);
  if (Number.isFinite(lastRun) && now - lastRun > PUBLISHER_LATE_AFTER_MS) {
    return result(
      'offline',
      `The scheduler has missed its 15-minute runs: the last one was ${ago(ops.lastRunAt, now)}. ${counts}`
    );
  }
  if (ops.status === 'failed') return result('critical', `The last run failed. ${counts}${when}`);
  if (ops.status === 'degraded' || overdue > 0) {
    const overdueNote = overdue > 0 ? `${plural(overdue, 'item')} overdue. ` : '';
    return result('degraded', `${overdueNote}${counts}${when}`);
  }
  return result('healthy', `${counts}${when}`);
}

export function checkScheduledPublishing(snapshot, now) {
  const digest = snapshot?.digest;
  const ops = digest?.publishingOps;
  const watchdog = digest?.publishingWatchdog;
  const overdue = Number(watchdog?.overdueScheduledCount) || 0;
  const lastRun = ops?.lastRunAt || watchdog?.lastRunAt;
  const when = lastRun ? ` Last activity ${ago(lastRun, now) ?? 'at an unknown time'}.` : '';
  return ops ? schedulerRunVerdict(ops, overdue, when, now) : idleSchedulerVerdict(overdue, when);
}

const countCheck =
  (pick, { zero, some }) =>
  (snapshot) => {
    const signals = snapshot?.operationalSignals;
    if (!signals) return result('unknown', 'This snapshot carries no operational signals.');
    const count = Number(pick(signals)) || 0;
    return count === 0 ? result('healthy', zero) : result('degraded', some(count, signals));
  };

export const checkPublishingFailures = countCheck((s) => s.publishFailureCount, {
  zero: 'No open publish-failure alerts.',
  some: (n) => `${plural(n, 'open publish-failure alert')}.`,
});

export const checkQueueSla = countCheck((s) => s.queueBreachCount, {
  zero: 'Nothing has waited in the review queue for more than 24 hours.',
  some: (n, s) =>
    `${plural(n, 'item')} waiting for review more than 24 hours; the oldest item waiting to go live ${s.oldestStagedHours === null ? 'has no recorded time' : `is ${s.oldestStagedHours ?? 0} h old`}.`,
});

export const checkOrphanedImages = countCheck((s) => s.orphanedGeneratedImages, {
  zero: 'Every generated image belongs to a content document that exists.',
  some: (n) => `${plural(n, 'generated image')} point at content that no longer exists.`,
});

export function checkStorage(snapshot) {
  const storage = snapshot?.storage;
  if (!storage) return result('unknown', 'This snapshot carries no storage figures.');
  const floor = storage.bounded ? 'at least ' : '';
  return result(
    'healthy',
    `${floor}${plural(storage.generatedImages ?? 0, 'generated image row')} in Cosmos.`,
    { detail: 'Blob byte counts are not read here: there is no cheap count route.' }
  );
}

export function checkLinkRot(snapshot) {
  const rot = snapshot?.digest?.linkRot;
  if (!rot) {
    return result('unknown', 'The weekly link check has not written a result to this digest yet.');
  }
  if ((rot.broken ?? 0) === 0) {
    return result('healthy', `All ${rot.checked ?? 0} live links answered on the last weekly check.`);
  }
  const sample = (rot.sampleBroken ?? []).slice(0, 5).map((row) => `${row.url} (${row.status})`);
  return result('degraded', `${rot.broken} of ${rot.checked} live links are broken.`, {
    ...(sample.length ? { detail: sample.join('\n') } : {}),
  });
}

export function checkForge(snapshot, now) {
  const forge = snapshot?.forge;
  if (!forge) return result('unknown', 'This snapshot carries no forge statistics.');
  if (!forge.updatedAt) return result('unknown', 'The scheduled forge has never recorded a run.');
  return result(
    'healthy',
    `${plural(forge.forgedToday ?? 0, 'item')} forged on ${forge.todayDate ?? 'today'}; last activity ${ago(forge.updatedAt, now) ?? 'at an unknown time'}.`
  );
}

export function checkTelegramNotify(snapshot, now) {
  const state = snapshot?.telegramNotifyState;
  if (!state) return result('unknown', 'This snapshot carries no Telegram notify state.');
  const sources = Object.entries(state)
    .filter(([key, value]) => key !== 'id' && key !== 'lastCheckedAt' && value?.lastNotifiedAt)
    .sort((a, b) => toMillis(b[1].lastNotifiedAt) - toMillis(a[1].lastNotifiedAt));
  if (sources.length === 0) return result('unknown', 'No Telegram notice has been recorded as sent yet.');
  const [[source, { lastNotifiedAt }]] = sources;
  return result(
    'healthy',
    `Last notice ${ago(lastNotifiedAt, now) ?? 'at an unknown time'} (${source}); ${plural(sources.length, 'source')} have notified.`
  );
}

/** Every check the snapshot answers, by the probe id it records. */
export const SNAPSHOT_CHECKS = Object.freeze({
  cosmos: checkCosmos,
  'runtime-config': checkRuntimeConfig,
  'unresolved-secrets': checkUnresolvedSecrets,
  storage: checkStorage,
  'scheduled-publishing': checkScheduledPublishing,
  'publishing-failures': checkPublishingFailures,
  'queue-sla': checkQueueSla,
  'orphaned-images': checkOrphanedImages,
  'link-rot': checkLinkRot,
  forge: checkForge,
  'telegram-notify': checkTelegramNotify,
  'content-agent': checkContentAgent,
  'nightly-export': checkNightlyExport,
});

