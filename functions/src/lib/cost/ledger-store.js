/**
 * cost/ledger-store.js — where the subscriptions ledger and the Cost page's
 * settings are kept, and how they are changed without two writers losing each
 * other's work.
 *
 * ONE DOCUMENT, `admin_config/cost_ledger`, in the container and the constant
 * partition every other admin setting uses (no new container):
 * `{ items: [...], settings: {...} }`. Every change is read, applied to what
 * was read, and written back under the ETag of that read, the same loop as
 * the Calendar Alerts store: a 412 (replaced since the read) or 409 (created
 * since an empty read) reads again and re-applies, up to WRITE_ATTEMPTS
 * times. A change is a pure function of the state it is given for that
 * reason.
 */
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { AuthoredError } from '../http/error-response.js';

export const CONTAINER = 'admin_config';
export const LEDGER_DOC_ID = 'cost_ledger';
export const LEDGER_DOC_TYPE = 'cost_ledger';
export const WRITE_ATTEMPTS = 5;

/** The page's settings and their defaults; normalizeSettings refuses anything else. */
export const DEFAULT_SETTINGS = Object.freeze({
  aiMonthlyBudgetUsd: null,
  renewalLeadDays: 7,
  telegram: true,
  monthlyDigest: true,
  refreshHours: 6,
});
export const SETTINGS_FIELDS = Object.freeze(Object.keys(DEFAULT_SETTINGS));
export const MAX_RENEWAL_LEAD_DAYS = 60;
export const MAX_REFRESH_HOURS = 24;

export class CostLedgerConflictError extends AuthoredError {
  constructor() {
    super('The ledger changed while this was being saved. Nothing was lost; try again.', {
      code: 'LEDGER_CONFLICT',
      status: 409,
    });
  }
}

export class CostSettingsValidationError extends AuthoredError {
  constructor(message) {
    super(message, { code: 'INVALID_SETTINGS', status: 400 });
  }
}

const fail = (message) => {
  throw new CostSettingsValidationError(message);
};

const isWriteConflict = (error) => {
  const status = error?.code ?? error?.statusCode;
  return status === 412 || status === 409;
};

/**
 * Run one setting's check. Read from the page (`strict`), a bad value is the
 * 400 the check throws; read from a stored document edited by hand, it is the
 * default instead.
 */
function soft(check, fallback, strict) {
  try {
    return check();
  } catch (error) {
    if (strict) throw error;
    return fallback;
  }
}

function budgetOf(input) {
  const value = input.aiMonthlyBudgetUsd;
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) fail('aiMonthlyBudgetUsd must be a number of 0 or more, or empty');
  return Number(n.toFixed(2));
}

/** A whole number from 1 to `max`, or the default when it is absent. */
function wholeNumberOf(input, key, max) {
  const value = input[key];
  if (value === undefined || value === null) return DEFAULT_SETTINGS[key];
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    fail(`${key} must be a whole number from 1 to ${max}`);
  }
  return n;
}

function flagOf(input, key) {
  const value = input[key];
  if (value === undefined || value === null) return DEFAULT_SETTINGS[key];
  if (typeof value !== 'boolean') fail(`${key} must be true or false`);
  return value;
}

/** How each setting is read, in the order the settings object lists them. */
const SETTING_READERS = Object.freeze({
  aiMonthlyBudgetUsd: budgetOf,
  renewalLeadDays: (input) => wholeNumberOf(input, 'renewalLeadDays', MAX_RENEWAL_LEAD_DAYS),
  telegram: (input) => flagOf(input, 'telegram'),
  monthlyDigest: (input) => flagOf(input, 'monthlyDigest'),
  refreshHours: (input) => wholeNumberOf(input, 'refreshHours', MAX_REFRESH_HOURS),
});

/**
 * The settings as stored, checked, with defaults for anything missing. A
 * value outside its range is a 400 from the page and the default when read
 * from a document edited by hand.
 */
export function normalizeSettings(input, { strict = false } = {}) {
  if (input === undefined || input === null) return { ...DEFAULT_SETTINGS };
  if (typeof input !== 'object' || Array.isArray(input)) fail('settings must be an object');
  const unknown = Object.keys(input).filter((key) => !SETTINGS_FIELDS.includes(key));
  if (unknown.length > 0) fail(`Unknown setting(s): ${unknown.join(', ')}. Allowed: ${SETTINGS_FIELDS.join(', ')}`);
  const read = (key) => soft(() => SETTING_READERS[key](input), DEFAULT_SETTINGS[key], strict);
  // Read in this order, so the page is refused for the same first bad field as before.
  const budget = read('aiMonthlyBudgetUsd');
  const lead = read('renewalLeadDays');
  const hours = read('refreshHours');
  return {
    aiMonthlyBudgetUsd: budget,
    renewalLeadDays: lead,
    telegram: read('telegram'),
    monthlyDigest: read('monthlyDigest'),
    refreshHours: hours,
  };
}

/** The stored document as `{ items, settings }`, whatever shape it is in. */
export function readState(doc) {
  const items = Array.isArray(doc?.items) ? doc.items.filter((row) => row && typeof row === 'object') : [];
  return { items, settings: normalizeSettings(doc?.settings) };
}

export async function readLedger(store) {
  return readState(await store.readDoc(CONTAINER, LEDGER_DOC_ID, ADMIN_CONFIG_PARTITION));
}

/**
 * Write the ledger: over the document that was read, under the ETag of that
 * read (a 412 when it was replaced since), or as a new document when the read
 * found none (a 409 when one was created since).
 */
async function writeLedger(store, stored, doc) {
  if (stored) {
    await store.replaceDocIfMatch(
      CONTAINER,
      { ...doc, _etag: stored._etag },
      { partitionKey: ADMIN_CONFIG_PARTITION }
    );
  } else {
    await store.createDoc(CONTAINER, doc);
  }
}

/**
 * Apply `change` to the stored ledger and write the result under the ETag it
 * was read at. `change(state)` returns `{ write, state?, result? }` and must
 * be pure (it runs again after a lost race).
 *
 * @param {{ readDoc: Function, createDoc: Function, replaceDocIfMatch: Function }} store
 * @param {(state: { items: object[], settings: object }) => { write: boolean, state?: object, result?: unknown }} change
 * @param {{ now?: () => Date }} [options]
 */
export async function changeLedger(store, change, { now = () => new Date() } = {}) {
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
    const stored = await store.readDoc(CONTAINER, LEDGER_DOC_ID, ADMIN_CONFIG_PARTITION);
    const current = readState(stored);
    const outcome = change(current);
    if (!outcome.write) return { state: current, result: outcome.result, written: false };

    const doc = {
      id: LEDGER_DOC_ID,
      configScope: ADMIN_CONFIG_PARTITION,
      docType: LEDGER_DOC_TYPE,
      items: outcome.state.items,
      settings: outcome.state.settings,
      updatedAt: now().toISOString(),
    };
    try {
      await writeLedger(store, stored, doc);
      return { state: outcome.state, result: outcome.result, written: true };
    } catch (error) {
      if (!isWriteConflict(error)) throw error;
    }
  }
  throw new CostLedgerConflictError();
}
