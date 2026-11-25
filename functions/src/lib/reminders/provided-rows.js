/**
 * provided-rows.js — how a part of the platform keeps its own rows on the
 * owner's reminders sheet (admin_config/reminders), so the daily
 * `sendReminders` timer says them on Telegram (#1886).
 *
 * The credential register was the first to do this (#1026) and its rules were
 * learned the hard way; they live here now so every provider follows them:
 *
 *   - A provider owns its rows whole, by a reserved id prefix
 *     (settings.js PROVIDED_ROWS). Every other row is passed through
 *     untouched and in its place.
 *   - The timer's `notified` stamps are kept while a row stays in the same
 *     cycle (same due date and title), so a sync never makes a stage fire
 *     twice; when either moves, the row starts fresh. `done` is never kept:
 *     a provider decides whether a row exists, not the sheet.
 *   - Read, merge, write only if the document has not changed since it was
 *     read (`ifMatch`), retried a few times with a short random wait; a
 *     write that keeps losing gives up and says so, and tomorrow's run tries
 *     again. Nothing is written when nothing changed.
 *   - A sheet that would not validate, or would pass its limit, is left as it
 *     is rather than repaired by a provider.
 *
 * Nothing here sends anything: the timer does (timers/reminders.js).
 */
import { ADMIN_CONFIG_PARTITION } from "../cosmos-client.js";
import {
  REMINDERS_CONFIG_ID,
  RemindersValidationError,
  normalizeReminders,
  readStoredReminders,
} from "./settings.js";

/** Read → merge → write-if-unchanged attempts on the reminders document. */
export const SYNC_WRITE_ATTEMPTS = 4;

const sameCycle = (row, next) =>
  row.dueDate === next.dueDate && row.title === next.title;
const sameRows = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The sheet's rows with one provider's merged in: every other row untouched
 * and in place, each of the provider's rows replaced in place or removed,
 * new ones appended. A row keeps the timer's `notified` only while it is the
 * same cycle; it never keeps `done`.
 *
 * @param {object[]} stored the sheet's rows
 * @param {object[]} wanted the provider's rows, each with `notified: {}`
 * @param {(row: object) => boolean} isMine the provider's prefix test
 */
export function mergeProvidedRows(stored = [], wanted = [], isMine) {
  const wantedById = new Map(wanted.map((row) => [row.id, row]));
  const placed = new Set();
  const out = [];
  for (const row of stored) {
    if (!isMine(row)) {
      out.push(row);
      continue;
    }
    const next = wantedById.get(row.id);
    if (!next || placed.has(row.id)) continue;
    placed.add(row.id);
    out.push(
      sameCycle(row, next) ? { ...next, notified: row.notified ?? {} } : next,
    );
  }
  for (const row of wanted) if (!placed.has(row.id)) out.push(row);
  return out;
}

/** One attempt's rows from one read, or `{ invalid: true }`. */
function plannedRows(reminderDoc, wanted, isMine) {
  try {
    const stored = readStoredReminders(reminderDoc).reminders;
    const merged = normalizeReminders({
      reminders: mergeProvidedRows(stored, wanted, isMine),
    });
    return { stored, rows: merged.reminders };
  } catch (error) {
    if (error instanceof RemindersValidationError) return { invalid: true };
    throw error;
  }
}

/** Write the merged rows under the document's ETag; false when another writer got there first. */
async function writeRows(store, current, rows) {
  try {
    if (current) {
      await store.replaceDocIfMatch(
        "admin_config",
        { ...current, reminders: rows },
        { partitionKey: ADMIN_CONFIG_PARTITION },
      );
    } else {
      await store.createDoc("admin_config", {
        id: REMINDERS_CONFIG_ID,
        configScope: ADMIN_CONFIG_PARTITION,
        reminders: rows,
      });
    }
    return true;
  } catch (error) {
    if (error?.code === 412 || error?.code === 409) return false;
    throw error;
  }
}

/**
 * Bring one provider's rows on the sheet in line with what it wants.
 * Resolves to a summary with counts only, `{ synced, changed?, reminders?,
 * reason? }`; throws only on a store error that is not a lost race.
 *
 * `plan()` is called once per attempt, after nothing else, and reads whatever
 * the provider needs plus the sheet: it resolves to `{ reminderDoc, wanted }`,
 * or `{ skip: reason }` to leave the sheet as it is this time.
 *
 * @param {object} deps
 * @param {{ createDoc: Function, replaceDocIfMatch: Function }} deps.store
 * @param {string} deps.label the provider's name in log lines (a fixed word)
 * @param {(row: object) => boolean} deps.isMine
 * @param {() => Promise<{ reminderDoc: object|null, wanted: object[] }|{ skip: string }>} deps.plan
 */
export async function syncProvidedRows({
  store,
  label,
  isMine,
  plan,
  log = {},
  attempts = SYNC_WRITE_ATTEMPTS,
  sleep = defaultSleep,
}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0)
      await sleep(20 * 2 ** Math.min(attempt, 5) + Math.random() * 20);
    const read = await plan();
    if (read.skip) return { synced: false, reason: read.skip };
    const planned = plannedRows(read.reminderDoc, read.wanted, isMine);
    if (planned.invalid) {
      // Not the normalizer's sentence: it can quote a row's hand-chosen id,
      // and a hand-chosen id is content (timers/reminders.js).
      log.warn?.(
        `[${label}] the reminders sheet would not validate, or would pass its limit; left as it is`,
      );
      return { synced: false, reason: "invalid" };
    }
    const reminders = read.wanted.length;
    if (sameRows(planned.stored, planned.rows))
      return { synced: true, changed: false, reminders };
    if (await writeRows(store, read.reminderDoc, planned.rows)) {
      return { synced: true, changed: true, reminders };
    }
  }
  log.warn?.(
    `[${label}] the reminders sheet kept changing; tried ${attempts} times`,
  );
  return { synced: false, reason: "conflict" };
}

/** The reminders document, as the sync reads it. */
export const readReminderDoc = (store) =>
  store.readDoc("admin_config", REMINDERS_CONFIG_ID, ADMIN_CONFIG_PARTITION);
