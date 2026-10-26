/**
 * The calendar alert model: what a request may say, how a patch changes a
 * row, what the portal is told, and the seed that makes the first alert.
 */
import { describe, expect, it } from 'vitest';

import {
  CalendarAlertValidationError,
  MAX_LINK_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_TITLE_LENGTH,
  SEED_ALERTS,
  alertState,
  applyPatch,
  applySeeds,
  compareAlerts,
  isAlertId,
  isSeedId,
  isStoredAlert,
  newAlert,
  parseCreateBody,
  parsePatchBody,
  presentAlert,
  readState,
  withoutAlert,
} from './model.js';

const AT = '2026-10-26T09:00:00.000Z';
const TODAY = '2026-10-26';

const base = { title: 'Renew the domain', dueDate: '2026-11-02' };

const refused = (fn) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CalendarAlertValidationError);
    return error.message;
  }
  throw new Error('expected a refusal');
};

describe('parseCreateBody', () => {
  it('takes a title and a day, with the rest empty', () => {
    expect(parseCreateBody(base)).toEqual({
      title: 'Renew the domain',
      dueDate: '2026-11-02',
      dueTime: null,
      link: '',
      note: '',
    });
  });

  it('trims text and keeps a time, a link and a note', () => {
    const fields = parseCreateBody({
      title: '  Call the registrar  ',
      dueDate: '2026-11-02',
      dueTime: '14:30',
      link: ' https://example.com/renew?x=1 ',
      note: '  Ask for the transfer code. ',
    });
    expect(fields).toEqual({
      title: 'Call the registrar',
      dueDate: '2026-11-02',
      dueTime: '14:30',
      link: 'https://example.com/renew?x=1',
      note: 'Ask for the transfer code.',
    });
  });

  it('refuses a body that is not an object, and a key it does not know', () => {
    expect(refused(() => parseCreateBody(null))).toMatch(/JSON object/);
    expect(refused(() => parseCreateBody([]))).toMatch(/JSON object/);
    expect(refused(() => parseCreateBody({ ...base, status: 'done' }))).toMatch(/Unknown field/);
  });

  it('refuses a missing, blank, long or multi-line title', () => {
    expect(refused(() => parseCreateBody({ dueDate: base.dueDate }))).toMatch(/title/);
    expect(refused(() => parseCreateBody({ ...base, title: '   ' }))).toMatch(/title/);
    expect(refused(() => parseCreateBody({ ...base, title: 42 }))).toMatch(/title/);
    expect(
      refused(() => parseCreateBody({ ...base, title: 'x'.repeat(MAX_TITLE_LENGTH + 1) }))
    ).toMatch(/longer/);
    expect(refused(() => parseCreateBody({ ...base, title: 'two\nlines' }))).toMatch(/single line/);
    expect(parseCreateBody({ ...base, title: 'x'.repeat(MAX_TITLE_LENGTH) }).title).toHaveLength(
      MAX_TITLE_LENGTH
    );
  });

  it('refuses a day that is not a real date, or is out of range', () => {
    for (const dueDate of [undefined, '', '2026-02-30', '2026-13-01', '26-10-30', '2026-10-30T10:00', 20261030]) {
      expect(refused(() => parseCreateBody({ ...base, dueDate })), String(dueDate)).toMatch(
        /dueDate/
      );
    }
    expect(refused(() => parseCreateBody({ ...base, dueDate: '1999-12-31' }))).toMatch(/between/);
    expect(refused(() => parseCreateBody({ ...base, dueDate: '2101-01-01' }))).toMatch(/between/);
  });

  it('accepts a time of 00:00 to 23:59 and treats blank as no time', () => {
    for (const dueTime of ['00:00', '09:05', '23:59']) {
      expect(parseCreateBody({ ...base, dueTime }).dueTime).toBe(dueTime);
    }
    for (const dueTime of [undefined, null, '', '  ']) {
      expect(parseCreateBody({ ...base, dueTime }).dueTime).toBeNull();
    }
    for (const dueTime of ['24:00', '9:05', '12:60', '12:30:00', 'noon', 1230]) {
      expect(refused(() => parseCreateBody({ ...base, dueTime })), String(dueTime)).toMatch(
        /dueTime/
      );
    }
  });

  describe('link', () => {
    it('accepts an https address and a page inside /admin', () => {
      for (const link of [
        'https://www.docker.com/community/open-source/application/',
        'https://example.com',
        '/admin',
        '/admin/calendar',
        '/admin/platform-settings?tab=reminders',
        '/admin/review-queue/abc-123/',
      ]) {
        expect(parseCreateBody({ ...base, link }).link, link).toBe(link);
      }
    });

    it('treats blank as no link', () => {
      for (const link of [undefined, null, '', '   ']) {
        expect(parseCreateBody({ ...base, link }).link).toBe('');
      }
    });

    it('refuses everything else', () => {
      for (const link of [
        'http://example.com',
        'javascript:alert(1)',
        'data:text/html,<b>x</b>',
        'ftp://example.com/file',
        '//evil.example/admin',
        '/administrator',
        '/other/page',
        '/admin/../secret',
        '/admin/..',
        '/admin/a b',
        '/admin/<script>',
        '/admin?next=https://evil.example',
        '/admin/ai-engine/OAuth/callback',
        '/admin/ai-engine/OAUTH/callback?error=x&error_description=hello',
        '/admin/some-page/callback',
        '/admin/ai-engine/oauth/callback',
        '/admin/ai-engine/oauth/callback?code=x&state=y',
        '/admin/oauth',
        'https://user:pass@example.com/',
        'https://example.com/a b',
        'https://exa mple.com',
        'https://',
        'example.com/page',
        '\\\\server\\share',
        42,
      ]) {
        expect(refused(() => parseCreateBody({ ...base, link })), String(link)).toMatch(/link/);
      }
      expect(
        refused(() => parseCreateBody({ ...base, link: `https://example.com/${'a'.repeat(MAX_LINK_LENGTH)}` }))
      ).toMatch(/too long/);
    });
  });

  it('refuses the characters some calendar programs read as a line end', () => {
    const separators = [0x85, 0x2028, 0x2029, 0x9f, 0x1c].map((code) => String.fromCharCode(code));
    for (const character of separators) {
      expect(refused(() => parseCreateBody({ ...base, title: 'a' + character + 'b' }))).toMatch(
        /title/
      );
      expect(refused(() => parseCreateBody({ ...base, note: 'a' + character + 'b' }))).toMatch(
        /plain text/
      );
      expect(
        refused(() => parseCreateBody({ ...base, link: 'https://example.com/a' + character + 'b' }))
      ).toMatch(/link/);
    }
    expect(
      refused(() => parseCreateBody({ ...base, link: 'https://example.com/' + String.fromCharCode(0x7f) }))
    ).toMatch(/link/);
    expect(refused(() => parseCreateBody({ ...base, link: 'https://ex' + String.fromCharCode(0xe4) + 'mple.com/' }))).toMatch(/link/);
  });

  it('keeps a note to 500 characters of plain text, line breaks allowed', () => {
    expect(parseCreateBody({ ...base, note: 'one\ntwo\tthree' }).note).toBe('one\ntwo\tthree');
    expect(parseCreateBody({ ...base, note: 'x'.repeat(MAX_NOTE_LENGTH) }).note).toHaveLength(
      MAX_NOTE_LENGTH
    );
    expect(refused(() => parseCreateBody({ ...base, note: 'x'.repeat(MAX_NOTE_LENGTH + 1) }))).toMatch(
      /note/
    );
    expect(refused(() => parseCreateBody({ ...base, note: 'bell\u0007' }))).toMatch(/plain text/);
    expect(refused(() => parseCreateBody({ ...base, note: 5 }))).toMatch(/note/);
  });
});

describe('parsePatchBody', () => {
  it('needs at least one field and knows only the editable ones', () => {
    expect(refused(() => parsePatchBody({}))).toMatch(/at least one/);
    expect(refused(() => parsePatchBody(null))).toMatch(/JSON object/);
    expect(refused(() => parsePatchBody({ status: 'done' }))).toMatch(/Unknown field/);
    expect(refused(() => parsePatchBody({ id: 'x' }))).toMatch(/Unknown field/);
    expect(refused(() => parsePatchBody({ snoozedUntil: '2026-11-01' }))).toMatch(/Unknown field/);
  });

  it('checks each edited field the way a create does', () => {
    expect(parsePatchBody({ title: ' New ', dueDate: '2026-12-01', dueTime: null, link: '', note: '' }))
      .toEqual({ edits: { title: 'New', dueDate: '2026-12-01', dueTime: null, link: '', note: '' } });
    expect(refused(() => parsePatchBody({ title: '' }))).toMatch(/title/);
    expect(refused(() => parsePatchBody({ dueDate: '2026-02-30' }))).toMatch(/dueDate/);
    expect(refused(() => parsePatchBody({ link: 'http://x.example' }))).toMatch(/link/);
  });

  it('takes done as a boolean and snoozeDays as a whole number from 0 to 30', () => {
    expect(parsePatchBody({ done: true })).toEqual({ edits: {}, done: true });
    expect(parsePatchBody({ done: false })).toEqual({ edits: {}, done: false });
    expect(parsePatchBody({ snoozeDays: 3 })).toEqual({ edits: {}, snoozeDays: 3 });
    expect(parsePatchBody({ snoozeDays: 0 })).toEqual({ edits: {}, snoozeDays: 0 });
    expect(refused(() => parsePatchBody({ done: 'yes' }))).toMatch(/done/);
    expect(refused(() => parsePatchBody({ done: 1 }))).toMatch(/done/);
    for (const snoozeDays of [-1, 31, 1.5, '3', null]) {
      expect(refused(() => parsePatchBody({ snoozeDays })), String(snoozeDays)).toMatch(/snoozeDays/);
    }
  });

  it('refuses done and a snooze in one request, but allows done with snooze cleared', () => {
    expect(refused(() => parsePatchBody({ done: true, snoozeDays: 3 }))).toMatch(/done and snoozed/);
    expect(parsePatchBody({ done: true, snoozeDays: 0 })).toEqual({
      edits: {},
      done: true,
      snoozeDays: 0,
    });
  });
});

describe('applyPatch', () => {
  const open = () => newAlert(parseCreateBody({ ...base, link: 'https://example.com' }), { id: 'a1', at: '2026-10-01T00:00:00.000Z' });
  const apply = (row, body) => applyPatch(row, parsePatchBody(body), { today: TODAY, at: AT });

  it('starts open, with no snooze and no finish time', () => {
    expect(open()).toMatchObject({ status: 'open', snoozedUntil: null, doneAt: null });
  });

  it('edits fields and stamps updatedAt, leaving id and createdAt alone', () => {
    const next = apply(open(), { title: 'Renewed', note: 'Done on the phone' });
    expect(next).toMatchObject({
      id: 'a1',
      title: 'Renewed',
      note: 'Done on the phone',
      dueDate: '2026-11-02',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: AT,
    });
  });

  it('marks done, then reopens', () => {
    const done = apply(open(), { done: true });
    expect(done).toMatchObject({ status: 'done', doneAt: AT, snoozedUntil: null });
    expect(apply(done, { done: false })).toMatchObject({ status: 'open', doneAt: null });
  });

  it('snoozes to today plus the days, and clears the snooze with 0', () => {
    expect(apply(open(), { snoozeDays: 1 })).toMatchObject({ status: 'snoozed', snoozedUntil: '2026-10-27' });
    expect(apply(open(), { snoozeDays: 3 })).toMatchObject({ snoozedUntil: '2026-10-29' });
    expect(apply(open(), { snoozeDays: 7 })).toMatchObject({ snoozedUntil: '2026-11-02' });
    const snoozed = apply(open(), { snoozeDays: 3 });
    expect(apply(snoozed, { snoozeDays: 0 })).toMatchObject({ status: 'open', snoozedUntil: null });
  });

  it('counts a snooze across a month and year end', () => {
    const next = applyPatch(open(), parsePatchBody({ snoozeDays: 7 }), { today: '2026-12-29', at: AT });
    expect(next.snoozedUntil).toBe('2027-01-05');
  });

  it('marking a snoozed alert done drops the snooze', () => {
    const snoozed = apply(open(), { snoozeDays: 3 });
    expect(apply(snoozed, { done: true })).toMatchObject({ status: 'done', snoozedUntil: null });
  });

  it('refuses to snooze a finished alert, but reopening and snoozing in one request works', () => {
    const done = apply(open(), { done: true });
    expect(refused(() => apply(done, { snoozeDays: 3 }))).toMatch(/reopen/);
    expect(apply(done, { done: false, snoozeDays: 3 })).toMatchObject({
      status: 'snoozed',
      snoozedUntil: '2026-10-29',
    });
  });
});

describe('alertState and presentAlert', () => {
  const row = (over = {}) => ({
    ...newAlert(parseCreateBody(base), { id: 'a1', at: AT }),
    ...over,
  });

  it('is open, snoozed or done, and a snooze ends on its day', () => {
    expect(alertState(row(), TODAY)).toBe('open');
    expect(alertState(row({ status: 'done' }), TODAY)).toBe('done');
    expect(alertState(row({ status: 'snoozed', snoozedUntil: '2026-10-27' }), TODAY)).toBe('snoozed');
    expect(alertState(row({ status: 'snoozed', snoozedUntil: '2026-10-26' }), TODAY)).toBe('open');
    expect(alertState(row({ status: 'snoozed', snoozedUntil: '2026-10-20' }), TODAY)).toBe('open');
    expect(alertState(row({ status: 'snoozed', snoozedUntil: null }), TODAY)).toBe('open');
  });

  it('returns only the named fields, with the state and the days left', () => {
    const presented = presentAlert(
      row({ _etag: '"x"', _rid: 'r', configScope: 'admin_config', createdBy: 'someone', secret: 's' }),
      TODAY
    );
    expect(Object.keys(presented).sort()).toEqual(
      [
        'id',
        'title',
        'dueDate',
        'dueTime',
        'link',
        'note',
        'status',
        'snoozedUntil',
        'doneAt',
        'createdAt',
        'updatedAt',
        'state',
        'daysUntilDue',
      ].sort()
    );
    expect(presented).toMatchObject({ state: 'open', daysUntilDue: 7 });
  });

  it('counts days from the UTC day, negative when overdue', () => {
    expect(presentAlert(row({ dueDate: '2026-10-26' }), TODAY).daysUntilDue).toBe(0);
    expect(presentAlert(row({ dueDate: '2026-10-25' }), TODAY).daysUntilDue).toBe(-1);
    expect(presentAlert(row({ dueDate: '2026-10-30' }), TODAY).daysUntilDue).toBe(4);
  });

  it('checks a stored time, link, snooze day and the words again on the way out', () => {
    const presented = presentAlert(
      {
        id: 'a1',
        title: 'T' + String.fromCharCode(0x2028) + 'x',
        dueDate: '2026-10-30',
        dueTime: '25:99',
        link: 'javascript:alert(1)',
        note: 'n' + String.fromCharCode(0x85) + 'x',
        status: 'snoozed',
        snoozedUntil: 'someday',
      },
      TODAY
    );
    expect(presented).toMatchObject({
      title: 'T x',
      dueTime: null,
      link: '',
      note: 'n x',
      snoozedUntil: null,
      state: 'open',
    });
  });

  it('cuts a stored title or note back to its limit on the way out', () => {
    const presented = presentAlert(
      {
        id: 'a1',
        title: 'T'.repeat(MAX_TITLE_LENGTH + 100),
        dueDate: '2026-10-30',
        note: 'n'.repeat(MAX_NOTE_LENGTH + 100),
        status: 'open',
      },
      TODAY
    );
    expect(presented.title).toHaveLength(MAX_TITLE_LENGTH);
    expect(presented.note).toHaveLength(MAX_NOTE_LENGTH);
  });

  it('fills a field a hand-made row lacks with its empty value', () => {
    const presented = presentAlert({ id: 'a1', title: 'T', dueDate: '2026-10-30', status: 'open' }, TODAY);
    expect(presented).toMatchObject({ dueTime: null, link: '', note: '', snoozedUntil: null, doneAt: null });
  });
});

describe('isStoredAlert, isAlertId and readState', () => {
  it('recognises a usable row', () => {
    expect(isStoredAlert({ id: 'a', title: 'T', dueDate: '2026-10-30', status: 'open' })).toBe(true);
    for (const bad of [
      null,
      [],
      { id: 'a b', title: 'T', dueDate: '2026-10-30', status: 'open' },
      { id: 'a', title: '', dueDate: '2026-10-30', status: 'open' },
      { id: 'a', title: 'T', dueDate: '2026-02-30', status: 'open' },
      { id: 'a', title: 'T', dueDate: '2026-10-30', status: 'archived' },
    ]) {
      expect(isStoredAlert(bad)).toBe(false);
    }
  });

  it('accepts letters, digits, - and _ up to 64 characters as an id', () => {
    expect(isAlertId('docker-dsos_1')).toBe(true);
    expect(isAlertId('a'.repeat(64))).toBe(true);
    expect(isAlertId('a'.repeat(65))).toBe(false);
    for (const id of ['', 'a/b', 'a b', '../x', undefined, 7]) expect(isAlertId(id)).toBe(false);
  });

  it('reads a missing or malformed document as empty', () => {
    expect(readState(null)).toEqual({ alerts: [], seeded: [] });
    expect(readState({ alerts: 'no', seeded: 5 })).toEqual({ alerts: [], seeded: [] });
    expect(readState({ alerts: [{ id: 'a' }], seeded: ['x', 3, null] })).toEqual({
      alerts: [{ id: 'a' }],
      seeded: ['x'],
    });
  });
});

describe('compareAlerts', () => {
  it('orders by day, then time (none first), then oldest, then id', () => {
    const rows = [
      { id: 'e', dueDate: '2026-10-31', dueTime: null, createdAt: AT },
      { id: 'd', dueDate: '2026-10-30', dueTime: '10:00', createdAt: AT },
      { id: 'c', dueDate: '2026-10-30', dueTime: null, createdAt: '2026-10-27T00:00:00.000Z' },
      { id: 'b', dueDate: '2026-10-30', dueTime: null, createdAt: '2026-10-26T00:00:00.000Z' },
      { id: 'a', dueDate: '2026-10-30', dueTime: null, createdAt: '2026-10-26T00:00:00.000Z' },
    ];
    expect([...rows].sort(compareAlerts).map((row) => row.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('the seed alert', () => {
  it('is the Docker-Sponsored Open Source application, due 30 October 2026, and nothing else', () => {
    expect(SEED_ALERTS).toHaveLength(1);
    expect(SEED_ALERTS[0]).toEqual({
      id: 'docker-dsos-application',
      title: 'Submit the Docker-Sponsored Open Source application',
      dueDate: '2026-10-30',
      dueTime: null,
      link: 'https://www.docker.com/community/open-source/application/',
      note: 'Text is ready to paste in the Doc Vault note: Docker DSOS application',
    });
    expect(isSeedId('docker-dsos-application')).toBe(true);
    expect(isSeedId('anything-else')).toBe(false);
  });

  it('passes the same checks as an alert typed by hand', () => {
    const { id, ...fields } = SEED_ALERTS[0];
    expect(isAlertId(id)).toBe(true);
    expect(parseCreateBody(fields)).toEqual(fields);
  });

  it('is created once, as an open alert', () => {
    const { state, changed } = applySeeds({ alerts: [], seeded: [] }, { at: AT });
    expect(changed).toBe(true);
    expect(state.seeded).toEqual(['docker-dsos-application']);
    expect(state.alerts).toHaveLength(1);
    expect(state.alerts[0]).toMatchObject({
      id: 'docker-dsos-application',
      status: 'open',
      createdAt: AT,
    });
    expect(isStoredAlert(state.alerts[0])).toBe(true);
  });

  it('changes nothing the second time', () => {
    const first = applySeeds({ alerts: [], seeded: [] }, { at: AT });
    const second = applySeeds(first.state, { at: '2026-10-27T00:00:00.000Z' });
    expect(second.changed).toBe(false);
    expect(second.state).toEqual(first.state);
  });

  it('does not make a seed again after it was deleted', () => {
    const first = applySeeds({ alerts: [], seeded: [] }, { at: AT });
    const deleted = withoutAlert(first.state, 'docker-dsos-application');
    expect(deleted.alerts).toEqual([]);
    expect(deleted.seeded).toEqual(['docker-dsos-application']);
    const again = applySeeds(deleted, { at: AT });
    expect(again.changed).toBe(false);
    expect(again.state.alerts).toEqual([]);
  });

  it('records the seed when a row exists but the record does not, without adding a second row', () => {
    const existing = newAlert(SEED_ALERTS[0], { id: SEED_ALERTS[0].id, at: '2026-10-20T00:00:00.000Z' });
    const { state, changed } = applySeeds({ alerts: [existing], seeded: [] }, { at: AT });
    expect(changed).toBe(true);
    expect(state.alerts).toEqual([existing]);
    expect(state.seeded).toEqual(['docker-dsos-application']);
  });

  it('leaves the owner\'s other alerts alone', () => {
    const mine = newAlert(parseCreateBody(base), { id: 'mine', at: AT });
    const { state } = applySeeds({ alerts: [mine], seeded: [] }, { at: AT });
    expect(state.alerts.map((row) => row.id)).toEqual(['mine', 'docker-dsos-application']);
  });
});

describe('withoutAlert', () => {
  it('removes an ordinary alert and records nothing', () => {
    const mine = newAlert(parseCreateBody(base), { id: 'mine', at: AT });
    expect(withoutAlert({ alerts: [mine], seeded: [] }, 'mine')).toEqual({ alerts: [], seeded: [] });
  });

  it('records a seed that was never recorded when it removes the row, so it is not made again', () => {
    const row = newAlert(SEED_ALERTS[0], { id: SEED_ALERTS[0].id, at: AT });
    const removed = withoutAlert({ alerts: [row], seeded: [] }, SEED_ALERTS[0].id);
    expect(removed).toEqual({ alerts: [], seeded: [SEED_ALERTS[0].id] });
    expect(applySeeds(removed, { at: AT }).changed).toBe(false);
  });

  it('does not record a seed twice', () => {
    expect(
      withoutAlert({ alerts: [], seeded: ['docker-dsos-application'] }, 'docker-dsos-application').seeded
    ).toEqual(['docker-dsos-application']);
  });
});
