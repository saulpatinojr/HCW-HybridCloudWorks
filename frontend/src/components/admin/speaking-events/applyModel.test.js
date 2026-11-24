/**
 * The pure rules of Speaking → Future Events (#1823): days, which
 * events clash with what the owner already has, what the calendar marks, and
 * the sums on a row. Every event here is made up.
 */
import { describe, it, expect } from 'vitest';
import {
  APPLY_STATUSES,
  addDays,
  allOverlaps,
  applyStatusInfo,
  attendanceCost,
  callCloseInfo,
  committedTalks,
  costTotal,
  daysBetween,
  eventRange,
  filterEvents,
  firstMonth,
  formatDay,
  formatRange,
  isDay,
  isDropped,
  isPlanned,
  knownEvents,
  locationLine,
  marksForMonth,
  monthGrid,
  noteForm,
  notePayload,
  overlapsFor,
  ownTalks,
  parseCost,
  rangesOverlap,
  shiftMonth,
  todayDay,
} from './applyModel';

const NOW = new Date(2026, 10, 24, 15); // 24 Nov 2026, local
const event = (over = {}) => ({
  id: 'event-1',
  title: 'Example Community Day',
  startDate: '2027-03-06',
  endDate: '2027-03-07',
  city: 'Exampleville',
  region: 'Ontario',
  country: 'CA',
  eventType: 'In Person',
  callCloses: '2027-01-15',
  cancelled: false,
  postponed: false,
  note: null,
  ...over,
});
const talk = (over = {}) => ({
  key: 't',
  name: 'Other Conf',
  day: '2027-03-06',
  status: 'accepted',
  statusLabel: 'Accepted',
  ...over,
});

describe('days', () => {
  it('knows a real calendar day from text that only looks like one', () => {
    expect(isDay('2027-03-06')).toBe(true);
    expect(isDay('2028-02-29')).toBe(true);
    for (const bad of [
      '2027-02-29',
      '2027-13-01',
      '2027-3-6',
      '2027-03-06T09:00',
      '',
      null,
      20270306,
    ]) {
      expect(isDay(bad), String(bad)).toBe(false);
    }
  });

  it('adds and counts days across a month, a year and a daylight-saving change', () => {
    expect(addDays('2027-01-31', 1)).toBe('2027-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-03-01', -1)).toBe('2027-02-28');
    // 14 March 2027 is when clocks change in North America; a day is still a day.
    expect(addDays('2027-03-13', 2)).toBe('2027-03-15');
    expect(daysBetween('2027-03-13', '2027-03-15')).toBe(2);
    expect(daysBetween('2027-03-15', '2027-03-13')).toBe(-2);
    expect(daysBetween('2027-03-15', 'soon')).toBeNull();
  });

  it('reads today from the reader’s own clock, as a day', () => {
    expect(todayDay(NOW)).toBe('2026-11-24');
    // Late evening stays the same day: no shift to UTC's tomorrow.
    expect(todayDay(new Date(2026, 10, 24, 23, 59))).toBe('2026-11-24');
  });
});

describe('ranges', () => {
  it('reads an event’s first and last day, and treats a bad end as one day', () => {
    expect(eventRange(event())).toEqual({ start: '2027-03-06', end: '2027-03-07' });
    expect(eventRange(event({ endDate: '2027-03-01' }))).toEqual({
      start: '2027-03-06',
      end: '2027-03-06',
    });
    expect(eventRange(event({ endDate: null }))).toEqual({
      start: '2027-03-06',
      end: '2027-03-06',
    });
    expect(eventRange(event({ startDate: 'tbd' }))).toBeNull();
    expect(eventRange(null)).toBeNull();
  });

  it.each([
    ['the same single day', ['2027-03-06', '2027-03-06'], ['2027-03-06', '2027-03-06'], true],
    [
      'touching on one shared day',
      ['2027-03-06', '2027-03-07'],
      ['2027-03-07', '2027-03-09'],
      true,
    ],
    ['one inside the other', ['2027-03-01', '2027-03-10'], ['2027-03-04', '2027-03-05'], true],
    [
      'next to each other, no shared day',
      ['2027-03-06', '2027-03-07'],
      ['2027-03-08', '2027-03-09'],
      false,
    ],
    ['across a month’s end', ['2027-03-30', '2027-04-02'], ['2027-04-01', '2027-04-01'], true],
    ['across a year’s end', ['2026-12-30', '2027-01-02'], ['2027-01-02', '2027-01-03'], true],
    ['a year apart', ['2026-03-06', '2026-03-07'], ['2027-03-06', '2027-03-07'], false],
  ])('%s', (_name, [aStart, aEnd], [bStart, bEnd], expected) => {
    const a = { start: aStart, end: aEnd };
    const b = { start: bStart, end: bEnd };
    expect(rangesOverlap(a, b)).toBe(expected);
    expect(rangesOverlap(b, a)).toBe(expected);
  });

  it('never overlaps a missing range', () => {
    expect(rangesOverlap(null, { start: '2027-03-06', end: '2027-03-06' })).toBe(false);
  });
});

describe('the owner’s own talks', () => {
  const rows = {
    mergedEvents: [
      { id: 101, name: 'Future Conf', date: '2027-03-06T00:00:00', _storedDoc: null },
      {
        id: 102,
        name: 'Sent Conf',
        date: '2027-04-10',
        _storedDoc: { status: 'proposed', cfpDeadline: '2027-01-05', date: '2027-04-11' },
      },
      { id: 103, name: 'Declined Conf', date: '2027-05-01', _storedDoc: { status: 'declined' } },
      { id: 104, name: 'Old Conf', date: '2025-05-01', _storedDoc: null },
    ],
    manualEntries: [
      { _docId: 'm1', eventName: 'Idea Meetup', date: '2027-03-06', status: 'idea' },
      { _docId: 'm2', eventName: 'Undated Talk', status: 'accepted' },
      { _docId: 'm3', eventName: 'Manual Accepted', date: '2027-06-01', status: 'accepted' },
    ],
  };

  it('reads each row’s day and status, the stored override first', () => {
    const talks = ownTalks(rows, NOW);
    expect(talks.map((t) => [t.name, t.day, t.status])).toEqual([
      ['Future Conf', '2027-03-06', 'accepted'],
      ['Sent Conf', '2027-04-11', 'proposed'],
      ['Declined Conf', '2027-05-01', 'declined'],
      ['Old Conf', '2025-05-01', 'delivered'],
      ['Idea Meetup', '2027-03-06', 'idea'],
      ['Undated Talk', null, 'accepted'],
      ['Manual Accepted', '2027-06-01', 'accepted'],
    ]);
    expect(talks[1].cfpDeadline).toBe('2027-01-05');
    expect(talks[0].statusLabel).toBe('Accepted');
    expect(ownTalks(undefined)).toEqual([]);
  });

  it('counts only talks that are sent or accepted and have a day', () => {
    expect(committedTalks(ownTalks(rows, NOW)).map((t) => t.name)).toEqual([
      'Future Conf',
      'Sent Conf',
      'Manual Accepted',
    ]);
  });
});

describe('what clashes', () => {
  const against = (events, talks = [], saved = []) => {
    const known = knownEvents(events, saved);
    return (id) =>
      overlapsFor(
        known.find((e) => e.id === id),
        { talks, known }
      );
  };
  // An event the owner cares about: marked Interested, Applied or Accepted.
  const planned = (over = {}) => event({ note: { status: 'applied' }, ...over });

  it('knows which statuses put an event in the owner’s plans and which take it out', () => {
    expect(['interested', 'applied', 'accepted'].every(isPlanned)).toBe(true);
    expect(['', 'declined', 'not_going', undefined].some(isPlanned)).toBe(false);
    expect(['declined', 'not_going'].every(isDropped)).toBe(true);
    expect(['', 'interested', 'applied', 'accepted', undefined].some(isDropped)).toBe(false);
  });

  it('flags a talk on the first, a middle or the last day of a planned multi-day event, and not the day before or after', () => {
    const three = planned({ startDate: '2027-03-05', endDate: '2027-03-07' });
    for (const day of ['2027-03-05', '2027-03-06', '2027-03-07']) {
      expect(against([three], [talk({ day })])('event-1').clashes, day).toHaveLength(1);
    }
    for (const day of ['2027-03-04', '2027-03-08']) {
      expect(against([three], [talk({ day })])('event-1').clashes, day).toEqual([]);
    }
  });

  it.each(['interested', 'applied', 'accepted'])(
    'counts an event marked %s as one of the owner’s own things',
    (status) => {
      const result = against([event({ note: { status } })], [talk()])('event-1');
      expect(result.clashes).toHaveLength(1);
      expect(result.wouldMeet).toEqual([]);
    }
  );

  it('says what it clashes with, in words', () => {
    const result = against(
      [planned()],
      [talk({ status: 'proposed', statusLabel: 'Proposed' })]
    )('event-1');
    expect(result.clashes).toEqual([
      { kind: 'talk', name: 'Other Conf', detail: 'Proposed talk on Mar 6, 2027' },
    ]);
  });

  it('does not call it a clash when the event has no status: it only says what the dates would meet', () => {
    // This used to be a clash: any listed event with one of the owner's talks
    // on its days. With hundreds of listed events that marked almost any day.
    const result = against([event()], [talk()])('event-1');
    expect(result.clashes).toEqual([]);
    expect(result.wouldMeet).toEqual([
      { kind: 'talk', name: 'Other Conf', detail: 'Accepted talk on Mar 6, 2027' },
    ]);
  });

  it.each(['declined', 'not_going'])(
    'says nothing at all for an event marked %s, and such an event clashes with nothing',
    (status) => {
      const dropped = event({ note: { status } });
      expect(against([dropped], [talk()])('event-1')).toEqual({
        clashes: [],
        wouldMeet: [],
        speakingHere: null,
      });
      const other = planned({ id: 'event-2', title: 'Second Day' });
      expect(against([dropped, other])('event-2').clashes).toEqual([]);
    }
  );

  it('ignores talks that are only an idea, declined, delivered or undated', () => {
    const talks = [
      talk({ status: 'idea' }),
      talk({ status: 'declined' }),
      talk({ status: 'delivered' }),
      talk({ day: null }),
    ];
    expect(against([planned()], talks)('event-1')).toEqual({
      clashes: [],
      wouldMeet: [],
      speakingHere: null,
    });
  });

  it('says "already speaking here" when the talk is this same event, not a clash', () => {
    for (const row of [event(), planned()]) {
      const result = against([row], [talk({ name: '  example community day ' })])('event-1');
      expect(result.clashes).toEqual([]);
      expect(result.wouldMeet).toEqual([]);
      expect(result.speakingHere).toBe('Accepted');
    }
  });

  it('flags two events against each other only when the owner planned both', () => {
    const other = (status) =>
      event({
        id: 'event-2',
        title: 'Second Day',
        startDate: '2027-03-07',
        endDate: '2027-03-08',
        note: status ? { status } : null,
      });
    for (const status of ['interested', 'applied', 'accepted']) {
      const of = against([planned(), other(status)]);
      expect(of('event-1').clashes, status).toEqual([
        {
          kind: 'event',
          name: 'Second Day',
          detail: `${applyStatusInfo(status).label}, Mar 7–8, 2027`,
        },
      ]);
      expect(of('event-2').clashes, status).toEqual([
        { kind: 'event', name: 'Example Community Day', detail: 'Applied, Mar 6–7, 2027' },
      ]);
    }
    // The other event is not one the owner cares about: no clash on either row.
    for (const status of [null, 'declined', 'not_going']) {
      const of = against([planned(), other(status)]);
      expect(of('event-1').clashes, String(status)).toEqual([]);
      expect(of('event-2').clashes, String(status)).toEqual([]);
    }
  });

  it('tells an unmarked event what it would meet, without flagging either row', () => {
    // This used to flag the unmarked row with "Clash".
    const unmarked = event();
    const applied = planned({ id: 'event-2', title: 'Second Day' });
    const of = against([unmarked, applied]);
    expect(of('event-1').clashes).toEqual([]);
    expect(of('event-1').wouldMeet).toEqual([
      { kind: 'event', name: 'Second Day', detail: 'Applied, Mar 6–7, 2027' },
    ]);
    expect(of('event-2')).toEqual({ clashes: [], wouldMeet: [], speakingHere: null });
  });

  it('says nothing between two events the owner has not marked', () => {
    const of = against([event(), event({ id: 'event-2', title: 'Second Day' })]);
    for (const id of ['event-1', 'event-2']) {
      expect(of(id)).toEqual({ clashes: [], wouldMeet: [], speakingHere: null });
    }
  });

  it('counts an event the owner applied to that is no longer listed', () => {
    const saved = [
      {
        eventId: 'event-gone',
        status: 'applied',
        event: { title: 'Closed Call Day', startDate: '2027-03-07', endDate: '2027-03-07' },
      },
    ];
    const of = against([planned()], [], saved);
    expect(of('event-1').clashes).toEqual([
      { kind: 'event', name: 'Closed Call Day', detail: 'Applied, Mar 7, 2027' },
    ]);
    // And the saved one is flagged too: it is still the owner's commitment.
    expect(of('event-gone').clashes).toEqual([
      { kind: 'event', name: 'Example Community Day', detail: 'Applied, Mar 6–7, 2027' },
    ]);
  });

  it('never flags a cancelled or postponed event, in either direction', () => {
    for (const flag of ['cancelled', 'postponed']) {
      const off = planned({ [flag]: true });
      expect(against([off], [talk()])('event-1'), flag).toEqual({
        clashes: [],
        wouldMeet: [],
        speakingHere: null,
      });
      const offApplied = planned({ id: 'event-2', title: 'Off Day', [flag]: true });
      expect(against([planned(), offApplied])('event-1').clashes, flag).toEqual([]);
    }
  });

  it('does not flag an event against itself', () => {
    expect(against([planned()])('event-1').clashes).toEqual([]);
  });

  it('answers for every listed and saved event at once', () => {
    const overlaps = allOverlaps({ events: [planned()], saved: [], talks: [talk()] });
    expect([...overlaps.keys()]).toEqual(['event-1']);
    expect(overlaps.get('event-1').clashes).toHaveLength(1);
  });
});

describe('the calendar', () => {
  it('lays a month out in weeks from Sunday, with blanks around it', () => {
    const march = monthGrid(2027, 2); // 1 March 2027 is a Monday
    expect(march[0]).toEqual([
      null,
      { day: '2027-03-01', date: 1 },
      ...[2, 3, 4, 5, 6].map((d) => ({ day: `2027-03-0${d}`, date: d })),
    ]);
    expect(march.every((week) => week.length === 7)).toBe(true);
    expect(march.flat().filter(Boolean)).toHaveLength(31);
    expect(monthGrid(2028, 1).flat().filter(Boolean)).toHaveLength(29);
    // A month that starts on Sunday has no leading blank.
    expect(monthGrid(2027, 7)[0][0]).toEqual({ day: '2027-08-01', date: 1 });
  });

  it('moves between months across a year’s end', () => {
    expect(shiftMonth({ year: 2026, monthIndex: 11 }, 1)).toEqual({ year: 2027, monthIndex: 0 });
    expect(shiftMonth({ year: 2027, monthIndex: 0 }, -1)).toEqual({ year: 2026, monthIndex: 11 });
  });

  it('marks every day of a planned multi-day event, the owner’s talks and the closing calls', () => {
    const marks = marksForMonth(
      { year: 2027, monthIndex: 2 },
      {
        events: [event({ callCloses: '2027-03-01', note: { status: 'interested' } })],
        saved: [],
        talks: [talk({ day: '2027-03-20' }), talk({ day: '2027-03-21', status: 'idea' })],
      }
    );
    expect([...marks.keys()].sort()).toEqual([
      '2027-03-01',
      '2027-03-06',
      '2027-03-07',
      '2027-03-20',
    ]);
    expect(marks.get('2027-03-06').events).toEqual([
      { id: 'event-1', title: 'Example Community Day', status: 'interested', listed: true },
    ]);
    expect(marks.get('2027-03-06').unmarked).toEqual([]);
    expect(marks.get('2027-03-20').talks).toEqual([
      { name: 'Other Conf', statusLabel: 'Accepted' },
    ]);
    expect(marks.get('2027-03-01').deadlines).toEqual([{ title: 'Example Community Day' }]);
    expect([...marks.values()].some((mark) => mark.overlap)).toBe(false);
  });

  it('shows an event that runs across a month’s end in both months, only on its own days', () => {
    const spanning = event({ startDate: '2027-03-30', endDate: '2027-04-02' });
    const march = marksForMonth(
      { year: 2027, monthIndex: 2 },
      { events: [spanning], saved: [], talks: [] }
    );
    const april = marksForMonth(
      { year: 2027, monthIndex: 3 },
      { events: [spanning], saved: [], talks: [] }
    );
    expect([...march.keys()].sort()).toEqual(['2027-03-30', '2027-03-31']);
    expect([...april.keys()].sort()).toEqual(['2027-04-01', '2027-04-02']);
    const may = marksForMonth(
      { year: 2027, monthIndex: 4 },
      { events: [spanning], saved: [], talks: [] }
    );
    expect(may.size).toBe(0);
  });

  const march = (input) => marksForMonth({ year: 2027, monthIndex: 2 }, input);
  const marked = (status, over = {}) => event({ note: { status }, ...over });
  const anyClash = (marks) => [...marks.values()].some((mark) => mark.overlap);

  it('keeps an event with no status apart from the planned ones, as a quiet mark', () => {
    const marks = march({ events: [event()], saved: [], talks: [] });
    expect(marks.get('2027-03-06')).toEqual({
      events: [],
      unmarked: [{ id: 'event-1', title: 'Example Community Day', status: '', listed: true }],
      talks: [],
      deadlines: [],
      overlap: false,
    });
  });

  it('flags the day a talk meets a planned event, and only that day', () => {
    for (const status of ['interested', 'applied', 'accepted']) {
      const marks = march({
        events: [marked(status)],
        saved: [],
        talks: [talk({ day: '2027-03-07' })],
      });
      expect(marks.get('2027-03-06').overlap, status).toBe(false);
      expect(marks.get('2027-03-07').overlap, status).toBe(true);
    }
  });

  it('does not flag a talk on the day of an event the owner has not marked', () => {
    // The old rule flagged this: one of the owner's talks on ANY listed event.
    const marks = march({ events: [event()], saved: [], talks: [talk({ day: '2027-03-07' })] });
    expect(anyClash(marks)).toBe(false);
    // The talk and the quiet mark are both still there to be read.
    expect(marks.get('2027-03-07').talks).toHaveLength(1);
    expect(marks.get('2027-03-07').unmarked).toHaveLength(1);
  });

  it('does not flag a busy day of many unmarked events around one the owner applied to', () => {
    // The old rule flagged this too: two events on a day, one of them Applied.
    const crowd = Array.from({ length: 40 }, (_, n) =>
      event({ id: `crowd-${n}`, title: `Elsewhere ${n}` })
    );
    const marks = march({ events: [marked('applied'), ...crowd], saved: [], talks: [] });
    expect(anyClash(marks)).toBe(false);
    expect(marks.get('2027-03-06').events).toHaveLength(1);
    expect(marks.get('2027-03-06').unmarked).toHaveLength(40);
  });

  it('leaves events marked Not going or Declined off the calendar, with their closing days', () => {
    const marks = march({
      events: [
        marked('not_going', { callCloses: '2027-03-02' }),
        marked('declined', { id: 'event-2', title: 'Second Day', callCloses: '2027-03-03' }),
      ],
      saved: [
        {
          eventId: 'event-gone',
          status: 'declined',
          event: { title: 'Closed Call Day', startDate: '2027-03-09', endDate: '2027-03-09' },
        },
      ],
      talks: [talk({ day: '2027-03-06' })],
    });
    // Only the owner's talk is left; nothing clashes with it.
    expect([...marks.keys()]).toEqual(['2027-03-06']);
    expect(marks.get('2027-03-06')).toMatchObject({ events: [], unmarked: [], overlap: false });
  });

  it('does not flag the day of a talk at the same event', () => {
    const marks = march({
      events: [marked('accepted')],
      saved: [],
      talks: [talk({ name: 'Example Community Day' })],
    });
    expect(marks.get('2027-03-06').overlap).toBe(false);
  });

  it('flags the shared days of two events only when the owner planned both', () => {
    const second = (status) =>
      event({
        id: 'event-2',
        title: 'Second Day',
        startDate: '2027-03-07',
        endDate: '2027-03-08',
        note: status ? { status } : null,
      });
    for (const [first, other] of [
      [null, null],
      [null, 'applied'],
      ['applied', null],
      ['applied', 'declined'],
      ['accepted', 'not_going'],
    ]) {
      const quiet = march({ events: [marked(first ?? ''), second(other)], saved: [], talks: [] });
      expect(anyClash(quiet), `${first} and ${other}`).toBe(false);
    }
    for (const [first, other] of [
      ['applied', 'applied'],
      ['interested', 'interested'],
      ['accepted', 'interested'],
    ]) {
      const both = march({ events: [marked(first), second(other)], saved: [], talks: [] });
      expect(both.get('2027-03-06').overlap, `${first} and ${other}`).toBe(false);
      expect(both.get('2027-03-07').overlap, `${first} and ${other}`).toBe(true);
      expect(both.get('2027-03-08').overlap, `${first} and ${other}`).toBe(false);
    }
  });

  it('agrees with the rows: a day is a clash day exactly when a row says Clash for it', () => {
    const events = [
      marked('applied'),
      event({ id: 'event-2', title: 'Unmarked Day' }),
      marked('interested', {
        id: 'event-3',
        title: 'Maybe Day',
        startDate: '2027-03-20',
        endDate: '2027-03-20',
      }),
      marked('declined', { id: 'event-4', title: 'Dropped Day' }),
    ];
    const talks = [talk({ day: '2027-03-07' }), talk({ name: 'Third Conf', day: '2027-03-20' })];
    const overlaps = allOverlaps({ events, saved: [], talks });
    const rowsWithClash = [...overlaps.entries()]
      .filter(([, o]) => o.clashes.length > 0)
      .map(([id]) => id);
    expect(rowsWithClash).toEqual(['event-1', 'event-3']);
    const clashDays = [...march({ events, saved: [], talks }).entries()]
      .filter(([, mark]) => mark.overlap)
      .map(([day]) => day)
      .sort();
    expect(clashDays).toEqual(['2027-03-07', '2027-03-20']);
  });

  it('leaves cancelled and postponed events off, and their closing calls when cancelled', () => {
    const marks = marksForMonth(
      { year: 2027, monthIndex: 2 },
      {
        events: [
          event({ cancelled: true, callCloses: '2027-03-02' }),
          event({ id: 'event-2', postponed: true, callCloses: null }),
        ],
        saved: [],
        talks: [],
      }
    );
    expect(marks.size).toBe(0);
  });

  it('includes saved events that are no longer listed', () => {
    const saved = [
      {
        eventId: 'event-gone',
        status: 'accepted',
        event: { title: 'Closed Call Day', startDate: '2027-03-09', endDate: '2027-03-09' },
      },
    ];
    const marks = marksForMonth({ year: 2027, monthIndex: 2 }, { events: [], saved, talks: [] });
    expect(marks.get('2027-03-09').unmarked).toEqual([]);
    expect(marks.get('2027-03-09').events).toEqual([
      { id: 'event-gone', title: 'Closed Call Day', status: 'accepted', listed: false },
    ]);
  });

  it('opens on the month of the first event still to come, else this month', () => {
    const events = [
      event({ startDate: '2026-10-01', endDate: '2026-10-01' }),
      event({ id: 'e2', startDate: '2027-02-10', endDate: '2027-02-10' }),
      event({ id: 'e3', cancelled: true, startDate: '2026-12-01' }),
    ];
    expect(firstMonth(events, '2026-11-24')).toEqual({ year: 2027, monthIndex: 1 });
    expect(firstMonth([], '2026-11-24')).toEqual({ year: 2026, monthIndex: 10 });
  });
});

describe('what a row shows', () => {
  it('writes a day and a range the way a person reads them', () => {
    expect(formatDay('2027-03-06')).toBe('Mar 6, 2027');
    expect(formatDay('nope')).toBe('—');
    expect(formatRange({ start: '2027-03-06', end: '2027-03-06' })).toBe('Mar 6, 2027');
    expect(formatRange({ start: '2027-03-06', end: '2027-03-07' })).toBe('Mar 6–7, 2027');
    expect(formatRange({ start: '2027-03-31', end: '2027-04-02' })).toBe('Mar 31 – Apr 2, 2027');
    expect(formatRange({ start: '2026-12-31', end: '2027-01-02' })).toBe(
      'Dec 31, 2026 – Jan 2, 2027'
    );
    expect(formatRange(null)).toBe('—');
  });

  it('says how long a call has left, and when it has closed', () => {
    expect(callCloseInfo('2027-01-15', '2026-11-24')).toEqual({
      label: 'Closes Jan 15, 2027, about 52 days left',
      tone: 'muted',
      left: 52,
    });
    expect(callCloseInfo('2026-11-25', '2026-11-24')).toMatchObject({
      label: 'Closes Nov 25, 2026, about 1 day left',
      tone: 'warn',
    });
    expect(callCloseInfo('2026-12-01', '2026-11-24').tone).toBe('warn');
    expect(callCloseInfo('2026-12-02', '2026-11-24').tone).toBe('muted');
    expect(callCloseInfo('2026-11-24', '2026-11-24')).toMatchObject({
      label: 'Closes today (Nov 24, 2026)',
      tone: 'warn',
      left: 0,
    });
    expect(callCloseInfo('2026-11-23', '2026-11-24')).toMatchObject({
      label: 'Closed Nov 23, 2026',
      tone: 'bad',
      left: -1,
    });
    expect(callCloseInfo(null, '2026-11-24')).toEqual({
      label: 'No closing date given',
      tone: 'muted',
      left: null,
    });
  });

  it('writes the place and kind on one line', () => {
    expect(locationLine(event())).toBe('Exampleville, Ontario, CA (In Person)');
    expect(locationLine(event({ city: '', region: '', country: '', eventType: 'Virtual' }))).toBe(
      '(Virtual)'
    );
    expect(locationLine({})).toBe('Place not given');
    expect(attendanceCost(['Free', 'Paid'])).toBe('Free, Paid');
    expect(attendanceCost([])).toBe('Not given');
  });

  it('adds up only the cost boxes that hold a number', () => {
    expect(costTotal({ travel: 320.5, lodging: 410, other: null })).toBe(730.5);
    expect(costTotal({ travel: '10.10', lodging: '0.20', other: '' })).toBe(10.3);
    expect(costTotal({ travel: 0 })).toBe(0);
    expect(costTotal({ travel: '', lodging: null })).toBeNull();
    expect(costTotal(undefined)).toBeNull();
    expect(parseCost('-5')).toBeNull();
    expect(parseCost('abc')).toBeNull();
    expect(parseCost(' 12.345 ')).toBe(12.35);
  });

  it('turns a note into a form and a form into what a save sends', () => {
    expect(noteForm(null)).toEqual({
      status: '',
      notes: '',
      costs: { travel: '', lodging: '', other: '' },
    });
    const form = noteForm({
      status: 'applied',
      notes: 'n',
      costs: { travel: 10, lodging: null, other: 0 },
    });
    expect(form).toEqual({
      status: 'applied',
      notes: 'n',
      costs: { travel: '10', lodging: '', other: '0' },
    });
    expect(notePayload(form)).toEqual({
      payload: { status: 'applied', notes: 'n', costs: { travel: 10, lodging: null, other: 0 } },
    });
    expect(notePayload({ ...form, costs: { ...form.costs, lodging: 'a lot' } })).toEqual({
      invalid: 'Lodging must be a number of 0 or more, or empty.',
    });
  });

  it('has a label for every status, and for none', () => {
    expect(APPLY_STATUSES).toEqual([
      '',
      'interested',
      'applied',
      'accepted',
      'declined',
      'not_going',
    ]);
    expect(applyStatusInfo('applied').label).toBe('Applied');
    expect(applyStatusInfo('made-up').label).toBe('Not decided');
    expect(applyStatusInfo(undefined).label).toBe('Not decided');
  });

  it('filters by search and by the owner’s status', () => {
    const events = [
      event(),
      event({ id: 'e2', title: 'Cloud Fest', city: 'Sampletown', note: { status: 'not_going' } }),
      event({ id: 'e3', title: 'Data Day', note: { status: 'applied' } }),
    ];
    expect(filterEvents(events, { status: 'open' }).map((e) => e.id)).toEqual(['event-1', 'e3']);
    expect(filterEvents(events, { status: 'all' })).toHaveLength(3);
    expect(filterEvents(events, { status: 'applied' }).map((e) => e.id)).toEqual(['e3']);
    expect(filterEvents(events, { status: '' }).map((e) => e.id)).toEqual(['event-1']);
    expect(
      filterEvents(events, { status: 'all', search: ' sampletown ' }).map((e) => e.id)
    ).toEqual(['e2']);
    expect(filterEvents(undefined)).toEqual([]);
  });
});
