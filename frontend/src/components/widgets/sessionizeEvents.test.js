/**
 * The speaking widget's pure rules (ADR 0033, Spotlight slice): coordinates
 * and labels in the display format, a snapshot row read whatever its
 * spelling, the merge with Sessionize (tombstones, id and name matches,
 * manual entries), the sort, the three sections and one card's view.
 */
import { describe, it, expect } from 'vitest';
import {
  combineEvents,
  compareEventDates,
  formatLocationFromAddress,
  groupSessions,
  locationLink,
  locationText,
  normalizeEvent,
  normalizeLocationLabel,
  parseCoords,
  sessionView,
  SPEAKING_YEAR_GRACE_MONTHS,
  speakingYear,
} from './sessionizeEvents';

const NOW = new Date(2026, 8, 14, 9); // 14 Sep 2026, 09:00 local

describe('coordinates', () => {
  it('reads a pair from text, from either object spelling and from a GeoPoint', () => {
    expect(parseCoords('41.88, -87.63')).toEqual({ lat: 41.88, lng: -87.63 });
    expect(parseCoords({ lat: '1', lng: '2' })).toEqual({ lat: 1, lng: 2 });
    expect(parseCoords({ latitude: 3, longitude: 4 })).toEqual({ lat: 3, lng: 4 });
    expect(parseCoords({ _lat: 5, _long: 6 })).toEqual({ lat: 5, lng: 6 });
    expect(parseCoords('Chicago, IL')).toBeNull();
    expect(parseCoords({ city: 'x' })).toBeNull();
    expect(parseCoords(null)).toBeNull();
  });
});

describe('location labels', () => {
  it('formats a Nominatim address as City, State in the US and City, Country elsewhere', () => {
    expect(
      formatLocationFromAddress({ city: 'Chicago', state: 'Illinois', country: 'United States' })
    ).toBe('Chicago, Illinois');
    expect(formatLocationFromAddress({ town: 'Oakville', country: 'Canada' })).toBe(
      'Oakville, Canada'
    );
    expect(formatLocationFromAddress({ country: 'United States' })).toBe('United States');
    expect(formatLocationFromAddress({})).toBe('');
  });

  it('shortens a free-text label the same way and leaves virtual and coordinate labels alone', () => {
    expect(normalizeLocationLabel('Chicago, IL, United States')).toBe('Chicago, IL');
    expect(normalizeLocationLabel('Austin, USA')).toBe('Austin');
    expect(normalizeLocationLabel('Toronto, Ontario, Canada')).toBe('Toronto, Canada');
    expect(normalizeLocationLabel('  Virtual ')).toBe('Virtual');
    expect(normalizeLocationLabel('41.88, -87.63')).toBe('41.88, -87.63');
    expect(normalizeLocationLabel('Denver')).toBe('Denver');
    expect(normalizeLocationLabel(null)).toBeNull();
  });

  it('turns a location into text and a map link, with none for virtual events', () => {
    expect(locationText({ lat: 1.5, lng: 2 })).toBe('1.5, 2');
    expect(locationText('Chicago, IL, United States')).toBe('Chicago, IL');
    expect(locationLink('Chicago, IL')).toBe('https://www.google.com/maps/search/Chicago%2C%20IL');
    expect(locationLink({ lat: 1, lng: 2 })).toBe('https://www.google.com/maps/search/1%2C2');
    expect(locationLink('Virtual event')).toBeNull();
    expect(locationLink('')).toBeNull();
  });
});

describe('normalizeEvent', () => {
  it('reads a stored row whatever the spelling of its keys and dates', () => {
    const event = normalizeEvent({
      id: 'row-1',
      EventName: ' KCDC ',
      Date: '2026-08-14T05:00:00.000Z',
      SessionizeId: '42',
      Images: [{ downloadURL: 'https://img/stored.png' }],
      eventImageUrl: 'https://img/external.png',
      sessions: [{ slidesUrl: 'https://slides/x' }],
      Display: true,
    });
    expect(event).toMatchObject({
      id: 'row-1',
      name: 'KCDC',
      date: '2026-08-14',
      sessionizeId: 42,
      image: 'https://img/stored.png',
      eventImageUrl: 'https://img/external.png',
      presentationUrl: 'https://slides/x',
      display: true,
      isManualEntry: true,
    });
    expect(normalizeEvent({ id: 'r' })).toMatchObject({
      sessionizeId: null,
      name: '',
      image: null,
      eventImageUrl: null,
      display: false,
    });
  });
});

describe('combineEvents', () => {
  // Far-future dates, so every row is upcoming whatever day the test runs.
  const sessionize = [
    { id: 7, name: 'Seven', startsAt: '2999-10-01', website: 'https://seven' },
    { id: 8, title: 'By Name', startsAt: '2999-11-01' },
    { id: 9, name: 'Hidden', startsAt: '2999-12-01' },
  ];
  const snapshot = [
    { id: 'a', eventId: 7, description: 'Stored words', location: 'Chicago, IL' },
    { id: 'b', eventName: 'by name (copy)', date: '2999-11-02' },
    { id: 't', sessionizeId: 9, display: false },
    { id: 'm', eventName: 'Meetup', date: '2999-09-20', display: true },
    { id: 'h', eventName: 'Not shown', date: '2999-09-21', display: false },
    null,
  ];

  it('drops tombstoned events, lets a stored row override by id then by name, and adds shown manual rows', () => {
    const out = combineEvents(sessionize, snapshot);
    // The stored row's own name wins over Sessionize's, as it always has.
    expect(out.map((e) => e.name)).toEqual(['Meetup', 'Seven', 'by name (copy)']);
    const seven = out.find((e) => e.id === 7);
    expect(seven).toMatchObject({
      description: 'Stored words',
      location: 'Chicago, IL',
      eventUrl: 'https://seven',
      isManualEntry: false,
    });
    const byName = out.find((e) => e.id === 8);
    expect(byName.date).toBe('2999-11-02');
    expect(out.find((e) => e.id === 'm').isManualEntry).toBe(true);
  });

  it('sorts upcoming soonest first, past most recent first, undated last', () => {
    const rows = [
      { id: 'undated' },
      { id: 'old', date: '2020-01-01' },
      { id: 'older', date: '2019-01-01' },
    ];
    expect([...rows].sort(compareEventDates).map((r) => r.id)).toEqual(['old', 'older', 'undated']);
    expect(compareEventDates({ date: '2999-01-01' }, { date: '2998-01-01' })).toBeGreaterThan(0);
  });
});

describe('groupSessions', () => {
  it('splits coming soon, this year and last year, each soonest first, and drops undated rows', () => {
    const groups = groupSessions(
      [
        { id: 'later', date: '2026-12-01' },
        { id: 'today', date: '2026-09-14' },
        { id: 'past', date: '2026-03-01' },
        { id: 'earlier', date: '2026-01-01' },
        { id: 'lastYear', date: '2025-06-01' },
        { id: 'ancient', date: '2024-06-01' },
        { id: 'undated' },
      ],
      NOW
    );
    expect(groups.comingSoon.map((s) => s.id)).toEqual(['today', 'later']);
    expect(groups.thisYear.map((s) => s.id)).toEqual(['earlier', 'past']);
    expect(groups.lastYear.map((s) => s.id)).toEqual(['lastYear']);
  });
});

describe('the yearly roll-over, one month late (#1777)', () => {
  const SESSIONS = [
    { id: 'nextSpring', date: '2027-04-10' },
    { id: 'thisJanuary', date: '2027-01-10' },
    { id: 'lastDecember', date: '2026-12-05' },
    { id: 'lastMarch', date: '2026-03-01' },
    { id: 'yearBefore', date: '2025-06-01' },
    { id: 'ancient', date: '2024-06-01' },
  ];
  const ids = (groups) => ({
    year: groups.year,
    comingSoon: groups.comingSoon.map((s) => s.id),
    newYear: groups.newYear.map((s) => s.id),
    thisYear: groups.thisYear.map((s) => s.id),
    lastYear: groups.lastYear.map((s) => s.id),
  });

  it('names the grace month and reads the year in local time', () => {
    expect(SPEAKING_YEAR_GRACE_MONTHS).toBe(1);
    expect(speakingYear(new Date(2026, 11, 31, 23, 59, 59))).toBe(2026);
    expect(speakingYear(new Date(2027, 0, 1, 0, 0, 0))).toBe(2026);
    expect(speakingYear(new Date(2027, 0, 31, 23, 59, 59))).toBe(2026);
    expect(speakingYear(new Date(2027, 1, 1, 0, 0, 0))).toBe(2027);
    expect(speakingYear(new Date(2027, 11, 31, 23, 59, 59))).toBe(2027);
  });

  it('shows the same past sections on 1 January and 31 January as on 31 December', () => {
    const december = ids(groupSessions(SESSIONS, new Date(2026, 11, 31, 12)));
    expect(december).toEqual({
      year: 2026,
      comingSoon: ['thisJanuary', 'nextSpring'],
      newYear: [],
      thisYear: ['lastMarch', 'lastDecember'],
      lastYear: ['yearBefore'],
    });
    for (const now of [new Date(2027, 0, 1, 0, 0, 1), new Date(2027, 0, 9, 12)]) {
      const january = ids(groupSessions(SESSIONS, now));
      expect(january.year).toBe(2026);
      expect(january.thisYear).toEqual(december.thisYear);
      expect(january.lastYear).toEqual(december.lastYear);
      expect(january.comingSoon).toEqual(december.comingSoon);
      expect(january.newYear).toEqual([]);
    }
  });

  it('keeps a talk given in January itself on the page, in a section of its own, and Coming Soon still works', () => {
    const january = ids(groupSessions(SESSIONS, new Date(2027, 0, 31, 23, 59)));
    expect(january).toEqual({
      year: 2026,
      comingSoon: ['nextSpring'],
      newYear: ['thisJanuary'],
      thisYear: ['lastMarch', 'lastDecember'],
      lastYear: ['yearBefore'],
    });
  });

  it('rolls over on 1 February: the January talk joins the new year, last year folds, the year before leaves', () => {
    const february = ids(groupSessions(SESSIONS, new Date(2027, 1, 1, 0, 0, 1)));
    expect(february).toEqual({
      year: 2027,
      comingSoon: ['nextSpring'],
      newYear: [],
      thisYear: ['thisJanuary'],
      lastYear: ['lastMarch', 'lastDecember'],
    });
    // The fold follows the same year: in January the year before last is still the folded one.
    expect(
      sessionView({ date: '2025-06-01' }, 0, speakingYear(new Date(2027, 0, 15))).isPreviousYear
    ).toBe(true);
    expect(
      sessionView({ date: '2026-03-01' }, 0, speakingYear(new Date(2027, 0, 15))).isPreviousYear
    ).toBe(false);
    expect(
      sessionView({ date: '2026-03-01' }, 0, speakingYear(new Date(2027, 1, 1))).isPreviousYear
    ).toBe(true);
  });
});

describe('sessionView', () => {
  it('derives what a card shows, with the fallbacks the page has always used', () => {
    const view = sessionView(
      { title: 'Talk', startsAt: '2025-05-05', location: { lat: 1, lng: 2 } },
      3,
      2026
    );
    expect(view).toMatchObject({
      key: 'session-3',
      name: 'Talk',
      description: 'Event description not available',
      location: '1, 2',
      isPreviousYear: true,
      imageFallback: null,
    });
    expect(sessionView({ id: 'x' }, 0, 2026)).toMatchObject({
      key: 'x',
      name: 'Event Title',
      isPreviousYear: false,
      dateLabel: '',
    });
  });
});
