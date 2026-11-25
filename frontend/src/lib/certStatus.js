/**
 * Certification status derived from dates, not from the stored field.
 *
 * The Azure catalogue in src/data/azure/certifications.js is a hand-synced
 * file. Between syncs its `status` field goes stale the moment a date passes:
 * from 2026-06-30 to 2026-09-09 the live page printed "Expiring Soon" for ten
 * exams Microsoft had already retired and "BETA · ends Jun 30, 2026" for exams
 * that had gone GA (#461). The dates in the file were right the whole time;
 * only the label was wrong. So the label is computed here, at render time,
 * from the dates — and a date passing can no longer show a status that has
 * already ended.
 *
 * Every function here is pure so the page, the detail page, the pre-renderer
 * and the tests agree on one rule. The one hook, `useToday`, exists for
 * hydration: /azure/education and the 68 detail routes are pre-rendered at
 * build time and hydrated with `hydrateRoot`. If a render read the real clock,
 * the HTML built on Monday and the first client render on Friday would
 * disagree the day a status flips (an expiring row turned retired) — React
 * logs a hydration mismatch and re-renders the tree from scratch. So during
 * the pre-render and the hydrating render "today" is the catalogue's own
 * `DATA_AS_OF`, which the build and the browser share, and the render right
 * after hydration moves it to the viewer's real date. Server and first client
 * render agree; the page still corrects itself.
 */
import { useSyncExternalStore } from 'react';
import { isIsoDate, todayIso } from './certDates';

// The clock is an external system as far as React is concerned, so it is read
// through useSyncExternalStore rather than a state-plus-effect pair: React
// uses the server snapshot for the pre-render and for the hydrating render,
// then re-renders with the client snapshot when the two differ — without a
// hydration mismatch, and without the setState-in-effect cascade the lint
// rule forbids. Nothing pushes updates (the date changes at midnight, which a
// page open that long can miss), so subscribe is a no-op.
const subscribeToNothing = () => () => {};

/**
 * The server snapshot `useToday` uses when a caller has no `DATA_AS_OF` to
 * give it. A fixed day rather than the clock, so the pre-render and the
 * hydrating render still agree with each other (#465 review): with an
 * undefined fallback `useSyncExternalStore` would have hydrated on the
 * viewer's date and mismatched the HTML. Every catalogue exports a
 * `DATA_AS_OF`, so this is reached only by a page that forgot to pass it.
 */
export const UNDATED_FALLBACK_ISO = '1970-01-01';

/**
 * "Today" for a render: `fallbackIso` (the catalogue's `DATA_AS_OF`) while
 * pre-rendering and while hydrating that HTML, the viewer's local date on every
 * render after that — and immediately on a client-side navigation, which has
 * no HTML to agree with. See the module header for why. A missing or
 * malformed `fallbackIso` is replaced by `UNDATED_FALLBACK_ISO`, so the server
 * snapshot is always the same real day.
 *
 * @param {string} [fallbackIso] `YYYY-MM-DD`
 * @returns {string} `YYYY-MM-DD`
 */
export function useToday(fallbackIso) {
  const serverSnapshot = isIsoDate(fallbackIso) ? fallbackIso : UNDATED_FALLBACK_ISO;
  return useSyncExternalStore(subscribeToNothing, todayIso, () => serverSnapshot);
}

// The pure helpers live in three sibling files, grouped by job. They are
// re-exported here so every caller keeps importing from '@/lib/certStatus'.
export { isIsoDate, todayIso, isPastDate, daysUntil, formatIsoDate } from './certDates';
export { CERT_STATUSES, deriveStatus, describeCertStatus } from './certStatusRules';
export { CERT_DATE_FIELDS, findStaleStatuses, findStatusesDueWithin } from './certStatusCheck';
