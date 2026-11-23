import { describe, it, expect } from 'vitest';
import { listPublishedEvents, listSpeakers, presentEvent, readEventFilters, readSearch } from './directory.js';
import { composeCall, isCallOpen, ownsCall, presentSubmission, validateCallChange, validateSubmission } from './cfs.js';

const q = (values) => new Map(Object.entries(values));

const SNAPSHOT = {
  meta: {
    speakerProfile: {
      name: 'Site Owner',
      bio: 'Hybrid cloud.',
      headshotUrl: 'javascript:alert(1)',
      links: [{ url: 'https://example.com' }, { label: 'bad', url: 'ftp://x' }, null],
    },
  },
  items: [
    { id: 'b', name: 'Beta', date: '2026-12-01T00:00:00Z', display: true, eventUrl: 'http://b.example', sessions: [{ title: 'Talk' }, { abstract: 'no title' }, null] },
    { id: 'a', name: 'Alpha', date: '2026-12-01', display: true, internal: 'x' },
    { id: 'u', name: 'Undated', display: true },
    { id: 'h', name: 'Hidden', display: false },
    { id: 't', sessionizeId: 1, display: false },
    null,
  ],
};

describe('the published events read (ADR 0042)', () => {
  it('lists only displayed, named rows, soonest first and undated last, narrowed by field', () => {
    const { events, total } = listPublishedEvents(SNAPSHOT);
    expect(events.map((e) => e.id)).toEqual(['a', 'b', 'u']);
    expect(total).toBe(3);
    expect(events[0]).not.toHaveProperty('internal');
    expect(events[1].date).toBe('2026-12-01');
    expect(events[1].sessions).toEqual([{ title: 'Talk', slidesUrl: null, videoUrl: null }]);
  });

  it('filters by from, to, q and limit; undated rows drop out of a date filter', () => {
    expect(listPublishedEvents(SNAPSHOT, { from: '2026-12-01', to: '2026-12-01' }).events.map((e) => e.id)).toEqual(['a', 'b']);
    expect(listPublishedEvents(SNAPSHOT, { q: 'talk' }).events.map((e) => e.id)).toEqual(['b']);
    expect(listPublishedEvents(SNAPSHOT, { limit: 1 })).toMatchObject({ total: 3, events: [{ id: 'a' }] });
  });

  it('answers empty for a missing snapshot', () => {
    expect(listPublishedEvents(null)).toEqual({ events: [], total: 0 });
    expect(listSpeakers(null)).toEqual({ speakers: [] });
  });

  it('reads and checks the query', () => {
    expect(readEventFilters(q({ from: '2026-01-01', to: '2026-02-01', q: ' Azure ', limit: '10' }))).toEqual({
      from: '2026-01-01',
      to: '2026-02-01',
      q: 'azure',
      limit: 10,
    });
    expect(readEventFilters(undefined)).toMatchObject({ from: null, limit: 50 });
    expect(() => readEventFilters(q({ from: '2026-02-01', to: '2026-01-01' }))).toThrow(/on or before/);
    expect(() => readEventFilters(q({ to: '2026-13-45' }))).toThrow(/YYYY-MM-DD/);
    expect(() => readEventFilters(q({ limit: '0' }))).toThrow(/limit/);
    expect(() => readEventFilters(q({ limit: '1.5' }))).toThrow(/limit/);
    expect(readSearch(q({ q: '   ' }))).toBeNull();
  });

  it('presents a sessionize id as text', () => {
    expect(presentEvent({ id: 1, name: 'x', sessionizeId: 5 }).sessionizeId).toBe('5');
  });
});

describe('the speakers read (ADR 0042)', () => {
  it('serves the owner profile with talks, and drops unsafe URLs', () => {
    const { speakers } = listSpeakers(SNAPSHOT);
    expect(speakers).toHaveLength(1);
    expect(speakers[0]).toMatchObject({ id: 'site-owner', headshotUrl: null, sessionizeId: null });
    expect(speakers[0].links).toEqual([{ label: 'https://example.com', url: 'https://example.com' }]);
    expect(speakers[0].talks).toEqual([{ title: 'Talk', eventId: 'b', eventName: 'Beta', date: '2026-12-01' }]);
  });

  it('matches q on name, bio and talk titles, and uses the Sessionize id when set', () => {
    const withId = { ...SNAPSHOT, meta: { ...SNAPSHOT.meta, speakerId: 'abc' } };
    expect(listSpeakers(withId, { q: 'talk' }).speakers[0].id).toBe('sessionize:abc');
    expect(listSpeakers(SNAPSHOT, { q: 'nobody' }).speakers).toEqual([]);
    expect(listSpeakers({ meta: { speakerProfile: { name: 'x', links: 'no' } } }).speakers[0].links).toEqual([]);
    expect(listSpeakers({ meta: { speakerProfile: {} } }).speakers).toEqual([]);
  });
});

describe('the call-for-speakers rules (ADR 0042)', () => {
  const NOW = Date.parse('2026-11-21T00:00:00Z');
  const user = { developerKeyId: 'k1', name: 'Org', oid: 'developer:k1' };

  it('refuses a non-object call change and a non-string closing time', () => {
    expect(() => validateCallChange(null, NOW)).toThrow(/action/);
    expect(() => validateCallChange({ action: 'open', closesAt: 5 }, NOW)).toThrow(/ISO/);
    expect(() => validateCallChange({ action: 'open', closesAt: 'soon' }, NOW)).toThrow(/ISO/);
    expect(() => validateCallChange({ action: 'open', title: 7 }, NOW)).toThrow(/text/);
    expect(() => validateCallChange({ action: 'open', title: 'x'.repeat(201) }, NOW)).toThrow(/at most/);
    expect(validateCallChange({ action: 'open', title: '   ' }, NOW).title).toBeNull();
  });

  it('owns, opens and closes by the stored fields only', () => {
    const call = composeCall({ eventId: 'e-1', existing: null, change: { action: 'open' }, user, nowIso: 'now' });
    expect(ownsCall(call, user)).toBe(true);
    expect(ownsCall(call, { developerKeyId: 'k2' })).toBe(false);
    expect(ownsCall(null, user)).toBe(false);
    expect(ownsCall(call, null)).toBe(false);
    expect(isCallOpen(call, NOW)).toBe(true);
    expect(isCallOpen({ ...call, closesAt: 'garbage' }, NOW)).toBe(false);
    expect(isCallOpen(null, NOW)).toBe(false);
  });

  it('refuses a non-object proposal and keeps an empty level as none', () => {
    expect(() => validateSubmission([])).toThrow(/JSON object/);
    expect(
      validateSubmission({ speakerName: 'A', speakerEmail: 'a@b.co', title: 'T', abstract: 'x', level: '' }).level,
    ).toBeNull();
  });

  it('presents a proposal with nulls for what was not sent', () => {
    expect(presentSubmission({ id: 'i', eventId: 'e', status: 'pending' })).toMatchObject({
      speakerBio: null,
      format: null,
      level: null,
      reviewNote: null,
    });
  });
});
