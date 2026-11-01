/**
 * The pure evaluators behind the snapshot and session probes (ADR 0033 §1
 * Platform, §8). Each takes the page's context — the ops-health snapshot, the
 * identity check, the Labs probes, the smoke-test runs — and returns one
 * result in lib/status.js's vocabulary. No request is made here; that is
 * probeRunners.js.
 *
 * The snapshot evaluators have a twin on the server: the health pulse judges
 * the same snapshot every five minutes (functions/src/lib/health/
 * pulse-checks.js) and records its result under the same probe id.
 * statusParity.test.js runs both on the same snapshots and fails on any
 * difference in status or sentence, so a card never flips between two
 * opinions as the page and the pulse take turns.
 *
 * Every result carries the time its evidence was read (`checkedAt`): the
 * snapshot's, or the session check's own run. A check that has not run says
 * so with no time (`notRun`), so a stored result from an earlier run shows
 * instead.
 */
import {
  evaluateIdentity,
  evaluateLabsProbe,
  evaluateUnauthenticatedProbe,
  verdictStatus,
} from './probes';
import { toMillis } from '@/lib/dateUtils';
import { ago, classifyFailure, notRun, plural, result, snapshotMissing, stamp } from './probeKit';

/** The scheduled publisher's cadence: `publishScheduledContent` runs every fifteen minutes. */
export const PUBLISHER_INTERVAL_MS = 15 * 60 * 1000;
/** Three missed runs (lib/status.js MISSED_BEATS): the scheduler has stopped. */
export const PUBLISHER_LATE_AFTER_MS = 3 * PUBLISHER_INTERVAL_MS;

/** `ago` for any shape of time a digest has held (`toMillis` answers 0 for none). */
const agoOf = (value, now = Date.now()) => {
  const ms = toMillis(value);
  return ms > 0 ? ago(new Date(ms).toISOString(), now) : null;
};

// ── Snapshot evaluators ──────────────────────────────────────────────────────

export function evaluateCosmos(ctx) {
  if (ctx?.ops?.loaded && ctx.snapshot) {
    return result('healthy', 'Cosmos DB answered the ten-query ops snapshot.', {
      checkedAt: ctx.snapshot.lastCheckedAt ?? ctx.snapshot.generatedAt ?? stamp(),
    });
  }
  return snapshotMissing(ctx);
}

export function evaluateRuntimeConfig(ctx) {
  const readiness = ctx?.snapshot?.readiness;
  if (!readiness) return snapshotMissing(ctx);
  const unresolved = Array.isArray(readiness.unresolvedSecrets) ? readiness.unresolvedSecrets : [];
  const checkedAt = readiness.lastCheckedAt ?? stamp();
  if (readiness.configGeneration === 'unset') {
    return result(
      'critical',
      'The runtime configuration stamp never reached this worker, so its app settings may be stale.',
      { checkedAt }
    );
  }
  if (unresolved.length > 0) {
    return result(
      'critical',
      `${plural(unresolved.length, 'Key Vault reference')} did not resolve: ${unresolved.join(', ')}.`,
      {
        checkedAt,
        detail: `Generation ${readiness.configGeneration} by ${readiness.configWriter}.`,
      }
    );
  }
  return result(
    'healthy',
    `Configuration generation ${readiness.configGeneration ?? 'unknown'} (${readiness.configWriter ?? 'unknown writer'}); every Key Vault reference resolved.`,
    { checkedAt }
  );
}

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

export function evaluateScheduledPublishing(ctx, now = Date.now()) {
  if (!ctx?.snapshot?.readiness) return snapshotMissing(ctx);
  const { digest } = ctx.snapshot;
  const checkedAt = digest?.lastCheckedAt ?? ctx.snapshot.lastCheckedAt ?? stamp();
  return scheduledPublishingVerdict(digest, checkedAt, now);
}

/** A snapshot block that may be absent on an older snapshot: unknown then, not missing. */
const blockMissing = (ctx, note) =>
  ctx?.snapshot?.readiness ? result('unknown', note) : snapshotMissing(ctx);

const countProbe =
  (pick, { zero, some, badStatus = 'degraded' }) =>
  (ctx) => {
    const signals = ctx?.snapshot?.operationalSignals;
    if (!signals) return blockMissing(ctx, 'This snapshot carries no operational signals.');
    const count = Number(pick(signals)) || 0;
    const checkedAt = signals.lastCheckedAt ?? stamp();
    return count === 0
      ? result('healthy', zero, { checkedAt })
      : result(badStatus, some(count, signals), { checkedAt });
  };

export const evaluatePublishingFailures = countProbe((s) => s.publishFailureCount, {
  zero: 'No open publish-failure alerts.',
  some: (n) => `${plural(n, 'open publish-failure alert')}.`,
});

export const evaluateQueueSla = countProbe((s) => s.queueBreachCount, {
  zero: 'Nothing has waited in the review queue for more than 24 hours.',
  some: (n, s) =>
    `${plural(n, 'item')} waiting more than 24 hours; the oldest staged item is ${s.oldestStagedHours ?? 0} h old.`,
});

export const evaluateOrphanedImages = countProbe((s) => s.orphanedGeneratedImages, {
  zero: 'Every generated image belongs to a content document that exists.',
  some: (n) => `${plural(n, 'generated image')} point at content that no longer exists.`,
});

export function evaluateStorage(ctx) {
  const storage = ctx?.snapshot?.storage;
  if (!storage) return blockMissing(ctx, 'This snapshot carries no storage figures.');
  const floor = storage.bounded ? 'at least ' : '';
  return result(
    'healthy',
    `${floor}${plural(storage.generatedImages ?? 0, 'generated image row')} in Cosmos.`,
    {
      checkedAt: storage.lastCheckedAt ?? stamp(),
      detail: 'Blob byte counts are not read here: there is no cheap count route.',
    }
  );
}

export function evaluateLinkRot(ctx) {
  if (!ctx?.snapshot?.readiness) return snapshotMissing(ctx);
  const rot = ctx.snapshot.digest?.linkRot;
  if (!rot)
    return result('unknown', 'The weekly link check has not written a result to this digest yet.');
  const checkedAt = rot.lastRunAt ?? ctx.snapshot.digest?.lastCheckedAt ?? stamp();
  if ((rot.broken ?? 0) === 0) {
    return result(
      'healthy',
      `All ${rot.checked ?? 0} live links answered on the last weekly check.`,
      { checkedAt }
    );
  }
  const sample = (rot.sampleBroken ?? []).slice(0, 5).map((row) => `${row.url} (${row.status})`);
  return result('degraded', `${rot.broken} of ${rot.checked} live links are broken.`, {
    checkedAt,
    detail: sample.length ? sample.join('\n') : undefined,
  });
}

export function evaluateForge(ctx, now = Date.now()) {
  const forge = ctx?.snapshot?.forge;
  if (!forge) return blockMissing(ctx, 'This snapshot carries no forge statistics.');
  if (!forge.updatedAt) return result('unknown', 'The scheduled forge has never recorded a run.');
  return result(
    'healthy',
    `${plural(forge.forgedToday ?? 0, 'item')} forged on ${forge.todayDate ?? 'today'}; last activity ${agoOf(forge.updatedAt, now) ?? 'at an unknown time'}.`,
    {
      checkedAt: forge.lastCheckedAt ?? stamp(),
    }
  );
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

export function evaluateContentAgent(ctx, now = Date.now()) {
  const agent = ctx?.snapshot?.agent;
  if (!agent) return blockMissing(ctx, 'This snapshot carries no content-agent block.');
  return contentAgentVerdict(agent, now);
}

export function evaluateTelegramNotify(ctx, now = Date.now()) {
  const state = ctx?.snapshot?.telegramNotifyState;
  if (!state) return blockMissing(ctx, 'This snapshot carries no Telegram notify state.');
  const sources = Object.entries(state)
    .filter(([key, value]) => key !== 'id' && key !== 'lastCheckedAt' && value?.lastNotifiedAt)
    .sort((a, b) => toMillis(b[1].lastNotifiedAt) - toMillis(a[1].lastNotifiedAt));
  const checkedAt = state.lastCheckedAt ?? stamp();
  if (sources.length === 0) {
    return result('unknown', 'No Telegram notice has been recorded as sent yet.', { checkedAt });
  }
  const [[source, { lastNotifiedAt }]] = sources;
  return result(
    'healthy',
    `Last notice ${agoOf(lastNotifiedAt, now) ?? 'at an unknown time'} (${source}); ${plural(sources.length, 'source')} have notified.`,
    {
      checkedAt,
    }
  );
}

// ── Session evaluators ───────────────────────────────────────────────────────

export function evaluateIdentitySession(ctx) {
  if (!ctx?.identity) return notRun('Reading the session…');
  const verdict = evaluateIdentity(ctx.identity.token, ctx.identity.admin);
  return result(verdictStatus(verdict.pass), verdict.reason, {
    checkedAt: ctx.identity.checkedAt ?? null,
    durationMs: ctx.identity.durationMs,
  });
}

export function evaluateRegistrySession(ctx) {
  if (!ctx?.identity) return notRun('Reading the session…');
  const { admin, adminError, adminHttp } = ctx.identity;
  const checkedAt = ctx.identity.checkedAt ?? null;
  if (!admin) {
    const message = adminError || 'getCurrentAdminStatus did not answer.';
    return result(classifyFailure(message), message, { checkedAt });
  }
  if (!admin.isAdmin)
    return result(
      'critical',
      `HTTP ${adminHttp}: the registry does not list this principal as an admin.`,
      { checkedAt }
    );
  if (admin.uidMatchesToken === false)
    return result('critical', 'The registry row is keyed on a different principal.', {
      checkedAt,
    });
  return result(
    'healthy',
    `HTTP ${adminHttp}: admin, role ${admin.role ?? 'unset'}, ${admin.active ? 'active' : 'inactive'}.`,
    { checkedAt }
  );
}

export function evaluateLabsSession(ctx) {
  if (!ctx?.labs) return notRun('Not run in this session.');
  const verdict = evaluateLabsProbe(ctx.labs);
  return result(verdictStatus(verdict.pass), verdict.reason, {
    checkedAt: ctx.labs.checkedAt ?? null,
    durationMs: ctx.labs.durationMs,
  });
}

export function evaluateUnauthSession(ctx) {
  if (!ctx?.unauth) return notRun('Not run in this session.');
  const verdict = evaluateUnauthenticatedProbe(ctx.unauth);
  return result(verdictStatus(verdict.pass), verdict.reason, {
    checkedAt: ctx.unauth.checkedAt ?? null,
    durationMs: ctx.unauth.durationMs,
  });
}

/** A smoke test's last run in this session, or the idle line when it has not run. */
export const smokeEvaluator = (actionId, idle) => (ctx) => {
  const run = ctx?.smoke?.lastRuns?.[actionId];
  if (!run) return notRun(idle);
  return result(run.ok ? 'healthy' : classifyFailure(run.message), run.message, {
    checkedAt: run.at,
  });
};
