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

/**
 * THE ALERT LOG (owner request 2026-11-10). Until now an alert went to
 * Telegram and nowhere else: `notify_state` keeps only when each source last
 * sent, so a notice the owner missed on the phone could not be read again
 * anywhere, by the owner or by Koda. Every alert Telegram accepts is now also
 * kept in `system/notify_log`: the newest NOTIFY_LOG_MAX, oldest first, each
 * with the words that were sent. The Health page lists them with a "Send
 * again" button, and Koda reads the same list (cms/alerts/recent,
 * lib/alerts/handlers.js).
 *
 * The text is the owner's own notices (a job failure's message is already
 * redacted before it gets here, lib/job-failure-notify.js), kept in the
 * owner's own database; it never reaches a log line. Writing the log is best
 * effort and after the send: a failure to record never turns a sent alert
 * into a failed one, and never throws.
 */
export const NOTIFY_LOG_ID = 'notify_log';
export const NOTIFY_LOG_MAX = 50;
/** Telegram's own limit on a message is 4,096 characters; nothing longer is ever sent. */
const LOG_TEXT_MAX = 4096;
/** Tries at the conditional write before giving up on recording one alert. */
const LOG_WRITE_ATTEMPTS = 4;
/** A logged alert may be sent again at most once in this long (a double press, a script). */
export const RESEND_MIN_GAP_MS = 60 * 1000;
/** The marker a resend adds after the text; stripped again when a resend is resent. */
const RESEND_MARKER = /\n\n\(First sent [^)]*\.\)$/;
const RESEND_PREFIX = 'Sent again: ';
/** Telegram refuses a message longer than this (characters). */
const TELEGRAM_TEXT_MAX = 4096;

/** A short random pause before retrying a lost race, so racing writers spread out. */
const jitter = () => new Promise((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 40)));

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

/** A short random id for one logged alert (not a secret: it names a log entry). */
function logEntryId(now) {
  return `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const clip = (value, max) => String(value ?? '').slice(0, max);

/**
 * Add one sent alert to `system/notify_log`, keeping the newest
 * NOTIFY_LOG_MAX. The list is one field written only if the document is
 * unchanged since it was read (ETag), so two alerts sent at once both land;
 * the loser of a race reads again and retries. Never throws.
 */
async function recordSent(store, entry, log) {
  for (let attempt = 1; attempt <= LOG_WRITE_ATTEMPTS; attempt += 1) {
    try {
      const existing = await store.readDoc('system', NOTIFY_LOG_ID, NOTIFY_LOG_ID);
      if (!existing) {
        // First alert ever: create only, so two first alerts at once cannot
        // overwrite each other (the loser gets 409, reads the winner's
        // document and appends). A store without createDoc is a caller that
        // predates the log; it gets the old unconditional write.
        if (typeof store.createDoc === 'function') {
          await store.createDoc('system', { id: NOTIFY_LOG_ID, entries: [entry] });
        } else {
          await store.upsertDoc('system', { id: NOTIFY_LOG_ID, entries: [entry] });
        }
        return true;
      }
      // Without an ETag the write below would not be conditional; read again.
      if (!existing._etag) throw Object.assign(new Error('no etag'), { code: 412 });
      const previous = Array.isArray(existing.entries) ? existing.entries : [];
      const entries = [...previous, entry].slice(-NOTIFY_LOG_MAX);
      await store.patchDoc('system', NOTIFY_LOG_ID, { entries }, { partitionKey: NOTIFY_LOG_ID, ifMatch: existing._etag });
      return true;
    } catch (error) {
      const lostRace = error?.code === 412 || error?.code === 409;
      if (lostRace && attempt < LOG_WRITE_ATTEMPTS) {
        await jitter();
        continue;
      }
      log.warn?.(`[notify] could not record the alert in the log: ${error?.code ?? 'error'}`);
      return false;
    }
  }
  return false;
}

/**
 * The alert log, newest first, or an empty list when nothing has been sent
 * since it began. A failed read throws, so a caller can say "could not read"
 * instead of "no alerts".
 */
export async function readAlertLog(store) {
  const doc = await store.readDoc('system', NOTIFY_LOG_ID, NOTIFY_LOG_ID);
  const entries = Array.isArray(doc?.entries) ? doc.entries : [];
  return [...entries].reverse();
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
  /** Send one message to the owner's chat; the response, or a thrown network error. */
  const post = (token, chatId, text) =>
    fetchWithTimeout(fetchImpl, `https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      timeoutMs: TELEGRAM_TIMEOUT_MS,
    });

  /** Keep a sent alert in the log (best effort; see NOTIFY_LOG_ID). */
  const remember = ({ title, message, severity, source, resentOf = null }) =>
    recordSent(
      store,
      {
        id: logEntryId(now()),
        at: now().toISOString(),
        source: clip(source, 200),
        severity: clip(severity, 20),
        title: clip(title, 300),
        message: clip(message, LOG_TEXT_MAX),
        ...(resentOf ? { resentOf: clip(resentOf, 40) } : {}),
      },
      log
    );

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
        response = await post(token, chatId, formatTelegramText({ title, message, severity, source }));
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
      await remember({ title, message, severity, source });
      return { sent: true };
    } catch (err) {
      log.error?.(`[notify] notifyTelegram failed: ${err?.message || err}`);
      return { sent: false, reason: 'exception' };
    }
  }

  /**
   * Send a logged alert again, by its log id: the owner pressed "Send again"
   * because the first one was missed. No cooldown applies (a person asked,
   * once), the title says it is a repeat and when the first went, and the
   * repeat is logged too, pointing at the original. Never throws.
   *
   * @returns {Promise<{ sent: boolean, reason?: string, status?: number }>}
   */
  async function resendLogged(entryId) {
    try {
      const token = readKey(env, 'TELEGRAM_BOT_TOKEN');
      const chatId = readKey(env, 'TELEGRAM_CHAT_ID');
      if (!token || !chatId) return { sent: false, reason: 'not_configured' };
      const entries = await readAlertLog(store);
      const picked = entries.find((entry) => entry?.id === entryId);
      if (!picked) return { sent: false, reason: 'not_found' };
      // A resend of a resend repeats the first alert, not the repeat: follow
      // `resentOf` back while the earlier entries are still in the log, and
      // strip the repeat's own title prefix and marker when they are not.
      let original = picked;
      for (let hops = 0; original.resentOf && hops < NOTIFY_LOG_MAX; hops += 1) {
        const earlier = entries.find((entry) => entry?.id === original.resentOf);
        if (!earlier) break;
        original = earlier;
      }
      const baseTitle = String(original.title ?? '').replace(new RegExp(`^(${RESEND_PREFIX})+`), '');
      const baseMessage = String(original.message ?? '').replace(RESEND_MARKER, '');
      const firstAt = original.resentOf ? null : original.at;
      // One resend of the same alert a minute, whoever asks: a double press
      // or a script must not page the owner over and over.
      const recent = entries.find(
        (entry) =>
          (entry?.resentOf === original.id || entry?.resentOf === picked.id) &&
          now().getTime() - (Date.parse(entry.at) || 0) < RESEND_MIN_GAP_MS
      );
      if (recent) return { sent: false, reason: 'too_soon' };
      const title = `${RESEND_PREFIX}${baseTitle}`;
      const marker = firstAt ? `\n\n(First sent ${firstAt}.)` : '';
      const { severity, source } = original;
      // The repeat must fit Telegram's limit too: the marker and the title
      // stay, and the original text is cut to make room (a refused resend
      // would also page the owner through the delivery alert).
      const frame = formatTelegramText({ title, message: marker, severity, source }).length;
      const room = Math.max(0, TELEGRAM_TEXT_MAX - frame - 1);
      const body = baseMessage.length > room ? `${baseMessage.slice(0, Math.max(0, room - 1))}…` : baseMessage;
      const message = `${body}${marker}`;
      const response = await post(token, chatId, formatTelegramText({ title, message, severity, source }));
      if (!response.ok) {
        log.error?.(`[notify] Telegram API error ${response.status} on a resend`);
        return { sent: false, reason: 'telegram_error', status: response.status };
      }
      await remember({ title, message, severity, source, resentOf: original.id });
      return { sent: true };
    } catch (err) {
      log.error?.(`[notify] resend failed: ${err?.code ?? 'error'}`);
      return { sent: false, reason: 'exception' };
    }
  }

  return { notifyTelegram, resendLogged };
}
