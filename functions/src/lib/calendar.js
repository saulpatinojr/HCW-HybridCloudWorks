/**
 * calendar.js — the Amplify → Calendar aggregate read (ADR 0033 §4).
 *
 *   GET /api/cms/calendar?from=ISO&to=ISO   editor
 *
 * One read unions everything in ContentForge that has a date: content
 * schedules and publishes, newsletter sends, social posts, speaking events and
 * their CFP deadlines, certification expirations and renewals, Ambassador
 * deadlines, Listen & Learn releases and the owner's own calendar alerts. Each source is ONE collector
 * (./calendar/collectors.js) — a small function over the store that answers
 * calendar items — so adding a source is adding a collector to COLLECTORS and
 * nothing else. The item shape and the date arithmetic are
 * ./calendar/items.js.
 *
 * A collector that throws costs its own items, never the whole read: the
 * answer carries `warnings[]` naming the source that failed, and the page
 * shows that beside the items it did get. The `ambassador` container may not
 * be provisioned yet (ADR 0033 §6 item 4); its collector treats "container
 * not found" as "nothing there" and adds no warning.
 *
 * An item is `{ id, kind, title, start, end?, allDay, status, href, sourceId,
 * sourceCollection, meta }`. `start` and `end` are ISO instants; a calendar
 * date (a `YYYY-MM-DD` with no time) is `allDay: true` with `start` at UTC
 * midnight of that day, which the page shows on that day in every time zone.
 */
import { COLLECTORS } from './calendar/collectors.js';
import { errorCode } from './http/error-response.js';

export {
  COLLECTORS,
  collectAmbassadorDeadlines,
  collectCertifications,
  collectContentSchedules,
  collectListenAndLearnReleases,
  collectNewsletterIssues,
  collectSocialPosts,
  collectSpeakingEvents,
  isContainerMissing,
} from './calendar/collectors.js';
export { dayBounds, toInstant } from './calendar/items.js';

export const CALENDAR_KINDS = Object.freeze([
  'content',
  'newsletter',
  'social',
  'speaking',
  'certification',
  'ambassador',
  'audio',
  'alert',
]);

/** The longest window one read may ask for: a quarter, with room for the grid's padding. */
export const MAX_WINDOW_DAYS = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

// The answer can carry the owner's private alerts (kind alert), so no cache may keep it.
const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  body: JSON.stringify(body),
});

/**
 * Run every collector for the window. Never throws: a failing source becomes
 * a warning and its items are left out.
 *
 * @returns {Promise<{ items: object[], warnings: string[] }>}
 */
export async function collectCalendar({
  store,
  from,
  to,
  collectors = COLLECTORS,
  kinds = null,
  log,
}) {
  const wanted = Object.entries(collectors).filter(([kind]) => !kinds || kinds.includes(kind));
  const settled = await Promise.allSettled(
    wanted.map(([, collect]) => collect({ store, from, to }))
  );
  const items = [];
  const warnings = [];
  settled.forEach((result, index) => {
    const [kind] = wanted[index];
    if (result.status === 'fulfilled') {
      items.push(...result.value);
    } else {
      // The collector's code, never its sentence: warnings are in the answer (#945).
      warnings.push(`${kind}: could not be read (${errorCode(result.reason)})`);
      log?.warn?.(`[calendar] ${kind} collector failed: ${result.reason?.name ?? 'Error'}`);
    }
  });
  items.sort((a, b) => String(a.start).localeCompare(String(b.start)) || a.id.localeCompare(b.id));
  return { items, warnings };
}

/** A response with `Cache-Control: private, no-store` added, its body and other headers kept. */
const withNoStore = (response) => ({
  ...response,
  headers: { ...response.headers, 'Cache-Control': 'private, no-store' },
});

const refuse = (error) => ({ error: json(400, { ok: false, error }) });

/**
 * `?from&to[&kinds=a,b]` as `{ from, to, kinds }`: two ordered ISO instants at
 * most MAX_WINDOW_DAYS apart, and the known kinds asked for (null for all).
 * Or `{ error }`, the 400 to answer with.
 */
export function parseWindow(query) {
  const from = new Date(String(query?.get?.('from') ?? ''));
  const to = new Date(String(query?.get?.('to') ?? ''));
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return refuse('from and to must be ISO instants');
  }
  if (to.getTime() <= from.getTime()) return refuse('to must be after from');
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
    return refuse(`The window may be at most ${MAX_WINDOW_DAYS} days`);
  }
  const kindsParam = String(query?.get?.('kinds') ?? '').trim();
  const kinds = kindsParam
    ? kindsParam
        .split(',')
        .map((kind) => kind.trim())
        .filter((kind) => CALENDAR_KINDS.includes(kind))
    : null;
  return { from, to, kinds };
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ queryDocs: Function }} deps.store
 * @param {object} [deps.collectors]
 */
export function createCalendarHandlers({ guard, store, collectors = COLLECTORS }) {
  return {
    /** GET /api/cms/calendar?from&to[&kinds=a,b] — editor. */
    async read(request, context) {
      const auth = await guard.requireRole(request, 'editor');
      // The guard's refusal is shared by every admin route; on this one, which can
      // carry the owner's alerts, no cache may keep it either.
      if (auth.error) return withNoStore(auth.error);
      const window = parseWindow(request.query);
      if (window.error) return window.error;
      const { from, to, kinds } = window;
      try {
        const { items, warnings } = await collectCalendar({
          store,
          from,
          to,
          collectors,
          kinds,
          log: context,
        });
        return json(200, {
          ok: true,
          from: from.toISOString(),
          to: to.toISOString(),
          items,
          warnings,
          total: items.length,
        });
      } catch (error) {
        context.error?.(`calendar read failed: ${error?.name ?? 'Error'}`);
        return json(500, { ok: false, error: 'Failed to read the calendar' });
      }
    },
  };
}
