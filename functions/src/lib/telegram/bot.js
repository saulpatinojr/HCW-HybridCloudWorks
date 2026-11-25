/**
 * telegram/bot.js — the inbound Telegram bot (T-512).
 *
 * Site-Main `functions/lib/telegram-bot.js` + the `telegramWebhook` handler in
 * `functions/index.js` (5643–5850). Ported deliberately rather than retired:
 * Migration-Plan §6 step 6 assumed a receiver existed here and there was none,
 * so the plan's "re-point the webhook" step had nothing to point at.
 *
 * TWO THINGS CHANGED IN THE PORT, both forced by the platform.
 *
 * 1. **Long commands enqueue instead of running inline.** Upstream answered
 *    Telegram with 200 immediately and then kept working in the background,
 *    which Cloud Functions tolerates. An Azure Functions invocation ENDS when
 *    the handler returns — background work after the response is not
 *    guaranteed to run, so that shape would silently drop `/forge` and
 *    `/inspect` half the time. Those two, plus `/rss`, now enqueue the platform
 *    job that already exists for each (`forge-article`, `batch-inspect`,
 *    `fetch-rss-feeds`, T-322) and reply "started". The fast read-only
 *    commands still answer inline.
 *
 * 2. **The reply is sent, then 200 is returned.** Same reason. Telegram's own
 *    timeout is generous enough for a status query; a command that cannot
 *    answer inside it is a command that should be a job.
 *
 * AUTHORIZATION IS TWO INDEPENDENT CHECKS, and neither is a bearer token —
 * Telegram cannot send one:
 *
 *   1. `X-Telegram-Bot-Api-Secret-Token` must equal sha256(TELEGRAM_BOT_TOKEN).
 *      Telegram echoes back whatever secret was registered with `setWebhook`,
 *      so this proves the request came from Telegram and not from anyone who
 *      guessed the URL. Compared in constant time.
 *   2. The sending chat id must equal TELEGRAM_CHAT_ID. The secret proves
 *      "Telegram sent this"; it does not prove "the owner sent this", because
 *      anyone who finds the bot can message it.
 *
 * Failing either is silent to the sender by design: an unauthorized chat gets
 * no reply at all, so the bot cannot be used to confirm it exists.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { readKey } from '../ai/router.js';
import { fetchWithTimeout } from '../http/fetch-with-timeout.js';
import { recordedFailure, errorFacts } from '../http/error-response.js';
import { COMMANDS, handleFreeform, isCommandEnabled, logActivity } from './commands.js';

// What each command does lives in commands.js and how the read-only answers
// are worded in format.js; exported again here so callers keep importing
// from bot.js.
export { ACTIVITY_CONTAINER, SETTINGS_CONTAINER, SETTINGS_ID } from './commands.js';
export { countNoun, formatAiReadiness, formatDigest, formatOpsStatus } from './format.js';

// Outbound deadline (T-712): Node's fetch has none, and these calls are
// reached from change-feed handlers where a hung socket holds the lease.
const TELEGRAM_TIMEOUT_MS = 15_000;

/** Commands the admin page can switch off. `/help` and `/start` never are. */
export const TOGGLEABLE_COMMANDS = Object.freeze([
  'status',
  'queue',
  'alerts',
  'digest',
  'ai',
  'rss',
  'inspect',
  'ack',
  'resolve',
  'forge',
  'approve',
  'reject',
]);

export const HELP_TEXT = `Commands:
/status - platform health snapshot
/queue - review queue counts
/alerts - open workflow alerts
/digest - latest publishing digest
/ai - AI stack readiness
/rss - queue an RSS fetch
/inspect - queue a batch inspection (up to 5 items)
/ack <alertId> - acknowledge an alert
/resolve <alertId> <note> - resolve an alert
/forge <contentId> - queue the forge pipeline on a candidate
/approve <contentId> - publish a staged draft live
/reject <contentId> [reason] - reject a staged draft
/help - this message

Anything else is answered as a free-form question grounded in current platform status.`;

/**
 * The webhook secret Telegram will echo back.
 *
 * SEC-6: Prefers an explicitly configured independent webhook secret
 * (`TELEGRAM_WEBHOOK_SECRET`), falling back to sha256(token) for backward
 * compatibility if not set.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {string} hex digest or explicit secret, or '' when neither is configured
 */
export function expectedWebhookSecret(env = process.env) {
  const explicit = readKey(env, 'TELEGRAM_WEBHOOK_SECRET');
  if (explicit) return explicit;
  const token = readKey(env, 'TELEGRAM_BOT_TOKEN');
  if (!token) return '';
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time string compare.
 *
 * `===` on a secret leaks its length and prefix through timing. The lengths are
 * checked first because timingSafeEqual throws on a mismatch, and a length
 * difference is not secret — the digest is always 64 hex characters.
 *
 * @param {string} a
 * @param {string} b
 */
export function secretMatches(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Is this chat allowed to drive the bot?
 *
 * @param {string|number|undefined} chatId
 * @param {Record<string, string|undefined>} env
 */
export function isAuthorizedSender(chatId, env = process.env) {
  const allowed = readKey(env, 'TELEGRAM_CHAT_ID');
  if (!allowed) return false;
  return String(chatId ?? '') === String(allowed);
}

export function formatAlerts(alerts = []) {
  if (!alerts.length) return 'No open workflow alerts.';
  return alerts
    .slice(0, 10)
    .map((a) => `• ${a.id} — ${a.title || a.message || 'untitled'} (${a.severity || 'info'})`)
    .join('\n');
}

/** Every command, `/alerts` included, as `(b, argText)`. */
const ALL_COMMANDS = {
  ...COMMANDS,
  alerts: async (b) => formatAlerts((await b.snapshot()).alerts),
};

async function handleCommand(b, handlers, text) {
  const [rawCommand, ...rest] = text.trim().split(/\s+/);
  const command = rawCommand.toLowerCase().replace(/^\//, '').split('@')[0];
  const argText = rest.join(' ').trim();

  if (command === 'help' || command === 'start') return HELP_TEXT;

  if (TOGGLEABLE_COMMANDS.includes(command) && !(await isCommandEnabled(b, command))) {
    return `/${command} is currently disabled from the admin Telegram Bot page.`;
  }

  const handler = handlers[command];
  if (!handler) return null;
  return handler(argText);
}

/** Why an update is not handled, before any command runs; null when it is the owner's text. */
function updateRefusal(b, update) {
  const message = update?.message;
  if (!message || typeof message.text !== 'string') {
    return { handled: false, reason: 'no_text' };
  }
  if (!isAuthorizedSender(message.chat?.id, b.env)) {
    // Deliberately no reply. Answering would confirm the bot exists to
    // anyone who found it.
    b.log.warn?.("[telegram] ignored a message from a chat that is not the owner's");
    return { handled: false, reason: 'unauthorized_chat' };
  }
  return null;
}

/** The reply to a command or a free-form question. */
async function replyTo(b, handlers, text) {
  if (!text.startsWith('/')) return handleFreeform(b, text);
  return (await handleCommand(b, handlers, text)) ?? 'Unknown command. Send /help for the list.';
}

/**
 * Process one Telegram update. Returns what the caller should do, never
 * throws — the webhook must answer 200 to anything Telegram sends that is
 * genuinely from Telegram, or Telegram retries it in a loop.
 *
 * @param {object} b - the bot's dependencies
 * @param {object} handlers - command name => `(argText) => reply`
 * @param {object} update - the parsed Telegram update body
 * @returns {Promise<{handled: boolean, reason?: string, reply?: string}>}
 */
async function handleUpdate(b, handlers, update) {
  const { log, send } = b;
  const refused = updateRefusal(b, update);
  if (refused) return refused;
  const text = update.message.text.trim();
  if (!text) return { handled: false, reason: 'empty' };

  let reply;
  try {
    reply = await replyTo(b, handlers, text);
  } catch (error) {
    // The activity log is an admin read: a sentence with the code and the
    // log line's reference, and the line itself is content-free (#945).
    const detail = recordedFailure(log, 'The command failed.', error);
    await logActivity(b, { command: text.split(/\s+/)[0], ok: false, detail });
    // The chat reply says the same: an authored refusal as written,
    // otherwise the stored sentence with its code and reference, never
    // the error's own words (CodeRabbit on #1200).
    reply = `Something went wrong: ${detail}`;
  }

  // The send is INSIDE the guard, not after it (T-730). It used to sit
  // outside the try above, so a network-level rejection from the sender
  // propagated out of handleUpdate, out of the webhook handler, and the
  // host answered 500 — breaking the invariant telegram-http.js states in
  // its own header: always 200 once the secret is valid, because Telegram
  // retries non-2xx and "a 500 on a bad command turns one broken message
  // into a retry storm that re-runs the command". For /forge, /approve,
  // /rss and /inspect each retry re-runs the enqueue, so one transient
  // Telegram outage produced duplicate publish and forge jobs.
  //
  // A failed send is genuinely unreportable — the only channel back to the
  // owner is the one that just failed — so it is logged and acknowledged.
  // The command already ran; re-running it would be worse than silence.
  try {
    await send(reply);
  } catch (error) {
    log.error?.(`[telegram] reply send failed: ${errorFacts(error)}`);
    return { handled: true, reply, sendFailed: true };
  }
  return { handled: true, reply };
}

/**
 * Build the bot.
 *
 * Every dependency is injected, so the whole command surface is testable
 * without a Cosmos account, a queue, or the Telegram API — which matters here
 * more than usual, because the alternative is testing a bot by messaging it.
 *
 * @param {object} deps
 * @param {object} deps.store - cosmos-client (readDoc/upsertDoc/patchDoc/queryDocs)
 * @param {() => Promise<object>} deps.snapshot - ops-health buildSnapshot
 * @param {(job: {type: string, payload: object}) => Promise<string>} deps.enqueueJob - returns the job id
 * @param {(args: {prompt: string, systemPrompt: string, purpose: string}) => Promise<string>} deps.generateText
 * @param {(text: string) => Promise<{sent: boolean}>} deps.send
 * @param {Record<string,string|undefined>} [deps.env]
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 * @param {object} [deps.log]
 */
export function createTelegramBot({
  store,
  snapshot,
  enqueueJob,
  generateText,
  send,
  env = process.env,
  now = () => new Date(),
  uuid = () => crypto.randomUUID(),
  log = {},
}) {
  const b = { store, snapshot, enqueueJob, generateText, send, env, now, uuid, log };
  /** Command name (no slash) => handler. Adding a command is an entry, not a branch. */
  const handlers = Object.fromEntries(
    Object.entries(ALL_COMMANDS).map(([name, command]) => [name, (argText) => command(b, argText)])
  );
  return {
    expectedSecret: () => expectedWebhookSecret(env),
    handleUpdate: (update) => handleUpdate(b, handlers, update),
  };
}

/**
 * Raw outbound send — NOT createNotifier's notifyTelegram.
 *
 * That one carries a 15-minute per-source cooldown, which is right for alert
 * storms and wrong for a reply: a bot that silently drops your second question
 * within the cooldown window looks broken.
 *
 * @param {Record<string,string|undefined>} env
 * @param {typeof fetch} fetchImpl
 */
export function createSender({ env = process.env, fetch: fetchImpl = globalThis.fetch, log = {} } = {}) {
  return async function send(text) {
    const token = readKey(env, 'TELEGRAM_BOT_TOKEN');
    const chatId = readKey(env, 'TELEGRAM_CHAT_ID');
    if (!token || !chatId) {
      log.warn?.('[telegram] TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not configured; not sending.');
      return { sent: false, reason: 'not_configured' };
    }
    const response = await fetchWithTimeout(
      fetchImpl,
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4096) }),
        timeoutMs: TELEGRAM_TIMEOUT_MS,
      }
    );
    if (!response.ok) {
      log.error?.(`[telegram] sendMessage failed with ${response.status}`);
      return { sent: false, reason: 'telegram_error' };
    }
    return { sent: true };
  };
}
