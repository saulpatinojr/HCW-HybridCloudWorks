/**
 * The browser's side of Calendar Alerts: which alerts the pop-up lists, how a
 * due date reads, which link may be opened, and the once-a-day memory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getJSON = vi.fn();
const sendJSON = vi.fn();
vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  sendJSON: (...args) => sendJSON(...args),
}));

import {
  CALENDAR_ALERTS_ROUTE,
  PROMPT_DAY_KEY,
  PROMPT_SESSION_KEY,
  compareAlerts,
  countByFilter,
  createCalendarAlert,
  deleteCalendarAlert,
  describeDue,
  describeWhen,
  fetchCalendarAlerts,
  filterAlerts,
  formatDay,
  isDueSoon,
  markPromptShown,
  resetPromptMemory,
  safeAlertLink,
  selectPromptAlerts,
  shouldShowPrompt,
  simulatePageReload,
  updateCalendarAlert,
} from './calendarAlerts';

const alert = (over = {}) => ({
  id: 'a1',
  title: 'Renew the domain',
  dueDate: '2026-10-30',
  dueTime: null,
  link: '',
  note: '',
  status: 'open',
  snoozedUntil: null,
  doneAt: null,
  state: 'open',
  daysUntilDue: 4,
  ...over,
});

beforeEach(() => {
  getJSON.mockReset();
  sendJSON.mockReset();
});

describe('the API', () => {
  it('reads the list from the admin route and returns the day and the alerts', async () => {
    getJSON.mockResolvedValue({ ok: true, today: '2026-10-26', alerts: [alert()], total: 1 });
    await expect(fetchCalendarAlerts()).resolves.toEqual({
      today: '2026-10-26',
      alerts: [alert()],
    });
    expect(getJSON).toHaveBeenCalledWith('cms/calendar-alerts');
    expect(CALENDAR_ALERTS_ROUTE).toBe('cms/calendar-alerts');
  });

  it.each([
    ['nothing', undefined],
    ['an HTML page', '<html>bad gateway</html>'],
    ['no alerts list', { today: '2026-10-26' }],
    ['no day', { alerts: [] }],
  ])('refuses %s instead of reading it as "no alerts"', async (_name, body) => {
    getJSON.mockResolvedValue(body);
    await expect(fetchCalendarAlerts()).rejects.toThrow(/expected shape/);
  });

  it('creates, updates and deletes through the alert routes', async () => {
    sendJSON.mockResolvedValue({ ok: true, alert: alert() });
    await expect(createCalendarAlert({ title: 'T', dueDate: '2026-11-01' })).resolves.toEqual(
      alert()
    );
    expect(sendJSON).toHaveBeenLastCalledWith('cms/calendar-alerts', 'POST', {
      title: 'T',
      dueDate: '2026-11-01',
    });

    await updateCalendarAlert('a 1/2', { done: true });
    expect(sendJSON).toHaveBeenLastCalledWith('cms/calendar-alerts/a%201%2F2', 'PATCH', {
      done: true,
    });

    sendJSON.mockResolvedValue({ ok: true, id: 'a1' });
    await deleteCalendarAlert('a1');
    expect(sendJSON).toHaveBeenLastCalledWith('cms/calendar-alerts/a1', 'DELETE');
  });

  it('refuses a save answer that carries no alert', async () => {
    sendJSON.mockResolvedValue({ ok: true });
    await expect(createCalendarAlert({})).rejects.toThrow(/expected shape/);
    await expect(updateCalendarAlert('a1', {})).rejects.toThrow(/expected shape/);
  });
});

describe('which alerts the pop-up lists', () => {
  const week = [
    alert({ id: 'overdue', dueDate: '2026-10-24', daysUntilDue: -2 }),
    alert({ id: 'today', dueDate: '2026-10-26', daysUntilDue: 0 }),
    alert({ id: 'edge', dueDate: '2026-11-02', daysUntilDue: 7 }),
    alert({ id: 'later', dueDate: '2026-11-03', daysUntilDue: 8 }),
    alert({ id: 'snoozed', state: 'snoozed', status: 'snoozed', daysUntilDue: 1 }),
    alert({ id: 'done', state: 'done', status: 'done', daysUntilDue: 0 }),
  ];

  it('is open alerts due within 7 days, and every overdue one', () => {
    expect(selectPromptAlerts(week).map((a) => a.id)).toEqual(['overdue', 'today', 'edge']);
  });

  it('leaves out an alert whose days are unknown', () => {
    expect(isDueSoon(alert({ daysUntilDue: null }))).toBe(false);
    expect(isDueSoon(alert({ daysUntilDue: undefined }))).toBe(false);
  });

  it('lists soonest first, whatever order it was given', () => {
    const shuffled = [week[2], week[0], week[1]];
    expect(selectPromptAlerts(shuffled).map((a) => a.id)).toEqual(['overdue', 'today', 'edge']);
  });

  it('puts an all-day alert before a timed one on the same day, then by title', () => {
    const rows = [
      alert({ id: 'b', dueTime: '09:00' }),
      alert({ id: 'c', title: 'Zebra' }),
      alert({ id: 'a', title: 'Apple' }),
    ];
    expect(rows.sort(compareAlerts).map((a) => a.id)).toEqual(['a', 'c', 'b']);
  });

  it('does not change the list it was given', () => {
    const copy = [...week];
    selectPromptAlerts(week);
    expect(week).toEqual(copy);
  });
});

describe('the page filters', () => {
  const rows = [
    alert({ id: 'soon', daysUntilDue: 2 }),
    alert({ id: 'far', daysUntilDue: 30 }),
    alert({ id: 'sn', state: 'snoozed', status: 'snoozed' }),
    alert({ id: 'dn', state: 'done', status: 'done' }),
  ];

  it.each([
    ['open', ['soon', 'far']],
    ['due-soon', ['soon']],
    ['snoozed', ['sn']],
    ['done', ['dn']],
    ['all', ['soon', 'far', 'sn', 'dn']],
    ['anything else', ['soon', 'far', 'sn', 'dn']],
  ])('%s shows %j', (filter, ids) => {
    expect(filterAlerts(rows, filter).map((a) => a.id)).toEqual(ids);
  });

  it('counts each filter for its label', () => {
    expect(countByFilter(rows)).toEqual({ open: 2, 'due-soon': 1, snoozed: 1, done: 1, all: 4 });
  });
});

describe('how a due date reads', () => {
  it.each([
    [alert({ daysUntilDue: -1 }), '1 day overdue', 'overdue'],
    [alert({ daysUntilDue: -3 }), '3 days overdue', 'overdue'],
    [alert({ daysUntilDue: 0 }), 'Due today', 'today'],
    [alert({ daysUntilDue: 1 }), 'Due tomorrow', 'soon'],
    [alert({ daysUntilDue: 4 }), 'Due in 4 days', 'soon'],
    [alert({ daysUntilDue: 7 }), 'Due in 7 days', 'soon'],
    [alert({ daysUntilDue: 8 }), 'Due in 8 days', 'later'],
    [alert({ state: 'done' }), 'Done', 'done'],
    [
      alert({ state: 'snoozed', snoozedUntil: '2026-10-29' }),
      'Snoozed until Thu, 29 Oct 2026',
      'snoozed',
    ],
    [alert({ daysUntilDue: null }), 'No date', 'later'],
  ])('%#: says %s', (row, text, tone) => {
    expect(describeDue(row)).toEqual({ text, tone });
  });

  it('shows a day on the UTC day it names, in every time zone', () => {
    expect(formatDay('2026-10-30')).toBe('Fri, 30 Oct 2026');
    expect(formatDay('2026-01-01')).toBe('Thu, 1 Jan 2026');
    expect(formatDay('not a day')).toBe('not a day');
  });

  it('adds the UTC time when there is one', () => {
    expect(describeWhen(alert())).toBe('Fri, 30 Oct 2026');
    expect(describeWhen(alert({ dueTime: '14:30' }))).toBe('Fri, 30 Oct 2026, 14:30 UTC');
  });
});

describe('safeAlertLink', () => {
  it('opens an https address in a new tab and a portal page in the portal', () => {
    expect(safeAlertLink('https://www.docker.com/community/open-source/application/')).toEqual({
      kind: 'external',
      href: 'https://www.docker.com/community/open-source/application/',
      host: 'docker.com',
    });
    expect(safeAlertLink('https://learn.microsoft.com/azure/')).toMatchObject({
      host: 'learn.microsoft.com',
    });
    expect(safeAlertLink('/admin/health')).toEqual({ kind: 'admin', href: '/admin/health' });
    expect(safeAlertLink('/admin/platform-settings?tab=reminders')).toEqual({
      kind: 'admin',
      href: '/admin/platform-settings?tab=reminders',
    });
    expect(safeAlertLink('/admin')).toEqual({ kind: 'admin', href: '/admin' });
  });

  it.each([
    ['empty', ''],
    ['not a string', null],
    ['http', 'http://example.com'],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,<b>x</b>'],
    ['protocol-relative', '//evil.example/admin'],
    ['outside /admin', '/somewhere'],
    ['climbing out of /admin', '/admin/../etc'],
    ['credentials in the address', 'https://user:pass@example.com/'],
    ['a space', 'https://example.com/a b'],
    ['a quote', 'https://example.com/"x'],
    ['a query that carries an address', '/admin?next=https://evil.example'],
    ['not an address', 'example.com'],
    ['the OAuth callback', '/admin/ai-engine/oauth/callback?code=x&state=y'],
    ['an OAuth segment anywhere', '/admin/oauth'],
    ['a next-line character', `https://example.com/a${String.fromCharCode(0x85)}b`],
    ['a line separator', `https://example.com/a${String.fromCharCode(0x2028)}b`],
    ['a control character', `https://example.com/a${String.fromCharCode(0x1c)}b`],
    ['a letter outside ASCII', `https://ex${String.fromCharCode(0xe4)}mple.com/`],
  ])('refuses %s', (_name, link) => {
    expect(safeAlertLink(link)).toBeNull();
  });
});

describe('once per session and once per day', () => {
  beforeEach(() => resetPromptMemory());
  afterEach(() => {
    vi.restoreAllMocks();
    resetPromptMemory();
  });

  it('may show on the first look, then not again in the session or the day', () => {
    expect(shouldShowPrompt('2026-10-26')).toBe(true);
    markPromptShown('2026-10-26');
    expect(shouldShowPrompt('2026-10-26')).toBe(false);
    expect(window.sessionStorage.getItem(PROMPT_SESSION_KEY)).toBe('1');
    expect(window.localStorage.getItem(PROMPT_DAY_KEY)).toBe('2026-10-26');
  });

  it('does not show in a new session on the same day', () => {
    markPromptShown('2026-10-26');
    window.sessionStorage.removeItem(PROMPT_SESSION_KEY);
    simulatePageReload();
    expect(shouldShowPrompt('2026-10-26')).toBe(false);
  });

  it('shows again in a new session on the next day', () => {
    markPromptShown('2026-10-26');
    window.sessionStorage.removeItem(PROMPT_SESSION_KEY);
    simulatePageReload();
    expect(shouldShowPrompt('2026-10-27')).toBe(true);
  });

  it('does not show twice in one session even on a new day', () => {
    markPromptShown('2026-10-26');
    simulatePageReload();
    expect(shouldShowPrompt('2026-10-27')).toBe(false);
  });

  it('falls back to once per page load when the browser blocks storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(shouldShowPrompt('2026-10-26')).toBe(true);
    expect(() => markPromptShown('2026-10-26')).not.toThrow();
    expect(shouldShowPrompt('2026-10-26')).toBe(false);
  });
});
