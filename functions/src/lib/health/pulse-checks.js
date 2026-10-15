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
import { isAgentOnline } from '../labs.js';
import { storedFailure } from '../http/error-response.js';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** The scheduled publisher's cadence: `publishScheduledContent` runs every fifteen minutes. */
export const PUBLISHER_INTERVAL_MS = 15 * MINUTE_MS;
/** Three missed runs, the heartbeat rule (status-model.js MISSED_BEATS). */
export const PUBLISHER_LATE_AFTER_MS = 3 * PUBLISHER_INTERVAL_MS;
/** The weekly AI probe, plus a day: a recorded test older than this is stale. */
export const AI_TEST_STALE_AFTER_MS = 8 * DAY_MS;

const result = (status, summary, extra = {}) => ({ status, summary, ...extra });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Epoch ms of an ISO string, a Date or a Firestore-shaped time; NaN otherwise. */
export function toMillis(value) {
  if (!value) return Number.NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (typeof value === 'object' && typeof value.seconds === 'number') return value.seconds * 1000;
  return Date.parse(String(value));
}

/** "just now", "12 min ago", "3 h ago", "2 d ago" (frontend/src/lib/status.js describeAge). */
export function ago(value, now) {
  const then = toMillis(value);
  if (!Number.isFinite(then)) return null;
  const minutes = Math.round(Math.max(0, now - then) / MINUTE_MS);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

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

export function checkRuntimeConfig(snapshot) {
  const readiness = snapshot?.readiness;
  if (!readiness) return result('unknown', 'This snapshot carries no readiness block.');
  const unresolved = Array.isArray(readiness.unresolvedSecrets) ? readiness.unresolvedSecrets : [];
  if (readiness.configGeneration === 'unset') {
    return result(
      'critical',
      'The runtime configuration stamp never reached this worker, so its app settings may be stale.'
    );
  }
  if (unresolved.length > 0) {
    return result(
      'critical',
      `${plural(unresolved.length, 'Key Vault reference')} did not resolve: ${unresolved.join(', ')}.`,
      { detail: `Generation ${readiness.configGeneration} by ${readiness.configWriter}.` }
    );
  }
  return result(
    'healthy',
    `Configuration generation ${readiness.configGeneration ?? 'unknown'} (${readiness.configWriter ?? 'unknown writer'}); every Key Vault reference resolved.`
  );
}

export function checkUnresolvedSecrets(snapshot) {
  const names = snapshot?.readiness?.unresolvedSecrets;
  if (!Array.isArray(names)) return result('unknown', 'This snapshot carries no Key Vault count.');
  if (names.length === 0) {
    return result('healthy', 'Every Key Vault reference resolved on the answering worker.');
  }
  return result(
    'critical',
    `${plural(names.length, 'Key Vault reference')} did not resolve: ${names.join(', ')}.`
  );
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
    `${plural(n, 'item')} waiting more than 24 hours; the oldest staged item is ${s.oldestStagedHours ?? 0} h old.`,
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
});

// ── From the registries ──────────────────────────────────────────────────────

const latestOf = (values) =>
  values.filter((value) => Number.isFinite(toMillis(value))).sort((a, b) => toMillis(a) - toMillis(b)).at(-1);

/**
 * Lab agents by their heartbeat: online while the last beat is under 90 s old
 * and it did not announce a shutdown, and the agent is not deactivated
 * (labs.js isAgentOnline, the rule the Labs page and the public door use).
 * `agents` are `{ lastSeenAt, online }` — the pulse computes `online` from
 * `lastSeenAt`; the page reads it from getLabsSnapshot, which does the same.
 */
export function labAgentsVerdict(agents, now) {
  if (agents.length === 0) return result('unknown', 'No lab agent has registered yet.');
  const online = agents.filter((agent) => agent.online).length;
  const latest = latestOf(agents.map((agent) => agent.lastSeenAt));
  const seen = latest ? ` Last heartbeat ${ago(latest, now) ?? 'at an unknown time'}.` : '';
  if (online === agents.length) return result('healthy', `${plural(agents.length, 'agent')} online.${seen}`);
  if (online === 0) return result('offline', `All ${agents.length} agents are offline.${seen}`);
  return result('degraded', `${online} of ${agents.length} agents online.${seen}`);
}

/** lab_agents rows as the verdict reads them. */
export const labAgentsFromRows = (rows, now) =>
  (rows || []).map((row) => ({
    lastSeenAt: row.lastSeenAt ?? null,
    // The whole row: the rule reads status and active as well as lastSeenAt
    // (#1009, #1018), so a stopping or deactivated agent is not online.
    online: isAgentOnline(row, now),
  }));

const mcpLine = (server) => {
  const name = server.id ?? server.name ?? 'server';
  if (server.status === 'connected') return `${name}: connected`;
  if (server.status === 'error') return `${name}: ${server.lastError || 'failed'}`;
  return `${name}: not synced yet`;
};

/**
 * MCP servers by their last tool sync (lib/ai/mcp.js writes `status`,
 * `lastTested` and `lastError` on every sync). Only servers switched on count:
 * the MCP route refuses a disabled one before it is ever called.
 */
export function mcpServersVerdict(servers, now) {
  const enabled = (servers || []).filter((server) => server?.enabled === true);
  if (enabled.length === 0) return result('unknown', 'No MCP server is enabled on the AI Engine page.');
  const ok = enabled.filter((server) => server.status === 'connected');
  const failing = enabled.filter((server) => server.status === 'error');
  const latest = latestOf(enabled.map((server) => server.lastTested));
  const when = latest ? ` Newest sync ${ago(latest, now) ?? 'at an unknown time'}.` : '';
  const detail = enabled.map(mcpLine).join('\n');
  if (ok.length === enabled.length) {
    return result('healthy', `${plural(ok.length, 'enabled MCP server')} answered their last tool sync.${when}`, {
      detail,
    });
  }
  if (ok.length === 0 && failing.length === 0) {
    return result('unknown', `${plural(enabled.length, 'enabled MCP server')}, none synced yet.`, { detail });
  }
  if (ok.length === 0) {
    return result(
      classifyFailure(failing[0].lastError),
      `None of the ${enabled.length} enabled MCP servers answered its last tool sync.${when}`,
      { detail }
    );
  }
  return result(
    'degraded',
    `${ok.length} of ${enabled.length} enabled MCP servers answered their last tool sync.${when}`,
    { detail }
  );
}

const aiLine = (provider) =>
  provider.status === 'connected'
    ? `${provider.id}: connected${Number.isFinite(provider.latencyMs) ? ` in ${provider.latencyMs} ms` : ''}`
    : `${provider.id}: ${provider.lastTestError || (provider.lastTested ? 'failed' : 'not tested yet')}`;

/**
 * AI providers by their last RECORDED test — the AI Engine's Test button or
 * the weekly probe, both of which write `status` and `lastTested` onto the
 * provider document. The pulse spends no model call: asking every provider a
 * word every five minutes is the browser Test's job, on demand. A newest test
 * older than the weekly probe plus a day is stale, and said to be.
 */
export function aiProvidersVerdict(providers, now) {
  const enabled = (providers || []).filter((provider) => provider?.enabled !== false);
  if (enabled.length === 0) return result('critical', 'No AI provider is enabled on the AI Engine page.');
  const latest = latestOf(enabled.map((provider) => provider.lastTested));
  if (!latest) {
    return result(
      'unknown',
      `${plural(enabled.length, 'enabled provider')}, none with a recorded test yet. The AI Engine's Test, or the weekly probe, records one.`
    );
  }
  const newest = enabled.find((provider) => provider.lastTested === latest);
  const by = newest?.lastTestedBy === 'probe' ? 'the weekly probe' : 'a Test button';
  const note = ` Newest recorded test: ${newest?.id ?? 'a provider'} ${ago(latest, now)} by ${by}.`;
  const detail = enabled.map(aiLine).join('\n');
  if (now - toMillis(latest) > AI_TEST_STALE_AFTER_MS) {
    return result('unknown', `No provider has been tested for over eight days.${note}`, { detail });
  }
  const ok = enabled.filter((provider) => provider.status === 'connected').length;
  if (ok === enabled.length) {
    return result('healthy', `${plural(ok, 'enabled provider')} passed their last recorded test.${note}`, {
      detail,
    });
  }
  if (ok === 0) {
    const firstError = enabled.find((provider) => provider.lastTestError)?.lastTestError;
    return result(
      classifyFailure(firstError),
      `None of the ${enabled.length} enabled providers passed their last recorded test.${note}`,
      { detail }
    );
  }
  return result(
    'degraded',
    `${ok} of ${enabled.length} enabled providers passed their last recorded test.${note}`,
    { detail }
  );
}
