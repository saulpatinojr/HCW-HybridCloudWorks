/**
 * scheduleWords.js: the schedule readings the Scheduled tasks tab shows.
 *
 * EVERY_SCHEDULE_IN_USE is every schedule the tab lists, with the words it
 * shows for it. The first test holds that table to the list, so a new
 * schedule (or a changed one) needs its words checked here before the tab
 * shows it.
 */
import { describe, it, expect } from 'vitest';

import { describeSchedule, parseSchedule } from './scheduleWords';
import { nextRun, formatRunTime, scheduleRhythm, compareSchedules } from './scheduleTimes';
import {
  SCHEDULE_GROUPS,
  SCHEDULED_TASKS,
} from '@/components/admin/platform-settings/scheduledTasks';

const EVERY_SCHEDULE_IN_USE = new Map([
  // GitHub Actions: five fields, UTC.
  ['20 7 * * 3', 'Every Wednesday at 07:20 UTC'],
  ['0 6 * * 1', 'Every Monday at 06:00 UTC'],
  ['43 7 * * 3', 'Every Wednesday at 07:43 UTC'],
  ['20 7 * * 1', 'Every Monday at 07:20 UTC'],
  ['35 5 * * *', 'Every day at 05:35 UTC'],
  ['50 5 * * *', 'Every day at 05:50 UTC'],
  ['5 7 * * 2', 'Every Tuesday at 07:05 UTC'],
  ['31 4 * * 1', 'Every Monday at 04:31 UTC'],
  ['45 6 * * 2', 'Every Tuesday at 06:45 UTC'],
  ['17 */4 * * *', 'Every 4 hours at :17'],
  ['41 * * * *', 'Every hour at :41'],
  ['29 */6 * * *', 'Every 6 hours at :29'],
  ['15 6 * * *', 'Every day at 06:15 UTC'],
  ['20 5 * * 2', 'Every Tuesday at 05:20 UTC'],
  ['11 * * * *', 'Every hour at :11'],
  ['30 6 * * 2', 'Every Tuesday at 06:30 UTC'],
  ['30 6 * * 1', 'Every Monday at 06:30 UTC'],
  ['30 6 * * 3', 'Every Wednesday at 06:30 UTC'],
  ['53 7 * * 1', 'Every Monday at 07:53 UTC'],
  ['0 7 * * 1', 'Every Monday at 07:00 UTC'],
  // Function App: six fields (seconds first), UTC.
  ['0 */15 * * * *', 'Every 15 minutes'],
  ['0 */5 * * * *', 'Every 5 minutes'],
  ['0 2-59/5 * * * *', 'Every 5 minutes, from :02'],
  ['0 */2 * * * *', 'Every 2 minutes'],
  ['0 20 */1 * * *', 'Every hour at :20'],
  ['0 0 */2 * * *', 'Every 2 hours, on the hour'],
  ['0 30 */2 * * *', 'Every 2 hours at :30'],
  ['0 0 */4 * * *', 'Every 4 hours, on the hour'],
  ['0 0 */6 * * *', 'Every 6 hours, on the hour'],
  ['0 15 */6 * * *', 'Every 6 hours at :15'],
  ['0 0 */12 * * *', 'Every 12 hours, on the hour'],
  ['0 10 0,12 * * *', 'Every day at 00:10 and 12:10 UTC'],
  ['0 0 0 * * *', 'Every day at 00:00 UTC'],
  ['0 0 2 * * *', 'Every day at 02:00 UTC'],
  ['0 0 3 * * *', 'Every day at 03:00 UTC'],
  ['0 30 3 * * *', 'Every day at 03:30 UTC'],
  ['0 0 4 * * *', 'Every day at 04:00 UTC'],
  ['0 0 5 * * *', 'Every day at 05:00 UTC'],
  ['0 45 6 * * *', 'Every day at 06:45 UTC'],
  ['0 0 7 * * *', 'Every day at 07:00 UTC'],
  ['0 40 12 * * *', 'Every day at 12:40 UTC'],
  ['0 0 13 * * *', 'Every day at 13:00 UTC'],
  ['0 55 23 * * *', 'Every day at 23:55 UTC'],
  ['0 0 0 * * 0', 'Every Sunday at 00:00 UTC'],
  ['0 0 6 * * 1', 'Every Monday at 06:00 UTC'],
  ['0 15 6 * * 1', 'Every Monday at 06:15 UTC'],
  ['0 0 13 * * 1', 'Every Monday at 13:00 UTC'],
  ['0 0 9 * * 5', 'Every Friday at 09:00 UTC'],
  // Lab host: systemd, on the host's own clock.
  ['OnUnitActiveSec=15min', 'Every 15 minutes'],
  ['OnCalendar=*-*-* 03:00:00', 'Every day at 03:00 (lab host clock)'],
  ['OnCalendar=*-*-* 03:30:00', 'Every day at 03:30 (lab host clock)'],
  ['OnCalendar=*-*-* 03:45:00', 'Every day at 03:45 (lab host clock)'],
  ['OnCalendar=*-*-* 04:00:00', 'Every day at 04:00 (lab host clock)'],
  ['OnCalendar=*-*-* 04:30:00', 'Every day at 04:30 (lab host clock)'],
  ['OnCalendar=*-*-* 05:45:00', 'Every day at 05:45 (lab host clock)'],
  ['OnCalendar=*-*-* 07:15:00', 'Every day at 07:15 (lab host clock)'],
  // The daily Claude session.
  ['13 9 * * *', 'Every day at 09:13 UTC'],
]);

const clockOf = (task) => SCHEDULE_GROUPS.find((g) => g.id === task.group).clock;

describe('describeSchedule', () => {
  it('has words for every schedule the tab lists, and the table lists nothing else', () => {
    const inUse = new Set(SCHEDULED_TASKS.flatMap((task) => task.schedules));
    expect([...EVERY_SCHEDULE_IN_USE.keys()].sort()).toEqual([...inUse].sort());
    for (const task of SCHEDULED_TASKS) {
      for (const schedule of task.schedules) {
        expect(
          describeSchedule(schedule, { clock: clockOf(task) }),
          `${task.id}: ${schedule}`
        ).toBe(EVERY_SCHEDULE_IN_USE.get(schedule));
      }
    }
  });

  it('reads shapes the estate does not use yet the same way', () => {
    expect(describeSchedule('0 9 * * 1,4')).toBe('Every Monday and Thursday at 09:00 UTC');
    expect(describeSchedule('0 9 * * 1-5')).toBe(
      'Every Monday, Tuesday, Wednesday, Thursday and Friday at 09:00 UTC'
    );
    expect(describeSchedule('15,45 * * * *')).toBe('Every 30 minutes, from :15');
    expect(describeSchedule('15,40 * * * *')).toBe('Every hour at :15 and :40');
    expect(describeSchedule('*/10 * * * 1')).toBe('Every 10 minutes on Mondays');
    expect(describeSchedule('0 */3 * * *')).toBe('Every 3 hours, on the hour');
    expect(describeSchedule('OnUnitActiveSec=2h')).toBe('Every 2 hours');
    expect(describeSchedule('OnUnitActiveSec=1h')).toBe('Every hour');
    expect(describeSchedule('0 0 9 * * 7')).toBe('Every Sunday at 09:00 UTC');
  });

  it('refuses what it cannot say correctly, rather than guessing', () => {
    expect(() => describeSchedule('0 0 1 * *')).toThrow(/day of the month/);
    expect(() => describeSchedule('0 0 * 6 *')).toThrow(/month/);
    expect(() => describeSchedule('30 0 0 * * *')).toThrow(/second/);
    expect(() => describeSchedule('every day')).toThrow(/not a schedule/);
    expect(() => describeSchedule('61 * * * *')).toThrow(/out of range/);
    expect(() => describeSchedule('L * * * *')).toThrow(/not a shape/);
    expect(() => describeSchedule('0 1,2,3,4,5 * * *')).toThrow(/too many/);
    expect(() => describeSchedule('OnCalendar=Mon *-*-* 03:00:00')).toThrow();
  });
});

describe('parseSchedule', () => {
  it('reads the four shapes the estate writes', () => {
    expect(parseSchedule('30 6 * * 2')).toMatchObject({
      kind: 'cron',
      minutes: [30],
      hours: [6],
      days: [2],
    });
    const pulse = parseSchedule('0 2-59/5 * * * *');
    expect(pulse.kind).toBe('ncrontab');
    expect(pulse.minutes.slice(0, 3)).toEqual([2, 7, 12]);
    expect(pulse.hours).toHaveLength(24);
    expect(parseSchedule('OnCalendar=*-*-* 03:45:00')).toMatchObject({
      kind: 'systemd-calendar',
      minutes: [45],
      hours: [3],
    });
    expect(parseSchedule('OnUnitActiveSec=15min')).toEqual({ kind: 'interval', everyMinutes: 15 });
  });
});

describe('nextRun and formatRunTime', () => {
  // Wednesday 25 November 2026, 12:00:30 UTC.
  const from = new Date(Date.UTC(2026, 10, 25, 12, 0, 30));

  it('finds the next firing after the given time, in UTC', () => {
    expect(formatRunTime(nextRun('30 6 * * 2', from))).toBe('Tue 1 Dec, 06:30 UTC');
    expect(formatRunTime(nextRun('41 * * * *', from))).toBe('Wed 25 Nov, 12:41 UTC');
    expect(formatRunTime(nextRun('0 2-59/5 * * * *', from))).toBe('Wed 25 Nov, 12:02 UTC');
    expect(formatRunTime(nextRun('0 0 0 * * 0', from))).toBe('Sun 29 Nov, 00:00 UTC');
    expect(formatRunTime(nextRun('0 10 0,12 * * *', from))).toBe('Wed 25 Nov, 12:10 UTC');
  });

  it('never returns the minute it was asked from, and crosses the year', () => {
    const onTheMinute = new Date(Date.UTC(2026, 10, 25, 12, 41));
    expect(formatRunTime(nextRun('41 * * * *', onTheMinute))).toBe('Wed 25 Nov, 13:41 UTC');
    const newYearsEve = new Date(Date.UTC(2026, 11, 31, 23, 59));
    expect(formatRunTime(nextRun('0 0 0 * * *', newYearsEve))).toBe('Fri 1 Jan, 00:00 UTC');
  });

  it('has no next run for an interval timer, which counts from its last run', () => {
    expect(nextRun('OnUnitActiveSec=15min', from)).toBeNull();
  });
});

describe('scheduleRhythm and compareSchedules', () => {
  it('counts the runs in a week and finds the first one from Monday 00:00', () => {
    expect(scheduleRhythm('0 */2 * * * *')).toEqual({ perWeek: 5040, firstMinute: 0 });
    expect(scheduleRhythm('41 * * * *')).toEqual({ perWeek: 168, firstMinute: 41 });
    expect(scheduleRhythm('0 0 0 * * 0')).toEqual({ perWeek: 1, firstMinute: 6 * 24 * 60 });
    expect(scheduleRhythm('OnUnitActiveSec=15min')).toEqual({ perWeek: 672, firstMinute: 0 });
  });

  it('puts the more frequent first, then the earlier in the week', () => {
    const order = [
      ['0 6 * * 1'],
      ['41 * * * *'],
      ['30 6 * * 2'],
      ['50 5 * * *'],
      ['0 7 * * 1'],
    ].sort(compareSchedules);
    expect(order).toEqual([
      ['41 * * * *'],
      ['50 5 * * *'],
      ['0 6 * * 1'],
      ['0 7 * * 1'],
      ['30 6 * * 2'],
    ]);
  });
});
