import { describe, expect, it } from 'vitest';
import { memoryStore } from '../../../test/memory-store.js';

import {
  DEFAULT_SETTINGS,
  LEDGER_DOC_ID,
  WRITE_ATTEMPTS,
  changeLedger,
  normalizeSettings,
  readLedger,
  readState,
} from './ledger-store.js';

describe('normalizeSettings', () => {
  it('is the defaults for nothing, and keeps a stored value in range', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ aiMonthlyBudgetUsd: 20.556, renewalLeadDays: 14, telegram: false, monthlyDigest: false, refreshHours: 12 })).toEqual({
      aiMonthlyBudgetUsd: 20.56,
      renewalLeadDays: 14,
      telegram: false,
      monthlyDigest: false,
      refreshHours: 12,
    });
    expect(normalizeSettings({ aiMonthlyBudgetUsd: '' }).aiMonthlyBudgetUsd).toBeNull();
  });

  it('falls back to the default for a bad stored value, but refuses it from the page', () => {
    const lax = normalizeSettings({ renewalLeadDays: 999, refreshHours: 0, telegram: 'yes', aiMonthlyBudgetUsd: -1 });
    expect(lax).toEqual(DEFAULT_SETTINGS);
    for (const [body, message] of [
      [{ renewalLeadDays: 999 }, 'renewalLeadDays'],
      [{ refreshHours: 0 }, 'refreshHours'],
      [{ telegram: 'yes' }, 'telegram must be'],
      [{ monthlyDigest: 1 }, 'monthlyDigest must be'],
      [{ aiMonthlyBudgetUsd: -1 }, 'aiMonthlyBudgetUsd'],
      [{ nope: 1 }, 'Unknown setting'],
      [[], 'must be an object'],
    ]) {
      expect(() => normalizeSettings(body, { strict: true })).toThrow(
        expect.objectContaining({ status: 400, message: expect.stringContaining(message) })
      );
    }
    // Unknown keys are refused even when lax: a stored document with a stray key is still read.
    expect(() => normalizeSettings({ nope: 1 })).toThrow(/Unknown setting/);
  });
});

describe('the ledger document', () => {
  it('reads an absent or odd document as empty with defaults', async () => {
    expect(readState(null)).toEqual({ items: [], settings: DEFAULT_SETTINGS });
    expect(readState({ items: [null, 'x', { id: 'a' }], settings: { refreshHours: 3 } })).toEqual({
      items: [{ id: 'a' }],
      settings: { ...DEFAULT_SETTINGS, refreshHours: 3 },
    });
    expect(await readLedger(memoryStore())).toEqual({ items: [], settings: DEFAULT_SETTINGS });
  });

  it('creates the document on the first write and replaces it under its ETag after', async () => {
    const store = memoryStore();
    const now = () => new Date('2026-11-01T00:00:00Z');
    const first = await changeLedger(store, (state) => ({ write: true, state: { ...state, items: [{ id: 'a' }] } }), { now });
    expect(first.written).toBe(true);
    expect(store.createDoc).toHaveBeenCalledTimes(1);
    const stored = store.get('admin_config', LEDGER_DOC_ID);
    expect(stored).toMatchObject({ configScope: 'admin_config', docType: 'cost_ledger', items: [{ id: 'a' }], updatedAt: '2026-11-01T00:00:00.000Z' });

    const second = await changeLedger(store, (state) => ({ write: true, state: { ...state, items: [...state.items, { id: 'b' }] } }), { now });
    expect(second.state.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(1);

    const none = await changeLedger(store, (state) => ({ write: false, result: state.items.length }));
    expect(none).toEqual({ state: expect.any(Object), result: 2, written: false });
  });

  it('re-reads and re-applies after a lost race, and gives up after WRITE_ATTEMPTS', async () => {
    const store = memoryStore({ [`admin_config/${LEDGER_DOC_ID}`]: { id: LEDGER_DOC_ID, items: [] } });
    const conflict = Object.assign(new Error('precondition'), { code: 412 });
    store.fail('admin_config', LEDGER_DOC_ID, 'replaceDocIfMatch', conflict, 2);
    const calls = [];
    const outcome = await changeLedger(store, (state) => {
      calls.push(state.items.length);
      return { write: true, state: { ...state, items: [{ id: 'z' }] } };
    });
    expect(outcome.written).toBe(true);
    expect(calls).toHaveLength(3);

    store.fail('admin_config', LEDGER_DOC_ID, 'replaceDocIfMatch', conflict, WRITE_ATTEMPTS);
    await expect(changeLedger(store, (state) => ({ write: true, state }))).rejects.toMatchObject({ code: 'LEDGER_CONFLICT', status: 409 });

    store.fail('admin_config', LEDGER_DOC_ID, 'replaceDocIfMatch', Object.assign(new Error('down'), { code: 503 }));
    await expect(changeLedger(store, (state) => ({ write: true, state }))).rejects.toMatchObject({ code: 503 });
  });
});
