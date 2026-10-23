/**
 * notify.js — best-effort Telegram alerts with a per-source cooldown.
 *
 * Ported from Site-Main `lib/notify.js` (088f458). Never throws: scheduled
 * jobs and change-feed handlers must not fail because a notification could
 * not be sent. The bot token and chat id are Key Vault references on the app
 * (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`); an unresolved reference reads as
 * "not configured". Cooldown state lives in `system/notify_state`, one field
 * per source.
 *
 * THE COOLDOWN IS CLAIMED BEFORE THE SEND, CONDITIONALLY (review of #920).
 * Until then the stamp was written after the send with an unconditional
 * upsert of the whole document, so two callers reading the same document at
 * once — a timer and the new Test Telegram route, say — both passed the
 * check, both sent, and the second write erased the first's stamp along
 * with every other source's. Now the stamp is a single-field patch made
 * only if the document's ETag is still the one that was read: the loser of
 * a race gets a 412 and is told `cooldown`, which is the truth, since the
 * winner is sending. If the send then fails, the stamp is put back as it
 * was, best effort, so a refusal does not silence the source for fifteen
 * minutes. The store therefore needs patchDoc beside readDoc and upsertDoc;
 * every caller passes the Cosmos client's.
 */
import { readKey } from './ai/router.js';
import { fetchWithTimeout } from './http/fetch-with-timeout.js';

// Outbound deadline (T-712): Node's fetch has none, and these calls are
// reached from change-feed handlers where a hung socket holds the lease.
const TELEGRAM_TIMEOUT_MS = 15_000;

export const COOLDOWN_MS = 15 * 60 * 1000;
export const NOTIFY_STATE_ID = 'notify_state';

function severityPrefix(severity) {
  if (severity === 'critical') return '\u{1F534}';
  if (severity === 'warning') return '\u{1F7E1}';
  return 'ℹ️';
}

export const SOURCE_DISPLAY_NAMES = Object.freeze({
  rss: 'the RSS feed fetcher',
  rssFetcher: 'the RSS feed fetcher',
  publishScheduledContent: 'the scheduled publisher',
  monitorPublishingPipeline: 'the publishing pipeline monitor',
  checkLiveLinks: 'the live-link checker',
  sendTestNotification: 'a test notification',
  firecrawl: 'the web scraper (Firecrawl)',
  forgeScheduled: 'the scheduled forge pipeline',
  buildWeeklyNewsletter: 'the Monday newsletter build',
  cleanupRejectedContent: 'the rejected-content cleanup job',
  cleanupSoftDeletedContent: 'the deleted-content cleanup job',
  workflow_alerts: 'the workflow alert monitor',
  seed: 'the content seeder',
  lab_agent_offline: 'the lab agent watch',
  lab_agent_online: 'the lab agent watch',
  delivery_monitor_red: 'the delivery monitor watch',
  delivery_monitor_green: 'the delivery monitor watch',
  delivery_monitor_blind: 'the delivery monitor watch',
});

export function formatTelegramText({ title, message, severity, source }) {
  // Dynamic prefixed sources — 'forge_ready:{contentId}' (per-post cooldown,
  // lib/triggers/forge-ready-notify.js), 'job_failed:{type}' (per-job-type
  // cooldown, lib/job-failure-notify.js) and 'reminder:{id}' (per-reminder
  // cooldown, lib/timers/reminders.js) — display as their prefix's name
  // rather than the raw key.
  const raw = String(source || '');
  let displayName = SOURCE_DISPLAY_NAMES[source] || source;
  if (!SOURCE_DISPLAY_NAMES[source]) {
    if (raw.startsWith('forge_ready:')) displayName = 'ContentForge';
    else if (raw.startsWith('job_failed:')) displayName = 'the job worker';
    else if (raw.startsWith('reminder:')) displayName = 'the reminders sheet';
  }
  return `${severityPrefix(severity)} ${title}\n\n${message}\n\nReported by ${displayName}.`;
}

/**
 * The cooldown document with its ETag, created empty on first use so the
 * conditional claim always has something to condition on. Two first-time
 * callers both upsert `{ id }`; upsert does not conflict, and each then
 * reads the ETag it needs.
 */
async function readOrCreateState(store) {
  const existing = await store.readDoc('system', NOTIFY_STATE_ID, NOTIFY_STATE_ID);
  if (existing) return existing;
  const created = await store.upsertDoc('system', { id: NOTIFY_STATE_ID });
  if (created?._etag) return created;
  return (await store.readDoc('system', NOTIFY_STATE_ID, NOTIFY_STATE_ID)) || { id: NOTIFY_STATE_ID };
}

/**
 * @param {object} deps
 * @param {{ readDoc: Function, upsertDoc: Function, patchDoc: Function }} deps.store
 * @param {Record<string,string|undefined>} [deps.env]
 * @param {typeof fetch} [deps.fetch]
 * @param {() => Date} [deps.now]
 */
export function createNotifier({
  store,
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  now = () => new Date(),
  log = {},
}) {
  async function notifyTelegram({ title, message, severity = 'info', source = 'system' }) {
    try {
      const token = readKey(env, 'TELEGRAM_BOT_TOKEN');
      const chatId = readKey(env, 'TELEGRAM_CHAT_ID');
      if (!token || !chatId) {
        log.warn?.('[notify] TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not configured; skipping.');
        return { sent: false, reason: 'not_configured' };
      }
      // The prefix only, in every log line below: a dynamic suffix is a
      // content identifier (forge_ready:{contentId}, reminder:{id}), which
      // telemetry never carries.
      const sourceForLog = String(source).split(':')[0];
      const state = await readOrCreateState(store);
      const previous = state[source];
      const last = Date.parse(previous?.lastNotifiedAt || '') || 0;
      if (now().getTime() - last < COOLDOWN_MS) {
        log.log?.(`[notify] Cooldown active for source="${sourceForLog}"; skipping Telegram send.`);
        return { sent: false, reason: 'cooldown' };
      }
      // Claim the window before sending: one field, only if nobody else has
      // written the document since it was read.
      try {
        await store.patchDoc(
          'system',
          NOTIFY_STATE_ID,
          { [source]: { lastNotifiedAt: now().toISOString() } },
          { partitionKey: NOTIFY_STATE_ID, ifMatch: state._etag }
        );
      } catch (error) {
        if (error?.code !== 412) throw error;
        log.log?.(`[notify] Another send claimed source="${sourceForLog}" first; skipping Telegram send.`);
        return { sent: false, reason: 'cooldown' };
      }
      const restore = () =>
        store
          .patchDoc('system', NOTIFY_STATE_ID, { [source]: previous }, { partitionKey: NOTIFY_STATE_ID })
          .catch((error) => log.warn?.(`[notify] could not release source="${sourceForLog}": ${error?.message || error}`));
      let response;
      try {
        response = await fetchWithTimeout(
        fetchImpl,
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: formatTelegramText({ title, message, severity, source }),
          }),
          timeoutMs: TELEGRAM_TIMEOUT_MS,
        }
        );
      } catch (error) {
        await restore();
        throw error;
      }
      if (!response.ok) {
        log.error?.(`[notify] Telegram API error ${response.status}`);
        await restore();
        // The status rides along for the Test Telegram route (lib/notify-test.js):
        // 403 is a blocked bot, 400 a chat Telegram cannot find, 401 a bad token.
        return { sent: false, reason: 'telegram_error', status: response.status };
      }
      return { sent: true };
    } catch (err) {
      log.error?.(`[notify] notifyTelegram failed: ${err?.message || err}`);
      return { sent: false, reason: 'exception' };
    }
  }
  return { notifyTelegram };
}
