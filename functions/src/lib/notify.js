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
import { errorFacts } from './http/error-response.js';
import {
  LOG_TEXT_MAX,
  LOG_WRITE_ATTEMPTS,
  NOTIFY_LOG_ID,
  NOTIFY_LOG_MAX,
  NOTIFY_STATE_ID,
  claimCooldown,
  clip,
  jitter,
  logEntryId,
  readOrCreateState,
  recordSent,
  releaseClaim,
} from './notify-store.js';

export {
  COOLDOWN_MS,
  NOTIFY_LOG_ID,
  NOTIFY_LOG_MAX,
  NOTIFY_STATE_ID,
  readAlertLog,
} from './notify-store.js';

// Outbound deadline (T-712): Node's fetch has none, and these calls are
// reached from change-feed handlers where a hung socket holds the lease.
const TELEGRAM_TIMEOUT_MS = 15_000;

/** A logged alert may be sent again at most once in this long (a double press, a script). */
export const RESEND_MIN_GAP_MS = 60 * 1000;
/** The marker a resend adds after the text; stripped again when a resend is resent. */
const RESEND_MARKER = /\n\n\(First sent ([^)]*)\.\)$/;
const RESEND_PREFIX = 'Sent again: ';
/** Telegram refuses a message longer than this (characters). */
const TELEGRAM_TEXT_MAX = 4096;

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
  content_archive_written: 'the yearly content archive',
  content_archive_late: 'the yearly content archive',
  content_archive_waiting: 'the yearly content archive',
  content_archive_blocked: 'the yearly content archive',
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
    // 'cloudflare-change:{agentId}:{auditRowId}' (one source per change, so
    // the cooldown never swallows an agent key's change; lib/cloudflare/record.js).
    else if (raw.startsWith('cloudflare-change:')) displayName = 'the Cloudflare page';
  }
  return `${severityPrefix(severity)} ${title}\n\n${message}\n\nReported by ${displayName}.`;
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
  const deps = { store, env, fetchImpl, now, log };
  return {
    notifyTelegram: (alert) => notifyTelegram(deps, alert),
    resendLogged: (entryId) => resendLogged(deps, entryId),
  };
}

/** Send one message to the owner's chat; the response, or a thrown network error. */
const post = ({ fetchImpl }, token, chatId, text) =>
  fetchWithTimeout(fetchImpl, `https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
    timeoutMs: TELEGRAM_TIMEOUT_MS,
  });


/** Keep a sent alert in the log (best effort; see NOTIFY_LOG_ID). */
function remember({ store, now, log }, { title, message, severity, source, resentOf = null }) {
  return (
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
  ));
}


/**
 * The bot token and chat id, or null when either is missing (an unresolved
 * Key Vault reference reads as missing).
 */
function telegramCredentials(env) {
  const token = readKey(env, 'TELEGRAM_BOT_TOKEN');
  const chatId = readKey(env, 'TELEGRAM_CHAT_ID');
  return token && chatId ? { token, chatId } : null;
}

async function notifyTelegram(deps, { title, message, severity = 'info', source = 'system' }) {
  const { store, env, log } = deps;
  try {
    const credentials = telegramCredentials(env);
    if (!credentials) {
      log.warn?.('[notify] TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not configured; skipping.');
      return { sent: false, reason: 'not_configured' };
    }
    // The prefix only, in every log line below: a dynamic suffix is a
    // content identifier (forge_ready:{contentId}, reminder:{id}), which
    // telemetry never carries.
    const sourceForLog = String(source).split(':')[0];
    const state = await readOrCreateState(store);
    const previous = state[source];
    if (!(await claimCooldown(deps, state, { source, sourceForLog }))) {
      return { sent: false, reason: 'cooldown' };
    }
    const restore = () =>
      store
        .patchDoc('system', NOTIFY_STATE_ID, { [source]: previous }, { partitionKey: NOTIFY_STATE_ID })
        .catch((error) => log.warn?.(`[notify] could not release source="${sourceForLog}": ${errorFacts(error)}`));
    const response = await sendOrUndo(deps, credentials, formatTelegramText({ title, message, severity, source }), restore);
    if (!response.ok) {
      log.error?.(`[notify] Telegram API error ${response.status}`);
      await restore();
      // The status rides along for the Test Telegram route (lib/notify-test.js):
      // 403 is a blocked bot, 400 a chat Telegram cannot find, 401 a bad token.
      return { sent: false, reason: 'telegram_error', status: response.status };
    }
    await remember(deps, { title, message, severity, source });
    return { sent: true };
  } catch (err) {
    log.error?.(`[notify] notifyTelegram failed: ${errorFacts(err)}`);
    return { sent: false, reason: 'exception' };
  }
}

/** Send `text`; when the send itself throws, run `undo` first and rethrow. */
async function sendOrUndo(deps, { token, chatId }, text, undo) {
  try {
    return await post(deps, token, chatId, text);
  } catch (error) {
    await undo();
    throw error;
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
async function resendLogged(deps, entryId) {
  const { store, now, log } = deps;
  try {
    const credentials = telegramCredentials(deps.env);
    if (!credentials) return { sent: false, reason: 'not_configured' };

    // THE REPEAT'S LOG ENTRY IS THE CLAIM (Copilot review of #1638). The
    // once-a-minute check and the write that records the repeat are one
    // conditional write on the log's ETag, made before the send: two
    // presses at the same moment cannot both pass the check, because the
    // second one's write fails with 412, reads again and finds the first
    // one's entry. A send Telegram refuses takes its entry back out.
    let claimed = null;
    for (let attempt = 1; attempt <= LOG_WRITE_ATTEMPTS && !claimed; attempt += 1) {
      const doc = await store.readDoc('system', NOTIFY_LOG_ID, NOTIFY_LOG_ID);
      const stored = Array.isArray(doc?.entries) ? doc.entries : [];
      const plan = planResend(deps, [...stored].reverse(), entryId);
      if (plan.refused) return { sent: false, reason: plan.refused };
      if (!doc?._etag) {
        await jitter();
        continue;
      }
      const entry = {
        id: logEntryId(now()),
        at: now().toISOString(),
        source: clip(plan.source, 200),
        severity: clip(plan.severity, 20),
        title: clip(plan.title, 300),
        message: clip(plan.message, LOG_TEXT_MAX),
        resentOf: clip(plan.originalId, 40),
      };
      if (await writeResendClaim(store, doc, [...stored, entry])) claimed = { entry, plan };
    }
    if (!claimed) return { sent: false, reason: 'exception' };

    const { entry, plan } = claimed;
    const text = formatTelegramText({ title: plan.title, message: plan.message, severity: plan.severity, source: plan.source });
    return await deliverResend(deps, credentials, text, entry.id);
  } catch (err) {
    log.error?.(`[notify] resend failed: ${err?.code ?? 'error'}`);
    return { sent: false, reason: 'exception' };
  }
}

/**
 * The log with the repeat added, written under the ETag it was read with.
 * False (after a short pause) when the document moved since.
 */
async function writeResendClaim(store, doc, entries) {
  try {
    await store.patchDoc(
      'system',
      NOTIFY_LOG_ID,
      { entries: entries.slice(-NOTIFY_LOG_MAX) },
      { partitionKey: NOTIFY_LOG_ID, ifMatch: doc._etag }
    );
    return true;
  } catch (error) {
    if (error?.code !== 412) throw error;
    await jitter();
    return false;
  }
}

/** Send a claimed repeat; a refused or failed send takes its log entry back out. */
async function deliverResend(deps, credentials, text, entryId) {
  const response = await sendOrUndo(deps, credentials, text, () => releaseClaim(deps, entryId));
  if (!response.ok) {
    deps.log.error?.(`[notify] Telegram API error ${response.status} on a resend`);
    await releaseClaim(deps, entryId);
    return { sent: false, reason: 'telegram_error', status: response.status };
  }
  return { sent: true };
}

/**
 * What sending `entryId` again means, from the log (newest first): the
 * words, or the reason not to. A resend of a resend repeats the first
 * alert: `resentOf` is followed back while the earlier entries are still
 * in the log; when they are not, the repeat's own title prefix and marker
 * are stripped and the time in its marker is kept (Copilot review of
 * #1638), so the repeat still says when the first one went.
 */
function planResend({ now }, entries, entryId) {
  const picked = entries.find((entry) => entry?.id === entryId);
  if (!picked) return { refused: 'not_found' };
  let original = picked;
  for (let hops = 0; original.resentOf && hops < NOTIFY_LOG_MAX; hops += 1) {
    const earlier = entries.find((entry) => entry?.id === original.resentOf);
    if (!earlier) break;
    original = earlier;
  }
  const storedMessage = String(original.message ?? '');
  const baseTitle = String(original.title ?? '').replace(new RegExp(`^(${RESEND_PREFIX})+`), '');
  const baseMessage = storedMessage.replace(RESEND_MARKER, '');
  const firstAt = original.resentOf ? (RESEND_MARKER.exec(storedMessage)?.[1] ?? null) : original.at;
  // One resend of the same alert a minute, whoever asks: a double press
  // or a script must not page the owner over and over.
  const recent = entries.find(
    (entry) =>
      (entry?.resentOf === original.id || entry?.resentOf === picked.id) &&
      now().getTime() - (Date.parse(entry.at) || 0) < RESEND_MIN_GAP_MS
  );
  if (recent) return { refused: 'too_soon' };
  const title = `${RESEND_PREFIX}${baseTitle}`;
  const marker = firstAt ? `\n\n(First sent ${firstAt}.)` : '';
  const { severity, source } = original;
  // The repeat must fit Telegram's limit too: the marker and the title
  // stay, and the original text is cut to make room (a refused resend
  // would also page the owner through the delivery alert).
  const frame = formatTelegramText({ title, message: marker, severity, source }).length;
  const room = Math.max(0, TELEGRAM_TEXT_MAX - frame - 1);
  const body = baseMessage.length > room ? `${baseMessage.slice(0, Math.max(0, room - 1))}…` : baseMessage;
  return { title, message: `${body}${marker}`, severity, source, originalId: original.id };
}
