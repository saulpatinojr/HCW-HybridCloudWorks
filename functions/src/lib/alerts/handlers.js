/**
 * alerts/handlers.js — the alert log's two routes (owner request 2026-11-10).
 *
 *   GET  cms/alerts/recent   the last alerts sent to Telegram, newest first   editor
 *   POST cms/alerts/resend   send one of them again, by its log id           editor
 *
 * Until now an alert went to the owner's phone and nowhere else, so one that
 * was missed could not be read again. lib/notify.js keeps every alert Telegram
 * accepted in `system/notify_log` (the newest NOTIFY_LOG_MAX); these routes
 * read that list for the Health page and Koda, and send one again on a
 * person's request.
 *
 * Editor reads, not viewer like the rest of the Health page: the log keeps
 * the reminders sheet's notices too (timers/reminders.js sends a reminder's
 * title and up to 400 characters of its notes), and the sheet itself is
 * editor (platform-settings.js). A job failure's text is redacted before it
 * is sent. Sending again is editor too, the role of Platform Settings' "Test
 * Telegram", and is not open to Koda's key (lib/agent-content/admin-access.js
 * lists the read only): a message to the owner's phone is a person's choice.
 * The notifier sends the same alert again at most once a minute.
 *
 * Answers are `Cache-Control: private, no-store`. An alert's words are never
 * logged: a failure is logged by its code with a correlation id
 * (http/error-response.js).
 */
import { readJsonBodyWithin } from '../http/bounded-body.js';
import { errorResponse } from '../http/error-response.js';
import { readAlertLog } from '../notify.js';

export const ALERTS_READ_ROLE = 'editor';
export const ALERTS_RESEND_ROLE = 'editor';
/** The resend body is one short id; anything larger is refused unread. */
const RESEND_BODY_MAX_BYTES = 1024;
/** A log id is a time and a random suffix in base 36 (notify.js logEntryId). */
const LOG_ID_PATTERN = /^[a-z0-9]{1,16}-[a-z0-9]{1,16}$/;

const privateJson = (status, body) => ({
  status,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'private, no-store',
  },
  body: JSON.stringify(body),
});

/** The fields a logged alert is answered with; anything else on the entry stays behind. */
function present(entry) {
  return {
    id: String(entry?.id ?? ''),
    at: typeof entry?.at === 'string' ? entry.at : null,
    source: String(entry?.source ?? ''),
    severity: String(entry?.severity ?? 'info'),
    title: String(entry?.title ?? ''),
    message: String(entry?.message ?? ''),
    resentOf: typeof entry?.resentOf === 'string' ? entry.resentOf : null,
  };
}

/** Each refusal from notify.js resendLogged, as an answer. */
const RESEND_REFUSALS = Object.freeze({
  not_found: [404, 'That alert is no longer in the log (it keeps the newest 50).'],
  too_soon: [429, 'That alert was sent again less than a minute ago. Wait a minute and press Send again once more.'],
  not_configured: [409, 'Telegram is not set up on this app, so nothing can be sent.'],
  telegram_error: [502, 'Telegram refused the message. Platform Settings → Reminders → Test Telegram shows its reason.'],
  exception: [502, 'The message could not be sent. Try again in a minute.'],
});

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ readDoc: Function }} deps.store
 * @param {{ resendLogged: Function }} deps.notifier
 */
export function createAlertLogHandlers({ guard, store, notifier }) {
  return {
    /** GET cms/alerts/recent */
    async getRecent(request, context) {
      const auth = await guard.requireRole(request, ALERTS_READ_ROLE);
      if (auth.error) return auth.error;
      try {
        const alerts = (await readAlertLog(store)).map(present);
        return privateJson(200, { ok: true, alerts });
      } catch (failure) {
        return errorResponse(context, 'Failed to read the alert log', failure, 500, request);
      }
    },

    /** POST cms/alerts/resend  { id } */
    async resend(request, context) {
      const auth = await guard.requireRole(request, ALERTS_RESEND_ROLE);
      if (auth.error) return auth.error;
      const read = await readJsonBodyWithin(request, RESEND_BODY_MAX_BYTES);
      if (read.tooLarge)
        return privateJson(413, {
          ok: false,
          error: 'body_too_large',
          message: 'Send only the alert id.',
        });
      const id = typeof read.body?.id === 'string' ? read.body.id.trim() : '';
      if (!LOG_ID_PATTERN.test(id)) {
        return privateJson(400, {
          ok: false,
          error: 'bad_id',
          message: 'Name the alert to send again by its id from the alert log.',
        });
      }
      try {
        const result = await notifier.resendLogged(id);
        if (result?.sent) return privateJson(200, { ok: true, sent: true });
        const reason = Object.hasOwn(RESEND_REFUSALS, result?.reason) ? result.reason : 'exception';
        const [status, message] = RESEND_REFUSALS[reason];
        return privateJson(status, {
          ok: false,
          sent: false,
          error: reason,
          message,
          ...(typeof result?.status === 'number' ? { telegramStatus: result.status } : {}),
        });
      } catch (failure) {
        return errorResponse(context, 'Failed to send the alert again', failure, 500, request);
      }
    },
  };
}
