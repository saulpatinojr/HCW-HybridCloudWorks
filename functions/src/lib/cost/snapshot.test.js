import { describe, expect, it, vi } from 'vitest';
import { memoryStore } from '../../../test/memory-store.js';

import { DEFAULT_SETTINGS } from './ledger-store.js';
import {
  MIN_REFRESH_INTERVAL_MS,
  SNAPSHOT_DOC_ID,
  buildSummary,
  changeSnapshot,
  forecastFor,
  presentAi,
  presentAzure,
  presentHistory,
  refreshAllowed,
  refreshSnapshot,
} from './snapshot.js';

const NOW = new Date('2026-11-10T12:00:00Z');
const period = { month: '2026-11', daysElapsed: 10, daysInMonth: 30, today: '2026-11-10' };
const ledger = (items = [], settings = {}) => ({ items, settings: { ...DEFAULT_SETTINGS, ...settings } });

const scopes = [
  { id: 'app', label: 'App', kind: 'subscription', monthToDate: 10, previousMonth: 30, budget: { amount: 150, forecastSpend: 33, percentUsed: 6.7 }, error: null },
  { id: 'mgmt', label: 'Mgmt', kind: 'subscription', monthToDate: 1, previousMonth: 2.5, budget: null, error: null },
  { id: 'foundry', label: 'Foundry', kind: 'resourceGroup', monthToDate: 2, previousMonth: 5, budget: { amount: 75, forecastSpend: 0, percentUsed: 2.7 }, error: null },
  { id: 'broken', label: 'Broken', kind: 'subscription', monthToDate: null, error: 'HTTP 403' },
];

describe('forecasts and totals', () => {
  it('prefers Azure’s own forecast, else a straight line, else nothing', () => {
    expect(forecastFor(scopes[0], period)).toEqual({ forecast: 33, forecastMethod: 'azure' });
    expect(forecastFor(scopes[1], period)).toEqual({ forecast: 3, forecastMethod: 'straight-line' });
    expect(forecastFor(scopes[2], period)).toEqual({ forecast: 6, forecastMethod: 'straight-line' });
    expect(forecastFor(scopes[3], period)).toEqual({ forecast: null, forecastMethod: null });
    expect(forecastFor({ monthToDate: null, error: null }, period)).toEqual({ forecast: null, forecastMethod: null });
  });

  it('totals the readable subscriptions only (a resource group is inside one)', () => {
    const azure = presentAzure({ available: true, reason: null, scopes }, period);
    expect(azure.totals).toEqual({ monthToDate: 11, forecast: 36, budget: 150, previousMonth: 32.5 });
    expect(presentAzure(null, period)).toMatchObject({ available: false, neverRead: true, totals: null });
    expect(presentAzure({ available: false, reason: 'x', scopes: [] }, period).totals).toBeNull();
    expect(presentAzure({ available: true, scopes: [scopes[1]] }, period).totals.budget).toBeNull();
  });

  it('copies the Foundry scope into its AI card, or leaves it empty', () => {
    const azure = presentAzure({ available: true, scopes }, period);
    const card = { id: 'foundry', kind: 'azure-budget', scopeId: 'foundry', configured: false };
    const other = { id: 'gemini', kind: 'ledger' };
    expect(presentAi({ providers: [card, other] }, azure, 20).providers).toEqual([
      { ...card, configured: true, monthToDate: 2, budget: 75, forecast: 6, percentUsed: 2.7 },
      other,
    ]);
    expect(presentAi({ providers: [card] }, { scopes: [] }, null).providers[0]).toMatchObject({ monthToDate: null, budget: null });
    expect(presentAi(null, null, 5)).toMatchObject({ budgetUsd: 5, providers: [] });
  });
});

describe('presentHistory', () => {
  it('lists closed months, newest first, without the current one', () => {
    const months = { '2026-09': { azureMonthToDate: 36.81 }, '2026-11': { azureMonthToDate: 1 }, '2026-10': { aiCostUsd: 2 } };
    expect(presentHistory(months, '2026-11').map((m) => m.month)).toEqual(['2026-10', '2026-09']);
    expect(presentHistory(months, '2026-11')[1]).toEqual({ month: '2026-09', azureMonthToDate: 36.81, aiCostUsd: null, servicesMonthly: null, readAt: null });
    expect(presentHistory(undefined, '2026-11')).toEqual([]);
  });
});

describe('buildSummary', () => {
  it('answers before any snapshot exists, with the ledger live', () => {
    const summary = buildSummary({
      snapshot: null,
      ledger: ledger([{ id: 'c', name: 'Cloudflare', amount: 20, cycle: 'monthly', nextRenewal: '2026-11-12' }]),
      now: NOW,
    });
    expect(summary).toMatchObject({ readAt: null, stale: true, currency: 'USD', history: [] });
    expect(summary.period.month).toBe('2026-11');
    expect(summary.services.monthlyEquivalent).toBe(20);
    expect(summary.signals.map((s) => s.id)).toEqual(['data:never-read', 'service:c:soon']);
    expect(summary.sources.map((s) => s.id)).toEqual(['services']);
    expect(summary.settings).toEqual(DEFAULT_SETTINGS);
  });
});

describe('the snapshot document', () => {
  it('creates, then replaces under the ETag, then writes nothing for a null change', async () => {
    const store = memoryStore();
    await changeSnapshot(store, () => ({ readAt: 'a' }));
    expect(store.get('admin_config', SNAPSHOT_DOC_ID)).toMatchObject({ readAt: 'a', configScope: 'admin_config', docType: 'cost_snapshot' });
    await changeSnapshot(store, (doc) => ({ ...doc, readAt: 'b' }));
    expect(store.get('admin_config', SNAPSHOT_DOC_ID).readAt).toBe('b');
    expect(await changeSnapshot(store, () => null)).toMatchObject({ readAt: 'b' });
  });

  it('retries a lost race and rethrows anything else', async () => {
    const store = memoryStore({ [`admin_config/${SNAPSHOT_DOC_ID}`]: { id: SNAPSHOT_DOC_ID } });
    store.fail('admin_config', SNAPSHOT_DOC_ID, 'replaceDocIfMatch', Object.assign(new Error('p'), { code: 412 }));
    await expect(changeSnapshot(store, (doc) => ({ ...doc, x: 1 }))).resolves.toMatchObject({ x: 1 });
    store.fail('admin_config', SNAPSHOT_DOC_ID, 'replaceDocIfMatch', Object.assign(new Error('d'), { code: 503 }));
    await expect(changeSnapshot(store, (doc) => ({ ...doc, x: 2 }))).rejects.toMatchObject({ code: 503 });
  });

  it('refreshes from both readers, records the month, and keeps the watch’s records', async () => {
    const store = memoryStore({
      [`admin_config/${SNAPSHOT_DOC_ID}`]: {
        id: SNAPSHOT_DOC_ID,
        notified: { 'azure:app:actual:75': '2026-11-09T00:00:00Z' },
        digestSentFor: '2026-10',
        months: Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`2025-${String(i % 12 + 1).padStart(2, '0')}${i >= 12 ? 'x' : ''}`, {}])),
      },
    });
    const azureReader = { readAll: vi.fn(async () => ({ available: true, reason: null, scopes })) };
    const readAi = vi.fn(async () => ({
      ai: { monthToDate: { costUsd: 1.5 }, previousMonth: null, providers: [] },
      sources: [{ id: 'ai-ledger', ok: true, error: null }],
    }));
    const doc = await refreshSnapshot({ store, ledger: ledger([], { aiMonthlyBudgetUsd: 9 }), now: () => NOW, azureReader, readAi, env: {} });
    expect(readAi).toHaveBeenCalledWith(expect.objectContaining({ budgetUsd: 9 }));
    expect(doc).toMatchObject({
      readAt: NOW.toISOString(),
      lastRefreshAt: NOW.toISOString(),
      digestSentFor: '2026-10',
      notified: { 'azure:app:actual:75': '2026-11-09T00:00:00Z' },
    });
    expect(doc.sources.map((s) => s.id)).toEqual(['azure', 'ai-ledger']);
    expect(doc.months['2026-11']).toEqual({ azureMonthToDate: 11, aiCostUsd: 1.5, servicesMonthly: 0, readAt: NOW.toISOString() });
    expect(Object.keys(doc.months)).toHaveLength(13);
  });

  it('records an unavailable Azure as a failed source', async () => {
    const store = memoryStore();
    const doc = await refreshSnapshot({
      store,
      ledger: ledger(),
      now: () => NOW,
      azureReader: { readAll: async () => ({ available: false, reason: 'not set', scopes: [] }) },
      readAi: async () => ({ ai: null, sources: [] }),
    });
    expect(doc.sources[0]).toMatchObject({ id: 'azure', ok: false, error: 'not set' });
    expect(doc.months['2026-11'].azureMonthToDate).toBeNull();
  });
});

describe('refreshAllowed', () => {
  it('allows the first refresh and one every five minutes after', () => {
    expect(refreshAllowed(null, NOW)).toEqual({ allowed: true, nextRefreshAt: null });
    const recent = { lastRefreshAt: new Date(NOW.getTime() - 60_000).toISOString() };
    expect(refreshAllowed(recent, NOW)).toEqual({
      allowed: false,
      nextRefreshAt: new Date(NOW.getTime() - 60_000 + MIN_REFRESH_INTERVAL_MS).toISOString(),
    });
    expect(refreshAllowed({ lastRefreshAt: '2026-11-10T00:00:00Z' }, NOW).allowed).toBe(true);
  });
});
