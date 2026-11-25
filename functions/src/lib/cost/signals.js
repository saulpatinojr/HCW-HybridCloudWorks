/**
 * cost/signals.js — the alerts the Cost page raises from a snapshot (ADR
 * 0039). Pure: a function of the snapshot and the settings, so the page, the
 * Decision Center and the Telegram watch all read the same list.
 *
 * Each signal has a STABLE id, so the watch can tell "still true since
 * yesterday" from "new today" and tell the owner once. The severity ladder
 * mirrors the Azure budgets' own thresholds (infra/budget.tf, 50/75/90/100 %
 * actual and 100 % forecast), so what Azure emails and what the page says
 * never disagree about where a budget stands.
 *
 *   critical   act now: a budget at or past 90 %, credits nearly out, the AI
 *              budget spent, the image budget spent
 *   warning    act this week: a budget past 75 %, a forecast past 100 %, a
 *              renewal due today or tomorrow or overdue, credits under 20 %,
 *              the image or AI budget past 80 %, Azure cost unreadable
 *   info       for the record: a budget past 50 %, a renewal inside its
 *              lead days, a stale snapshot, a credit read that failed
 */
import { CURRENCY, isStale } from './model.js';

export const SEVERITIES = Object.freeze(['critical', 'warning', 'info']);
const RANK = { critical: 0, warning: 1, info: 2 };

const usd = (value) => `${CURRENCY} ${Number(value ?? 0).toFixed(2)}`;
const pct = (value) => `${Math.round(Number(value ?? 0))}%`;

const AZURE_HREF = '/admin/cost?tab=azure';
const AI_HREF = '/admin/cost?tab=ai';
const SERVICES_HREF = '/admin/cost?tab=services';
const OVERVIEW_HREF = '/admin/cost?tab=overview';

/** A maker of signals that all link to `href` (one tab of the Cost page). */
const signalAt = (href) => (id, severity, area, title, detail) => ({ id, severity, area, title, detail, href });
const azureSignal = signalAt(AZURE_HREF);
const aiSignal = signalAt(AI_HREF);
const serviceSignal = signalAt(SERVICES_HREF);
const overviewSignal = signalAt(OVERVIEW_HREF);

/** The budget rungs, highest first: the first one a percentage reaches is its rung. */
const BUDGET_RUNGS = Object.freeze([
  { rung: 100, severity: 'critical' },
  { rung: 90, severity: 'critical' },
  { rung: 75, severity: 'warning' },
  { rung: 50, severity: 'info' },
]);

/** The highest budget rung a percentage has reached, or null under 50. */
export function budgetRung(percentUsed) {
  const p = Number(percentUsed);
  if (!Number.isFinite(p)) return null;
  const reached = BUDGET_RUNGS.find(({ rung }) => p >= rung);
  return reached ? { ...reached } : null;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** One scope's budget signals: the rung it has reached, and a forecast past 100 % below that rung. */
function budgetSignals(scope, daysLeft) {
  const out = [];
  const budget = scope.budget;
  const used = budgetRung(budget.percentUsed);
  if (used) {
    out.push(
      azureSignal(
        `azure:${scope.id}:actual:${used.rung}`,
        used.severity,
        'azure',
        `${scope.label} is at ${pct(budget.percentUsed)} of its ${usd(budget.amount)} budget`,
        `${usd(budget.currentSpend)} spent with ${plural(daysLeft, 'day')} left` +
          (Number.isFinite(scope.forecast) ? `; the month is estimated at ${usd(scope.forecast)}.` : '.')
      )
    );
  }
  const forecastPast = Number.isFinite(budget.percentForecast) && budget.percentForecast >= 100;
  if (forecastPast && (!used || used.rung < 100)) {
    out.push(
      azureSignal(
        `azure:${scope.id}:forecast:100`,
        'warning',
        'azure',
        `${scope.label} is forecast to pass its ${usd(budget.amount)} budget`,
        `Azure's own estimate for the month is ${usd(budget.forecastSpend)} (${pct(budget.percentForecast)} of the budget).`
      )
    );
  }
  return out;
}

/** One scope's signals: unreadable, or showing kept figures, and then its budget's. */
function scopeSignals(scope, daysLeft) {
  if (scope.error) {
    return [azureSignal(`azure:${scope.id}:unreadable`, 'warning', 'data', `${scope.label}: costs could not be read`, scope.error)];
  }
  const out = [];
  if (scope.note) {
    out.push(azureSignal(`azure:${scope.id}:kept`, 'info', 'data', `${scope.label}: showing earlier figures`, scope.note));
  }
  if (scope.budget) out.push(...budgetSignals(scope, daysLeft));
  return out;
}

function azureSignals(azure, period) {
  if (!azure || azure.neverRead) return [];
  if (!azure.available) {
    return [
      azureSignal('azure:unavailable', 'warning', 'data', 'Azure costs could not be read', azure.reason || 'No Azure scope answered.'),
    ];
  }
  const daysLeft = Math.max(0, (period?.daysInMonth ?? 0) - (period?.daysElapsed ?? 0));
  return (azure.scopes || []).flatMap((scope) => scopeSignals(scope, daysLeft));
}

/** The AI budget's signal, when one is set and spend has reached 80 % of it. */
function aiBudgetSignals(ai) {
  const budget = Number(ai.budgetUsd);
  const spend = Number(ai.monthToDate?.costUsd ?? 0);
  if (!Number.isFinite(budget) || budget <= 0) return [];
  const p = (spend / budget) * 100;
  const detail = `${usd(spend)} estimated so far this month.`;
  if (p >= 100) return [aiSignal('ai:budget:100', 'critical', 'ai', `AI spend has reached its ${usd(budget)} monthly budget`, detail)];
  if (p >= 80) return [aiSignal('ai:budget:80', 'warning', 'ai', `AI spend is at ${pct(p)} of its ${usd(budget)} monthly budget`, detail)];
  return [];
}

/** A credits card's signal: unreadable, nearly out (under 5 %), or low (under 20 %). */
function creditSignals(card) {
  if (card.error) {
    return [aiSignal(`${card.id}:unreadable`, 'info', 'data', `${card.label} credits could not be read`, card.error)];
  }
  if (!Number.isFinite(card.percentLeft)) return [];
  const reset = card.resetAt ? ` They reset on ${String(card.resetAt).slice(0, 10)}.` : '';
  if (card.percentLeft < 5) {
    return [aiSignal(`${card.id}:credits:5`, 'critical', 'ai', `${card.label} is nearly out of credits`, `${card.left} of ${card.limit} credits left.${reset}`)];
  }
  if (card.percentLeft < 20) {
    return [aiSignal(`${card.id}:credits:20`, 'warning', 'ai', `${card.label} has ${pct(card.percentLeft)} of its credits left`, `${card.left} of ${card.limit} credits.${reset}`)];
  }
  return [];
}

/** An image-budget card's signal: spent (100 %) or past 80 %. */
function imageBudgetSignals(card) {
  if (card.percentUsed >= 100) {
    return [aiSignal(`${card.id}:budget:100`, 'critical', 'ai', `${card.label} has spent its ${usd(card.budget)} monthly budget`, `${card.images} images this month; generation is paused until the 1st.`)];
  }
  if (card.percentUsed >= 80) {
    return [aiSignal(`${card.id}:budget:80`, 'warning', 'ai', `${card.label} is at ${pct(card.percentUsed)} of its ${usd(card.budget)} monthly budget`, `${card.images} images this month.`)];
  }
  return [];
}

function providerSignals(card) {
  const out = [];
  if (card.kind === 'credits' && card.configured) out.push(...creditSignals(card));
  if (card.kind === 'budget' && Number.isFinite(card.percentUsed)) out.push(...imageBudgetSignals(card));
  return out;
}

function aiSignals(ai) {
  if (!ai) return [];
  return [...aiBudgetSignals(ai), ...(ai.providers || []).flatMap(providerSignals)];
}

const CYCLE_WORDS = new Map([
  ['annual', 'year'],
  ['quarterly', 'quarter'],
]);

/** What a subscription costs, as the signal says it. */
function priceOf(item) {
  if (item.amount === null) return 'amount not recorded';
  return `${item.currency} ${Number(item.amount).toFixed(2)} per ${CYCLE_WORDS.get(item.cycle) ?? 'month'}`;
}

/** One subscription's renewal signal, or null: overdue (unless it renews by itself), due today or tomorrow, or inside the lead days. */
function renewalSignal(item, lead) {
  const days = item.daysUntilRenewal;
  const price = priceOf(item);
  if (days < 0) {
    if (item.autoRenew) return null; // auto-renewed: the date is just stale, the Services tab shows it
    return serviceSignal(`service:${item.id}:overdue`, 'warning', 'services', `${item.name} renewal date has passed`, `Was due ${item.nextRenewal} (${price}); update the date or mark it cancelled.`);
  }
  if (days <= 1) {
    return serviceSignal(`service:${item.id}:due`, 'warning', 'services', `${item.name} renews ${days === 0 ? 'today' : 'tomorrow'}`, `${price}${item.autoRenew ? ', renews by itself' : ', not set to renew by itself'}.`);
  }
  if (days <= lead) {
    return serviceSignal(`service:${item.id}:soon`, 'info', 'services', `${item.name} renews in ${days} days`, `On ${item.nextRenewal}; ${price}.`);
  }
  return null;
}

function serviceSignals(services, settings) {
  const lead = Number(settings?.renewalLeadDays) || 7;
  return (services?.items || [])
    .filter((item) => item.status !== 'cancelled' && Number.isFinite(item.daysUntilRenewal))
    .map((item) => renewalSignal(item, lead))
    .filter(Boolean);
}

/** The signal for figures never read, or read too long ago; null when they are fresh. */
function freshnessSignal(readAt, now) {
  if (!readAt) {
    return overviewSignal('data:never-read', 'info', 'data', 'The cost figures have not been read yet', 'Press Refresh on the Cost page, or wait for the hourly watch to read them.');
  }
  if (isStale(readAt, now)) {
    return overviewSignal('data:stale', 'info', 'data', 'The cost figures may be out of date', `They were last read on ${String(readAt).slice(0, 16).replace('T', ' ')} UTC. Press Refresh to read again.`);
  }
  return null;
}

/**
 * Every signal a snapshot raises, most severe first.
 *
 * @param {object} snapshot `{ readAt, period, azure, ai, services }`
 * @param {object} settings the ledger's settings (renewalLeadDays)
 * @param {Date} now
 */
export function computeSignals(snapshot, settings, now) {
  const out = [
    ...azureSignals(snapshot?.azure, snapshot?.period),
    ...aiSignals(snapshot?.ai),
    ...serviceSignals(snapshot?.services, settings),
  ];
  const freshness = freshnessSignal(snapshot?.readAt, now);
  if (freshness) out.push(freshness);
  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.id.localeCompare(b.id));
}

/** The signals worth a Telegram message: warning and critical. */
export const notable = (signals) => signals.filter((s) => s.severity !== 'info');
