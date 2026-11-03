/**
 * cost/snapshot.js — the one document the Cost page reads, and how it is
 * rebuilt (ADR 0039).
 *
 * The Azure and AI reads are slow (several ARM calls, a Cosmos query over the
 * month, a call to ElevenLabs) and Azure's cost data only changes a few times
 * a day, so the page never reads them live. The hourly watch (watch.js) and
 * the Refresh button rebuild `admin_config/cost_snapshot`:
 *
 *   readAt          when the Azure and AI figures were read
 *   azure, ai       the two sections, as azure.js and ai.js answer them
 *   sources         what was read and whether it worked
 *   months          `{ 'YYYY-MM': { azureMonthToDate, aiCostUsd, servicesMonthly, readAt } }`,
 *                   the latest reading of each month, so a month that has
 *                   closed keeps its last figure as history
 *   notified        `{ [signalId]: ISO }`, the warnings the watch has told the
 *                   owner about (watch.js)
 *   digestSentFor   the `YYYY-MM` whose closing digest went out
 *
 * The services ledger is NOT in the snapshot: it is the owner's own sheet
 * (ledger-store.js) and is read live on every request, so an edit shows at
 * once. `buildSummary` is pure over the stored document, the ledger and the
 * clock, and is what every route answers.
 */
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { createAzureCostReader } from './azure.js';
import { aggregateUsage, readAiCosts } from './ai.js';
import {
  HISTORY_MONTHS,
  CURRENCY,
  isStale,
  money,
  monthOf,
  period as periodOf,
  straightLineForecast,
} from './model.js';
import { presentItem, isStoredItem, summarizeServices } from './services.js';
import { computeSignals } from './signals.js';

export const CONTAINER = 'admin_config';
export const SNAPSHOT_DOC_ID = 'cost_snapshot';
export const SNAPSHOT_DOC_TYPE = 'cost_snapshot';
/** A Refresh asked for sooner than this after the last one is answered from the snapshot. */
export const MIN_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
export const WRITE_ATTEMPTS = 3;

const isWriteConflict = (error) => {
  const status = error?.code ?? error?.statusCode;
  return status === 412 || status === 409;
};

export async function readSnapshot(store) {
  return store.readDoc(CONTAINER, SNAPSHOT_DOC_ID, ADMIN_CONFIG_PARTITION);
}

/**
 * Apply `change(doc)` to the stored snapshot and write it back under the ETag
 * it was read at, retrying on a lost race. `change` returns the next
 * document body (without id and partition fields) or null to write nothing.
 */
export async function changeSnapshot(store, change) {
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
    const stored = await readSnapshot(store);
    const next = change(stored);
    if (!next) return stored;
    const doc = { ...next, id: SNAPSHOT_DOC_ID, configScope: ADMIN_CONFIG_PARTITION, docType: SNAPSHOT_DOC_TYPE };
    try {
      if (stored) {
        await store.replaceDocIfMatch(CONTAINER, { ...doc, _etag: stored._etag }, { partitionKey: ADMIN_CONFIG_PARTITION });
      } else {
        await store.createDoc(CONTAINER, doc);
      }
      return doc;
    } catch (error) {
      if (!isWriteConflict(error) || attempt === WRITE_ATTEMPTS) throw error;
    }
  }
  return null;
}

/** The scope-level estimate: Azure's own forecast when its budget has one, else a straight line. */
export function forecastFor(scope, period) {
  if (!scope || scope.error) return { forecast: null, forecastMethod: null };
  const azureForecast = scope.budget?.forecastSpend;
  if (Number.isFinite(azureForecast) && azureForecast > 0) {
    return { forecast: money(azureForecast), forecastMethod: 'azure' };
  }
  const straight = straightLineForecast(scope.monthToDate, period.daysElapsed, period.daysInMonth);
  return { forecast: straight, forecastMethod: straight === null ? null : 'straight-line' };
}

/** The Azure section as the page shows it: forecasts filled in and the subscription totals added. */
export function presentAzure(azure, period) {
  if (!azure) {
    // Before the first refresh: not a failure, so signals.js raises no warning for it.
    return { available: false, neverRead: true, reason: 'The Azure figures have not been read yet.', scopes: [], totals: null };
  }
  const scopes = (azure.scopes || []).map((scope) => ({ ...scope, ...forecastFor(scope, period) }));
  const subscriptions = scopes.filter((scope) => scope.kind === 'subscription' && !scope.error);
  const sum = (pick) => money(subscriptions.reduce((total, scope) => total + (Number(pick(scope)) || 0), 0));
  const budgets = subscriptions.filter((scope) => scope.budget);
  return {
    available: azure.available === true,
    reason: azure.reason ?? null,
    scopes,
    totals:
      subscriptions.length === 0
        ? null
        : {
            monthToDate: sum((s) => s.monthToDate),
            forecast: sum((s) => s.forecast),
            budget: budgets.length === 0 ? null : money(budgets.reduce((t, s) => t + s.budget.amount, 0)),
            previousMonth: sum((s) => s.previousMonth),
          },
  };
}

/** The AI section with the Foundry card's figures copied from its Azure scope. */
export function presentAi(ai, azure, budgetUsd) {
  // Before the first reading there is no AI section: answer zeros, so a
  // reader never meets a missing month (the first visit after a deploy).
  const base = { previousMonth: null, providers: [], ...(ai ?? {}) };
  base.monthToDate = ai?.monthToDate ?? aggregateUsage([]);
  const providers = (base.providers || []).map((card) => {
    if (card.kind !== 'azure-budget') return card;
    const scope = (azure?.scopes || []).find((s) => s.id === card.scopeId && !s.error);
    if (!scope) return { ...card, configured: card.configured, monthToDate: null, budget: null, forecast: null };
    return {
      ...card,
      configured: true,
      monthToDate: scope.monthToDate,
      budget: scope.budget?.amount ?? null,
      forecast: scope.forecast ?? null,
      percentUsed: scope.budget?.percentUsed ?? null,
    };
  });
  return { ...base, budgetUsd, providers };
}

/** The months list the page shows, newest first, at most HISTORY_MONTHS, without the current month. */
export function presentHistory(months, currentMonth) {
  return Object.entries(months || {})
    .filter(([month]) => month !== currentMonth)
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, HISTORY_MONTHS)
    .map(([month, figures]) => ({
      month,
      azureMonthToDate: figures?.azureMonthToDate ?? null,
      aiCostUsd: figures?.aiCostUsd ?? null,
      servicesMonthly: figures?.servicesMonthly ?? null,
      readAt: figures?.readAt ?? null,
    }));
}

/**
 * The whole answer of GET cms/cost/summary, from the stored snapshot (or
 * none), the ledger and the clock. Pure.
 *
 * @param {object} args
 * @param {object|null} args.snapshot the stored document
 * @param {{ items: object[], settings: object }} args.ledger
 * @param {Date} args.now
 */
export function buildSummary({ snapshot, ledger, now }) {
  const period = periodOf(now);
  const azure = presentAzure(snapshot?.azure, period);
  const ai = presentAi(snapshot?.ai, azure, ledger.settings.aiMonthlyBudgetUsd);
  const items = ledger.items.filter(isStoredItem).map((row) => presentItem(row, period.today));
  const services = summarizeServices(items);
  const readAt = typeof snapshot?.readAt === 'string' ? snapshot.readAt : null;
  const sources = [
    ...(Array.isArray(snapshot?.sources) ? snapshot.sources : []),
    { id: 'services', ok: true, error: null, readAt: now.toISOString() },
  ];
  const partial = { readAt, period, azure, ai, services };
  return {
    readAt,
    stale: isStale(readAt, now),
    currency: CURRENCY,
    period,
    azure,
    ai,
    services,
    signals: computeSignals(partial, ledger.settings, now),
    sources,
    history: presentHistory(snapshot?.months, period.month),
    settings: ledger.settings,
  };
}

/** The current month's figures for the `months` record, from a built summary. */
export function monthFigures(summary) {
  return {
    azureMonthToDate: summary.azure?.totals?.monthToDate ?? null,
    aiCostUsd: summary.ai?.monthToDate?.costUsd ?? null,
    servicesMonthly: summary.services?.monthlyEquivalent ?? null,
    readAt: summary.readAt,
  };
}

/**
 * Read Azure and the AI ledger now and write the snapshot. Returns the stored
 * document. Never throws for a source that failed (each says so in
 * `sources`); throws only when the store cannot be written.
 *
 * @param {object} deps
 * @param {object} deps.store readDoc, createDoc, replaceDocIfMatch, queryDocs
 * @param {{ items: object[], settings: object }} deps.ledger
 * @param {() => Date} [deps.now]
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {Function} [deps.fetchImpl]
 * @param {{ readAll: Function }} [deps.azureReader] test seam
 * @param {Function} [deps.readAi] test seam for readAiCosts
 */
export async function refreshSnapshot({
  store,
  ledger,
  now = () => new Date(),
  env = process.env,
  fetchImpl = globalThis.fetch,
  azureReader = createAzureCostReader({ env, fetchImpl }),
  readAi = readAiCosts,
}) {
  const at = now();
  const stored = await readSnapshot(store);
  const [azure, aiResult] = await Promise.all([
    azureReader.readAll({ previous: stored?.azure ?? null, now: at }),
    readAi({ store, env, fetchImpl, now, budgetUsd: ledger.settings.aiMonthlyBudgetUsd }),
  ]);
  const sources = [
    { id: 'azure', ok: azure.available, error: azure.available ? null : azure.reason, readAt: at.toISOString() },
    ...aiResult.sources,
  ];
  return changeSnapshot(store, (stored) => {
    const next = {
      readAt: at.toISOString(),
      lastRefreshAt: at.toISOString(),
      azure,
      ai: aiResult.ai,
      sources,
      months: { ...(stored?.months ?? {}) },
      notified: stored?.notified ?? {},
      digestSentFor: stored?.digestSentFor ?? null,
    };
    const summary = buildSummary({ snapshot: next, ledger, now: at });
    next.months[monthOf(at)] = monthFigures(summary);
    // Keep the record bounded: the current month plus HISTORY_MONTHS before it.
    const keep = Object.keys(next.months).sort().slice(-(HISTORY_MONTHS + 1));
    next.months = Object.fromEntries(keep.map((month) => [month, next.months[month]]));
    return next;
  });
}

/** Whether a refresh asked for at `now` is allowed, given the last one. */
export function refreshAllowed(snapshot, now, minIntervalMs = MIN_REFRESH_INTERVAL_MS) {
  const last = Date.parse(snapshot?.lastRefreshAt || '');
  if (!Number.isFinite(last)) return { allowed: true, nextRefreshAt: null };
  const nextAt = last + minIntervalMs;
  if (now.getTime() >= nextAt) return { allowed: true, nextRefreshAt: null };
  return { allowed: false, nextRefreshAt: new Date(nextAt).toISOString() };
}
