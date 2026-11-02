/**
 * cost/model.js — the arithmetic behind the Cost page (ADR 0039), with no
 * I/O: which month we are in, how a month-to-date figure becomes an estimate
 * for the whole month, how a subscription's price becomes a monthly figure,
 * and how money is rounded for the page.
 *
 * Every date here is a UTC calendar day, the same convention as the reminders
 * sheet and the calendar alerts (reminders/calendar.js): the site's day is the
 * UTC day (owner decision 2026-09-07, #416).
 */
import { dateOnly, daysUntil, parseDateOnly } from '../reminders/calendar.js';

export { dateOnly, daysUntil, parseDateOnly };

export const CURRENCY = 'USD';

/** A snapshot older than this is shown with a "may be out of date" notice. */
export const STALE_AFTER_MS = 36 * 60 * 60 * 1000;

/** The months of closed figures the snapshot keeps. */
export const HISTORY_MONTHS = 12;

/** Round to cents; 4 decimals under a cent so a fraction of a cent is not shown as nothing. */
export function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const abs = Math.abs(n);
  if (abs > 0 && abs < 0.01) return Number(n.toFixed(4));
  return Number(n.toFixed(2));
}

/** `part / whole * 100` to one decimal; null when there is no whole. */
export function percent(part, whole) {
  const p = Number(part);
  const w = Number(whole);
  if (!Number.isFinite(p) || !Number.isFinite(w) || w <= 0) return null;
  return Number(((p / w) * 100).toFixed(1));
}

/** `YYYY-MM` of a UTC instant. */
export const monthOf = (date) => dateOnly(date).slice(0, 7);

/** The `YYYY-MM` before `month`. */
export function previousMonthOf(month) {
  const [y, m] = String(month).split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Days in the month `YYYY-MM`. */
export function daysInMonth(month) {
  const [y, m] = String(month).split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * The calendar month `now` is in, the way the page shows it.
 *
 * @param {Date} now
 * @returns {{ month: string, start: string, end: string, today: string, daysElapsed: number, daysInMonth: number }}
 */
export function period(now) {
  const today = dateOnly(now);
  const month = today.slice(0, 7);
  const days = daysInMonth(month);
  return {
    month,
    start: `${month}-01`,
    end: `${month}-${String(days).padStart(2, '0')}`,
    today,
    // Today counts as a day with data: on the 1st the estimate is one day's spend times the month.
    daysElapsed: Number(today.slice(8, 10)),
    daysInMonth: days,
  };
}

/**
 * A whole-month estimate from what has been spent so far, by straight line.
 * Null when nothing can be said (no spend read, or a bad day count).
 */
export function straightLineForecast(monthToDate, daysElapsed, totalDays) {
  if (monthToDate === null || monthToDate === undefined || monthToDate === '') return null;
  const spend = Number(monthToDate);
  const elapsed = Number(daysElapsed);
  const total = Number(totalDays);
  if (!Number.isFinite(spend) || !Number.isFinite(elapsed) || !Number.isFinite(total)) return null;
  if (elapsed <= 0 || total <= 0) return null;
  return money((spend / elapsed) * total);
}

/** How a subscription is billed. `usage` is pay-as-you-go: the amount is the owner's monthly estimate. */
export const CYCLES = Object.freeze(['monthly', 'annual', 'quarterly', 'usage', 'free', 'one-off']);

/** What one subscription costs per month, from its price and how often it bills. */
export function monthlyEquivalent(amount, cycle) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return 0;
  switch (cycle) {
    case 'monthly':
    case 'usage':
      return money(value);
    case 'annual':
      return money(value / 12);
    case 'quarterly':
      return money(value / 3);
    default:
      // free and one-off bill nothing per month
      return 0;
  }
}

/** Whether `readAt` is older than STALE_AFTER_MS at `now` (true when there is no readAt). */
export function isStale(readAt, now, staleAfterMs = STALE_AFTER_MS) {
  const ms = Date.parse(readAt || '');
  if (!Number.isFinite(ms)) return true;
  return now.getTime() - ms > staleAfterMs;
}
