/**
 * The Azure cost reader: the scopes setting, the shape of Cost Management's
 * answers, and what one failing scope does to the others. ARM is a fake fetch;
 * the credential is a stub, so nothing here needs Azure.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  ARM_ORIGIN,
  BUDGETS_API_VERSION,
  MAX_ATTEMPTS,
  RETRY_WAIT_CAP_MS,
  RETRY_WAIT_DEFAULT_MS,
  QUERY_API_VERSION,
  createAzureCostReader,
  describeArmStatus,
  parseScopes,
  retryAfterMs,
  rowsOf,
  summarizeBudgets,
  summarizeUsage,
  totalOf,
  usageDateOf,
} from './azure.js';

const APP = '00000000-0000-0000-0000-000000000001';
const MGMT = '00000000-0000-0000-0000-000000000002';
const SCOPES = JSON.stringify([
  { id: 'app', label: 'Application subscription', scope: `/subscriptions/${APP}`, kind: 'subscription', name: 'sub-app' },
  { id: 'mgmt', label: 'Platform Management', scope: `/subscriptions/${MGMT}`, kind: 'subscription' },
  {
    id: 'foundry',
    label: 'Microsoft Foundry',
    scope: `/subscriptions/${APP}/resourceGroups/rg-ai-site-prod-cus`,
    kind: 'resourceGroup',
  },
]);

describe('parseScopes', () => {
  it('reads the list and leaves name null when not given', () => {
    const scopes = parseScopes({ COST_SCOPES: SCOPES });
    expect(scopes.map((s) => s.id)).toEqual(['app', 'mgmt', 'foundry']);
    expect(scopes[0].name).toBe('sub-app');
    expect(scopes[1].name).toBeNull();
  });

  it('is empty without the setting', () => {
    expect(parseScopes({})).toEqual([]);
    expect(parseScopes({ COST_SCOPES: '  ' })).toEqual([]);
  });

  it.each([
    ['not json', 'not JSON'],
    ['{}', 'not a list'],
    ['[1]', 'not an object'],
    [JSON.stringify([{ id: 'Bad Id', label: 'x', scope: `/subscriptions/${APP}`, kind: 'subscription' }]), 'usable id'],
    [JSON.stringify([{ id: 'a', label: '', scope: `/subscriptions/${APP}`, kind: 'subscription' }]), 'usable label'],
    [JSON.stringify([{ id: 'a', label: 'x', scope: '/subscriptions/nope', kind: 'subscription' }]), 'usable scope'],
    [JSON.stringify([{ id: 'a', label: 'x', scope: `/subscriptions/${APP}`, kind: 'tenant' }]), 'usable kind'],
    [
      JSON.stringify([
        { id: 'a', label: 'x', scope: `/subscriptions/${APP}`, kind: 'subscription' },
        { id: 'a', label: 'y', scope: `/subscriptions/${MGMT}`, kind: 'subscription' },
      ]),
      'repeats the id',
    ],
  ])('refuses a malformed setting (%s)', (raw, reason) => {
    expect(() => parseScopes({ COST_SCOPES: raw })).toThrow(
      expect.objectContaining({ code: 'COST_SCOPES_INVALID', message: expect.stringContaining(reason) })
    );
  });
});

const usagePayload = {
  properties: {
    columns: [
      { name: 'PreTaxCost', type: 'Number' },
      { name: 'UsageDate', type: 'Number' },
      { name: 'ResourceGroupName', type: 'String' },
      { name: 'ServiceName', type: 'String' },
      { name: 'Currency', type: 'String' },
    ],
    rows: [
      [1.5, 20261101, 'RG-WEB-SITE-PROD-CUS', 'Storage', 'USD'],
      [0.5, 20261101, 'rg-web-site-prod-cus', 'Functions', 'USD'],
      [2.25, 20261102, 'rg-web-site-prod-cus', 'Storage', 'USD'],
      [0.0, 20261102, 'rg-db-site-prod-cus', 'Azure Cosmos DB', 'USD'],
      ['x', 20261102, 'rg-db-site-prod-cus', 'Bad', 'USD'],
      [0.75, 'bad-date', '', '', 'USD'],
    ],
  },
};

describe('the query answers', () => {
  it('turns columns and rows into objects keyed by column', () => {
    expect(rowsOf(usagePayload)[0]).toEqual({
      pretaxcost: 1.5,
      usagedate: 20261101,
      resourcegroupname: 'RG-WEB-SITE-PROD-CUS',
      servicename: 'Storage',
      currency: 'USD',
    });
    expect(rowsOf({})).toEqual([]);
    expect(usageDateOf(20261101)).toBe('2026-11-01');
    expect(usageDateOf('x')).toBeNull();
  });

  it('adds the month up by service (case-folded resource group) and by day, dropping zero and unreadable rows', () => {
    const summary = summarizeUsage(usagePayload);
    expect(summary.monthToDate).toBe(5);
    expect(summary.byService).toEqual([
      { resourceGroup: 'rg-web-site-prod-cus', service: 'Storage', cost: 3.75 },
      { resourceGroup: '(none)', service: '(unnamed)', cost: 0.75 },
      { resourceGroup: 'rg-web-site-prod-cus', service: 'Functions', cost: 0.5 },
    ]);
    expect(summary.daily).toEqual([
      { date: '2026-11-01', cost: 2 },
      { date: '2026-11-02', cost: 2.25 },
    ]);
  });

  it('totals a grouping-free answer', () => {
    expect(
      totalOf({ properties: { columns: [{ name: 'PreTaxCost' }, { name: 'Currency' }], rows: [[34.3201, 'USD']] } })
    ).toBe(34.32);
    expect(totalOf(null)).toBe(0);
  });
});

describe('summarizeBudgets', () => {
  const budgetPayload = {
    value: [
      {
        name: 'site-monthly-budget',
        properties: {
          amount: 150,
          timeGrain: 'Monthly',
          currentSpend: { amount: 12.3456, unit: 'USD' },
          forecastSpend: { amount: 38.1, unit: 'USD' },
          notifications: {
            a50: { enabled: true, threshold: 50, thresholdType: 'Actual' },
            a75: { enabled: true, threshold: 75 },
            off: { enabled: false, threshold: 90, thresholdType: 'Actual' },
            f100: { enabled: true, threshold: 100, thresholdType: 'Forecasted' },
            dup: { enabled: true, threshold: 50, thresholdType: 'Actual' },
          },
        },
      },
    ],
  };

  it('reads amount, spend, forecast and the threshold ladders', () => {
    expect(summarizeBudgets(budgetPayload)).toEqual({
      name: 'site-monthly-budget',
      amount: 150,
      currentSpend: 12.35,
      forecastSpend: 38.1,
      percentUsed: 8.2,
      percentForecast: 25.4,
      thresholds: [50, 75],
      forecastThresholds: [100],
    });
  });

  it('is null with no monthly budget, and tolerates a missing forecast', () => {
    expect(summarizeBudgets({ value: [] })).toBeNull();
    expect(summarizeBudgets({ value: [{ name: 'q', properties: { amount: 1, timeGrain: 'Quarterly' } }] })).toBeNull();
    const noForecast = summarizeBudgets({
      value: [{ name: 'b', properties: { amount: 10, currentSpend: { amount: 1 } } }],
    });
    expect(noForecast.forecastSpend).toBeNull();
    expect(noForecast.percentForecast).toBeNull();
    expect(noForecast.thresholds).toEqual([]);
  });

  it('shows the first budget by name when a scope has several', () => {
    const two = summarizeBudgets({
      value: [
        { name: 'zz', properties: { amount: 5, currentSpend: { amount: 1 } } },
        { name: 'aa', properties: { amount: 7, currentSpend: { amount: 2 } } },
      ],
    });
    expect(two.name).toBe('aa');
  });
});

describe('describeArmStatus', () => {
  it('names the role for a refusal and says what the others mean', () => {
    expect(describeArmStatus(403)).toContain('Cost Management Reader');
    expect(describeArmStatus(401)).toContain('HTTP 401');
    expect(describeArmStatus(404)).toContain('404');
    expect(describeArmStatus(429)).toContain('HTTP 429');
    expect(describeArmStatus(429)).toContain('Azure portal');
    expect(describeArmStatus(500)).toBe('Azure answered HTTP 500.');
  });
});

/** A fake ARM: answers by path, records every request, and can refuse one scope. */
function fakeArm({ refuse = {} } = {}) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init) => {
    calls.push({ url, init });
    const path = url.replace(ARM_ORIGIN, '');
    for (const [needle, status] of Object.entries(refuse)) {
      if (path.includes(needle)) return { ok: false, status, json: async () => ({}) };
    }
    if (path.includes('/budgets?')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          value: [{ name: 'b', properties: { amount: 150, currentSpend: { amount: 12 }, forecastSpend: { amount: 30 } } }],
        }),
      };
    }
    const body = JSON.parse(init.body);
    if (body.timeframe === 'TheLastMonth') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ properties: { columns: [{ name: 'PreTaxCost' }, { name: 'Currency' }], rows: [[34.32, 'USD']] } }),
      };
    }
    return { ok: true, status: 200, json: async () => usagePayload };
  });
  return { fetchImpl, calls };
}

const credential = { getToken: vi.fn(async () => ({ token: 'tok' })) };

describe('createAzureCostReader', () => {
  it('reads every scope with the identity token and the documented api-versions', async () => {
    const arm = fakeArm();
    const reader = createAzureCostReader({ env: { COST_SCOPES: SCOPES }, fetchImpl: arm.fetchImpl, credential });
    expect(reader.scopes()).toHaveLength(3);
    const result = await reader.readAll();
    expect(result.available).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.scopes).toHaveLength(3);
    const app = result.scopes[0];
    expect(app).toMatchObject({
      id: 'app',
      label: 'Application subscription',
      kind: 'subscription',
      name: 'sub-app',
      monthToDate: 5,
      previousMonth: 34.32,
      error: null,
    });
    expect(app.budget.amount).toBe(150);
    expect(app.daily).toHaveLength(2);
    // Three calls a scope: budgets, this month by day and service, last month's total.
    expect(arm.calls).toHaveLength(9);
    expect(arm.calls.every((c) => c.init.headers.Authorization === 'Bearer tok')).toBe(true);
    expect(arm.calls.some((c) => c.url.includes(`/budgets?api-version=${BUDGETS_API_VERSION}`))).toBe(true);
    expect(arm.calls.some((c) => c.url.includes(`/query?api-version=${QUERY_API_VERSION}`))).toBe(true);
    const usageQuery = JSON.parse(arm.calls.find((c) => c.init.method === 'POST').init.body);
    expect(usageQuery).toMatchObject({ type: 'ActualCost', timeframe: 'MonthToDate' });
    expect(usageQuery.dataset.grouping.map((g) => g.name)).toEqual(['ResourceGroupName', 'ServiceName']);
    // The scope path (with the subscription id) never comes back in the answer.
    expect(JSON.stringify(result)).not.toContain(APP);
  });

  it('answers "not configured" without touching the credential', async () => {
    const arm = fakeArm();
    const reader = createAzureCostReader({ env: {}, fetchImpl: arm.fetchImpl, credential: { getToken: vi.fn() } });
    const result = await reader.readAll();
    expect(result).toEqual({ available: false, reason: expect.stringContaining('COST_SCOPES is not set'), scopes: [] });
    expect(arm.calls).toHaveLength(0);
  });

  it('says the setting is malformed rather than reading nothing silently', async () => {
    const reader = createAzureCostReader({ env: { COST_SCOPES: '[nope' }, fetchImpl: vi.fn(), credential });
    const result = await reader.readAll();
    expect(result.available).toBe(false);
    expect(result.reason).toContain('COST_SCOPES could not be read');
  });

  it('costs only the refused scope its figures, naming the role', async () => {
    const arm = fakeArm({ refuse: { [MGMT]: 403 } });
    const reader = createAzureCostReader({ env: { COST_SCOPES: SCOPES }, fetchImpl: arm.fetchImpl, credential });
    const result = await reader.readAll();
    expect(result.available).toBe(true);
    const mgmt = result.scopes.find((s) => s.id === 'mgmt');
    expect(mgmt.error).toContain('Cost Management Reader');
    expect(mgmt.errorCode).toBe('ARM_STATUS');
    expect(mgmt.monthToDate).toBeNull();
    expect(result.scopes.find((s) => s.id === 'app').monthToDate).toBe(5);
  });

  it('is unavailable, with the first scope’s reason, when every scope fails', async () => {
    const arm = fakeArm({ refuse: { '/subscriptions/': 401 } });
    const reader = createAzureCostReader({ env: { COST_SCOPES: SCOPES }, fetchImpl: arm.fetchImpl, credential });
    const result = await reader.readAll();
    expect(result.available).toBe(false);
    expect(result.reason).toContain('HTTP 401');
    expect(result.scopes).toHaveLength(3);
  });

  it('words a timeout and an unexpected failure without copying their text', async () => {
    const timeout = Object.assign(new Error('timeout after 20000 ms'), { code: 'FETCH_TIMEOUT' });
    const reader = createAzureCostReader({
      env: { COST_SCOPES: JSON.stringify([{ id: 'a', label: 'A', scope: `/subscriptions/${APP}`, kind: 'subscription' }]) },
      fetchImpl: vi.fn(async () => {
        throw timeout;
      }),
      credential,
    });
    const timedOut = await reader.readAll();
    expect(timedOut.scopes[0].error).toContain('did not answer in time');

    const broken = createAzureCostReader({
      env: { COST_SCOPES: JSON.stringify([{ id: 'a', label: 'A', scope: `/subscriptions/${APP}`, kind: 'subscription' }]) },
      fetchImpl: vi.fn(async () => {
        throw new Error('ECONNRESET secret-host');
      }),
      credential,
    });
    const other = await broken.readAll();
    expect(other.scopes[0].error).toMatch(/^Azure could not be read; the next refresh will try again \(/);
    expect(JSON.stringify(other)).not.toContain('secret-host');
  });

  it('fails a scope when no token can be minted', async () => {
    const reader = createAzureCostReader({
      env: { COST_SCOPES: JSON.stringify([{ id: 'a', label: 'A', scope: `/subscriptions/${APP}`, kind: 'subscription' }]) },
      fetchImpl: vi.fn(),
      credential: { getToken: vi.fn(async () => null) },
    });
    const result = await reader.readAll();
    expect(result.available).toBe(false);
    expect(result.scopes[0].errorCode).toBe('error');
  });
});

describe('living within Cost Management’s rate limits (2026-11-03)', () => {
  const ONE_SCOPE = JSON.stringify([{ id: 'app', label: 'App', scope: `/subscriptions/${APP}`, kind: 'subscription' }]);
  const NOW = new Date('2026-11-03T03:30:00Z');
  const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
  const throttled = (headers = {}) => ({
    ok: false,
    status: 429,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => ({}),
  });
  const budgetBody = { value: [{ name: 'b', properties: { amount: 150, currentSpend: { amount: 12 }, forecastSpend: { amount: 30 } } }] };
  const lastMonthBody = { properties: { columns: [{ name: 'PreTaxCost' }], rows: [[34.32]] } };
  const answer = (url, init) => {
    if (url.includes('/budgets?')) return ok(budgetBody);
    return JSON.parse(init.body).timeframe === 'TheLastMonth' ? ok(lastMonthBody) : ok(usagePayload);
  };

  it('reads the wait from the QPU header, then Retry-After, then a default, and caps it', () => {
    const headers = (h) => ({ get: (name) => h[name] ?? null });
    expect(retryAfterMs(headers({ 'x-ms-ratelimit-microsoft.costmanagement-qpu-retry-after': '4' }))).toBe(4000);
    expect(retryAfterMs(headers({ 'retry-after': '7' }))).toBe(7000);
    expect(retryAfterMs(headers({}))).toBe(RETRY_WAIT_DEFAULT_MS);
    expect(retryAfterMs(headers({ 'retry-after': '600' }))).toBe(RETRY_WAIT_CAP_MS);
    expect(retryAfterMs(undefined)).toBe(RETRY_WAIT_DEFAULT_MS);
  });

  it('asks one question at a time, never two together', async () => {
    let inFlight = 0;
    let most = 0;
    const fetchImpl = vi.fn(async (url, init) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return answer(url, init);
    });
    const reader = createAzureCostReader({ env: { COST_SCOPES: SCOPES }, fetchImpl, credential });
    const result = await reader.readAll({ now: NOW });
    expect(result.available).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(9);
    expect(most).toBe(1);
  });

  it('waits as long as Azure asks after a 429 and tries once more', async () => {
    const sleep = vi.fn(async () => {});
    let first = true;
    const fetchImpl = vi.fn(async (url, init) => {
      if (first && !url.includes('/budgets?')) {
        first = false;
        return throttled({ 'x-ms-ratelimit-microsoft.costmanagement-qpu-retry-after': '3' });
      }
      return answer(url, init);
    });
    const reader = createAzureCostReader({ env: { COST_SCOPES: ONE_SCOPE }, fetchImpl, credential, sleep });
    const result = await reader.readAll({ now: NOW });
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(result.scopes[0]).toMatchObject({ monthToDate: 5, error: null, readAt: NOW.toISOString() });
  });

  it('gives up after MAX_ATTEMPTS and says it is the shared allowance, not the role', async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => throttled());
    const reader = createAzureCostReader({ env: { COST_SCOPES: ONE_SCOPE }, fetchImpl, credential, sleep });
    const result = await reader.readAll({ now: NOW });
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(result.available).toBe(false);
    expect(result.reason).toContain('HTTP 429');
    expect(result.reason).not.toContain('Cost Management Reader');
    expect(result.scopes[0]).toMatchObject({ errorStatus: 429 });
  });

  it('does not retry a refusal that waiting cannot fix', async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, headers: { get: () => null }, json: async () => ({}) }));
    const reader = createAzureCostReader({ env: { COST_SCOPES: ONE_SCOPE }, fetchImpl, credential, sleep });
    await reader.readAll({ now: NOW });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('reuses last month’s total read earlier this month instead of asking again', async () => {
    const fetchImpl = vi.fn(async (url, init) => answer(url, init));
    const reader = createAzureCostReader({ env: { COST_SCOPES: ONE_SCOPE }, fetchImpl, credential });
    const previous = { scopes: [{ id: 'app', error: null, previousMonth: 30.5, previousMonthOf: '2026-10', readAt: '2026-11-03T00:00:00Z' }] };
    const result = await reader.readAll({ previous, now: NOW });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.some(([, init]) => init.body && JSON.parse(init.body).timeframe === 'TheLastMonth')).toBe(false);
    expect(result.scopes[0]).toMatchObject({ previousMonth: 30.5, previousMonthOf: '2026-10' });

    // A total kept from a different month is asked for again.
    const stale = { scopes: [{ ...previous.scopes[0], previousMonthOf: '2026-09' }] };
    fetchImpl.mockClear();
    const again = await reader.readAll({ previous: stale, now: NOW });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(again.scopes[0]).toMatchObject({ previousMonth: 34.32, previousMonthOf: '2026-10' });
  });

  it('keeps this month’s last good figures when a refresh is refused, and says when they were read', async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => throttled());
    const reader = createAzureCostReader({ env: { COST_SCOPES: ONE_SCOPE }, fetchImpl, credential, sleep });
    const good = { id: 'app', label: 'Old label', error: null, monthToDate: 11, previousMonth: 30, previousMonthOf: '2026-10', budget: { amount: 150 }, byService: [], daily: [], readAt: '2026-11-03T00:10:00.000Z' };
    const result = await reader.readAll({ previous: { scopes: [good] }, now: NOW });
    expect(result.available).toBe(true);
    expect(result.scopes[0]).toMatchObject({ label: 'App', monthToDate: 11, error: null, noteCode: 'throttled' });
    expect(result.scopes[0].note).toContain('read at 2026-11-03 00:10 UTC');
    expect(result.scopes[0].note).toContain('HTTP 429');

    // Last month's figures are not kept into a new month.
    const october = { ...good, readAt: '2026-10-31T23:00:00.000Z' };
    const fresh = await reader.readAll({ previous: { scopes: [october] }, now: NOW });
    expect(fresh.available).toBe(false);
    expect(fresh.scopes[0].monthToDate).toBeNull();
  });
});
