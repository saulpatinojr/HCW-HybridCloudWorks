/**
 * `alert-timer-overdue` knows every timer the host runs, and when each is due
 * (PLAT-4, #964).
 *
 * The rule in infra/observability.tf computes each timer's last due time from
 * `local.timer_schedules`: a period and an anchor, a moment the schedule is
 * known to fire. That map is written by hand beside the NCRONTAB it restates,
 * and the two can drift three ways, each of them silent in production:
 *
 *   - A timer added to the app and not to the map is never watched. The
 *     estate assessment found exactly that for twenty-four of twenty-five.
 *   - A timer removed from the app but left in the map is "overdue" forever,
 *     and pages until someone mutes the rule, which then watches nothing.
 *   - A timer rescheduled in the code but not in the map is judged against
 *     the old schedule: overdue at the wrong time, or never.
 *
 * So the map is held to the registrations themselves, read by stubbing the
 * Functions host as timer-schedules-utc.test.js does, not to the source text,
 * and to functions/function-inventory.json, the list the registration monitor
 * checks. Terraform is read as text, so this fails on a checkout with no
 * Azure credentials and no Terraform binary.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { terraformSource } from '../../test/terraform-source.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const INFRA = join(ROOT, 'infra');

const timerRegistrations = new Map();

vi.mock('@azure/functions', () => ({
  app: {
    http: () => {},
    timer: (name, options) => timerRegistrations.set(name, options),
    cosmosDB: () => {},
    storageQueue: () => {},
  },
  output: {
    storageQueue: (options) => ({ type: 'queue', ...options }),
  },
}));

await import('./schedulers.js');
await import('./jobs-sweeper.js');
await import('./cosmos-export.js');
await import('./cloud-tools-jobs.js');
await import('./labs-jobs.js');
await import('./ambassador-audience.js');
await import('./brain-http.js');
await import('./visitor-session-sweep.js');

/** `local.timer_schedules` from infra/*.tf: name -> { period, anchor }. */
export function declaredSchedules(source) {
  const block = /^\s*timer_schedules\s*=\s*\{\n([\s\S]*?)\n\s*\}\n/m.exec(source);
  if (!block) return null;
  const entries = [
    ...block[1].matchAll(/^\s*(\w+)\s*=\s*\{\s*period\s*=\s*"([^"]+)",\s*anchor\s*=\s*"([^"]+)"\s*\}/gm),
  ];
  return new Map(entries.map((m) => [m[1], { period: m[2], anchor: m[3] }]));
}

/**
 * The KQL timespan between two firings of a six-field NCRONTAB, for the
 * shapes this app uses, or null for any other shape. Every minute step here
 * divides 60 and every hour step divides 24, so each is a fixed period.
 */
export function periodOf(schedule) {
  const f = String(schedule).trim().split(/\s+/);
  if (f.length !== 6 || f[0] !== '0' || f[3] !== '*' || f[4] !== '*') return null;
  const [, minute, hour, , , weekday] = f;
  const step = (field) => /^(?:\*|\d+-\d+)\/(\d+)$/.exec(field)?.[1];
  const fixed = (field) => /^\d+$/.test(field);
  if (hour === '*' && weekday === '*' && step(minute)) return `${step(minute)}m`;
  if (fixed(minute) && weekday === '*' && step(hour)) return `${step(hour)}h`;
  if (fixed(minute) && fixed(hour) && weekday === '*') return '1d';
  if (fixed(minute) && fixed(hour) && /^[0-6]$/.test(weekday)) return '7d';
  return null;
}

/** Whether one NCRONTAB field admits a value. */
function admits(field, value) {
  if (field === '*') return true;
  if (/^\d+$/.test(field)) return Number(field) === value;
  const m = /^(?:\*|(\d+)-(\d+))\/(\d+)$/.exec(field);
  if (!m) return false;
  const from = m[1] === undefined ? 0 : Number(m[1]);
  const to = m[2] === undefined ? Infinity : Number(m[2]);
  return value >= from && value <= to && (value - from) % Number(m[3]) === 0;
}

/** Whether the schedule fires at this UTC instant ("YYYY-MM-DD HH:MM"). */
export function firesAt(schedule, anchor) {
  const at = new Date(`${anchor.replace(' ', 'T')}:00Z`);
  if (Number.isNaN(at.getTime())) return false;
  const [second, minute, hour, day, month, weekday] = String(schedule).trim().split(/\s+/);
  return (
    admits(second, 0) &&
    admits(minute, at.getUTCMinutes()) &&
    admits(hour, at.getUTCHours()) &&
    admits(day, at.getUTCDate()) &&
    admits(month, at.getUTCMonth() + 1) &&
    admits(weekday, at.getUTCDay())
  );
}

describe('alert-timer-overdue schedules', () => {
  const declared = declaredSchedules(terraformSource(INFRA));
  const inventory = JSON.parse(readFileSync(join(ROOT, 'functions', 'function-inventory.json'), 'utf8'));

  it('reads all three sides, so an empty parse cannot pass by comparing nothing', () => {
    expect(declared, 'local.timer_schedules not found in infra/*.tf').not.toBeNull();
    expect(declared.size).toBeGreaterThan(0);
    expect(timerRegistrations.size).toBeGreaterThan(0);
    expect(inventory.timer.length).toBeGreaterThan(0);
  });

  it('watches exactly the timers the host registers and the inventory lists', () => {
    const registered = [...timerRegistrations.keys()].sort();
    expect([...declared.keys()].sort(), 'local.timer_schedules against the app.timer() registrations').toEqual(
      registered
    );
    expect([...inventory.timer].sort(), 'function-inventory.json against the registrations').toEqual(registered);
  });

  it.each([...timerRegistrations])('%s: the period and anchor restate its NCRONTAB', (name, options) => {
    const entry = declared.get(name);
    expect(entry, `${name} has no entry in local.timer_schedules`).toBeDefined();
    const period = periodOf(options.schedule);
    expect(period, `${name}: ${options.schedule} is a shape periodOf() does not know; teach it`).not.toBeNull();
    expect(entry.period, `${name}: ${options.schedule} repeats every ${period}`).toBe(period);
    expect(
      firesAt(options.schedule, entry.anchor),
      `${name}: ${options.schedule} does not fire at the anchor ${entry.anchor} UTC`
    ).toBe(true);
  });

  it('checks firing the way NCRONTAB does, so a wrong anchor cannot pass', () => {
    // 2026-01-05 is a Monday; the map's weekly anchors depend on it.
    expect(firesAt('0 0 6 * * 1', '2026-01-05 06:00')).toBe(true);
    expect(firesAt('0 0 6 * * 1', '2026-01-04 06:00')).toBe(false);
    expect(firesAt('0 2-59/5 * * * *', '2026-01-01 00:02')).toBe(true);
    expect(firesAt('0 2-59/5 * * * *', '2026-01-01 00:00')).toBe(false);
    expect(firesAt('0 30 */2 * * *', '2026-01-01 01:30')).toBe(false);
    expect(periodOf('0 0 9 1 * *')).toBeNull();
  });
});
