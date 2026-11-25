/**
 * The date helpers behind certification status: every date in the
 * catalogues is a `YYYY-MM-DD` string, read and printed on the UTC calendar
 * so the viewer's time zone never moves a day. Split out of certStatus.js,
 * which re-exports everything here; see its header for the wider story.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True for a `YYYY-MM-DD` string that names a real calendar day — the check
 * the catalogue tests run on `DATA_AS_OF` and on every dated field, so a
 * typo like `2026-02-30` is a red build rather than a date that never comes.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const ms = utcDay(value);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/**
 * Today as `YYYY-MM-DD` in the viewer's local calendar. For code that runs
 * outside a render (tests, scripts, effects); inside a component use
 * `useToday` so the pre-rendered HTML and the first client render agree.
 */
export function todayIso(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Whether an ISO date is strictly before `today`. Both are `YYYY-MM-DD`
 * strings and are compared as text, so no Date parsing or zone conversion is
 * involved here; the caller defines "today" (`todayIso` gives the viewer's
 * local calendar date, `useToday` the catalogue date until mount).
 *
 * A missing, malformed or impossible date (`2026-02-30`) is never "past" — a
 * bad value must not retire a certification by accident, and it is reported
 * once, by the shape check in `findStaleStatuses`, not again here.
 */
export function isPastDate(iso, today) {
  if (!isIsoDate(iso) || !isIsoDate(today)) return false;
  return iso < today;
}

/**
 * `YYYY-MM-DD` → the UTC millisecond timestamp of that calendar day.
 * Exported for certStatusCheck.js; certStatus.js does not re-export it.
 */
export function utcDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/**
 * Whole calendar days from `today` to `iso`, both `YYYY-MM-DD`: 0 on the day
 * itself, positive ahead, negative once past. The parts are placed on the UTC
 * calendar with `Date.UTC`, where every day is exactly 86,400,000 ms, so a
 * span that crosses a daylight-saving change is not 23 or 25 hours long and
 * the "Xd" countdown cannot be off by one. Returns `null` for a missing or
 * malformed date rather than `NaN`.
 *
 * This is the canonical day-difference helper for the Learn pages; the
 * provider pages share it rather than subtracting two local-midnight Dates.
 */
export function daysUntil(iso, today) {
  if (!isIsoDate(iso) || !isIsoDate(today)) return null;
  return Math.round((utcDay(iso) - utcDay(today)) / 86400000);
}

/**
 * `2026-06-30` → `Jun 30, 2026`, the calendar day itself in every zone. The
 * day is placed on the UTC calendar and formatted in UTC, so neither the
 * parse nor the print applies the viewer's offset; `new Date('2026-06-30')`
 * formatted locally reads "Jun 29, 2026" west of Greenwich. Returns the input
 * unchanged when it is not a `YYYY-MM-DD` string.
 */
export function formatIsoDate(iso) {
  if (!isIsoDate(iso)) return iso;
  return new Date(utcDay(iso)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
