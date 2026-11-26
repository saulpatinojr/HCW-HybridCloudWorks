/**
 * Ambassador's rows on the reminders sheet (#1886): each deadline and each
 * activity requirement not yet met for the period, from the attention list
 * (attention.js), becomes a row the
 * daily `sendReminders` timer says on Telegram, from the program's own lead
 * time. The rows are kept the way the credential register's are
 * (reminders/provided-rows.js): an editor cannot change or silence one, and
 * the timer's stamps survive a sync, so nothing is said twice.
 *
 * A row goes when its reason does: the application moves to a status where
 * the date no longer matters, the period's activity requirement is met, or
 * the program is
 * no longer held. A deadline more than OVERDUE_DROP_DAYS past is dropped too,
 * so an application nobody moved does not nag every week for ever; it still
 * shows on the Dashboard.
 */
import { createHash } from "node:crypto";
import { PRODUCTION_ORIGINS } from "../auth/cors.js";
import { dateOnly } from "../reminders/calendar.js";
import {
  MAX_NOTES_LENGTH,
  MAX_TITLE_LENGTH,
  PROVIDED_ROWS,
} from "../reminders/settings.js";
import {
  readReminderDoc,
  syncProvidedRows,
} from "../reminders/provided-rows.js";
import { readAmbassadorAttention } from "./attention-read.js";

const PROVIDER = PROVIDED_ROWS.find(({ keeper }) => keeper === "Ambassador");
export const AMBASSADOR_ROW_PREFIX = PROVIDER.prefix;
/** At most this many rows, the soonest first: the sheet keeps this many for Ambassador. */
export const MAX_AMBASSADOR_ROWS = PROVIDER.reserved;
/** A deadline further past than this is no longer said on Telegram. */
export const OVERDUE_DROP_DAYS = 30;

const KEPT =
  "Ambassador keeps this row: it moves with the deadline, and goes once the application moves on or the period's activity requirement is met. An edit made to it here is replaced at the next sync.";

const clip = (text, max) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * The row id for one attention item: the prefix and a hash of its key, so
 * the id is the same every day (stamps are kept) and stays inside the
 * sheet's 64 characters whatever the record ids are.
 */
export const ambassadorRowId = (key) =>
  `${AMBASSADOR_ROW_PREFIX}${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;

export const isAmbassadorRow = (row) =>
  typeof row?.id === "string" && row.id.startsWith(AMBASSADOR_ROW_PREFIX);

/** The rows Ambassador wants on the sheet, from the attention items. */
export function wantedAmbassadorRows(items) {
  return items
    .filter(
      (item) =>
        /^\d{4}-\d{2}-\d{2}$/.test(item.due ?? "") &&
        (item.daysLeft === null || item.daysLeft >= -OVERDUE_DROP_DAYS),
    )
    .sort((a, b) => a.due.localeCompare(b.due) || a.key.localeCompare(b.key))
    .slice(0, MAX_AMBASSADOR_ROWS)
    .map((item) => ({
      id: ambassadorRowId(item.key),
      title: clip(item.title.trim(), MAX_TITLE_LENGTH),
      dueDate: item.due,
      leadDays: item.leadDays,
      notes: clip(
        [item.detail, KEPT].filter(Boolean).join("\n\n"),
        MAX_NOTES_LENGTH,
      ),
      url: `${PRODUCTION_ORIGINS[0]}${item.href}`,
      done: false,
      notified: {},
    }));
}

/**
 * Bring Ambassador's rows on the sheet in line with what it needs now. The
 * same summary as the credential register's sync; throws only on a store
 * error that is not a lost race.
 */
export async function syncAmbassadorReminders({
  store,
  now = () => new Date(),
  log = {},
  attempts,
  sleep,
}) {
  const plan = async () => {
    const [reminderDoc, attention] = await Promise.all([
      readReminderDoc(store),
      readAmbassadorAttention(store, dateOnly(now().getTime())),
    ]);
    if (attention.missing) {
      // A list that could not be read says nothing about what is due.
      log.warn?.(
        "[ambassadorReminders] the Ambassador store could not be read; reminders left as they are",
      );
      return { skip: "missing" };
    }
    if (attention.truncated) {
      // Rows built from a cut list would remove reminders that should stay.
      log.warn?.(
        "[ambassadorReminders] the Ambassador lists passed their read limit; reminders left as they are",
      );
      return { skip: "truncated" };
    }
    return { reminderDoc, wanted: wantedAmbassadorRows(attention.items) };
  };
  return syncProvidedRows({
    store,
    label: "ambassadorReminders",
    isMine: isAmbassadorRow,
    plan,
    log,
    ...(attempts ? { attempts } : {}),
    ...(sleep ? { sleep } : {}),
  });
}
