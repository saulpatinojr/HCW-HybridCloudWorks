/**
 * The Telegram webhook's own gate (#817).
 *
 * This is the one anonymous route that can write a job and reach a model, and
 * the check that makes that safe lives in telegram-http.js itself, not in the
 * bot: the `X-Telegram-Bot-Api-Secret-Token` header against
 * sha256(TELEGRAM_BOT_TOKEN). bot.test.js covers `secretMatches`; the route
 * inventory calls this handler once with a bare request. Neither shows that a
 * wrong header stops the request before the bot, the job store or the queue.
 *
 * The bot is a stand-in whose `expectedSecret` is the real derivation, so the
 * header is compared exactly as production compares it, and whose
 * `handleUpdate` is a spy — the question is what reaches it, not what it does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const registrations = new Map();
vi.mock('@azure/functions', () => ({
  output: { storageQueue: (options) => ({ type: 'queue', ...options }) },
}));
vi.mock('../lib/auth/http-route.js', () => ({
  httpRoute: (name, options) => registrations.set(name, options),
}));

const upsertDoc = vi.fn(async (_container, doc) => doc);
vi.mock('../lib/cosmos-client.js', () => ({
  readDoc: vi.fn(),
  upsertDoc: (...args) => upsertDoc(...args),
  patchDoc: vi.fn(),
  queryDocs: vi.fn(),
}));

const handleUpdate = vi.fn(async () => ({ handled: true }));
const built = [];
vi.mock('../lib/telegram/bot.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createSender: () => vi.fn(),
    createTelegramBot: (deps) => {
      built.push(deps);
      return {
        expectedSecret: () => actual.expectedWebhookSecret(process.env),
        handleUpdate: (...args) => handleUpdate(...args),
      };
    },
  };
});

const { expectedWebhookSecret } = await import('../lib/telegram/bot.js');
const { JOBS_CONTAINER, JOBS_QUEUE } = await import('../lib/jobs.js');
await import('./telegram-http.js');

const TOKEN = '123456:telegram-test-token-not-real';
const route = () => registrations.get('telegramWebhook');

const makeContext = () => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  extraOutputs: { set: vi.fn() },
});

const makeRequest = ({ secret, body = { update_id: 1 }, badJson = false } = {}) => ({
  headers: new Headers(secret === undefined ? {} : { 'x-telegram-bot-api-secret-token': secret }),
  json: async () => {
    if (badJson) throw new SyntaxError('Unexpected token');
    return body;
  },
});

let savedToken;
beforeEach(() => {
  savedToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = TOKEN;
  handleUpdate.mockReset().mockResolvedValue({ handled: true });
  upsertDoc.mockClear();
  built.length = 0;
});
afterEach(() => {
  if (savedToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = savedToken;
});

describe('telegramWebhook registration', () => {
  it('is an anonymous POST on telegram/webhook with the jobs queue output', () => {
    expect(route()).toMatchObject({
      methods: ['POST'],
      authLevel: 'anonymous',
      route: 'telegram/webhook',
    });
    expect(route().extraOutputs[0]).toMatchObject({ type: 'queue', queueName: JOBS_QUEUE });
  });
});

describe('the secret-token gate', () => {
  it('answers 404 when no bot token is configured, and calls nothing', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const response = await route().handler(makeRequest({ secret: 'anything' }), makeContext());
    expect(response.status).toBe(404);
    expect(handleUpdate).not.toHaveBeenCalled();
  });

  it('treats an unresolved Key Vault reference as no token, not as a token', async () => {
    process.env.TELEGRAM_BOT_TOKEN = '@Microsoft.KeyVault(SecretUri=https://x/secrets/TELEGRAM-BOT-TOKEN)';
    const response = await route().handler(makeRequest({ secret: 'anything' }), makeContext());
    expect(response.status).toBe(404);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['the raw bot token rather than its digest', TOKEN],
    ['a digest of something else', 'a'.repeat(64)],
  ])('refuses a %s header with 401 before the bot, the store or the queue', async (_label, secret) => {
    const context = makeContext();
    const response = await route().handler(makeRequest({ secret }), context);
    expect(response.status).toBe(401);
    expect(handleUpdate).not.toHaveBeenCalled();
    expect(upsertDoc).not.toHaveBeenCalled();
    expect(context.extraOutputs.set).not.toHaveBeenCalled();
  });

  it('passes a request carrying sha256(TELEGRAM_BOT_TOKEN) to the bot', async () => {
    const update = { update_id: 7, message: { text: '/status' } };
    const response = await route().handler(
      makeRequest({ secret: expectedWebhookSecret(process.env), body: update }),
      makeContext()
    );
    expect(response).toEqual({ status: 200, body: 'ok' });
    expect(handleUpdate).toHaveBeenCalledWith(update);
  });

  it('passes a request carrying an independent TELEGRAM_WEBHOOK_SECRET (SEC-6)', async () => {
    const saved = process.env.TELEGRAM_WEBHOOK_SECRET;
    process.env.TELEGRAM_WEBHOOK_SECRET = 'independent-secret-val-999';
    try {
      const update = { update_id: 8, message: { text: '/help' } };
      const response = await route().handler(
        makeRequest({ secret: 'independent-secret-val-999', body: update }),
        makeContext()
      );
      expect(response).toEqual({ status: 200, body: 'ok' });
      expect(handleUpdate).toHaveBeenCalledWith(update);
    } finally {
      if (saved === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET;
      else process.env.TELEGRAM_WEBHOOK_SECRET = saved;
    }
  });
});

describe('always 200 once the secret is valid, so Telegram never retry-storms', () => {
  it('acknowledges malformed JSON without calling the bot', async () => {
    const response = await route().handler(
      makeRequest({ secret: expectedWebhookSecret(process.env), badJson: true }),
      makeContext()
    );
    expect(response).toEqual({ status: 200, body: 'ok' });
    expect(handleUpdate).not.toHaveBeenCalled();
  });

  it('acknowledges and logs when the bot throws', async () => {
    handleUpdate.mockRejectedValue(new Error('boom'));
    const context = makeContext();
    const response = await route().handler(
      makeRequest({ secret: expectedWebhookSecret(process.env) }),
      context
    );
    expect(response).toEqual({ status: 200, body: 'ok' });
    expect(context.error).toHaveBeenCalledWith(expect.stringContaining('handleUpdate threw'));
  });
});

describe('the enqueue the bot is handed', () => {
  it('writes a queued job as the bot and puts its id on the queue', async () => {
    const context = makeContext();
    await route().handler(makeRequest({ secret: expectedWebhookSecret(process.env) }), context);
    const { enqueueJob } = built.at(-1);

    const jobId = await enqueueJob({ type: 'refresh-pricing', payload: { a: 1 } });

    expect(upsertDoc).toHaveBeenCalledWith(
      JOBS_CONTAINER,
      expect.objectContaining({
        id: jobId,
        type: 'refresh-pricing',
        status: 'queued',
        payload: { a: 1 },
        attempts: 0,
        requestedBy: { oid: null, email: 'telegram-bot@system' },
      })
    );
    expect(context.extraOutputs.set).toHaveBeenCalledWith(
      expect.objectContaining({ queueName: JOBS_QUEUE }),
      { jobId, type: 'refresh-pricing' }
    );
  });
});
