/**
 * cost/services.js — the ledger of subscriptions the platform pays for
 * outside Azure (ADR 0039): what one row looks like, how a request is checked
 * into one, and the figures the page adds up from them.
 *
 * Cloudflare, the domain host, Publer, Resend, GitHub, Docker Hub and the rest
 * bill on their own accounts, where no Azure budget and no API of ours can see
 * them (docs/architecture/cost-analysis.md lists them as "tracked
 * separately"). So this is a sheet the owner keeps by hand, the way the
 * reminders sheet is, and the page turns it into a monthly figure, a list of
 * renewals coming up, calendar items and alerts.
 *
 * Stored row (one entry of the ledger document's `items` list):
 *
 *   id             UUID
 *   name           required, up to MAX_NAME_LENGTH, one line
 *   vendor         up to MAX_VENDOR_LENGTH, may be empty
 *   category       one of CATEGORIES
 *   plan           up to MAX_PLAN_LENGTH
 *   amount         the price per cycle, >= 0, or null when not yet known
 *   currency       three letters, USD unless said
 *   cycle          one of model.js CYCLES
 *   nextRenewal    a real UTC day as YYYY-MM-DD, or null
 *   autoRenew      boolean
 *   status         active | trial | cancelled
 *   paymentMethod  up to MAX_PAYMENT_LENGTH; the form says "never a card number"
 *   link           '' or an https URL or an admin route
 *   note           up to MAX_NOTE_LENGTH
 *   createdAt, updatedAt
 *
 * presentItem names the fields it returns and adds the two computed ones
 * (monthlyEquivalent, daysUntilRenewal), so a field added to the stored row
 * later is withheld until someone lists it here. Nothing here is logged: a
 * failure is logged by its code, an audit row carries the id and the names
 * of changed fields.
 */
import { AuthoredError } from '../http/error-response.js';
import { SECRET_CATALOG } from '../secret-catalog.js';
import { CYCLES, daysUntil, money, monthlyEquivalent, parseDateOnly } from './model.js';

export const MAX_ITEMS = 200;
export const MAX_NAME_LENGTH = 120;
export const MAX_VENDOR_LENGTH = 80;
export const MAX_PLAN_LENGTH = 80;
export const MAX_PAYMENT_LENGTH = 60;
export const MAX_NOTE_LENGTH = 500;
export const MAX_LINK_LENGTH = 2048;
export const MAX_AMOUNT = 1_000_000;
/** Renewals this many days out are "coming up" on the page and the calendar. */
export const UPCOMING_DAYS = 30;

export const CATEGORIES = Object.freeze([
  { id: 'infrastructure', label: 'Infrastructure' },
  { id: 'ai', label: 'AI' },
  { id: 'communication', label: 'Communication' },
  { id: 'content', label: 'Content' },
  { id: 'developer', label: 'Developer tools' },
  { id: 'other', label: 'Other' },
]);
export const CATEGORY_IDS = Object.freeze(CATEGORIES.map((c) => c.id));
export const STATUSES = Object.freeze(['active', 'trial', 'cancelled']);

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const ANY_CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/;
const NOT_ADDRESS_CHARACTER = /[^!-~]/;
const ADMIN_ROUTE = /^\/admin(?:\/[A-Za-z0-9._~-]+)*\/?(?:\?[A-Za-z0-9._~%=&-]*)?$/;
const OAUTH_SEGMENT = /(^|\/)(oauth|callback)(\/|$)/i;
/** A run of 13 to 19 digits, with or without spaces or dashes: a card number is never stored. */
const CARD_NUMBER = /(?:\d[ -]?){13,19}/;

export class CostServiceValidationError extends AuthoredError {
  constructor(message) {
    super(message, { code: 'INVALID_SERVICE', status: 400 });
  }
}

export class CostServiceNotFoundError extends AuthoredError {
  constructor() {
    super('That subscription no longer exists. Reload the page to see the current list.', {
      code: 'SERVICE_NOT_FOUND',
      status: 404,
    });
  }
}

export class CostLedgerFullError extends AuthoredError {
  constructor() {
    super(`The ledger holds ${MAX_ITEMS} subscriptions already. Remove one before adding another.`, {
      code: 'LEDGER_FULL',
      status: 400,
    });
  }
}

const fail = (message) => {
  throw new CostServiceValidationError(message);
};

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const isItemId = (id) => typeof id === 'string' && ID_PATTERN.test(id);

function oneLine(value, field, max, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(`${field} is required`);
    return '';
  }
  if (typeof value !== 'string') fail(`${field} must be text`);
  const text = value.trim();
  if (required && text === '') fail(`${field} is required`);
  if (text.length > max) fail(`${field} is longer than ${max} characters`);
  if (ANY_CONTROL_CHARACTER.test(text)) fail(`${field} must be a single line of plain text`);
  return text;
}

function normalizeAmount(value) {
  if (value === undefined || value === null || value === '') return null;
  const amount = typeof value === 'string' ? Number(value.replace(/[,$\s]/g, '')) : Number(value);
  if (!Number.isFinite(amount) || amount < 0) fail('amount must be a number of 0 or more, or empty');
  if (amount > MAX_AMOUNT) fail(`amount must be ${MAX_AMOUNT} or less`);
  return money(amount);
}

function normalizeCurrency(value) {
  if (value === undefined || value === null || value === '') return 'USD';
  if (typeof value !== 'string') fail('currency must be a three-letter code such as USD');
  const code = value.trim().toUpperCase();
  if (!CURRENCY_PATTERN.test(code)) fail('currency must be a three-letter code such as USD');
  return code;
}

function oneOf(value, field, allowed, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!allowed.includes(value)) fail(`${field} must be one of ${allowed.join(', ')}`);
  return value;
}

function normalizeRenewal(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || parseDateOnly(value) === null) {
    fail('nextRenewal must be a real date as YYYY-MM-DD, or empty');
  }
  if (value < '2000-01-01' || value > '2100-12-31') fail('nextRenewal must be between 2000 and 2100');
  return value;
}

function normalizeBoolean(value, field, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') fail(`${field} must be true or false`);
  return value;
}

function normalizePayment(value) {
  const text = oneLine(value, 'paymentMethod', MAX_PAYMENT_LENGTH);
  if (CARD_NUMBER.test(text)) fail('paymentMethod must not hold a card number; "Card ending 1234" is enough');
  return text;
}

/** '' for no link, an https URL with no credentials in it, or a page inside /admin (the Calendar Alerts' link rule). */
function normalizeLink(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') fail('link must be a web address or an admin page, or empty');
  const link = value.trim();
  if (link === '') return '';
  if (link.length > MAX_LINK_LENGTH) fail('link is too long');
  const refuse = () => fail('link must be an https web address or a page inside /admin');
  if (link.startsWith('/')) {
    const [path] = link.split('?');
    if (!ADMIN_ROUTE.test(link) || path.split('/').some((s) => s === '..') || OAUTH_SEGMENT.test(path)) {
      refuse();
    }
    return link;
  }
  if (NOT_ADDRESS_CHARACTER.test(link) || /[<>"'`\\]/.test(link) || !/^https:\/\/[^/]+/.test(link)) refuse();
  let parsed;
  try {
    parsed = new URL(link);
  } catch {
    refuse();
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') refuse();
  return link;
}

function normalizeNote(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') fail('note must be text');
  const note = value.trim();
  if (note.length > MAX_NOTE_LENGTH) fail(`note is longer than ${MAX_NOTE_LENGTH} characters`);
  if (CONTROL_CHARACTERS.test(note)) fail('note must be plain text');
  return note;
}

export const EDITABLE_FIELDS = Object.freeze([
  'name',
  'vendor',
  'category',
  'plan',
  'amount',
  'currency',
  'cycle',
  'nextRenewal',
  'autoRenew',
  'status',
  'paymentMethod',
  'link',
  'note',
]);

function assertOnlyKeys(body, where) {
  const unknown = Object.keys(body).filter((key) => !EDITABLE_FIELDS.includes(key));
  if (unknown.length > 0) {
    fail(`Unknown field(s) in ${where}: ${unknown.join(', ')}. Allowed: ${EDITABLE_FIELDS.join(', ')}`);
  }
}

/**
 * The fields of one subscription, checked, with `current` supplying anything
 * the body leaves out (a create passes none). Every editable field comes back.
 */
export function normalizeFields(body, current = null) {
  if (!isPlainObject(body)) fail('The body must be a JSON object');
  assertOnlyKeys(body, 'the body');
  const pick = (key) => (key in body ? body[key] : current?.[key]);
  return {
    name: oneLine(pick('name'), 'name', MAX_NAME_LENGTH, { required: true }),
    vendor: oneLine(pick('vendor'), 'vendor', MAX_VENDOR_LENGTH),
    category: oneOf(pick('category'), 'category', CATEGORY_IDS, 'other'),
    plan: oneLine(pick('plan'), 'plan', MAX_PLAN_LENGTH),
    amount: normalizeAmount(pick('amount')),
    currency: normalizeCurrency(pick('currency')),
    cycle: oneOf(pick('cycle'), 'cycle', CYCLES, 'monthly'),
    nextRenewal: normalizeRenewal(pick('nextRenewal')),
    autoRenew: normalizeBoolean(pick('autoRenew'), 'autoRenew', true),
    status: oneOf(pick('status'), 'status', STATUSES, 'active'),
    paymentMethod: normalizePayment(pick('paymentMethod')),
    link: normalizeLink(pick('link')),
    note: normalizeNote(pick('note')),
  };
}

/** A PATCH body: at least one editable field, no other key. Returns the names it carries. */
export function patchFields(body) {
  if (!isPlainObject(body)) fail('The body must be a JSON object');
  assertOnlyKeys(body, 'the body');
  const names = Object.keys(body);
  if (names.length === 0) fail('Nothing to change: send at least one field');
  return names;
}

export function newItem(fields, { id, at }) {
  return { id, ...fields, createdAt: at, updatedAt: at };
}

/** A stored row this code can show: an id and a name, at least. */
export function isStoredItem(row) {
  return isPlainObject(row) && isItemId(row.id) && typeof row.name === 'string' && row.name.trim() !== '';
}

/**
 * One row as the page reads it: the stored fields, each run through the same
 * check the form uses (a row edited by hand cannot send on what the form would
 * refuse; a bad value becomes the empty default), plus the two computed ones.
 */
export function presentItem(row, today) {
  let fields;
  try {
    fields = normalizeFields({}, row);
  } catch {
    fields = normalizeFields({ name: String(row.name).trim().slice(0, MAX_NAME_LENGTH) || 'Unnamed' });
  }
  return {
    id: row.id,
    ...fields,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : null,
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null,
    monthlyEquivalent: monthlyEquivalent(fields.amount, fields.cycle),
    daysUntilRenewal: fields.nextRenewal ? daysUntil(fields.nextRenewal, today) : null,
  };
}

/** By name, then id. */
export const compareItems = (a, b) =>
  String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base' }) ||
  String(a.id).localeCompare(String(b.id));

/** Active and trial rows: the ones that bill. */
const bills = (item) => item.status !== 'cancelled';

/**
 * What the page adds up from the presented rows.
 *
 * @param {object[]} items presented rows
 * @returns {{ count: number, monthlyEquivalent: number, annualEquivalent: number, byCategory: object[], upcoming: object[], overdue: object[], items: object[] }}
 */
export function summarizeServices(items, { upcomingDays = UPCOMING_DAYS } = {}) {
  const sorted = items.slice().sort(compareItems);
  const billing = sorted.filter(bills);
  const monthly = money(billing.reduce((sum, item) => sum + item.monthlyEquivalent, 0));
  const byCategory = CATEGORIES.map((category) => {
    const rows = billing.filter((item) => item.category === category.id);
    return {
      category: category.id,
      label: category.label,
      count: rows.length,
      monthlyEquivalent: money(rows.reduce((sum, item) => sum + item.monthlyEquivalent, 0)),
    };
  }).filter((row) => row.count > 0);
  const dated = billing.filter((item) => Number.isFinite(item.daysUntilRenewal));
  const bySoonest = (a, b) => a.daysUntilRenewal - b.daysUntilRenewal || compareItems(a, b);
  return {
    count: sorted.length,
    monthlyEquivalent: monthly,
    annualEquivalent: money(monthly * 12),
    byCategory,
    upcoming: dated
      .filter((item) => item.daysUntilRenewal >= 0 && item.daysUntilRenewal <= upcomingDays)
      .sort(bySoonest),
    overdue: dated.filter((item) => item.daysUntilRenewal < 0).sort(bySoonest),
    items: sorted,
  };
}

/**
 * Vendors the site is configured with (the API-keys catalogue) that the
 * ledger does not list yet, as one-click suggestions. Vendor is the word
 * before any dash or em dash in the catalogue label ("Publer — API key" is
 * Publer), matched case-insensitively against the ledger's vendor and name.
 */
export const SUGGESTED_VENDORS = Object.freeze(
  [
    ...new Map(
      SECRET_CATALOG.filter((entry) => !['cloud', 'platform', 'labs'].includes(entry.section)).map(
        (entry) => {
          const vendor = entry.label.split(/\s[—-]\s/)[0].trim();
          const category =
            entry.section === 'gen-ai' || entry.section === 'ai-services'
              ? 'ai'
              : entry.section === 'communication'
                ? 'communication'
                : entry.section === 'content'
                  ? 'content'
                  : entry.section === 'code-quality'
                    ? 'developer'
                    : 'other';
          return [vendor.toLowerCase(), { name: vendor, vendor, category, link: '' }];
        }
      )
    ).values(),
  ].sort((a, b) => a.name.localeCompare(b.name))
);

export function suggestionsFor(items) {
  const known = new Set(
    items.flatMap((item) => [String(item.vendor || '').toLowerCase(), String(item.name || '').toLowerCase()])
  );
  return SUGGESTED_VENDORS.filter((s) => !known.has(s.vendor.toLowerCase()));
}
