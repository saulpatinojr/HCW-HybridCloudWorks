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
import { DefaultAzureCredential } from '@azure/identity';
import { fetchWithTimeout } from '../http/fetch-with-timeout.js';
import { AuthoredError, storedFailure } from '../http/error-response.js';
import { money, percent } from './model.js';

export const ARM_ORIGIN = 'https://management.azure.com';
export const ARM_SCOPE = 'https://management.azure.com/.default';
export const BUDGETS_API_VERSION = '2023-11-01';
export const QUERY_API_VERSION = '2023-11-01';
/** Cost Management can take several seconds on a cold query; this is the ceiling. */
export const ARM_TIMEOUT_MS = 20_000;
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

/** ARM answered something other than 2xx; describeArmStatus wrote the sentence, no ARM text is in it. */
export class ArmStatusError extends AuthoredError {
  constructor(status) {
    super(describeArmStatus(status), { code: 'ARM_STATUS' });
    this.status = status;
  }
}

function invalidScopes(reason) {
  return new CostScopesError(reason);
}

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
 * The first budget of a scope as the page shows it, or null when the scope
 * has none. A scope here has one budget by design (infra/budget.tf,
 * infra/foundry.tf); when it has several the first by name is shown.
 */
export function summarizeBudgets(payload) {
  const budgets = Array.isArray(payload?.value) ? payload.value : [];
  const monthly = budgets
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

/** What a non-2xx answer means, as a sentence the page may show (no ARM text is copied). */
export function describeArmStatus(status) {
  if (status === 401 || status === 403) {
    return `Azure refused the read (HTTP ${status}): the Function App's identity needs the Cost Management Reader role on this scope.`;
  }
  if (status === 404) return 'Azure answered 404: the scope does not exist or is not visible to this identity.';
  if (status === 429) return 'Azure rate-limited the read (HTTP 429); the next refresh will try again.';
  return `Azure answered HTTP ${status}.`;
}

/**
 * @param {object} [deps]
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {Function} [deps.fetchImpl]
 * @param {{ getToken: Function }} [deps.credential] test seam; production builds DefaultAzureCredential lazily
 */
export function createAzureCostReader({ env = process.env, fetchImpl = globalThis.fetch, credential } = {}) {
  let cached = credential ?? null;
  const getCredential = () => (cached ??= new DefaultAzureCredential());

  async function armFetch(path, init = {}) {
    const token = await getCredential().getToken(ARM_SCOPE);
    if (!token?.token) throw new Error(`Could not acquire a token for ${ARM_SCOPE}`);
    const response = await fetchWithTimeout(fetchImpl, `${ARM_ORIGIN}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
      timeoutMs: ARM_TIMEOUT_MS,
    });
    if (!response.ok) throw new ArmStatusError(response.status);
    return response.json();
  }

  const query = (scope, body) =>
    armFetch(`${scope}/providers/Microsoft.CostManagement/query?api-version=${QUERY_API_VERSION}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

  const aggregation = { totalCost: { name: 'PreTaxCost', function: 'Sum' } };

  /**
   * One scope's figures. Never throws: a failed read is `{ error }` with the
   * figures null, so one scope that cannot be read never hides the others.
   */
  async function readScope(scope) {
    const base = {
      id: scope.id,
      label: scope.label,
      kind: scope.kind,
      name: scope.name,
      monthToDate: null,
      previousMonth: null,
      budget: null,
      byService: [],
      daily: [],
      error: null,
    };
    try {
      const [budgets, usage, lastMonth] = await Promise.all([
        armFetch(`${scope.scope}/providers/Microsoft.Consumption/budgets?api-version=${BUDGETS_API_VERSION}`),
        query(scope.scope, {
          type: 'ActualCost',
          timeframe: 'MonthToDate',
          dataset: {
            granularity: 'Daily',
            aggregation,
            grouping: [
              { type: 'Dimension', name: 'ResourceGroupName' },
              { type: 'Dimension', name: 'ServiceName' },
            ],
          },
        }),
        query(scope.scope, {
          type: 'ActualCost',
          timeframe: 'TheLastMonth',
          dataset: { granularity: 'None', aggregation },
        }),
      ]);
      const summary = summarizeUsage(usage);
      return {
        ...base,
        monthToDate: summary.monthToDate,
        byService: summary.byService,
        daily: summary.daily,
        previousMonth: totalOf(lastMonth),
        budget: summarizeBudgets(budgets),
      };
    } catch (error) {
      return {
        ...base,
        error: error?.code === 'FETCH_TIMEOUT' ? TIMEOUT_SENTENCE : storedFailure(error, UNREADABLE_SENTENCE),
        errorCode: error?.code ?? 'error',
      };
    }
  }

  return {
    /** The configured scopes (parseScopes), so a caller can say "nothing configured" without reading. */
    scopes() {
      return parseScopes(env);
    },

    /**
     * Every configured scope, read together. `available` is false, with a
     * `reason`, when no scope is configured, the setting is malformed, or
     * every scope failed.
     */
    async readAll() {
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
      const results = await Promise.all(scopes.map((scope) => readScope(scope)));
      const failed = results.filter((row) => row.error);
      if (failed.length === results.length) {
        return { available: false, reason: failed[0].error, scopes: results };
      }
      return { available: true, reason: null, scopes: results };
    },
  };
}
