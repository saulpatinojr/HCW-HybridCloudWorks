/**
 * platform-setting-checks.js — the refusal every platform-setting normalizer
 * throws, and the small checks they share. platform-settings.js re-exports
 * PlatformSettingValidationError.
 */
import { AuthoredError } from './http/error-response.js';

/**
 * Thrown by a normalizer; the handler turns it into a 400 with the message.
 * Authored (#945): every sentence is written by a normalizer here.
 */
export class PlatformSettingValidationError extends AuthoredError {
  /** @param {string} message - the refusal, naming the field */
  constructor(message) {
    super(message);
    this.name = 'PlatformSettingValidationError';
  }
}

export const fail = (message) => {
  throw new PlatformSettingValidationError(message);
};

export const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Refuse keys outside `allowed` — an allowlisted shape, not a filtered one. */
export function assertOnlyKeys(object, allowed, where) {
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    fail(`Unknown field(s) in ${where}: ${unknown.join(', ')}. Allowed: ${allowed.join(', ')}`);
  }
}

/** The longest URL a setting may store. */
export const MAX_URL_LENGTH = 2048;
