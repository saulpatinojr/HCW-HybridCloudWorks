/**
 * checkCloudflareRateLimit (#1918): the daily read of the API rate limit
 * rule, recorded on the Health card, and said on Telegram only when it
 * crosses the line.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  RATE_LIMIT_SOURCE,
  RULES_PAGE,
  TIMER_NAME,
  WATCH_DOC_ID,
  createRateLimitWatch,
  nextStep,
} from './cloudflare-rate-limit.js';
import { CloudflareError } from '../cloudflare/client.js';
import { presentResult, resultDocId } from '../health/probe-results.js';
import { formatTelegramText } from '../notify.js';

const PROBE_DOC = resultDocId('cloudflare-rate-limit');
const DAY_MS = 24 * 60 * 60 * 1000;
const START = Date.parse('2026-11-27T12:40:00.000Z');

/** An admin_config container in memory, with ETags that move on every write. */
function memStore() {
  const data = new Map();
  let etag = 0;
  const stamp = (doc) => ({ ...doc, _etag: `e${(etag += 1)}` });
  return {
    data,
    readDoc: vi.fn(async (_c, id) => (data.has(id) ? { ...data.get(id) } : null)),
    createDoc: vi.fn(async (_c, doc) => {
      if (data.has(doc.id)) throw Object.assign(new Error('exists'), { code: 409 });
      data.set(doc.id, stamp(doc));
      return data.get(doc.id);
    }),
    replaceDocIfMatch: vi.fn(async (_c, doc) => {
      if (data.get(doc.id)?._etag !== doc._etag) throw Object.assign(new Error('changed'), { code: 412 });
      data.set(doc.id, stamp(doc));
      return data.get(doc.id);
    }),
  };
}

const rule = (extra = {}) => ({ id: 'r1', expression: 'true', action: 'block', ...extra });
const ON = { rules: [rule()] };
const OFF = { rules: [rule({ enabled: false })] };

/** A daily harness: `run(phase)` runs the timer one day after the last run. */
function harness({ store = memStore(), sent = true, connect } = {}) {
  let day = -1;
  const notifier = { notifyTelegram: vi.fn(async () => (sent ? { sent: true } : { sent: false, reason: 'cooldown' })) };
  const log = { warn: vi.fn(), error: vi.fn() };
  const run = (phase) => {
    day += 1;
    const at = new Date(START + day * DAY_MS);
    const client = {
      getPhase: vi.fn(async () => {
        if (phase instanceof Error) throw phase;
        return phase;
      }),
    };
    return createRateLimitWatch({
      store,
      connect: connect ?? (() => ({ client, missing: [] })),
      notifier,
      log,
      now: () => at,
      clock: () => at.getTime(),
    }).run();
  };
  return { store, notifier, log, run };
}

describe('checkCloudflareRateLimit', () => {
  it('records a rule that is on as healthy, checked by the timer, and says nothing', async () => {
    const h = harness();
    expect(await h.run(ON)).toEqual({ state: 'on', status: 'healthy', recorded: true, told: false });
    const doc = h.store.data.get(PROBE_DOC);
    expect(doc).toMatchObject({
      probeId: 'cloudflare-rate-limit',
      kind: 'live',
      status: 'healthy',
      summary: '1 API rate limit rule is on.',
      checkedBy: 'timer',
      recordedBy: TIMER_NAME,
      checkedAt: '2026-11-27T12:40:00.000Z',
    });
    // The Health page is told who checked: the timer, never "an admin".
    expect(presentResult(doc).checkedBy).toBe('timer');
    expect(h.notifier.notifyTelegram).not.toHaveBeenCalled();
  });

  it('says once when the rule goes off, and nothing more while it stays off', async () => {
    const h = harness();
    await h.run(ON);
    expect(await h.run(OFF)).toMatchObject({ state: 'off', status: 'degraded', told: true });
    expect(h.notifier.notifyTelegram).toHaveBeenCalledTimes(1);
    const alert = h.notifier.notifyTelegram.mock.calls[0][0];
    expect(alert).toMatchObject({ source: RATE_LIMIT_SOURCE, severity: 'warning', title: 'Cloudflare API rate limit is off' });
    expect(alert.message).toContain(RULES_PAGE);
    expect(formatTelegramText(alert)).toContain('the daily Cloudflare rate limit check');
    expect(h.store.data.get(WATCH_DOC_ID)).toMatchObject({ alerted: true, state: 'off' });

    expect(await h.run(OFF)).toMatchObject({ state: 'off', told: false });
    expect(await h.run({ rules: [] })).toMatchObject({ state: 'off', told: false });
    expect(h.notifier.notifyTelegram).toHaveBeenCalledTimes(1);
  });

  it('keeps how long the answer has held on the Health card', async () => {
    const h = harness();
    await h.run(ON);
    await h.run(OFF);
    await h.run(OFF);
    expect(h.store.data.get(PROBE_DOC)).toMatchObject({
      status: 'degraded',
      previousStatus: 'healthy',
      statusSince: '2026-11-28T12:40:00.000Z',
      checkedAt: '2026-11-29T12:40:00.000Z',
    });
  });

  it('says once when the rule is on again, then nothing', async () => {
    const h = harness();
    await h.run(OFF);
    expect(h.notifier.notifyTelegram).toHaveBeenCalledTimes(1);
    expect(await h.run(ON)).toMatchObject({ state: 'on', told: true });
    expect(h.notifier.notifyTelegram).toHaveBeenCalledTimes(2);
    expect(h.notifier.notifyTelegram.mock.calls[1][0]).toMatchObject({
      source: RATE_LIMIT_SOURCE,
      severity: 'info',
      title: 'Cloudflare API rate limit is on again',
    });
    expect(h.store.data.get(WATCH_DOC_ID)).toMatchObject({ alerted: false, state: 'on' });
    await h.run(ON);
    expect(h.notifier.notifyTelegram).toHaveBeenCalledTimes(2);
  });

  it('records "not checked" without a message while the token or zone id is not set', async () => {
    const h = harness({ connect: () => ({ client: null, missing: ['token'] }) });
    expect(await h.run(ON)).toEqual({ state: 'not-configured', status: 'unknown', recorded: true, told: false });
    const doc = h.store.data.get(PROBE_DOC);
    expect(doc.status).toBe('unknown');
    expect(doc.summary).toMatch(/^Not checked\. Cloudflare is not set up yet: .*CLOUDFLARE-ADMIN-TOKEN/);
    expect(h.notifier.notifyTelegram).not.toHaveBeenCalled();
    expect(h.store.data.has(WATCH_DOC_ID)).toBe(false);
  });

  it('a failed read has the browser’s status: offline for a 502 or unreachable, critical otherwise; said once', async () => {
    const h = harness();
    // The route answers a token Cloudflare refused with 502, which the browser reads as offline.
    const refused = new CloudflareError('Cloudflare refused the token for this (HTTP 403).', {
      status: 502,
      upstreamStatus: 403,
    });
    expect(await h.run(refused)).toMatchObject({ state: 'failed', status: 'offline', told: true });
    expect(h.store.data.get(PROBE_DOC)).toMatchObject({
      status: 'offline',
      summary: 'The rate limiting rules could not be read: Cloudflare refused the token for this (HTTP 403).',
    });
    expect(h.notifier.notifyTelegram.mock.calls[0][0]).toMatchObject({ severity: 'critical', source: RATE_LIMIT_SOURCE });
    expect(h.log.warn).toHaveBeenCalledWith(
      '[checkCloudflareRateLimit] the rate limiting phase could not be read (CLOUDFLARE_REFUSED)'
    );

    // Still unreadable the next day, by another cause: the same kind, no second message.
    const unreachable = new CloudflareError('Cloudflare could not be reached. Try again shortly.', {
      status: 502,
      code: 'CLOUDFLARE_UNREACHABLE',
    });
    expect(await h.run(unreachable)).toMatchObject({ state: 'failed', status: 'offline', told: false });
    // A refusal the route answers with its own status (429) is critical, as in the browser.
    const limited = new CloudflareError('Cloudflare is limiting requests right now. Wait a minute and try again.', {
      status: 429,
      upstreamStatus: 429,
    });
    expect(await h.run(limited)).toMatchObject({ status: 'critical', told: false });
    // A thrown error that is not ours shows the route's own sentence, never its own text: critical.
    expect(await h.run(new Error('secret-looking text'))).toMatchObject({ status: 'critical', told: false });
    expect(h.store.data.get(PROBE_DOC).summary).toBe('The rate limiting rules could not be read: The Cloudflare request failed.');
    expect(h.notifier.notifyTelegram).toHaveBeenCalledTimes(1);
  });

  it('gives the same status as the browser for every failure shape (classifyFailure)', async () => {
    const cases = [
      [new CloudflareError('Cloudflare could not be reached. Try again shortly.', { status: 502, code: 'CLOUDFLARE_UNREACHABLE' }), 'offline'],
      [new CloudflareError('Cloudflare has no such item.', { status: 404 }), 'critical'],
      [new CloudflareError('Cloudflare refused the change as not valid.', { status: 400 }), 'critical'],
      [Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), 'critical'],
    ];
    for (const [error, status] of cases) {
      expect((await harness().run(error)).status, error.message).toBe(status);
    }
  });

  it('says once more when the alarm changes kind, off to unreadable and back, and nothing while it holds', async () => {
    const h = harness();
    const unreadable = new CloudflareError('Cloudflare could not be reached. Try again shortly.', { status: 502 });
    await h.run(OFF);
    expect(await h.run(unreadable)).toMatchObject({ state: 'failed', told: true });
    expect(h.notifier.notifyTelegram.mock.calls[1][0].title).toBe('Cloudflare API rate limit could not be checked');
    expect(h.store.data.get(WATCH_DOC_ID)).toMatchObject({ alerted: true, state: 'failed' });
    expect(await h.run(unreadable)).toMatchObject({ told: false });
    expect(await h.run(OFF)).toMatchObject({ state: 'off', told: true });
    expect(h.notifier.notifyTelegram.mock.calls[2][0].title).toBe('Cloudflare API rate limit is off');
    expect(await h.run(OFF)).toMatchObject({ told: false });
    expect(await h.run(ON)).toMatchObject({ state: 'on', told: true });
    expect(await h.run(ON)).toMatchObject({ told: false });
    expect(h.notifier.notifyTelegram).toHaveBeenCalledTimes(4);
  });

  it('records nothing about the alert when the message did not go, so the next run tries again', async () => {
    const h = harness({ sent: false });
    expect(await h.run(OFF)).toMatchObject({ told: false });
    expect(h.store.data.has(WATCH_DOC_ID)).toBe(false);
    expect(h.log.warn).toHaveBeenCalledWith('[checkCloudflareRateLimit] message not sent (cooldown); the next run tries again');
    expect(await h.run(OFF)).toMatchObject({ told: false });
    expect(h.notifier.notifyTelegram).toHaveBeenCalledTimes(2);
  });

  it('leaves the alert record to another run that wrote it first (412)', async () => {
    const store = memStore();
    const h = harness({ store });
    await h.run(ON);
    await h.run(OFF);
    // Another writer changes the record between this run's read and its write.
    const original = store.readDoc.getMockImplementation();
    store.readDoc.mockImplementation(async (c, id) => {
      const doc = await original(c, id);
      if (id === WATCH_DOC_ID) store.data.set(id, { ...store.data.get(id), _etag: 'moved' });
      return doc;
    });
    expect(await h.run(ON)).toMatchObject({ state: 'on', told: true });
    expect(store.data.get(WATCH_DOC_ID)).toMatchObject({ alerted: true, _etag: 'moved' });
    expect(h.log.warn).toHaveBeenCalledWith('[checkCloudflareRateLimit] another run recorded the alert first; left as it is');
  });

  it('retries the Health result when another writer got there first (412), and keeps the newest', async () => {
    const store = memStore();
    const h = harness({ store });
    await h.run(ON);
    const replace = store.replaceDocIfMatch.getMockImplementation();
    store.replaceDocIfMatch.mockImplementationOnce(async () => {
      throw Object.assign(new Error('changed'), { code: 412 });
    });
    expect(await h.run(OFF)).toMatchObject({ recorded: true });
    expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(2);
    store.replaceDocIfMatch.mockImplementation(replace);
    expect(store.data.get(PROBE_DOC).status).toBe('degraded');
  });

  it('throws when the Health result cannot be written at all, so the host sees the failure', async () => {
    const store = memStore();
    store.createDoc.mockRejectedValue(Object.assign(new Error('down'), { code: 503 }));
    await expect(harness({ store }).run(ON)).rejects.toThrow('down');
  });
});

describe('nextStep', () => {
  const verdict = (status, state = 'x') => ({ status, state, sentence: 'S.' });
  it('speaks only across the line, or when the alarm changes kind', () => {
    expect(nextStep(verdict('degraded', 'off'), null)?.alerted).toBe(true);
    expect(nextStep(verdict('critical', 'failed'), { alerted: false })?.alerted).toBe(true);
    expect(nextStep(verdict('degraded', 'off'), { alerted: true, state: 'off' })).toBeNull();
    expect(nextStep(verdict('offline', 'failed'), { alerted: true, state: 'failed' })).toBeNull();
    expect(nextStep(verdict('critical', 'failed'), { alerted: true, state: 'failed' })).toBeNull();
    expect(nextStep(verdict('offline', 'failed'), { alerted: true, state: 'off' })?.alert.title).toBe(
      'Cloudflare API rate limit could not be checked'
    );
    expect(nextStep(verdict('degraded', 'off'), { alerted: true, state: 'failed' })?.alert.title).toBe(
      'Cloudflare API rate limit is off'
    );
    expect(nextStep(verdict('healthy'), { alerted: true })?.alerted).toBe(false);
    expect(nextStep(verdict('healthy'), null)).toBeNull();
    expect(nextStep(verdict('unknown'), { alerted: true })).toBeNull();
    expect(nextStep(verdict('unknown'), null)).toBeNull();
  });
});
