/**
 * The Stats tab's pure helpers (#1115).
 *
 * Everything here is a function of its arguments — no React, no fetch — so the
 * tab can be read for what it renders rather than for how it derives it, and
 * the derivations can be tested without a DOM.
 *
 * Two of Podbean's shapes are documented without their units or key formats
 * (`host-stats.js` passes them through unreshaped), and the helpers that take
 * them are written to accept either reading and say which they assumed:
 *
 *  - the monthly download map's key under `period: 'm'` — a `YYYY-MM` key is
 *    taken as a month, a `YYYY-MM-DD` key is folded into its month, and any
 *    other key is kept as its own point after the window's, never dropped;
 *  - retention's `retention` field — a value at or under 1 is read as a
 *    fraction and shown as a percentage, a value above 1 as a percentage
 *    already.
 */

/** The ranges the route offers, in the order the tab shows them. */
export const RANGES = Object.freeze([
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
  { id: '12m', label: '12 months' },
]);
export const DEFAULT_RANGE = '30d';

/** A range the tab offers, or the default. */
export function resolveRange(value) {
  return RANGES.some((range) => range.id === value) ? value : DEFAULT_RANGE;
}

const MONTHS = Object.freeze([
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]);

/** A period key as its axis label: `2026-10-13` → `Oct 13`, `2026-10` → `Oct 2026`, else as given. */
export function periodLabel(key) {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (day) return `${MONTHS[Number(day[2]) - 1] ?? day[2]} ${Number(day[3])}`;
  const month = /^(\d{4})-(\d{2})$/.exec(key);
  if (month) return `${MONTHS[Number(month[2]) - 1] ?? month[2]} ${month[1]}`;
  return String(key);
}

const DAY_MS = 86_400_000;
/** Ceilings on the axis, not expectations: 12 months or 90 days is the most a range asks for. */
const MAX_MONTHS = 36;
const MAX_DAYS = 400;

/**
 * Every period from the window's start to its end, as the keys Podbean uses
 * (`YYYY-MM-DD` daily, `YYYY-MM` monthly): a continuous axis, so a day nobody
 * listened is a zero bar and not a gap the eye reads as "no data".
 */
export function periodKeys(window) {
  if (!window?.start || !window?.end) return [];
  const start = new Date(`${window.start}T00:00:00Z`);
  const end = new Date(`${window.end}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];
  const keys = [];
  if (window.period === 'm') {
    let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    while (cursor <= end && keys.length < MAX_MONTHS) {
      keys.push(cursor.toISOString().slice(0, 7));
      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    }
    return keys;
  }
  for (let t = start.getTime(); t <= end.getTime() && keys.length < MAX_DAYS; t += DAY_MS) {
    keys.push(new Date(t).toISOString().slice(0, 10));
  }
  return keys;
}

/**
 * The download series for the chart: one point per period in the window,
 * zero where Podbean reported nothing, plus any key outside the window kept
 * as its own point after them (see the header on monthly keys).
 */
export function downloadSeries(byPeriod, window) {
  const monthly = window?.period === 'm';
  const counts = new Map();
  for (const [rawKey, value] of Object.entries(byPeriod || {})) {
    const count = Number(value);
    if (!Number.isFinite(count)) continue;
    const key = monthly && /^\d{4}-\d{2}-\d{2}$/.test(rawKey) ? rawKey.slice(0, 7) : rawKey;
    counts.set(key, (counts.get(key) || 0) + count);
  }
  const keys = periodKeys(window);
  const known = new Set(keys);
  const extras = [...counts.keys()].filter((key) => !known.has(key)).sort();
  return [...keys, ...extras].map((key) => ({
    key,
    label: periodLabel(key),
    count: counts.get(key) || 0,
  }));
}

/**
 * A name → count map ranked by count, each with its share of the total as a
 * percentage to one decimal; past `limit` rows the rest fold into one
 * `Other` row that says how many it holds. Zero and non-numeric counts are
 * left out. Empty when there is nothing to rank.
 */
export function rankedShares(map, { limit = 8 } = {}) {
  const rows = Object.entries(map || {})
    .map(([name, value]) => ({ name, count: Number(value) }))
    .filter((row) => Number.isFinite(row.count) && row.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  if (total === 0) return [];
  const top = rows.slice(0, limit);
  const rest = rows.slice(limit);
  if (rest.length) {
    top.push({
      name: 'Other',
      count: rest.reduce((sum, row) => sum + row.count, 0),
      others: rest.length,
    });
  }
  return top.map((row) => ({ ...row, share: Math.round((row.count / total) * 1000) / 10 }));
}

/** A two-letter country code as its English name when the runtime knows it; the code otherwise. */
export function countryName(code) {
  if (typeof code !== 'string' || !/^[A-Za-z]{2}$/.test(code)) return String(code);
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase()) || code;
  } catch {
    return code;
  }
}

/** Seconds as `12h 34m`, `34m`, or `under a minute`; '' for nothing. */
export function fmtSeconds(seconds) {
  if (seconds === null || seconds === undefined || seconds === '') return '';
  const total = Number(seconds);
  if (!Number.isFinite(total) || total < 0) return '';
  const minutes = Math.floor(total / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return 'under a minute';
}

/** A retention value as a percentage to one decimal (see the header on its unit), or null. */
function retentionPercent(value) {
  const n = Number(value);
  if (value === null || value === undefined || !Number.isFinite(n)) return null;
  return Math.round((n <= 1 ? n * 100 : n) * 10) / 10;
}

/**
 * Retention as table rows: one per cohort, with the listeners the cohort
 * started with and each point's retention as a percentage.
 */
export function retentionRows(retention) {
  if (!retention || typeof retention !== 'object' || Array.isArray(retention)) return [];
  return Object.entries(retention).map(([cohort, points]) => {
    const list = Array.isArray(points) ? points : [];
    return {
      cohort,
      listeners: Number(list[0]?.listeners) || 0,
      points: list.map((point) => ({
        listeners: Number(point?.listeners) || 0,
        retentionPct: retentionPercent(point?.retention),
      })),
    };
  });
}

/** The audience counts in display order. */
export const AUDIENCE_ROWS = Object.freeze([
  { key: 'followers', label: 'Followers' },
  { key: 'likes', label: 'Likes' },
  { key: 'comments', label: 'Comments' },
]);

/**
 * Whether the statistics carry anything to show: a download, a ranked row, a
 * retention cohort or an audience count above zero. A configured show with
 * no listeners yet is "no data yet", not an empty chart and three empty lists.
 */
export function hasAnyData(stats) {
  if (!stats || typeof stats !== 'object') return false;
  if ((stats.downloads?.total ?? 0) > 0) return true;
  for (const key of ['countries', 'platforms', 'sources', 'retention']) {
    if (stats[key] && Object.keys(stats[key]).length > 0) return true;
  }
  const { audience } = stats;
  return Boolean(
    audience && Object.values(audience).some((value) => typeof value === 'number' && value > 0)
  );
}
