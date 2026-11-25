/**
 * content-field-checks.js — the checks one field of a content update goes
 * through (a length, a date, a web address, a list, a size), and the error
 * they throw. Split out of content-update-validation.js, which re-exports
 * everything here, to keep each file short.
 */
import { AuthoredError } from "../http/error-response.js";

/**
 * A refusal written here for the editor: every sentence this module throws.
 * Typed so a handler can show it (`authoredMessage`) while anything else
 * that escapes a validation block — a Cosmos read, a serialisation fault —
 * is answered with the handler's own safe sentence (#945).
 */
export class ContentValidationError extends AuthoredError {}

/**
 * A string field within its length.
 *
 * @param {unknown} value - the field
 * @param {string} fieldName - its name, for the refusal
 * @param {number} maxLength - the ceiling
 * @param {{ allowEmpty?: boolean }} [options]
 * @returns {string}
 * @throws {ContentValidationError}
 */
export function assertStringLength(
  value,
  fieldName,
  maxLength,
  { allowEmpty = true } = {},
) {
  const normalized = String(value || "");
  if (!allowEmpty && !normalized.trim()) {
    throw new ContentValidationError(`${fieldName} is required`);
  }
  if (normalized.length > maxLength) {
    throw new ContentValidationError(`${fieldName} exceeds ${maxLength} characters`);
  }
  return normalized;
}

/**
 * An optional date field as a Date, or null when empty.
 *
 * @param {unknown} value - the field
 * @param {string} fieldName - its name, for the refusal
 * @returns {Date|null}
 * @throws {ContentValidationError}
 */
export function assertOptionalDateString(value, fieldName) {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw new ContentValidationError(`${fieldName} must be a valid date`);
  }
  return parsed;
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * An optional http(s) URL field, trimmed.
 *
 * @param {unknown} value - the field
 * @param {string} fieldName - its name, for the refusal
 * @param {{ allowEmpty?: boolean }} [options]
 * @returns {string}
 * @throws {ContentValidationError}
 */
export function assertOptionalHttpUrl(
  value,
  fieldName,
  { allowEmpty = true } = {},
) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    if (!allowEmpty) throw new ContentValidationError(`${fieldName} is required`);
    return "";
  }
  if (normalized.length > 2048) {
    throw new ContentValidationError(`${fieldName} exceeds 2048 characters`);
  }
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new ContentValidationError(`${fieldName} must be a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ContentValidationError(`${fieldName} must be an http(s) URL`);
  }
  return normalized;
}

/**
 * An optional list of strings within its item count and item length.
 *
 * @param {unknown} value - the field
 * @param {string} fieldName - its name, for the refusal
 * @param {{ maxItems?: number, maxItemLength?: number }} [options]
 * @returns {string[]|null}
 * @throws {ContentValidationError}
 */
export function assertStringArray(
  value,
  fieldName,
  { maxItems = 50, maxItemLength = 120 } = {},
) {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) {
    throw new ContentValidationError(`${fieldName} must be an array`);
  }
  if (value.length > maxItems) {
    throw new ContentValidationError(`${fieldName} exceeds ${maxItems} items`);
  }
  return value.map((entry) => {
    const normalized = String(entry || "").trim();
    if (normalized.length > maxItemLength) {
      throw new ContentValidationError(
        `${fieldName} contains an entry that exceeds ${maxItemLength} characters`,
      );
    }
    return normalized;
  });
}

/**
 * A JSON value within its serialised size.
 *
 * @param {unknown} value - the field
 * @param {string} fieldName - its name, for the refusal
 * @param {number} [maxChars] - the ceiling
 * @returns {unknown}
 * @throws {ContentValidationError}
 */
export function assertJsonSize(value, fieldName, maxChars = 120_000) {
  if (value === null || value === undefined) return value;
  // Defensive: only JSON-friendly values should be stored.
  const serialized = JSON.stringify(value);
  if (serialized.length > maxChars) {
    throw new ContentValidationError(`${fieldName} payload exceeds ${maxChars} characters`);
  }
  return value;
}
