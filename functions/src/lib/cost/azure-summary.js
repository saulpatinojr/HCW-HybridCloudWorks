/**
 * cost/azure-summary.js — Cost Management's and Consumption's answers turned
 * into what the Cost page shows: the month's cost by service and by day, a
 * month's total, and a scope's budget. Pure over the payloads; azure.js
 * re-exports these, so callers and tests keep one import.
 */
import { money, percent } from './model.js';

/** Cost Management's `yyyymmdd` number as `YYYY-MM-DD`. */
export function usageDateOf(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length !== 8) return null;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

/**
 * A query answer (`properties.columns` naming `rows`' positions) as objects
 * keyed by column name, lower-cased. Cost Management names the cost column
 * after the aggregation alias (`PreTaxCost` here) and the day `UsageDate`.
 */
export function rowsOf(payload) {
  const columns = Array.isArray(payload?.properties?.columns) ? payload.properties.columns : [];
  const rows = Array.isArray(payload?.properties?.rows) ? payload.properties.rows : [];
  const names = columns.map((column) => String(column?.name ?? '').toLowerCase());
  return rows.map((row) => Object.fromEntries(names.map((name, i) => [name, row?.[i]])));
}

/**
 * The by-service table and the daily line from one MonthToDate query grouped
 * by ResourceGroupName and ServiceName at Daily granularity.
 *
 * @returns {{ monthToDate: number, byService: object[], daily: object[] }}
 */
export function summarizeUsage(payload) {
  const byKey = new Map();
  const byDay = new Map();
  let total = 0;
  for (const row of rowsOf(payload)) {
    const cost = Number(row.pretaxcost ?? row.cost ?? 0);
    if (!Number.isFinite(cost)) continue;
    total += cost;
    const resourceGroup = String(row.resourcegroupname ?? '').toLowerCase() || '(none)';
    const service = String(row.servicename ?? '') || '(unnamed)';
    const key = `${resourceGroup}\u0000${service}`;
    byKey.set(key, (byKey.get(key) ?? 0) + cost);
    const day = usageDateOf(row.usagedate);
    if (day) byDay.set(day, (byDay.get(day) ?? 0) + cost);
  }
  const byService = [...byKey.entries()]
    .map(([key, cost]) => {
      const [resourceGroup, service] = key.split('\u0000');
      return { resourceGroup, service, cost: money(cost) };
    })
    .filter((row) => row.cost !== 0)
    .sort((a, b) => b.cost - a.cost || a.service.localeCompare(b.service));
  const daily = [...byDay.entries()]
    .map(([date, cost]) => ({ date, cost: money(cost) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { monthToDate: money(total), byService, daily };
}

/** The total of a query with no grouping and no granularity (one row, or none). */
export function totalOf(payload) {
  let total = 0;
  for (const row of rowsOf(payload)) {
    const cost = Number(row.pretaxcost ?? row.cost ?? 0);
    if (Number.isFinite(cost)) total += cost;
  }
  return money(total);
}

/**
 * True when a budget's id says it was created at `scope` itself. Listing a
 * subscription's budgets also returns the budgets of its resource groups
 * (seen 2026-11-03: the application subscription's list carried the Foundry
 * group's site-foundry-monthly-budget, which sorts before site-monthly-budget
 * and was shown as the subscription's), so the id is what tells them apart.
 * A budget without an id is kept: there is nothing to tell it by.
 */
function belongsTo(budget, scope) {
  // Compared without leading or trailing slashes, so "/subscriptions/…" and
  // "subscriptions/…" are the same path whichever side carries the slash.
  const trim = (value) => String(value ?? '').toLowerCase().replace(/^\/+|\/+$/g, '');
  const id = trim(budget?.id);
  if (!id || !scope) return true;
  return id.startsWith(`${trim(scope)}/providers/microsoft.consumption/budgets/`);
}

/**
 * The first budget of a scope as the page shows it, or null when the scope
 * has none. A scope here has one budget by design (infra/budget.tf,
 * infra/foundry.tf); when it has several the first by name is shown. With
 * `scope`, a budget set on a narrower scope inside it (a resource group's
 * budget in a subscription's list) is left out.
 */
export function summarizeBudgets(payload, scope) {
  const budgets = Array.isArray(payload?.value) ? payload.value : [];
  const monthly = budgets
    .filter((b) => belongsTo(b, scope))
    .filter((b) => String(b?.properties?.timeGrain ?? 'Monthly').toLowerCase() === 'monthly')
    .sort((a, b) => String(a?.name ?? '').localeCompare(String(b?.name ?? '')));
  const budget = monthly[0];
  if (!budget) return null;
  const props = budget.properties ?? {};
  const amount = money(props.amount);
  const currentSpend = money(props.currentSpend?.amount);
  const forecastRaw = Number(props.forecastSpend?.amount);
  const forecastSpend = Number.isFinite(forecastRaw) ? money(forecastRaw) : null;
  const thresholds = [];
  const forecastThresholds = [];
  for (const notification of Object.values(props.notifications ?? {})) {
    const threshold = Number(notification?.threshold);
    if (!Number.isFinite(threshold) || notification?.enabled === false) continue;
    const list =
      String(notification?.thresholdType ?? 'Actual').toLowerCase() === 'forecasted'
        ? forecastThresholds
        : thresholds;
    if (!list.includes(threshold)) list.push(threshold);
  }
  thresholds.sort((a, b) => a - b);
  forecastThresholds.sort((a, b) => a - b);
  return {
    name: String(budget.name ?? ''),
    amount,
    currentSpend,
    forecastSpend,
    percentUsed: percent(currentSpend, amount),
    percentForecast: forecastSpend === null ? null : percent(forecastSpend, amount),
    thresholds,
    forecastThresholds,
  };
}

/**
 * The budget with its spend raised to `spend` when Azure's own figure on the
 * budget is lower. A budget's currentSpend is evaluated on Azure's schedule
 * and can lag the cost query: on 2026-11-03 site-monthly-budget still said
 * USD 0.00 while the query had USD 7.33, so the bar read "0% used" and the
 * 50/75/90 % alerts, which read the same percentage, would have warned late.
 * The higher of the two is used so a lagging budget never hides spend;
 * `spendSource` says which one the bar shows. Azure's forecast is left as is.
 */
export function withSpendAtLeast(budget, spend) {
  if (!budget) return budget;
  const queried = Number(spend);
  if (!Number.isFinite(queried) || queried <= (Number(budget.currentSpend) || 0)) {
    return { ...budget, spendSource: 'budget' };
  }
  const currentSpend = money(queried);
  return { ...budget, currentSpend, percentUsed: percent(currentSpend, budget.amount), spendSource: 'query' };
}

