/**
 * The reminders sheet's shape and its calendar: what a save may carry, and
 * when a reminder is due to be said (owner request 2026-10-06).
 */
import { describe, it, expect } from 'vitest';
import {
  CREDENTIAL_ROW_PREFIX,
  DEFAULT_LEAD_DAYS,
  MAX_REMINDERS,
  OVERDUE_REPEAT_DAYS,
  REGISTER_RESERVED_ROWS,
  RemindersValidationError,
  daysUntil,
  isCredentialRow,
  mergeStamps,
  mergeStoredStamps,
  normalizeReminders,
  parseDateOnly,
  readStoredReminders,
  stageDue,
  summarizeReminders,
} from './settings.js';

const reminder = (over = {}) => ({
  id: 'cf-token',
  title: 'Cloudflare DNS token for the lab host expires',
  dueDate: '2027-01-04',
  ...over,
});

const expectRejects = (body, pattern) => {
  expect(() => normalizeReminders(body)).toThrow(RemindersValidationError);
  expect(() => normalizeReminders(body)).toThrow(pattern);
};

describe('dates', () => {
  it('accepts real calendar days only', () => {
    expect(parseDateOnly('2026-10-06')).toBe(Date.UTC(2026, 9, 6));
    expect(parseDateOnly('2026-02-30')).toBeNull();
    expect(parseDateOnly('2026-13-01')).toBeNull();
    expect(parseDateOnly('06/10/2026')).toBeNull();
    expect(parseDateOnly(20261006)).toBeNull();
  });
  it('counts whole days, negative once past', () => {
    expect(daysUntil('2026-10-13', '2026-10-06')).toBe(7);
    expect(daysUntil('2026-10-06', '2026-10-06')).toBe(0);
    expect(daysUntil('2026-10-01', '2026-10-06')).toBe(-5);
    expect(daysUntil('nope', '2026-10-06')).toBeNull();
  });
});

describe('normalizeReminders', () => {
  it('fills the defaults and trims, keeping the order given', () => {
    const value = normalizeReminders({
      reminders: [reminder({ title: '  Renew  ', dueDate: '2026-12-01' }), reminder({ id: 'b' })],
    });
    expect(value.reminders[0]).toEqual({
      id: 'cf-token',
      title: 'Renew',
      dueDate: '2026-12-01',
      leadDays: DEFAULT_LEAD_DAYS,
      notes: '',
      url: '',
      done: false,
      notified: {},
    });
    expect(value.reminders.map((r) => r.id)).toEqual(['cf-token', 'b']);
  });

  it('accepts the lead days as the form types them and the timer stamps as stored', () => {
    const value = normalizeReminders({
      reminders: [
        reminder({
          leadDays: '14',
          notes: ' rotate in the Cloudflare dashboard ',
          url: 'https://dash.cloudflare.com/profile/api-tokens',
          done: true,
          notified: { ahead: '2026-12-21T13:00:00.000Z', due: null },
        }),
      ],
    });
    expect(value.reminders[0]).toMatchObject({
      leadDays: 14,
      notes: 'rotate in the Cloudflare dashboard',
      url: 'https://dash.cloudflare.com/profile/api-tokens',
      done: true,
      notified: { ahead: '2026-12-21T13:00:00.000Z' },
    });
  });

  it('refuses what the sheet cannot have written', () => {
    expectRejects({ reminders: [reminder({ extra: 1 })], }, /Unknown field\(s\) in reminders\[0\]/);
    expectRejects({ reminders: [reminder({ id: 'has space' })] }, /id must be/);
    expectRejects({ reminders: [reminder({ title: '   ' })] }, /title is required/);
    expectRejects({ reminders: [reminder({ dueDate: '2026-02-30' })] }, /real date/);
    expectRejects({ reminders: [reminder({ leadDays: -1 })] }, /leadDays/);
    expectRejects({ reminders: [reminder({ leadDays: 366 })] }, /leadDays/);
    expectRejects({ reminders: [reminder({ url: 'http://plain.example' })] }, /https URL/);
    expectRejects({ reminders: [reminder({ url: 'https://a.example/x y' })] }, /https URL/);
    expectRejects({ reminders: [reminder({ done: 'yes' })] }, /done must be/);
    expectRejects({ reminders: [reminder({ notified: { later: '2026-01-01T00:00:00Z' } })] }, /notified/);
    expectRejects({ reminders: [reminder({ notified: { ahead: 'soon' } })] }, /ISO timestamp/);
    expectRejects({ reminders: [reminder(), reminder()] }, /more than once/);
    expectRejects({ reminders: 'many' }, /must be an array/);
    expectRejects({ items: [] }, /Unknown field\(s\) in body/);
    expectRejects(
      { reminders: Array.from({ length: MAX_REMINDERS + 1 }, (_, i) => reminder({ id: `r${i}` })) },
      /at most/
    );
  });

  it('reads a stored document by its reminders field alone, and an absent one as empty', () => {
    expect(readStoredReminders(null)).toEqual({ reminders: [] });
    expect(
      readStoredReminders({ id: 'reminders', configScope: 'x', _etag: 'e', reminders: [reminder()] })
        .reminders
    ).toHaveLength(1);
    expect(() => readStoredReminders({ reminders: [{ id: 'x' }] })).toThrow(RemindersValidationError);
  });
});

describe('stageDue', () => {
  const r = (over) => normalizeReminders({ reminders: [reminder(over)] }).reminders[0];

  it('is quiet outside the lead window and after each stage has been said', () => {
    expect(stageDue(r({ dueDate: '2027-01-04', leadDays: 7 }), '2026-12-27')).toBeNull();
    expect(stageDue(r({ dueDate: '2027-01-04', leadDays: 7 }), '2026-12-28')).toBe('ahead');
    expect(
      stageDue(r({ dueDate: '2027-01-04', notified: { ahead: '2026-12-28T13:00:00Z' } }), '2026-12-30')
    ).toBeNull();
    expect(stageDue(r({ dueDate: '2027-01-04' }), '2027-01-04')).toBe('due');
    expect(
      stageDue(r({ dueDate: '2027-01-04', notified: { due: '2027-01-04T13:00:00Z' } }), '2027-01-04')
    ).toBeNull();
  });

  it('says an overdue reminder once, then weekly, and never once done', () => {
    const overdue = r({ dueDate: '2027-01-04' });
    expect(stageDue(overdue, '2027-01-05')).toBe('overdue');
    const said = r({ dueDate: '2027-01-04', notified: { overdue: '2027-01-05T13:00:00.000Z' } });
    expect(stageDue(said, '2027-01-08', Date.parse('2027-01-08T13:00:00Z'))).toBeNull();
    expect(
      stageDue(said, `2027-01-${5 + OVERDUE_REPEAT_DAYS}`, Date.parse(`2027-01-${5 + OVERDUE_REPEAT_DAYS}T13:00:00Z`))
    ).toBe('overdue');
    expect(stageDue(r({ dueDate: '2027-01-04', done: true }), '2027-02-01')).toBeNull();
  });

  it('skips the ahead stage when leadDays is 0', () => {
    expect(stageDue(r({ dueDate: '2027-01-04', leadDays: 0 }), '2027-01-03')).toBeNull();
    expect(stageDue(r({ dueDate: '2027-01-04', leadDays: 0 }), '2027-01-04')).toBe('due');
  });
});

describe('stamps from two writers', () => {
  it('keeps the later instant per stage', () => {
    expect(mergeStamps({ ahead: '2026-12-21T13:00:00.000Z' }, { ahead: '2026-12-28T13:00:00.000Z', due: '2027-01-04T13:00:00.000Z' })).toEqual({
      ahead: '2026-12-28T13:00:00.000Z',
      due: '2027-01-04T13:00:00.000Z',
    });
    expect(mergeStamps(undefined, {})).toEqual({});
  });

  it("folds the stored stamps into a save, by id, without resurrecting removed rows", () => {
    const stored = {
      reminders: [
        { id: 'a', notified: { ahead: '2026-12-28T13:00:00.000Z' } },
        { id: 'gone', notified: { due: '2026-01-01T13:00:00.000Z' } },
      ],
    };
    const saved = normalizeReminders({
      reminders: [reminder({ id: 'a', notified: {} }), reminder({ id: 'new' })],
    });
    const merged = mergeStoredStamps(saved, stored);
    expect(merged.reminders.map((r) => r.id)).toEqual(['a', 'new']);
    expect(merged.reminders[0].notified).toEqual({ ahead: '2026-12-28T13:00:00.000Z' });
    expect(merged.reminders[1].notified).toEqual({});
    expect(mergeStoredStamps(saved, null).reminders[0].notified).toEqual({});
  });

  it('repairs a stored sheet whose reminders is not a list, rather than throwing (review of #1039)', () => {
    const saved = normalizeReminders({ reminders: [reminder({ id: 'a' })] });
    for (const malformed of [{ reminders: { a: 1 } }, { reminders: 'x' }, { reminders: 7 }]) {
      const merged = mergeStoredStamps(saved, malformed);
      expect(merged.reminders.map((r) => r.id)).toEqual(['a']);
      expect(merged.reminders[0].notified).toEqual({});
    }
  });
});

describe('the credential register’s rows survive any save unchanged (review of #1039)', () => {
  const registerRow = reminder({
    id: `${CREDENTIAL_ROW_PREFIX}azure-swa-deployment-token`,
    title: 'Rotate Static Web App deployment token',
    dueDate: '2026-12-28',
    leadDays: 14,
    notified: { ahead: '2026-12-14T13:00:00.000Z' },
  });
  const stored = () => normalizeReminders({ reminders: [reminder({ id: 'mine' }), registerRow] });

  it('recognises a register row by its reserved prefix only', () => {
    expect(isCredentialRow(registerRow)).toBe(true);
    expect(isCredentialRow(reminder({ id: 'cf-token' }))).toBe(false);
    expect(isCredentialRow({})).toBe(false);
  });

  it('carries the stored register row through, whatever the save sent for it', () => {
    const [storedRegisterRow] = stored().reminders.filter(isCredentialRow);
    const saved = normalizeReminders({
      reminders: [
        reminder({ id: 'mine', title: 'Mine, renamed' }),
        { ...registerRow, done: true, dueDate: '2099-01-01', notified: { due: '2099-01-01T00:00:00.000Z' } },
      ],
    });
    const merged = mergeStoredStamps(saved, stored());
    expect(merged.reminders.map((r) => r.id)).toEqual(['mine', registerRow.id]);
    expect(merged.reminders[0].title).toBe('Mine, renamed');
    expect(merged.reminders[1]).toEqual(storedRegisterRow);
  });

  it('keeps a register row the save left out, and drops one the stored sheet does not hold', () => {
    const left = mergeStoredStamps(normalizeReminders({ reminders: [reminder({ id: 'mine' })] }), stored());
    expect(left.reminders.map((r) => r.id)).toEqual(['mine', registerRow.id]);
    const added = mergeStoredStamps(
      normalizeReminders({ reminders: [reminder({ id: `${CREDENTIAL_ROW_PREFIX}made-up` })] }),
      { reminders: [] }
    );
    expect(added.reminders).toEqual([]);
  });

  it('drops a stored register row that does not validate: the save repairs it', () => {
    const merged = mergeStoredStamps(normalizeReminders({ reminders: [reminder({ id: 'mine' })] }), {
      reminders: [{ id: `${CREDENTIAL_ROW_PREFIX}broken`, title: '' }],
    });
    expect(merged.reminders.map((r) => r.id)).toEqual(['mine']);
  });

  it('keeps a valid register row, and its stamp, beside an invalid owner row (#1041)', () => {
    // An out-of-band edit left an owner row that does not validate. The whole
    // sheet was validated at once, so the save dropped the register row too,
    // its `notified` stamp with it, and the next run said that stage again.
    const brokenOwnerRow = { id: 'mine', title: '', dueDate: 'soon' };
    const merged = mergeStoredStamps(normalizeReminders({ reminders: [reminder({ id: 'mine' })] }), {
      reminders: [brokenOwnerRow, registerRow],
    });
    const kept = merged.reminders.find(isCredentialRow);
    expect(merged.reminders.map((r) => r.id)).toEqual(['mine', registerRow.id]);
    expect(kept.notified).toEqual({ ahead: '2026-12-14T13:00:00.000Z' });
    expect(kept).toEqual(normalizeReminders({ reminders: [registerRow] }).reminders[0]);
  });

  it('keeps the first of two stored register rows under one id, as a whole-sheet read would refuse both', () => {
    const later = { ...registerRow, title: 'A second copy', notified: {} };
    const merged = mergeStoredStamps(normalizeReminders({ reminders: [] }), {
      reminders: [registerRow, later],
    });
    expect(merged.reminders).toHaveLength(1);
    expect(merged.reminders[0].title).toBe(registerRow.title);
  });

  it('refuses a save that, with the register’s rows, would pass MAX_REMINDERS', () => {
    const full = normalizeReminders({
      reminders: Array.from({ length: MAX_REMINDERS }, (_, i) => reminder({ id: `r${i}` })),
    });
    expect(() => mergeStoredStamps(full, stored())).toThrow(RemindersValidationError);
  });

  it('keeps REGISTER_RESERVED_ROWS free for the register, even before any of its rows exist (review of #1039)', () => {
    const own = (n) =>
      normalizeReminders({ reminders: Array.from({ length: n }, (_, i) => reminder({ id: `r${i}` })) });
    const limit = MAX_REMINDERS - REGISTER_RESERVED_ROWS;
    expect(mergeStoredStamps(own(limit), null).reminders).toHaveLength(limit);
    expect(() => mergeStoredStamps(own(limit + 1), null)).toThrow(/kept for the credential register/);
  });
});

describe('summarizeReminders', () => {
  it('records counts and the next open date, never a title', () => {
    const value = normalizeReminders({
      reminders: [
        reminder({ id: 'a', dueDate: '2027-01-04' }),
        reminder({ id: 'b', dueDate: '2026-11-01', done: true }),
        reminder({ id: 'c', dueDate: '2026-12-01' }),
      ],
    });
    expect(summarizeReminders(value)).toEqual({ reminders: 3, open: 2, nextDue: '2026-12-01' });
    expect(JSON.stringify(summarizeReminders(value))).not.toContain('Cloudflare');
    expect(summarizeReminders({ reminders: [] })).toEqual({ reminders: 0, open: 0, nextDue: null });
  });
});
