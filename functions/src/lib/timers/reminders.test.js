/**
 * The daily reminder check: what it says, when it stamps, how it shares the
 * document with the sheet, and what it leaves alone (owner request
 * 2026-10-06; dual-writer and telemetry points from the review of #910).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  STAMP_WRITE_ATTEMPTS,
  REMINDER_SOURCE_PREFIX,
  createReminderCheck,
  describeDistance,
  reminderMessage,
} from './reminders.js';
import { REMINDERS_CONFIG_ID } from '../reminders/settings.js';
import { syncReminderProviders } from '../reminders/providers.js';
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { formatTelegramText } from '../notify.js';

const NOW = new Date('2026-12-28T13:00:05.000Z');
const now = () => NOW;

const doc = (reminders, etag = '"v1"') => ({
  id: REMINDERS_CONFIG_ID,
  configScope: ADMIN_CONFIG_PARTITION,
  updatedAt: '2026-10-06T20:00:00.000Z',
  _etag: etag,
  reminders,
});

const store = (stored) => ({
  readDoc: vi.fn(async () => stored),
  replaceDocIfMatch: vi.fn(async (_c, d) => d),
});

const sending = () => ({ notifyTelegram: vi.fn(async () => ({ sent: true })) });
const precondition = () => Object.assign(new Error('412'), { code: 412 });

describe('wording', () => {
  it('describes the distance to the date in words', () => {
    expect(describeDistance(7)).toBe('in 7 days');
    expect(describeDistance(1)).toBe('tomorrow');
    expect(describeDistance(0)).toBe('today');
    expect(describeDistance(-1)).toBe('1 day overdue');
    expect(describeDistance(-9)).toBe('9 days overdue');
  });

  it('builds a message with the date, the notes, the link and where to mark it done', () => {
    const { title, message } = reminderMessage(
      {
        title: 'Cloudflare DNS token expires',
        dueDate: '2027-01-04',
        notes: 'Re-scope to the lab zone when the zone exists.',
        url: 'https://dash.cloudflare.com/profile/api-tokens',
      },
      'ahead',
      '2026-12-28'
    );
    expect(title).toBe('Coming up: Cloudflare DNS token expires');
    expect(message).toContain('Due 2027-01-04 (in 7 days).');
    expect(message).toContain('Re-scope to the lab zone');
    expect(message).toContain('https://dash.cloudflare.com/profile/api-tokens');
    expect(message).toContain('Platform Settings → Reminders');
  });

  it('is reported by the reminders sheet, not by its raw source key', () => {
    const text = formatTelegramText({
      title: 'T',
      message: 'M',
      severity: 'info',
      source: `${REMINDER_SOURCE_PREFIX}cf-token`,
    });
    expect(text).toContain('Reported by the reminders sheet.');
    expect(text).not.toContain('reminder:cf-token');
  });
});

describe('createReminderCheck', () => {
  it('does nothing when no document is stored, and reads it from the admin_config partition', async () => {
    const s = store(null);
    expect(await createReminderCheck({ store: s, notifier: sending(), now }).run()).toEqual({
      checked: 0,
      sent: 0,
    });
    expect(s.readDoc).toHaveBeenCalledWith('admin_config', REMINDERS_CONFIG_ID, ADMIN_CONFIG_PARTITION);
    expect(s.replaceDocIfMatch).not.toHaveBeenCalled();
  });

  it('says each reminder whose stage has come, one source per reminder, and stamps only those with the ETag', async () => {
    const s = store(
      doc([
        { id: 'cf-token', title: 'Cloudflare DNS token expires', dueDate: '2027-01-04', leadDays: 7 },
        { id: 'far', title: 'Far away', dueDate: '2027-06-01' },
        { id: 'late', title: 'Already late', dueDate: '2026-12-20', leadDays: 3 },
        { id: 'done', title: 'Handled', dueDate: '2026-12-28', done: true },
      ])
    );
    const notifier = sending();
    const result = await createReminderCheck({ store: s, notifier, now }).run();
    expect(result).toEqual({
      checked: 4,
      sent: 2,
      stages: { ahead: 1, due: 0, overdue: 1 },
      stamped: true,
    });
    expect(notifier.notifyTelegram.mock.calls.map(([call]) => [call.source, call.severity])).toEqual([
      [`${REMINDER_SOURCE_PREFIX}cf-token`, 'info'],
      [`${REMINDER_SOURCE_PREFIX}late`, 'critical'],
    ]);
    expect(notifier.notifyTelegram.mock.calls[0][0].title).toBe('Coming up: Cloudflare DNS token expires');

    expect(s.replaceDocIfMatch).toHaveBeenCalledTimes(1);
    const [container, written, options] = s.replaceDocIfMatch.mock.calls[0];
    expect(container).toBe('admin_config');
    expect(options).toEqual({ partitionKey: ADMIN_CONFIG_PARTITION });
    // The document's own fields and ETag survive; only the stamps change.
    expect(written).toMatchObject({ id: REMINDERS_CONFIG_ID, configScope: ADMIN_CONFIG_PARTITION, _etag: '"v1"' });
    const byId = Object.fromEntries(written.reminders.map((r) => [r.id, r]));
    expect(byId['cf-token'].notified).toEqual({ ahead: NOW.toISOString() });
    expect(byId.late.notified).toEqual({ overdue: NOW.toISOString() });
    expect(byId.far.notified).toBeUndefined();
    expect(byId.done.notified).toBeUndefined();
  });

  it('on a 412 re-reads and re-applies the stamps onto the rows as the sheet left them (review of #910)', async () => {
    const first = doc([
      { id: 'cf-token', title: 'Cloudflare token', dueDate: '2027-01-04', leadDays: 7 },
      { id: 'removed', title: 'Removed meanwhile', dueDate: '2026-12-28' },
    ]);
    // The owner edited one row's notes and removed the other between read
    // and write. The edit keeps the row's date and title, so it is the same
    // cycle and the stamp still belongs to it.
    const second = doc(
      [{ id: 'cf-token', title: 'Cloudflare token', dueDate: '2027-01-04', leadDays: 7, notes: 'edited' }],
      '"v2"'
    );
    const s = {
      readDoc: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
      replaceDocIfMatch: vi.fn().mockRejectedValueOnce(precondition()).mockImplementation(async (_c, d) => d),
    };
    const notifier = sending();
    const result = await createReminderCheck({ store: s, notifier, now }).run();
    expect(result).toMatchObject({ sent: 2, stamped: true });
    expect(s.replaceDocIfMatch).toHaveBeenCalledTimes(2);
    const written = s.replaceDocIfMatch.mock.calls[1][1];
    expect(written._etag).toBe('"v2"');
    expect(written.reminders).toHaveLength(1);
    expect(written.reminders[0]).toMatchObject({
      title: 'Cloudflare token',
      notes: 'edited',
      notified: { ahead: NOW.toISOString() },
    });
  });

  it('on a 412 drops a stamp whose row moved to a new cycle meanwhile, so the new cycle is said afresh (review of #1039)', async () => {
    const first = doc([
      { id: 'retitled', title: 'Old title', dueDate: '2027-01-04', leadDays: 7 },
      { id: 'redated', title: 'Redated', dueDate: '2026-12-28' },
      { id: 'credential-lab-agent-certificate', title: 'Record when the agent certificate was last rotated', dueDate: '2026-12-28', leadDays: 0 },
      { id: 'kept', title: 'Kept', dueDate: '2026-12-28' },
    ]);
    // Between the timer's read and its write: the owner renamed one row and
    // re-dated another, and a rotation recorded on Integrations → Credentials
    // started the register row's next cycle.
    const second = doc(
      [
        { id: 'retitled', title: 'New title', dueDate: '2027-01-04', leadDays: 7 },
        { id: 'redated', title: 'Redated', dueDate: '2027-02-01' },
        { id: 'credential-lab-agent-certificate', title: 'Rotate the agent certificate', dueDate: '2028-12-27', leadDays: 30 },
        { id: 'kept', title: 'Kept', dueDate: '2026-12-28' },
      ],
      '"v2"'
    );
    const s = {
      readDoc: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
      replaceDocIfMatch: vi.fn().mockRejectedValueOnce(precondition()).mockImplementation(async (_c, d) => d),
    };
    const result = await createReminderCheck({ store: s, notifier: sending(), now }).run();
    expect(result).toMatchObject({ sent: 4, stamped: true });
    const byId = Object.fromEntries(s.replaceDocIfMatch.mock.calls[1][1].reminders.map((r) => [r.id, r]));
    expect(byId.retitled.notified).toBeUndefined();
    expect(byId.redated.notified).toBeUndefined();
    expect(byId['credential-lab-agent-certificate'].notified).toBeUndefined();
    expect(byId.kept.notified).toEqual({ due: NOW.toISOString() });
  });

  it('without a conflict stamps every row it said, as before', async () => {
    const s = store(doc([{ id: 'a', title: '  Spaced title  ', dueDate: '2026-12-28' }]));
    await createReminderCheck({ store: s, notifier: sending(), now }).run();
    expect(s.replaceDocIfMatch).toHaveBeenCalledTimes(1);
    expect(s.replaceDocIfMatch.mock.calls[0][1].reminders[0].notified).toEqual({ due: NOW.toISOString() });
  });

  it('gives up stamping after the attempts run out, says so without naming a reminder, and does not throw', async () => {
    const stored = doc([{ id: 'cf-token', title: 'T', dueDate: '2026-12-28' }]);
    const s = {
      readDoc: vi.fn(async () => stored),
      replaceDocIfMatch: vi.fn(async () => {
        throw precondition();
      }),
    };
    const log = { warn: vi.fn(), log: vi.fn() };
    const result = await createReminderCheck({ store: s, notifier: sending(), now, log }).run();
    expect(result).toMatchObject({ sent: 1, stamped: false });
    expect(s.replaceDocIfMatch).toHaveBeenCalledTimes(STAMP_WRITE_ATTEMPTS);
    const warned = log.warn.mock.calls.map(([line]) => line).join('\n');
    expect(warned).toMatch(/stamps not written/);
    expect(warned).not.toContain('cf-token');
  });

  it('rethrows a write failure that is not a precondition', async () => {
    const s = {
      readDoc: vi.fn(async () => doc([{ id: 'x', title: 'T', dueDate: '2026-12-28' }])),
      replaceDocIfMatch: vi.fn(async () => {
        throw Object.assign(new Error('boom'), { code: 503 });
      }),
    };
    await expect(createReminderCheck({ store: s, notifier: sending(), now }).run()).rejects.toThrow('boom');
  });

  it('does not stamp a reminder the notifier could not send, logs its position not its id, and tries again tomorrow', async () => {
    const s = store(doc([{ id: 'cf-token', title: 'T', dueDate: '2026-12-28' }]));
    const notifier = { notifyTelegram: vi.fn(async () => ({ sent: false, reason: 'not_configured' })) };
    const log = { warn: vi.fn(), log: vi.fn() };
    expect(await createReminderCheck({ store: s, notifier, now, log }).run()).toMatchObject({ checked: 1, sent: 0 });
    expect(s.replaceDocIfMatch).not.toHaveBeenCalled();
    expect(log.warn.mock.calls[0][0]).toContain('not_configured');
    expect(log.warn.mock.calls[0][0]).toContain('reminders[0]');
    expect(log.warn.mock.calls[0][0]).not.toContain('cf-token');

    const throwing = {
      notifyTelegram: vi.fn(async () => {
        throw new Error('telegram down');
      }),
    };
    expect(
      await createReminderCheck({
        store: store(doc([{ id: 'x', title: 'T', dueDate: '2026-12-28' }])),
        notifier: throwing,
        now,
        log,
      }).run()
    ).toMatchObject({ sent: 0 });
  });

  it('returns nothing a log line could leak: counts and stages, no ids or titles', async () => {
    const s = store(doc([{ id: 'semantic-id', title: 'Secret project', dueDate: '2026-12-28' }]));
    const result = await createReminderCheck({ store: s, notifier: sending(), now }).run();
    const printed = JSON.stringify(result);
    expect(printed).not.toContain('semantic-id');
    expect(printed).not.toContain('Secret project');
  });

  it('warns and says nothing when the stored document does not validate', async () => {
    const s = store(doc([{ id: 'bad', title: 'T', dueDate: '2026-02-30' }]));
    const notifier = sending();
    const log = { warn: vi.fn(), log: vi.fn() };
    expect(await createReminderCheck({ store: s, notifier, now, log }).run()).toEqual({
      checked: 0,
      sent: 0,
      invalid: true,
    });
    expect(notifier.notifyTelegram).not.toHaveBeenCalled();
    expect(log.warn.mock.calls[0][0]).toMatch(/do not validate/);
  });

  it('says nothing without a notifier', async () => {
    const s = store(doc([{ id: 'x', title: 'T', dueDate: '2026-12-28' }]));
    expect(await createReminderCheck({ store: s, now }).run()).toEqual({ checked: 1, sent: 0 });
    expect(s.replaceDocIfMatch).not.toHaveBeenCalled();
  });
});

describe('the row providers run first (#1026, #1886)', () => {
  it('syncs them first, at the run’s own time, then reads the sheet the sync left', async () => {
    const order = [];
    const s = {
      readDoc: vi.fn(async () => {
        order.push('read');
        return doc([{ id: 'credential-lab-agent-certificate', title: 'Rotate it', dueDate: '2026-12-28' }]);
      }),
      replaceDocIfMatch: vi.fn(async (_c, d) => d),
    };
    const syncProviders = vi.fn(async () => {
      order.push('sync');
    });
    const result = await createReminderCheck({ store: s, notifier: sending(), now, syncProviders }).run();
    expect(order).toEqual(['sync', 'read']);
    expect(syncProviders).toHaveBeenCalledWith(NOW);
    expect(result).toMatchObject({ checked: 1, sent: 1 });
  });

  it('goes on with the sheet as it stands when a provider throws or declines, and says so', async () => {
    const s = store(doc([{ id: 'x', title: 'T', dueDate: '2026-12-28' }]));
    const log = { warn: vi.fn(), log: vi.fn() };
    const providers = [
      {
        id: 'credentials',
        sync: vi.fn(async () => {
          throw Object.assign(new Error('Entity admin_config/reminders is unavailable'), { code: 503 });
        }),
      },
      { id: 'ambassador', sync: vi.fn(async () => ({ synced: false, reason: 'truncated' })) },
    ];
    const syncProviders = (at) => syncReminderProviders({ store: s, at, log, providers });
    const result = await createReminderCheck({ store: s, notifier: sending(), now, log, syncProviders }).run();
    expect(result).toMatchObject({ checked: 1, sent: 1 });
    // The code or reason, never the store's sentence, which names a document.
    expect(log.warn.mock.calls.map(([line]) => line)).toEqual([
      '[sendReminders] credentials reminders sync threw (503)',
      '[sendReminders] ambassador reminders not synced (truncated)',
    ]);
  });
});

describe('a kept row says where it goes away, not "mark it done" (#1886)', () => {
  it('names the keeper for a kept row and keeps the sheet line for the owner’s own', () => {
    const kept = { id: 'ambassador-0123456789abcdef', title: 'Submit: Example Program', dueDate: '2026-12-10' };
    expect(reminderMessage(kept, 'ahead', '2026-12-01').message).toMatch(/Kept by Ambassador: it goes once it is handled there\.$/);
    expect(reminderMessage(kept, 'overdue', '2026-12-20').message).toMatch(/until it is handled in Ambassador/);
    const own = { id: 'my-own-row', title: 'Own', dueDate: '2026-12-10' };
    expect(reminderMessage(own, 'ahead', '2026-12-01').message).toMatch(/Mark it done on Platform Settings/);
  });
});
