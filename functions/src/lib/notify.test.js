/**
 * The notifier's cooldown is claimed before the send, conditionally on the
 * document's ETag, so two callers racing on one source produce one message
 * and no source's stamp is ever overwritten by another's (review of #920).
 * Telegram's status travels in the result for the Test Telegram route.
 */
import { describe, it, expect, vi } from 'vitest';
import { COOLDOWN_MS, NOTIFY_LOG_ID, NOTIFY_LOG_MAX, NOTIFY_STATE_ID, RESEND_MIN_GAP_MS, createNotifier, readAlertLog } from './notify.js';

const NOW = new Date('2026-10-07T01:30:00.000Z');
const now = () => NOW;
const env = { TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '1' };

/**
 * A store over the `system` container's documents by id, with ETags and a 412
 * on a stale conditional write. Starts with the cooldown document (or none);
 * the alert log (`notify_log`) is created by the first send that succeeds.
 * `current` is the cooldown document; `calls(id)` the patches to one document.
 */
function stateStore(doc) {
  const docs = new Map();
  let version = 1;
  if (doc) docs.set(NOTIFY_STATE_ID, { _etag: '"e1"', ...doc });
  const store = {
    readDoc: vi.fn(async (_c, id) => docs.get(id) ?? null),
    upsertDoc: vi.fn(async (_c, d) => {
      version += 1;
      const next = { ...d, _etag: `"e${version}"` };
      docs.set(d.id, next);
      return next;
    }),
    createDoc: vi.fn(async (_c, d) => {
      if (docs.has(d.id)) throw Object.assign(new Error('409'), { code: 409 });
      version += 1;
      const next = { ...d, _etag: `"e${version}"` };
      docs.set(d.id, next);
      return next;
    }),
    patchDoc: vi.fn(async (_c, id, updates, options = {}) => {
      const current = docs.get(id) ?? null;
      if (options.ifMatch && current && options.ifMatch !== current._etag) {
        throw Object.assign(new Error('412'), { code: 412 });
      }
      version += 1;
      const next = { ...(current || { id }), ...updates, _etag: `"e${version}"` };
      for (const [k, v] of Object.entries(updates)) if (v === undefined) delete next[k];
      docs.set(id, next);
      return next;
    }),
    get current() {
      return docs.get(NOTIFY_STATE_ID) ?? null;
    },
    log: () => docs.get(NOTIFY_LOG_ID) ?? null,
    calls: (id) => store.patchDoc.mock.calls.filter((call) => call[1] === id),
    upserts: (id) => store.upsertDoc.mock.calls.filter((call) => call[1]?.id === id),
  };
  return store;
}

const ok = () => vi.fn(async () => ({ ok: true }));

describe('claiming the cooldown', () => {
  it('claims with the ETag it read before sending, and the stamp is the claim', async () => {
    const store = stateStore({ id: NOTIFY_STATE_ID });
    const fetch = ok();
    const result = await createNotifier({ store, env, fetch, now }).notifyTelegram({ title: 't', message: 'm', source: 'checkLiveLinks' });
    expect(result).toEqual({ sent: true });
    expect(store.calls(NOTIFY_STATE_ID)).toHaveLength(1);
    const [container, id, updates, options] = store.calls(NOTIFY_STATE_ID)[0];
    expect([container, id]).toEqual(['system', NOTIFY_STATE_ID]);
    expect(updates).toEqual({ checkLiveLinks: { lastNotifiedAt: NOW.toISOString() } });
    expect(options).toEqual({ partitionKey: NOTIFY_STATE_ID, ifMatch: '"e1"' });
    // The claim comes first: fetch runs after the patch.
    expect(store.patchDoc.mock.invocationCallOrder[0]).toBeLessThan(fetch.mock.invocationCallOrder[0]);
    // Nothing writes the whole cooldown document any more.
    expect(store.upserts(NOTIFY_STATE_ID)).toHaveLength(0);
  });

  it('is told cooldown, and sends nothing, when another writer claimed first (412)', async () => {
    const store = stateStore({ id: NOTIFY_STATE_ID });
    const fetch = ok();
    const n = createNotifier({ store, env, fetch, now });
    // Someone else wrote the document between our read and our claim.
    store.readDoc.mockImplementationOnce(async () => ({ id: NOTIFY_STATE_ID, _etag: '"stale"' }));
    expect(await n.notifyTelegram({ title: 't', message: 'm', source: 'a' })).toEqual({ sent: false, reason: 'cooldown' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('honours an existing stamp inside the window without touching the store', async () => {
    const store = stateStore({
      id: NOTIFY_STATE_ID,
      a: { lastNotifiedAt: new Date(NOW.getTime() - COOLDOWN_MS + 1000).toISOString() },
    });
    const fetch = ok();
    expect(await createNotifier({ store, env, fetch, now }).notifyTelegram({ title: 't', message: 'm', source: 'a' })).toEqual({
      sent: false,
      reason: 'cooldown',
    });
    expect(store.patchDoc).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("touches only its own source's field, so a concurrent source's stamp survives", async () => {
    const store = stateStore({ id: NOTIFY_STATE_ID, other: { lastNotifiedAt: '2026-10-07T01:00:00.000Z' } });
    await createNotifier({ store, env, fetch: ok(), now }).notifyTelegram({ title: 't', message: 'm', source: 'mine' });
    expect(store.current.other).toEqual({ lastNotifiedAt: '2026-10-07T01:00:00.000Z' });
    expect(store.current.mine).toEqual({ lastNotifiedAt: NOW.toISOString() });
  });

  it('creates the document on first use and then claims against its ETag', async () => {
    const store = stateStore(null);
    const result = await createNotifier({ store, env, fetch: ok(), now }).notifyTelegram({ title: 't', message: 'm', source: 'a' });
    expect(result).toEqual({ sent: true });
    expect(store.upsertDoc).toHaveBeenCalledWith('system', { id: NOTIFY_STATE_ID });
    expect(store.calls(NOTIFY_STATE_ID)[0][3].ifMatch).toBe('"e2"');
  });
});

describe('when Telegram does not take it', () => {
  it('returns the status and puts the previous stamp back, so a refusal does not silence the source', async () => {
    const before = { lastNotifiedAt: '2026-10-06T20:00:00.000Z' };
    const store = stateStore({ id: NOTIFY_STATE_ID, a: before });
    const fetch = vi.fn(async () => ({ ok: false, status: 403 }));
    const log = { error: vi.fn(), log: vi.fn(), warn: vi.fn() };
    const result = await createNotifier({ store, env, fetch, now, log }).notifyTelegram({ title: 't', message: 'm', source: 'a' });
    expect(result).toEqual({ sent: false, reason: 'telegram_error', status: 403 });
    expect(store.calls(NOTIFY_STATE_ID)).toHaveLength(2);
    expect(store.calls(NOTIFY_STATE_ID)[1][2]).toEqual({ a: before });
    expect(store.current.a).toEqual(before);
    expect(log.error.mock.calls[0][0]).toBe('[notify] Telegram API error 403');
  });

  it('removes the stamp again when the source had never been said and the send threw', async () => {
    const store = stateStore({ id: NOTIFY_STATE_ID });
    const fetch = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    const result = await createNotifier({ store, env, fetch, now, log: {} }).notifyTelegram({ title: 't', message: 'm', source: 'a' });
    expect(result).toEqual({ sent: false, reason: 'exception' });
    expect(store.calls(NOTIFY_STATE_ID)[1][2]).toEqual({ a: undefined });
    expect(store.current).not.toHaveProperty('a');
  });

  it('stays quiet when unconfigured, before any store call', async () => {
    const store = stateStore({ id: NOTIFY_STATE_ID });
    expect(await createNotifier({ store, env: {}, fetch: ok(), now }).notifyTelegram({ title: 't', message: 'm' })).toEqual({
      sent: false,
      reason: 'not_configured',
    });
    expect(store.readDoc).not.toHaveBeenCalled();
  });

  it('logs the source prefix only, never a dynamic suffix', async () => {
    const store = stateStore({
      id: NOTIFY_STATE_ID,
      'reminder:secret-id': { lastNotifiedAt: NOW.toISOString() },
    });
    const log = { log: vi.fn() };
    await createNotifier({ store, env, fetch: ok(), now, log }).notifyTelegram({ title: 't', message: 'm', source: 'reminder:secret-id' });
    expect(log.log.mock.calls[0][0]).toContain('source="reminder"');
    expect(log.log.mock.calls[0][0]).not.toContain('secret-id');
  });
});

describe('the alert log', () => {
  const send = (n, i) => n.notifyTelegram({ title: `t${i}`, message: `m${i}`, severity: 'warning', source: `s${i}` });

  it('keeps each alert Telegram accepted, with its words, newest first when read', async () => {
    const store = stateStore({ id: NOTIFY_STATE_ID });
    const n = createNotifier({ store, env, fetch: ok(), now });
    await send(n, 1);
    await send(n, 2);
    const entries = await readAlertLog(store);
    expect(entries.map((e) => [e.title, e.message, e.source, e.severity, e.at])).toEqual([
      ['t2', 'm2', 's2', 'warning', NOW.toISOString()],
      ['t1', 'm1', 's1', 'warning', NOW.toISOString()],
    ]);
    expect(new Set(entries.map((e) => e.id)).size).toBe(2);
  });

  it('keeps nothing for an alert that was not sent (cooldown, refused, not configured)', async () => {
    const store = stateStore({ id: NOTIFY_STATE_ID, s1: { lastNotifiedAt: NOW.toISOString() } });
    const refused = vi.fn(async () => ({ ok: false, status: 403 }));
    await createNotifier({ store, env, fetch: ok(), now }).notifyTelegram({ title: 't', message: 'm', source: 's1' });
    await createNotifier({ store, env, fetch: refused, now }).notifyTelegram({ title: 't', message: 'm', source: 's2' });
    await createNotifier({ store, env: {}, fetch: ok(), now }).notifyTelegram({ title: 't', message: 'm', source: 's3' });
    expect(store.log()).toBeNull();
  });

  it('keeps only the newest NOTIFY_LOG_MAX', async () => {
    const store = stateStore({ id: NOTIFY_STATE_ID });
    const n = createNotifier({ store, env, fetch: ok(), now });
    for (let i = 0; i < NOTIFY_LOG_MAX + 3; i += 1) await send(n, i);
    const entries = await readAlertLog(store);
    expect(entries).toHaveLength(NOTIFY_LOG_MAX);
    expect(entries[0].title).toBe(`t${NOTIFY_LOG_MAX + 2}`);
    expect(entries.at(-1).title).toBe('t3');
  });

  it('retries the log write on a 412, and a log that cannot be written never fails the send', async () => {
    const store = stateStore({ id: NOTIFY_STATE_ID });
    const n = createNotifier({ store, env, fetch: ok(), now });
    await send(n, 1);
    // The next read of the log hands back a stale ETag once, as if another
    // alert had been logged between this one's read and its write.
    const real = store.readDoc.getMockImplementation();
    let staleOnce = true;
    store.readDoc.mockImplementation(async (c, id) => {
      const doc = await real(c, id);
      if (id !== NOTIFY_LOG_ID || !staleOnce) return doc;
      staleOnce = false;
      return { ...doc, _etag: '"stale"' };
    });
    await send(n, 2);
    expect(staleOnce).toBe(false);
    expect((await readAlertLog(store)).map((e) => e.title)).toEqual(['t2', 't1']);

    const broken = stateStore({ id: NOTIFY_STATE_ID });
    broken.createDoc.mockRejectedValue(Object.assign(new Error('down'), { code: 503 }));
    expect(await send(createNotifier({ store: broken, env, fetch: ok(), now }), 1)).toEqual({ sent: true });
  });

  it('sends a logged alert again, without the cooldown, marked as a repeat, and logs the repeat', async () => {
    const store = stateStore({ id: NOTIFY_STATE_ID });
    const fetch = ok();
    const n = createNotifier({ store, env, fetch, now });
    await send(n, 1);
    const [first] = await readAlertLog(store);
    // Inside the source's cooldown: a resend is a person asking, once.
    expect(await n.resendLogged(first.id)).toEqual({ sent: true });
    const body = JSON.parse(fetch.mock.calls[1][1].body);
    expect(body.text).toContain('Sent again: t1');
    expect(body.text).toContain('m1');
    expect(body.text).toContain(`First sent ${first.at}`);
    const [repeat] = await readAlertLog(store);
    expect(repeat.resentOf).toBe(first.id);
    expect(repeat.title).toBe('Sent again: t1');
  });

  it('says not_found for an id that is not in the log, and not_configured without the bot', async () => {
    const store = stateStore({ id: NOTIFY_STATE_ID });
    const fetch = ok();
    expect(await createNotifier({ store, env, fetch, now }).resendLogged('nope')).toEqual({ sent: false, reason: 'not_found' });
    expect(await createNotifier({ store, env: {}, fetch, now }).resendLogged('nope')).toEqual({ sent: false, reason: 'not_configured' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('the alert log under a race, and resends', () => {
  const send = (n, i) => n.notifyTelegram({ title: `t${i}`, message: `m${i}`, severity: 'warning', source: `s${i}` });
  const at = (iso) => () => new Date(iso);

  it('creates the log with a create-only write, so a first alert racing another first alert keeps both', async () => {
    const store = stateStore({ id: NOTIFY_STATE_ID });
    const n = createNotifier({ store, env, fetch: ok(), now });
    // This alert reads "no log yet"; another writer creates the log with its
    // own first alert before this one's create lands.
    const real = store.readDoc.getMockImplementation();
    let raced = false;
    store.readDoc.mockImplementation(async (c, id) => {
      const doc = await real(c, id);
      if (id === NOTIFY_LOG_ID && !raced) {
        raced = true;
        await store.createDoc('system', { id: NOTIFY_LOG_ID, entries: [{ id: 'other-1', title: 'other', message: '', at: NOW.toISOString() }] });
        return null;
      }
      return doc;
    });
    await send(n, 1);
    expect((await readAlertLog(store)).map((e) => e.title)).toEqual(['t1', 'other']);
    expect(store.upserts(NOTIFY_LOG_ID)).toHaveLength(0);
  });

  it('reads again rather than write unconditionally when a read carries no ETag', async () => {
    const store = stateStore({ id: NOTIFY_STATE_ID });
    const n = createNotifier({ store, env, fetch: ok(), now });
    await send(n, 1);
    const real = store.readDoc.getMockImplementation();
    let once = true;
    store.readDoc.mockImplementation(async (c, id) => {
      const doc = await real(c, id);
      if (id !== NOTIFY_LOG_ID || !once) return doc;
      once = false;
      const { _etag, ...rest } = doc;
      return rest;
    });
    await send(n, 2);
    expect(store.calls(NOTIFY_LOG_ID).every((call) => call[3]?.ifMatch)).toBe(true);
    expect((await readAlertLog(store)).map((e) => e.title)).toEqual(['t2', 't1']);
  });

  it('sends the same alert again at most once a minute', async () => {
    const store = stateStore({ id: NOTIFY_STATE_ID });
    const fetch = ok();
    await send(createNotifier({ store, env, fetch, now }), 1);
    const [first] = await readAlertLog(store);
    const t0 = '2026-10-07T02:00:00.000Z';
    expect(await createNotifier({ store, env, fetch, now: at(t0) }).resendLogged(first.id)).toEqual({ sent: true });
    expect(await createNotifier({ store, env, fetch, now: at('2026-10-07T02:00:30.000Z') }).resendLogged(first.id)).toEqual({
      sent: false,
      reason: 'too_soon',
    });
    const later = new Date(Date.parse(t0) + RESEND_MIN_GAP_MS + 1000).toISOString();
    expect(await createNotifier({ store, env, fetch, now: at(later) }).resendLogged(first.id)).toEqual({ sent: true });
  });

  it('repeats the first alert when a repeat is sent again, not "Sent again: Sent again:"', async () => {
    const store = stateStore({ id: NOTIFY_STATE_ID });
    const fetch = ok();
    await send(createNotifier({ store, env, fetch, now }), 1);
    const [first] = await readAlertLog(store);
    await createNotifier({ store, env, fetch, now: at('2026-10-07T02:00:00.000Z') }).resendLogged(first.id);
    const [repeat] = await readAlertLog(store);
    expect(await createNotifier({ store, env, fetch, now: at('2026-10-07T03:00:00.000Z') }).resendLogged(repeat.id)).toEqual({ sent: true });
    const text = JSON.parse(fetch.mock.calls.at(-1)[1].body).text;
    expect(text).toContain('Sent again: t1');
    expect(text).not.toContain('Sent again: Sent again:');
    expect(text).toContain(`First sent ${first.at}`);
    expect(text.match(/First sent/g)).toHaveLength(1);
    expect((await readAlertLog(store))[0].resentOf).toBe(first.id);
  });

  it('cuts a long alert so the repeat still fits Telegram\'s 4,096 characters, keeping the marker', async () => {
    const store = stateStore({ id: NOTIFY_STATE_ID });
    const fetch = ok();
    const long = 'x'.repeat(4080);
    await createNotifier({ store, env, fetch, now }).notifyTelegram({ title: 'Long', message: long, source: 'big' });
    const [first] = await readAlertLog(store);
    await createNotifier({ store, env, fetch, now: at('2026-10-07T02:00:00.000Z') }).resendLogged(first.id);
    const text = JSON.parse(fetch.mock.calls.at(-1)[1].body).text;
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toContain(`(First sent ${first.at}.)`);
    expect(text).toContain('…');
  });

  it('lets only one of two presses at the same moment through (the repeat\'s log entry is the claim)', async () => {
    const store = stateStore({ id: NOTIFY_STATE_ID });
    const fetch = ok();
    await send(createNotifier({ store, env, fetch, now }), 1);
    const [first] = await readAlertLog(store);
    const n = createNotifier({ store, env, fetch, now: at('2026-10-07T02:00:00.000Z') });
    const results = await Promise.all([n.resendLogged(first.id), n.resendLogged(first.id)]);
    expect(results.filter((r) => r.sent)).toHaveLength(1);
    expect(results.filter((r) => r.reason === 'too_soon')).toHaveLength(1);
    // The first send, and one repeat.
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await readAlertLog(store)).filter((e) => e.resentOf === first.id)).toHaveLength(1);
  });

  it('takes a refused resend\'s entry back out, so the next press is not told to wait', async () => {
    const store = stateStore({ id: NOTIFY_STATE_ID });
    await send(createNotifier({ store, env, fetch: ok(), now }), 1);
    const [first] = await readAlertLog(store);
    const refused = vi.fn(async () => ({ ok: false, status: 403 }));
    const t = at('2026-10-07T02:00:00.000Z');
    expect(await createNotifier({ store, env, fetch: refused, now: t }).resendLogged(first.id)).toEqual({
      sent: false,
      reason: 'telegram_error',
      status: 403,
    });
    expect((await readAlertLog(store)).some((e) => e.resentOf)).toBe(false);
    expect(await createNotifier({ store, env, fetch: ok(), now: t }).resendLogged(first.id)).toEqual({ sent: true });
  });

  it('keeps the first-sent time when a repeat is sent again after its first alert left the log', async () => {
    const store = stateStore({ id: NOTIFY_STATE_ID });
    store.upsertDoc('system', {
      id: NOTIFY_LOG_ID,
      entries: [
        {
          id: 'r1-a',
          at: '2026-10-07T01:00:00.000Z',
          source: 's',
          severity: 'warning',
          title: 'Sent again: Lost',
          message: 'body\n\n(First sent 2026-10-01T00:00:00.000Z.)',
          resentOf: 'gone-1',
        },
      ],
    });
    const fetch = ok();
    expect(await createNotifier({ store, env, fetch, now }).resendLogged('r1-a')).toEqual({ sent: true });
    const text = JSON.parse(fetch.mock.calls.at(-1)[1].body).text;
    expect(text).toContain('Sent again: Lost');
    expect(text).not.toContain('Sent again: Sent again:');
    expect(text.match(/First sent 2026-10-01T00:00:00\.000Z/g)).toHaveLength(1);
  });
});

