/**
 * Calendar Alerts → an .ics file the owner can import into a calendar app.
 *
 * Built in the browser from the alerts the page already holds and saved to
 * the owner's own disk, so there is no address anyone else could fetch it
 * from: the file exists only where the owner clicked the button. The format is
 * RFC 5545 (https://www.rfc-editor.org/rfc/rfc5545): CRLF line ends, text
 * escaped, lines folded at 75 octets.
 *
 * Alerts with no time become all-day events; alerts with a time become
 * 30-minute events at that UTC time. An alert marked done is left out.
 */

import { safeAlertLink } from './calendarAlertsLink';

export const ICS_FILENAME = 'hcw-calendar-alerts.ics';
const EVENT_MINUTES = 30;
const encoder = new TextEncoder();

const span = (from, to) => `${String.fromCharCode(from)}-${String.fromCharCode(to)}`;
/** Control characters but the tab and the line break, and the C1 controls but NEL (next). */
const STRIPPED = new RegExp(
  `[${span(0, 8)}${span(0x0b, 0x0c)}${span(0x0e, 0x1f)}${span(0x7f, 0x84)}${span(0x86, 0x9f)}]`,
  'g'
);
/** Characters some calendar programs read as a line end: NEL, and the line and paragraph separators. */
const OTHER_LINE_ENDS = new RegExp(`[${String.fromCharCode(0x85, 0x2028, 0x2029)}]`, 'g');
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * RFC 5545 §3.3.11: backslash, semicolon, comma and line breaks in a text
 * value. Control characters are dropped and the other line ends become the
 * escaped break, so no character of a title or note can start a new property.
 */
export function escapeIcsText(value) {
  return String(value ?? '')
    .replace(STRIPPED, '')
    .replace(OTHER_LINE_ENDS, '\n')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * RFC 5545 §3.1: no line longer than 75 octets; a longer one continues on the
 * next line after a single space. Cuts fall between characters, never inside
 * one, so a multi-byte letter is not broken.
 */
export function foldIcsLine(line) {
  const parts = [];
  let current = '';
  let octets = 0;
  let limit = 75;
  for (const character of line) {
    const size = encoder.encode(character).length;
    if (octets + size > limit) {
      parts.push(current);
      current = '';
      octets = 0;
      limit = 74; // the continuation line starts with one space
    }
    current += character;
    octets += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

const compactDay = (day) => day.replaceAll('-', '');

const addDay = (day) =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** `20261030T140000Z` from a UTC day and an HH:MM. */
const compactInstant = (day, time) => `${compactDay(day)}T${time.replace(':', '')}00Z`;

function endInstant(day, time) {
  const end = new Date(Date.parse(`${day}T${time}:00.000Z`) + EVENT_MINUTES * 60 * 1000);
  return end
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

function eventLines(alert, stamp) {
  const link = safeAlertLink(alert.link);
  const time = TIME.test(alert.dueTime) ? alert.dueTime : null;
  const lines = [
    'BEGIN:VEVENT',
    `UID:${alert.id}@calendar-alerts.hybridcloudworks.com`,
    `DTSTAMP:${stamp}`,
  ];
  if (time) {
    lines.push(
      `DTSTART:${compactInstant(alert.dueDate, time)}`,
      `DTEND:${endInstant(alert.dueDate, time)}`
    );
  } else {
    lines.push(
      `DTSTART;VALUE=DATE:${compactDay(alert.dueDate)}`,
      `DTEND;VALUE=DATE:${compactDay(addDay(alert.dueDate))}`
    );
  }
  lines.push(`SUMMARY:${escapeIcsText(alert.title)}`);
  const description = [alert.note, link?.href].filter(Boolean).join('\n');
  if (description) lines.push(`DESCRIPTION:${escapeIcsText(description)}`);
  if (link?.kind === 'external') lines.push(`URL:${link.href}`);
  lines.push('END:VEVENT');
  return lines;
}

/**
 * The calendar file's text for every alert not yet done.
 *
 * @param {object[]} alerts as the server sends them
 * @param {Date} [now]
 * @returns {string} CRLF-separated, ending in a CRLF
 */
export function buildIcs(alerts, now = new Date()) {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  // A row without a real day cannot be an event; the server never sends one.
  const events = alerts.filter((alert) => alert.state !== 'done' && DAY.test(alert.dueDate));
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//HybridCloudWorks//Calendar Alerts//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:HCW calendar alerts',
    ...events.flatMap((alert) => eventLines(alert, stamp)),
    'END:VCALENDAR',
  ];
  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
}

/** Save `text` as a file on the owner's disk, through a link that points at memory. */
export function downloadIcs(text, filename = ICS_FILENAME) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // After the click has been handled; revoking at once can cancel the save.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
