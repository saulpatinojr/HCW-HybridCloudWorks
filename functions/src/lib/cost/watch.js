/**
 * cost/watch.js — keeps the cost snapshot fresh and tells the owner on
 * Telegram when a cost signal turns warning or critical (ADR 0039).
 *
 * WHY THIS RUNS FROM checkAgentHealth AND NOT ITS OWN TIMER. The same reason
 * the delivery monitor watch does (timers/delivery-monitor-watch.js): a new
 * timer is off until the owner adds it to `enabled_timers`, while
 * checkAgentHealth is armed, runs every five minutes and already holds the
 * notifier. `checkIfDue` is cheap when nothing is due: one point read of the
 * snapshot.
 *
 * WHAT IT DOES, each time it is due
 *   1. Rebuilds the snapshot (snapshot.js refreshSnapshot) when the last read
 *      is older than the page's `refreshHours` setting (6 by default: Azure's
 *      cost data moves a few times a day, so hourly reads would mostly repeat
 *      themselves and spend Cost Management's rate limit for nothing).
 *   2. Works out the signals (signals.js) and sends ONE Telegram message for
 *      every warning or critical signal the owner has not been told about,
 *      recording its id and the time in the snapshot's `notified`. A signal
 *      that stops being true is forgotten, so it is told again if it comes
 *      back. Nothing is said about info signals.
 *   3. On the first run of a new month, when `monthlyDigest` is on, sends
 *      last month's closing figures (Azure, AI, subscriptions) once, and
 *      records the month in `digestSentFor`.
 *
 * The messages are built here from numbers and the owner's own labels; no
 * text from Azure or ElevenLabs is repeated into them (#945). A send that did
 * not go is not recorded, so the next due run tries again; the notifier's own
 * per-source cooldown stops two instances from double-sending.
 */
import { readLedger } from './ledger-store.js';
import { CURRENCY, monthOf, previousMonthOf } from './model.js';
import { buildSummary, changeSnapshot, readSnapshot, refreshSnapshot } from './snapshot.js';
import { notable } from './signals.js';

const HOUR_MS = 60 * 60 * 1000;
/** Signals are re-checked this often even when no refresh is due; the ledger's renewals move daily. */
export const SIGNAL_CHECK_INTERVAL_MS = 55 * 60 * 1000;

/** The notifier source every message here carries. */
export const COST_SOURCE = 'cost_watch';

const usd = (value) =>
  value !== null && value !== undefined && Number.isFinite(Number(value))
    ? `${CURRENCY} ${Number(value).toFixed(2)}`
    : 'not read';

/** The month's closing figures as a Telegram message body. */
export function digestMessage(month, figures) {
  return [
    `Azure (both subscriptions): ${usd(figures?.azureMonthToDate)}`,
    `AI usage (site estimate): ${usd(figures?.aiCostUsd)}`,
    `Subscriptions outside Azure (ledger): ${usd(figures?.servicesMonthly)} a month`,
    '',
    `Azure's figure can still move until the invoice closes. Details: /admin/cost`,
  ].join('\n');
}

/**
 * @param {object} deps
 * @param {object} deps.store readDoc, createDoc, replaceDocIfMatch, queryDocs
 * @param {{ notifyTelegram: Function }|null} [deps.notifier]
 * @param {() => Date} [deps.now]
 * @param {object} [deps.log]
 * @param {Function} [deps.refresh] test seam for refreshSnapshot
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {Function} [deps.fetchImpl]
 */
export function createCostWatch({
  store,
  notifier = null,
  now = () => new Date(),
  log = {},
  refresh = refreshSnapshot,
  env = process.env,
  fetchImpl = globalThis.fetch,
}) {
  const say = async (title, message, severity) => {
    if (!notifier) return false;
    const outcome = await notifier.notifyTelegram({ title, message, severity, source: COST_SOURCE });
    return outcome?.sent === true;
  };

  /**
   * Run when due. Returns `{ checked, refreshed, told, digest }`; never
   * throws (checkAgentHealth's other work must finish whatever happens here).
   */
  async function checkIfDue() {
    try {
      const at = now();
      const atMs = at.getTime();
      let snapshot = await readSnapshot(store);
      const ledger = await readLedger(store);
      const refreshDueMs = (Number(ledger.settings.refreshHours) || 6) * HOUR_MS;
      const lastRead = Date.parse(snapshot?.readAt || '');
      const lastCheck = Date.parse(snapshot?.lastSignalCheckAt || '');
      const refreshDue = !Number.isFinite(lastRead) || atMs - lastRead >= refreshDueMs;
      const checkDue = !Number.isFinite(lastCheck) || atMs - lastCheck >= SIGNAL_CHECK_INTERVAL_MS;
      if (!refreshDue && !checkDue) return { checked: false, reason: 'not due' };

      let refreshed = false;
      if (refreshDue) {
        try {
          snapshot = await refresh({ store, ledger, now, env, fetchImpl });
          refreshed = true;
        } catch (error) {
          log.warn?.(`[costWatch] the snapshot could not be refreshed (${error?.code ?? 'error'})`);
        }
      }

      const summary = buildSummary({ snapshot, ledger, now: at });
      const wanted = notable(summary.signals);
      const known = snapshot?.notified ?? {};
      const told = [];
      if (ledger.settings.telegram) {
        for (const sig of wanted) {
          if (known[sig.id]) continue;
          const sent = await say(sig.title, `${sig.detail}\n\n${sig.href}`, sig.severity);
          if (sent) told.push(sig.id);
        }
      }

      let digest = null;
      const month = monthOf(at);
      const lastMonth = previousMonthOf(month);
      const closing = snapshot?.months?.[lastMonth];
      if (ledger.settings.monthlyDigest && closing && snapshot?.digestSentFor !== lastMonth) {
        const sent = await say(`Costs for ${lastMonth} (closing figures)`, digestMessage(lastMonth, closing), 'info');
        if (sent) digest = lastMonth;
      }

      await changeSnapshot(store, (stored) => {
        const base = stored ?? { readAt: null, azure: null, ai: null, sources: [], months: {} };
        const keep = new Set(wanted.map((sig) => sig.id));
        const notified = Object.fromEntries(
          Object.entries(base.notified ?? {}).filter(([id]) => keep.has(id))
        );
        for (const id of told) notified[id] = at.toISOString();
        return {
          ...base,
          notified,
          lastSignalCheckAt: at.toISOString(),
          digestSentFor: digest ?? base.digestSentFor ?? null,
        };
      });

      return { checked: true, refreshed, told: told.length, digest };
    } catch (error) {
      log.warn?.(`[costWatch] failed (${error?.code ?? 'error'})`);
      return { checked: false, reason: 'failed' };
    }
  }

  return { checkIfDue };
}
