/**
 * The alert log's routes: who may read and resend, what an answer carries,
 * and how each refusal from the notifier is put into words.
 */
import { describe, it, expect, vi } from 'vitest';
import { createAlertLogHandlers, ALERTS_READ_ROLE, ALERTS_RESEND_ROLE } from './handlers.js';
import { NOTIFY_LOG_ID } from '../notify.js';

const allow = { requireRole: vi.fn(async () => ({ user: { oid: 'o' } })) };
const deny = {
  requireRole: vi.fn(async () => ({ error: { status: 403, body: '{}' } })),
};
const LOG = {
  id: NOTIFY_LOG_ID,
  entries: [
    {
      id: 'a1-x',
      at: '2026-11-10T00:40:00.000Z',
      source: 'job_failed:x',
      severity: 'warning',
      title: 'Job failed: x',
      message: 'm1',
      extra: 'not answered',
    },
    {
      id: 'b2-y',
      at: '2026-11-10T00:45:00.000Z',
      source: 's',
      severity: 'info',
      title: 'T2',
      message: 'm2',
      resentOf: 'a1-x',
    },
  ],
};
const store = (doc = LOG) => ({ readDoc: vi.fn(async () => doc) });
const post = (body) => ({
  headers: { get: () => null },
  json: async () => body,
});
const parse = (res) => JSON.parse(res.body);

describe('GET cms/alerts/recent', () => {
  it('answers the log newest first, only the known fields, private and uncached', async () => {
    const res = await createAlertLogHandlers({
      guard: allow,
      store: store(),
      notifier: {},
    }).getRecent({}, {});
    expect(res.status).toBe(200);
    expect(res.headers['Cache-Control']).toBe('private, no-store');
    const { alerts } = parse(res);
    expect(alerts.map((a) => a.id)).toEqual(['b2-y', 'a1-x']);
    expect(alerts[1]).toEqual({
      id: 'a1-x',
      at: '2026-11-10T00:40:00.000Z',
      source: 'job_failed:x',
      severity: 'warning',
      title: 'Job failed: x',
      message: 'm1',
      resentOf: null,
    });
    expect(allow.requireRole).toHaveBeenLastCalledWith({}, ALERTS_READ_ROLE);
  });

  it('answers an empty list before any alert was sent, and 500 when the store fails', async () => {
    const empty = await createAlertLogHandlers({
      guard: allow,
      store: store(null),
      notifier: {},
    }).getRecent({}, {});
    expect(parse(empty).alerts).toEqual([]);
    const broken = {
      readDoc: vi.fn(async () => {
        throw new Error('down');
      }),
    };
    const res = await createAlertLogHandlers({
      guard: allow,
      store: broken,
      notifier: {},
    }).getRecent({}, { error: vi.fn() });
    expect(res.status).toBe(500);
    expect(parse(res).error).toBe('Failed to read the alert log');
  });

  it('answers the guard refusal and reads nothing', async () => {
    const s = store();
    const res = await createAlertLogHandlers({
      guard: deny,
      store: s,
      notifier: {},
    }).getRecent({}, {});
    expect(res.status).toBe(403);
    expect(s.readDoc).not.toHaveBeenCalled();
  });
});

describe('POST cms/alerts/resend', () => {
  const resend = (result, body = { id: 'a1-x' }, guard = allow) => {
    const notifier = { resendLogged: vi.fn(async () => result) };
    return {
      notifier,
      run: createAlertLogHandlers({ guard, store: store(), notifier }).resend(post(body), {}),
    };
  };

  it('sends the named alert again at editor', async () => {
    const { notifier, run } = resend({ sent: true });
    const res = await run;
    expect(res.status).toBe(200);
    expect(parse(res)).toEqual({ ok: true, sent: true });
    expect(notifier.resendLogged).toHaveBeenCalledWith('a1-x');
    expect(allow.requireRole).toHaveBeenLastCalledWith(expect.anything(), ALERTS_RESEND_ROLE);
  });

  it('refuses a missing or malformed id without calling the notifier', async () => {
    for (const body of [{}, { id: '' }, { id: 42 }, { id: '../x' }, { id: 'a'.repeat(40) }]) {
      const { notifier, run } = resend({ sent: true }, body);
      const res = await run;
      expect(res.status).toBe(400);
      expect(notifier.resendLogged).not.toHaveBeenCalled();
    }
  });

  it('puts each refusal into words with its own status', async () => {
    const cases = [
      [{ sent: false, reason: 'not_found' }, 404],
      [{ sent: false, reason: 'not_configured' }, 409],
      [{ sent: false, reason: 'telegram_error', status: 403 }, 502],
      [{ sent: false, reason: 'exception' }, 502],
      [{ sent: false, reason: 'something new' }, 502],
    ];
    for (const [result, status] of cases) {
      const res = await resend(result).run;
      expect(res.status).toBe(status);
      expect(parse(res).message).toMatch(/\w/);
    }
    expect(parse(await resend({ sent: false, reason: 'telegram_error', status: 403 }).run).telegramStatus).toBe(403);
  });

  it('answers the guard refusal and sends nothing', async () => {
    const { notifier, run } = resend({ sent: true }, { id: 'a1-x' }, deny);
    expect((await run).status).toBe(403);
    expect(notifier.resendLogged).not.toHaveBeenCalled();
  });
});
