/**
 * Opening one talk from a `?talk=` link (#1886): which row a stored id
 * names, and the tab its date puts it on.
 */
import { describe, expect, it } from 'vitest';
import { findLinkedTalk, tabForDate } from './linkedTalk';

const NOW = new Date(2026, 10, 26);
const ROWS = {
  mergedEvents: [
    { id: 101, name: 'Example Conf', date: '2026-12-01', _storedDoc: { _docId: 'event-101' } },
    { id: 102, name: 'Unstored Conf', date: '2026-12-02', _storedDoc: null },
  ],
  manualEntries: [{ _docId: 'manual-1', eventName: 'Example Meetup', date: '2026-10-01' }],
};

describe('findLinkedTalk', () => {
  it('finds a Sessionize event by its stored record, on Upcoming', () => {
    expect(findLinkedTalk(ROWS, 'event-101', NOW)).toEqual({
      kind: 'sessionize',
      row: ROWS.mergedEvents[0],
      tab: 'upcoming',
    });
  });

  it('finds a manual entry by its id, on Past once its date has gone', () => {
    expect(findLinkedTalk(ROWS, 'manual-1', NOW)).toMatchObject({ kind: 'manual', tab: 'past' });
  });

  it('is null for no id, an unknown id, or a Sessionize id with no stored record', () => {
    expect(findLinkedTalk(ROWS, null, NOW)).toBeNull();
    expect(findLinkedTalk(ROWS, 'event-999', NOW)).toBeNull();
    expect(findLinkedTalk(ROWS, '102', NOW)).toBeNull();
    expect(findLinkedTalk(undefined, 'event-101', NOW)).toBeNull();
  });
});

describe('tabForDate', () => {
  it('puts an undated talk on Upcoming, as the lists do', () => {
    expect(tabForDate(null, NOW)).toBe('upcoming');
    expect(tabForDate('2026-11-25', NOW)).toBe('past');
    expect(tabForDate('2026-11-26', NOW)).toBe('upcoming');
  });
});
