/**
 * The calendar file built from the alerts: valid iCalendar lines, the right
 * events, nothing for a finished alert, and a download that has no address.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ICS_FILENAME,
  buildIcs,
  downloadIcs,
  escapeIcsText,
  foldIcsLine,
} from './calendarAlertsIcs';

const NOW = new Date('2026-10-26T09:05:07.123Z');

const alert = (over = {}) => ({
  id: 'docker-dsos-application',
  title: 'Submit the Docker-Sponsored Open Source application',
  dueDate: '2026-10-30',
  dueTime: null,
  link: 'https://www.docker.com/community/open-source/application/',
  note: 'Text is ready to paste in the Doc Vault note: Docker DSOS application',
  state: 'open',
  ...over,
});

const lines = (text) => text.split('\r\n');
const unfold = (text) => text.replace(/\r\n /g, '');

describe('buildIcs', () => {
  it('wraps events in a calendar and ends every line with CRLF', () => {
    const text = buildIcs([alert()], NOW);
    expect(text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(text).not.toMatch(/[^\r]\n/);
    expect(lines(text)).toContain('PRODID:-//HybridCloudWorks//Calendar Alerts//EN');
  });

  it('makes an all-day event for an alert with no time, ending the next day', () => {
    const text = unfold(buildIcs([alert()], NOW));
    expect(text).toContain('UID:docker-dsos-application@calendar-alerts.hybridcloudworks.com');
    expect(text).toContain('DTSTAMP:20261026T090507Z');
    expect(text).toContain('DTSTART;VALUE=DATE:20261030');
    expect(text).toContain('DTEND;VALUE=DATE:20261031');
    expect(text).toContain('SUMMARY:Submit the Docker-Sponsored Open Source application');
    expect(text).toContain('URL:https://www.docker.com/community/open-source/application/');
  });

  it('ends an all-day event on the first of the next month and the next year', () => {
    expect(buildIcs([alert({ dueDate: '2026-10-31' })], NOW)).toContain(
      'DTEND;VALUE=DATE:20261101'
    );
    expect(buildIcs([alert({ dueDate: '2026-12-31' })], NOW)).toContain(
      'DTEND;VALUE=DATE:20270101'
    );
  });

  it('makes a 30-minute UTC event for an alert with a time, across midnight too', () => {
    const text = buildIcs([alert({ dueTime: '14:30' })], NOW);
    expect(text).toContain('DTSTART:20261030T143000Z');
    expect(text).toContain('DTEND:20261030T150000Z');
    const late = buildIcs([alert({ dueTime: '23:45' })], NOW);
    expect(late).toContain('DTSTART:20261030T234500Z');
    expect(late).toContain('DTEND:20261031T001500Z');
  });

  it('leaves out an alert that is done, and keeps one that is snoozed', () => {
    const text = buildIcs(
      [
        alert({ id: 'open-1' }),
        alert({ id: 'done-1', state: 'done' }),
        alert({ id: 'snoozed-1', state: 'snoozed' }),
      ],
      NOW
    );
    expect(text).toContain('UID:open-1@');
    expect(text).toContain('UID:snoozed-1@');
    expect(text).not.toContain('UID:done-1@');
    expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(2);
  });

  it('is a valid empty calendar when there is nothing to export', () => {
    expect(buildIcs([], NOW)).not.toContain('VEVENT');
    expect(buildIcs([alert({ state: 'done' })], NOW)).not.toContain('VEVENT');
  });

  it('escapes the characters iCalendar reserves, so a note cannot add properties', () => {
    const text = unfold(
      buildIcs(
        [alert({ title: 'A, B; C\\D', note: 'line one\nEND:VEVENT\nline three', link: '' })],
        NOW
      )
    );
    expect(text).toContain('SUMMARY:A\\, B\\; C\\\\D');
    expect(text).toContain('DESCRIPTION:line one\\nEND:VEVENT\\nline three');
    expect(text.match(/END:VEVENT/g)).toHaveLength(2); // the event's own, and the escaped one inside the text
    expect(lines(text).filter((line) => line === 'END:VEVENT')).toHaveLength(1);
  });

  it('puts the note and the link in the description, and a URL only for an https link', () => {
    const text = unfold(buildIcs([alert()], NOW));
    expect(text).toContain(
      'DESCRIPTION:Text is ready to paste in the Doc Vault note: Docker DSOS application\\nhttps://www.docker.com/community/open-source/application/'
    );
    const portal = buildIcs([alert({ link: '/admin/health', note: '' })], NOW);
    expect(portal).toContain('DESCRIPTION:/admin/health');
    expect(portal).not.toContain('URL:');
  });

  it('keeps every line within 75 octets, counting letters that take more than one', () => {
    const text = buildIcs([alert({ title: 'Ünïcödé '.repeat(30), note: 'é'.repeat(200) })], NOW);
    const encoder = new TextEncoder();
    for (const line of lines(text)) expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
    const rebuilt = unfold(text);
    expect(rebuilt).toContain(`SUMMARY:${'Ünïcödé '.repeat(30)}`);
    expect(rebuilt).toContain(`DESCRIPTION:${'é'.repeat(200)}`);
  });
});

describe('what a title, note or stored row cannot do to the file', () => {
  const NEL = String.fromCharCode(0x85);
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  const FS = String.fromCharCode(0x1c);

  it('turns every kind of line end into an escaped break, so no property can start inside a title', () => {
    const text = buildIcs(
      [
        alert({
          title: `Pay${LS}BEGIN:VALARM${NEL}ACTION:DISPLAY`,
          note: `a${PS}ATTACH:http://evil.example`,
        }),
      ],
      NOW
    );
    expect(
      lines(unfold(text)).filter((line) => /^(BEGIN:VALARM|ACTION|ATTACH)/.test(line))
    ).toEqual([]);
    expect(unfold(text)).toContain('SUMMARY:Pay\\nBEGIN:VALARM\\nACTION:DISPLAY');
    expect(unfold(text)).toContain('DESCRIPTION:a\\nATTACH:http://evil.example');
  });

  it('drops control characters from the words', () => {
    const text = unfold(
      buildIcs([alert({ title: `A${FS}B${String.fromCharCode(0)}C`, link: '' })], NOW)
    );
    expect(text).toContain('SUMMARY:ABC');
  });

  it('writes no link that the portal would not open, and no URL line for a portal page', () => {
    const hostile = `https://x.example/a${String.fromCharCode(13, 10)}ATTACH:http://evil.example`;
    const text = buildIcs([alert({ link: hostile, note: '' })], NOW);
    expect(text).not.toContain('ATTACH');
    expect(text).not.toContain('URL:');
    expect(text).not.toContain('DESCRIPTION');
  });

  it('treats a stored time that is not HH:MM as no time, rather than failing', () => {
    expect(() => buildIcs([alert({ dueTime: 'zz' })], NOW)).not.toThrow();
    expect(buildIcs([alert({ dueTime: 'zz' })], NOW)).toContain('DTSTART;VALUE=DATE:20261030');
    expect(buildIcs([alert({ dueTime: '25:00' })], NOW)).toContain('DTSTART;VALUE=DATE:20261030');
  });

  it('leaves out a row with no real day instead of failing', () => {
    expect(() => buildIcs([alert({ dueDate: 'soon' })], NOW)).not.toThrow();
    expect(buildIcs([alert({ dueDate: 'soon' })], NOW)).not.toContain('VEVENT');
  });
});

describe('escapeIcsText and foldIcsLine', () => {
  it('escapes backslash first, so an escape is not escaped twice', () => {
    expect(escapeIcsText('a\\b;c,d\ne')).toBe('a\\\\b\\;c\\,d\\ne');
    expect(escapeIcsText('a\r\nb\rc')).toBe('a\\nb\\nc');
    expect(escapeIcsText(null)).toBe('');
  });

  it('leaves a short line alone and folds a long one onto space-led lines', () => {
    expect(foldIcsLine('SHORT')).toBe('SHORT');
    const folded = foldIcsLine(`X:${'a'.repeat(200)}`);
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts.slice(1)) expect(part.startsWith(' ')).toBe(true);
    expect(folded.replace(/\r\n /g, '')).toBe(`X:${'a'.repeat(200)}`);
  });
});

describe('downloadIcs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('saves the text through a link to memory and then lets the address go', () => {
    vi.useFakeTimers();
    const created = [];
    URL.createObjectURL = vi.fn((blob) => {
      created.push(blob);
      return 'blob:mem/1';
    });
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      expect(this.href).toBe('blob:mem/1');
      expect(this.download).toBe(ICS_FILENAME);
    });

    downloadIcs('BEGIN:VCALENDAR\r\n');

    expect(click).toHaveBeenCalledTimes(1);
    expect(created[0].type).toBe('text/calendar;charset=utf-8');
    expect(document.querySelector('a[download]')).toBeNull();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mem/1');
    vi.useRealTimers();
  });
});
