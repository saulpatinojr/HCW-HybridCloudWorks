/**
 * calendar-alerts/store.js — where the alerts are kept, and how they are
 * changed without two writers losing each other's work.
 *
 * ONE DOCUMENT, `admin_config/calendar_alerts`, in the container and the
 * constant partition every other admin setting uses (no new container). It
 * holds the whole list and `seeded`, the ids of every alert the code has ever
 * created for the owner (model.js SEED_ALERTS). They are in one document so
 * that one conditional write covers both: an alert is removed and its id is
 * recorded as seeded in the same step, so there is no moment when a deleted
 * seed could be made again.
 *
 * Every change is read, applied to what was read, and written back under the
 * ETag of that read (the same pattern as the reminders sheet's save,
 * platform-settings.js writeMerged). A 412 (replaced since the read) or 409
 * (created since an empty read) reads again and re-applies the change to the
 * newer document, up to WRITE_ATTEMPTS times, so two browser tabs each
 * snoozing a different alert both land. A change is a pure function of the
 * state it is given for that reason.
 */
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { AuthoredError, logFailure } from '../http/error-response.js';
import {
  CALENDAR_ALERTS_DOC_ID,
  CALENDAR_ALERTS_DOC_TYPE,
  applySeeds,
  readState,
} from './model.js';

const CONTAINER = 'admin_config';

/** Reads that find the document changed before the write lands, before giving up. */
export const WRITE_ATTEMPTS = 5;

/** Thrown when every attempt lost to another writer. */
export class CalendarAlertsConflictError extends AuthoredError {
  constructor() {
    super('The alerts changed while this was being saved. Nothing was lost; try again.', {
      code: 'ALERTS_CONFLICT',
      status: 409,
    });
  }
}

/** 412: replaced since the read. 409: created since a read that found nothing. */
const isWriteConflict = (error) => {
  const status = error?.code ?? error?.statusCode;
  return status === 412 || status === 409;
};

/** The stored list and the record of seeds, as `{ alerts, seeded }`. */
export async function readAlertsState(store) {
  return readState(await store.readDoc(CONTAINER, CALENDAR_ALERTS_DOC_ID, ADMIN_CONFIG_PARTITION));
}

/**
 * Apply `change` to the stored state and write the result under the ETag it
 * was read at.
 *
 * `change(state)` returns `{ write, state?, result? }` and must be pure: it
 * runs again, on a fresh read, after a lost race. `write: false` writes
 * nothing (the state already says what it should). A change that refuses
 * throws an AuthoredError, which leaves the document alone.
 *
 * @param {{ readDoc: Function, createDoc: Function, replaceDocIfMatch: Function }} store
 * @param {(state: { alerts: object[], seeded: string[] }) => { write: boolean, state?: object, result?: unknown }} change
 * @param {{ now?: () => Date }} [options]
 * @returns {Promise<{ state: { alerts: object[], seeded: string[] }, result: unknown, written: boolean }>}
 * @throws {CalendarAlertsConflictError} when every attempt lost the race
 */
export async function changeAlerts(store, change, { now = () => new Date() } = {}) {
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
    const stored = await store.readDoc(CONTAINER, CALENDAR_ALERTS_DOC_ID, ADMIN_CONFIG_PARTITION);
    const current = readState(stored);
    const outcome = change(current);
    if (!outcome.write) return { state: current, result: outcome.result, written: false };

    const doc = {
      id: CALENDAR_ALERTS_DOC_ID,
      configScope: ADMIN_CONFIG_PARTITION,
      docType: CALENDAR_ALERTS_DOC_TYPE,
      alerts: outcome.state.alerts,
      seeded: outcome.state.seeded,
      updatedAt: now().toISOString(),
    };
    try {
      if (stored) {
        await store.replaceDocIfMatch(
          CONTAINER,
          { ...doc, _etag: stored._etag },
          { partitionKey: ADMIN_CONFIG_PARTITION }
        );
      } else {
        await store.createDoc(CONTAINER, doc);
      }
      return { state: outcome.state, result: outcome.result, written: true };
    } catch (error) {
      if (!isWriteConflict(error)) throw error;
    }
  }
  throw new CalendarAlertsConflictError();
}

/**
 * The state with the seed alerts in it: any that was never created is
 * created now (create-only, applySeeds), and the state is read as written.
 *
 * Seeding is a kindness, not a requirement of reading: when the write fails,
 * the list is read as it stands and the failure is logged without content, so
 * a store that cannot be written still answers the pop-up. Only a failed
 * READ fails the call.
 *
 * @param {object} store
 * @param {{ now?: () => Date, context?: object, request?: object }} [options]
 */
export async function readSeededState(store, { now = () => new Date(), context, request } = {}) {
  const at = now().toISOString();
  try {
    const { state } = await changeAlerts(
      store,
      (state) => {
        const seeded = applySeeds(state, { at });
        return { write: seeded.changed, state: seeded.state };
      },
      { now }
    );
    return state;
  } catch (error) {
    logFailure(context, 'Calendar alerts: creating the starting alerts failed; reading the list as it stands', error, request);
    // The list is still answered, with the starting alerts added in memory as the
    // Calendar read adds them (collector.js), so the panel and the grid agree.
    return applySeeds(await readAlertsState(store), { at }).state;
  }
}
