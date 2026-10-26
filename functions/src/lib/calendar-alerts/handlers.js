/**
 * calendar-alerts/handlers.js — the four routes behind the admin portal's
 * Calendar Alerts pop-up and its "All alerts" page.
 *
 *   GET    cms/calendar-alerts            every alert, soonest first        editor
 *   POST   cms/calendar-alerts            add one                           editor
 *   PATCH  cms/calendar-alerts/{alertId}  edit, mark done, snooze, reopen   editor
 *   DELETE cms/calendar-alerts/{alertId}  remove one                        editor
 *
 * Editor and above, like the sibling Platform Settings routes and the
 * reminders sheet these sit beside. The list is the one route the portal
 * calls on every sign-in, so it is also where the starting alerts are made
 * (store.js readSeededState): the first read after a deploy creates them,
 * and a second read changes nothing.
 *
 * NOTHING PRIVATE IN A LOG OR AN AUDIT ROW. An alert's title, note and link
 * are the owner's own words and are never logged: a failure is logged by its
 * code (http/error-response.js), and the audit row carries the alert's id and
 * state only, never its text. The answers are `Cache-Control: private,
 * no-store`, as the credential register's are.
 *
 * Every refusal is a sentence this code wrote (AuthoredError, #945); a
 * failure of the store is a fixed sentence plus a correlation id.
 */
import { randomUUID } from 'node:crypto';

import { recordMutationAudit } from '../audit.js';
import {
  authoredMessage,
  errorResponse,
  isAuthoredError,
} from '../http/error-response.js';
import {
  CalendarAlertNotFoundError,
  CalendarAlertTooLargeError,
  CalendarAlertValidationError,
  applyPatch,
  applySeeds,
  assertListWeight,
  assertRoomFor,
  compareAlerts,
  dateOnly,
  isAlertId,
  isStoredAlert,
  newAlert,
  parseCreateBody,
  parsePatchBody,
  presentAlert,
  withoutAlert,
} from './model.js';
import { changeAlerts, readSeededState } from './store.js';

/** The role every route here needs. */
export const CALENDAR_ALERTS_ROLE = 'editor';

/** The audit actions the writes record. */
export const AUDIT_ACTIONS = Object.freeze({
  created: 'calendar_alert_created',
  updated: 'calendar_alert_updated',
  deleted: 'calendar_alert_deleted',
});

/**
 * A request body past this many characters, or a declared Content-Length past
 * this many bytes, is refused as too large. The largest valid alert is about
 * 3 000 characters, so 10 000 leaves room; the byte limit allows four bytes a
 * character, and is checked before the body is parsed.
 */
export const MAX_BODY_JSON = 10_000;
export const MAX_BODY_BYTES = 40_000;

const privateJson = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  body: JSON.stringify(body),
});

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ readDoc: Function, createDoc: Function, replaceDocIfMatch: Function, upsertDoc?: Function }} deps.store
 *        upsertDoc only for the audit row
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 */
export function createCalendarAlertHandlers({
  guard,
  store,
  now = () => new Date(),
  uuid = randomUUID,
}) {
  /** A refusal this code wrote answers as itself; anything else is the fixed failure sentence. */
  function failed(context, request, sentence, error) {
    if (isAuthoredError(error) && Number.isInteger(error.status) && error.status < 500) {
      return privateJson(error.status, {
        ok: false,
        error: authoredMessage(error, sentence),
        ...(error.status === 409 ? { code: 'CONFLICT' } : {}),
      });
    }
    return errorResponse(context, sentence, error, 500, request);
  }

  /**
   * The request body as JSON. A body that is not an object is a 400; one past
   * the size limits is a 413 with its own sentence, so the guard can be told
   * from the field checks that follow it.
   */
  async function readBody(request) {
    const declared = Number(request.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new CalendarAlertTooLargeError();
    const body = await request.json().catch(() => null);
    if (body === null || typeof body !== 'object') {
      throw new CalendarAlertValidationError('The body must be a JSON object');
    }
    if (JSON.stringify(body).length > MAX_BODY_JSON) throw new CalendarAlertTooLargeError();
    return body;
  }

  /**
   * What an audit row says: the alert's id, where it stands, and the NAMES of
   * the fields a change touched, never its words or their values.
   */
  async function audit(action, user, row, context, fields = null) {
    await recordMutationAudit(store, {
      action,
      actor: user,
      resource: `admin_config:calendar_alerts:${row.id}`,
      details: { alertId: row.id, status: row.status, ...(fields ? { fields } : {}) },
      now,
      uuid,
      context,
    });
  }

  /** The alert id off the route, or the 404 for one that cannot be an id. */
  function alertIdOf(request) {
    const id = request.params?.alertId;
    return isAlertId(id) ? { id } : { error: new CalendarAlertNotFoundError() };
  }

  return {
    /** GET cms/calendar-alerts */
    async list(request, context) {
      const auth = await guard.requireRole(request, CALENDAR_ALERTS_ROLE);
      if (auth.error) return auth.error;
      try {
        const today = dateOnly(now());
        const state = await readSeededState(store, { now, context, request });
        const alerts = state.alerts
          .filter(isStoredAlert)
          .map((row) => presentAlert(row, today))
          .sort(compareAlerts);
        return privateJson(200, { ok: true, today, alerts, total: alerts.length });
      } catch (error) {
        return failed(context, request, 'Failed to read the calendar alerts', error);
      }
    },

    /** POST cms/calendar-alerts */
    async create(request, context) {
      const auth = await guard.requireRole(request, CALENDAR_ALERTS_ROLE);
      if (auth.error) return auth.error;
      try {
        const fields = parseCreateBody(await readBody(request));
        const at = now().toISOString();
        const row = newAlert(fields, { id: uuid(), at });
        await changeAlerts(
          store,
          (state) => {
            assertRoomFor(state);
            return { write: true, state: { ...state, alerts: [...state.alerts, row] } };
          },
          { now }
        );
        await audit(AUDIT_ACTIONS.created, auth.user, row, context);
        return privateJson(201, { ok: true, alert: presentAlert(row, dateOnly(now())) });
      } catch (error) {
        return failed(context, request, 'Failed to save the calendar alert', error);
      }
    },

    /** PATCH cms/calendar-alerts/{alertId} */
    async update(request, context) {
      const auth = await guard.requireRole(request, CALENDAR_ALERTS_ROLE);
      if (auth.error) return auth.error;
      try {
        const target = alertIdOf(request);
        if (target.error) throw target.error;
        const patch = parsePatchBody(await readBody(request));
        const at = now().toISOString();
        const today = dateOnly(now());
        const { result } = await changeAlerts(
          store,
          (stored) => {
            // The Calendar can show a starting alert before any list read has
            // saved it; acting on it saves it, in the same write.
            const { state } = applySeeds(stored, { at });
            const row = state.alerts.find((entry) => entry?.id === target.id);
            if (!row || !isStoredAlert(row)) throw new CalendarAlertNotFoundError();
            const next = applyPatch(row, patch, { today, at });
            const changed = {
              ...state,
              alerts: state.alerts.map((entry) => (entry?.id === target.id ? next : entry)),
            };
            // Only an edit of the words can make the list heavier; done and snooze cannot.
            if (Object.keys(patch.edits).length > 0) assertListWeight(changed);
            return { write: true, state: changed, result: next };
          },
          { now }
        );
        await audit(AUDIT_ACTIONS.updated, auth.user, result, context, [
          ...Object.keys(patch.edits),
          ...(patch.done === undefined ? [] : ['done']),
          ...(patch.snoozeDays === undefined ? [] : ['snooze']),
        ]);
        return privateJson(200, { ok: true, alert: presentAlert(result, today) });
      } catch (error) {
        return failed(context, request, 'Failed to update the calendar alert', error);
      }
    },

    /** DELETE cms/calendar-alerts/{alertId} */
    async remove(request, context) {
      const auth = await guard.requireRole(request, CALENDAR_ALERTS_ROLE);
      if (auth.error) return auth.error;
      try {
        const target = alertIdOf(request);
        if (target.error) throw target.error;
        const at = now().toISOString();
        const { result } = await changeAlerts(
          store,
          (stored) => {
            const { state } = applySeeds(stored, { at });
            const row = state.alerts.find((entry) => entry?.id === target.id);
            if (!row) throw new CalendarAlertNotFoundError();
            return { write: true, state: withoutAlert(state, target.id), result: row };
          },
          { now }
        );
        await audit(AUDIT_ACTIONS.deleted, auth.user, { id: target.id, status: result?.status ?? null }, context);
        return privateJson(200, { ok: true, id: target.id });
      } catch (error) {
        return failed(context, request, 'Failed to delete the calendar alert', error);
      }
    },
  };
}
