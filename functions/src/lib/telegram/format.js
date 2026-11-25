/**
 * telegram/format.js — how the Telegram bot (bot.js) words its read-only
 * answers: the ops status, the digest and the AI readiness. bot.js exports
 * these again; formatAlerts stays in bot.js.
 */

/** "1 hour" / "3 hours" — upstream's countNoun, kept so replies read the same. */
export function countNoun(count, singular, pluralWord) {
  const n = Number(count) || 0;
  const plural = pluralWord || `${singular}s`;
  return `${n} ${n === 1 ? singular : plural}`;
}

/** The /queue line about items waiting to go live (#1516). */
export function stagedLine(oldestStaged, waiting) {
  if (oldestStaged === null && waiting > 0) {
    return `${countNoun(waiting, 'item is', 'items are')} waiting to go live, with no recorded time to age ${waiting === 1 ? 'it' : 'them'} by.`;
  }
  if ((oldestStaged ?? 0) > 0) {
    return `The oldest item staged for publishing has been sitting for about ${countNoun(oldestStaged, 'hour')}.`;
  }
  return 'Nothing is currently stuck in staging.';
}

export function formatOpsStatus(snapshot = {}) {
  const r = snapshot.readiness || {};
  const s = snapshot.operationalSignals || {};
  return [
    `Published: ${r.publishedCount ?? 0}`,
    `Needs review: ${r.needsReviewCount ?? 0}`,
    `Staged: ${r.stagedCount ?? 0}`,
    `RSS cached: ${r.rssCount ?? 0}`,
    `Open alerts: ${(snapshot.alerts || []).length}`,
    `Publish failures: ${s.publishFailureCount ?? 0}`,
    s.lastSchedulerSuccessAt
      ? `Last scheduler success: ${s.lastSchedulerSuccessAt}`
      : 'Last scheduler success: none recorded',
  ].join('\n');
}

export function formatDigest(digest) {
  if (!digest) return 'No digest has been generated yet.';
  const ops = digest.publishingOps || {};
  return [
    `Digest ${digest.id || ''}`.trim(),
    `Publishing ops: ${ops.status || 'unknown'}`,
    ops.lastRunAt ? `Last run: ${ops.lastRunAt}` : null,
    digest.summary ? `\n${digest.summary}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatAiReadiness(readiness = {}) {
  const providers = readiness.providers || {};
  const lines = Object.entries(providers).map(
    ([name, state]) => `• ${name}: ${state?.configured ? 'configured' : 'not configured'}`
  );
  if (!lines.length) return 'No AI provider state is reported in the current snapshot.';
  return ['AI stack readiness:', ...lines].join('\n');
}
