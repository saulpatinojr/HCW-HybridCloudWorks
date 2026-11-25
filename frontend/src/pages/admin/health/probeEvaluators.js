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
import {
  agoOf,
  contentAgentVerdict,
  nightlyExportVerdict,
  scheduledPublishingVerdict,
} from './digestVerdicts';
import { classifyFailure, notRun, plural, result, snapshotMissing, stamp } from './probeKit';

// The digest verdicts and their thresholds, for the callers that read them from here.
export {
  contentAgentVerdict,
  EXPORT_STALE_AFTER_MS,
  nightlyExportVerdict,
  PUBLISHER_INTERVAL_MS,
  PUBLISHER_LATE_AFTER_MS,
  scheduledPublishingVerdict,
} from './digestVerdicts';

// ── Snapshot evaluators ──────────────────────────────────────────────────────

export function evaluateCosmos(ctx) {
  if (ctx?.ops?.loaded && ctx.snapshot) {
    return result('healthy', 'Cosmos DB answered the ten-query ops snapshot.', {
      checkedAt: ctx.snapshot.lastCheckedAt ?? ctx.snapshot.generatedAt ?? stamp(),
    });
  }
  return snapshotMissing(ctx);
}

/**
 * The unresolved names split into on-purpose and not (#1512), the same as the
 * pulse's unresolvedSplit. A snapshot from before the split carries only
 * `unresolvedSecrets`; every name in it then counts as unexpected.
 */
export function unresolvedSplit(readiness) {
  const all = Array.isArray(readiness?.unresolvedSecrets) ? readiness.unresolvedSecrets : [];
  if (!Array.isArray(readiness?.unexpectedUnresolved)) return { expected: [], unexpected: all };
  const expected = (
    Array.isArray(readiness.expectedUnresolved) ? readiness.expectedUnresolved : []
  ).map((entry) => (typeof entry === 'string' ? entry : entry?.name));
  return { expected: expected.filter(Boolean), unexpected: readiness.unexpectedUnresolved };
}

/** "3 Key Vault references are unresolved on purpose, waiting on the owner: A, B, C" */
export function expectedPhrase(names) {
  return `${plural(names.length, 'Key Vault reference')} ${names.length === 1 ? 'is' : 'are'} unresolved on purpose, waiting on the owner: ${names.join(', ')}`;
}

/** " 2 more are unresolved on purpose." after a Critical sentence, or nothing. */
export const alsoExpected = (names) =>
  names.length
    ? ` ${names.length} more ${names.length === 1 ? 'is' : 'are'} unresolved on purpose.`
    : '';

export function evaluateRuntimeConfig(ctx) {
  const readiness = ctx?.snapshot?.readiness;
  if (!readiness) return snapshotMissing(ctx);
  const { expected, unexpected } = unresolvedSplit(readiness);
  const checkedAt = readiness.lastCheckedAt ?? stamp();
  if (readiness.configGeneration === 'unset') {
    return result(
      'critical',
      'The runtime configuration stamp never reached this worker, so its app settings may be stale.',
      { checkedAt }
    );
  }
  if (unexpected.length > 0) {
    return result(
      'critical',
      `${plural(unexpected.length, 'Key Vault reference')} did not resolve: ${unexpected.join(', ')}.${alsoExpected(expected)}`,
      {
        checkedAt,
        detail: `Generation ${readiness.configGeneration} by ${readiness.configWriter}.`,
      }
    );
  }
  const generation = `Configuration generation ${readiness.configGeneration ?? 'unknown'} (${readiness.configWriter ?? 'unknown writer'})`;
  if (expected.length > 0) {
    return result(
      'healthy',
      `${generation}; ${expectedPhrase(expected)}; every other one resolved.`,
      { checkedAt }
    );
  }
  return result('healthy', `${generation}; every Key Vault reference resolved.`, { checkedAt });
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
    `${plural(n, 'item')} waiting for review more than 24 hours; the oldest item waiting to go live ${s.oldestStagedHours === null ? 'has no recorded time' : `is ${s.oldestStagedHours ?? 0} h old`}.`,
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

export function evaluateContentAgent(ctx, now = Date.now()) {
  const agent = ctx?.snapshot?.agent;
  if (!agent) return blockMissing(ctx, 'This snapshot carries no content-agent block.');
  return contentAgentVerdict(agent, now);
}

export function evaluateNightlyExport(ctx, now = Date.now()) {
  const backups = ctx?.snapshot?.backups;
  if (!backups) return blockMissing(ctx, 'This snapshot carries no backups block.');
  return nightlyExportVerdict(backups, now);
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
