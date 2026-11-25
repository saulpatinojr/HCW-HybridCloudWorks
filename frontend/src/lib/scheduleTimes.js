/**
 * When a schedule runs: its next run, and how often it runs in a week (for
 * sorting), for the Scheduled tasks tab. The schedules are read by
 * parseSchedule in scheduleWords.js; every time here is UTC.
 */
import { parseSchedule, pad } from './scheduleWords';

const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS_SHORT = [
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
];
const MINUTES_PER_WEEK = 7 * 24 * 60;

/** Does a parsed schedule fire in the minute that starts at `date` (read in UTC)? */
function firesAt(parsed, date) {
  return (
    parsed.minutes.includes(date.getUTCMinutes()) &&
    parsed.hours.includes(date.getUTCHours()) &&
    parsed.days.includes(date.getUTCDay())
  );
}

/**
 * The next time a schedule fires after `from`, reading its hours as UTC, or
 * null for an interval timer (whose next run depends on its last one).
 *
 * @param {string} expr
 * @param {Date} [from]
 * @returns {Date|null}
 */
export function nextRun(expr, from = new Date()) {
  const parsed = parseSchedule(expr);
  if (parsed.kind === 'interval') return null;
  const t = new Date(from.getTime());
  t.setUTCSeconds(0, 0);
  for (let i = 0; i < MINUTES_PER_WEEK + 1; i += 1) {
    t.setUTCMinutes(t.getUTCMinutes() + 1);
    if (firesAt(parsed, t)) return new Date(t.getTime());
  }
  return null;
}

/** "Tue 1 Dec, 06:30 UTC": a run time as the tab shows it, always in UTC. */
export function formatRunTime(date) {
  return (
    `${DAYS_SHORT[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS_SHORT[date.getUTCMonth()]}, ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}

/** Monday 2026-01-05 00:00 UTC: the start of the week the order below is read in. */
const WEEK_START = Date.UTC(2026, 0, 5);

/**
 * How often a schedule fires and when it first does in a week that starts
 * on Monday, for sorting: most frequent first, then in the order the week
 * meets them.
 *
 * @param {string} expr
 * @returns {{ perWeek: number, firstMinute: number }}
 */
export function scheduleRhythm(expr) {
  const key = String(expr);
  if (!rhythmCache.has(key)) rhythmCache.set(key, countRhythm(key));
  return { ...rhythmCache.get(key) };
}

/** A week is 10,080 minutes to step through, so each schedule is counted once. */
const rhythmCache = new Map();

function countRhythm(expr) {
  const parsed = parseSchedule(expr);
  if (parsed.kind === 'interval') {
    return { perWeek: MINUTES_PER_WEEK / parsed.everyMinutes, firstMinute: 0 };
  }
  let perWeek = 0;
  let firstMinute = -1;
  for (let i = 0; i < MINUTES_PER_WEEK; i += 1) {
    if (firesAt(parsed, new Date(WEEK_START + i * 60_000))) {
      perWeek += 1;
      if (firstMinute < 0) firstMinute = i;
    }
  }
  return { perWeek, firstMinute };
}

/** Sort order for two lists of schedules: the more frequent first, then the earlier in the week. */
export function compareSchedules(a, b) {
  const rhythm = (list) =>
    list.map(scheduleRhythm).reduce(
      (acc, r) => ({
        perWeek: acc.perWeek + r.perWeek,
        firstMinute: Math.min(acc.firstMinute, r.firstMinute),
      }),
      { perWeek: 0, firstMinute: MINUTES_PER_WEEK }
    );
  const ra = rhythm(a);
  const rb = rhythm(b);
  return rb.perWeek - ra.perWeek || ra.firstMinute - rb.firstMinute;
}
