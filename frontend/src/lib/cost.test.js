/**
 * The Cost page's client: each fetch checks the server's shape, and the pure
 * rules the tabs share (money, budget tone, the monthly equivalent, the words
 * for each field) do what the contract says.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  COST_SERVICES_ROUTE,
  COST_SETTINGS_ROUTE,
  COST_SUMMARY_ROUTE,
  CATEGORIES,
  CYCLES,
  DEFAULT_SETTINGS,
  STATUSES,
  agoLabel,
  budgetTone,
  categoryLabel,
  createCostService,
  cycleLabel,
  deleteCostService,
  fetchCostServices,
  fetchCostSettings,
  fetchCostSummary,
  fmtUsd,
  monthLabel,
  monthlyEquivalent,
  percent,
  renewalLabel,
  saveCostSettings,
  severityTone,
  statusInfo,
  updateCostService,
} from './cost';
import { SUMMARY } from '@/components/admin/cost/fixture';

const getJSON = vi.fn();
const sendJSON = vi.fn();
vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  sendJSON: (...args) => sendJSON(...args),
}));

beforeEach(() => {
  getJSON.mockReset();
  sendJSON.mockReset();
});

describe('fmtUsd', () => {
  it('prints two decimals, four below a cent, and a dash for no number', () => {
    expect(fmtUsd(0)).toBe('$0.00');
    expect(fmtUsd(12.345)).toBe('$12.35');
    expect(fmtUsd(1234.5)).toBe('$1,234.50');
    expect(fmtUsd(0.0042)).toBe('$0.0042');
    expect(fmtUsd(0.005)).toBe('$0.005');
    expect(fmtUsd(0.00001)).toBe('$0.00');
    expect(fmtUsd(-3)).toBe('-$3.00');
    expect(fmtUsd(null)).toBe('—');
    expect(fmtUsd(undefined)).toBe('—');
    expect(fmtUsd(Number.NaN)).toBe('—');
  });
});

describe('percent and budgetTone', () => {
  it('gives one decimal, and nothing without a whole', () => {
    expect(percent(12.34, 150)).toBe(8.2);
    expect(percent(150, 150)).toBe(100);
    expect(percent(5, 0)).toBeNull();
    expect(percent(5, null)).toBeNull();
    expect(percent(null, 10)).toBeNull();
  });

  it('steps at 50, 75 and 90, the server’s own thresholds', () => {
    expect(budgetTone(0)).toBe('ok');
    expect(budgetTone(49.9)).toBe('ok');
    expect(budgetTone(50)).toBe('info');
    expect(budgetTone(74.9)).toBe('info');
    expect(budgetTone(75)).toBe('warn');
    expect(budgetTone(89.9)).toBe('warn');
    expect(budgetTone(90)).toBe('bad');
    expect(budgetTone(140)).toBe('bad');
    expect(budgetTone(null)).toBe('muted');
  });
});

describe('monthlyEquivalent', () => {
  it('mirrors the server rule for every cycle', () => {
    expect(monthlyEquivalent(20, 'monthly')).toBe(20);
    expect(monthlyEquivalent(120, 'annual')).toBe(10);
    expect(monthlyEquivalent(30, 'quarterly')).toBe(10);
    expect(monthlyEquivalent(100, 'annual')).toBe(8.33);
    expect(monthlyEquivalent(7.5, 'usage')).toBe(7.5);
    expect(monthlyEquivalent(99, 'free')).toBe(0);
    expect(monthlyEquivalent(99, 'one-off')).toBe(0);
    expect(monthlyEquivalent(null, 'monthly')).toBe(0);
    expect(monthlyEquivalent(10, 'weekly')).toBe(0);
  });
});

describe('the words for each field', () => {
  it('names every category, cycle and status the server accepts', () => {
    expect(CATEGORIES.map((c) => c.id)).toEqual([
      'infrastructure',
      'ai',
      'communication',
      'content',
      'developer',
      'other',
    ]);
    expect(CYCLES.map((c) => c.id)).toEqual([
      'monthly',
      'annual',
      'quarterly',
      'usage',
      'free',
      'one-off',
    ]);
    expect(STATUSES.map((s) => s.id)).toEqual(['active', 'trial', 'cancelled']);
    expect(categoryLabel('developer')).toBe('Developer tools');
    expect(categoryLabel('nope')).toBe('nope');
    expect(cycleLabel('annual')).toBe('Yearly');
    expect(statusInfo('trial')).toMatchObject({ label: 'Trial', tone: 'warn' });
    expect(statusInfo('odd')).toMatchObject({ label: 'odd', tone: 'muted' });
  });

  it('paints a severity, never relying on the colour alone elsewhere', () => {
    expect(severityTone('critical')).toBe('bad');
    expect(severityTone('warning')).toBe('warn');
    expect(severityTone('info')).toBe('muted');
  });

  it('says where a renewal stands and how long ago something was', () => {
    expect(renewalLabel(14)).toBe('in 14 days');
    expect(renewalLabel(1)).toBe('tomorrow');
    expect(renewalLabel(0)).toBe('today');
    expect(renewalLabel(-3)).toBe('3 days overdue');
    expect(renewalLabel(-1)).toBe('1 day overdue');
    expect(renewalLabel(null)).toBe('no date');
    const now = Date.parse('2026-11-01T14:10:00.000Z');
    expect(agoLabel('2026-11-01T14:09:40.000Z', now)).toBe('just now');
    expect(agoLabel('2026-11-01T14:02:11.000Z', now)).toBe('7 minutes ago');
    expect(agoLabel('2026-11-01T11:10:00.000Z', now)).toBe('3 hours ago');
    expect(agoLabel('2026-10-30T14:10:00.000Z', now)).toBe('2 days ago');
    expect(agoLabel(null, now)).toBeNull();
    expect(monthLabel('2026-10')).toBe('October 2026');
    expect(monthLabel('bad')).toBe('bad');
  });
});

describe('the API', () => {
  it('reads the summary, with ?refresh=1 when asked, and refuses another shape', async () => {
    getJSON.mockResolvedValue(SUMMARY);
    await expect(fetchCostSummary()).resolves.toBe(SUMMARY);
    expect(getJSON).toHaveBeenLastCalledWith(COST_SUMMARY_ROUTE);
    await fetchCostSummary({ refresh: true });
    expect(getJSON).toHaveBeenLastCalledWith(`${COST_SUMMARY_ROUTE}?refresh=1`);
    getJSON.mockResolvedValue({ ok: true });
    await expect(fetchCostSummary()).rejects.toThrow(/expected shape/);
    getJSON.mockResolvedValue('<html>');
    await expect(fetchCostSummary()).rejects.toThrow(/expected shape/);
  });

  it('reads the ledger with its suggestions, and writes one item at a time', async () => {
    getJSON.mockResolvedValue({ ok: true, today: '2026-11-01', items: [], total: 0 });
    await expect(fetchCostServices()).resolves.toEqual({
      today: '2026-11-01',
      items: [],
      total: 0,
      suggestions: [],
    });
    expect(getJSON).toHaveBeenCalledWith(COST_SERVICES_ROUTE);
    getJSON.mockResolvedValue({ ok: false, error: 'editor role needed' });
    await expect(fetchCostServices()).rejects.toThrow(/expected shape/);

    const item = { id: 'svc-1', name: 'Cloudflare Pro' };
    sendJSON.mockResolvedValue({ ok: true, item });
    await expect(createCostService({ name: 'Cloudflare Pro' })).resolves.toBe(item);
    expect(sendJSON).toHaveBeenLastCalledWith(COST_SERVICES_ROUTE, 'POST', {
      name: 'Cloudflare Pro',
    });
    await expect(updateCostService('svc 1', { amount: 25 })).resolves.toBe(item);
    expect(sendJSON).toHaveBeenLastCalledWith(`${COST_SERVICES_ROUTE}/svc%201`, 'PATCH', {
      amount: 25,
    });
    sendJSON.mockResolvedValue({ ok: true, id: 'svc-1' });
    await deleteCostService('svc-1');
    expect(sendJSON).toHaveBeenLastCalledWith(`${COST_SERVICES_ROUTE}/svc-1`, 'DELETE');
    sendJSON.mockResolvedValue({ ok: true });
    await expect(createCostService({ name: 'x' })).rejects.toThrow(/expected shape/);
  });

  it('reads and PUTs the settings whole, filling gaps with the defaults', async () => {
    getJSON.mockResolvedValue({ ok: true, settings: { aiMonthlyBudgetUsd: 20 } });
    await expect(fetchCostSettings()).resolves.toEqual({
      ...DEFAULT_SETTINGS,
      aiMonthlyBudgetUsd: 20,
    });
    expect(getJSON).toHaveBeenCalledWith(COST_SETTINGS_ROUTE);
    const settings = { ...DEFAULT_SETTINGS, telegram: false };
    sendJSON.mockResolvedValue({ ok: true, settings });
    await expect(saveCostSettings(settings)).resolves.toEqual(settings);
    expect(sendJSON).toHaveBeenCalledWith(COST_SETTINGS_ROUTE, 'PUT', settings);
    sendJSON.mockResolvedValue({ ok: true });
    await expect(saveCostSettings(settings)).rejects.toThrow(/expected shape/);
  });
});
