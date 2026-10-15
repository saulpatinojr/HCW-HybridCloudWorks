/**
 * telegram-http.js — the inbound Telegram webhook (T-512).
 *
 * Logic is lib/telegram/bot.js; this file is registration, the secret-token
 * gate, and wiring the dependencies.
 *
 * THIS ROUTE IS ANONYMOUS AND THAT IS NOT AN OVERSIGHT. Telegram cannot send a
 * bearer token, so `requireRole` has nothing to check. It is guarded instead by
 * the `X-Telegram-Bot-Api-Secret-Token` header, which Telegram echoes back from
 * whatever was registered with `setWebhook`, compared in constant time against
 * sha256(TELEGRAM_BOT_TOKEN). It is listed in route-inventory.test.js's
 * PUBLIC_ROUTES for that reason, with this comment as the justification.
 *
 * A second, independent check lives in the bot: the sending chat id must match
 * TELEGRAM_CHAT_ID. The secret proves the request came from Telegram; it does
 * not prove it came from the owner, because anyone who finds the bot can
 * message it.
 *
 * ALWAYS 200 ONCE THE SECRET IS VALID. Telegram retries non-2xx responses, so a
 * 500 on a bad command turns one broken message into a retry storm that
 * re-runs the command every few seconds. Failures are reported into the chat
 * and logged, not signalled through the status code.
 */
import { output } from '@azure/functions';
import { httpRoute } from '../lib/auth/http-route.js';
import { readDoc, upsertDoc, patchDoc, queryDocs } from '../lib/cosmos-client.js';
import { JOBS_CONTAINER, JOBS_QUEUE, newJobDoc } from '../lib/jobs.js';
import { createTelegramBot, createSender, secretMatches } from '../lib/telegram/bot.js';

const queueOutput = output.storageQueue({
  queueName: JOBS_QUEUE,
  connection: 'AzureWebJobsStorage',
});

const store = { readDoc, upsertDoc, patchDoc, queryDocs };

/** ops-health's snapshot, built without a guard — this caller is not a user. */
async function snapshot() {
  const { createOpsHealthHandlers } = await import('../lib/ops-health.js');
  return createOpsHealthHandlers({ guard: null, store }).buildSnapshot();
}

/**
 * Write the job document and put its id on the queue, the same two steps
 * `enqueueJob` performs — without the HTTP shape or the role guard, neither of
 * which applies to a chat message that has already been authorized twice.
 * The document is built by newJobDoc, so the type's payload bound holds
 * here as at every other door (#942 follow-up).
 */
function makeEnqueue(context) {
  return async function enqueueJob({ type, payload }) {
    const jobId = crypto.randomUUID();
    await store.upsertDoc(
      JOBS_CONTAINER,
      newJobDoc({
        id: jobId,
        type,
        payload: payload ?? null,
        requestedBy: { oid: null, email: 'telegram-bot@system' },
        createdAt: new Date().toISOString(),
      })
    );
    context.extraOutputs.set(queueOutput, { jobId, type });
    return jobId;
  };
}

httpRoute('telegramWebhook', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'telegram/webhook',
  extraOutputs: [queueOutput],
  handler: async (request, context) => {
    const bot = createTelegramBot({
      store,
      snapshot,
      enqueueJob: makeEnqueue(context),
      generateText: async (args) => {
        const { generateTextResponse } = await import('../lib/ai/router.js');
        // The bot keeps answering its commands when this is switched off in
        // the portal; only the free-form model replies stop.
        return generateTextResponse({ ...args, feature: 'telegram' });
      },
      send: createSender({ log: context }),
      log: context,
    });

    const expected = bot.expectedSecret();
    if (!expected) {
      // No bot token configured. 404 rather than 500: an endpoint that cannot
      // be authenticated should not advertise that it exists.
      context.warn?.('[telegram] TELEGRAM_BOT_TOKEN is not configured; refusing.');
      return { status: 404, body: 'not found' };
    }

    const provided = request.headers.get('x-telegram-bot-api-secret-token') || '';
    if (!secretMatches(provided, expected)) {
      context.warn?.('[telegram] rejected an update with an invalid secret token.');
      return { status: 401, body: 'unauthorized' };
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return { status: 200, body: 'ok' }; // malformed: ack, do not retry-storm
    }

    // Belt and braces for the invariant in this file's header (T-730).
    // handleUpdate's own JSDoc promises it never throws, and it now catches
    // its send as well — but the promise is what the retry-storm behaviour
    // depends on, so the route enforces it rather than trusting it. Anything
    // escaping here is logged and acknowledged: Telegram retries a non-2xx,
    // and a retry re-runs the command that just failed.
    try {
      const result = await bot.handleUpdate(update);
      context.log(`[telegram] ${result.handled ? 'handled' : `ignored (${result.reason})`}`);
    } catch (error) {
      context.error?.(`[telegram] handleUpdate threw: ${error?.stack || error}`);
    }
    return { status: 200, body: 'ok' };
  },
});
