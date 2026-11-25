/**
 * Reminders for the credentials only the owner can renew (#1026), through the
 * existing Reminders feature: the same document (admin_config/reminders), the
 * same daily `sendReminders` timer (SEND_REMINDERS) and the same Telegram
 * notifier. Nothing here sends anything; it keeps rows on the sheet, and the
 * timer says them.
 *
 * ## Which credentials, and which reminder
 *
 * Every `hand` credential with a rotation rule (`lifetimeDays`). Today that
 * is the issue's list: the Anthropic key, the Telegram bot token, the two
 * GitHub App private keys, the Coder GitHub OAuth secret, the Static Web
 * Apps deployment token's 90-day reset and the two 730-day lab host
 * certificates. Each has a reminder, always (#1026 asks for one for each),
 * and which one depends on whether a date is known:
 *
 *   ROTATE   a date is known (a Key Vault write, or one the owner recorded):
 *            "Rotate <name>", due on the computed due date, said first when
 *            its row turns amber on the tab (lead days = its due-soon window).
 *   RECORD   no date yet: "Record when <name> was last rotated", due the day
 *            it was first added, with no lead days. A due date for the
 *            rotation made up from nothing would fire on the wrong day, so
 *            this one asks for the date instead. Its due date STAYS the day
 *            it was first added (found on the sheet by its title) rather
 *            than moving to each day's sync, which would reset it daily.
 *
 * Recording the date, or a Key Vault write the sync sees, turns the RECORD
 * row into the ROTATE row at the real due date: a date move, so the rule
 * below starts it fresh.
 *
 * ## The rows: register-managed, by a reserved id
 *
 * A credential's reminder is the row `credential-<register id>`. The register
 * owns that row whole (title, due date, lead days, notes, link, and `done`,
 * which it never sets) and nothing else on the sheet: every other row is the
 * owner's and is passed through untouched, in its place. A `credential-` row
 * whose credential no longer has a rule is removed; a new one is appended.
 *
 * ONE FIELD IS KEPT while the cycle stands (the same due date and title):
 * `notified`, the timer's stamps, so a sync never makes a stage fire twice.
 * `done` is NOT kept: a register row is always open, and one found marked
 * done is reopened (review of #1039). The sheet saves at `editor`, below
 * the `super_admin` that records a rotation, and its save no longer changes
 * these rows at all (reminders/settings.js mergeStoredStamps); this is the
 * second half, for a `done` that reached the document some other way.
 * Recording the rotation is the only way a register row's cycle ends. When
 * the due date or the title moves (a rotation was recorded, or the Keys tab
 * wrote a new value), the row starts fresh with no stamps: it is a new
 * cycle, and the old cycle's stamps would otherwise keep its "coming up" and
 * "due" messages from ever being said.
 *
 * ## When it runs
 *
 *   - when a rotation is recorded on the Credentials tab (handlers.js);
 *   - when the owner presses Update reminders there;
 *   - at the start of every `sendReminders` run, before anything is said, so
 *     a Keys-tab rotation since the last run has already moved its row and
 *     no message is built from a stale date.
 *
 * ## Sharing the document
 *
 * Three writers now share admin_config/reminders: the sheet's save (a full
 * replace that keeps the timer's stamps, platform-settings.js), the timer's
 * stamps (ETag, re-read on 412), and this. This writes only when the merged
 * rows differ from the stored ones, under the document's ETag, so an owner's
 * edit is never lost to a sync and a sync is never lost to a stamp. The one
 * race it cannot win is the sheet saving a copy loaded before a sync: that
 * save puts the old credential rows back, and the next sync moves them
 * again. Because the timer syncs before it says anything, the message is
 * never the stale one.
 *
 * EVERY ATTEMPT RE-READS EVERYTHING, the sheet first and the date sources
 * after it (sources.js), and computes the rows from that read (review of
 * #1039: a snapshot taken once before the retries let a rotation recorded
 * mid-sync be overwritten by its old due date). The order is what makes the
 * write safe: a rotation recorded after this attempt read the sheet is
 * followed by its own sync (handlers.js), which reads its dates after the
 * record and writes the sheet under an ETag; whichever of the two writes
 * second finds the ETag changed and goes round again with fresh dates, so
 * the last write is always computed from the newest record.
 *
 * A sheet that does not validate is left alone: the owner repairs it on
 * Platform Settings, and the sync tries again next time. So is one the
 * credential rows would push past MAX_REMINDERS.
 *
 * Telemetry carries counts only, the timer's rule.
 */

import { PRODUCTION_ORIGINS } from '../auth/cors.js';
import { dateOnly, parseDateOnly } from '../reminders/calendar.js';
import {
  CREDENTIAL_ROW_PREFIX,
  MAX_NOTES_LENGTH,
  MAX_TITLE_LENGTH,
  RemindersValidationError,
  isCredentialRow,
  readStoredReminders,
} from '../reminders/settings.js';
import { CREDENTIAL_STORES } from './register.js';
import { readCredentialSources } from './sources.js';
import { buildRegisterView } from './status.js';
import {
  SYNC_WRITE_ATTEMPTS,
  mergeProvidedRows,
  syncProvidedRows,
} from '../reminders/provided-rows.js';

/** The reserved id prefix, from the sheet's own module so the save and the sync agree. */
export const CREDENTIAL_REMINDER_PREFIX = CREDENTIAL_ROW_PREFIX;

/** Where every credential reminder links: the tab that records the rotation. */
export const CREDENTIALS_TAB_URL = `${PRODUCTION_ORIGINS[0]}/admin/integrations?tab=credentials`;

// Read → merge → write-if-unchanged attempts, shared with every row provider.
export { SYNC_WRITE_ATTEMPTS };

/** The sources a reminder's due date depends on; the sync waits while one is unreadable. */
export const REMINDER_SOURCES = Object.freeze(['secret-state', 'credential-register', 'reminders']);

const STORE_LABELS = new Map(CREDENTIAL_STORES.map((store) => [store.id, store.label]));

export const reminderIdFor = (credentialId) => `${CREDENTIAL_REMINDER_PREFIX}${credentialId}`;

/** Whether a sheet row is one the register manages. */
export const isCredentialReminder = isCredentialRow;

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const KEPT_BY_REGISTER =
  'The credential register keeps this row: an edit made to it here is replaced at the next sync.';

/** Where it lives, what uses it and who issues it: the first paragraph of either reminder. */
function whereAndWhat(credential) {
  const where = STORE_LABELS.get(credential.store) ?? credential.store;
  return `${credential.name}, in ${where}. Used by: ${credential.consumer}. Issued by ${credential.issuer}.`;
}

/** The ROTATE reminder's notes: where, how to rotate, and how to move it. */
function rotateNotes(credential) {
  return clip(
    [
      whereAndWhat(credential),
      credential.rotate ?? '',
      `Then record the rotation on Integrations → Credentials, which moves this reminder to the next due date. ${KEPT_BY_REGISTER}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
    MAX_NOTES_LENGTH
  );
}

/** The RECORD reminder's notes: where, the rule, and what recording the date does. */
function recordNotes(credential) {
  return clip(
    [
      whereAndWhat(credential),
      `It is rotated every ${credential.lifetimeDays} days, and no date is known for its last rotation. Record that date on Integrations → Credentials (or the day it is rotated next): this reminder then becomes the rotation reminder, due ${credential.lifetimeDays} days after it. ${KEPT_BY_REGISTER}`,
    ].join('\n\n'),
    MAX_NOTES_LENGTH
  );
}

export const rotateTitle = (credential) => clip(`Rotate ${credential.name}`, MAX_TITLE_LENGTH);
export const recordTitle = (credential) =>
  clip(`Record when ${credential.name} was last rotated`, MAX_TITLE_LENGTH);

/** Which reminder a presented credential wants: 'rotate', 'record', or null for none. */
export function reminderKind(credential) {
  // A credential whose source could not be read has no reminder of either
  // kind computed for it (status.js): the sync does not run then anyway.
  if (credential.renewal !== 'hand' || credential.sourceUnavailable) return null;
  if (credential.expiresAt) return 'rotate';
  return Number.isInteger(credential.lifetimeDays) ? 'record' : null;
}

/**
 * The rows the register wants on the sheet, from presented credentials
 * (status.js presentCredential): a ROTATE row for each hand credential with
 * a due date, a RECORD row for each with a rule and no date yet.
 *
 * `today` is the sync's UTC day; `stored` the sheet's rows, where a RECORD
 * row already added keeps its first due date (see the header).
 */
export function wantedReminders(credentials, { today, stored = [] }) {
  const storedById = new Map((stored ?? []).map((row) => [row?.id, row]));
  return credentials.flatMap((credential) => {
    const kind = reminderKind(credential);
    if (!kind) return [];
    const id = reminderIdFor(credential.id);
    const row = { id, url: CREDENTIALS_TAB_URL, done: false, notified: {} };
    if (kind === 'rotate') {
      return [
        {
          ...row,
          title: rotateTitle(credential),
          dueDate: dateOnly(credential.expiresAt),
          leadDays: credential.dueSoonDays,
          notes: rotateNotes(credential),
        },
      ];
    }
    const title = recordTitle(credential);
    const previous = storedById.get(id);
    const kept = previous?.title === title && parseDateOnly(previous.dueDate) !== null;
    return [
      {
        ...row,
        title,
        dueDate: kept ? previous.dueDate : today,
        leadDays: 0,
        notes: recordNotes(credential),
      },
    ];
  });
}

/**
 * The sheet's rows with the register's merged in (see the header): the
 * owner's rows untouched and in place, each credential row replaced in place
 * or removed, new ones appended. A credential row keeps the timer's
 * `notified` only while it is the same cycle: the same due date and the same
 * title, so a RECORD row turning into a ROTATE row on the same day still
 * starts fresh. It never keeps `done`: the wanted row's `false` stands, so a
 * row marked done by anyone but the register is reopened (see the header).
 */
export function mergeCredentialReminders(stored = [], wanted = []) {
  return mergeProvidedRows(stored, wanted, isCredentialReminder);
}

/**
 * Bring the sheet's credential rows in line with the register. Resolves to
 * a summary, `{ synced, changed?, reminders?, reason? }`, with counts only;
 * throws only on a store error that is not a lost race.
 *
 * @param {object} deps
 * @param {{ readDoc: Function, queryDocs: Function, createDoc: Function, replaceDocIfMatch: Function }} deps.store
 * @param {() => Date} [deps.now]
 * @param {{ warn?: Function }} [deps.log]
 */
export async function syncCredentialReminders({
  store,
  now = () => new Date(),
  log = {},
  attempts = SYNC_WRITE_ATTEMPTS,
  sleep,
}) {
  // Everything again, every attempt: the sheet, then the dates (header).
  const plan = async () => {
    const read = await readCredentialSources(store);
    const blocked = read.unavailable.filter((id) => REMINDER_SOURCES.includes(id));
    if (blocked.length) {
      // A due date read without its source would remove a reminder that
      // should stay; waiting a day costs nothing the timer cannot repeat.
      log.warn?.(`[credentialReminders] ${blocked.length} source(s) could not be read; reminders left as they are`);
      return { skip: 'unreadable' };
    }
    const nowMs = now().getTime();
    let stored;
    try {
      stored = readStoredReminders(read.reminderDoc).reminders;
    } catch (error) {
      if (!(error instanceof RemindersValidationError)) throw error;
      log.warn?.('[credentialReminders] the reminders sheet would not validate, or would pass its limit; left as it is');
      return { skip: 'invalid' };
    }
    const { credentials } = buildRegisterView(read.sources, nowMs, read.unavailable);
    return {
      reminderDoc: read.reminderDoc,
      wanted: wantedReminders(credentials, { today: dateOnly(nowMs), stored }),
    };
  };
  return syncProvidedRows({
    store,
    label: 'credentialReminders',
    isMine: isCredentialReminder,
    plan,
    log,
    attempts,
    ...(sleep ? { sleep } : {}),
  });
}
