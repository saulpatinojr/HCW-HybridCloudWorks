/**
 * timers/reminders.js — `sendReminders`, daily at 13:00 UTC (08:00 Central).
 *
 * Reads the owner's reminders sheet (admin_config/reminders, written from
 * Platform Settings → Reminders; shape in lib/reminders/settings.js) and says
 * on Telegram, through the shared notifier, each reminder whose stage has
 * come: once within its lead days, once on the day, then weekly while it is
 * overdue, until it is marked done. Owner request 2026-10-06.
 *
 * A stage is stamped on the reminder only when the notifier reports the
 * message sent, so an unconfigured bot or a Telegram error means the same
 * reminder is tried again tomorrow rather than counted as said.
 *
 * Two writers share the document: this timer stamps, the sheet edits. The
 * stamps are written with the document's ETag and, when the sheet saved in
 * between (412), re-read and re-applied onto the rows as they now stand — a
 * row the owner removed meanwhile stays removed, a row they edited keeps the
 * edit, and only `notified` gains the stage. The sheet's own PUT merges the
 * other way (platform-settings.js, `merge`), so a stamp written while the
 * page was open survives the save. Review of #910.
 *
 * A STAMP BELONGS TO THE CYCLE IT WAS SAID FOR (review of #1039): the row's
 * due date and title when the message went. On a re-apply after a 412 it is
 * written only onto a row that still has that date and title. A row that
 * moved meanwhile (the owner re-dated it, or a rotation recorded on
 * Integrations → Credentials started the register row's next cycle) gets no
 * stamp, so its new cycle is said afresh rather than counted as said by a
 * message about the old one. With no conflict the rows are the ones the
 * stamps were computed from, so nothing changes there.
 *
 * Telemetry carries positions and counts, never a reminder's id: ids may be
 * chosen by hand and a hand-chosen id is content.
 *
 * Each reminder is its own notifier source (`reminder:<id>`), so the
 * notifier's fifteen-minute cooldown never lets one reminder silence another.
 *
 * A run first brings every row provider's rows in line (`syncProviders`,
 * lib/reminders/providers.js; the credential register since #1026, and
 * Ambassador since #1886): a Key Vault secret rotated on the Keys tab since
 * yesterday has moved its reminder before anything is said, so no message
 * is built from a stale due date. A sync that fails is a warning and the
 * run goes on with the sheet as it stands.
 */
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { dateOnly, daysUntil, stageDue } from '../reminders/calendar.js';
import {
  PROVIDED_ROWS,
  REMINDERS_CONFIG_ID,
  RemindersValidationError,
  mergeStamps,
  readStoredReminders,
} from '../reminders/settings.js';
import { errorFacts } from '../http/error-response.js';

export const REMINDER_SOURCE_PREFIX = 'reminder:';
export const STAMP_WRITE_ATTEMPTS = 3;
const MAX_NOTES_IN_MESSAGE = 400;

const SEVERITY = Object.freeze({ ahead: 'info', due: 'warning', overdue: 'critical' });
const TITLE_PREFIX = Object.freeze({ ahead: 'Coming up', due: 'Due today', overdue: 'Overdue' });

/** "in 7 days" / "today" / "3 days overdue". */
export function describeDistance(days) {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days > 1) return `in ${days} days`;
  return days === -1 ? '1 day overdue' : `${-days} days overdue`;
}

/** The Telegram text for one reminder at one stage. */
/**
 * The message's last line. A kept row (PROVIDED_ROWS) cannot be marked done
 * on the sheet, so it says where it goes away instead.
 */
function closingLine(reminder, stage) {
  const provider = PROVIDED_ROWS.find(({ prefix }) => reminder.id?.startsWith(prefix));
  if (provider) {
    return stage === 'overdue'
      ? `Said again weekly until it is handled in ${provider.keeper}, which keeps this reminder.`
      : `Kept by ${provider.keeper}: it goes once it is handled there.`;
  }
  return stage === 'overdue'
    ? 'Said again weekly until it is marked done on Platform Settings → Reminders.'
    : 'Mark it done on Platform Settings → Reminders once it is handled.';
}

export function reminderMessage(reminder, stage, today) {
  const days = daysUntil(reminder.dueDate, today);
  const lines = [`Due ${reminder.dueDate} (${describeDistance(days)}).`];
  if (reminder.notes) {
    const notes =
      reminder.notes.length > MAX_NOTES_IN_MESSAGE
        ? `${reminder.notes.slice(0, MAX_NOTES_IN_MESSAGE)}…`
        : reminder.notes;
    lines.push('', notes);
  }
  if (reminder.url) lines.push('', reminder.url);
  lines.push('', closingLine(reminder, stage));
  return { title: `${TITLE_PREFIX[stage]}: ${reminder.title}`, message: lines.join('\n') };
}

/** The stored document as reminders, or null (logged) when it does not validate. */
function readValue(doc, log) {
  try {
    return readStoredReminders(doc);
  } catch (error) {
    if (!(error instanceof RemindersValidationError)) throw error;
    log.warn?.(`[sendReminders] stored reminders do not validate; nothing said: ${errorFacts(error)}`);
    return null;
  }
}

/**
 * Say one reminder at one stage; true when the message went. Never throws,
 * since a notifier failure on one reminder must not stop the rest.
 */
async function sayReminder({ notifier, log }, reminder, index, stage, today) {
  const { title, message } = reminderMessage(reminder, stage, today);
  let result;
  try {
    result = await notifier.notifyTelegram({
      title,
      message,
      severity: SEVERITY[stage],
      source: `${REMINDER_SOURCE_PREFIX}${reminder.id}`,
    });
  } catch (error) {
    log.warn?.(`[sendReminders] reminders[${index}] ${stage}: notifier threw: ${errorFacts(error)}`);
    result = { sent: false, reason: 'exception' };
  }
  if (!result?.sent) {
    log.warn?.(
      `[sendReminders] reminders[${index}] ${stage}: not sent (${result?.reason || 'unknown'}); tried again tomorrow.`
    );
  }
  return Boolean(result?.sent);
}

/** Whether a row is still in the cycle a stamp was said for: the same due date and title. */
const inCycle = (row, cycle) =>
  row?.dueDate === cycle.dueDate && String(row?.title ?? '').trim() === cycle.title;

/**
 * `rows` with each stamped id's `notified` merged in; rows not in `stamps`
 * untouched. With `sameCycleOnly`, a re-apply after a 412, a stamp is
 * written only onto a row still in the cycle it was said for (see the
 * header); the first attempt writes onto the rows the stamps came from.
 */
const applyStamps = (rows, stamps, { sameCycleOnly = false } = {}) =>
  (rows ?? []).map((row) => {
    const stamp = stamps.get(row.id);
    if (!stamp || (sameCycleOnly && !inCycle(row, stamp.cycle))) return row;
    return { ...row, notified: mergeStamps(row.notified, stamp.notified) };
  });

/**
 * Write the stamps onto the document as it stands now, with its ETag. On a
 * 412 the sheet saved meanwhile: re-read and re-apply onto the new rows,
 * each stamp only where its row is still in the cycle it was said for.
 * False when the document is gone or the attempts run out; either way the
 * worst case is one repeated message tomorrow, never a lost edit.
 */
async function writeStamps({ store, log }, doc, stamps) {
  let current = doc;
  for (let attempt = 1; attempt <= STAMP_WRITE_ATTEMPTS; attempt += 1) {
    try {
      await store.replaceDocIfMatch(
        'admin_config',
        { ...current, reminders: applyStamps(current.reminders, stamps, { sameCycleOnly: attempt > 1 }) },
        { partitionKey: ADMIN_CONFIG_PARTITION }
      );
      return true;
    } catch (error) {
      if (error?.code !== 412) throw error;
      current = await store.readDoc('admin_config', REMINDERS_CONFIG_ID, ADMIN_CONFIG_PARTITION);
      if (!current) return false;
    }
  }
  log.warn?.(
    `[sendReminders] stamps not written after ${STAMP_WRITE_ATTEMPTS} attempts (the sheet kept saving); the same reminders may be said again tomorrow.`
  );
  return false;
}

/**
 * Say every reminder whose stage has come; the stamps to write and the
 * counts per stage. Each stamp carries the cycle it was said for.
 */
async function sayDue(deps, reminders, today, at) {
  const stamps = new Map();
  const stages = { ahead: 0, due: 0, overdue: 0 };
  for (const [index, reminder] of reminders.entries()) {
    const stage = stageDue(reminder, today, at.getTime());
    if (stage && (await sayReminder(deps, reminder, index, stage, today))) {
      stamps.set(reminder.id, {
        cycle: { dueDate: reminder.dueDate, title: reminder.title },
        notified: { [stage]: at.toISOString() },
      });
      stages[stage] += 1;
    }
  }
  return { stamps, stages };
}

/**
 * @param {object} deps
 * @param {{ readDoc: Function, replaceDocIfMatch: Function }} deps.store
 * @param {{ notifyTelegram: Function }|null} [deps.notifier]
 * @param {() => Date} [deps.now]
 * @param {((at: Date) => Promise<unknown>)|null} [deps.syncProviders]
 *        every row provider's sync (reminders/providers.js, #1886), run before
 *        the sheet is read; it says its own failures and never throws
 */
export function createReminderCheck({
  store,
  notifier = null,
  now = () => new Date(),
  log = {},
  syncProviders = null,
}) {
  async function run() {
    const at = now();
    const today = dateOnly(at);
    if (syncProviders) await syncProviders(at);
    const doc = await store.readDoc('admin_config', REMINDERS_CONFIG_ID, ADMIN_CONFIG_PARTITION);
    if (!doc) return { checked: 0, sent: 0 };

    const value = readValue(doc, log);
    if (!value) return { checked: 0, sent: 0, invalid: true };
    if (!notifier?.notifyTelegram) {
      log.warn?.('[sendReminders] no notifier; nothing said.');
      return { checked: value.reminders.length, sent: 0 };
    }

    const { stamps, stages } = await sayDue({ notifier, log }, value.reminders, today, at);
    const stamped = stamps.size > 0 ? await writeStamps({ store, log }, doc, stamps) : true;
    log.log?.(`[sendReminders] ${value.reminders.length} reminder(s) checked, ${stamps.size} said`);
    return { checked: value.reminders.length, sent: stamps.size, stages, stamped };
  }
  return { run };
}
