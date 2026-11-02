import { describe, expect, it } from 'vitest';

import {
  STALE_AFTER_MS,
  daysInMonth,
  isStale,
  money,
  monthOf,
  monthlyEquivalent,
  percent,
  period,
  previousMonthOf,
  straightLineForecast,
} from './model.js';

describe('money and percent', () => {
  it('rounds to cents, keeps four decimals under a cent, and reads garbage as 0', () => {
    expect(money(12.345)).toBe(12.35);
    expect(money(0.004321)).toBe(0.0043);
    expect(money(-0.0012)).toBe(-0.0012);
    expect(money('abc')).toBe(0);
    expect(money(null)).toBe(0);
  });

  it('percent is one decimal, and null without a whole', () => {
    expect(percent(12.34, 150)).toBe(8.2);
    expect(percent(5, 0)).toBeNull();
    expect(percent('x', 10)).toBeNull();
  });
});

describe('the month', () => {
  it('names the UTC month, its bounds and the days so far', () => {
    expect(period(new Date('2026-11-01T03:00:00Z'))).toEqual({
      month: '2026-11',
      start: '2026-11-01',
      end: '2026-11-30',
      today: '2026-11-01',
      daysElapsed: 1,
      daysInMonth: 30,
    });
    expect(period(new Date('2026-02-28T23:59:59Z')).daysInMonth).toBe(28);
    expect(period(new Date('2028-02-10T00:00:00Z')).daysInMonth).toBe(29);
  });

  it('steps back a month across a year boundary', () => {
    expect(previousMonthOf('2026-01')).toBe('2025-12');
    expect(previousMonthOf('2026-11')).toBe('2026-10');
    expect(monthOf(new Date('2026-11-30T23:59:59Z'))).toBe('2026-11');
    expect(daysInMonth('2026-12')).toBe(31);
  });
});

describe('straightLineForecast', () => {
  it('scales the spend so far to the whole month', () => {
    expect(straightLineForecast(10, 10, 30)).toBe(30);
    expect(straightLineForecast(5.36, 20, 31)).toBe(8.31);
  });

  it('says nothing for a bad day count or no spend figure', () => {
    expect(straightLineForecast(null, 1, 30)).toBeNull();
    expect(straightLineForecast(10, 0, 30)).toBeNull();
    expect(straightLineForecast(10, 3, 0)).toBeNull();
  });
});

describe('monthlyEquivalent', () => {
  it('spreads an annual or quarterly price over its months and bills nothing for free or one-off', () => {
    expect(monthlyEquivalent(240, 'annual')).toBe(20);
    expect(monthlyEquivalent(30, 'quarterly')).toBe(10);
    expect(monthlyEquivalent(20, 'monthly')).toBe(20);
    expect(monthlyEquivalent(7.5, 'usage')).toBe(7.5);
    expect(monthlyEquivalent(99, 'free')).toBe(0);
    expect(monthlyEquivalent(99, 'one-off')).toBe(0);
    expect(monthlyEquivalent(null, 'monthly')).toBe(0);
    expect(monthlyEquivalent(-5, 'monthly')).toBe(0);
  });
});

describe('isStale', () => {
  const now = new Date('2026-11-02T12:00:00Z');
  it('is stale after 36 hours, and when there is no read at all', () => {
    expect(isStale('2026-11-02T00:00:00Z', now)).toBe(false);
    expect(isStale(new Date(now.getTime() - STALE_AFTER_MS - 1).toISOString(), now)).toBe(true);
    expect(isStale(null, now)).toBe(true);
    expect(isStale('not a date', now)).toBe(true);
  });
});
