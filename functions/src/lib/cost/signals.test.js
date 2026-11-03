import { describe, expect, it } from 'vitest';

import { budgetRung, computeSignals, notable } from './signals.js';

const NOW = new Date('2026-11-10T12:00:00Z');
const period = { month: '2026-11', daysElapsed: 10, daysInMonth: 30 };
const settings = { renewalLeadDays: 7 };
const scope = (over) => ({
  id: 'app',
  label: 'Application subscription',
  kind: 'subscription',
  error: null,
  monthToDate: 10,
  forecast: 30,
  budget: { amount: 150, currentSpend: 10, forecastSpend: 30, percentUsed: 6.7, percentForecast: 20 },
  ...over,
});
const base = (over = {}) => ({
  readAt: '2026-11-10T11:00:00Z',
  period,
  azure: { available: true, scopes: [scope()] },
  ai: { budgetUsd: null, monthToDate: { costUsd: 0 }, providers: [] },
  services: { items: [] },
  ...over,
});
const ids = (snapshot, s = settings) => computeSignals(snapshot, s, NOW).map((x) => `${x.severity} ${x.id}`);

describe('budgetRung', () => {
  it('follows the budgets’ own ladder', () => {
    expect(budgetRung(49)).toBeNull();
    expect(budgetRung(50)).toEqual({ rung: 50, severity: 'info' });
    expect(budgetRung(75)).toEqual({ rung: 75, severity: 'warning' });
    expect(budgetRung(90)).toEqual({ rung: 90, severity: 'critical' });
    expect(budgetRung(130)).toEqual({ rung: 100, severity: 'critical' });
    expect(budgetRung(null)).toBeNull();
  });
});

describe('computeSignals', () => {
  it('is quiet for a healthy, fresh snapshot', () => {
    expect(ids(base())).toEqual([]);
  });

  it('raises the budget rung with the days left and the estimate in the detail', () => {
    const snapshot = base({
      azure: {
        available: true,
        scopes: [scope({ monthToDate: 117, forecast: 160, budget: { amount: 150, currentSpend: 117, forecastSpend: 160, percentUsed: 78, percentForecast: 106.7 } })],
      },
    });
    const signals = computeSignals(snapshot, settings, NOW);
    expect(signals.map((s) => s.id)).toEqual(['azure:app:actual:75', 'azure:app:forecast:100']);
    expect(signals[0]).toMatchObject({ severity: 'warning', area: 'azure', href: '/admin/cost?tab=azure' });
    expect(signals[0].title).toBe('Application subscription is at 78% of its USD 150.00 budget');
    expect(signals[0].detail).toBe('USD 117.00 spent with 20 days left; the month is estimated at USD 160.00.');
    expect(signals[1].detail).toContain('USD 160.00');
  });

  it('does not repeat the forecast once the budget itself is past 100 %', () => {
    const snapshot = base({
      azure: { available: true, scopes: [scope({ budget: { amount: 10, currentSpend: 12, forecastSpend: 14, percentUsed: 120, percentForecast: 140 } })] },
    });
    expect(ids(snapshot)).toEqual(['critical azure:app:actual:100']);
  });

  it('notes a scope showing earlier figures after a refused refresh', () => {
    const kept = scope({ note: 'These figures were read at 2026-11-10 09:00 UTC and could not be renewed this time.' });
    const signals = computeSignals(base({ azure: { available: true, scopes: [kept] } }), settings, NOW);
    expect(signals.map((s) => `${s.severity} ${s.id}`)).toEqual(['info azure:app:kept']);
    expect(signals[0].detail).toBe(kept.note);
  });

  it('warns when Azure could not be read at all, or one scope could not', () => {
    expect(ids(base({ azure: { available: false, reason: 'COST_SCOPES is not set' } }))).toEqual(['warning azure:unavailable']);
    expect(ids(base({ azure: { available: true, scopes: [scope({ error: 'HTTP 403' }), scope({ id: 'mgmt', label: 'M' })] } }))).toEqual([
      'warning azure:app:unreadable',
    ]);
    // Before the first read there is nothing to warn about.
    expect(ids(base({ readAt: null, azure: { available: false, neverRead: true } }))).toEqual(['info data:never-read']);
    expect(ids(base({ azure: null }))).toEqual([]);
  });

  it('watches the AI budget, the credits and the image budget', () => {
    const snapshot = base({
      ai: {
        budgetUsd: 20,
        monthToDate: { costUsd: 17 },
        providers: [
          { id: 'elevenlabs', label: 'ElevenLabs', kind: 'credits', configured: true, error: null, percentLeft: 12, left: 1200, limit: 10000, resetAt: '2026-11-26T00:00:00Z' },
          { id: 'replicate', label: 'Replicate (images)', kind: 'budget', configured: true, percentUsed: 85, budget: 10, images: 42 },
          { id: 'gemini', label: 'Gemini', kind: 'ledger', configured: true },
        ],
      },
    });
    const signals = computeSignals(snapshot, settings, NOW);
    expect(signals.map((s) => `${s.severity} ${s.id}`)).toEqual([
      'warning ai:budget:80',
      'warning elevenlabs:credits:20',
      'warning replicate:budget:80',
    ]);
    expect(signals[1].detail).toBe('1200 of 10000 credits. They reset on 2026-11-26.');
  });

  it('escalates to critical when a budget or the credits are spent, and notes an unreadable credit balance', () => {
    const snapshot = base({
      ai: {
        budgetUsd: 20,
        monthToDate: { costUsd: 21 },
        providers: [
          { id: 'elevenlabs', label: 'ElevenLabs', kind: 'credits', configured: true, error: null, percentLeft: 2, left: 200, limit: 10000, resetAt: null },
          { id: 'replicate', label: 'Replicate (images)', kind: 'budget', configured: true, percentUsed: 100, budget: 10, images: 500 },
          { id: 'other', label: 'Other credits', kind: 'credits', configured: true, error: 'Could not read it.' },
          { id: 'off', label: 'Off', kind: 'credits', configured: false, error: null, percentLeft: 1 },
        ],
      },
    });
    expect(ids(snapshot)).toEqual([
      'critical ai:budget:100',
      'critical elevenlabs:credits:5',
      'critical replicate:budget:100',
      'info other:unreadable',
    ]);
  });

  it('follows renewals: inside the lead days, due, and overdue without auto-renew', () => {
    const item = (over) => ({ id: over.id, name: over.id, status: 'active', autoRenew: false, amount: 12, currency: 'USD', cycle: 'monthly', nextRenewal: '2026-11-15', daysUntilRenewal: 5, ...over });
    const snapshot = base({
      services: {
        items: [
          item({ id: 'soon' }),
          item({ id: 'today', daysUntilRenewal: 0, cycle: 'annual', amount: null }),
          item({ id: 'tomorrow', daysUntilRenewal: 1, autoRenew: true, cycle: 'quarterly' }),
          item({ id: 'late', daysUntilRenewal: -3, nextRenewal: '2026-11-07' }),
          item({ id: 'auto-late', daysUntilRenewal: -3, autoRenew: true }),
          item({ id: 'cancelled', status: 'cancelled', daysUntilRenewal: 0 }),
          item({ id: 'far', daysUntilRenewal: 20 }),
          item({ id: 'undated', daysUntilRenewal: null }),
        ],
      },
    });
    const signals = computeSignals(snapshot, settings, NOW);
    expect(signals.map((s) => `${s.severity} ${s.id}`)).toEqual([
      'warning service:late:overdue',
      'warning service:today:due',
      'warning service:tomorrow:due',
      'info service:soon:soon',
    ]);
    expect(signals.find((s) => s.id === 'service:today:due').detail).toBe('amount not recorded, not set to renew by itself.');
    expect(signals.find((s) => s.id === 'service:tomorrow:due').detail).toBe('USD 12.00 per quarter, renews by itself.');
    expect(signals.find((s) => s.id === 'service:late:overdue').detail).toContain('Was due 2026-11-07');
    // A longer lead makes "far" a signal too.
    expect(ids(snapshot, { renewalLeadDays: 30 })).toContain('info service:far:soon');
  });

  it('notes a stale snapshot and orders most severe first', () => {
    const snapshot = base({ readAt: '2026-11-01T00:00:00Z', azure: { available: false, reason: 'x' } });
    expect(ids(snapshot)).toEqual(['warning azure:unavailable', 'info data:stale']);
    expect(notable(computeSignals(snapshot, settings, NOW)).map((s) => s.id)).toEqual(['azure:unavailable']);
  });
});
