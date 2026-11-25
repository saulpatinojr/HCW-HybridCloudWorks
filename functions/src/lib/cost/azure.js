/**
 * cost/azure.js — what Azure says the platform has spent this month, read
 * with the Function App's own managed identity (ADR 0039).
 *
 * Two ARM reads per scope, no SDK, the same way labs/resource-graph.js reads
 * Resource Graph: `DefaultAzureCredential` mints a management-plane token and
 * plain `fetch` carries it.
 *
 *   1. The scope's budgets:
 *      GET {scope}/providers/Microsoft.Consumption/budgets?api-version=2023-11-01
 *      Each budget carries `amount`, `currentSpend.amount` (what Azure has
 *      billed so far this period) and `forecastSpend.amount` (Azure's own
 *      estimate for the whole period), plus its notification thresholds.
 *      https://learn.microsoft.com/rest/api/consumption/budgets/list (read 2026-11-01)
 *   2. The month's cost by day, resource group and service:
 *      POST {scope}/providers/Microsoft.CostManagement/query?api-version=2023-11-01
 *      type ActualCost, timeframe MonthToDate, granularity Daily, PreTaxCost
 *      summed, grouped by ResourceGroupName and ServiceName. One answer gives
 *      both the by-service table and the daily line. A second query with
 *      timeframe TheLastMonth and no granularity gives last month's total.
 *      https://learn.microsoft.com/rest/api/cost-management/query/usage (read 2026-11-01)
 *
 * WHAT THE IDENTITY CAN SEE is the whole grant: Cost Management Reader on the
 * application and Platform Management subscriptions (infra/budget.tf), which
 * is every read under Microsoft.Consumption and Microsoft.CostManagement and
 * nothing that changes anything
 * (https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/management-and-governance#cost-management-reader,
 * read 2026-11-01). A scope the identity cannot read answers 401 or 403, and
 * that scope's card says so; the others still answer.
 *
 * THE SCOPES COME FROM ONE APP SETTING, `COST_SCOPES`: a JSON list of
 * `{ id, label, scope, kind, name }`, written by Terraform
 * (infra/functionapp.tf) from the same subscription variables the budgets
 * use. `scope` is an ARM scope path (`/subscriptions/<id>` or
 * `/subscriptions/<id>/resourceGroups/<name>`); `kind` is `subscription` or
 * `resourceGroup`. A process without the setting (a local run, the
 * route-inventory tests) knows no scope and the reader answers "not
 * configured" BEFORE touching the credential, for the reason resource-graph.js
 * gives: a credential probe inside a unit test is slow or live.
 *
 * NOTHING HERE NAMES A SUBSCRIPTION ID TO THE BROWSER. The scope path stays
 * on the server; the page sees the configured `id`, `label` and `name`.
 *
 * Cost data lags: Azure refreshes it a few times a day and the current
 * month's charges can still move until the invoice closes
 * (https://learn.microsoft.com/azure/cost-management-billing/costs/understand-cost-mgt-data).
 * The snapshot (snapshot.js) is what bounds how often this runs.
 */
import { AuthoredError, storedFailure } from '../http/error-response.js';
import { previousMonthOf } from './model.js';
import { BUDGETS_API_VERSION, QUERY_API_VERSION, STEPS, createArmFetch } from './azure-arm.js';
import { summarizeBudgets, summarizeUsage, totalOf, withSpendAtLeast } from './azure-summary.js';

export {
  ARM_ORIGIN,
  ARM_SCOPE,
  ARM_TIMEOUT_MS,
  ArmStatusError,
  BUDGETS_API_VERSION,
  MAX_ATTEMPTS,
  QPU_RETRY_HEADER,
  QUERY_API_VERSION,
  RETRY_WAIT_CAP_MS,
  RETRY_WAIT_DEFAULT_MS,
  STEPS,
  azureErrorCode,
  describeArmStatus,
  retryAfterMs,
} from './azure-arm.js';
export { rowsOf, summarizeBudgets, summarizeUsage, totalOf, usageDateOf, withSpendAtLeast } from './azure-summary.js';

/** The setting the scopes are read from. */
export const SCOPES_SETTING = 'COST_SCOPES';

export const SCOPE_KINDS = Object.freeze(['subscription', 'resourceGroup']);

const TIMEOUT_SENTENCE = 'Azure did not answer in time; the next refresh will try again.';
const UNREADABLE_SENTENCE = 'Azure could not be read; the next refresh will try again.';

const SCOPE_PATH = /^\/subscriptions\/[0-9a-f-]{36}(\/resourceGroups\/[A-Za-z0-9._()-]{1,90})?$/i;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * The configured scopes, in order; `[]` when the setting is absent, and an
 * `Error` with `code: 'COST_SCOPES_INVALID'` when it is present but not the
 * shape above (a misconfiguration the page should say, not hide).
 *
 * @param {Record<string, string|undefined>} env
 * @returns {Array<{ id: string, label: string, scope: string, kind: string, name: string|null }>}
 */
export function parseScopes(env = process.env) {
  const raw = env?.[SCOPES_SETTING];
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidScopes('it is not JSON');
  }
  if (!Array.isArray(parsed)) throw invalidScopes('it is not a list');
  const seen = new Set();
  return parsed.map((entry, index) => {
    const where = `entry ${index + 1}`;
    if (!entry || typeof entry !== 'object') throw invalidScopes(`${where} is not an object`);
    const id = String(entry.id ?? '').trim();
    const label = String(entry.label ?? '').trim();
    const scope = String(entry.scope ?? '').trim();
    const kind = String(entry.kind ?? '').trim();
    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : null;
    if (!ID_PATTERN.test(id)) throw invalidScopes(`${where} has no usable id`);
    if (seen.has(id)) throw invalidScopes(`${where} repeats the id ${id}`);
    seen.add(id);
    if (!label || label.length > 80) throw invalidScopes(`${where} has no usable label`);
    if (!SCOPE_PATH.test(scope)) throw invalidScopes(`${where} has no usable scope path`);
    if (!SCOPE_KINDS.includes(kind)) throw invalidScopes(`${where} has no usable kind`);
    return { id, label, scope, kind, name };
  });
}

/** The setting is present but not the documented shape; the sentence is written here (#945). */
export class CostScopesError extends AuthoredError {
  constructor(reason) {
    super(`${SCOPES_SETTING} could not be read: ${reason}`, { code: 'COST_SCOPES_INVALID' });
  }
}

function invalidScopes(reason) {
  return new CostScopesError(reason);
}


const AGGREGATION = { totalCost: { name: 'PreTaxCost', function: 'Sum' } };

/** The question for this month's costs: by day, by resource group and service. */
const MONTH_TO_DATE_QUERY = {
  type: 'ActualCost',
  timeframe: 'MonthToDate',
  dataset: {
    granularity: 'Daily',
    aggregation: AGGREGATION,
    grouping: [
      { type: 'Dimension', name: 'ResourceGroupName' },
      { type: 'Dimension', name: 'ServiceName' },
    ],
  },
};

/**
 * The question for last month's total, by its dates. `TheLastMonth` with no
 * granularity was refused with 400 BadRequest on 2026-11-03; a Custom period
 * with granularity None is the form cost-analysis.md measured September with.
 */
function lastMonthQuery(lastMonth) {
  const [y, m] = lastMonth.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    type: 'ActualCost',
    timeframe: 'Custom',
    timePeriod: {
      from: `${lastMonth}-01T00:00:00Z`,
      to: `${lastMonth}-${String(lastDay).padStart(2, '0')}T23:59:59Z`,
    },
    dataset: { granularity: 'None', aggregation: AGGREGATION },
  };
}

/** A scope's card before anything is read: its names, and every figure empty. */
function scopeBase(scope) {
  return {
    id: scope.id,
    label: scope.label,
    kind: scope.kind,
    name: scope.name,
    monthToDate: null,
    previousMonth: null,
    previousMonthOf: null,
    budget: null,
    byService: [],
    daily: [],
    readAt: null,
    note: null,
    error: null,
  };
}

/** True when `previous` already holds a good total for `lastMonth`, so it need not be asked again. */
function knowsLastMonth(previous, lastMonth) {
  return Boolean(previous && !previous.error && previous.previousMonthOf === lastMonth && Number.isFinite(previous.previousMonth));
}

/**
 * A read that is not this month's costs may fail on its own: the card still
 * shows the month, and its note (from `partial`) says what could not be read.
 */
async function optional(read, partial) {
  try {
    return { value: await read() };
  } catch (error) {
    partial.push(error?.code === 'FETCH_TIMEOUT' ? TIMEOUT_SENTENCE : storedFailure(error, UNREADABLE_SENTENCE));
    return { value: null };
  }
}

/** This scope could not be read: keep this month's last good figures, or say why. */
function failed(error, { base, scope, previous, month }) {
  const message = error?.code === 'FETCH_TIMEOUT' ? TIMEOUT_SENTENCE : storedFailure(error, UNREADABLE_SENTENCE);
  const keep = previous && !previous.error && typeof previous.readAt === 'string' && previous.readAt.slice(0, 7) === month;
  if (keep) {
    return {
      ...base,
      ...previous,
      id: scope.id,
      label: scope.label,
      kind: scope.kind,
      name: scope.name,
      note: `These figures were read at ${previous.readAt.slice(0, 16).replace('T', ' ')} UTC and could not be renewed this time: ${message}`,
      noteCode: error?.status === 429 ? 'throttled' : error?.code ?? 'error',
      error: null,
    };
  }
  return { ...base, error: message, errorCode: error?.code ?? 'error', errorStatus: error?.status ?? null };
}

/**
 * The scope's budget, or null. The budgets come first, from the Consumption
 * API, which the Query API's QPU allowance does not cover: each budget
 * carries Azure's own spend so far and forecast, so a scope with a budget
 * still has a month when the cost query is throttled (2026-11-03: both
 * subscriptions 429).
 */
async function readBudget(arm, scope, partial) {
  const budgets = await optional(
    () =>
      arm.fetch(
        `${scope.scope}/providers/Microsoft.Consumption/budgets?api-version=${BUDGETS_API_VERSION}`,
        {},
        STEPS.budgets
      ),
    partial
  );
  return budgets.value ? summarizeBudgets(budgets.value, scope.scope) : null;
}

/**
 * Last month's total: the one `previous` holds when it is for the same month
 * (it does not change once the month is over, so the query is not sent),
 * else asked for; null when it could not be read.
 */
async function readLastMonthTotal(arm, scope, { previous, lastMonth, partial }) {
  if (knowsLastMonth(previous, lastMonth)) return previous.previousMonth;
  const lastTotal = await optional(() => arm.query(scope.scope, lastMonthQuery(lastMonth), STEPS.lastMonth), partial);
  return lastTotal.value ? totalOf(lastTotal.value) : null;
}

/**
 * The month from the budget alone: no breakdown, and last month waits too
 * (asking again now would only spend more of the same allowance).
 */
function budgetOnlyFigures(base, budget, { previous, lastMonth, now }) {
  const keepLast = knowsLastMonth(previous, lastMonth);
  return {
    ...base,
    monthToDate: budget.currentSpend,
    previousMonth: keepLast ? previous.previousMonth : null,
    previousMonthOf: keepLast ? lastMonth : null,
    budget,
    readAt: now.toISOString(),
  };
}

/** The full card once this month's costs were read. */
function fullFigures(base, budget, usage, { previousMonth, lastMonth, partial, now }) {
  const summary = summarizeUsage(usage);
  return {
    ...base,
    monthToDate: summary.monthToDate,
    byService: summary.byService,
    daily: summary.daily,
    previousMonth,
    previousMonthOf: previousMonth === null ? null : lastMonth,
    budget: withSpendAtLeast(budget, summary.monthToDate),
    readAt: now.toISOString(),
    note: partial.length ? `Part of this scope could not be read: ${partial.join(' ')}` : null,
    noteCode: partial.length ? 'partial' : undefined,
  };
}

/**
 * One scope's figures. Never throws: a failed read is `{ error }` with the
 * figures null, so one scope that cannot be read never hides the others.
 *
 * The calls run one after another, never together (the QPU note in
 * azure-arm.js). Last month's total does not change once the month is over,
 * so when `previous` (this scope as the last snapshot holds it) already has
 * it for the same month, it is reused and the query is not sent: half the
 * QPU of every refresh after the first of the month.
 *
 * When this read fails and `previous` has good figures from this same
 * month, those are kept, marked with `readAt` and a `note` saying why they
 * were not renewed, so a throttled refresh does not blank the card.
 */
async function readScope(arm, scope, previous, now) {
  const month = now.toISOString().slice(0, 7);
  const lastMonth = previousMonthOf(month);
  const base = scopeBase(scope);
  const partial = [];
  const context = { base, scope, previous, month, lastMonth, partial, now };
  const budget = await readBudget(arm, scope, partial);
  let usage;
  try {
    usage = await arm.query(scope.scope, MONTH_TO_DATE_QUERY, STEPS.monthToDate);
  } catch (error) {
    if (!budget) return failed(error, context);
    const message = error?.code === 'FETCH_TIMEOUT' ? TIMEOUT_SENTENCE : storedFailure(error, UNREADABLE_SENTENCE);
    return {
      ...budgetOnlyFigures(base, budget, context),
      note: `This month's spend is the budget's own figure; the daily line and the cost by service could not be read: ${message}`,
      noteCode: error?.status === 429 ? 'throttled' : 'partial',
    };
  }
  try {
    const previousMonth = await readLastMonthTotal(arm, scope, context);
    return fullFigures(base, budget, usage, { ...context, previousMonth });
  } catch (error) {
    return failed(error, context);
  }
}

/** Every configured scope, read one after another: the QPU allowance is per tenant (azure-arm.js). */
async function readScopes(arm, scopes, previous, now) {
  const before = new Map((previous?.scopes ?? []).map((row) => [row.id, row]));
  const results = [];
  for (const scope of scopes) results.push(await readScope(arm, scope, before.get(scope.id), now));
  return results;
}

/**
 * @param {object} [deps]
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {Function} [deps.fetchImpl]
 * @param {{ getToken: Function }} [deps.credential] test seam; production builds DefaultAzureCredential lazily
 */
export function createAzureCostReader({
  env = process.env,
  fetchImpl = globalThis.fetch,
  credential,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const armFetch = createArmFetch({ fetchImpl, credential, sleep });
  const arm = {
    fetch: armFetch,
    query: (scope, body, step) =>
      armFetch(
        `${scope}/providers/Microsoft.CostManagement/query?api-version=${QUERY_API_VERSION}`,
        { method: 'POST', body: JSON.stringify(body) },
        step
      ),
  };

  return {
    /** The configured scopes (parseScopes), so a caller can say "nothing configured" without reading. */
    scopes() {
      return parseScopes(env);
    },

    /**
     * Every configured scope, read one after another. `previous` is the last
     * snapshot's Azure section, used to reuse last month's totals and to keep
     * good figures through a throttled refresh. `available` is false, with a
     * `reason`, when no scope is configured, the setting is malformed, or
     * every scope failed.
     */
    async readAll({ previous = null, now = new Date() } = {}) {
      let scopes;
      try {
        scopes = parseScopes(env);
      } catch (error) {
        return { available: false, reason: storedFailure(error, `${SCOPES_SETTING} could not be read.`), scopes: [] };
      }
      if (scopes.length === 0) {
        return {
          available: false,
          reason: `${SCOPES_SETTING} is not set, so this process knows no Azure scope to read.`,
          scopes: [],
        };
      }
      const results = await readScopes(arm, scopes, previous, now);
      const failedScopes = results.filter((row) => row.error);
      if (failedScopes.length === results.length) {
        return { available: false, reason: failedScopes[0].error, scopes: results };
      }
      return { available: true, reason: null, scopes: results };
    },
  };
}
