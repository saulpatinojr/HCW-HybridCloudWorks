/**
 * telegram/commands.js — what each of the Telegram bot's commands does
 * (bot.js says how a message reaches them, and who may send one). Each
 * command is a function `(b, argText)`, where `b` is the bot's injected
 * dependencies (createTelegramBot), and returns the reply text.
 * `/alerts` is added to the table in bot.js, beside formatAlerts.
 */
import { errorFacts } from '../http/error-response.js';
import { countNoun, formatAiReadiness, formatDigest, formatOpsStatus, stagedLine } from './format.js';

export const SETTINGS_CONTAINER = 'admin_settings';
export const SETTINGS_ID = 'telegram_bot';
export const ACTIVITY_CONTAINER = 'telegram_bot_activity';

const ASSISTANT_SYSTEM_PROMPT = `You are the operations assistant for HybridCloudWorks, a hybrid-cloud content platform. Answer from the platform status JSON you are given. Be concise and concrete. If the JSON does not contain the answer, say so rather than guessing.`;

export async function isCommandEnabled(b, command) {
  // Absent settings document means every command is on. A bot that goes
  // silent because nobody has visited an admin page yet is worse than one
  // that answers.
  try {
    const doc = await b.store.readDoc(SETTINGS_CONTAINER, SETTINGS_ID, SETTINGS_ID);
    const commands = doc?.commands;
    if (!commands || typeof commands !== 'object') return true;
    return commands[command] !== false;
  } catch (error) {
    b.log.warn?.(`[telegram] could not read command toggles: ${errorFacts(error)}`);
    return true;
  }
}

export async function logActivity(b, { command, args = '', ok, detail = '' }) {
  // Best effort. Losing the audit row must not lose the reply.
  try {
    await b.store.upsertDoc(ACTIVITY_CONTAINER, {
      id: b.uuid(),
      command,
      args,
      ok,
      detail,
      at: b.now().toISOString(),
    });
  } catch (error) {
    b.log.warn?.(`[telegram] activity log write failed: ${errorFacts(error)}`);
  }
}

async function updateAlert(b, alertId, action, note) {
  const { buildWorkflowAlertUpdates } = await import('../ops-health.js');
  const alert = await b.store.readDoc('workflow_alerts', alertId, alertId);
  if (!alert) {
    await logActivity(b, { command: `/${action}`, args: alertId, ok: false, detail: 'not found' });
    return `I couldn't find an alert with the ID ${alertId} — send /alerts to see the open ones.`;
  }
  const updates = buildWorkflowAlertUpdates({
    action,
    now: b.now().toISOString(),
    actor: 'telegram_bot',
    normalizedResolutionNote: note,
    alertData: alert,
  });
  // patchDoc's third argument is the updates object (partitionKey rides in
  // options and defaults to the id). This used to pass alertId there, which
  // Object.entries() exploded into per-character junk fields while the real
  // updates were silently dropped — /ack and /resolve confirmed without
  // persisting anything.
  await b.store.patchDoc('workflow_alerts', alertId, updates);
  await logActivity(b, { command: `/${action}`, args: alertId, ok: true, detail: `${action}d` });
  return `Done — alert ${alertId} is now ${action === 'acknowledge' ? 'acknowledged' : 'resolved'}.`;
}

async function queueJob(b, type, payload, describe) {
  const jobId = await b.enqueueJob({ type, payload });
  await logActivity(b, { command: `/${type}`, args: JSON.stringify(payload), ok: true, detail: jobId });
  return `${describe} Job ${jobId} is queued — send /status in a minute or check the review queue.`;
}

/** One staged item in the /queue worklist, with its /approve command inline. */
function stagedItemLines(item) {
  const grade = typeof item.forgeGrade?.overall === 'number' ? ` — grade ${item.forgeGrade.overall}` : '';
  return [`• ${item.Title || item.id}${grade}`, `  /approve ${item.id}`];
}

/**
 * The Phase 5 loop's worklist: what forge_ready is waiting on /approve,
 * newest first, with the commands inline so approval is one reply (T-607).
 */
async function stagedForApproval(b) {
  try {
    const staged = await b.store.queryDocs(
      'content',
      "SELECT TOP 5 c.id, c.Title, c.forgeGrade FROM c WHERE c.contentStatus = 'forge_ready' ORDER BY c._ts DESC",
      []
    );
    if (!staged?.length) return ['', 'Nothing is staged for approval right now.'];
    return ['', 'Staged for approval:', ...staged.flatMap(stagedItemLines)];
  } catch (error) {
    b.log.warn?.(`[telegram] staged listing failed: ${errorFacts(error)}`);
    return ['', 'Could not read the staged-for-approval list just now.'];
  }
}

async function queueCommand(b) {
  const s = (await b.snapshot()).operationalSignals || {};
  const breaches = s.queueBreachCount ?? 0;
  // null: items wait but none carries a time (#1516); not "nothing stuck".
  const oldestStaged = s.oldestStagedHours;
  const waiting = Number(s.stagedWaitingCount) || 0;
  const lines = [
    breaches > 0
      ? `${countNoun(breaches, 'item has', 'items have')} been waiting in the review queue for more than a day.`
      : 'The review queue is healthy — nothing has been waiting more than a day.',
    stagedLine(oldestStaged, waiting),
    ...(await stagedForApproval(b)),
  ];
  return lines.join('\n');
}

async function ackCommand(b, argText) {
  const alertId = argText.trim();
  if (!alertId) return 'Usage: /ack <alertId>';
  return updateAlert(b, alertId, 'acknowledge', '');
}

async function resolveCommand(b, argText) {
  const [alertId, ...noteParts] = argText.split(/\s+/);
  const note = noteParts.join(' ').trim();
  if (!alertId || !note) return 'Usage: /resolve <alertId> <note>';
  return updateAlert(b, alertId, 'resolve', note);
}

async function forgeCommand(b, argText) {
  const contentId = argText.trim();
  if (!contentId) return 'Usage: /forge <contentId>';
  // resolveForgeTargets reads sourceContentId/sourceContentIds — a bare
  // contentId key is rejected and the job lands failed (T-601).
  return queueJob(b, 'forge-article', { sourceContentId: contentId }, `Queued the forge pipeline for ${contentId}.`);
}

async function approveCommand(b, argText) {
  const contentId = argText.trim();
  if (!contentId) return 'Usage: /approve <contentId>';
  // The publish-content worker calls the injected processPublishContent
  // with markLive: true — the same pipeline as the admin portal and the
  // scheduled publisher, every gate included (T-606).
  return queueJob(
    b,
    'publish-content',
    { contentId },
    `Queued publish for ${contentId} — it goes live once every gate passes.`
  );
}

/** The reply to a refused /reject, after its activity row. */
async function rejectRefused(b, argText, contentId, result) {
  await logActivity(b, { command: '/reject', args: argText, ok: false, detail: result.error });
  if (result.status === 404) {
    return `I couldn't find content ${contentId}.`;
  }
  const allowed = result.allowedTransitions?.length ? ` (allowed next: ${result.allowedTransitions.join(', ')})` : '';
  return `Can't reject ${contentId}: ${result.error}${allowed}`;
}

async function rejectCommand(b, argText) {
  const [contentId, ...reasonParts] = argText.split(/\s+/);
  const reason = reasonParts.join(' ').trim();
  if (!contentId) return 'Usage: /reject <contentId> [reason]';
  // Same lazy-import shape as updateAlert: the transition core is the
  // portal's own writer (one state machine, not a bot-side copy).
  const { createContentStatusTransitioner } = await import('../cms/content-update.js');
  const applyTransition = createContentStatusTransitioner({ store: b.store, now: b.now, uuid: b.uuid });
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
  if (!result.ok) return rejectRefused(b, argText, contentId, result);
  await logActivity(b, {
    command: '/reject',
    args: argText,
    ok: true,
    detail: `${result.from} -> rejected`,
  });
  return `Done — ${contentId} is rejected (was ${result.from})${reason ? `, noted: ${reason}` : ''}.`;
}

/**
 * Command name (no slash) => handler, all but `/alerts` (bot.js adds it).
 * Adding a command is an entry, not a branch.
 */
export const COMMANDS = {
  status: async (b) => formatOpsStatus(await b.snapshot()),
  queue: queueCommand,
  digest: async (b) => formatDigest((await b.snapshot()).digest),
  ai: async (b) => formatAiReadiness((await b.snapshot()).readiness),
  rss: async (b) => queueJob(b, 'fetch-rss-feeds', {}, 'Queued an RSS fetch.'),
  inspect: async (b) => queueJob(b, 'batch-inspect', { limit: 5 }, 'Queued a batch inspection of up to 5 items.'),
  ack: ackCommand,
  resolve: resolveCommand,
  forge: forgeCommand,
  approve: approveCommand,
  reject: rejectCommand,
};

export async function handleFreeform(b, text) {
  const snap = await b.snapshot();
  const context = JSON.stringify(snap).slice(0, 6000);
  const answer = await b.generateText({
    prompt: `Platform status JSON:\n${context}\n\nQuestion: ${text}`,
    systemPrompt: ASSISTANT_SYSTEM_PROMPT,
    purpose: 'general',
  });
  return answer || "I couldn't generate a response.";
}
