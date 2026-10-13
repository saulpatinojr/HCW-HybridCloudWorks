/**
 * The Stats tab's pure helpers (#1115).
 *
 * The two assumptions the header of statsView.js names are pinned here, so a
 * live reading of Podbean that contradicts one has a test to change: the
 * monthly key handling, and retention's unit.
 */
import { describe, expect, it } from 'vitest';
import {
  AUDIENCE_ROWS,
  DEFAULT_RANGE,
  RANGES,
  countryName,
  downloadSeries,
  fmtSeconds,
  hasAnyData,
  hasAnyError,
  periodKeys,
  periodLabel,
  rankedShares,
  resolveRange,
  retentionRows,
} from './statsView';

describe('ranges', () => {
  it('offers the three the route accepts, in order, and falls back to 30d', () => {
    expect(RANGES.map((range) => range.id)).toEqual(['30d', '90d', '12m']);
    expect(DEFAULT_RANGE).toBe('30d');
    expect(resolveRange('12m')).toBe('12m');
    expect(resolveRange('7d')).toBe('30d');
    expect(resolveRange(undefined)).toBe('30d');
  });
});

describe('periodLabel and periodKeys', () => {
  it('labels a day as its month and day, a month as its month and year, anything else as given', () => {
    expect(periodLabel('2026-10-13')).toBe('Oct 13');
    expect(periodLabel('2026-01-05')).toBe('Jan 5');
    expect(periodLabel('2026-10')).toBe('Oct 2026');
    expect(periodLabel('Week 41')).toBe('Week 41');
  });

  it('is every day of a daily window and every month of a monthly one', () => {
    expect(periodKeys({ start: '2026-10-11', end: '2026-10-13', period: 'd' })).toEqual([
      '2026-10-11',
      '2026-10-12',
      '2026-10-13',
    ]);
    expect(periodKeys({ start: '2025-11-01', end: '2026-01-15', period: 'm' })).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
    ]);
    expect(periodKeys({ start: '2026-10-13', end: '2026-10-11', period: 'd' })).toEqual([]);
    expect(periodKeys({ start: 'x', end: '2026-10-11', period: 'd' })).toEqual([]);
    expect(periodKeys(null)).toEqual([]);
  });
});

describe('downloadSeries', () => {
  it('is one point per day with zeros where Podbean reported nothing', () => {
    const window = { start: '2026-10-11', end: '2026-10-13', period: 'd' };
    expect(downloadSeries({ '2026-10-13': 4, '2026-10-11': 1 }, window)).toEqual([
      { key: '2026-10-11', label: 'Oct 11', count: 1 },
      { key: '2026-10-12', label: 'Oct 12', count: 0 },
      { key: '2026-10-13', label: 'Oct 13', count: 4 },
    ]);
  });

  it('under a monthly window takes YYYY-MM keys, folds YYYY-MM-DD keys into their month, and keeps unknown keys after', () => {
    const window = { start: '2026-08-01', end: '2026-10-13', period: 'm' };
    expect(
      downloadSeries({ '2026-09': 5, '2026-10-02': 1, '2026-10-05': 2, 'Q3 2026': 9 }, window)
    ).toEqual([
      { key: '2026-08', label: 'Aug 2026', count: 0 },
      { key: '2026-09', label: 'Sep 2026', count: 5 },
      { key: '2026-10', label: 'Oct 2026', count: 3 },
      { key: 'Q3 2026', label: 'Q3 2026', count: 9 },
    ]);
  });

  it('drops a count that is not a number and survives no map and no window', () => {
    expect(
      downloadSeries({ '2026-10-11': 'x' }, { start: '2026-10-11', end: '2026-10-11', period: 'd' })
    ).toEqual([{ key: '2026-10-11', label: 'Oct 11', count: 0 }]);
    expect(downloadSeries(null, null)).toEqual([]);
    expect(downloadSeries({ '2026-10-11': 2 }, null)).toEqual([
      { key: '2026-10-11', label: 'Oct 11', count: 2 },
    ]);
  });
});

describe('rankedShares', () => {
  it('ranks by count with the share of the total to one decimal', () => {
    expect(rankedShares({ GH: 1, US: 3 })).toEqual([
      { name: 'US', count: 3, share: 75 },
      { name: 'GH', count: 1, share: 25 },
    ]);
    expect(rankedShares({ a: 1, b: 1, c: 1 }).map((row) => row.share)).toEqual([33.3, 33.3, 33.3]);
  });

  it('folds everything past the limit into Other, and leaves out zero and non-numeric counts', () => {
    const map = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`c${i}`, 10 - i]));
    const rows = rankedShares({ ...map, zero: 0, bad: 'x' }, { limit: 3 });
    expect(rows.map((row) => row.name)).toEqual(['c0', 'c1', 'c2', 'Other']);
    expect(rows[3]).toEqual({
      name: 'Other',
      count: 7 + 6 + 5 + 4 + 3 + 2 + 1,
      others: 7,
      share: 50.9,
    });
  });

  it('is empty when there is nothing to rank', () => {
    expect(rankedShares({})).toEqual([]);
    expect(rankedShares(null)).toEqual([]);
    expect(rankedShares({ a: 0 })).toEqual([]);
  });
});

describe('countryName, fmtSeconds', () => {
  it('names a two-letter code and leaves anything else alone', () => {
    expect(countryName('US')).toBe('United States');
    expect(countryName('gh')).toBe('Ghana');
    expect(countryName('Unknown')).toBe('Unknown');
    expect(countryName(null)).toBe('null');
  });

  it('formats seconds as hours and minutes', () => {
    expect(fmtSeconds(5400)).toBe('1h 30m');
    expect(fmtSeconds(600)).toBe('10m');
    expect(fmtSeconds(30)).toBe('under a minute');
    expect(fmtSeconds(null)).toBe('');
    expect(fmtSeconds(-1)).toBe('');
    expect(fmtSeconds('x')).toBe('');
  });
});

describe('retentionRows', () => {
  it('is one row per cohort with the first point’s listeners and each point as a percentage', () => {
    expect(
      retentionRows({
        'Aug 04-Aug 10': [
          { listeners: 12, retention: 1 },
          { listeners: 6, retention: 0.5 },
          { listeners: 3, retention: 0.25 },
        ],
      })
    ).toEqual([
      {
        cohort: 'Aug 04-Aug 10',
        listeners: 12,
        points: [
          { listeners: 12, retentionPct: 100 },
          { listeners: 6, retentionPct: 50 },
          { listeners: 3, retentionPct: 25 },
        ],
      },
    ]);
  });

  it('reads a value above 1 as a percentage already, and a non-number as unknown', () => {
    const [row] = retentionRows({ c: [{ listeners: 2, retention: 42.26 }, { listeners: 1 }] });
    expect(row.points.map((point) => point.retentionPct)).toEqual([42.3, null]);
  });

  it('is empty for nothing and for a shape that is not a map of arrays', () => {
    expect(retentionRows(null)).toEqual([]);
    expect(retentionRows([])).toEqual([]);
    expect(retentionRows({ c: 'nope' })).toEqual([{ cohort: 'c', listeners: 0, points: [] }]);
  });
});

describe('hasAnyData', () => {
  it('is true for a download, a ranked row, a cohort or an audience count, and false otherwise', () => {
    expect(hasAnyData({ downloads: { total: 1 } })).toBe(true);
    expect(hasAnyData({ downloads: { total: 0 }, countries: { US: 1 } })).toBe(true);
    expect(hasAnyData({ retention: { c: [] } })).toBe(true);
    expect(hasAnyData({ audience: { followers: 2, likes: null } })).toBe(true);
    expect(
      hasAnyData({
        downloads: { total: 0 },
        countries: {},
        platforms: null,
        audience: { followers: 0 },
      })
    ).toBe(false);
    expect(hasAnyData({ downloads: null })).toBe(false);
    expect(hasAnyData(null)).toBe(false);
  });

  it('AUDIENCE_ROWS names the three counts the report carries, in order', () => {
    expect(AUDIENCE_ROWS.map((row) => row.key)).toEqual(['followers', 'likes', 'comments']);
  });
});

describe('hasAnyError', () => {
  it('is true when any section recorded a failure, and false for no errors, an empty map or no statistics', () => {
    expect(hasAnyError({ errors: { countries: { code: 'UPSTREAM', message: 'x' } } })).toBe(true);
    expect(hasAnyError({ errors: {} })).toBe(false);
    expect(hasAnyError({ downloads: { total: 3 } })).toBe(false);
    expect(hasAnyError({ errors: null })).toBe(false);
    expect(hasAnyError(null)).toBe(false);
  });
});
