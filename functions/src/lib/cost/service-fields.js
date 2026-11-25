/**
 * cost/service-fields.js — the check for each field of one subscription row
 * (cost/services.js). Each takes the value as sent (or as stored) and answers
 * the clean value, or throws CostServiceValidationError with a sentence that
 * names the rule, never the value. services.js re-exports what callers use.
 */
import { AuthoredError } from '../http/error-response.js';
import { money, parseDateOnly } from './model.js';

export const MAX_NAME_LENGTH = 120;
export const MAX_VENDOR_LENGTH = 80;
export const MAX_PLAN_LENGTH = 80;
export const MAX_PAYMENT_LENGTH = 60;
export const MAX_NOTE_LENGTH = 500;
export const MAX_LINK_LENGTH = 2048;
export const MAX_AMOUNT = 1_000_000;

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

const fail = (message) => {
  throw new CostServiceValidationError(message);
};

export function oneLine(value, field, max, { required = false } = {}) {
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

export function normalizeAmount(value) {
  if (value === undefined || value === null || value === '') return null;
  const amount = typeof value === 'string' ? Number(value.replace(/[,$\s]/g, '')) : Number(value);
  if (!Number.isFinite(amount) || amount < 0) fail('amount must be a number of 0 or more, or empty');
  if (amount > MAX_AMOUNT) fail(`amount must be ${MAX_AMOUNT} or less`);
  return money(amount);
}

export function normalizeCurrency(value) {
  if (value === undefined || value === null || value === '') return 'USD';
  if (typeof value !== 'string') fail('currency must be a three-letter code such as USD');
  const code = value.trim().toUpperCase();
  if (!CURRENCY_PATTERN.test(code)) fail('currency must be a three-letter code such as USD');
  return code;
}

export function oneOf(value, field, allowed, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!allowed.includes(value)) fail(`${field} must be one of ${allowed.join(', ')}`);
  return value;
}

export function normalizeRenewal(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || parseDateOnly(value) === null) {
    fail('nextRenewal must be a real date as YYYY-MM-DD, or empty');
  }
  if (value < '2000-01-01' || value > '2100-12-31') fail('nextRenewal must be between 2000 and 2100');
  return value;
}

export function normalizeBoolean(value, field, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') fail(`${field} must be true or false`);
  return value;
}

export function normalizePayment(value) {
  const text = oneLine(value, 'paymentMethod', MAX_PAYMENT_LENGTH);
  if (CARD_NUMBER.test(text)) fail('paymentMethod must not hold a card number; "Card ending 1234" is enough');
  return text;
}

/** '' for no link, an https URL with no credentials in it, or a page inside /admin (the Calendar Alerts' link rule). */
export function normalizeLink(value) {
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

export function normalizeNote(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') fail('note must be text');
  const note = value.trim();
  if (note.length > MAX_NOTE_LENGTH) fail(`note is longer than ${MAX_NOTE_LENGTH} characters`);
  if (CONTROL_CHARACTERS.test(note)) fail('note must be plain text');
  return note;
}
