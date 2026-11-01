import { describe, expect, it, vi } from 'vitest';
import { memoryStore } from '../../../test/memory-store.js';

import { LEDGER_DOC_ID } from './ledger-store.js';
import { SNAPSHOT_DOC_ID } from './snapshot.js';
import { COST_SOURCE, SIGNAL_CHECK_INTERVAL_MS, createCostWatch, digestMessage } from './watch.js';

const NOW = new Date('2026-11-01T09:00:00Z');
const hot = {
  available: true,
  scopes: [
    { id: 'app', label: 'App', kind: 'subscription', monthToDate: 140, error: null, budget: { amount: 150, currentSpend: 140, forecastSpend: 150, percentUsed: 93.3, percentForecast: 100 } },
  ],
};

function setup({ snapshot, settings = {}, sent = true, refresh } = {}) {
  const initial = {
    [`admin_config/${LEDGER_DOC_ID}`]: { id: LEDGER_DOC_ID, items: [], settings },
    ...(snapshot ? { [`admin_config/${SNAPSHOT_DOC_ID}`]: { id: SNAPSHOT_DOC_ID, ...snapshot } } : {}),
  };
  const store = memoryStore(initial);
  const notifier = { notifyTelegram: vi.fn(async () => ({ sent })) };
  const refreshFn =
    refresh ??
    vi.fn(async ({ store: s }) => {
      const current = await s.readDoc('admin_config', SNAPSHOT_DOC_ID);
      const doc = { ...(current ?? { id: SNAPSHOT_DOC_ID }), readAt: NOW.toISOString(), azure: hot, ai: null, sources: [] };
      await s.upsertDoc('admin_config', doc);
      return s.readDoc('admin_config', SNAPSHOT_DOC_ID);
    });
  const log = { warn: vi.fn() };
  const watch = createCostWatch({ store, notifier, now: () => NOW, log, refresh: refreshFn, env: {} });
  return { store, notifier, watch, refresh: refreshFn, log };
}

describe('digestMessage', () => {
  it('lists the three figures and says when one was not read', () => {
    const text = digestMessage('2026-10', { azureMonthToDate: 36.81, aiCostUsd: null, servicesMonthly: 85.5 });
    expect(text).toContain('USD 36.81');
    expect(text).toContain('AI usage (site estimate): not read');
    expect(text).toContain('USD 85.50 a month');
  });
});

describe('createCostWatch', () => {
  it('refreshes a missing snapshot, tells each warning once, and remembers it', async () => {
    const { store, notifier, watch } = setup();
    const outcome = await watch.checkIfDue();
    expect(outcome).toEqual({ checked: true, refreshed: true, told: 2, digest: null });
    expect(notifier.notifyTelegram).toHaveBeenCalledWith(
      expect.objectContaining({ source: COST_SOURCE, severity: 'critical', title: expect.stringContaining('App is at 93%') })
    );
    const doc = store.get('admin_config', SNAPSHOT_DOC_ID);
    expect(Object.keys(doc.notified).sort()).toEqual(['azure:app:actual:90', 'azure:app:forecast:100']);
    expect(doc.lastSignalCheckAt).toBe(NOW.toISOString());
  });

  it('is not due again until the check interval passes, and does not repeat a told signal', async () => {
    const { notifier, watch } = setup({
      snapshot: {
        readAt: NOW.toISOString(),
        lastSignalCheckAt: new Date(NOW.getTime() - 60_000).toISOString(),
        azure: hot,
        notified: {},
      },
    });
    expect(await watch.checkIfDue()).toEqual({ checked: false, reason: 'not due' });

    const later = setup({
      snapshot: {
        readAt: NOW.toISOString(),
        lastSignalCheckAt: new Date(NOW.getTime() - SIGNAL_CHECK_INTERVAL_MS).toISOString(),
        azure: hot,
        notified: { 'azure:app:actual:90': 'x', 'azure:app:forecast:100': 'x', 'gone:signal': 'x' },
      },
    });
    const outcome = await later.watch.checkIfDue();
    expect(outcome).toMatchObject({ checked: true, refreshed: false, told: 0 });
    expect(later.notifier.notifyTelegram).not.toHaveBeenCalled();
    // A signal that is no longer true is forgotten, so it is told again if it comes back.
    expect(Object.keys(later.store.get('admin_config', SNAPSHOT_DOC_ID).notified)).not.toContain('gone:signal');
    expect(notifier.notifyTelegram).not.toHaveBeenCalled();
  });

  it('records nothing for a send that did not go, and says nothing with Telegram off', async () => {
    const unsent = setup({ sent: false });
    await unsent.watch.checkIfDue();
    expect(unsent.store.get('admin_config', SNAPSHOT_DOC_ID).notified).toEqual({});

    const quiet = setup({ settings: { telegram: false, monthlyDigest: false } });
    expect(await quiet.watch.checkIfDue()).toMatchObject({ told: 0 });
    expect(quiet.notifier.notifyTelegram).not.toHaveBeenCalled();
  });

  it('sends last month’s closing digest once', async () => {
    const snapshot = {
      readAt: NOW.toISOString(),
      azure: { available: true, scopes: [] },
      months: { '2026-10': { azureMonthToDate: 36.81, aiCostUsd: 2.1, servicesMonthly: 50 } },
    };
    const first = setup({ snapshot });
    expect(await first.watch.checkIfDue()).toMatchObject({ digest: '2026-10' });
    expect(first.notifier.notifyTelegram).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Costs for 2026-10 (closing figures)', severity: 'info' })
    );
    expect(first.store.get('admin_config', SNAPSHOT_DOC_ID).digestSentFor).toBe('2026-10');

    const again = setup({ snapshot: { ...snapshot, digestSentFor: '2026-10' } });
    expect(await again.watch.checkIfDue()).toMatchObject({ digest: null });
  });

  it('keeps going when the refresh fails, and never throws', async () => {
    const failing = setup({ refresh: vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'ARM' }); }) });
    expect(await failing.watch.checkIfDue()).toMatchObject({ checked: true, refreshed: false });
    expect(failing.log.warn).toHaveBeenCalledWith(expect.stringContaining('(ARM)'));

    const broken = setup();
    broken.store.fail('admin_config', SNAPSHOT_DOC_ID, 'readDoc', Object.assign(new Error('down'), { code: 503 }));
    expect(await broken.watch.checkIfDue()).toEqual({ checked: false, reason: 'failed' });
  });

  it('says nothing without a notifier', async () => {
    const { store } = setup();
    const watch = createCostWatch({ store, notifier: null, now: () => NOW, refresh: async () => null, env: {} });
    expect(await watch.checkIfDue()).toMatchObject({ checked: true, told: 0 });
  });
});
