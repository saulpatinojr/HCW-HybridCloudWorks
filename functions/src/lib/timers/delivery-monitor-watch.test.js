/**
 * The delivery monitor watch: Telegram says so when "Monitor delivery health"
 * goes red, once, and says so again when it is green.
 *
 * The GitHub answers here are shaped like the real runs and jobs endpoints
 * (workflow_runs[].id / conclusion / run_number / updated_at; jobs[].name /
 * conclusion). Nothing reaches the network: fetch is a fake, and every URL it
 * is asked for is recorded.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  DELIVERY_GREEN_SOURCE,
  DELIVERY_RED_SOURCE,
  REMINDER_AFTER_MS,
  WATCH_INTERVAL_MS,
  WATCHED_WORKFLOW,
  createDeliveryMonitorWatch,
  greenMessage,
  latestVerdictRun,
  redMessage,
} from './delivery-monitor-watch.js';
import { createAgentHealthCheck } from './agent-health.js';
import { formatTelegramText } from '../notify.js';

const NOW = new Date('2026-10-23T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

const run = (id, conclusion, extra = {}) => ({
  id,
  conclusion,
  run_number: id - 1000,
  updated_at: '2026-10-23T08:34:12Z',
  ...extra,
});

/** A fake fetch answering the two endpoints the watch uses. */
function github({ runs = [], jobs = [], runsStatus = 200, jobsStatus = 200 } = {}) {
  const urls = [];
  const fetch = vi.fn(async (url) => {
    urls.push(String(url));
    const isJobs = /\/actions\/runs\/\d+\/jobs/.test(String(url));
    const status = isJobs ? jobsStatus : runsStatus;
    const body = isJobs ? { jobs } : { workflow_runs: runs };
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { fetch, urls };
}

/** An in-memory admin_config with the three calls the watch makes. */
function memoryStore(initial = null) {
  let doc = initial ? { ...initial, _etag: 'e1' } : null;
  return {
    get doc() {
      return doc;
    },
    readDoc: vi.fn(async () => doc),
    createDoc: vi.fn(async (_c, next) => {
      doc = { ...next, _etag: 'e1' };
    }),
    replaceDocIfMatch: vi.fn(async (_c, next) => {
      doc = { ...next, _etag: `${next._etag}x` };
    }),
  };
}

const notifier = (result = { sent: true }) => ({ notifyTelegram: vi.fn(async () => result) });

const watch = ({ store, gh, n = notifier(), now = NOW, log = {} }) =>
  createDeliveryMonitorWatch({ store, notifier: n, fetch: gh.fetch, now: () => now, log });

describe('latestVerdictRun', () => {
  it('takes the newest run that reached a verdict, skipping cancelled and skipped ones', () => {
    const rows = [run(1005, 'cancelled'), run(1004, 'skipped'), run(1003, 'failure'), run(1002, 'success')];
    expect(latestVerdictRun(rows)).toMatchObject({ id: 1003, conclusion: 'failure' });
  });

  it('counts a timed-out run as a failure', () => {
    expect(latestVerdictRun([run(1001, 'timed_out')])).toMatchObject({ conclusion: 'timed_out' });
  });

  it.each([[[]], [null], [undefined], [[run(1001, 'cancelled')]]])('returns null for %j', (rows) => {
    expect(latestVerdictRun(rows)).toBeNull();
  });

  it('ignores a row whose id could not be spliced into a URL', () => {
    const rows = [run('../../x', 'failure'), run(-1, 'failure'), run(1.5, 'failure'), run(1001, 'success')];
    expect(latestVerdictRun(rows)).toMatchObject({ id: 1001 });
  });
});

describe('the messages', () => {
  const r = { id: 39925541560, number: 234, conclusion: 'failure', completedAt: '2026-10-23T08:34:12.000Z' };

  it('title the red one "DELIVERY MONITOR RED", which no other message uses', () => {
    const m = redMessage({ run: r, jobs: ['Is production behind main?'] });
    expect(m.title).toBe('DELIVERY MONITOR RED');
    expect(m.severity).toBe('critical');
    expect(m.source).toBe(DELIVERY_RED_SOURCE);
    expect(m.message).toContain('Failed: Is production behind main?.');
    expect(m.message).toContain('https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/runs/39925541560');
    expect(m.message).toContain('Run #234 finished 2026-10-23T08:34:12.000Z');
  });

  it('say so when GitHub did not name the failed job', () => {
    expect(redMessage({ run: r }).message).toContain('did not say which job failed');
  });

  it('mark a reminder and say how long it has been red', () => {
    const m = redMessage({ run: r, reminder: true, redForHours: 24 });
    expect(m.title).toBe('DELIVERY MONITOR STILL RED');
    expect(m.message).toContain('STILL RED, 24 hours after the first alert');
  });

  it('render through the notifier with their own source name', () => {
    const text = formatTelegramText(redMessage({ run: r }));
    expect(text).toMatch(/^\u{1F534} DELIVERY MONITOR RED/u);
    expect(text).toContain('Reported by the delivery monitor watch.');
    expect(formatTelegramText(greenMessage({ run: r }))).toContain('Reported by the delivery monitor watch.');
  });
});

describe('checkIfDue', () => {
  it('reads the watched workflow on main, completed runs only, through the pinned API', async () => {
    const gh = github({ runs: [run(1002, 'success')] });
    await watch({ store: memoryStore(), gh }).checkIfDue();
    const url = new URL(gh.urls[0]);
    expect(url.origin).toBe('https://api.github.com');
    expect(url.pathname).toBe(`/repos/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/${WATCHED_WORKFLOW}/runs`);
    expect(url.searchParams.get('branch')).toBe('main');
    expect(url.searchParams.get('status')).toBe('completed');
  });

  it('sends no credential: the repository is public', async () => {
    const gh = github({ runs: [run(1002, 'success')] });
    await watch({ store: memoryStore(), gh }).checkIfDue();
    const init = gh.fetch.mock.calls[0][1];
    expect(JSON.stringify(init.headers).toLowerCase()).not.toContain('authorization');
  });

  it('tells the owner once when the newest verdict is red, naming the failed job', async () => {
    const store = memoryStore();
    const n = notifier();
    const gh = github({
      runs: [run(1234, 'failure')],
      jobs: [
        { name: 'Is production behind main?', conclusion: 'failure' },
        { name: 'Can every workflow still succeed?', conclusion: 'success' },
      ],
    });
    const outcome = await watch({ store, gh, n }).checkIfDue();
    expect(outcome).toMatchObject({ checked: true, verdict: 'red', told: true, written: true });
    expect(n.notifyTelegram).toHaveBeenCalledTimes(1);
    const message = n.notifyTelegram.mock.calls[0][0];
    expect(message.title).toBe('DELIVERY MONITOR RED');
    expect(message.message).toContain('Failed: Is production behind main?.');
    expect(message.message).not.toContain('Can every workflow');
    expect(store.doc).toMatchObject({ alertedRunId: 1234, lastVerdict: 'red', lastError: null });
  });

  it('does not repeat itself on the next hour while the same red stretch goes on', async () => {
    const store = memoryStore();
    const n = notifier();
    const gh = github({ runs: [run(1234, 'failure')] });
    await watch({ store, gh, n }).checkIfDue();
    const later = new Date(NOW.getTime() + WATCH_INTERVAL_MS + 1000);
    const again = await watch({ store, gh, n, now: later }).checkIfDue();
    expect(again).toMatchObject({ verdict: 'red', told: false });
    expect(n.notifyTelegram).toHaveBeenCalledTimes(1);
  });

  it('does not repeat itself when a newer red run replaces the one it told about', async () => {
    const store = memoryStore();
    const n = notifier();
    await watch({ store, gh: github({ runs: [run(1234, 'failure')] }), n }).checkIfDue();
    const later = new Date(NOW.getTime() + 4 * 60 * 60_000);
    await watch({ store, gh: github({ runs: [run(1240, 'failure'), run(1234, 'failure')] }), n, now: later }).checkIfDue();
    expect(n.notifyTelegram).toHaveBeenCalledTimes(1);
  });

  it('reminds the owner once it has been red for a day', async () => {
    const store = memoryStore();
    const n = notifier();
    const gh = github({ runs: [run(1234, 'failure')] });
    await watch({ store, gh, n }).checkIfDue();
    const dayLater = new Date(NOW.getTime() + REMINDER_AFTER_MS + 1000);
    const outcome = await watch({ store, gh, n, now: dayLater }).checkIfDue();
    expect(outcome.told).toBe(true);
    expect(n.notifyTelegram).toHaveBeenCalledTimes(2);
    expect(n.notifyTelegram.mock.calls[1][0].title).toBe('DELIVERY MONITOR STILL RED');
    expect(n.notifyTelegram.mock.calls[1][0].message).toContain('24 hours after the first alert');
  });

  it('says it is green again, once, after the owner was told, and clears the record', async () => {
    const store = memoryStore({ id: 'delivery_monitor_watch', alertedRunId: 1234, alertedAt: iso(NOW - 3_600_000) });
    const n = notifier();
    const gh = github({ runs: [run(1300, 'success')] });
    const outcome = await watch({ store, gh, n }).checkIfDue();
    expect(outcome).toMatchObject({ verdict: 'green', told: true });
    expect(n.notifyTelegram.mock.calls[0][0]).toMatchObject({
      title: 'DELIVERY MONITOR back to green',
      source: DELIVERY_GREEN_SOURCE,
      severity: 'info',
    });
    expect(store.doc).toMatchObject({ alertedRunId: null, alertedAt: null, lastVerdict: 'green' });
  });

  it('says nothing when it was green and still is', async () => {
    const n = notifier();
    const outcome = await watch({ store: memoryStore(), gh: github({ runs: [run(1300, 'success')] }), n }).checkIfDue();
    expect(outcome).toMatchObject({ verdict: 'green', told: false });
    expect(n.notifyTelegram).not.toHaveBeenCalled();
  });

  it('leaves the alert state alone when the newest runs were all cancelled', async () => {
    const store = memoryStore({ id: 'delivery_monitor_watch', alertedRunId: 1234, alertedAt: iso(NOW - 3_600_000) });
    const n = notifier();
    const outcome = await watch({ store, gh: github({ runs: [run(1300, 'cancelled')] }), n }).checkIfDue();
    expect(outcome).toMatchObject({ verdict: 'none', told: false });
    expect(store.doc.alertedRunId).toBe(1234);
  });

  it('does not record an alert the notifier did not send, so the next hour tries again', async () => {
    const store = memoryStore();
    const log = { warn: vi.fn() };
    const failing = notifier({ sent: false, reason: 'cooldown' });
    await watch({ store, gh: github({ runs: [run(1234, 'failure')] }), n: failing, log }).checkIfDue();
    expect(store.doc.alertedRunId).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('message not sent (cooldown)'));

    const later = new Date(NOW.getTime() + WATCH_INTERVAL_MS + 1000);
    const working = notifier();
    await watch({ store, gh: github({ runs: [run(1234, 'failure')] }), n: working, now: later }).checkIfDue();
    expect(working.notifyTelegram).toHaveBeenCalledTimes(1);
    expect(store.doc.alertedRunId).toBe(1234);
  });

  it('sends the alert even when the failed jobs cannot be read', async () => {
    const n = notifier();
    const log = { warn: vi.fn() };
    const gh = github({ runs: [run(1234, 'failure')], jobsStatus: 500 });
    const outcome = await watch({ store: memoryStore(), gh, n, log }).checkIfDue();
    expect(outcome.told).toBe(true);
    expect(n.notifyTelegram.mock.calls[0][0].message).toContain('did not say which job failed');
  });

  it('is not due again within the interval, and reads nothing', async () => {
    const store = memoryStore({ id: 'delivery_monitor_watch', lastAttemptAt: iso(NOW - 10 * 60_000) });
    const gh = github({ runs: [run(1234, 'failure')] });
    const outcome = await watch({ store, gh }).checkIfDue();
    expect(outcome).toEqual({ checked: false, reason: 'not due' });
    expect(gh.fetch).not.toHaveBeenCalled();
  });

  it('records a failed read with its code, keeps the alert state, and does not throw', async () => {
    const store = memoryStore({ id: 'delivery_monitor_watch', alertedRunId: 1234, alertedAt: iso(NOW - 3_600_000) });
    const log = { warn: vi.fn() };
    const n = notifier();
    const outcome = await watch({ store, gh: github({ runsStatus: 503 }), n, log }).checkIfDue();
    expect(outcome).toMatchObject({ checked: true, verdict: 'unread', told: false });
    expect(store.doc.alertedRunId).toBe(1234);
    expect(store.doc.lastError).toEqual(expect.any(String));
    expect(n.notifyTelegram).not.toHaveBeenCalled();
    expect(log.warn.mock.calls.flat().join('\n')).toMatch(/could not be read \(\w+\)/);
  });

  it('refuses a body that is not a run list', async () => {
    const gh = { fetch: vi.fn(async () => new Response(JSON.stringify({ message: 'nope' }), { status: 200 })) };
    const outcome = await watch({ store: memoryStore(), gh }).checkIfDue();
    expect(outcome.verdict).toBe('unread');
  });

  it('leaves the record alone when another instance wrote it first (412)', async () => {
    const store = memoryStore();
    store.readDoc.mockResolvedValueOnce({ id: 'delivery_monitor_watch', _etag: 'e0' });
    store.replaceDocIfMatch.mockRejectedValueOnce(Object.assign(new Error('changed'), { code: 412 }));
    const outcome = await watch({ store, gh: github({ runs: [run(1300, 'success')] }) }).checkIfDue();
    expect(outcome).toMatchObject({ checked: true, written: false });
  });

  it('guards the write with the ETag it read', async () => {
    const store = memoryStore({ id: 'delivery_monitor_watch', lastAttemptAt: iso(NOW - 2 * 3_600_000) });
    await watch({ store, gh: github({ runs: [run(1300, 'success')] }) }).checkIfDue();
    expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(1);
    expect(store.replaceDocIfMatch.mock.calls[0][1]._etag).toBe('e1');
    expect(store.replaceDocIfMatch.mock.calls[0][2]).toEqual({ partitionKey: 'admin_config' });
  });

  it('carries only the run number, a link built from the id, and a plain job name', async () => {
    const n = notifier();
    const gh = github({
      runs: [run(1234, 'failure', { html_url: 'https://evil.example/phish', display_title: 'click here' })],
      jobs: [{ name: 'Deploy\u0007 `rm -rf` <b>now</b>\nhttps://evil.example', conclusion: 'failure' }],
    });
    await watch({ store: memoryStore(), gh, n }).checkIfDue();
    const text = n.notifyTelegram.mock.calls[0][0].message;
    expect(text).not.toContain('evil.example/phish');
    expect(text).not.toContain('click here');
    expect(text).not.toMatch(/[`<>\u0007]/);
    expect(text).toContain('/actions/runs/1234');
  });
});

describe('checkAgentHealth runs the watch', () => {
  const agentStore = () => ({ queryDocs: vi.fn(async () => []), patchDoc: vi.fn() });

  it('after its own work, and reports what the watch found', async () => {
    const deliveryWatch = { checkIfDue: vi.fn(async () => ({ checked: true, verdict: 'red' })) };
    const summary = await createAgentHealthCheck({ store: agentStore(), now: () => NOW, deliveryWatch }).run();
    expect(summary.deliveryWatch).toBe('red');
  });

  it.each([
    [{ checked: false, reason: 'not due' }, 'not due'],
    [{ checked: true, verdict: 'green' }, 'green'],
    [{ checked: true, verdict: 'unread' }, 'unread'],
  ])('reports %j as %s', async (outcome, word) => {
    const summary = await createAgentHealthCheck({
      store: agentStore(),
      now: () => NOW,
      deliveryWatch: { checkIfDue: async () => outcome },
    }).run();
    expect(summary.deliveryWatch).toBe(word);
  });

  it('never fails the run, and logs only a code', async () => {
    const log = { warn: vi.fn() };
    const summary = await createAgentHealthCheck({
      store: agentStore(),
      now: () => NOW,
      log,
      deliveryWatch: {
        checkIfDue: async () => {
          throw Object.assign(new Error('secret-token-123 at https://x.example'), { code: 'BOOM' });
        },
      },
    }).run();
    expect(summary.deliveryWatch).toBe('failed');
    expect(log.warn).toHaveBeenCalledWith('[checkAgentHealth] the delivery monitor watch failed (BOOM)');
    expect(log.warn.mock.calls.flat().join('\n')).not.toMatch(/secret-token-123|x\.example/);
  });

  it('does nothing extra when no watch is given', async () => {
    const summary = await createAgentHealthCheck({ store: agentStore(), now: () => NOW }).run();
    expect(summary).not.toHaveProperty('deliveryWatch');
  });

  it('is wired in schedulers.js into checkAgentHealth, with the same notifier kind', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../../functions/schedulers.js', import.meta.url), 'utf8');
    const wiring = /timer\('checkAgentHealth'[\s\S]*?\.run\(\)\n\);/.exec(source)?.[0] ?? '';
    expect(wiring).toMatch(/deliveryWatch: createDeliveryMonitorWatch\(\{[\s\S]*?createNotifier\(\{ store, log: context \}\)/);
  });
});
