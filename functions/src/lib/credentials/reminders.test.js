/**
 * The credential reminders on the owner's sheet (#1026): which rows, how
 * they merge, and that the owner's own rows, the timer's stamps, a
 * concurrent save and a rotation recorded mid-sync all survive a sync.
 */
import { describe, it, expect, vi } from 'vitest';

import { memoryStore } from '../../../test/memory-store.js';
import {
  MAX_REMINDERS,
  REGISTER_RESERVED_ROWS,
  normalizeReminders,
  readStoredReminders,
} from '../reminders/settings.js';
import { CREDENTIAL_REGISTER } from './register.js';
import { recordRotation } from './sources.js';
import { buildRegisterView } from './status.js';
import {
  CREDENTIALS_TAB_URL,
  CREDENTIAL_REMINDER_PREFIX,
  isCredentialReminder,
  mergeCredentialReminders,
  recordTitle,
  reminderIdFor,
  reminderKind,
  rotateTitle,
  syncCredentialReminders,
  wantedReminders,
} from './reminders.js';

const NOW = new Date('2026-10-09T12:00:00.000Z');
const TODAY = '2026-10-09';
const now = () => NOW;
const noSleep = () => Promise.resolve();

/** Every hand credential with a rule: the issue's list. */
const RULED = CREDENTIAL_REGISTER.filter((entry) => entry.renewal === 'hand' && entry.lifetimeDays);

/** Every one of them with a date, as the owner would record them. */
const ALL_RECORDED = Object.fromEntries(RULED.map((entry) => [entry.id, { rotatedOn: '2026-09-29' }]));

const ownerRow = (id, overrides = {}) => ({
  id,
  title: `Owner reminder ${id}`,
  dueDate: '2026-12-01',
  leadDays: 7,
  notes: '',
  url: '',
  done: false,
  notified: {},
  ...overrides,
});

const view = (records = {}, secrets = {}) =>
  buildRegisterView({ records, secrets, mcp: {}, coder: null }, NOW.getTime()).credentials;
const byId = (rows) => Object.fromEntries(rows.map((row) => [row.id, row]));
const credential = (credentials, id) => credentials.find((c) => c.id === id);

describe('wantedReminders', () => {
  it('wants a reminder for EVERY hand credential with a rule: the issue’s eight, dated or not', () => {
    const undated = wantedReminders(view(), { today: TODAY });
    const dated = wantedReminders(view(ALL_RECORDED), { today: TODAY });
    const ids = RULED.map((entry) => reminderIdFor(entry.id)).sort();
    expect(undated.map((row) => row.id).sort()).toEqual(ids);
    expect(dated.map((row) => row.id).sort()).toEqual(ids);
    expect(ids).toHaveLength(8);
  });

  it('fits within the rows the sheet keeps for the register, so an editor-filled sheet still takes them (review of #1039)', () => {
    expect(wantedReminders(view(), { today: TODAY }).length).toBeLessThanOrEqual(REGISTER_RESERVED_ROWS);
    expect(wantedReminders(view(ALL_RECORDED), { today: TODAY }).length).toBeLessThanOrEqual(REGISTER_RESERVED_ROWS);
  });

  it('asks for the date, due today, when no date is known', () => {
    const rows = byId(wantedReminders(view(), { today: TODAY }));
    const row = rows['credential-kv-anthropic-api-key'];
    expect(row).toEqual({
      id: 'credential-kv-anthropic-api-key',
      url: CREDENTIALS_TAB_URL,
      done: false,
      notified: {},
      title: 'Record when ANTHROPIC-API-KEY was last rotated',
      dueDate: TODAY,
      leadDays: 0,
      notes: expect.stringContaining('It is rotated every 180 days, and no date is known'),
    });
    expect(row.notes).toContain('Record that date on Integrations → Credentials');
  });

  it('keeps a RECORD row’s first due date rather than moving it to each day’s sync', () => {
    const credentials = view();
    const stored = [{ id: 'credential-kv-anthropic-api-key', title: recordTitle(credential(credentials, 'kv-anthropic-api-key')), dueDate: '2026-10-01' }];
    const rows = byId(wantedReminders(credentials, { today: TODAY, stored }));
    expect(rows['credential-kv-anthropic-api-key'].dueDate).toBe('2026-10-01');
    // Any other stored row for it (an old ROTATE row) is not a RECORD row: due today.
    const old = [{ id: 'credential-kv-anthropic-api-key', title: 'Rotate ANTHROPIC-API-KEY', dueDate: '2026-01-01' }];
    expect(byId(wantedReminders(credentials, { today: TODAY, stored: old }))['credential-kv-anthropic-api-key'].dueDate).toBe(
      TODAY
    );
  });

  it('is the rotation reminder once a date is known: due on the expiry’s day, said first when the tab turns amber', () => {
    const [swa] = wantedReminders(view({ 'azure-swa-deployment-token': { rotatedOn: '2026-09-29' } }), {
      today: TODAY,
    }).filter((row) => row.id === 'credential-azure-swa-deployment-token');
    expect(swa).toEqual({
      id: 'credential-azure-swa-deployment-token',
      title: 'Rotate Static Web App deployment token',
      dueDate: '2026-12-28',
      leadDays: 14,
      notes: expect.stringContaining('Static Web App deployment token, in Azure Static Web App.'),
      url: CREDENTIALS_TAB_URL,
      done: false,
      notified: {},
    });
    expect(swa.notes).toContain('Reset it on the Static Web App');
    expect(swa.notes).toContain('record the rotation on Integrations → Credentials');
    const cert = byId(wantedReminders(view({ 'lab-agent-certificate': { rotatedOn: '2026-09-29' } }), { today: TODAY }))[
      'credential-lab-agent-certificate'
    ];
    expect(cert).toMatchObject({ dueDate: '2027-03-28', leadDays: 30 });
  });

  it('follows a Keys-tab write: the later of it and the record, 180 days on', () => {
    const rows = byId(
      wantedReminders(
        view(
          { 'kv-anthropic-api-key': { rotatedOn: '2026-01-01' } },
          { 'ANTHROPIC-API-KEY': { lastWriteAt: '2026-10-01T09:00:00.000Z' } }
        ),
        { today: TODAY }
      )
    );
    expect(rows['credential-kv-anthropic-api-key']).toMatchObject({
      title: 'Rotate ANTHROPIC-API-KEY',
      dueDate: '2027-03-30',
      leadDays: 30,
    });
  });

  it('wants none for a credential whose source could not be read, nor for one with no rule', () => {
    const credentials = buildRegisterView({ records: ALL_RECORDED }, NOW.getTime(), ['secret-state']).credentials;
    expect(reminderKind(credential(credentials, 'kv-anthropic-api-key'))).toBeNull();
    expect(reminderKind(credential(credentials, 'lab-agent-certificate'))).toBe('rotate');
    expect(reminderKind(credential(view(), 'kv-openai-api-key'))).toBeNull();
  });

  it('writes rows the sheet’s own normalizer accepts, both kinds', () => {
    expect(() => normalizeReminders({ reminders: wantedReminders(view(), { today: TODAY }) })).not.toThrow();
    expect(() => normalizeReminders({ reminders: wantedReminders(view(ALL_RECORDED), { today: TODAY }) })).not.toThrow();
  });
});

describe('mergeCredentialReminders', () => {
  const wanted = wantedReminders(view({ 'lab-agent-certificate': { rotatedOn: '2026-09-29' } }), {
    today: TODAY,
  }).filter((row) => row.id === 'credential-lab-agent-certificate');
  const id = 'credential-lab-agent-certificate';

  it('passes the owner’s rows through untouched and in place, and appends a new credential row', () => {
    const stored = [ownerRow('a'), ownerRow('b', { done: true, notified: { ahead: '2026-11-24T13:00:00.000Z' } })];
    const merged = mergeCredentialReminders(stored, wanted);
    expect(merged.slice(0, 2)).toEqual(stored);
    expect(merged[2].id).toBe(id);
  });

  it('keeps the timer’s stamps while it is the same cycle, and reopens a row marked done (review of #1039)', () => {
    // Only the register says a credential row is handled, by moving its
    // date: a `done` that reached the sheet any other way is undone, and a
    // hand edit to its content is replaced.
    const notified = { ahead: '2028-08-29T13:00:00.000Z' };
    const stored = [{ ...wanted[0], notes: 'edited by hand', done: true, notified }];
    const [row] = mergeCredentialReminders(stored, wanted);
    expect(row).toEqual({ ...wanted[0], done: false, notified });
  });

  it('starts a fresh cycle when the due date moves', () => {
    const stored = [{ ...wanted[0], dueDate: '2027-01-01', done: true, notified: { due: '2027-01-01T13:00:00.000Z' } }];
    const [row] = mergeCredentialReminders(stored, wanted);
    expect(row).toEqual(wanted[0]);
  });

  it('starts a fresh cycle when a RECORD row becomes a ROTATE row, even on the same date', () => {
    const stored = [
      { ...wanted[0], title: 'Record when it was last rotated', leadDays: 0, done: true, notified: { due: '2028-09-28T13:00:00.000Z' } },
    ];
    expect(mergeCredentialReminders(stored, wanted)).toEqual(wanted);
  });

  it('replaces a credential row in place, and removes one whose credential no longer wants one', () => {
    const stored = [
      ownerRow('a'),
      { ...wanted[0], dueDate: '2027-01-01' },
      ownerRow('b'),
      { ...wanted[0], id: 'credential-kv-openai-api-key' },
    ];
    expect(mergeCredentialReminders(stored, wanted).map((row) => row.id)).toEqual(['a', id, 'b']);
  });

  it('keeps one row per credential even if the sheet holds two', () => {
    const merged = mergeCredentialReminders([wanted[0], { ...wanted[0] }], wanted);
    expect(merged.filter((row) => row.id === id)).toHaveLength(1);
  });

  it('recognises its own rows by the reserved prefix only', () => {
    expect(isCredentialReminder({ id: `${CREDENTIAL_REMINDER_PREFIX}x` })).toBe(true);
    expect(isCredentialReminder({ id: 'f0e1d2c3-uuid' })).toBe(false);
    expect(isCredentialReminder({})).toBe(false);
  });
});

describe('syncCredentialReminders', () => {
  const seeded = (reminders, records = ALL_RECORDED) =>
    memoryStore({
      'admin_config/credential_register': { id: 'credential_register', credentials: records },
      ...(reminders ? { 'admin_config/reminders': { id: 'reminders', configScope: 'admin_config', reminders } } : {}),
    });
  const sheet = (store) => store.get('admin_config', 'reminders');
  const rowsOf = (store) => byId(sheet(store).reminders);

  it('creates the sheet when there is none, with a row per reminder-bearing credential', async () => {
    const store = seeded(null);
    expect(await syncCredentialReminders({ store, now })).toEqual({ synced: true, changed: true, reminders: 8 });
    expect(sheet(store)).toMatchObject({ id: 'reminders', configScope: 'admin_config' });
    expect(readStoredReminders(sheet(store)).reminders).toHaveLength(8);
  });

  it('gives every undated one a RECORD row due today, and turns it into the rotation row once a date is recorded', async () => {
    const store = seeded(null, {});
    expect(await syncCredentialReminders({ store, now })).toMatchObject({ synced: true, reminders: 8 });
    const first = rowsOf(store)['credential-lab-agent-certificate'];
    expect(first).toMatchObject({ title: recordTitle({ name: '/etc/hcw/labs-agent.pem (sp-labs-agent-lab-hybrid-prod-cus-01)' }), dueDate: TODAY, leadDays: 0 });

    // The timer said it, and someone marked it done in the document; a
    // later day's sync keeps the date and the stamp, and reopens the row.
    const stamped = sheet(store);
    await store.replaceDocIfMatch('admin_config', {
      ...stamped,
      reminders: stamped.reminders.map((row) =>
        row.id === first.id ? { ...row, done: true, notified: { due: '2026-10-09T13:00:00.000Z' } } : row
      ),
    });
    await syncCredentialReminders({ store, now: () => new Date('2026-10-12T13:00:00.000Z') });
    expect(rowsOf(store)[first.id]).toMatchObject({ dueDate: TODAY, done: false, notified: { due: '2026-10-09T13:00:00.000Z' } });

    // The date is recorded: a date move, so a fresh cycle at the real due date.
    await recordRotation(store, { credentialId: 'lab-agent-certificate', rotatedOn: '2026-09-29', actor: 'o', at: NOW.toISOString() });
    await syncCredentialReminders({ store, now });
    expect(rowsOf(store)[first.id]).toMatchObject({
      title: rotateTitle({ name: '/etc/hcw/labs-agent.pem (sp-labs-agent-lab-hybrid-prod-cus-01)' }),
      dueDate: '2027-03-28',
      leadDays: 30,
      done: false,
      notified: {},
    });
  });

  it('never touches the owner’s rows, and keeps the document’s other fields', async () => {
    const owners = [ownerRow('a'), ownerRow('b', { done: true })];
    const store = memoryStore({
      'admin_config/credential_register': { id: 'credential_register', credentials: ALL_RECORDED },
      'admin_config/reminders': { id: 'reminders', configScope: 'admin_config', updatedBy: 'oid-9', reminders: owners },
    });
    await syncCredentialReminders({ store, now });
    const stored = sheet(store);
    expect(stored.updatedBy).toBe('oid-9');
    expect(stored.reminders.slice(0, 2)).toEqual(owners);
    expect(stored.reminders).toHaveLength(10);
    expect(store.replaceDocIfMatch).toHaveBeenCalledWith(
      'admin_config',
      expect.objectContaining({ _etag: expect.any(String) }),
      { partitionKey: 'admin_config' }
    );
  });

  it('writes nothing when the sheet is already in step', async () => {
    const store = seeded(null);
    await syncCredentialReminders({ store, now });
    store.replaceDocIfMatch.mockClear();
    store.createDoc.mockClear();
    expect(await syncCredentialReminders({ store, now })).toEqual({ synced: true, changed: false, reminders: 8 });
    expect(store.replaceDocIfMatch).not.toHaveBeenCalled();
    expect(store.createDoc).not.toHaveBeenCalled();
  });

  it('re-reads and re-merges when the sheet was saved in between, losing neither write', async () => {
    const store = seeded([ownerRow('a')]);
    const realRead = store.readDoc.getMockImplementation();
    let raced = false;
    store.readDoc.mockImplementation(async (container, id, pk) => {
      const doc = await realRead(container, id, pk);
      if (id === 'reminders' && !raced) {
        raced = true;
        // The owner adds a row between the sync's read and its write.
        const current = store.get('admin_config', 'reminders');
        await store.replaceDocIfMatch('admin_config', { ...current, reminders: [...current.reminders, ownerRow('c')] });
      }
      return doc;
    });
    const result = await syncCredentialReminders({ store, now, sleep: noSleep });
    expect(result).toMatchObject({ synced: true, changed: true });
    const ids = sheet(store).reminders.map((row) => row.id);
    expect(ids.slice(0, 2)).toEqual(['a', 'c']);
    expect(ids).toHaveLength(10);
  });

  it('a rotation recorded mid-sync is never overwritten by its old due date (review of #1039)', async () => {
    // The sync reads the sheet and then the register; between its read of
    // the register and its write, the owner records a new date and that
    // record's own sync completes. This sync's write must lose and go round
    // again with the new date, never put the old one back.
    const store = seeded([ownerRow('a')], { 'lab-agent-certificate': { rotatedOn: '2026-01-01' } });
    const realRead = store.readDoc.getMockImplementation();
    let interleaved = false;
    store.readDoc.mockImplementation(async (container, id, pk) => {
      const doc = await realRead(container, id, pk);
      if (id === 'credential_register' && !interleaved) {
        interleaved = true;
        await recordRotation(store, {
          credentialId: 'lab-agent-certificate',
          rotatedOn: '2026-09-29',
          actor: 'owner',
          at: NOW.toISOString(),
        });
        await syncCredentialReminders({ store, now });
      }
      return doc;
    });
    const result = await syncCredentialReminders({ store, now, sleep: noSleep });
    expect(result).toMatchObject({ synced: true });
    expect(rowsOf(store)['credential-lab-agent-certificate'].dueDate).toBe('2027-03-28');
    // It went round: the register was read again after the interleaved record.
    expect(store.readDoc.mock.calls.filter((call) => call[1] === 'credential_register').length).toBeGreaterThanOrEqual(3);
  });

  it('leaves a sheet that does not validate alone, and says so without quoting it', async () => {
    const store = seeded([{ id: 'broken', title: '' }]);
    const log = { warn: vi.fn() };
    expect(await syncCredentialReminders({ store, now, log })).toEqual({ synced: false, reason: 'invalid' });
    expect(sheet(store).reminders).toEqual([{ id: 'broken', title: '' }]);
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn.mock.calls[0][0]).not.toContain('broken');
  });

  it('leaves the sheet alone when the credential rows would pass its limit', async () => {
    const full = Array.from({ length: MAX_REMINDERS - 2 }, (_, i) => ownerRow(`r${i}`));
    const store = seeded(full);
    expect(await syncCredentialReminders({ store, now, log: {} })).toEqual({ synced: false, reason: 'invalid' });
    expect(sheet(store).reminders).toHaveLength(MAX_REMINDERS - 2);
  });

  it('waits while a source its dates depend on cannot be read', async () => {
    const store = seeded(null);
    store.fail('admin_config', 'secret_state', 'readDoc', Object.assign(new Error('x'), { code: 503 }));
    const log = { warn: vi.fn() };
    expect(await syncCredentialReminders({ store, now, log })).toEqual({ synced: false, reason: 'unreadable' });
    expect(sheet(store)).toBeNull();
    // Counts only: no source id, no credential name in the line.
    expect(log.warn.mock.calls[0][0]).toBe(
      '[credentialReminders] 1 source(s) could not be read; reminders left as they are'
    );
  });

  it('leaves every credential row in place when a date source is present but malformed (review of #1039)', async () => {
    const store = seeded(null);
    await syncCredentialReminders({ store, now });
    const before = sheet(store).reminders;
    await store.replaceDocIfMatch('admin_config', {
      ...store.get('admin_config', 'credential_register'),
      credentials: 'hand-edited',
    });
    expect(await syncCredentialReminders({ store, now, log: {} })).toEqual({ synced: false, reason: 'unreadable' });
    expect(sheet(store).reminders).toEqual(before);
  });

  it('still syncs when only an MCP record or the Coder report is unreadable', async () => {
    const store = seeded(null);
    store.fail('mcp_servers', '*', 'queryDocs', Object.assign(new Error('x'), { code: 503 }));
    store.fail('admin_config', 'coder_automation', 'readDoc', Object.assign(new Error('x'), { code: 503 }));
    expect(await syncCredentialReminders({ store, now })).toMatchObject({ synced: true, reminders: 8 });
  });

  it('gives up after its attempts when the sheet keeps changing', async () => {
    const store = seeded([ownerRow('a')]);
    store.fail('admin_config', 'reminders', 'replaceDocIfMatch', Object.assign(new Error('x'), { code: 412 }), 2);
    const log = { warn: vi.fn() };
    expect(await syncCredentialReminders({ store, now, log, attempts: 2, sleep: noSleep })).toEqual({
      synced: false,
      reason: 'conflict',
    });
  });

  it('throws a store error that is not a lost race', async () => {
    const store = seeded([ownerRow('a')]);
    store.fail('admin_config', 'reminders', 'replaceDocIfMatch', Object.assign(new Error('x'), { code: 500 }));
    await expect(syncCredentialReminders({ store, now, sleep: noSleep })).rejects.toMatchObject({ code: 500 });
  });
});
