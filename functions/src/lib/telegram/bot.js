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
import { recordedFailure } from '../http/error-response.js';

// Outbound deadline (T-712): Node's fetch has none, and these calls are
// reached from change-feed handlers where a hung socket holds the lease.
const TELEGRAM_TIMEOUT_MS = 15_000;

/** Cosmos containers this module reads and writes. */
export const ACTIVITY_CONTAINER = 'telegram_bot_activity';
export const SETTINGS_CONTAINER = 'admin_settings';
export const SETTINGS_ID = 'telegram_bot';

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

const ASSISTANT_SYSTEM_PROMPT = `You are the operations assistant for HybridCloudWorks, a hybrid-cloud content platform. Answer from the platform status JSON you are given. Be concise and concrete. If the JSON does not contain the answer, say so rather than guessing.`;

/**
 * The webhook secret Telegram will echo back.
 *
 * Derived from the bot token rather than stored separately, exactly as upstream
 * did — one secret to rotate, not two, and no way for the two to drift apart.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {string} hex digest, or '' when the token is not configured
 */
export function expectedWebhookSecret(env = process.env) {
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

/** "1 hour" / "3 hours" — upstream's countNoun, kept so replies read the same. */
export function countNoun(count, singular, pluralWord) {
  const n = Number(count) || 0;
  const plural = pluralWord || `${singular}s`;
  return `${n} ${n === 1 ? singular : plural}`;
}

export function formatOpsStatus(snapshot = {}) {
  const r = snapshot.readiness || {};
  const s = snapshot.operationalSignals || {};
  return [
    `Published: ${r.publishedCount ?? 0}`,
    `Needs review: ${r.needsReviewCount ?? 0}`,
    `Staged: ${r.stagedCount ?? 0}`,
    `RSS cached: ${r.rssCount ?? 0}`,
    `Open alerts: ${(snapshot.alerts || []).length}`,
    `Publish failures: ${s.publishFailureCount ?? 0}`,
    s.lastSchedulerSuccessAt
      ? `Last scheduler success: ${s.lastSchedulerSuccessAt}`
      : 'Last scheduler success: none recorded',
  ].join('\n');
}

export function formatAlerts(alerts = []) {
  if (!alerts.length) return 'No open workflow alerts.';
  return alerts
    .slice(0, 10)
    .map((a) => `• ${a.id} — ${a.title || a.message || 'untitled'} (${a.severity || 'info'})`)
    .join('\n');
}

export function formatDigest(digest) {
  if (!digest) return 'No digest has been generated yet.';
  const ops = digest.publishingOps || {};
  return [
    `Digest ${digest.id || ''}`.trim(),
    `Publishing ops: ${ops.status || 'unknown'}`,
    ops.lastRunAt ? `Last run: ${ops.lastRunAt}` : null,
    digest.summary ? `\n${digest.summary}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatAiReadiness(readiness = {}) {
  const providers = readiness.providers || {};
  const lines = Object.entries(providers).map(
    ([name, state]) => `• ${name}: ${state?.configured ? 'configured' : 'not configured'}`
  );
  if (!lines.length) return 'No AI provider state is reported in the current snapshot.';
  return ['AI stack readiness:', ...lines].join('\n');
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
  async function isCommandEnabled(command) {
    // Absent settings document means every command is on. A bot that goes
    // silent because nobody has visited an admin page yet is worse than one
    // that answers.
    try {
      const doc = await store.readDoc(SETTINGS_CONTAINER, SETTINGS_ID, SETTINGS_ID);
      const commands = doc?.commands;
      if (!commands || typeof commands !== 'object') return true;
      return commands[command] !== false;
    } catch (error) {
      log.warn?.(`[telegram] could not read command toggles: ${error?.message || error}`);
      return true;
    }
  }

  async function logActivity({ command, args = '', ok, detail = '' }) {
    // Best effort. Losing the audit row must not lose the reply.
    try {
      await store.upsertDoc(ACTIVITY_CONTAINER, {
        id: uuid(),
        command,
        args,
        ok,
        detail,
        at: now().toISOString(),
      });
    } catch (error) {
      log.warn?.(`[telegram] activity log write failed: ${error?.message || error}`);
    }
  }

  async function updateAlert(alertId, action, note) {
    const { buildWorkflowAlertUpdates } = await import('../ops-health.js');
    const alert = await store.readDoc('workflow_alerts', alertId, alertId);
    if (!alert) {
      await logActivity({ command: `/${action}`, args: alertId, ok: false, detail: 'not found' });
      return `I couldn't find an alert with the ID ${alertId} — send /alerts to see the open ones.`;
    }
    const updates = buildWorkflowAlertUpdates({
      action,
      now: now().toISOString(),
      actor: 'telegram_bot',
      normalizedResolutionNote: note,
      alertData: alert,
    });
    // patchDoc's third argument is the updates object (partitionKey rides in
    // options and defaults to the id). This used to pass alertId there, which
    // Object.entries() exploded into per-character junk fields while the real
    // updates were silently dropped — /ack and /resolve confirmed without
    // persisting anything.
    await store.patchDoc('workflow_alerts', alertId, updates);
    await logActivity({ command: `/${action}`, args: alertId, ok: true, detail: `${action}d` });
    return `Done — alert ${alertId} is now ${action === 'acknowledge' ? 'acknowledged' : 'resolved'}.`;
  }

  async function queue(type, payload, describe) {
    const jobId = await enqueueJob({ type, payload });
    await logActivity({ command: `/${type}`, args: JSON.stringify(payload), ok: true, detail: jobId });
    return `${describe} Job ${jobId} is queued — send /status in a minute or check the review queue.`;
  }

  /** Command name (no slash) => handler. Adding a command is an entry, not a branch. */
  const handlers = {
    status: async () => formatOpsStatus(await snapshot()),
    queue: async () => {
      const s = (await snapshot()).operationalSignals || {};
      const breaches = s.queueBreachCount ?? 0;
      const oldestStaged = s.oldestStagedHours ?? 0;
      const lines = [
        breaches > 0
          ? `${countNoun(breaches, 'item has', 'items have')} been waiting in the review queue for more than a day.`
          : 'The review queue is healthy — nothing has been waiting more than a day.',
        oldestStaged > 0
          ? `The oldest item staged for publishing has been sitting for about ${countNoun(oldestStaged, 'hour')}.`
          : 'Nothing is currently stuck in staging.',
      ];
      // The Phase 5 loop's worklist: what forge_ready is waiting on /approve,
      // newest first, with the commands inline so approval is one reply (T-607).
      try {
        const staged = await store.queryDocs(
          'content',
          "SELECT TOP 5 c.id, c.Title, c.forgeGrade FROM c WHERE c.contentStatus = 'forge_ready' ORDER BY c._ts DESC",
          []
        );
        if (staged?.length) {
          lines.push('', 'Staged for approval:');
          for (const item of staged) {
            const grade =
              typeof item.forgeGrade?.overall === 'number'
                ? ` — grade ${item.forgeGrade.overall}`
                : '';
            lines.push(`• ${item.Title || item.id}${grade}`, `  /approve ${item.id}`);
          }
        } else {
          lines.push('', 'Nothing is staged for approval right now.');
        }
      } catch (error) {
        log.warn?.(`[telegram] staged listing failed: ${error?.message || error}`);
        lines.push('', 'Could not read the staged-for-approval list just now.');
      }
      return lines.join('\n');
    },
    alerts: async () => formatAlerts((await snapshot()).alerts),
    digest: async () => formatDigest((await snapshot()).digest),
    ai: async () => formatAiReadiness((await snapshot()).readiness),
    rss: async () => queue('fetch-rss-feeds', {}, 'Queued an RSS fetch.'),
    inspect: async () => queue('batch-inspect', { limit: 5 }, 'Queued a batch inspection of up to 5 items.'),
    ack: async (argText) => {
      const alertId = argText.trim();
      if (!alertId) return 'Usage: /ack <alertId>';
      return updateAlert(alertId, 'acknowledge', '');
    },
    resolve: async (argText) => {
      const [alertId, ...noteParts] = argText.split(/\s+/);
      const note = noteParts.join(' ').trim();
      if (!alertId || !note) return 'Usage: /resolve <alertId> <note>';
      return updateAlert(alertId, 'resolve', note);
    },
    forge: async (argText) => {
      const contentId = argText.trim();
      if (!contentId) return 'Usage: /forge <contentId>';
      // resolveForgeTargets reads sourceContentId/sourceContentIds — a bare
      // contentId key is rejected and the job lands failed (T-601).
      return queue(
        'forge-article',
        { sourceContentId: contentId },
        `Queued the forge pipeline for ${contentId}.`
      );
    },
    approve: async (argText) => {
      const contentId = argText.trim();
      if (!contentId) return 'Usage: /approve <contentId>';
      // The publish-content worker calls the injected processPublishContent
      // with markLive: true — the same pipeline as the admin portal and the
      // scheduled publisher, every gate included (T-606).
      return queue(
        'publish-content',
        { contentId },
        `Queued publish for ${contentId} — it goes live once every gate passes.`
      );
    },
    reject: async (argText) => {
      const [contentId, ...reasonParts] = argText.split(/\s+/);
      const reason = reasonParts.join(' ').trim();
      if (!contentId) return 'Usage: /reject <contentId> [reason]';
      // Same lazy-import shape as updateAlert: the transition core is the
      // portal's own writer (one state machine, not a bot-side copy).
      const { createContentStatusTransitioner } = await import('../cms/content-update.js');
      const applyTransition = createContentStatusTransitioner({ store, now, uuid });
      const result = await applyTransition({
        contentId,
        newStatus: 'rejected',
        reviewNotes: reason,
        reviewedBy: 'telegram-bot',
        // Named, not implied: the transitioner refuses a call with no role
        // (AP-F13, #937). A command reaches this handler only from the
        // owner's own chat (isAuthorizedSender, checked before any command
        // runs, behind the webhook secret), and the owner is the
        // super_admin, so /reject can take a live page down as the portal
        // lets the owner do.
        actorRole: 'super_admin',
        authMethod: 'telegram_webhook',
      });
      if (!result.ok) {
        await logActivity({ command: '/reject', args: argText, ok: false, detail: result.error });
        if (result.status === 404) {
          return `I couldn't find content ${contentId}.`;
        }
        const allowed = result.allowedTransitions?.length
          ? ` (allowed next: ${result.allowedTransitions.join(', ')})`
          : '';
        return `Can't reject ${contentId}: ${result.error}${allowed}`;
      }
      await logActivity({
        command: '/reject',
        args: argText,
        ok: true,
        detail: `${result.from} -> rejected`,
      });
      return `Done — ${contentId} is rejected (was ${result.from})${reason ? `, noted: ${reason}` : ''}.`;
    },
  };

  async function handleCommand(text) {
    const [rawCommand, ...rest] = text.trim().split(/\s+/);
    const command = rawCommand.toLowerCase().replace(/^\//, '').split('@')[0];
    const argText = rest.join(' ').trim();

    if (command === 'help' || command === 'start') return HELP_TEXT;

    if (TOGGLEABLE_COMMANDS.includes(command) && !(await isCommandEnabled(command))) {
      return `/${command} is currently disabled from the admin Telegram Bot page.`;
    }

    const handler = handlers[command];
    if (!handler) return null;
    return handler(argText);
  }

  async function handleFreeform(text) {
    const snap = await snapshot();
    const context = JSON.stringify(snap).slice(0, 6000);
    const answer = await generateText({
      prompt: `Platform status JSON:\n${context}\n\nQuestion: ${text}`,
      systemPrompt: ASSISTANT_SYSTEM_PROMPT,
      purpose: 'general',
    });
    return answer || "I couldn't generate a response.";
  }

  return {
    expectedSecret: () => expectedWebhookSecret(env),

    /**
     * Process one Telegram update. Returns what the caller should do, never
     * throws — the webhook must answer 200 to anything Telegram sends that is
     * genuinely from Telegram, or Telegram retries it in a loop.
     *
     * @param {object} update - the parsed Telegram update body
     * @returns {Promise<{handled: boolean, reason?: string, reply?: string}>}
     */
    async handleUpdate(update) {
      const message = update?.message;
      if (!message || typeof message.text !== 'string') {
        return { handled: false, reason: 'no_text' };
      }
      if (!isAuthorizedSender(message.chat?.id, env)) {
        // Deliberately no reply. Answering would confirm the bot exists to
        // anyone who found it.
        log.warn?.(`[telegram] ignored message from unauthorized chat ${message.chat?.id}`);
        return { handled: false, reason: 'unauthorized_chat' };
      }
      const text = message.text.trim();
      if (!text) return { handled: false, reason: 'empty' };

      let reply;
      try {
        reply = text.startsWith('/')
          ? ((await handleCommand(text)) ?? 'Unknown command. Send /help for the list.')
          : await handleFreeform(text);
      } catch (error) {
        // The activity log is an admin read: a sentence with the code and the
        // log line's reference, and the line itself is content-free (#945).
        const detail = recordedFailure(log, 'The command failed.', error);
        await logActivity({ command: text.split(/\s+/)[0], ok: false, detail });
        reply = `Something went wrong: ${error?.message || error}`;
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
        log.error?.(`[telegram] reply send failed: ${error?.stack || error}`);
        return { handled: true, reply, sendFailed: true };
      }
      return { handled: true, reply };
    },
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
