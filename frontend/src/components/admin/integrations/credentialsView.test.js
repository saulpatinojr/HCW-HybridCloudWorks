/**
 * The Credentials tab's words (#1026). The states are the API's; these pin
 * how each reads, that an unexpected one never reads as OK, and the grouping.
 */
import { describe, it, expect } from 'vitest';

import {
  CREDENTIAL_STATE,
  STATE_ORDER,
  describeAge,
  describeAgeSource,
  describeExpiry,
  describeReminder,
  describeRule,
  describeSync,
  groupByStore,
  remindersOutOfStep,
  stateCounts,
  stateOf,
  todayIso,
  localDateIso,
  rotationDateBounds,
} from './credentialsView';

const credential = (overrides = {}) => ({
  id: 'kv-anthropic-api-key',
  name: 'ANTHROPIC-API-KEY',
  store: 'key-vault',
  renewal: 'hand',
  lifetimeDays: 180,
  ageDays: null,
  lastRotatedSource: null,
  expiresAt: null,
  expiryEstimated: false,
  state: 'unknown',
  reminder: null,
  ...overrides,
});

describe('states', () => {
  it('reads overdue as the admin’s red and keeps the four in worst-first order', () => {
    expect(CREDENTIAL_STATE.overdue).toMatchObject({ label: 'Overdue', tone: 'bad' });
    expect(CREDENTIAL_STATE['due-soon'].tone).toBe('warn');
    expect(STATE_ORDER).toEqual(['overdue', 'due-soon', 'unknown', 'ok']);
  });

  it('reads a state it does not know as Unknown, never as OK', () => {
    expect(stateOf(credential({ state: 'brand-new' })).label).toBe('Unknown');
    expect(stateOf(credential({ state: 'ok' })).label).toBe('OK');
  });

  it('counts in worst-first order with a zero for any missing', () => {
    expect(stateCounts({ ok: 40, overdue: 2 })).toEqual([
      { state: 'overdue', count: 2 },
      { state: 'due-soon', count: 0 },
      { state: 'unknown', count: 0 },
      { state: 'ok', count: 40 },
    ]);
  });
});

describe('the columns', () => {
  it('says the age in days, and where it was read from', () => {
    expect(describeAge(credential())).toBe('Unknown');
    expect(describeAge(credential({ ageDays: 0 }))).toBe('Today');
    expect(describeAge(credential({ ageDays: 1 }))).toBe('1 day');
    expect(describeAge(credential({ ageDays: 214 }))).toBe('214 days');
    expect(describeAgeSource(credential({ lastRotatedSource: 'owner' }))).toBe('recorded');
    expect(describeAgeSource(credential({ lastRotatedSource: 'key-vault' }))).toBe('Keys tab');
    expect(describeAgeSource(credential({ lastRotatedSource: 'azure' }))).toBe('Activity Log');
    expect(describeAgeSource(credential())).toBeNull();
  });

  // 2026-10-11: every rotation the owner saved was a 200, and the tab still
  // read as though none had landed, because no row showed the stored date.
  it('names the recorded date whenever one is stored, even when a newer source dates the age', () => {
    expect(
      describeAgeSource(credential({ lastRotatedSource: 'owner', recordedOn: '2026-08-20' }))
    ).toBe('recorded 2026-08-20');
    expect(
      describeAgeSource(credential({ lastRotatedSource: 'key-vault', recordedOn: '2026-08-20' }))
    ).toBe('Keys tab; recorded 2026-08-20');
    expect(describeAgeSource(credential({ recordedOn: '2026-08-20' }))).toBe('recorded 2026-08-20');
  });

  it('tells a reported expiry from an estimated rotation date, and a missing date from no rule', () => {
    expect(describeExpiry(credential({ expiresAt: '2027-01-07T05:45:00.000Z' }))).toEqual({
      text: '2027-01-07',
      kind: 'expires',
    });
    expect(
      describeExpiry(credential({ expiresAt: '2027-10-01T00:00:00.000Z', expiryEstimated: true }))
    ).toEqual({
      text: '2027-10-01',
      kind: 'rotation due',
    });
    expect(describeExpiry(credential()).text).toBe('Unknown');
    expect(describeExpiry(credential({ lifetimeDays: null })).text).toBe('None');
    expect(describeExpiry(credential({ renewal: 'self', lifetimeDays: null })).text).toBe('—');
  });

  it('states the rule in days', () => {
    expect(describeRule(credential({ lifetimeDays: 90 }))).toBe('every 90 days');
    expect(describeRule(credential({ lifetimeDays: null }))).toBeNull();
  });
});

describe('reminders', () => {
  const withReminder = (inSheet, kind = 'rotate') =>
    credential({
      reminder: { id: 'credential-x', kind, dueDate: '2027-10-01', leadDays: 30, inSheet },
    });

  it('says whether the reminder is on the sheet', () => {
    expect(describeReminder(credential())).toBeNull();
    expect(describeReminder(withReminder(true))).toEqual({
      text: 'Rotation reminder, due 2027-10-01',
      inStep: true,
    });
    expect(describeReminder(withReminder(false))).toEqual({
      text: 'Rotation reminder, due 2027-10-01, not on the sheet yet',
      inStep: false,
    });
    expect(describeReminder(withReminder(null)).inStep).toBeNull();
  });

  it('names the reminder that asks for a date, for a credential with none yet (#1026)', () => {
    expect(describeReminder(withReminder(true, 'record')).text).toBe(
      'Reminder to record its rotation date, due 2027-10-01'
    );
    expect(describeReminder(withReminder(false, 'record')).inStep).toBe(false);
  });

  it('counts only the ones known to be missing', () => {
    expect(
      remindersOutOfStep([
        withReminder(false),
        withReminder(true),
        withReminder(null),
        credential(),
      ])
    ).toBe(1);
    expect(remindersOutOfStep(undefined)).toBe(0);
  });

  it('describes a sync in words, and a declined one with what to do', () => {
    expect(describeSync({ synced: true, changed: true })).toBe('The reminders sheet was updated.');
    expect(describeSync({ synced: true, changed: false })).toBe(
      'The reminders sheet was already in step.'
    );
    expect(describeSync({ synced: false, reason: 'invalid' })).toMatch(
      /Platform Settings → Reminders/
    );
    expect(describeSync({ synced: false, reason: 'error' })).toBe(
      'The reminders sheet was not updated. Update reminders tries again.'
    );
    expect(describeSync(undefined)).toBeNull();
  });
});

describe('groupByStore', () => {
  const stores = [
    { id: 'key-vault', label: 'Key Vault kv-site-prod-cus-01' },
    { id: 'lab-file', label: 'Lab host file' },
    { id: 'owner', label: 'Owner’s password manager' },
  ];
  const rows = [
    credential({ id: 'a', store: 'lab-file' }),
    credential({ id: 'b', store: 'key-vault' }),
    credential({ id: 'c', store: 'brand-new' }),
  ];

  it('groups in the API’s store order, drops empty stores and keeps an unknown one', () => {
    const groups = groupByStore(rows, stores);
    expect(groups.map((g) => g.store.id)).toEqual(['key-vault', 'lab-file', 'brand-new']);
    expect(groups[2].store.label).toBe('brand-new');
  });

  it('keeps only the chosen store', () => {
    expect(
      groupByStore(rows, stores, 'lab-file').map((g) => g.credentials.map((c) => c.id))
    ).toEqual([['a']]);
  });
});

it('takes today as the UTC day', () => {
  expect(todayIso(Date.parse('2026-10-09T23:30:00.000Z'))).toBe('2026-10-09');
});

describe('rotationDateBounds (review of #1039)', () => {
  it('allows the UTC day plus the API’s one day of grace', () => {
    // 01:30 UTC on the 10th is still the 9th in Central time.
    expect(rotationDateBounds(Date.parse('2026-10-10T01:30:00.000Z')).max).toBe('2026-10-11');
    expect(rotationDateBounds(Date.parse('2026-10-09T23:30:00.000Z')).max).toBe('2026-10-10');
  });

  it('starts on this browser’s own day, which is always inside the bound', () => {
    for (const iso of [
      '2026-10-10T01:30:00.000Z',
      '2026-10-09T12:00:00.000Z',
      '2026-10-09T23:30:00.000Z',
    ]) {
      const now = Date.parse(iso);
      const local = new Date(now);
      const pad = (n) => String(n).padStart(2, '0');
      const { initial, max } = rotationDateBounds(now);
      expect(initial).toBe(
        `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`
      );
      expect(localDateIso(now)).toBe(initial);
      expect(initial <= max).toBe(true);
    }
  });
});
