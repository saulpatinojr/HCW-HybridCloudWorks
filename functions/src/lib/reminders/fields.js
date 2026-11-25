/**
 * reminders/fields.js — the checks one reminder's fields go through, and the
 * error a refused one throws. settings.js holds the reminder's shape and
 * says why; it exports RemindersValidationError and MAX_URL_LENGTH again.
 */

import { AuthoredError } from '../http/error-response.js';
import { STAGES } from './calendar.js';

export const MAX_URL_LENGTH = 2048;

/** Thrown by the normalizer; platform-settings.js turns it into a 400 (authored, #945). */
export class RemindersValidationError extends AuthoredError {
  /** @param {string} message - the refusal, naming the field */
  constructor(message) {
    super(message);
    this.name = 'RemindersValidationError';
    this.status = 400;
  }
}

export const fail = (message) => {
  throw new RemindersValidationError(message);
};

export const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function assertOnlyKeys(object, allowed, where) {
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    fail(`Unknown field(s) in ${where}: ${unknown.join(', ')}. Allowed: ${allowed.join(', ')}`);
  }
}

/** An https URL with nothing that could smuggle a second one, or empty. */
export function normalizeUrl(value, where) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') fail(`${where}.url must be a string`);
  const url = value.trim();
  if (url === '') return '';
  if (url.length > MAX_URL_LENGTH) fail(`${where}.url is too long`);
  if (/[\s<>"'`\\]/.test(url) || !/^https:\/\/[^/]+/.test(url)) {
    fail(`${where}.url must be an https URL`);
  }
  return url;
}

/** The timer's stamps: each stage an ISO instant or absent. Never invented here. */
export function normalizeNotified(value, where) {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) fail(`${where}.notified must be an object`);
  assertOnlyKeys(value, STAGES, `${where}.notified`);
  const out = {};
  for (const stage of STAGES) {
    const stamp = value[stage];
    if (stamp === undefined || stamp === null) continue;
    if (typeof stamp !== 'string' || !Number.isFinite(Date.parse(stamp))) {
      fail(`${where}.notified.${stage} must be an ISO timestamp`);
    }
    out[stage] = new Date(stamp).toISOString();
  }
  return out;
}

