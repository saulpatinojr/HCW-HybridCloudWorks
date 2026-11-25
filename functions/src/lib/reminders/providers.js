/**
 * The parts of the platform that keep their own rows on the owner's reminders
 * sheet (#1886), run by the daily `sendReminders` timer before it reads the
 * sheet, so each row is current before anything is said on Telegram.
 *
 * ADDING ONE. A prefix and its reserve in settings.js PROVIDED_ROWS, the same
 * prefix in the Reminders tab's ROW_KEEPERS (a test holds the two together),
 * a sync built on reminders/provided-rows.js, and one entry here. The
 * checklist is in .claude/CLAUDE.md, "How the admin Pages connect".
 */
import { syncCredentialReminders } from "../credentials/reminders.js";
import { syncAmbassadorReminders } from "../ambassador/reminder-rows.js";

export const REMINDER_PROVIDERS = Object.freeze([
  Object.freeze({ id: "credentials", sync: syncCredentialReminders }),
  Object.freeze({ id: "ambassador", sync: syncAmbassadorReminders }),
]);

/**
 * Every provider's sync, one after another (they write the same document),
 * each on its own: one that fails is said in the log and never stops the
 * next, or the timer. The lines carry a provider id and a reason or error
 * code, never a store message, which can name a document.
 *
 * @returns {Promise<Array<{ id: string, synced: boolean, reason?: string }>>}
 */
export async function syncReminderProviders({
  store,
  at,
  log = {},
  providers = REMINDER_PROVIDERS,
}) {
  const results = [];
  for (const provider of providers) {
    try {
      const summary = await provider.sync({ store, now: () => at, log });
      if (summary && !summary.synced) {
        log.warn?.(
          `[sendReminders] ${provider.id} reminders not synced (${summary.reason || "unknown"})`,
        );
      }
      results.push({
        id: provider.id,
        synced: Boolean(summary?.synced),
        reason: summary?.reason,
      });
    } catch (error) {
      log.warn?.(
        `[sendReminders] ${provider.id} reminders sync threw (${error?.code ?? "error"})`,
      );
      results.push({ id: provider.id, synced: false, reason: "threw" });
    }
  }
  return results;
}
