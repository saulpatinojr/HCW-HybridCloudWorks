/**
 * notify-test.js — "Test Telegram": one message through the shared notifier,
 * on demand, from Platform Settings → Reminders (owner brief 2026-10-06).
 *
 * The day the brief was written, every owner notification had been failing
 * since morning because the owner's Telegram account had the bot blocked, and
 * the only record was a trace line. The delivery alert (observability.tf,
 * alert-telegram-delivery) now pages on a refusal; this route is the other
 * half, a way to prove the channel works right now, from the page that
 * depends on it, and to read Telegram's own reason when it does not.
 *
 * The notifier is used as every other caller uses it — same cooldown, same
 * source table (`sendTestNotification` has had a display name since the
 * port) — so what this proves is the production path, not a parallel one. A
 * second test inside the fifteen-minute cooldown is answered `cooldown`, which
 * is itself information: the previous one went.
 *
 * Editor, the same role as the Reminders sheet. The message names the actor
 * by display name only; an email is never put on the wire to Telegram.
 */

import { errorFacts } from './http/error-response.js';
export const TEST_SOURCE = 'sendTestNotification';

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** Who sent it, as Telegram may see it: a display name, never an address. */
export function actorName(user) {
  const name = typeof user?.name === 'string' ? user.name.trim() : '';
  return name && !name.includes('@') ? name : 'an editor';
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ notifyTelegram: Function }} deps.notifier
 * @param {() => Date} [deps.now]
 */
export function createNotifyTestHandlers({ guard, notifier, now = () => new Date() }) {
  return {
    /** POST /api/cms/platform-settings/reminders/test — no body. */
    async sendTelegramTest(request, context) {
      const auth = await guard.requireRole(request, 'editor');
      if (auth.error) return auth.error;
      const at = now().toISOString();
      let result;
      try {
        result = await notifier.notifyTelegram({
          title: 'Test from Platform Settings',
          message: `Sent at ${at} by ${actorName(auth.user)} from Platform Settings → Reminders. If you are reading this, Telegram delivery works.`,
          severity: 'info',
          source: TEST_SOURCE,
        });
      } catch (error) {
        context.error?.(`sendTelegramTest failed: ${errorFacts(error)}`);
        return json(500, { error: 'Failed to send the test message' });
      }
      const sent = Boolean(result?.sent);
      return json(200, {
        success: true,
        sent,
        reason: sent ? null : result?.reason || 'unknown',
        status: result?.status ?? null,
        at,
      });
    },
  };
}
