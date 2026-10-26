/**
 * calendar-alerts/collector.js — the owner's calendar alerts as a Calendar
 * source (ADR 0033 §4: "adding a source is adding a collector to COLLECTORS").
 *
 * Owner instruction 2026-10-26: "we already have a calendar in the admin
 * portal so maybe we can build off of that". The Calendar page
 * (`GET cms/calendar`, lib/calendar.js) is a read-only union of other
 * records' dates; it owns no storage of its own. So the alerts keep the
 * document they were given (store.js) and this collector shows them on the
 * Calendar as one more kind, `alert`, on their due days. The reasons the
 * alerts are NOT stored as content or social-post records, where the Calendar
 * would find them by itself, are in docs/runbooks/calendar-alerts.md: those
 * containers are scanned by the publisher (`scheduledPublishDate`) and by the
 * Publer sync (`scheduledAt`), and an alert that looked like either could be
 * published or posted.
 *
 * READ-ONLY, and a single point read: the Calendar read never writes. The
 * starting alerts are PERSISTED by the alerts list route (handlers.js), which
 * the sign-in pop-up and the Calendar page's panel both call. So that the grid
 * and the panel agree even when the Calendar is read first, the starting
 * alerts a document has not recorded yet are added here in memory, by the same
 * pure rule (model.js applySeeds): one already finished, deleted or typed is
 * never added again.
 *
 * Each item is the common calendar shape (calendar/items.js). `status` is the
 * alert's state today (open, snoozed or done), `sourceId` is the alert's id,
 * and `meta` carries what the preview needs (the note, the link, the snooze
 * day). An alert with a time is a 30-minute item at that UTC time; one
 * without is all-day on its UTC date, which the page shows on that day in
 * every time zone.
 */
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { item, rowsInWindow } from '../calendar/items.js';
import {
  CALENDAR_ALERTS_DOC_ID,
  dateOnly,
  applySeeds,
  isStoredAlert,
  presentAlert,
  readState,
} from './model.js';

const ALERT_MINUTES = 30;

/** Where an alert opens from the Calendar: the Calendar page's own alerts panel. */
export const ALERTS_HREF = '/admin/calendar#alerts';

/** The stored date the calendar reads: a bare day (all-day), or a UTC instant when there is a time. */
const storedDate = (alert) => (alert.dueTime ? `${alert.dueDate}T${alert.dueTime}:00.000Z` : alert.dueDate);

/**
 * Every alert whose due day falls in the window.
 *
 * @param {{ store: { readDoc: Function }, from: Date, to: Date, now?: () => Date }} args
 */
export async function collectAlerts({ store, from, to, now = () => new Date() }) {
  const doc = await store.readDoc('admin_config', CALENDAR_ALERTS_DOC_ID, ADMIN_CONFIG_PARTITION);
  const today = dateOnly(now());
  const { state } = applySeeds(readState(doc), { at: now().toISOString() });
  const alerts = state.alerts.filter(isStoredAlert).map((row) => presentAlert(row, today));
  return rowsInWindow(alerts, { from, to }, storedDate).map(({ row, when }) =>
    item({
      id: `alert:${row.id}`,
      kind: 'alert',
      title: row.title,
      start: when.iso,
      end: when.allDay ? null : new Date(Date.parse(when.iso) + ALERT_MINUTES * 60_000).toISOString(),
      allDay: when.allDay,
      status: row.state,
      href: ALERTS_HREF,
      sourceId: row.id,
      sourceCollection: 'admin_config',
      meta: {
        note: row.note,
        link: row.link,
        dueTime: row.dueTime,
        snoozedUntil: row.snoozedUntil,
      },
    })
  );
}
