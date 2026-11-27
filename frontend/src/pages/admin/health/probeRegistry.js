/**
 * The Health Hub's probe registry — one entry per hub dependency, so "is
 * every part of the platform working?" is answered by one list rather than by
 * knowing which page happens to carry a test (ADR 0033 §1 Platform, §8).
 *
 * Every entry is `{ id, label, hub, covers, impact, action, href, kind, safe }`
 * plus the function that answers it (and, optionally, `freshForMs`: how long
 * its result stays evidence, when that is shorter than its kind's window),
 * and every answer is one shape:
 *
 *   { status, summary, detail?, checkedAt, checkedBy? }
 *
 * where `status` is lib/status.js's vocabulary — healthy / degraded /
 * critical / offline / unknown — so a probe here reads like a card on the
 * Integrations page and a row on the Overview tab.
 *
 * Every id here has an entry in the server's closed catalogue
 * (functions/src/lib/health/probe-catalogue.js), which decides who may record
 * its result; statusParity.test.js fails when the two lists drift.
 *
 * Three kinds, by where the answer comes from:
 *
 *   live      `run(ctx)` makes a request and returns a result. These are the
 *             tests the Integrations page already had (SERVICES[].test, run
 *             by the same function so the two pages cannot disagree), plus
 *             reads of routes other hubs expose: the AI providers list and
 *             testAiProvider, the labs snapshot, the newsletter issues, the
 *             public content list for cover images, /api/health.
 *   snapshot  `evaluate(ctx)` reads the ops-health snapshot the page already
 *             holds. Its "Test" is a re-read of the snapshot, so Test all
 *             refreshes it once and evaluates every snapshot probe from it.
 *   session   `evaluate(ctx)` reads a check the page runs with the session's
 *             own token (identity, the Labs no-op probe, the smoke tests);
 *             its "Test" is that check's own action.
 *
 * An entry may also carry `docs: { href, label }`, a runbook its card links
 * beside the fix (the Cloudflare rate limit probe links Part 4 of its
 * runbook).
 *
 * `safe` says whether Test all may press it. A probe that writes real data
 * (the smoke tests enqueue jobs and build digests; the Labs probe creates a
 * job) or spends quota (YouTube) is run from its own card only, and its
 * `costNote` says why.
 *
 * The table is written one hub per module under probeGroups/ and joined here;
 * the builders and links are probeKit.js, the pure evaluators
 * probeEvaluators.js and the live runners probeRunners.js. Everything a page
 * or a test needs is re-exported from this module, so the registry still has
 * one address.
 */

import {
  PULSE_INTERVAL_MS,
  applyFreshness,
  describeAge,
  describeWindow,
  freshnessWindow,
  pulseStatus,
  toSystemStatus,
} from '@/lib/status';
import { SERVICES } from '@/components/admin/integrations/serviceRegistry';
import { HUBS, result } from './probeKit';
import { newestResult } from './probeStore';
import { PIPELINE_PROBES } from './probeGroups/pipeline';
import { CREATIVE_PROBES } from './probeGroups/creative';
import { AMPLIFY_PROBES } from './probeGroups/amplify';
import { ENHANCED_PROBES } from './probeGroups/enhanced';
import { SPOTLIGHT_PROBES } from './probeGroups/spotlight';
import { PLATFORM_PROBES } from './probeGroups/platform';

export { HUBS, classifyFailure, result } from './probeKit';
export * from './probeEvaluators';
export * from './probeRunners';

// ── The registry ─────────────────────────────────────────────────────────────

export const PROBES = Object.freeze([
  ...PIPELINE_PROBES,
  ...CREATIVE_PROBES,
  ...AMPLIFY_PROBES,
  ...ENHANCED_PROBES,
  ...SPOTLIGHT_PROBES,
  ...PLATFORM_PROBES,
]);

export const PROBE_IDS = Object.freeze(PROBES.map((probe) => probe.id));

/** Probes grouped by hub, in HUBS order. */
export function probesByHub(probes = PROBES) {
  return Object.entries(HUBS)
    .map(([id, label]) => ({ id, label, probes: probes.filter((probe) => probe.hub === id) }))
    .filter((group) => group.probes.length > 0);
}

/**
 * The result to show for one probe (#1011). Two candidates:
 *
 *   - this page's own: a live result this tab ran, or the evaluation of the
 *     page's state for snapshot and session kinds;
 *   - the stored one: the last result anyone recorded — this browser
 *     earlier, another session, or the server's pulse.
 *
 * The newer by `checkedAt` wins; one that has not run (no time) never hides
 * one that has. The winner is then judged against its freshness window at
 * `now` (lib/status.js): past it, it is unknown and `stale`, keeping its last
 * value and time. Never null — a probe with nothing to say says unknown.
 */
export function resolveProbe(probe, ctx, liveResults = {}, stored = {}, now = Date.now()) {
  const notYet = (summary) => result('unknown', summary, { checkedAt: null });
  const local = probe.kind === 'live' ? (liveResults[probe.id] ?? null) : probe.evaluate(ctx);
  const chosen =
    newestResult(local, stored?.[probe.id]) ??
    notYet(probe.kind === 'live' ? 'Not tested yet.' : 'Not evaluated.');
  return applyFreshness(chosen, freshnessWindow(probe, chosen), now);
}

/** Who a result came from, as a reader says it. */
export const checkedByLabel = (r) => {
  if (r?.checkedBy === 'pulse') return 'the pulse';
  if (r?.stored) return 'an admin';
  return 'this session';
};

/** One status word for a resolved result, saying when a stale result last held. */
function statusWords(r) {
  const { label } = toSystemStatus(r.status);
  if (!r.stale) return label;
  return `${label} (stale: last ${toSystemStatus(r.lastStatus).label}, older than its ${describeWindow(r.windowMs)} window)`;
}

/** The pulse as a report line. */
export function pulseReportLine(pulse, now = Date.now()) {
  const status = toSystemStatus(pulseStatus(pulse, now)).label;
  if (!pulse) return `- Pulse: ${status} — it has never reported.`;
  const every = describeWindow(pulse.intervalMs ?? PULSE_INTERVAL_MS);
  return `- Pulse: ${status} — every ${every}, last beat ${pulse.lastBeatAt} (${describeAge(pulse.lastBeatAt, now)}).`;
}

/** The Markdown lines the Report tab adds for the registry. */
export function probeReportLines(probes, resolve, { pulse, now = Date.now() } = {}) {
  const lines = ['### Probe registry', '', pulseReportLine(pulse, now), ''];
  for (const group of probesByHub(probes)) {
    lines.push(`#### ${group.label}`);
    for (const probe of group.probes) {
      const r = resolve(probe);
      const when = r.checkedAt ? ` (${r.checkedAt}, by ${checkedByLabel(r)})` : '';
      lines.push(`- ${probe.label}: ${statusWords(r)}${when} — ${r.summary}`);
    }
    lines.push('');
  }
  return lines;
}

/** Every testable, safe probe: what Test all runs. */
export const safeProbes = (probes = PROBES) => probes.filter((probe) => probe.safe);

/** The service ids the registry covers, for the registry test. */
export const SERVICE_PROBE_IDS = Object.freeze(
  PROBES.filter((probe) => SERVICES.some((service) => service.id === probe.id)).map(
    (probe) => probe.id
  )
);
