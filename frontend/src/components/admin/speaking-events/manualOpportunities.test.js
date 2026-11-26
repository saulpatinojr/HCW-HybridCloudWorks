/**
 * The owner's own speaking ideas as Future Events rows: which entries are
 * listed, that none doubles a directory row, and that slotting them in never
 * reorders the directory's rows.
 */
import { describe, it, expect } from 'vitest';
import {
  MANUAL_ID_PREFIX,
  manualOpportunities,
  manualRow,
  withManualRows,
} from './manualOpportunities';
import { allOverlaps, marksForMonth } from './applyCalendarModel';
import { callCloseInfo, filterEvents, locationLine } from './applyModel';

const NOW = new Date('2099-01-01T12:00:00Z');

const entry = (over = {}) => ({
  _docId: 'example-conf-2099',
  eventName: 'Example Conf 2099',
  date: '2099-08-02',
  status: 'idea',
  cfpDeadline: '2099-01-14',
  location: 'Exampleton, WA',
  eventUrl: 'https://example.org/conf',
  description: 'Two talk ideas.',
  display: false,
  ...over,
});

const feedEvent = (over = {}) => ({
  id: 'event-1',
  title: 'Example Community Day',
  startDate: '2099-03-06',
  endDate: '2099-03-07',
  callCloses: '2099-01-15',
  note: null,
  ...over,
});

describe('a manual entry as a row', () => {
  it('carries its name, day, closing day, place, page and description, under an id of its own', () => {
    const row = manualRow(entry());
    expect(row).toMatchObject({
      id: `${MANUAL_ID_PREFIX}example-conf-2099`,
      manual: true,
      docId: 'example-conf-2099',
      title: 'Example Conf 2099',
      startDate: '2099-08-02',
      endDate: '2099-08-02',
      callCloses: '2099-01-14',
      place: 'Exampleton, WA',
      url: 'https://example.org/conf',
      callUrl: null,
      entryNotes: 'Two talk ideas.',
      note: null,
    });
    expect(locationLine(row)).toBe('Exampleton, WA');
    expect(callCloseInfo(row.callCloses, '2099-01-01').label).toBe(
      'Closes Jan 14, 2099, about 13 days left'
    );
  });

  it('never makes a link from anything but http or https', () => {
    expect(manualRow(entry({ eventUrl: 'javascript:alert(1)' })).url).toBeNull();
  });

  it('reads a stored timestamp as its day, and an undated entry as no range', () => {
    expect(manualRow(entry({ date: '2099-08-02T00:00:00.000Z' })).startDate).toBe('2099-08-02');
    expect(manualRow(entry({ date: null })).startDate).toBeNull();
  });
});

describe('which entries are listed', () => {
  it('lists an Idea, and leaves out Proposed, Accepted, Declined and Delivered', () => {
    const rows = manualOpportunities(
      [
        entry(),
        entry({ _docId: 'p', eventName: 'Proposed Conf', status: 'proposed' }),
        entry({ _docId: 'a', eventName: 'Accepted Conf', status: 'accepted' }),
        entry({ _docId: 'd', eventName: 'Declined Conf', status: 'declined' }),
        entry({ _docId: 'x', eventName: 'Delivered Conf', status: 'delivered' }),
      ],
      {},
      NOW
    );
    expect(rows.map((row) => row.title)).toEqual(['Example Conf 2099']);
  });

  it('treats an entry with no status as an Idea until its day has passed', () => {
    const future = entry({ status: undefined });
    const past = entry({
      _docId: 'old',
      eventName: 'Old Conf',
      status: undefined,
      date: '2098-05-01',
    });
    expect(manualOpportunities([future, past], {}, NOW).map((row) => row.title)).toEqual([
      'Example Conf 2099',
    ]);
  });

  it('leaves out an entry with the same name as a listed or saved directory event', () => {
    const entries = [
      entry({ eventName: 'example community day ' }),
      entry({ _docId: 'gone', eventName: 'Closed Call Day' }),
      entry({ _docId: 'own', eventName: 'Only Mine' }),
    ];
    const rows = manualOpportunities(
      entries,
      {
        events: [feedEvent()],
        saved: [{ eventId: 'event-9', event: { title: 'Closed Call Day' } }],
      },
      NOW
    );
    expect(rows.map((row) => row.title)).toEqual(['Only Mine']);
  });

  it('leaves out an Idea whose day has passed, and keeps one with no date or still running', () => {
    const rows = manualOpportunities(
      [
        entry({ _docId: 'past', eventName: 'Past Idea', date: '2098-12-31' }),
        entry({ _docId: 'undated', eventName: 'Undated Idea', date: null }),
        entry({
          _docId: 'running',
          eventName: 'Running Idea',
          date: '2098-12-31',
          endDate: '2099-01-02',
        }),
        entry({ _docId: 'today', eventName: 'Today Idea', date: '2099-01-01' }),
      ],
      {},
      NOW
    );
    expect(rows.map((row) => row.title)).toEqual(['Undated Idea', 'Running Idea', 'Today Idea']);
  });

  it('never lists a stored Sessionize record, even when Sessionize could not be read', () => {
    // While Sessionize is unreachable every stored row reaches `manualEntries`,
    // and one with no status of its own would otherwise read as an Idea.
    const rows = manualOpportunities(
      [
        entry({
          _docId: 'by-event-id',
          eventName: 'Sessionize Talk',
          status: undefined,
          eventId: 7,
        }),
        entry({ _docId: 'by-sessionize-id', eventName: 'Other Talk', sessionizeId: '9' }),
        entry({ _docId: 'own', eventName: 'Only Mine' }),
      ],
      {},
      NOW
    );
    expect(rows.map((row) => row.title)).toEqual(['Only Mine']);
  });

  it('lists nothing when the hub has no entries yet', () => {
    expect(manualOpportunities(undefined, {}, NOW)).toEqual([]);
  });
});

describe('slotting them in', () => {
  const feed = [
    feedEvent({ id: 'a', startDate: '2099-03-01' }),
    feedEvent({ id: 'b', startDate: '2099-05-01' }),
    feedEvent({ id: 'c', startDate: '2099-09-01' }),
  ];

  it('gives back the directory list itself when there is nothing to add', () => {
    expect(withManualRows(feed, [])).toBe(feed);
  });

  it('puts each manual row before the first directory row that starts later, and undated ones last', () => {
    const manual = [
      manualRow(entry({ _docId: 'm2', date: '2099-08-02' })),
      manualRow(entry({ _docId: 'm1', date: '2099-04-01' })),
      manualRow(entry({ _docId: 'm0', date: null })),
    ];
    expect(withManualRows(feed, manual).map((row) => row.id)).toEqual([
      'a',
      'manual-m1',
      'b',
      'manual-m2',
      'c',
      'manual-m0',
    ]);
  });

  it('never changes the order of the directory rows', () => {
    const unsorted = [feed[2], feed[0], feed[1]];
    const merged = withManualRows(unsorted, [manualRow(entry())]);
    expect(merged.filter((row) => !row.manual).map((row) => row.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('the tab’s rules apply to them', () => {
  it('tells a manual idea what its dates would meet, without calling it a clash', () => {
    const manual = manualRow(entry({ date: '2099-03-06' }));
    const planned = feedEvent({ note: { status: 'applied' } });
    const overlaps = allOverlaps({ events: [planned, manual], saved: [], talks: [] });
    expect(overlaps.get(manual.id).clashes).toEqual([]);
    expect(overlaps.get(manual.id).wouldMeet.map((m) => m.name)).toEqual(['Example Community Day']);
    // And it does not make a clash for the planned directory event.
    expect(overlaps.get('event-1').clashes).toEqual([]);
  });

  it('marks its day and its closing day on the calendar', () => {
    const manual = manualRow(entry());
    const august = marksForMonth(
      { year: 2099, monthIndex: 7 },
      { events: [manual], saved: [], talks: [] }
    );
    expect(august.get('2099-08-02').unmarked.map((m) => m.title)).toEqual(['Example Conf 2099']);
    const january = marksForMonth(
      { year: 2099, monthIndex: 0 },
      { events: [manual], saved: [], talks: [] }
    );
    expect(january.get('2099-01-14').deadlines).toEqual([{ title: 'Example Conf 2099' }]);
  });

  it('is found by the search box by its place, and kept by the default filter', () => {
    const manual = manualRow(entry());
    expect(filterEvents([manual], { search: 'exampleton' })).toEqual([manual]);
    expect(filterEvents([manual], { status: 'open' })).toEqual([manual]);
    expect(filterEvents([manual], { status: 'applied' })).toEqual([]);
  });
});
