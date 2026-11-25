/**
 * Schedules in plain words, for the Scheduled tasks tab (Platform Settings).
 *
 * The estate writes a schedule four ways, and this reads all four:
 *
 *   '30 6 * * 2'                   a GitHub Actions cron line: five fields,
 *                                  minute hour day-of-month month day-of-week
 *   '0 30 3 * * *'                 an Azure Functions timer (NCRONTAB): the
 *                                  same with a seconds field in front
 *   'OnCalendar=*-*-* 03:45:00'    a systemd timer on the lab host, once a day
 *   'OnUnitActiveSec=15min'        a systemd timer on the lab host, every so
 *                                  often after its last run
 *
 * Only the shapes the estate uses are read: a day of the month or a month
 * other than `*`, or a seconds field other than `0`, throws, so a new kind of
 * schedule fails the tests instead of being described wrongly. No dependency:
 * the list of shapes is short, and each one is tested. When a schedule runs
 * next, and how often, is scheduleTimes.js.
 */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const pad = (n) => String(n).padStart(2, '0');

/** "a", "a and b", "a, b and c". */
function joinWords(items) {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Every value one cron field allows, sorted: `*`, `n`, `a-b`, a step on either, and lists of them. */
function expandField(text, min, max) {
  const values = new Set();
  for (const part of text.split(',')) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error(`Schedule field "${text}" is not a shape this page reads`);
    const [, all, from, to, step] = match;
    const start = all === '*' ? min : Number(from);
    // `5/10` means from 5 to the end, as in cron; a bare `5` is just 5.
    const end = all === '*' || (step && to === undefined) ? max : Number(to ?? from);
    const by = step ? Number(step) : 1;
    if (start < min || end > max || start > end || by < 1) {
      throw new Error(`Schedule field "${text}" is out of range`);
    }
    for (let v = start; v <= end; v += by) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
}

/**
 * Read a schedule into the minutes, hours and weekdays it fires on, or, for
 * an interval timer, its period in minutes.
 *
 * @param {string} expr
 * @returns {{ kind: 'cron'|'ncrontab'|'systemd-calendar'|'interval', minutes?: number[], hours?: number[], days?: number[], hourStep?: boolean, everyMinutes?: number }}
 */
export function parseSchedule(expr) {
  const text = String(expr).trim();
  const interval = /^OnUnitActiveSec=(\d+)(min|h)$/.exec(text);
  if (interval) {
    const everyMinutes = Number(interval[1]) * (interval[2] === 'h' ? 60 : 1);
    return { kind: 'interval', everyMinutes };
  }
  const calendar = /^OnCalendar=\*-\*-\* (\d{2}):(\d{2}):00$/.exec(text);
  if (calendar) {
    return {
      kind: 'systemd-calendar',
      minutes: expandField(String(Number(calendar[2])), 0, 59),
      hours: expandField(String(Number(calendar[1])), 0, 23),
      days: expandField('*', 0, 6),
    };
  }
  const fields = text.split(/\s+/);
  let kind = 'cron';
  if (fields.length === 6) {
    if (fields[0] !== '0') throw new Error(`"${text}" fires on a second other than :00`);
    fields.shift();
    kind = 'ncrontab';
  } else if (fields.length !== 5) {
    throw new Error(`"${text}" is not a schedule this page reads`);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (dayOfMonth !== '*' || month !== '*') {
    throw new Error(`"${text}" names a day of the month or a month, which this page does not read`);
  }
  const days = expandField(dayOfWeek.replace(/\b7\b/g, '0'), 0, 6);
  return {
    kind,
    minutes: expandField(minute, 0, 59),
    hours: expandField(hour, 0, 23),
    days,
    // A step in the hour field (`*/4`) is read as "every 4 hours"; a list
    // (`0,12`) as the times it names.
    hourStep: hour.includes('/'),
  };
}

/** The step between evenly spaced values that fill a cycle of `size`, else null. */
function evenStep(values, size) {
  if (values.length < 2 || size % values.length !== 0) return null;
  const step = size / values.length;
  return values.every((v, i) => i === 0 || v - values[i - 1] === step) ? step : null;
}

/** " on Mondays", " on Mondays and Thursdays", or "" for every day. */
function onDays(days) {
  if (days.length === 7) return '';
  return ` on ${joinWords(days.map((d) => `${DAYS[d]}s`))}`;
}

/**
 * A schedule in plain words: "Every Tuesday at 06:30 UTC", "Every hour at
 * :41", "Every 4 hours at :17", "Every 2 hours, on the hour", "Every 5
 * minutes, from :02", "Every day at 00:10 and 12:10 UTC".
 *
 * `clock` names the clock a fixed time is read on ("UTC", or "lab host
 * clock" for a host that sets no time zone); it is left off where the
 * schedule names no time of day.
 *
 * @param {string} expr
 * @param {{ clock?: string }} [options]
 */
export function describeSchedule(expr, { clock = 'UTC' } = {}) {
  const parsed = parseSchedule(expr);
  if (parsed.kind === 'interval') return describeInterval(parsed.everyMinutes);
  if (parsed.hours.length === 24) return describeWithinTheHour(parsed);
  return describeHourStep(parsed) ?? describeFixedTimes(expr, parsed, clock);
}

/** "Every 15 minutes", "Every hour", "Every 2 hours". */
function describeInterval(n) {
  if (n === 60) return 'Every hour';
  return n % 60 === 0 ? `Every ${n / 60} hours` : `Every ${n} minutes`;
}

/** A schedule that runs in every hour: "Every hour at :41", "Every 5 minutes, from :02". */
function describeWithinTheHour({ minutes, days }) {
  if (minutes.length === 1) return `Every hour at :${pad(minutes[0])}${onDays(days)}`;
  const step = evenStep(minutes, 60);
  if (!step) return `Every hour at ${joinWords(minutes.map((m) => `:${pad(m)}`))}${onDays(days)}`;
  const from = minutes[0] === 0 ? '' : `, from :${pad(minutes[0])}`;
  return `Every ${step} minutes${from}${onDays(days)}`;
}

/** An hour field with a step: "Every 4 hours at :17", "Every 2 hours, on the hour"; else null. */
function describeHourStep({ minutes, hours, days, hourStep }) {
  const step = minutes.length === 1 && hourStep ? evenStep(hours, 24) : null;
  if (!step || step < 2) return null;
  const at = minutes[0] === 0 ? ', on the hour' : ` at :${pad(minutes[0])}`;
  return `Every ${step} hours${at}${onDays(days)}`;
}

/** Set times of day: "Every Tuesday at 06:30 UTC", "Every day at 00:10 and 12:10 UTC". */
function describeFixedTimes(expr, { minutes, hours, days }, clock) {
  const times = hours.flatMap((h) => minutes.map((m) => `${pad(h)}:${pad(m)}`));
  if (times.length > 4) throw new Error(`"${expr}" fires at too many set times to read out`);
  const when = days.length === 7 ? 'Every day' : `Every ${joinWords(days.map((d) => DAYS[d]))}`;
  const clockWords = clock === 'UTC' ? ' UTC' : ` (${clock})`;
  return `${when} at ${joinWords(times)}${clockWords}`;
}
