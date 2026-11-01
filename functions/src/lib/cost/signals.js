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

function signal(id, severity, area, title, detail, href) {
  return { id, severity, area, title, detail, href };
}

/** The highest budget rung a percentage has reached, or null under 50. */
export function budgetRung(percentUsed) {
  const p = Number(percentUsed);
  if (!Number.isFinite(p)) return null;
  if (p >= 100) return { rung: 100, severity: 'critical' };
  if (p >= 90) return { rung: 90, severity: 'critical' };
  if (p >= 75) return { rung: 75, severity: 'warning' };
  if (p >= 50) return { rung: 50, severity: 'info' };
  return null;
}

function azureSignals(azure, period) {
  const out = [];
  if (!azure || azure.neverRead) return out;
  if (!azure.available) {
    out.push(
      signal(
        'azure:unavailable',
        'warning',
        'data',
        'Azure costs could not be read',
        azure.reason || 'No Azure scope answered.',
        AZURE_HREF
      )
    );
    return out;
  }
  const daysLeft = Math.max(0, (period?.daysInMonth ?? 0) - (period?.daysElapsed ?? 0));
  for (const scope of azure.scopes || []) {
    if (scope.error) {
      out.push(
        signal(`azure:${scope.id}:unreadable`, 'warning', 'data', `${scope.label}: costs could not be read`, scope.error, AZURE_HREF)
      );
      continue;
    }
    const budget = scope.budget;
    if (!budget) continue;
    const used = budgetRung(budget.percentUsed);
    if (used) {
      out.push(
        signal(
          `azure:${scope.id}:actual:${used.rung}`,
          used.severity,
          'azure',
          `${scope.label} is at ${pct(budget.percentUsed)} of its ${usd(budget.amount)} budget`,
          `${usd(budget.currentSpend)} spent with ${daysLeft} day${daysLeft === 1 ? '' : 's'} left` +
            (Number.isFinite(scope.forecast) ? `; the month is estimated at ${usd(scope.forecast)}.` : '.'),
          AZURE_HREF
        )
      );
    }
    if (Number.isFinite(budget.percentForecast) && budget.percentForecast >= 100 && (!used || used.rung < 100)) {
      out.push(
        signal(
          `azure:${scope.id}:forecast:100`,
          'warning',
          'azure',
          `${scope.label} is forecast to pass its ${usd(budget.amount)} budget`,
          `Azure's own estimate for the month is ${usd(budget.forecastSpend)} (${pct(budget.percentForecast)} of the budget).`,
          AZURE_HREF
        )
      );
    }
  }
  return out;
}

function aiSignals(ai) {
  const out = [];
  if (!ai) return out;
  const budget = Number(ai.budgetUsd);
  const spend = Number(ai.monthToDate?.costUsd ?? 0);
  if (Number.isFinite(budget) && budget > 0) {
    const p = (spend / budget) * 100;
    if (p >= 100) {
      out.push(signal('ai:budget:100', 'critical', 'ai', `AI spend has reached its ${usd(budget)} monthly budget`, `${usd(spend)} estimated so far this month.`, AI_HREF));
    } else if (p >= 80) {
      out.push(signal('ai:budget:80', 'warning', 'ai', `AI spend is at ${pct(p)} of its ${usd(budget)} monthly budget`, `${usd(spend)} estimated so far this month.`, AI_HREF));
    }
  }
  for (const card of ai.providers || []) {
    if (card.kind === 'credits' && card.configured) {
      if (card.error) {
        out.push(signal(`${card.id}:unreadable`, 'info', 'data', `${card.label} credits could not be read`, card.error, AI_HREF));
      } else if (Number.isFinite(card.percentLeft)) {
        const reset = card.resetAt ? ` They reset on ${String(card.resetAt).slice(0, 10)}.` : '';
        if (card.percentLeft < 5) {
          out.push(signal(`${card.id}:credits:5`, 'critical', 'ai', `${card.label} is nearly out of credits`, `${card.left} of ${card.limit} credits left.${reset}`, AI_HREF));
        } else if (card.percentLeft < 20) {
          out.push(signal(`${card.id}:credits:20`, 'warning', 'ai', `${card.label} has ${pct(card.percentLeft)} of its credits left`, `${card.left} of ${card.limit} credits.${reset}`, AI_HREF));
        }
      }
    }
    if (card.kind === 'budget' && Number.isFinite(card.percentUsed)) {
      if (card.percentUsed >= 100) {
        out.push(signal(`${card.id}:budget:100`, 'critical', 'ai', `${card.label} has spent its ${usd(card.budget)} monthly budget`, `${card.images} images this month; generation is paused until the 1st.`, AI_HREF));
      } else if (card.percentUsed >= 80) {
        out.push(signal(`${card.id}:budget:80`, 'warning', 'ai', `${card.label} is at ${pct(card.percentUsed)} of its ${usd(card.budget)} monthly budget`, `${card.images} images this month.`, AI_HREF));
      }
    }
  }
  return out;
}

function serviceSignals(services, settings) {
  const out = [];
  const lead = Number(settings?.renewalLeadDays) || 7;
  for (const item of services?.items || []) {
    if (item.status === 'cancelled' || !Number.isFinite(item.daysUntilRenewal)) continue;
    const days = item.daysUntilRenewal;
    const price = item.amount === null ? 'amount not recorded' : `${item.currency} ${Number(item.amount).toFixed(2)} per ${item.cycle === 'annual' ? 'year' : item.cycle === 'quarterly' ? 'quarter' : 'month'}`;
    if (days < 0) {
      if (item.autoRenew) continue; // auto-renewed: the date is just stale, the Services tab shows it
      out.push(signal(`service:${item.id}:overdue`, 'warning', 'services', `${item.name} renewal date has passed`, `Was due ${item.nextRenewal} (${price}); update the date or mark it cancelled.`, SERVICES_HREF));
    } else if (days <= 1) {
      out.push(signal(`service:${item.id}:due`, 'warning', 'services', `${item.name} renews ${days === 0 ? 'today' : 'tomorrow'}`, `${price}${item.autoRenew ? ', renews by itself' : ', not set to renew by itself'}.`, SERVICES_HREF));
    } else if (days <= lead) {
      out.push(signal(`service:${item.id}:soon`, 'info', 'services', `${item.name} renews in ${days} days`, `On ${item.nextRenewal}; ${price}.`, SERVICES_HREF));
    }
  }
  return out;
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
  if (!snapshot?.readAt) {
    out.push(
      signal('data:never-read', 'info', 'data', 'The cost figures have not been read yet', 'Press Refresh on the Cost page, or wait for the hourly watch to read them.', OVERVIEW_HREF)
    );
  } else if (isStale(snapshot.readAt, now)) {
    out.push(
      signal('data:stale', 'info', 'data', 'The cost figures may be out of date', `They were last read on ${String(snapshot.readAt).slice(0, 16).replace('T', ' ')} UTC. Press Refresh to read again.`, OVERVIEW_HREF)
    );
  }
  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.id.localeCompare(b.id));
}

/** The signals worth a Telegram message: warning and critical. */
export const notable = (signals) => signals.filter((s) => s.severity !== 'info');
