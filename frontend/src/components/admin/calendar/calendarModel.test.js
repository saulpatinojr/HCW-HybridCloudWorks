/**
 * The Calendar's pure rules (ADR 0033 §4). What must hold: items land on the
 * viewer's local day (all-day ones on their own date), a view asks for the
 * window it draws, filters narrow by kind, status and channel, two timed
 * items in one quarter hour are a conflict, past days are refused, and the
 * Unscheduled panel offers only approved content with no schedule.
 */
import { describe, it, expect } from 'vitest';
import {
  applyFilters,
  channelsOf,
  combineDateTime,
  findConflicts,
  groupByDay,
  isPastDay,
  isUnscheduled,
  itemDayKey,
  itemStatus,
  kindMeta,
  monthGridDays,
  rangeFor,
  socialComposeHref,
  stepCursor,
} from './calendarModel';

const local = (y, m, d, h = 12) => new Date(y, m, d, h).toISOString();
const item = (over = {}) => ({
  id: 'x',
  kind: 'content',
  title: 't',
  start: local(2026, 9, 5),
  allDay: false,
  status: 'scheduled',
  meta: {},
  ...over,
});

describe('days and windows', () => {
  it('places timed items on the local day and all-day items on their own date', () => {
    expect(itemDayKey(item())).toBe('2026-10-05');
    expect(itemDayKey(item({ allDay: true, start: '2026-10-20T00:00:00.000Z' }))).toBe(
      '2026-10-20'
    );
    expect(itemDayKey(item({ start: 'nope' }))).toBeNull();
  });

  it('groups by day with all-day items first, then by time', () => {
    const days = groupByDay([
      item({ id: 'b', start: local(2026, 9, 5, 15) }),
      item({ id: 'a', start: local(2026, 9, 5, 9) }),
      item({ id: 'c', allDay: true, start: '2026-10-05T00:00:00.000Z' }),
    ]);
    expect(days.get('2026-10-05').map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });

  it('a month grid starts on the Sunday before the first and covers the last day', () => {
    const days = monthGridDays(new Date(2026, 9, 1));
    expect(days[0].getDay()).toBe(0);
    expect(days[0] <= new Date(2026, 9, 1)).toBe(true);
    expect(days[days.length - 1] >= new Date(2026, 9, 31)).toBe(true);
    expect(days.length % 7).toBe(0);
  });

  it('a view asks for exactly the window it draws, and steps by its own unit', () => {
    const month = rangeFor('month', new Date(2026, 9, 15));
    expect(month.from.getDay()).toBe(0);
    expect(month.to > new Date(2026, 9, 31)).toBe(true);
    const week = rangeFor('week', new Date(2026, 9, 7)); // a Wednesday
    expect(week.from).toEqual(new Date(2026, 9, 4));
    expect(week.to).toEqual(new Date(2026, 9, 11));
    const agenda = rangeFor('agenda', new Date(2026, 9, 7, 15));
    expect(agenda.from).toEqual(new Date(2026, 9, 7));
    expect(agenda.to).toEqual(new Date(2026, 10, 6));
    expect(stepCursor('month', new Date(2026, 9, 15), 1)).toEqual(new Date(2026, 10, 1));
    expect(stepCursor('week', new Date(2026, 9, 7), -1)).toEqual(new Date(2026, 8, 30));
  });
});

describe('filters, conflicts and the rest', () => {
  const items = [
    item({ id: 'c1', kind: 'content', meta: { provider: 'Azure' } }),
    item({ id: 's1', kind: 'social', status: 'failed', meta: { platforms: ['linkedin'] } }),
    item({ id: 'n1', kind: 'newsletter', status: 'sent' }),
  ];

  it('narrows by kind, status and channel; empty filters pass everything', () => {
    expect(applyFilters(items, {}).map((i) => i.id)).toEqual(['c1', 's1', 'n1']);
    expect(applyFilters(items, { kinds: ['social', 'newsletter'] }).map((i) => i.id)).toEqual([
      's1',
      'n1',
    ]);
    expect(applyFilters(items, { status: 'failed' }).map((i) => i.id)).toEqual(['s1']);
    expect(applyFilters(items, { channel: 'azure' }).map((i) => i.id)).toEqual(['c1']);
    expect(channelsOf(items)).toEqual(['Azure', 'linkedin']);
  });

  it('flags timed items in the same quarter hour, not published ones or all-day ones', () => {
    const conflicts = findConflicts([
      item({ id: 'a', start: local(2026, 9, 5, 9) }),
      item({ id: 'b', start: new Date(2026, 9, 5, 9, 10).toISOString() }),
      item({ id: 'c', start: new Date(2026, 9, 5, 9, 20).toISOString() }),
      item({ id: 'd', start: local(2026, 9, 5, 9), status: 'published' }),
      item({ id: 'e', allDay: true, start: '2026-10-05T00:00:00.000Z' }),
    ]);
    expect([...conflicts].sort()).toEqual(['a', 'b']);
  });

  it('refuses past days, combines a day with a time, and reads statuses with a tone', () => {
    const today = new Date(2026, 9, 5, 12);
    expect(isPastDay(new Date(2026, 9, 4), today)).toBe(true);
    expect(isPastDay(new Date(2026, 9, 5), today)).toBe(false);
    expect(combineDateTime(new Date(2026, 9, 5), '09:30')).toEqual(new Date(2026, 9, 5, 9, 30));
    expect(combineDateTime(new Date(2026, 9, 5), 'x')).toBeNull();
    expect(itemStatus({ status: 'failed' })).toMatchObject({ tone: 'bad', label: 'Failed' });
    expect(itemStatus({ status: 'odd_thing' })).toMatchObject({
      tone: 'muted',
      label: 'odd thing',
    });
    expect(kindMeta('nope').label).toBe('nope');
  });

  it('offers approved and forge-ready content with no schedule, nothing live or scheduled', () => {
    expect(isUnscheduled({ contentStatus: 'approved' })).toBe(true);
    expect(isUnscheduled({ contentStatus: 'forge_ready' })).toBe(true);
    expect(isUnscheduled({ contentStatus: 'approved', scheduledPublishDate: 'x' })).toBe(false);
    expect(isUnscheduled({ contentStatus: 'approved', Live: true })).toBe(false);
    expect(isUnscheduled({ contentStatus: 'draft' })).toBe(false);
  });

  it('Share carries the content id to the composer', () => {
    expect(socialComposeHref('c 1')).toBe('/admin/social-hub?tab=compose&contentId=c%201');
    expect(socialComposeHref(null)).toBe('/admin/social-hub?tab=compose');
  });
});
